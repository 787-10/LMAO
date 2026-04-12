"""Channel 4 — commanded vs actual joint position check.

Compares /mars/arm/command_state to /mars/arm/state.
Flags joints where |actual - commanded| exceeds threshold.
Publishes /lmao/fdir/joint_health at 2 Hz.
"""
from __future__ import annotations

import json
import math
import time
from typing import Any

from lmao_fdir.transport import Transport

DEVIATION_THRESHOLD_RAD = math.radians(5.0)  # 5 degrees
DEVIATION_HOLD_S = 0.5  # must persist for this long to flag

NUM_JOINTS = 7  # MARS arm: 6 arm joints + 1 gripper


class JointCheck:
    """Detects arm joint command/actual mismatches."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._actual_pos: list[float] | None = None
        self._cmd_pos: list[float] | None = None
        self._deviation_since: dict[int, float] = {}  # joint_idx -> monotonic time
        self._joint_status: list[dict[str, Any]] = []
        self._overall = "NOMINAL"

    def start(self) -> None:
        self._transport.subscribe(
            "/mars/arm/state",
            "sensor_msgs/JointState",
            self._on_actual,
        )
        self._transport.subscribe(
            "/mars/arm/command_state",
            "sensor_msgs/JointState",
            self._on_command,
        )
        self._transport.create_timer(0.5, self._evaluate)

    def _on_actual(self, msg: dict) -> None:
        positions = msg.get("position")
        if positions and isinstance(positions, (list, tuple)):
            self._actual_pos = list(positions)

    def _on_command(self, msg: dict) -> None:
        positions = msg.get("position")
        if positions and isinstance(positions, (list, tuple)):
            self._cmd_pos = list(positions)

    def _evaluate(self) -> None:
        now = time.monotonic()
        joints: list[dict[str, Any]] = []
        flagged = 0

        if self._actual_pos is None or self._cmd_pos is None:
            # No data yet — publish unknown status
            self._joint_status = []
            self._overall = "NO_DATA"
            self._publish()
            return

        n = min(len(self._actual_pos), len(self._cmd_pos), NUM_JOINTS)

        for i in range(n):
            actual = self._actual_pos[i]
            cmd = self._cmd_pos[i]
            error = abs(actual - cmd)
            error_deg = math.degrees(error)

            if error > DEVIATION_THRESHOLD_RAD:
                if i not in self._deviation_since:
                    self._deviation_since[i] = now
                held = now - self._deviation_since[i]
                if held >= DEVIATION_HOLD_S:
                    status = "FAULT"
                    flagged += 1
                else:
                    status = "WARNING"
            else:
                self._deviation_since.pop(i, None)
                status = "OK"

            joints.append({
                "id": i,
                "cmd_rad": round(cmd, 4),
                "actual_rad": round(actual, 4),
                "error_deg": round(error_deg, 2),
                "status": status,
            })

        if flagged >= 3:
            self._overall = "CRITICAL"
        elif flagged > 0:
            self._overall = "FAULT"
        else:
            self._overall = "NOMINAL"

        self._joint_status = joints
        self._publish()

    def _publish(self) -> None:
        report = {
            "joints": self._joint_status,
            "overall": self._overall,
        }
        self._transport.publish(
            "/lmao/fdir/joint_health",
            "std_msgs/String",
            {"data": json.dumps(report)},
        )

    def get_overall(self) -> str:
        return self._overall

    def has_faults(self) -> bool:
        return self._overall in ("FAULT", "CRITICAL")
