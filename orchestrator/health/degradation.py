"""Channel R — degradation tier state machine."""
from __future__ import annotations

import logging
import time

from orchestrator.health.rate_monitor import TopicHealth
from orchestrator.world_model.robot_state import HealthTier

log = logging.getLogger(__name__)

# Topics whose failure triggers sensor degradation
CRITICAL_SENSOR_TOPICS = {"/scan", "/odom"}


class DegradationManager:
    """Per-robot tier state machine.

    Transition rules (higher tiers override lower):
      FULL_CAPABILITY   — all systems nominal
      DEGRADED_SENSORS  — any critical sensor DEGRADED or FAILED
      LOCAL_ONLY        — comms blackout (ws_messages gap > threshold)
      SAFE_MODE         — multiple sensors failed OR battery < 15%
      HIBERNATION       — battery < 5% OR no heartbeat
    """

    def __init__(
        self,
        robot_name: str,
        heartbeat_timeout_s: float = 5.0,
        comms_blackout_s: float = 10.0,
    ) -> None:
        self.robot_name = robot_name
        self.current_tier = HealthTier.FULL_CAPABILITY
        self._heartbeat_timeout = heartbeat_timeout_s
        self._comms_blackout = comms_blackout_s

    def evaluate(
        self,
        topic_health: dict[str, TopicHealth],
        battery_pct: float | None,
        last_heartbeat: float | None,
        last_ws_message: float | None,
    ) -> HealthTier | None:
        """Compute the new tier.  Returns the new tier if it changed, else None."""
        now = time.monotonic()
        new_tier = self._compute_tier(
            topic_health, battery_pct, last_heartbeat, last_ws_message, now
        )
        if new_tier != self.current_tier:
            old = self.current_tier
            self.current_tier = new_tier
            log.info(
                "%s: %s → %s", self.robot_name, old.value, new_tier.value
            )
            return new_tier
        return None

    def _compute_tier(
        self,
        topic_health: dict[str, TopicHealth],
        battery_pct: float | None,
        last_heartbeat: float | None,
        last_ws_message: float | None,
        now: float,
    ) -> HealthTier:
        # --- HIBERNATION checks (highest severity) ---
        if battery_pct is not None and battery_pct < 5.0:
            return HealthTier.HIBERNATION

        if last_heartbeat is not None:
            if (now - last_heartbeat) > self._heartbeat_timeout:
                return HealthTier.HIBERNATION

        # --- SAFE_MODE checks ---
        if battery_pct is not None and battery_pct < 15.0:
            return HealthTier.SAFE_MODE

        failed_count = sum(
            1 for h in topic_health.values() if h == TopicHealth.FAILED
        )
        if failed_count >= 2:
            return HealthTier.SAFE_MODE

        # --- LOCAL_ONLY check (comms blackout) ---
        if last_ws_message is not None:
            if (now - last_ws_message) > self._comms_blackout:
                return HealthTier.LOCAL_ONLY

        # --- DEGRADED_SENSORS check ---
        for topic, health in topic_health.items():
            if topic in CRITICAL_SENSOR_TOPICS and health != TopicHealth.HEALTHY:
                return HealthTier.DEGRADED_SENSORS

        return HealthTier.FULL_CAPABILITY
