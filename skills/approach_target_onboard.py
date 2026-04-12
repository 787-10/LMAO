"""Approach a target object using onboard YOLO vision + proportional steering.

Runs entirely on the Jetson — no network, no Mac, no Qwen needed.
YOLO11s detects the target, math computes the steering, mobility executes.

First run downloads yolo11s.pt (~19MB). For TensorRT acceleration, run:
    python3 -c "from ultralytics import YOLO; YOLO('yolo11s.pt').export(format='engine')"
Then change MODEL_PATH below to 'yolo11s.engine'.
"""

import math
import time

from brain_client.skill_types import (
    Skill, SkillResult, Interface, InterfaceType,
    RobotState, RobotStateType,
)

# ── Config ──────────────────────────────────────────────────────────────────

MODEL_PATH = "/home/jetson1/yolo11s.pt"  # change to .engine after TensorRT export
HORIZONTAL_FOV_DEG = 100.0
CENTER_TOLERANCE = 0.15    # ±15% of frame width
CLOSE_ENOUGH = 0.12        # target fills >12% of frame width
DAMPING = 0.6              # proportional steering gain
MIN_CONFIDENCE = 0.15
MAX_ITERATIONS = 30
FORWARD_SPEED = 0.15       # m/s

# COCO class name → class index
COCO_CLASSES = {
    "person": 0, "bicycle": 1, "car": 2, "motorcycle": 3, "bus": 5,
    "train": 6, "truck": 7, "boat": 8, "traffic light": 9,
    "fire hydrant": 10, "stop sign": 12, "bench": 13, "bird": 14,
    "cat": 15, "dog": 16, "backpack": 24, "umbrella": 25, "handbag": 26,
    "suitcase": 28, "frisbee": 29, "skis": 30, "sports ball": 32,
    "bottle": 39, "wine glass": 40, "cup": 41, "fork": 42, "knife": 43,
    "spoon": 44, "bowl": 45, "banana": 46, "apple": 47, "sandwich": 48,
    "chair": 56, "couch": 57, "potted plant": 58, "bed": 59,
    "dining table": 60, "toilet": 61, "tv": 62, "laptop": 63,
    "mouse": 64, "remote": 65, "keyboard": 66, "cell phone": 67,
    "microwave": 68, "oven": 69, "toaster": 70, "sink": 71,
    "refrigerator": 72, "book": 73, "clock": 74, "vase": 75,
    "scissors": 76, "teddy bear": 77,
}

# User-friendly aliases
ALIASES = {
    "water bottle": "bottle",
    "black bottle": "bottle",
    "black water bottle": "bottle",
    "mug": "cup",
    "glass": "wine glass",
    "human": "person",
    "people": "person",
    "man": "person",
    "woman": "person",
    "sofa": "couch",
    "table": "dining table",
    "desk": "dining table",
    "monitor": "tv",
    "screen": "tv",
    "box": "suitcase",
    "cardboard box": "suitcase",
    "bag": "backpack",
    "phone": "cell phone",
    "mobile": "cell phone",
    "computer": "laptop",
    "notebook": "laptop",
}


class ApproachTargetOnboard(Skill):
    """Drive precisely toward a detected object using onboard YOLO vision."""

    mobility = Interface(InterfaceType.MOBILITY)
    image = RobotState(RobotStateType.LAST_MAIN_CAMERA_IMAGE_B64)

    _model = None       # YOLO11s COCO — loaded once, reused
    _world_model = None  # YOLO-World open-vocab fallback

    @property
    def name(self):
        return "approach_target_onboard"

    def guidelines(self):
        return (
            "Use onboard YOLO vision to detect and drive precisely toward "
            "a target object. Handles all steering automatically. "
            "Supported targets: bottle, person, chair, cup, laptop, backpack, "
            "couch, tv, cell phone, book, and more. "
            "Also accepts aliases like 'water bottle', 'cardboard box'."
        )

    def execute(self, target: str = "bottle", timeout_s: float = 25.0):
        """Detect and approach a target object.

        Args:
            target: object to approach (e.g. 'bottle', 'person', 'chair')
            timeout_s: max time for the approach (default 25s)
        """
        self._cancelled = False

        # Resolve target name
        resolved = ALIASES.get(target.lower().strip(), target.lower().strip())
        use_coco = resolved in COCO_CLASSES
        target_cls = COCO_CLASSES.get(resolved)

        if use_coco:
            self._send_feedback(f"Using COCO detector for '{resolved}'")
        else:
            # Load YOLO-World for open-vocab detection
            self._send_feedback(f"'{resolved}' not in COCO, loading open-vocab detector...")
            if ApproachTargetOnboard._world_model is None:
                ApproachTargetOnboard._world_model = YOLO("yolov8s-worldv2.pt")
            ApproachTargetOnboard._world_model.set_classes([target.lower().strip()])
            self._send_feedback(f"Using YOLO-World for '{target}'")

        # Lazy imports (avoid top-level cv2/numpy/ultralytics)
        import base64
        import cv2
        import numpy as np
        from ultralytics import YOLO

        # Lazy-load COCO model (cached across skill invocations)
        if ApproachTargetOnboard._model is None:
            self._send_feedback("Loading YOLO model (first time only)...")
            ApproachTargetOnboard._model = YOLO(MODEL_PATH)
            self._send_feedback("YOLO loaded")
        model = ApproachTargetOnboard._model

        self._send_feedback(f"Approaching '{target}' (class={resolved})")

        start = time.time()
        lost_count = 0
        prev_offset = None
        prev_width = None
        stale_count = 0

        for step in range(1, MAX_ITERATIONS + 1):
            if self._cancelled:
                return "Cancelled", SkillResult.CANCELLED
            if time.time() - start > timeout_s:
                return f"Timeout after {step} steps", SkillResult.FAILURE

            # ── GRAB FRAME ──────────────────────────────────────────
            if not self.image:
                time.sleep(0.05)
                continue

            try:
                raw = base64.b64decode(self.image)
                buf = np.frombuffer(raw, dtype=np.uint8)
                img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
                if img is None:
                    continue
            except Exception:
                continue

            h, w = img.shape[:2]

            # ── YOLO DETECT ─────────────────────────────────────────
            if use_coco:
                results = model.predict(img, conf=MIN_CONFIDENCE, verbose=False)
                # Find the best detection of the target COCO class
                best_conf = 0
                best_box = None
                for box in results[0].boxes:
                    if int(box.cls[0]) == target_cls:
                        conf = float(box.conf[0])
                        if conf > best_conf:
                            best_conf = conf
                            best_box = box.xyxy[0].tolist()
            else:
                # YOLO-World open-vocab detection
                results = ApproachTargetOnboard._world_model.predict(
                    img, conf=MIN_CONFIDENCE, verbose=False
                )
                best_conf = 0
                best_box = None
                if results and len(results[0].boxes) > 0:
                    best_idx = results[0].boxes.conf.argmax().item()
                    best_conf = float(results[0].boxes.conf[best_idx])
                    best_box = results[0].boxes.xyxy[best_idx].tolist()

            if best_box is None:
                lost_count += 1
                self._send_feedback(f"[{step}] {resolved} not seen (lost {lost_count})")
                if lost_count >= 8:
                    return f"{target} not found after {step} steps", SkillResult.FAILURE
                # Don't spin on every miss — stay still and retry for the
                # first few misses (might be a flaky detection). Only turn
                # to search after 5 consecutive misses with no detection.
                if lost_count >= 5:
                    self.mobility.rotate(math.radians(45))
                    self._send_feedback(f"[{step}] Searching: turning 45°")
                else:
                    time.sleep(0.3)  # wait for next frame, don't move
                continue

            lost_count = 0
            x1, y1, x2, y2 = best_box

            # ── COMPUTE GEOMETRY ────────────────────────────────────
            centroid_x = (x1 + x2) / 2
            x_norm = centroid_x / w
            offset = x_norm - 0.5
            box_width = (x2 - x1) / w

            # ── STALE DETECTION CHECK ───────────────────────────────
            if prev_offset is not None:
                if abs(offset - prev_offset) < 0.02 and abs(box_width - prev_width) < 0.01:
                    stale_count += 1
                    if stale_count >= 3:
                        self._send_feedback(f"[{step}] Stale frame, stopping")
                        return f"Stale detection after {step} steps", SkillResult.FAILURE
                else:
                    stale_count = 0
            prev_offset = offset
            prev_width = box_width

            # ── ARRIVAL CHECK ───────────────────────────────────────
            if box_width >= CLOSE_ENOUGH:
                if abs(offset) <= CENTER_TOLERANCE:
                    self._send_feedback(
                        f"[{step}] TARGET REACHED (width={box_width:.0%}, "
                        f"offset={offset:+.0%}). Final push!"
                    )
                    self.mobility.send_cmd_vel(
                        linear_x=FORWARD_SPEED, angular_z=0.0, duration=2.0
                    )
                    time.sleep(2.2)
                    return f"Reached {target} in {step} steps", SkillResult.SUCCESS
                else:
                    # Close but not centered — tiny correction
                    turn_deg = max(5, min(abs(offset) * 30, 15))
                    turn_rad = math.radians(turn_deg)
                    if offset < 0:
                        self.mobility.rotate(turn_rad)
                    else:
                        self.mobility.rotate(-turn_rad)
                    self._send_feedback(
                        f"[{step}] Close (width={box_width:.0%}) "
                        f"but off-center ({offset:+.0%}), correcting {turn_deg:.0f}°"
                    )
                    continue

            # ── STEERING DECISION ───────────────────────────────────
            if abs(offset) > CENTER_TOLERANCE:
                # Turn to center the target
                turn_deg = abs(offset) * HORIZONTAL_FOV_DEG * DAMPING
                turn_deg = max(5, min(turn_deg, 45))
                turn_rad = math.radians(turn_deg)

                if offset < 0:
                    self.mobility.rotate(turn_rad)   # left (positive)
                    direction = "left"
                else:
                    self.mobility.rotate(-turn_rad)  # right (negative)
                    direction = "right"

                self._send_feedback(
                    f"[{step}] conf={best_conf:.2f} offset={offset:+.0%} "
                    f"width={box_width:.0%} → turn_{direction}({turn_deg:.0f}°)"
                )
            else:
                # Centered — drive forward
                duration = 2.0 if box_width < 0.06 else 1.0
                self.mobility.send_cmd_vel(
                    linear_x=FORWARD_SPEED, angular_z=0.0, duration=duration
                )
                time.sleep(duration + 0.2)
                self._send_feedback(
                    f"[{step}] conf={best_conf:.2f} offset={offset:+.0%} "
                    f"width={box_width:.0%} → forward({duration:.1f}s)"
                )

        return f"Max iterations ({MAX_ITERATIONS}) reached", SkillResult.FAILURE

    def cancel(self):
        self._cancelled = True
        try:
            self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
        except Exception:
            pass
        return "Approach cancelled"
