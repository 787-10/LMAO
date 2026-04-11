"""Channel K — rolling-window topic rate health."""
from __future__ import annotations

import time
from collections import defaultdict, deque
from enum import Enum


class TopicHealth(Enum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    FAILED = "FAILED"


class RateMonitor:
    """Per-robot, per-topic message rate tracker.

    Uses a rolling window of timestamps.  From REFERENCE.md Channel K:
    - rate < 50% of expected → DEGRADED
    - rate == 0              → FAILED
    """

    def __init__(
        self,
        window_s: float = 2.0,
        degraded_threshold: float = 0.5,
    ) -> None:
        self._window_s = window_s
        self._degraded_threshold = degraded_threshold
        # robot_name -> topic -> deque of monotonic timestamps
        self._timestamps: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(deque)
        )

    def record(self, robot_name: str, topic: str) -> None:
        """Record a message arrival.  Called on every received message."""
        self._timestamps[robot_name][topic].append(time.monotonic())

    def _prune(self, dq: deque[float], now: float) -> None:
        """Remove timestamps older than the window."""
        cutoff = now - self._window_s
        while dq and dq[0] < cutoff:
            dq.popleft()

    def get_rate(self, robot_name: str, topic: str) -> float:
        """Current rate (Hz) within the rolling window."""
        dq = self._timestamps.get(robot_name, {}).get(topic)
        if not dq:
            return 0.0
        now = time.monotonic()
        self._prune(dq, now)
        if not dq:
            return 0.0
        return len(dq) / self._window_s

    def get_health(
        self, robot_name: str, topic: str, expected_hz: float
    ) -> TopicHealth:
        """Evaluate topic health against expected rate."""
        rate = self.get_rate(robot_name, topic)
        if rate == 0.0:
            return TopicHealth.FAILED
        if rate < expected_hz * self._degraded_threshold:
            return TopicHealth.DEGRADED
        return TopicHealth.HEALTHY

    def get_all_rates(self, robot_name: str) -> dict[str, float]:
        """Return current Hz for every topic being tracked for a robot."""
        out: dict[str, float] = {}
        topics = self._timestamps.get(robot_name, {})
        now = time.monotonic()
        for topic, dq in topics.items():
            self._prune(dq, now)
            out[topic] = len(dq) / self._window_s if dq else 0.0
        return out
