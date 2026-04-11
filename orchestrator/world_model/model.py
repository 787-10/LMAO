"""WorldModel — single source of truth for fleet state."""
from __future__ import annotations

import asyncio
import math
import time

from orchestrator.world_model.robot_state import HealthTier, RobotState, TaskStatus
from orchestrator.world_model.task_state import (
    EventType,
    MissionPlan,
    MissionStatus,
    Task,
    WorldEvent,
)


class WorldModel:
    """Central state store.  Updated by topic callbacks, queried by reasoner."""

    def __init__(self) -> None:
        self._robots: dict[str, RobotState] = {}
        self._missions: dict[str, MissionPlan] = {}
        self._lock = asyncio.Lock()
        self._event_queue: asyncio.Queue[WorldEvent] = asyncio.Queue()

    # ------------------------------------------------------------------
    # Robot registration
    # ------------------------------------------------------------------

    def register_robot(self, name: str, capabilities: list[str] | None = None) -> None:
        if name not in self._robots:
            self._robots[name] = RobotState(
                name=name,
                capabilities=capabilities or [],
            )

    # ------------------------------------------------------------------
    # Update methods (called by topic callbacks / health monitor)
    # ------------------------------------------------------------------

    async def update_odom(self, robot_name: str, msg: dict) -> None:
        async with self._lock:
            rs = self._robots.get(robot_name)
            if rs is None:
                return
            pose = msg.get("pose", {}).get("pose", {})
            pos = pose.get("position", {})
            orient = pose.get("orientation", {})
            # Extract yaw from quaternion (z-axis rotation)
            qz = orient.get("z", 0.0)
            qw = orient.get("w", 1.0)
            theta = 2.0 * math.atan2(qz, qw)
            rs.position = (pos.get("x", 0.0), pos.get("y", 0.0), theta)
            twist = msg.get("twist", {}).get("twist", {})
            lin = twist.get("linear", {})
            ang = twist.get("angular", {})
            rs.velocity = (lin.get("x", 0.0), ang.get("z", 0.0))
            rs.last_odom_time = time.monotonic()

    async def update_battery(self, robot_name: str, msg: dict) -> None:
        async with self._lock:
            rs = self._robots.get(robot_name)
            if rs is None:
                return
            rs.battery_voltage = msg.get("voltage")
            rs.battery_percentage = msg.get("percentage")
            rs.last_battery_time = time.monotonic()

    async def update_arm_state(self, robot_name: str, msg: dict) -> None:
        async with self._lock:
            rs = self._robots.get(robot_name)
            if rs is None:
                return
            rs.arm_joint_positions = msg.get("position")
            rs.arm_joint_efforts = msg.get("effort")

    async def update_heartbeat(self, robot_name: str) -> None:
        async with self._lock:
            rs = self._robots.get(robot_name)
            if rs is None:
                return
            rs.last_heartbeat_time = time.monotonic()

    async def update_connection(self, robot_name: str, connected: bool) -> None:
        async with self._lock:
            rs = self._robots.get(robot_name)
            if rs is None:
                return
            rs.connected = connected

    async def update_health_tier(self, robot_name: str, tier: HealthTier) -> None:
        async with self._lock:
            rs = self._robots.get(robot_name)
            if rs is None:
                return
            rs.health_tier = tier

    # ------------------------------------------------------------------
    # Query methods (called by reasoner tools)
    # ------------------------------------------------------------------

    async def get_robot_state(self, robot_name: str) -> RobotState | None:
        async with self._lock:
            return self._robots.get(robot_name)

    async def get_all_robots(self) -> dict[str, RobotState]:
        async with self._lock:
            return dict(self._robots)

    async def get_available_robots(self) -> list[str]:
        """Robots healthy enough to accept new tasks."""
        async with self._lock:
            return [
                name
                for name, rs in self._robots.items()
                if rs.connected
                and rs.health_tier
                in (HealthTier.FULL_CAPABILITY, HealthTier.DEGRADED_SENSORS)
            ]

    async def get_fleet_summary(self) -> str:
        """Human-readable fleet summary for Claude context injection."""
        async with self._lock:
            if not self._robots:
                return "No robots registered."
            lines = [rs.summary() for rs in self._robots.values()]
            return "\n".join(lines)

    # ------------------------------------------------------------------
    # Task / mission management
    # ------------------------------------------------------------------

    async def add_mission(self, mission: MissionPlan) -> None:
        async with self._lock:
            self._missions[mission.id] = mission

    async def get_mission(self, mission_id: str) -> MissionPlan | None:
        async with self._lock:
            return self._missions.get(mission_id)

    async def get_active_missions(self) -> list[MissionPlan]:
        async with self._lock:
            return [
                m for m in self._missions.values()
                if m.status == MissionStatus.ACTIVE
            ]

    async def assign_task(self, task_id: str, robot_name: str) -> bool:
        """Assign a task to a robot.  Returns False if task/robot not found."""
        async with self._lock:
            # Find the task across missions
            for mission in self._missions.values():
                for task in mission.tasks:
                    if task.id == task_id:
                        task.assigned_robot = robot_name
                        task.status = TaskStatus.IN_PROGRESS
                        rs = self._robots.get(robot_name)
                        if rs:
                            rs.current_task_id = task_id
                            rs.task_status = TaskStatus.IN_PROGRESS
                        return True
            return False

    async def update_task_status(
        self, task_id: str, status: TaskStatus
    ) -> None:
        async with self._lock:
            for mission in self._missions.values():
                for task in mission.tasks:
                    if task.id == task_id:
                        task.status = status
                        if task.assigned_robot:
                            rs = self._robots.get(task.assigned_robot)
                            if rs and rs.current_task_id == task_id:
                                rs.task_status = status
                                if status in (
                                    TaskStatus.COMPLETED,
                                    TaskStatus.FAILED,
                                ):
                                    rs.current_task_id = None
                                    rs.task_status = TaskStatus.IDLE
                        return

    async def get_tasks_for_robot(self, robot_name: str) -> list[Task]:
        async with self._lock:
            tasks: list[Task] = []
            for mission in self._missions.values():
                for task in mission.tasks:
                    if task.assigned_robot == robot_name:
                        tasks.append(task)
            return tasks

    # ------------------------------------------------------------------
    # Event stream
    # ------------------------------------------------------------------

    async def emit_event(self, event: WorldEvent) -> None:
        await self._event_queue.put(event)

    async def get_next_event(self, timeout: float | None = None) -> WorldEvent | None:
        try:
            return await asyncio.wait_for(self._event_queue.get(), timeout=timeout)
        except (asyncio.TimeoutError, TimeoutError):
            return None
