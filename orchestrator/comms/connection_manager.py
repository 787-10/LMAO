"""Multi-robot roslibpy connection lifecycle + asyncio bridge."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import roslibpy

from orchestrator.config import RobotConfig

log = logging.getLogger(__name__)


class ConnectionManager:
    """Manages one roslibpy.Ros client per robot.

    roslibpy runs a twisted reactor on a background thread.  Message
    callbacks fire there, so we bridge into the asyncio event loop via
    ``loop.call_soon_threadsafe``.
    """

    def __init__(self, fleet: list[RobotConfig]) -> None:
        self._fleet = {r.name: r for r in fleet}
        self._clients: dict[str, roslibpy.Ros] = {}
        self._subscribers: dict[str, list[roslibpy.Topic]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect_all(self) -> dict[str, bool]:
        """Connect to every robot in the fleet.  Returns name → success."""
        self._loop = asyncio.get_running_loop()
        results: dict[str, bool] = {}
        for cfg in self._fleet.values():
            ok = await self.connect_robot(cfg.name, cfg.host, cfg.port)
            results[cfg.name] = ok
        return results

    async def connect_robot(self, name: str, host: str, port: int) -> bool:
        """Connect to a single robot.  Runs blocking roslibpy.run() in executor."""
        client = roslibpy.Ros(host=host, port=port)
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, lambda: client.run(timeout=10)
            )
        except Exception as exc:
            log.warning("Failed to connect to %s (%s:%d): %s", name, host, port, exc)
            return False

        if not client.is_connected:
            log.warning("%s: client.is_connected is False after run()", name)
            return False

        self._clients[name] = client
        self._subscribers.setdefault(name, [])
        log.info("Connected to %s at ws://%s:%d", name, host, port)
        return True

    def is_connected(self, name: str) -> bool:
        client = self._clients.get(name)
        return client is not None and client.is_connected

    # ------------------------------------------------------------------
    # Subscribe / publish / service
    # ------------------------------------------------------------------

    def subscribe(
        self,
        robot_name: str,
        topic: str,
        msg_type: str,
        callback: Callable[[str, str, dict], None],
    ) -> None:
        """Subscribe to *topic* on *robot_name*.

        ``callback(robot_name, topic, msg_dict)`` is scheduled on the
        asyncio event loop — safe to await coroutines from there.
        """
        client = self._clients.get(robot_name)
        if client is None or not client.is_connected:
            log.warning("subscribe: %s not connected", robot_name)
            return

        listener = roslibpy.Topic(client, topic, msg_type)

        def _on_msg(msg: dict) -> None:
            if self._loop is not None:
                self._loop.call_soon_threadsafe(callback, robot_name, topic, msg)

        listener.subscribe(_on_msg)
        self._subscribers[robot_name].append(listener)

    def publish(
        self,
        robot_name: str,
        topic: str,
        msg_type: str,
        msg: dict,
    ) -> None:
        """Publish a single message to *topic* on *robot_name*."""
        client = self._clients.get(robot_name)
        if client is None or not client.is_connected:
            log.warning("publish: %s not connected", robot_name)
            return
        pub = roslibpy.Topic(client, topic, msg_type)
        pub.publish(roslibpy.Message(msg))
        # roslibpy Topics opened just for publish should be unadvertised
        # after a short delay to let the message go through.
        pub.unadvertise()

    async def call_service(
        self,
        robot_name: str,
        service: str,
        srv_type: str,
        args: dict | None = None,
    ) -> dict[str, Any]:
        """Call a ROS2 service on *robot_name*.  Returns the response dict."""
        client = self._clients.get(robot_name)
        if client is None or not client.is_connected:
            return {"success": False, "error": f"{robot_name} not connected"}

        srv = roslibpy.Service(client, service, srv_type)
        request = roslibpy.ServiceRequest(args or {})

        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()

        def _on_response(result: dict) -> None:
            if self._loop and not future.done():
                self._loop.call_soon_threadsafe(future.set_result, result)

        def _on_error(exc: Exception) -> None:
            if self._loop and not future.done():
                self._loop.call_soon_threadsafe(
                    future.set_result, {"success": False, "error": str(exc)}
                )

        srv.call(request, callback=_on_response, errback=_on_error)

        try:
            return await asyncio.wait_for(future, timeout=15.0)
        except (asyncio.TimeoutError, TimeoutError):
            return {"success": False, "error": "service call timed out"}

    # ------------------------------------------------------------------
    # Navigation helpers (wraps /navigate_to_pose action goal)
    # ------------------------------------------------------------------

    async def send_nav_goal(
        self,
        robot_name: str,
        x: float,
        y: float,
        theta: float = 0.0,
    ) -> dict[str, Any]:
        """Publish a Nav2 goal via the /navigate_to_pose action topic.

        roslibpy doesn't have first-class action support, so we use the
        action goal topic directly.
        """
        import math

        goal_msg = {
            "pose": {
                "header": {"frame_id": "map"},
                "pose": {
                    "position": {"x": x, "y": y, "z": 0.0},
                    "orientation": {
                        "x": 0.0,
                        "y": 0.0,
                        "z": math.sin(theta / 2),
                        "w": math.cos(theta / 2),
                    },
                },
            }
        }
        # Use the action client service for NavigateToPose
        return await self.call_service(
            robot_name,
            "/navigate_to_pose/_action/send_goal",
            "nav2_msgs/NavigateToPose",
            goal_msg,
        )

    def send_cmd_vel(
        self,
        robot_name: str,
        linear_x: float = 0.0,
        angular_z: float = 0.0,
    ) -> None:
        """Publish a Twist to /cmd_vel on *robot_name*."""
        self.publish(
            robot_name,
            "/cmd_vel",
            "geometry_msgs/Twist",
            {
                "linear": {"x": linear_x, "y": 0.0, "z": 0.0},
                "angular": {"x": 0.0, "y": 0.0, "z": angular_z},
            },
        )

    def stop_robot(self, robot_name: str) -> None:
        """Emergency stop — publish zero velocity."""
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
        """Trigger a skill via the /execute_primitive action."""
        import json

        return await self.call_service(
            robot_name,
            "/execute_primitive/_action/send_goal",
            "brain_messages/ExecutePrimitive",
            {
                "primitive_name": skill_name,
                "input_json": json.dumps(parameters or {}),
            },
        )

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------

    async def shutdown(self) -> None:
        """Unsubscribe and terminate all connections."""
        for name, subs in self._subscribers.items():
            for s in subs:
                try:
                    s.unsubscribe()
                except Exception:
                    pass
        self._subscribers.clear()

        for name, client in self._clients.items():
            try:
                await asyncio.get_running_loop().run_in_executor(
                    None, client.terminate
                )
            except Exception:
                log.warning("Error terminating %s", name, exc_info=True)
        self._clients.clear()
        log.info("All connections closed.")
