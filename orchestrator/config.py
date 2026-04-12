"""Fleet configuration and ROS2 topic catalog."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


# ---------------------------------------------------------------------------
# Topic catalog — sourced from docs/REFERENCE.md rate-sanity table
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TopicDef:
    msg_type: str
    expected_hz: float | None  # None = TBD / unverified


MONITORED_TOPICS: dict[str, TopicDef] = {
    "/odom":           TopicDef("nav_msgs/msg/Odometry",                            expected_hz=None),
    "/amcl_pose":      TopicDef("geometry_msgs/msg/PoseWithCovarianceStamped",      expected_hz=None),
    "/battery_state":  TopicDef("sensor_msgs/msg/BatteryState",                     expected_hz=None),
    "/scan":           TopicDef("sensor_msgs/msg/LaserScan",                        expected_hz=6.0),
    "/mars/arm/state": TopicDef("sensor_msgs/msg/JointState",                       expected_hz=None),
}


# ---------------------------------------------------------------------------
# Typed config dataclasses
# ---------------------------------------------------------------------------

@dataclass
class RobotConfig:
    name: str
    host: str
    port: int = 9090
    capabilities: list[str] = field(default_factory=lambda: ["navigate", "scan"])


@dataclass
class ClaudeConfig:
    model: str = "claude-sonnet-4-20250514"
    max_tokens: int = 4096


@dataclass
class HealthConfig:
    rate_window_s: float = 2.0
    rate_degraded_threshold: float = 0.5
    rate_failed_threshold: float = 0.0
    heartbeat_timeout_s: float = 5.0
    comms_blackout_s: float = 10.0
    eval_interval_s: float = 1.0


@dataclass
class HubConfig:
    fleet: list[RobotConfig]
    claude: ClaudeConfig
    health: HealthConfig


def load_config(path: str | Path | None = None) -> HubConfig:
    """Load fleet_config.yaml from *path* or fall back to the bundled default."""
    if path is None:
        path = Path(__file__).parent / "fleet_config.yaml"
    else:
        path = Path(path)

    # Allow env-var override for the config path
    env_path = os.environ.get("LMAO_CONFIG")
    if env_path:
        path = Path(env_path)

    with open(path) as f:
        raw = yaml.safe_load(f)

    fleet = [RobotConfig(**r) for r in raw.get("fleet", [])]
    claude_raw = raw.get("claude", {})
    claude = ClaudeConfig(**claude_raw)
    health_raw = raw.get("health", {})
    health = HealthConfig(**health_raw)

    return HubConfig(fleet=fleet, claude=claude, health=health)
