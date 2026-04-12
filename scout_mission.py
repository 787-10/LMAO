"""LMAO scout mission skill — drop-in for ~/skills/ on MARS.

Day-1 MVP: travel → scan → look for a white chess pawn → report.
Detector is a color + shape heuristic in HSV (cv2), good enough to
discriminate a white pawn from typical indoor backgrounds under
normal lighting. Swap for a trained model later if needed.
"""

from brain_client.skill_types import (
    Skill,
    SkillResult,
    Interface,
    InterfaceType,
    RobotState,
    RobotStateType,
)
import base64
import math
import time


class ScoutMission(Skill):
    """Travel to a target, survey for a resource, report back.

    The atomic unit of LMAO: one scout, one mission, one outcome.
    The hub will eventually dispatch this skill programmatically
    across multiple scouts; for the MVP it runs on a single MARS.
    """

    mobility = Interface(InterfaceType.MOBILITY)
    head = Interface(InterfaceType.HEAD)
    image = RobotState(RobotStateType.LAST_MAIN_CAMERA_IMAGE_B64)

    @property
    def name(self):
        return "scout_mission"

    def guidelines(self):
        return (
            "Deploy the robot as a scout: drive forward a short distance, "
            "rotate to scan for a named resource, and report SUCCESS if "
            "the resource is detected in any scanned frame, or FAILURE if "
            "the budget is exceeded or nothing is seen."
        )

    def execute(
        self,
        resource_tag: str = "white_chess_pawn",
        travel_duration_s: float = 1.5,
        scan_directions: int = 4,
        time_budget_s: float = 45.0,
        linear_speed_mps: float = 0.15,
    ):
        """Run one scout mission.

        Args:
            resource_tag: label of the resource the scout is hunting.
                Supported: 'white_chess_pawn', 'black_water_bottle'.
                Anything else falls back to the white-pawn detector.
            travel_duration_s: seconds to drive forward before scanning.
            scan_directions: number of headings to sample during the scan.
            time_budget_s: abort if the mission takes longer than this.
            linear_speed_mps: forward speed during the travel phase.
        """
        self._cancelled = False
        start = time.time()

        self._send_feedback(f"Scout deploying for '{resource_tag}'")

        # Phase 1: travel.
        # send_cmd_vel is NON-BLOCKING — it publishes the velocity with a
        # duration tag and returns immediately. We must block ourselves
        # for the duration, otherwise the next Nav2-backed call (rotate)
        # will preempt the still-running cmd_vel stream.
        distance_m = linear_speed_mps * travel_duration_s
        self._send_feedback(
            f"Driving forward {distance_m:.2f} m "
            f"({linear_speed_mps:.2f} m/s × {travel_duration_s:.1f}s)"
        )
        self.mobility.send_cmd_vel(
            linear_x=linear_speed_mps,
            angular_z=0.0,
            duration=travel_duration_s,
        )
        travel_deadline = time.time() + travel_duration_s + 0.2
        while time.time() < travel_deadline:
            if self._cancelled:
                try:
                    self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
                except Exception:
                    pass
                return "Recalled during travel", SkillResult.CANCELLED
            if self._should_abort(start, time_budget_s):
                return self._abort("travel exceeded budget")
            time.sleep(0.1)

        # Phase 2: survey
        self._send_feedback(f"Scanning for '{resource_tag}'")
        self.head.set_position(-10)
        rotation_step = (2 * math.pi) / max(1, scan_directions)

        for i in range(scan_directions):
            if self._cancelled:
                return "Recalled by hub", SkillResult.CANCELLED
            if self._should_abort(start, time_budget_s):
                return self._abort("survey exceeded budget")

            # Give the camera a moment to settle after rotation.
            time.sleep(0.3)

            self._send_feedback(f"Heading {i + 1}/{scan_directions}: looking")

            detection = self._detect_resource(resource_tag, self.image)
            if detection is not None:
                area, aspect, fill = detection
                elapsed = time.time() - start
                msg = (
                    f"FOUND '{resource_tag}' on heading {i + 1}/"
                    f"{scan_directions} after {elapsed:.1f}s "
                    f"(area={area}, aspect={aspect:.2f}, fill={fill:.2f})"
                )
                return msg, SkillResult.SUCCESS

            self.mobility.rotate(rotation_step)

        return (
            f"'{resource_tag}' not visible — hub should replan",
            SkillResult.FAILURE,
        )

    def cancel(self):
        self._cancelled = True
        try:
            self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
        except Exception:
            pass
        return "Mission cancelled"

    # ------- helpers -------

    def _should_abort(self, start, budget):
        return (time.time() - start) > budget

    def _abort(self, reason):
        try:
            self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
        except Exception:
            pass
        return f"ABORT: {reason}", SkillResult.FAILURE

    def _detect_resource(self, tag, image_b64):
        """Route to the right detector for the tag. Unknown tags
        fall back to the white-pawn detector."""
        tag = (tag or "").strip().lower().replace(" ", "_")
        if tag in ("black_water_bottle", "black_bottle", "water_bottle"):
            return self._detect_black_bottle(image_b64)
        return self._detect_white_pawn(image_b64)

    def _detect_black_bottle(self, image_b64):
        """Detect a black water bottle at close range (~0.15–0.5 m).

        Black bottles are dark (low HSV Value), tall-to-wide (aspect
        ~2–4), and — at these ranges — occupy a big chunk of the frame
        (several percent up to ~25%). Unlike the pawn we don't reject
        blobs touching the edges because a close bottle may easily
        reach the top/bottom of the frame."""
        if not image_b64:
            return None

        try:
            import cv2
            import numpy as np

            raw = base64.b64decode(image_b64)
            buf = np.frombuffer(raw, dtype=np.uint8)
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if bgr is None:
                return None

            h_img, w_img = bgr.shape[:2]
            total_px = h_img * w_img

            # Black = very low Value. Any hue, any saturation.
            hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
            lower = np.array([0, 0, 0], dtype=np.uint8)
            upper = np.array([180, 255, 55], dtype=np.uint8)
            mask = cv2.inRange(hsv, lower, upper)

            # Larger kernel to merge bottle-sized dark regions.
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

            n_labels, _, stats, _ = cv2.connectedComponentsWithStats(
                mask, connectivity=8
            )

            min_area = max(4000, int(0.010 * total_px))
            max_area = int(0.35 * total_px)

            best = None
            reject_summary = {
                "area": 0, "aspect": 0, "fill": 0, "total": 0
            }
            for lbl in range(1, n_labels):
                reject_summary["total"] += 1
                x, y, w, h, area = stats[lbl]
                if area < min_area or area > max_area:
                    reject_summary["area"] += 1
                    continue
                if h <= 0 or w <= 0:
                    continue

                aspect = h / float(w)
                fill = area / float(w * h)
                if aspect < 1.8 or aspect > 5.0:
                    reject_summary["aspect"] += 1
                    continue
                if fill < 0.55:
                    reject_summary["fill"] += 1
                    continue

                candidate = (int(area), float(aspect), float(fill))
                if best is None or area > best[0]:
                    best = candidate

            if best is None and reject_summary["total"] > 0:
                try:
                    self._send_feedback(
                        f"no bottle: {reject_summary['total']} blobs, "
                        f"rejected area={reject_summary['area']} "
                        f"aspect={reject_summary['aspect']} "
                        f"fill={reject_summary['fill']}"
                    )
                except Exception:
                    pass

            return best
        except Exception as exc:
            try:
                self._send_feedback(f"bottle detector error: {exc}")
            except Exception:
                pass
            return None

    def _detect_white_pawn(self, image_b64):
        """Return (area, aspect, fill) if a plausible white pawn blob is
        visible, else None.

        A chess pawn at ~1 m is a compact, bright-white, vertically
        oriented blob — meaningfully taller than wide, only a small
        fraction of the frame, and not touching the image edges.
        Walls, floors, paper, and ceiling fixtures fail at least one
        of those gates."""
        if not image_b64:
            return None

        try:
            import cv2
            import numpy as np

            raw = base64.b64decode(image_b64)
            buf = np.frombuffer(raw, dtype=np.uint8)
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if bgr is None:
                return None

            h_img, w_img = bgr.shape[:2]
            total_px = h_img * w_img

            # White = very high Value, very low Saturation.
            hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
            lower = np.array([0, 0, 215], dtype=np.uint8)
            upper = np.array([180, 35, 255], dtype=np.uint8)
            mask = cv2.inRange(hsv, lower, upper)

            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

            n_labels, _, stats, _ = cv2.connectedComponentsWithStats(
                mask, connectivity=8
            )

            # Pawn size gates, tuned for ~1 m viewing distance.
            min_area = max(600, int(0.0008 * total_px))
            max_area = int(0.04 * total_px)
            edge_margin = 4

            best = None
            reject_summary = {
                "area": 0, "edge": 0, "aspect": 0, "fill": 0, "total": 0
            }
            for lbl in range(1, n_labels):
                reject_summary["total"] += 1
                x, y, w, h, area = stats[lbl]
                if area < min_area or area > max_area:
                    reject_summary["area"] += 1
                    continue
                if (
                    x <= edge_margin
                    or y <= edge_margin
                    or x + w >= w_img - edge_margin
                    or y + h >= h_img - edge_margin
                ):
                    reject_summary["edge"] += 1
                    continue
                if h <= 0 or w <= 0:
                    continue

                aspect = h / float(w)
                fill = area / float(w * h)
                if aspect < 1.35 or aspect > 2.8:
                    reject_summary["aspect"] += 1
                    continue
                if fill < 0.60:
                    reject_summary["fill"] += 1
                    continue

                candidate = (int(area), float(aspect), float(fill))
                if best is None or area > best[0]:
                    best = candidate

            if best is None and reject_summary["total"] > 0:
                try:
                    self._send_feedback(
                        f"no match: {reject_summary['total']} blobs, "
                        f"rejected area={reject_summary['area']} "
                        f"edge={reject_summary['edge']} "
                        f"aspect={reject_summary['aspect']} "
                        f"fill={reject_summary['fill']}"
                    )
                except Exception:
                    pass

            return best
        except Exception as exc:
            try:
                self._send_feedback(f"detector error: {exc}")
            except Exception:
                pass
            return None
