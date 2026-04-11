"""Task allocator — score and assign robots to tasks."""
from __future__ import annotations

import math
from typing import Any

from orchestrator.world_model.model import WorldModel
from orchestrator.world_model.robot_state import HealthTier, RobotState, TaskStatus
from orchestrator.world_model.task_state import Task, TaskType

# How much each health tier is worth (higher = more desirable)
_TIER_WEIGHT: dict[HealthTier, float] = {
    HealthTier.FULL_CAPABILITY: 1.0,
    HealthTier.DEGRADED_SENSORS: 0.5,
    HealthTier.LOCAL_ONLY: 0.1,
    HealthTier.SAFE_MODE: 0.0,
    HealthTier.HIBERNATION: 0.0,
}

# Task types that require specific capabilities
_TASK_CAPABILITY: dict[TaskType, str] = {
    TaskType.NAVIGATE: "navigate",
    TaskType.MANIPULATE: "manipulate",
    TaskType.SCAN: "scan",
    TaskType.WAIT: "navigate",  # any robot can wait
}


class TaskAllocator:
    """Scores robots for task suitability and picks the best candidate."""

    def __init__(self, world: WorldModel) -> None:
        self._world = world

    async def allocate(self, task: Task) -> str | None:
        """Pick the best robot for *task*.  Returns the robot name or None."""
        robots = await self._world.get_all_robots()
        candidates = [
            (name, rs)
            for name, rs in robots.items()
            if self._is_candidate(rs, task)
        ]
        if not candidates:
            return None

        scored = [
            (name, self._score(rs, task)) for name, rs in candidates
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[0][0]

    async def reallocate_from(self, failed_robot: str) -> list[tuple[str, str]]:
        """Reassign all pending/in-progress tasks from *failed_robot*.

        Returns a list of ``(task_id, new_robot_name)`` pairs.
        """
        tasks = await self._world.get_tasks_for_robot(failed_robot)
        reassigned: list[tuple[str, str]] = []

        for task in tasks:
            if task.status not in (TaskStatus.PENDING, TaskStatus.IN_PROGRESS):
                continue
            # Mark old assignment as failed
            await self._world.update_task_status(task.id, TaskStatus.FAILED)

            # Try to find a new robot
            new_robot = await self.allocate(task)
            if new_robot:
                await self._world.assign_task(task.id, new_robot)
                reassigned.append((task.id, new_robot))

        return reassigned

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _is_candidate(rs: RobotState, task: Task) -> bool:
        """Can this robot accept the task at all?"""
        if not rs.connected:
            return False
        if rs.health_tier in (HealthTier.SAFE_MODE, HealthTier.HIBERNATION):
            return False
        required_cap = _TASK_CAPABILITY.get(task.task_type, "navigate")
        if required_cap not in rs.capabilities:
            return False
        return True

    @staticmethod
    def _score(rs: RobotState, task: Task) -> float:
        """Higher is better."""
        score = 0.0

        # Health tier weight (0–10)
        score += _TIER_WEIGHT.get(rs.health_tier, 0.0) * 10.0

        # Distance penalty (if task has position target)
        tx = task.target.get("x")
        ty = task.target.get("y")
        if tx is not None and ty is not None:
            if rs.position is not None:
                dx = tx - rs.position[0]
                dy = ty - rs.position[1]
                dist = math.hypot(dx, dy)
                score -= dist  # closer is better
            else:
                # Unknown position — penalise for spatial tasks
                score -= 10.0

        # Prefer idle robots
        if rs.current_task_id is not None:
            score -= 5.0

        # Battery bonus (0–2)
        if rs.battery_percentage is not None:
            score += (rs.battery_percentage / 100.0) * 2.0

        return score
