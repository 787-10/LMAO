"""Channel K — ROS2 topic rate health monitoring.

Rolling 2s window per topic.  Publishes /lmao/fdir/rate_health at 1 Hz.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from typing import Any

from lmao_fdir.transport import Transport

# Expected rates from docs/REFERENCE.md
EXPECTED_RATES: dict[str, float] = {
    "/scan": 6.0,
    "/battery_state": 0.2,
    "/lmao/heartbeat": 1.0,
    # These are verified on-robot; set to None-equivalent if unknown
}

# Rates that may vary — add after verification on the real robot
OPTIONAL_RATES: dict[str, float] = {
    "/odom": 10.0,
    "/mars/arm/state": 50.0,
    "/mars/main_camera/left/image_raw/compressed": 15.0,
}

WINDOW_S = 2.0
DEGRADED_THRESHOLD = 0.5  # <50% of expected = DEGRADED


class RateHealth:
    """Monitors message rates for critical topics."""

    def __init__(self, transport: Transport, topics: dict[str, float] | None = None) -> None:
        self._transport = transport
        self._topics = topics or {**EXPECTED_RATES, **OPTIONAL_RATES}
        self._timestamps: dict[str, deque[float]] = defaultdict(deque)
        self._report: dict[str, dict[str, Any]] = {}

    def start(self) -> None:
        """Subscribe to all monitored topics and start the eval timer."""
        for topic in self._topics:
            # We only need to know messages arrive — content doesn't matter
            self._transport.subscribe(
                topic, "std_msgs/String",  # type is irrelevant for rate counting
                lambda msg, t=topic: self._on_message(t),
            )

        self._transport.create_timer(1.0, self._evaluate)

    def _on_message(self, topic: str) -> None:
        self._timestamps[topic].append(time.monotonic())

    def _evaluate(self) -> None:
        now = time.monotonic()
        cutoff = now - WINDOW_S
        report: dict[str, dict[str, Any]] = {}

        for topic, expected_hz in self._topics.items():
            dq = self._timestamps[topic]
            # Prune old timestamps
            while dq and dq[0] < cutoff:
                dq.popleft()

            actual_hz = len(dq) / WINDOW_S if dq else 0.0

            if actual_hz == 0.0:
                status = "FAILED"
            elif actual_hz < expected_hz * DEGRADED_THRESHOLD:
                status = "DEGRADED"
            else:
                status = "HEALTHY"

            report[topic] = {
                "expected_hz": expected_hz,
                "actual_hz": round(actual_hz, 2),
                "status": status,
            }

        self._report = report
        # Publish
        self._transport.publish(
            "/lmao/fdir/rate_health",
            "std_msgs/String",
            {"data": json.dumps(report)},
        )

    def get_report(self) -> dict[str, dict[str, Any]]:
        return dict(self._report)

    def has_failures(self) -> bool:
        return any(r["status"] == "FAILED" for r in self._report.values())

    def has_degraded(self) -> bool:
        return any(r["status"] != "HEALTHY" for r in self._report.values())
