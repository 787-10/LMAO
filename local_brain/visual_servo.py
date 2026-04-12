"""Visual servoing — YOLO-World open-vocab detection + proportional steering.

Given a text description of a target, detects it in the camera frame and
computes turn/forward commands to approach it. Runs as a blocking loop
called by the main server when Qwen decides to approach a target.

Usage (from server.py):
    from visual_servo import VisualServo
    servo = VisualServo()
    servo.load()  # one-time model load (~2s)

    # In the inference worker, when Qwen outputs approach_target:
    result = servo.approach(
        get_frame_fn=lambda: latest_frame_bytes,
        dispatch_fn=lambda skill, inputs: ...,
        target="blue X",
        timeout_s=30.0,
    )
"""

import io
import json
import logging
import time

from PIL import Image

log = logging.getLogger("local-brain")

# Camera horizontal FOV in degrees (estimated from 640×480 @ 80° vertical)
HORIZONTAL_FOV_DEG = 100.0

# Thresholds
CENTER_TOLERANCE = 0.15   # ±15% of frame width = "centered"
CLOSE_ENOUGH = 0.12       # target bbox fills >12% of frame width = arrived
MIN_CONFIDENCE = 0.15     # YOLO detection threshold
MAX_STEPS = 15            # safety limit
SEARCH_TURN_DEG = 80      # turn this much when target is lost
CONSECUTIVE_FORWARD_STOP = 4  # stop after N consecutive forward moves (target is small but we're close)


# COCO class names that YOLO11 can detect natively (subset of 80)
COCO_TARGETS = {
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
}

# Map common user descriptions to COCO class names
TARGET_ALIASES = {
    "water bottle": "bottle",
    "black bottle": "bottle",
    "black water bottle": "bottle",
    "cardboard box": "suitcase",  # closest COCO proxy
    "box": "suitcase",
    "human": "person",
    "people": "person",
    "sofa": "couch",
    "monitor": "tv",
    "screen": "tv",
    "desk": "dining table",
    "table": "dining table",
}


class VisualServo:
    def __init__(self):
        self._coco_model = None
        self._world_model = None

    def load(self):
        """Load detection models. Call once at startup."""
        from ultralytics import YOLO
        log.info("loading YOLO11x (COCO)...")
        t0 = time.time()
        self._coco_model = YOLO("yolo11x.pt")
        log.info("YOLO11x loaded in %.1fs", time.time() - t0)

        log.info("loading YOLO-World (open-vocab)...")
        t0 = time.time()
        self._world_model = YOLO("yolov8x-worldv2.pt")
        log.info("YOLO-World loaded in %.1fs", time.time() - t0)

    def _resolve_target(self, target: str) -> tuple[str, str]:
        """Map user target description to (coco_class | None, model_to_use).

        Returns (resolved_name, "coco" | "world").
        """
        t = target.lower().strip()
        # Check aliases first
        if t in TARGET_ALIASES:
            return TARGET_ALIASES[t], "coco"
        # Check if it's a direct COCO class
        if t in COCO_TARGETS:
            return t, "coco"
        # Fall back to YOLO-World for open-vocab
        return target, "world"

    def detect(self, frame_bytes: bytes, target: str) -> dict | None:
        """Detect target in a JPEG frame.

        Returns dict with keys: x_center (0-1), y_center (0-1),
        width (0-1), height (0-1), confidence, name, or None if not found.
        """
        img = Image.open(io.BytesIO(frame_bytes))
        img_w, img_h = img.size

        resolved, mode = self._resolve_target(target)

        if mode == "coco" and self._coco_model is not None:
            results = self._coco_model.predict(img, conf=MIN_CONFIDENCE, verbose=False)
            if results and len(results[0].boxes) > 0:
                # Filter for the target class
                for i, box in enumerate(results[0].boxes):
                    cls_name = results[0].names[int(box.cls[0])]
                    if cls_name == resolved:
                        conf = float(box.conf[0])
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        return {
                            "x_center": ((x1 + x2) / 2) / img_w,
                            "y_center": ((y1 + y2) / 2) / img_h,
                            "width": (x2 - x1) / img_w,
                            "height": (y2 - y1) / img_h,
                            "confidence": conf,
                            "name": cls_name,
                        }

        # Fall back to YOLO-World
        if self._world_model is not None:
            self._world_model.set_classes([target])
            results = self._world_model.predict(img, conf=MIN_CONFIDENCE, verbose=False)
            if results and len(results[0].boxes) > 0:
                best_idx = results[0].boxes.conf.argmax().item()
                box = results[0].boxes.xyxy[best_idx].tolist()
                conf = results[0].boxes.conf[best_idx].item()
                x1, y1, x2, y2 = box
                return {
                    "x_center": ((x1 + x2) / 2) / img_w,
                    "y_center": ((y1 + y2) / 2) / img_h,
                    "width": (x2 - x1) / img_w,
                    "height": (y2 - y1) / img_h,
                    "confidence": conf,
                    "name": target,
                }

        return None

    def compute_action(self, detection: dict) -> tuple[str, dict, str]:
        """Given a detection, compute the steering action.

        Returns (skill_name, inputs_dict, reason_string).
        """
        x_center = detection["x_center"]
        width = detection["width"]
        offset = x_center - 0.5  # negative = left, positive = right

        # Check if we're close enough (target fills a large portion of frame)
        if width >= CLOSE_ENOUGH:
            # One last forward push to make contact
            return ("move_forward", {"duration_s": 1.5},
                    f"Target fills {width:.0%} of frame — driving into it")

        # Check if target is centered
        if abs(offset) <= CENTER_TOLERANCE:
            # Centered — drive forward
            duration = 2.0 if width < 0.15 else 1.0  # longer if far away
            return ("move_forward", {"duration_s": duration},
                    f"Target centered (offset={offset:+.0%}), moving forward")

        # Need to turn — proportional to offset
        turn_degrees = abs(offset) * HORIZONTAL_FOV_DEG * 0.6  # damped
        turn_degrees = max(10, min(turn_degrees, 45))  # clamp 10-45°

        if offset < 0:
            return ("turn_left", {"degrees": round(turn_degrees)},
                    f"Target is left (offset={offset:+.0%}), turning left {turn_degrees:.0f}°")
        else:
            return ("turn_right", {"degrees": round(turn_degrees)},
                    f"Target is right (offset={offset:+.0%}), turning right {turn_degrees:.0f}°")

    def approach(
        self,
        get_frame_fn,
        dispatch_fn,
        wait_complete_fn,
        wait_fresh_fn,
        target: str,
        timeout_s: float = 30.0,
    ) -> str:
        """Run the visual servoing loop until the target is reached or timeout.

        Args:
            get_frame_fn: callable returning latest JPEG bytes
            dispatch_fn: callable(skill, inputs) that dispatches a skill and blocks
            wait_complete_fn: callable() that waits for primitive_completed
            wait_fresh_fn: callable() that waits for a fresh frame
            target: text description of what to approach
            timeout_s: max time for the whole approach

        Returns:
            Result string: "reached", "lost", "timeout"
        """
        start = time.time()
        lost_count = 0
        stale_count = 0
        consecutive_forward = 0
        prev_offset = None
        prev_width = None
        step = 0

        log.info("SERVO: starting approach to '%s'", target)

        while time.time() - start < timeout_s and step < MAX_STEPS:
            step += 1
            frame = get_frame_fn()
            if frame is None:
                time.sleep(0.2)
                continue

            detection = self.detect(frame, target)

            if detection is None:
                lost_count += 1
                log.info("SERVO [%d]: target '%s' not detected (lost %d)",
                         step, target, lost_count)
                if lost_count >= 3:
                    log.info("SERVO: target lost after %d steps", step)
                    return "lost"
                dispatch_fn("turn_left", {"degrees": SEARCH_TURN_DEG})
                wait_complete_fn()
                wait_fresh_fn()
                continue

            lost_count = 0
            cur_offset = round(detection["x_center"] - 0.5, 2)
            cur_width = round(detection["width"], 2)

            # Detect stale frames — same offset+width as last step
            if prev_offset is not None:
                if abs(cur_offset - prev_offset) < 0.02 and abs(cur_width - prev_width) < 0.01:
                    stale_count += 1
                    if stale_count >= 2:
                        log.warning("SERVO [%d]: stale frame detected (%d in a row), breaking",
                                    step, stale_count)
                        return "stale"
                else:
                    stale_count = 0
            prev_offset = cur_offset
            prev_width = cur_width

            # Check if we've arrived
            if detection["width"] >= CLOSE_ENOUGH:
                if abs(cur_offset) <= CENTER_TOLERANCE:
                    log.info("SERVO: target reached! (width=%.0f%%, offset=%.0f%%) Final push.",
                             detection["width"] * 100, cur_offset * 100)
                    dispatch_fn("move_forward", {"duration_s": 2.0})
                    wait_complete_fn()
                    return "reached"
                else:
                    # Close but not centered — small correction turn
                    turn_deg = max(5, min(abs(cur_offset) * 30, 15))
                    if cur_offset < 0:
                        dispatch_fn("turn_left", {"degrees": round(turn_deg)})
                    else:
                        dispatch_fn("turn_right", {"degrees": round(turn_deg)})
                    log.info("SERVO [%d]: close (width=%.0f%%) but off-center (%.0f%%), small correction %d°",
                             step, detection["width"] * 100, cur_offset * 100, turn_deg)
                    wait_complete_fn()
                    wait_fresh_fn()
                    continue

            skill, inputs, reason = self.compute_action(detection)
            log.info("SERVO [%d]: %s conf=%.2f offset=%.0f%% width=%.0f%% -> %s(%s) | %s",
                     step, target, detection["confidence"],
                     cur_offset * 100, cur_width * 100,
                     skill, json.dumps(inputs), reason)

            # Track consecutive forward moves — if we keep driving toward
            # a centered target, we're close enough even if width is small
            if skill == "move_forward":
                consecutive_forward += 1
                if consecutive_forward >= CONSECUTIVE_FORWARD_STOP:
                    log.info("SERVO: %d consecutive forwards with target centered — close enough, stopping.",
                             consecutive_forward)
                    return "reached"
            else:
                consecutive_forward = 0

            dispatch_fn(skill, inputs)
            wait_complete_fn()
            wait_fresh_fn()

        log.info("SERVO: timeout after %d steps", step)
        return "timeout"
