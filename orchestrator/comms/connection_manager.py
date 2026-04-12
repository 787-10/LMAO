"""Multi-robot WebSocket connection manager.

Speaks the same rosbridge-like JSON protocol as Innate's rws_server,
using raw WebSocket (autobahn/twisted) instead of roslibpy — because
rws_server rejects roslibpy's extra subscribe fields.

Subscribe messages match what the lucas dashboard sends:
  {"op": "subscribe", "topic": "/scan", "type": "sensor_msgs/msg/LaserScan"}

Publish messages:
  {"op": "advertise", "topic": "/cmd_vel", "type": "geometry_msgs/msg/Twist"}
  {"op": "publish", "topic": "/cmd_vel", "msg": {...}}
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from collections.abc import Callable
from typing import Any

from orchestrator.config import RobotConfig

log = logging.getLogger(__name__)


class _RobotWS:
    """Single WebSocket connection to one robot's rws_server."""

    def __init__(self, name: str, host: str, port: int, loop: asyncio.AbstractEventLoop) -> None:
        self.name = name
        self.host = host
        self.port = port
        self._loop = loop
        self._ws: Any = None
        self._connected = False
        self._listeners: dict[str, list[Callable]] = {}  # topic -> [callbacks]
        self._action_callbacks: dict[str, Callable] = {}  # msg_id -> callback
        self._advertised: set[str] = set()
        self._pending_subs: list[dict] = []
        self._action_counter = 0
        self._thread: threading.Thread | None = None

    def connect(self) -> bool:
        """Connect in a background thread (twisted reactor). Returns success."""
        ready = threading.Event()
        success = [False]

        def _run() -> None:
            from autobahn.twisted.websocket import (
                WebSocketClientFactory,
                WebSocketClientProtocol,
                connectWS,
            )
            from twisted.internet import reactor as _reactor

            parent = self

            class Proto(WebSocketClientProtocol):
                def onOpen(self):
                    parent._ws = self
                    parent._connected = True
                    success[0] = True
                    log.info("Connected to %s at ws://%s:%d", parent.name, parent.host, parent.port)
                    # Send any pending subscriptions
                    for sub in parent._pending_subs:
                        self.sendMessage(json.dumps(sub).encode("utf-8"))
                    parent._pending_subs.clear()
                    ready.set()

                def onMessage(self, payload, isBinary):
                    if isBinary:
                        return
                    try:
                        raw = payload.decode("utf-8")
                        # rws sends null-gap arrays like [, and ,, — fix before parsing
                        raw = re.sub(r"\[,", "[null,", raw)
                        raw = re.sub(r",(?=[,\]])", ",null", raw)
                        msg = json.loads(raw)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        return

                    op = msg.get("op")
                    if op == "publish":
                        topic = msg.get("topic", "")
                        data = msg.get("msg", {})
                        for cb in parent._listeners.get(topic, []):
                            parent._loop.call_soon_threadsafe(cb, data)
                    elif op == "action_result":
                        msg_id = msg.get("id", "")
                        cb = parent._action_callbacks.pop(msg_id, None)
                        if cb:
                            parent._loop.call_soon_threadsafe(cb, msg.get("values", {}))

                def onClose(self, wasClean, code, reason):
                    parent._connected = False
                    log.warning("%s WebSocket closed: %s", parent.name, reason)
                    # Auto-reconnect after 3s
                    if not _reactor._stopped:
                        _reactor.callLater(3.0, _do_connect)

            def _do_connect():
                factory = WebSocketClientFactory(f"ws://{parent.host}:{parent.port}")
                factory.protocol = Proto
                factory.setProtocolOptions(openHandshakeTimeout=10)
                connectWS(factory)

            _do_connect()

            # If not connected within 10s, unblock
            _reactor.callLater(10.0, lambda: ready.set())

            if not _reactor.running:
                _reactor.run(installSignalHandlers=False)

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()
        ready.wait(timeout=12)
        return success[0]

    @property
    def connected(self) -> bool:
        return self._connected

    def subscribe(self, topic: str, msg_type: str, callback: Callable[[dict], None]) -> None:
        self._listeners.setdefault(topic, []).append(callback)
        sub_msg = {"op": "subscribe", "topic": topic, "type": msg_type}
        if self._ws and self._connected:
            self._ws.sendMessage(json.dumps(sub_msg).encode("utf-8"))
        else:
            self._pending_subs.append(sub_msg)

    def publish(self, topic: str, msg_type: str, msg: dict) -> None:
        if not self._ws or not self._connected:
            return
        # Advertise once
        if topic not in self._advertised:
            adv = {"op": "advertise", "topic": topic, "type": msg_type}
            self._ws.sendMessage(json.dumps(adv).encode("utf-8"))
            self._advertised.add(topic)
        pub = {"op": "publish", "topic": topic, "msg": msg}
        self._ws.sendMessage(json.dumps(pub).encode("utf-8"))

    def send_action_goal(
        self,
        skill_type: str,
        inputs: dict,
        callback: Callable[[dict], None],
    ) -> None:
        """Send a skill execution via rws_server's action goal protocol.

        Matches the lucas dashboard's sendActionGoal() exactly:
        {op: 'send_action_goal', id, action: '/execute_skill',
         action_type: 'brain_messages/action/ExecuteSkill',
         args: {skill_type, inputs: JSON}}
        """
        if not self._ws or not self._connected:
            callback({"success": False, "message": "not connected"})
            return

        self._action_counter += 1
        msg_id = f"act{self._action_counter}"
        self._action_callbacks[msg_id] = callback

        # rws_server expects integer values as floats in the JSON
        inputs_json = json.dumps(inputs)
        inputs_json = re.sub(r":(-?\d+)([,}])", r":\g<1>.0\2", inputs_json)

        msg = {
            "op": "send_action_goal",
            "id": msg_id,
            "action": "/execute_skill",
            "action_type": "brain_messages/action/ExecuteSkill",
            "args": {
                "skill_type": skill_type,
                "inputs": inputs_json,
            },
        }
        self._ws.sendMessage(json.dumps(msg).encode("utf-8"))

    def close(self) -> None:
        self._connected = False
        if self._ws:
            try:
                self._ws.sendClose()
            except Exception:
                pass


class ConnectionManager:
    """Manages one WebSocket connection per robot via raw autobahn/twisted.

    Drop-in replacement for the old roslibpy-based ConnectionManager.
    Speaks the same protocol as the lucas dashboard's useRosbridge.ts.
    """

    def __init__(self, fleet: list[RobotConfig]) -> None:
        self._fleet = {r.name: r for r in fleet}
        self._robots: dict[str, _RobotWS] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect_all(self) -> dict[str, bool]:
        self._loop = asyncio.get_running_loop()
        results: dict[str, bool] = {}
        for cfg in self._fleet.values():
            ok = await self.connect_robot(cfg.name, cfg.host, cfg.port)
            results[cfg.name] = ok
        return results

    async def connect_robot(self, name: str, host: str, port: int) -> bool:
        loop = asyncio.get_running_loop()
        rws = _RobotWS(name, host, port, loop)
        ok = await loop.run_in_executor(None, rws.connect)
        if ok:
            self._robots[name] = rws
        return ok

    def is_connected(self, name: str) -> bool:
        rws = self._robots.get(name)
        return rws is not None and rws.connected

    # ------------------------------------------------------------------
    # Subscribe / publish
    # ------------------------------------------------------------------

    def subscribe(
        self,
        robot_name: str,
        topic: str,
        msg_type: str,
        callback: Callable[[str, str, dict], None],
    ) -> None:
        rws = self._robots.get(robot_name)
        if rws is None or not rws.connected:
            log.warning("subscribe: %s not connected", robot_name)
            return

        def _cb(msg: dict) -> None:
            callback(robot_name, topic, msg)

        rws.subscribe(topic, msg_type, _cb)

    def publish(
        self,
        robot_name: str,
        topic: str,
        msg_type: str,
        msg: dict,
    ) -> None:
        rws = self._robots.get(robot_name)
        if rws is None or not rws.connected:
            log.warning("publish: %s not connected", robot_name)
            return
        rws.publish(topic, msg_type, msg)

    async def run_skill(
        self,
        robot_name: str,
        skill_type: str,
        inputs: dict | None = None,
    ) -> dict[str, Any]:
        """Execute a skill on the robot via rws_server's action goal protocol.

        This is the primary way to command the robot — matches the lucas
        dashboard's sendActionGoal().
        """
        rws = self._robots.get(robot_name)
        if rws is None or not rws.connected:
            return {"success": False, "message": f"{robot_name} not connected"}

        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()

        def _on_result(values: dict) -> None:
            if not future.done():
                self._loop.call_soon_threadsafe(future.set_result, values)

        rws.send_action_goal(skill_type, inputs or {}, _on_result)

        try:
            result = await asyncio.wait_for(future, timeout=60.0)
            ok = result.get("success", False) or result.get("success_type") == "success"
            return {"success": ok, "message": result.get("message", ""), "raw": result}
        except (asyncio.TimeoutError, TimeoutError):
            return {"success": False, "message": "skill execution timed out"}

    # ------------------------------------------------------------------
    # Navigation helpers (via skills)
    # ------------------------------------------------------------------

    async def send_nav_goal(
        self,
        robot_name: str,
        x: float,
        y: float,
        theta: float = 0.0,
    ) -> dict[str, Any]:
        """Navigate using the innate-os/navigate_to_position skill."""
        return await self.run_skill(
            robot_name,
            "innate-os/navigate_to_position",
            {"x": x, "y": y, "theta": theta},
        )

    def send_cmd_vel(
        self,
        robot_name: str,
        linear_x: float = 0.0,
        angular_z: float = 0.0,
    ) -> None:
        self.publish(
            robot_name,
            "/cmd_vel",
            "geometry_msgs/msg/Twist",
            {
                "linear": {"x": linear_x, "y": 0.0, "z": 0.0},
                "angular": {"x": 0.0, "y": 0.0, "z": angular_z},
            },
        )

    def stop_robot(self, robot_name: str) -> None:
        self.send_cmd_vel(robot_name, 0.0, 0.0)

    # ------------------------------------------------------------------
    # Skill execution
    # ------------------------------------------------------------------

    async def execute_skill(
        self,
        robot_name: str,
        skill_name: str,
        parameters: dict | None = None,
    ) -> dict[str, Any]:
        """Execute a named skill on the robot."""
        return await self.run_skill(robot_name, skill_name, parameters)

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------

    async def shutdown(self) -> None:
        for name, rws in self._robots.items():
            rws.close()
        self._robots.clear()
        log.info("All connections closed.")
