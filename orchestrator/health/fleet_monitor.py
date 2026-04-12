"""FleetHealthMonitor — subscribes to health topics, runs periodic eval."""
from __future__ import annotations

import asyncio
import logging
import time

from orchestrator.comms.connection_manager import ConnectionManager
from orchestrator.config import MONITORED_TOPICS, HealthConfig
from orchestrator.health.degradation import DegradationManager
from orchestrator.health.rate_monitor import RateMonitor, TopicHealth
from orchestrator.world_model.model import WorldModel
from orchestrator.world_model.robot_state import HealthTier
from orchestrator.world_model.task_state import EventType, WorldEvent

log = logging.getLogger(__name__)


class FleetHealthMonitor:
    """Subscribes to health-relevant topics for every connected robot and
    periodically evaluates degradation tiers.
    """

    def __init__(
        self,
        conn: ConnectionManager,
        world: WorldModel,
        config: HealthConfig,
    ) -> None:
        self._conn = conn
        self._world = world
        self._config = config

        self._rate_monitor = RateMonitor(
            window_s=config.rate_window_s,
            degraded_threshold=config.rate_degraded_threshold,
        )
        self._degradation: dict[str, DegradationManager] = {}
        self._last_ws_time: dict[str, float] = {}
        self._comms_lost: dict[str, bool] = {}       # per-robot comms blackout state
        self._comms_lost_since: dict[str, float] = {} # when comms were lost
        self._eval_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self, robot_names: list[str]) -> None:
        """Subscribe to health topics on each robot and start the eval loop."""
        for name in robot_names:
            self._degradation[name] = DegradationManager(
                name,
                heartbeat_timeout_s=self._config.heartbeat_timeout_s,
                comms_blackout_s=self._config.comms_blackout_s,
            )
            self._comms_lost[name] = False
            self._subscribe_robot(name)

        self._eval_task = asyncio.create_task(self._eval_loop())
        log.info("Fleet health monitor started for %s", robot_names)

    async def stop(self) -> None:
        if self._eval_task:
            self._eval_task.cancel()
            try:
                await self._eval_task
            except asyncio.CancelledError:
                pass
        log.info("Fleet health monitor stopped.")

    # ------------------------------------------------------------------
    # Subscription wiring
    # ------------------------------------------------------------------

    def _subscribe_robot(self, robot_name: str) -> None:
        """Subscribe to all MONITORED_TOPICS on a single robot."""
        for topic, tdef in MONITORED_TOPICS.items():
            self._conn.subscribe(
                robot_name, topic, tdef.msg_type, self._on_message
            )
        # Also subscribe to ws_messages for comms blackout detection
        self._conn.subscribe(
            robot_name, "ws_messages", "std_msgs/msg/String", self._on_ws_message
        )

    def _on_message(self, robot_name: str, topic: str, msg: dict) -> None:
        """Callback for every health-monitored topic.  Fires on asyncio loop."""
        self._rate_monitor.record(robot_name, topic)

        # Any topic message proves comms are alive (don't rely solely on
        # the ws_messages synthetic topic which the robot may not publish).
        self._last_ws_time[robot_name] = time.monotonic()

        # Route to world-model updaters (schedule as coroutines)
        loop = asyncio.get_event_loop()
        if topic == "/amcl_pose":
            loop.create_task(self._world.update_amcl_pose(robot_name, msg))
        elif topic == "/odom":
            loop.create_task(self._world.update_odom(robot_name, msg))
        elif topic == "/battery_state":
            loop.create_task(self._world.update_battery(robot_name, msg))
        elif topic == "/mars/arm/state":
            loop.create_task(self._world.update_arm_state(robot_name, msg))

    def _on_ws_message(self, robot_name: str, topic: str, msg: dict) -> None:
        """Track last ws_messages timestamp for comms-blackout detection."""
        self._last_ws_time[robot_name] = time.monotonic()

    # ------------------------------------------------------------------
    # Periodic evaluation
    # ------------------------------------------------------------------

    async def _eval_loop(self) -> None:
        """Runs every eval_interval_s.  Evaluates health for all robots."""
        while True:
            await asyncio.sleep(self._config.eval_interval_s)
            await self._evaluate_all()

    async def _evaluate_all(self) -> None:
        now = time.monotonic()

        for robot_name, deg in self._degradation.items():
            # Collect topic health for topics with known expected rates
            topic_health: dict[str, TopicHealth] = {}
            for topic, tdef in MONITORED_TOPICS.items():
                if tdef.expected_hz is not None:
                    topic_health[topic] = self._rate_monitor.get_health(
                        robot_name, topic, tdef.expected_hz
                    )

            # Get battery from world model
            rs = await self._world.get_robot_state(robot_name)
            battery_pct = rs.battery_percentage if rs else None
            last_hb = rs.last_heartbeat_time if rs else None
            last_ws = self._last_ws_time.get(robot_name)

            # --- Comms blackout detection (Channel M) ---
            was_lost = self._comms_lost.get(robot_name, False)
            is_blackout = (
                last_ws is not None
                and (now - last_ws) > self._config.comms_blackout_s
            )

            if is_blackout and not was_lost:
                # Comms just went down
                self._comms_lost[robot_name] = True
                self._comms_lost_since[robot_name] = now
                log.warning("COMMS LOST: %s (no ws_messages for %.0fs)",
                            robot_name, now - last_ws)
                await self._world.emit_event(
                    WorldEvent(
                        type=EventType.COMMS_LOST,
                        robot=robot_name,
                        data={
                            "last_contact_ago_s": round(now - last_ws, 1),
                            "robot_last_position": rs.position if rs else None,
                            "robot_last_task": rs.current_task_id if rs else None,
                        },
                    )
                )

            elif not is_blackout and was_lost:
                # Comms just restored
                self._comms_lost[robot_name] = False
                blackout_duration = now - self._comms_lost_since.get(robot_name, now)
                log.info("COMMS RESTORED: %s (blackout lasted %.0fs)",
                         robot_name, blackout_duration)
                await self._world.emit_event(
                    WorldEvent(
                        type=EventType.COMMS_RESTORED,
                        robot=robot_name,
                        data={
                            "blackout_duration_s": round(blackout_duration, 1),
                            "robot_position": rs.position if rs else None,
                            "robot_battery": rs.battery_percentage if rs else None,
                            "robot_task": rs.current_task_id if rs else None,
                        },
                    )
                )

            # --- Standard tier evaluation ---
            new_tier = deg.evaluate(topic_health, battery_pct, last_hb, last_ws)
            if new_tier is not None:
                await self._world.update_health_tier(robot_name, new_tier)
                if new_tier == HealthTier.FULL_CAPABILITY:
                    etype = EventType.ROBOT_RECOVERED
                else:
                    etype = EventType.ROBOT_DEGRADED
                await self._world.emit_event(
                    WorldEvent(
                        type=etype,
                        robot=robot_name,
                        data={
                            "old_tier": deg.current_tier.value,
                            "new_tier": new_tier.value,
                            "topic_health": {
                                t: h.value for t, h in topic_health.items()
                            },
                        },
                    )
                )

    # ------------------------------------------------------------------
    # Query (for reasoner tools)
    # ------------------------------------------------------------------

    def get_health_report(self) -> dict[str, dict]:
        """Synchronous snapshot of fleet health for the reasoner."""
        report: dict[str, dict] = {}
        for robot_name, deg in self._degradation.items():
            rates = self._rate_monitor.get_all_rates(robot_name)
            report[robot_name] = {
                "tier": deg.current_tier.value,
                "topic_rates_hz": {t: round(r, 2) for t, r in rates.items()},
            }
        return report
