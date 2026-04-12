"""Simulation layer — fake robots for offline demo / development.

    uv run python -m orchestrator --sim

Provides:
- SimConnectionManager: drop-in replacement that logs commands instead of
  talking to real rosbridge.  Returns plausible success responses.
- Simulator: background task that feeds synthetic telemetry into the
  WorldModel so the health monitor, reasoner, and allocator all work
  end-to-end without hardware.

The REPL gains extra commands in sim mode:
  fault <robot>       — kill a sensor feed to trigger degradation
  recover <robot>     — restore full telemetry
  drain <robot>       — set battery to 10% (triggers SAFE_MODE)
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Any

from orchestrator.config import RobotConfig
from orchestrator.world_model.model import WorldModel

log = logging.getLogger(__name__)


# ------------------------------------------------------------------
# SimConnectionManager — replaces ConnectionManager
# ------------------------------------------------------------------

class SimConnectionManager:
    """Fake connection manager that never touches the network.

    Keeps the same public interface as ConnectionManager so every caller
    (health monitor, reasoner tool handlers) works unchanged.
    """

    def __init__(self, fleet: list[RobotConfig]) -> None:
        self._fleet = {r.name: r for r in fleet}
        self._connected: dict[str, bool] = {}
        self._callbacks: dict[str, list[tuple[str, str, Any]]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- lifecycle ---------------------------------------------------

    async def connect_all(self) -> dict[str, bool]:
        self._loop = asyncio.get_running_loop()
        results: dict[str, bool] = {}
        for name in self._fleet:
            self._connected[name] = True
            self._callbacks.setdefault(name, [])
            results[name] = True
            log.info("[SIM] %s connected (simulated)", name)
        return results

    async def connect_robot(self, name: str, host: str, port: int) -> bool:
        self._connected[name] = True
        return True

    def is_connected(self, name: str) -> bool:
        return self._connected.get(name, False)

    # -- subscribe / publish / service --------------------------------

    def subscribe(self, robot_name: str, topic: str, msg_type: str,
                  callback: Any) -> None:
        """Store callbacks so the Simulator can push messages through them."""
        self._callbacks.setdefault(robot_name, []).append(
            (topic, msg_type, callback)
        )

    def push_message(self, robot_name: str, topic: str, msg: dict) -> None:
        """Simulator calls this to inject a fake ROS message."""
        for t, _, cb in self._callbacks.get(robot_name, []):
            if t == topic:
                cb(robot_name, topic, msg)

    def publish(self, robot_name: str, topic: str, msg_type: str,
                msg: dict) -> None:
        log.info("[SIM] PUB  %s %s → %s", robot_name, topic, _short(msg))

    async def run_skill(self, robot_name: str, skill_type: str,
                        inputs: dict | None = None) -> dict:
        log.info("[SIM] SKILL %s → %s(%s)", robot_name, skill_type, _short(inputs))
        return {"success": True, "message": "simulated", "skill": skill_type}

    async def send_nav_goal(self, robot_name: str, x: float, y: float,
                            theta: float = 0.0) -> dict:
        log.info("[SIM] NAV  %s → (%.1f, %.1f, %.1f)", robot_name, x, y, theta)
        return await self.run_skill(robot_name, "innate-os/navigate_to_position",
                                    {"x": x, "y": y, "theta": theta})

    def send_cmd_vel(self, robot_name: str, linear_x: float = 0.0,
                     angular_z: float = 0.0) -> None:
        log.info("[SIM] VEL  %s lin=%.2f ang=%.2f", robot_name, linear_x, angular_z)

    def stop_robot(self, robot_name: str) -> None:
        log.info("[SIM] STOP %s", robot_name)

    async def execute_skill(self, robot_name: str, skill_name: str,
                            parameters: dict | None = None) -> dict:
        log.info("[SIM] SKILL %s → %s(%s)", robot_name, skill_name, _short(parameters))
        return {"success": True, "simulated": True, "skill": skill_name}

    async def shutdown(self) -> None:
        self._connected.clear()
        log.info("[SIM] All simulated connections closed.")


# ------------------------------------------------------------------
# Simulator — generates fake telemetry
# ------------------------------------------------------------------

class Simulator:
    """Background task that pushes synthetic messages into the sim
    connection manager at realistic rates.

    Each robot gets:
    - /odom           at ~10 Hz  (position random-walks)
    - /battery_state  at ~0.2 Hz (slow drain)
    - /scan           at ~6 Hz   (empty placeholder)
    - /lmao/heartbeat at ~1 Hz
    """

    def __init__(
        self,
        conn: SimConnectionManager,
        world: WorldModel,
        fleet: list[RobotConfig],
    ) -> None:
        self._conn = conn
        self._world = world
        self._fleet = fleet
        self._tasks: list[asyncio.Task] = []

        # Per-robot mutable state
        self._positions: dict[str, list[float]] = {}  # [x, y, theta]
        self._batteries: dict[str, float] = {}
        self._faulted: dict[str, set[str]] = {}       # robot -> set of killed topics
        self._blacked_out: set[str] = set()            # robots with total comms loss

    async def start(self) -> None:
        for cfg in self._fleet:
            # Scatter initial positions
            x = random.uniform(-2.0, 2.0)
            y = random.uniform(-2.0, 2.0)
            self._positions[cfg.name] = [x, y, 0.0]
            self._batteries[cfg.name] = random.uniform(70.0, 100.0)
            self._faulted[cfg.name] = set()

        self._tasks = [
            asyncio.create_task(self._odom_loop()),
            asyncio.create_task(self._battery_loop()),
            asyncio.create_task(self._scan_loop()),
            asyncio.create_task(self._heartbeat_loop()),
            asyncio.create_task(self._ws_messages_loop()),
        ]
        log.info("[SIM] Simulator started — %d robots", len(self._fleet))

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        log.info("[SIM] Simulator stopped.")

    # -- Fault injection (called from REPL) ---------------------------

    def inject_fault(self, robot_name: str, topic: str = "/scan") -> None:
        """Stop publishing *topic* for this robot."""
        self._faulted.setdefault(robot_name, set()).add(topic)
        log.info("[SIM] FAULT injected: %s %s killed", robot_name, topic)

    def clear_fault(self, robot_name: str) -> None:
        """Restore all topics for this robot."""
        self._faulted[robot_name] = set()
        log.info("[SIM] FAULT cleared: %s fully recovered", robot_name)

    def set_battery(self, robot_name: str, pct: float) -> None:
        self._batteries[robot_name] = pct
        log.info("[SIM] Battery %s set to %.0f%%", robot_name, pct)

    def blackout(self, robot_name: str) -> None:
        """Simulate total comms loss — stop ALL telemetry for this robot."""
        self._blacked_out.add(robot_name)
        log.info("[SIM] BLACKOUT: %s — all telemetry stopped", robot_name)

    def restore_comms(self, robot_name: str) -> None:
        """Restore comms — resume all telemetry for this robot."""
        self._blacked_out.discard(robot_name)
        log.info("[SIM] COMMS RESTORED: %s — telemetry resumed", robot_name)

    # -- Telemetry loops ----------------------------------------------

    async def _odom_loop(self) -> None:
        """~10 Hz position updates with random walk."""
        while True:
            for cfg in self._fleet:
                name = cfg.name
                if name in self._blacked_out:
                    continue
                if "/odom" in self._faulted.get(name, set()):
                    continue
                pos = self._positions[name]
                # Small random walk
                pos[0] += random.gauss(0, 0.005)
                pos[1] += random.gauss(0, 0.005)
                pos[2] += random.gauss(0, 0.002)
                qz = math.sin(pos[2] / 2)
                qw = math.cos(pos[2] / 2)
                msg = {
                    "pose": {"pose": {
                        "position": {"x": pos[0], "y": pos[1], "z": 0.0},
                        "orientation": {"x": 0.0, "y": 0.0, "z": qz, "w": qw},
                    }},
                    "twist": {"twist": {
                        "linear": {"x": random.gauss(0, 0.01), "y": 0, "z": 0},
                        "angular": {"x": 0, "y": 0, "z": random.gauss(0, 0.005)},
                    }},
                }
                self._conn.push_message(name, "/odom", msg)
            await asyncio.sleep(0.1)

    async def _battery_loop(self) -> None:
        """~0.2 Hz battery updates with slow drain."""
        while True:
            for cfg in self._fleet:
                name = cfg.name
                if name in self._blacked_out:
                    continue
                self._batteries[name] = max(0.0, self._batteries[name] - 0.05)
                msg = {
                    "voltage": 10.0 + (self._batteries[name] / 100.0) * 2.5,
                    "percentage": self._batteries[name],
                }
                self._conn.push_message(name, "/battery_state", msg)
            await asyncio.sleep(5.0)

    async def _scan_loop(self) -> None:
        """~6 Hz LiDAR placeholder."""
        while True:
            for cfg in self._fleet:
                name = cfg.name
                if name in self._blacked_out:
                    continue
                if "/scan" in self._faulted.get(name, set()):
                    continue
                msg = {
                    "header": {"stamp": {"sec": int(time.time()), "nanosec": 0}},
                    "ranges": [random.uniform(0.5, 5.0) for _ in range(360)],
                }
                self._conn.push_message(name, "/scan", msg)
            await asyncio.sleep(1.0 / 6.0)

    async def _heartbeat_loop(self) -> None:
        """~1 Hz heartbeat."""
        tick = 0
        while True:
            for cfg in self._fleet:
                name = cfg.name
                if name in self._blacked_out:
                    continue
                if "/lmao/heartbeat" in self._faulted.get(name, set()):
                    continue
                msg = {"data": f"alive (tick={tick})"}
                self._conn.push_message(name, "/lmao/heartbeat", msg)
            tick += 1
            await asyncio.sleep(1.0)

    async def _ws_messages_loop(self) -> None:
        """~0.5 Hz simulated cloud bridge messages (for comms blackout detection)."""
        while True:
            for cfg in self._fleet:
                name = cfg.name
                if name in self._blacked_out:
                    continue
                msg = {"data": "heartbeat"}
                self._conn.push_message(name, "ws_messages", msg)
            await asyncio.sleep(2.0)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _short(obj: Any, limit: int = 80) -> str:
    s = str(obj)
    return s if len(s) <= limit else s[:limit] + "..."
