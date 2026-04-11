#!/usr/bin/env python3
"""T2 — Topic introspection.

Verifies that every topic in EXPECTED is actually being published on the
robot, and that its publish rate is within ±20% of the expected value.

Run on the robot (uses `ros2 topic list` and `ros2 topic hz` via subprocess
so it doesn't need rclpy in the script's Python env):

    python3 tests/02_topic_check.py

Output is a per-topic PASS/FAIL table. Update REFERENCE.md and
config/topic_expectations.yaml with the actual rates discovered here.
"""
from __future__ import annotations

import re
import subprocess
import sys
from typing import Optional

# Topic name → (expected_hz_or_None_if_unknown, msg_type, source_note)
EXPECTED = {
    "/scan":                                  (6.0,   "sensor_msgs/msg/LaserScan",   "lidar.launch.py:42 throttle"),
    "/battery_state":                         (0.2,   "sensor_msgs/msg/BatteryState","robot_config.yaml:7"),
    "/odom":                                  (None,  "nav_msgs/msg/Odometry",       "TBD"),
    "/mars/arm/state":                        (None,  "sensor_msgs/msg/JointState",  "TBD"),
    "/mars/main_camera/left/image_raw":       (15.0,  "sensor_msgs/msg/Image",       "main_camera_driver.yaml:13"),
    "/mars/main_camera/left/camera_info":     (15.0,  "sensor_msgs/msg/CameraInfo",  "main_camera_driver.cpp:181"),
    "/mars/main_camera/depth/image_rect_raw": (8.0,   "sensor_msgs/msg/Image",       "stereo_depth_estimator.yaml:58 (lazy)"),
    "ws_messages":                            (None,  "std_msgs/msg/String",         "brain_client/ws_client_node.py:149"),
    "ws_outgoing":                            (None,  "std_msgs/msg/String",         "brain_client/ws_client_node.py:153"),
}

HZ_TOLERANCE = 0.2  # ±20%
HZ_SAMPLE_S = 5     # how long to measure each topic

OK = "\033[32m✓\033[0m"
WARN = "\033[33m!\033[0m"
FAIL = "\033[31m✗\033[0m"


def list_topics() -> set[str]:
    """All currently published topics on the robot."""
    try:
        out = subprocess.check_output(
            ["ros2", "topic", "list"], text=True, timeout=10
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"FATAL: `ros2 topic list` failed: {e}", file=sys.stderr)
        sys.exit(2)
    return {line.strip() for line in out.splitlines() if line.strip()}


def measure_hz(topic: str) -> Optional[float]:
    """Measure publish rate of `topic` over HZ_SAMPLE_S seconds.

    Returns None if no messages arrive (topic exists but is silent).
    """
    try:
        proc = subprocess.run(
            ["ros2", "topic", "hz", "--window", str(HZ_SAMPLE_S * 10), topic],
            capture_output=True, text=True, timeout=HZ_SAMPLE_S + 5,
        )
    except subprocess.TimeoutExpired as exc:
        # ros2 topic hz never returns on its own — timeout is expected.
        # Stdout up to that point still has the rate readout.
        text = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        if not text and exc.stdout is not None:
            text = exc.stdout.decode("utf-8", errors="replace")
    else:
        text = proc.stdout

    # Look for a line like: "average rate: 6.012"
    match = re.search(r"average rate:\s*([\d.]+)", text)
    if not match:
        return None
    return float(match.group(1))


def check_topic(name: str, expected_hz: Optional[float]) -> tuple[str, str]:
    """Returns (status_glyph, summary_string)."""
    actual = measure_hz(name)
    if actual is None:
        return FAIL, f"{name} — silent (no messages in {HZ_SAMPLE_S}s)"

    if expected_hz is None:
        return WARN, f"{name} — {actual:.2f} Hz (expected: TBD; record this value)"

    low = expected_hz * (1 - HZ_TOLERANCE)
    high = expected_hz * (1 + HZ_TOLERANCE)
    if low <= actual <= high:
        return OK, f"{name} — {actual:.2f} Hz (expected {expected_hz:.2f}, within ±{int(HZ_TOLERANCE*100)}%)"
    return FAIL, (
        f"{name} — {actual:.2f} Hz (expected {expected_hz:.2f}, "
        f"OUTSIDE ±{int(HZ_TOLERANCE*100)}% range [{low:.2f}, {high:.2f}])"
    )


def main() -> int:
    print("LMAO T2 — Topic introspection")
    print("=" * 60)

    print("\nStep 1: ros2 topic list")
    live = list_topics()
    missing = sorted(set(EXPECTED) - live)
    extra = sorted(live - set(EXPECTED))[:8]

    for name in EXPECTED:
        glyph = OK if name in live else FAIL
        print(f"  {glyph} {name}")

    if missing:
        print(f"\n{FAIL} Missing topics: {len(missing)}")
        for m in missing:
            print(f"    - {m}  ({EXPECTED[m][2]})")
        print("\nFix missing topics before running step 2.")
        return 1

    if extra:
        print(f"\n  ({len(extra)} other topics live, e.g.: {', '.join(extra)})")

    print(f"\nStep 2: measuring rates ({HZ_SAMPLE_S}s per topic)")
    failures = 0
    unknown_rates: dict[str, float] = {}
    for name, (expected_hz, _, _) in EXPECTED.items():
        glyph, summary = check_topic(name, expected_hz)
        print(f"  {glyph} {summary}")
        if glyph == FAIL:
            failures += 1
        if glyph == WARN:
            actual = measure_hz(name)
            if actual is not None:
                unknown_rates[name] = actual

    print()
    print("=" * 60)
    if unknown_rates:
        print("\nUnverified rates discovered (update REFERENCE.md + topic_expectations.yaml):")
        for name, hz in unknown_rates.items():
            print(f"  {name}: {hz:.2f} Hz")

    if failures:
        print(f"\n{FAIL} {failures} topic(s) failed rate check.")
        return 1
    print(f"\n{OK} All required topics present and within tolerance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
