"""ClaudeReasoner — the 'brain' of the hub planner.

Uses the Anthropic SDK with tool_use to decompose human commands into
robot tasks, query fleet state, and replan on failures.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import anthropic

from orchestrator.config import ClaudeConfig
from orchestrator.comms.connection_manager import ConnectionManager
from orchestrator.health.fleet_monitor import FleetHealthMonitor
from orchestrator.reasoner.mission import mission_summary
from orchestrator.reasoner.tools import TOOLS
from orchestrator.world_model.model import WorldModel
from orchestrator.world_model.robot_state import TaskStatus
from orchestrator.world_model.task_state import (
    MissionPlan,
    MissionStatus,
    Task,
    TaskType,
    WorldEvent,
)

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are the central mission planner for LMAO (Large Multi-Agent Orchestration),
commanding a fleet of Innate MARS scout rovers from a base-station laptop.

## Capabilities
- Each rover can navigate (Nav2), scan (LiDAR), and manipulate objects (6-DOF arm).
- Communication goes through a ROS2 WebSocket bridge (roslibpy).
- You receive real-time health tiers per robot (FULL_CAPABILITY → DEGRADED_SENSORS
  → LOCAL_ONLY → SAFE_MODE → HIBERNATION).

## Your responsibilities
1. Decompose high-level operator commands into specific, actionable robot tasks.
2. Always call query_world_state before making task-assignment decisions.
3. Assign tasks based on robot proximity, capability, and health tier.
4. When a health alert arrives, replan: reassign pending tasks from degraded
   robots to the nearest healthy robot.
5. Prefer parallel task assignment when robots can work independently.
6. If no robot can fulfil a task, say so clearly.

## Style
- Be concise.  Respond with what you did and why.
- When you assign tasks, state which robot got which task.
- On replan, explain what changed and what you reassigned.
"""


class ClaudeReasoner:
    """Maintains a conversation (mission context) with Claude and executes
    tool calls against the world model and connection manager."""

    def __init__(
        self,
        world: WorldModel,
        conn: ConnectionManager,
        health: FleetHealthMonitor,
        config: ClaudeConfig,
    ) -> None:
        self._world = world
        self._conn = conn
        self._health = health
        self._config = config
        self._client = anthropic.Anthropic()   # uses ANTHROPIC_API_KEY
        self._messages: list[dict[str, Any]] = []
        self._current_mission: MissionPlan | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def process_command(self, command: str) -> str:
        """Process a human operator command.  Returns the reasoner's text reply."""
        fleet_summary = await self._world.get_fleet_summary()
        mission_ctx = ""
        if self._current_mission:
            mission_ctx = (
                "\n[Active Mission]\n"
                + mission_summary(self._current_mission)
            )
        augmented = (
            f"[Fleet State]\n{fleet_summary}{mission_ctx}\n\n"
            f"[Operator Command]\n{command}"
        )
        self._messages.append({"role": "user", "content": augmented})
        return await self._run_loop()

    async def handle_health_event(self, event: WorldEvent) -> str:
        """Called by the event loop when a health transition occurs."""
        desc = (
            f"[HEALTH ALERT] Robot '{event.robot}' transitioned to "
            f"{event.data.get('new_tier', '?')}.  "
            f"Previous: {event.data.get('old_tier', '?')}.  "
            f"Topic health: {event.data.get('topic_health', {})}."
        )
        return await self.process_command(desc)

    # ------------------------------------------------------------------
    # Claude API loop
    # ------------------------------------------------------------------

    async def _run_loop(self) -> str:
        """Call Claude in a tool-use loop until end_turn."""
        while True:
            response = await asyncio.to_thread(
                self._client.messages.create,
                model=self._config.model,
                max_tokens=self._config.max_tokens,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=self._messages,
            )

            # Append assistant turn
            self._messages.append(
                {"role": "assistant", "content": response.content}
            )

            if response.stop_reason == "end_turn":
                return self._extract_text(response.content)

            if response.stop_reason == "tool_use":
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        result = await self._dispatch_tool(
                            block.name, block.input
                        )
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": json.dumps(result),
                            }
                        )
                self._messages.append({"role": "user", "content": tool_results})
            else:
                # Unexpected stop reason — return whatever text we have
                return self._extract_text(response.content)

    @staticmethod
    def _extract_text(content: list) -> str:
        parts = []
        for block in content:
            if hasattr(block, "text"):
                parts.append(block.text)
        return "\n".join(parts) if parts else "(no response)"

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    async def _dispatch_tool(self, name: str, args: dict) -> Any:
        handler = {
            "query_world_state": self._tool_query_world_state,
            "assign_task": self._tool_assign_task,
            "navigate_robot": self._tool_navigate_robot,
            "execute_skill": self._tool_execute_skill,
            "get_fleet_health": self._tool_get_fleet_health,
            "replan_mission": self._tool_replan_mission,
            "stop_robot": self._tool_stop_robot,
        }.get(name)

        if handler is None:
            return {"error": f"Unknown tool: {name}"}

        try:
            return await handler(args)
        except Exception as exc:
            log.exception("Tool %s failed", name)
            return {"error": str(exc)}

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    async def _tool_query_world_state(self, args: dict) -> Any:
        robot_name = args.get("robot_name")
        if robot_name:
            rs = await self._world.get_robot_state(robot_name)
            if rs is None:
                return {"error": f"Unknown robot: {robot_name}"}
            return {
                "name": rs.name,
                "connected": rs.connected,
                "health_tier": rs.health_tier.value,
                "position": rs.position,
                "velocity": rs.velocity,
                "battery_voltage": rs.battery_voltage,
                "battery_percentage": rs.battery_percentage,
                "current_task": rs.current_task_id,
                "task_status": rs.task_status.value,
                "capabilities": rs.capabilities,
            }
        return {"fleet_summary": await self._world.get_fleet_summary()}

    async def _tool_assign_task(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        task_type_str = args["task_type"]
        description = args["description"]
        parameters = args.get("parameters", {})

        try:
            task_type = TaskType(task_type_str)
        except ValueError:
            return {"error": f"Invalid task_type: {task_type_str}"}

        # Check robot exists and is available
        rs = await self._world.get_robot_state(robot_name)
        if rs is None:
            return {"error": f"Unknown robot: {robot_name}"}
        if not rs.connected:
            return {"error": f"{robot_name} is not connected"}
        if rs.health_tier.value in ("SAFE_MODE", "HIBERNATION"):
            return {"error": f"{robot_name} is in {rs.health_tier.value}, cannot accept tasks"}

        # Create task and mission if needed
        task = Task(
            description=description,
            task_type=task_type,
            target=parameters,
        )
        if self._current_mission is None:
            self._current_mission = MissionPlan(description="Active mission")
            await self._world.add_mission(self._current_mission)

        self._current_mission.tasks.append(task)
        await self._world.assign_task(task.id, robot_name)
        task.assigned_robot = robot_name
        task.status = TaskStatus.IN_PROGRESS

        # Execute the task on the robot
        exec_result = await self._execute_task_on_robot(task)

        return {
            "task_id": task.id,
            "assigned_to": robot_name,
            "status": "dispatched",
            "execution_result": exec_result,
        }

    async def _tool_navigate_robot(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        x = args["x"]
        y = args["y"]
        theta = args.get("theta", 0.0)

        result = await self._conn.send_nav_goal(robot_name, x, y, theta)
        return {
            "robot": robot_name,
            "target": {"x": x, "y": y, "theta": theta},
            "nav_result": result,
        }

    async def _tool_execute_skill(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        skill_name = args["skill_name"]
        parameters = args.get("parameters", {})

        result = await self._conn.execute_skill(robot_name, skill_name, parameters)
        return {
            "robot": robot_name,
            "skill": skill_name,
            "result": result,
        }

    async def _tool_get_fleet_health(self, _args: dict) -> Any:
        return self._health.get_health_report()

    async def _tool_replan_mission(self, args: dict) -> Any:
        reason = args["reason"]
        failed_ids = args.get("failed_task_ids", [])

        if self._current_mission is None:
            return {"status": "no active mission to replan"}

        # Mark failed tasks
        for tid in failed_ids:
            await self._world.update_task_status(tid, TaskStatus.FAILED)

        self._current_mission.status = MissionStatus.REPLANNING
        available = await self._world.get_available_robots()

        return {
            "status": "replanning",
            "reason": reason,
            "failed_tasks": failed_ids,
            "available_robots": available,
            "hint": "Use assign_task to reassign work to available robots.",
        }

    async def _tool_stop_robot(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        self._conn.stop_robot(robot_name)

        # Cancel current task
        rs = await self._world.get_robot_state(robot_name)
        if rs and rs.current_task_id:
            await self._world.update_task_status(
                rs.current_task_id, TaskStatus.FAILED
            )

        return {"robot": robot_name, "status": "stopped"}

    # ------------------------------------------------------------------
    # Task execution helper
    # ------------------------------------------------------------------

    async def _execute_task_on_robot(self, task: Task) -> dict:
        """Dispatch a task to the actual robot via connection manager."""
        robot = task.assigned_robot
        if robot is None:
            return {"error": "task not assigned"}

        if task.task_type == TaskType.NAVIGATE:
            x = task.target.get("x", 0.0)
            y = task.target.get("y", 0.0)
            theta = task.target.get("theta", 0.0)
            return await self._conn.send_nav_goal(robot, x, y, theta)

        if task.task_type == TaskType.MANIPULATE:
            skill = task.target.get("action", "")
            params = {k: v for k, v in task.target.items() if k != "action"}
            return await self._conn.execute_skill(robot, skill, params)

        if task.task_type == TaskType.SCAN:
            # Scan = navigate to area center then do a 360 LiDAR sweep
            # For now, just navigate
            x = task.target.get("x", 0.0)
            y = task.target.get("y", 0.0)
            return await self._conn.send_nav_goal(robot, x, y)

        # WAIT — no action needed
        return {"status": "waiting"}
