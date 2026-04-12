"""lidar_scan_check — cross-validates lidar anomalies against the stereo depth camera.

Flow:
  1. Collect lidar scans for 4 seconds to find persistent anomalies.
  2. If anomaly found, grab one PointCloud2 frame from the stereo camera.
  3. If any point cloud points are within 25 cm → sensors agree, nominal.
  4. If no close points in depth cloud → LIDAR FAULT detected.
"""

import base64
import json
import math
import re
import struct
import time
from collections import defaultdict

import websocket

from std_msgs.msg import String
from brain_client.skill_types import Skill, SkillResult

ROSBRIDGE      = "ws://localhost:9090"
SCAN_DURATION  = 4.0    # seconds to collect lidar scans
PCL_WAIT       = 5.0    # seconds to wait for one point cloud frame
PCL_TOPIC      = "/mars/main_camera/points"
CLOSE_THRESH   = 1.0    # metres — anything within 1m in depth cloud = something is there
MIN_FOV_FRAC   = 0.08   # cluster must cover at least 8% of total beams (real blockage, not noise)

ANOMALY_RATIO  = 0.35   # beam suspicious if < this fraction of scan median
MIN_CLUSTER    = 20     # min consecutive confirmed beams
MIN_SCAN_RATIO = 0.5    # beam must be suspicious in this fraction of scans


def _fix_json(raw: str) -> str:
    raw = raw.replace("[,", "[null,")
    raw = re.sub(r",(?=[,\]])", ",null", raw)
    return raw


def _decode_pcl_min_z(msg: dict) -> float | None:
    """Return the minimum z (depth) value from a PointCloud2 message, or None."""
    fields     = msg.get("fields", [])
    point_step = int(msg.get("point_step", 0))
    data       = msg.get("data", None)
    if not fields or not point_step or data is None:
        return None

    z_field = next((f for f in fields if f["name"] == "z"), None)
    if not z_field:
        return None

    z_offset = int(z_field["offset"])
    le       = not bool(msg.get("is_bigendian", False))
    fmt      = "<f" if le else ">f"

    if isinstance(data, str):
        raw_bytes = base64.b64decode(data)
    else:
        raw_bytes = bytes(data)

    min_z = float("inf")
    n_points = len(raw_bytes) // point_step
    # sample every 10th point — enough to catch close obstacles without slowness
    for i in range(0, n_points, 10):
        offset = i * point_step + z_offset
        if offset + 4 > len(raw_bytes):
            break
        (z,) = struct.unpack_from(fmt, raw_bytes, offset)
        if math.isfinite(z) and z > 0:
            min_z = min(min_z, z)

    return min_z if min_z < float("inf") else None


class LidarScanCheck(Skill):

    def __init__(self, logger):
        self.logger = logger
        self._tts_pub = None

    def _speak(self, text: str):
        if self._tts_pub is None:
            self._tts_pub = self.node.create_publisher(String, "/brain/tts", 10)
            time.sleep(0.1)
        self._tts_pub.publish(String(data=text))

    # ------------------------------------------------------------------ lidar

    def _collect_scans(self) -> list[dict]:
        scans = []
        ws = websocket.WebSocket()
        ws.connect(ROSBRIDGE, timeout=5)
        ws.send(json.dumps({
            "op": "subscribe", "id": "lsc_scan",
            "topic": "/scan", "type": "sensor_msgs/msg/LaserScan",
            "throttle_rate": 0,
        }))
        ws.settimeout(0.5)
        deadline = time.monotonic() + SCAN_DURATION
        while time.monotonic() < deadline:
            try:
                msg = json.loads(_fix_json(ws.recv()))
                if msg.get("op") == "publish" and msg.get("topic") == "/scan":
                    scans.append(msg["msg"])
            except Exception:
                continue
        ws.close()
        self.logger.info(f"Collected {len(scans)} lidar scans")
        return scans

    def _find_anomaly(self, scans: list[dict]) -> dict | None:
        if not scans:
            return None

        scan0  = scans[0]
        rmin   = float(scan0.get("range_min", 0.15))
        rmax   = float(scan0.get("range_max", 12.0))
        amin   = float(scan0.get("angle_min", -math.pi))
        ainc   = float(scan0.get("angle_increment", 0.01))
        n_beams = len(scan0.get("ranges", []))
        if n_beams == 0:
            return None

        hot_counts = defaultdict(int)
        for scan in scans:
            ranges = scan.get("ranges", [])
            valid  = [r for r in ranges
                      if r is not None and math.isfinite(r) and rmin < r < rmax]
            if len(valid) < 20:
                continue
            median    = sorted(valid)[len(valid) // 2]
            threshold = median * ANOMALY_RATIO
            for i, r in enumerate(ranges):
                if r is None or not math.isfinite(r) or r <= 0 or r < rmin:
                    hot_counts[i] += 1
                elif r < threshold:
                    hot_counts[i] += 1

        n_scans   = len(scans)
        confirmed = sorted(i for i, c in hot_counts.items() if c / n_scans >= MIN_SCAN_RATIO)
        if len(confirmed) < MIN_CLUSTER:
            return None

        clusters, cur = [], [confirmed[0]]
        for idx in confirmed[1:]:
            if idx - cur[-1] <= 3:
                cur.append(idx)
            else:
                clusters.append(cur); cur = [idx]
        clusters.append(cur)
        best = max(clusters, key=len)
        if len(best) < MIN_CLUSTER:
            return None
        if len(best) < n_beams * MIN_FOV_FRAC:
            self.logger.info(f"Cluster {len(best)} beams too small vs FOV ({n_beams} total, need {MIN_FOV_FRAC*100:.0f}%)")
            return None

        mid_idx   = best[len(best) // 2]
        mid_angle = amin + mid_idx * ainc
        beam_ranges = [
            s["ranges"][mid_idx] for s in scans
            if mid_idx < len(s.get("ranges", []))
            and s["ranges"][mid_idx] is not None
            and math.isfinite(s["ranges"][mid_idx])
            and s["ranges"][mid_idx] > 0
        ]
        mid_range = sorted(beam_ranges)[len(beam_ranges) // 2] if beam_ranges else 0.0

        return {
            "angle_deg":    round(math.degrees(mid_angle), 1),
            "range_m":      round(float(mid_range), 3),
            "cluster_size": len(best),
            "scans_used":   n_scans,
        }

    # ------------------------------------------------------------------ depth

    def _get_min_depth(self) -> float | None:
        ws = websocket.WebSocket()
        ws.connect(ROSBRIDGE, timeout=5)
        ws.send(json.dumps({
            "op": "subscribe", "id": "lsc_pcl",
            "topic": PCL_TOPIC, "type": "sensor_msgs/msg/PointCloud2",
            "throttle_rate": 0,
        }))
        ws.settimeout(1.0)
        deadline = time.monotonic() + PCL_WAIT
        min_z = None
        while time.monotonic() < deadline:
            try:
                msg = json.loads(ws.recv())
                if msg.get("op") == "publish" and msg.get("topic") == PCL_TOPIC:
                    min_z = _decode_pcl_min_z(msg["msg"])
                    break
            except Exception:
                continue
        ws.close()
        return min_z

    # ------------------------------------------------------------------ skill

    @property
    def name(self) -> str:
        return "lidar_cross_validate"

    def guidelines(self) -> str:
        return (
            "Cross-validates lidar anomalies against the stereo depth camera. "
            "Collects 4 seconds of lidar scans to find persistent close-range clusters, "
            "then checks the point cloud for objects within 25 cm. "
            "Reports LIDAR FAULT if lidar sees an obstacle but depth camera does not."
        )

    def execute(self) -> tuple[str, SkillResult]:
        self._speak("Starting lidar cross-validation.")

        scans   = self._collect_scans()
        anomaly = self._find_anomaly(scans)

        if not anomaly:
            result = {
                "verdict": "nominal",
                "message": "Nominal. No persistent lidar anomalies detected.",
                "scans_used": len(scans),
            }
            self._speak("Nominal.")
            return json.dumps(result, indent=2), SkillResult.SUCCESS

        self.logger.info(f"Lidar anomaly: {anomaly} — checking depth camera…")
        min_z = self._get_min_depth()
        self.logger.info(f"Depth camera min z: {min_z}")

        depth_close = min_z is not None and min_z < CLOSE_THRESH

        if depth_close:
            result = {
                "verdict": "nominal",
                "message": f"Nominal. Depth camera confirms obstacle at {min_z:.3f}m — sensors agree.",
                "anomaly": anomaly,
                "depth_min_m": round(min_z, 3),
            }
            self._speak("Nominal.")
        else:
            result = {
                "verdict": "lidar_fault",
                "message": (
                    f"Lidar fault detected. Lidar reported obstacle at {anomaly['range_m']}m "
                    f"but depth camera sees nothing within {CLOSE_THRESH}m."
                ),
                "anomaly":    anomaly,
                "depth_min_m": round(min_z, 3) if min_z is not None else None,
            }
            self._speak("Lidar fault detected.")

        return json.dumps(result, indent=2), SkillResult.SUCCESS

    def cancel(self) -> str:
        return "lidar_scan_check cancelled"
