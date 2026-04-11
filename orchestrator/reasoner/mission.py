"""Mission plan representation — thin wrapper for reasoner context."""
from __future__ import annotations

from orchestrator.world_model.task_state import MissionPlan, MissionStatus, Task


def mission_summary(mission: MissionPlan) -> str:
    """Human-readable mission summary for Claude context."""
    lines = [
        f"Mission {mission.id}: {mission.description} [{mission.status.value}]"
    ]
    for t in mission.tasks:
        robot = t.assigned_robot or "unassigned"
        lines.append(
            f"  - [{t.id}] {t.task_type.value}: {t.description} "
            f"({t.status.value}, robot={robot})"
        )
    return "\n".join(lines)
