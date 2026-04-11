"""Per-robot state dataclass."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class HealthTier(Enum):
    FULL_CAPABILITY = "FULL_CAPABILITY"
    DEGRADED_SENSORS = "DEGRADED_SENSORS"
    LOCAL_ONLY = "LOCAL_ONLY"
    SAFE_MODE = "SAFE_MODE"
    HIBERNATION = "HIBERNATION"


class TaskStatus(Enum):
    IDLE = "IDLE"
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


@dataclass
class RobotState:
    name: str
    connected: bool = False
    health_tier: HealthTier = HealthTier.FULL_CAPABILITY

    # From /odom
    position: tuple[float, float, float] | None = None   # x, y, theta
    velocity: tuple[float, float] | None = None           # linear, angular

    # From /battery_state
    battery_voltage: float | None = None
    battery_percentage: float | None = None

    # From /mars/arm/state
    arm_joint_positions: list[float] | None = None
    arm_joint_efforts: list[float] | None = None

    # Timestamps (monotonic)
    last_odom_time: float | None = None
    last_battery_time: float | None = None
    last_heartbeat_time: float | None = None

    # Task assignment
    current_task_id: str | None = None
    task_status: TaskStatus = TaskStatus.IDLE

    # Capabilities (from config)
    capabilities: list[str] = field(default_factory=list)

    def summary(self) -> str:
        """Human-readable one-liner for this robot."""
        pos = f"({self.position[0]:.1f}, {self.position[1]:.1f})" if self.position else "unknown"
        batt = f"{self.battery_percentage:.0f}%" if self.battery_percentage is not None else "?"
        task = self.current_task_id or "idle"
        return (
            f"{self.name}: {self.health_tier.value} | "
            f"pos={pos} | battery={batt} | task={task}"
        )
