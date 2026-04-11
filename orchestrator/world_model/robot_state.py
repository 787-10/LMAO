"""Per-robot state dataclass."""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum

# Default ring-buffer size: ~5 min at 10 Hz odom
DEFAULT_HISTORY_LEN = 3000


@dataclass(slots=True)
class Breadcrumb:
    """Single timestamped position sample."""
    t: float    # time.monotonic()
    x: float
    y: float
    theta: float


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

    # Position history (ring buffer)
    position_history: deque[Breadcrumb] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_HISTORY_LEN)
    )

    # Capabilities (from config)
    capabilities: list[str] = field(default_factory=list)

    def record_position(self, x: float, y: float, theta: float) -> None:
        """Append a breadcrumb to the ring buffer."""
        self.position_history.append(Breadcrumb(
            t=time.monotonic(), x=x, y=y, theta=theta,
        ))

    def get_trail(self, last_n: int | None = None) -> list[Breadcrumb]:
        """Return the most recent *last_n* breadcrumbs (or all if None)."""
        if last_n is None:
            return list(self.position_history)
        return list(self.position_history)[-last_n:]

    def summary(self) -> str:
        """Human-readable one-liner for this robot."""
        pos = f"({self.position[0]:.1f}, {self.position[1]:.1f})" if self.position else "unknown"
        batt = f"{self.battery_percentage:.0f}%" if self.battery_percentage is not None else "?"
        task = self.current_task_id or "idle"
        return (
            f"{self.name}: {self.health_tier.value} | "
            f"pos={pos} | battery={batt} | task={task}"
        )
