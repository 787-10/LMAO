"""Task, mission, and event dataclasses."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum

from orchestrator.world_model.robot_state import TaskStatus


# ---------------------------------------------------------------------------
# Tasks & missions
# ---------------------------------------------------------------------------

class TaskType(Enum):
    NAVIGATE = "navigate"
    MANIPULATE = "manipulate"
    SCAN = "scan"
    WAIT = "wait"


class MissionStatus(Enum):
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    REPLANNING = "REPLANNING"


@dataclass
class Task:
    description: str
    task_type: TaskType
    target: dict
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    assigned_robot: str | None = None
    status: TaskStatus = TaskStatus.PENDING
    created_at: float = field(default_factory=time.time)


@dataclass
class MissionPlan:
    description: str
    tasks: list[Task] = field(default_factory=list)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    status: MissionStatus = MissionStatus.ACTIVE
    created_at: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# Events — bridge between health monitor and reasoner
# ---------------------------------------------------------------------------

class EventType(Enum):
    ROBOT_DEGRADED = "ROBOT_DEGRADED"
    ROBOT_RECOVERED = "ROBOT_RECOVERED"
    TASK_COMPLETED = "TASK_COMPLETED"
    TASK_FAILED = "TASK_FAILED"
    COMMS_LOST = "COMMS_LOST"
    COMMS_RESTORED = "COMMS_RESTORED"


@dataclass
class WorldEvent:
    type: EventType
    robot: str
    data: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def describe(self) -> str:
        return f"[{self.type.value}] {self.robot}: {self.data}"
