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
        """Called by the event loop when a health transition occurs.

        Builds a rich prompt with affected tasks, remaining objectives,
        and available fleet so Claude can make informed replan decisions.
        """
        robot_name = event.robot
        new_tier = event.data.get("new_tier", "?")
        old_tier = event.data.get("old_tier", "?")
        topic_health = event.data.get("topic_health", {})

        # Gather context for Claude
        rs = await self._world.get_robot_state(robot_name)
        affected_tasks = await self._world.get_tasks_for_robot(robot_name)
        available = await self._world.get_available_robots()
        health_report = self._health.get_health_report()

        # Build affected-tasks summary
        affected_lines = []
        for t in affected_tasks:
            if t.status.value in ("PENDING", "IN_PROGRESS"):
                affected_lines.append(
                    f"  - [{t.id}] {t.task_type.value}: {t.description} "
                    f"(status={t.status.value}, target={t.target})"
                )
        affected_str = "\n".join(affected_lines) if affected_lines else "  (none)"

        # Build fleet health summary
        fleet_health_lines = []
        for name, info in health_report.items():
            rates = ", ".join(f"{t}={r}Hz" for t, r in info.get("topic_rates_hz", {}).items())
            fleet_health_lines.append(f"  {name}: {info['tier']} | {rates}")
        fleet_health_str = "\n".join(fleet_health_lines)

        # Identify what capability was lost
        failed_sensors = [
            t for t, h in topic_health.items() if h in ("FAILED", "DEGRADED")
        ]
        capability_impact = ""
        if "/scan" in failed_sensors:
            capability_impact += "LiDAR is down — robot cannot scan or navigate safely. "
        if "/odom" in failed_sensors:
            capability_impact += "Odometry is down — robot position is unreliable. "
        if not failed_sensors and new_tier == "LOCAL_ONLY":
            capability_impact = "Comms blackout — robot is operating on last-known mission parameters. Hub cannot send new commands until comms restore. "
        if new_tier == "SAFE_MODE":
            capability_impact += "Multiple failures or low battery — robot should not accept new tasks. "
        if new_tier == "HIBERNATION":
            capability_impact += "Robot is unreachable or critically low battery — treat as unavailable. "

        prompt = (
            f"[FAULT ESCALATION — REPLAN REQUIRED]\n"
            f"\n"
            f"Robot '{robot_name}' has degraded: {old_tier} → {new_tier}\n"
            f"Failed/degraded sensors: {failed_sensors or 'none (comms-level fault)'}\n"
            f"Impact: {capability_impact}\n"
            f"\n"
            f"Tasks currently assigned to {robot_name}:\n{affected_str}\n"
            f"\n"
            f"Available robots for reassignment: {available}\n"
            f"\n"
            f"Fleet health:\n{fleet_health_str}\n"
            f"\n"
            f"Given the remaining mission objectives and available resources, "
            f"provide updated task assignments. If {robot_name} has in-progress "
            f"tasks, reassign them to healthy robots. If no robot can fulfil a "
            f"task, mark it and explain why."
        )
        return await self.process_command(prompt)

    async def handle_comms_lost(self, event: WorldEvent) -> str:
        """Called when a scout loses contact with the hub.

        The scout falls back to its last-known mission parameters and local
        FDIR.  The hub replans without that scout — treating it as temporarily
        unavailable.
        """
        robot_name = event.robot
        last_pos = event.data.get("robot_last_position")
        last_task = event.data.get("robot_last_task")
        last_contact = event.data.get("last_contact_ago_s", "?")

        affected_tasks = await self._world.get_tasks_for_robot(robot_name)
        available = await self._world.get_available_robots()
        # The lost robot is NOT in the available list (it's LOCAL_ONLY now)

        affected_lines = []
        for t in affected_tasks:
            if t.status.value in ("PENDING", "IN_PROGRESS"):
                affected_lines.append(
                    f"  - [{t.id}] {t.task_type.value}: {t.description} "
                    f"(status={t.status.value})"
                )
        affected_str = "\n".join(affected_lines) if affected_lines else "  (none)"

        prompt = (
            f"[COMMS BLACKOUT — REPLAN WITHOUT {robot_name.upper()}]\n"
            f"\n"
            f"Contact lost with '{robot_name}' {last_contact}s ago.\n"
            f"Last known position: {last_pos}\n"
            f"Last assigned task: {last_task}\n"
            f"\n"
            f"The robot is now operating autonomously on its last-known mission "
            f"parameters with local FDIR. It cannot receive new commands until "
            f"comms are restored.\n"
            f"\n"
            f"Tasks that were assigned to {robot_name}:\n{affected_str}\n"
            f"\n"
            f"Available robots: {available}\n"
            f"\n"
            f"Replan the mission WITHOUT {robot_name}. Reassign its pending/"
            f"in-progress tasks to available robots. Do NOT assign any new tasks "
            f"to {robot_name} until comms are restored."
        )
        return await self.process_command(prompt)

    async def handle_comms_restored(self, event: WorldEvent) -> str:
        """Called when a scout regains contact with the hub.

        The scout uploads its local state.  The hub reconciles the world
        model and asks Claude to replan with the reunified fleet.
        """
        robot_name = event.robot
        blackout_duration = event.data.get("blackout_duration_s", "?")
        current_pos = event.data.get("robot_position")
        current_battery = event.data.get("robot_battery")
        current_task = event.data.get("robot_task")

        # Get the robot's current state (just updated by restored telemetry)
        rs = await self._world.get_robot_state(robot_name)
        available = await self._world.get_available_robots()
        health_report = self._health.get_health_report()

        # What tasks are still pending across the fleet?
        all_tasks_lines = []
        if self._current_mission:
            for t in self._current_mission.tasks:
                if t.status.value in ("PENDING", "IN_PROGRESS"):
                    all_tasks_lines.append(
                        f"  - [{t.id}] {t.task_type.value}: {t.description} "
                        f"(status={t.status.value}, robot={t.assigned_robot or 'unassigned'})"
                    )
        remaining_str = "\n".join(all_tasks_lines) if all_tasks_lines else "  (none)"

        robot_health = health_report.get(robot_name, {})

        prompt = (
            f"[COMMS RESTORED — RECONCILE AND REPLAN]\n"
            f"\n"
            f"Contact restored with '{robot_name}' after {blackout_duration}s blackout.\n"
            f"Robot's current state:\n"
            f"  Position: {current_pos}\n"
            f"  Battery: {current_battery}%\n"
            f"  Health tier: {rs.health_tier.value if rs else '?'}\n"
            f"  Topic rates: {robot_health.get('topic_rates_hz', {})}\n"
            f"  Last task it was working on: {current_task}\n"
            f"\n"
            f"Available robots (now including {robot_name}): {available}\n"
            f"\n"
            f"Remaining mission tasks:\n{remaining_str}\n"
            f"\n"
            f"Reconcile: {robot_name} is back online. Check if it completed "
            f"its previous task during the blackout (based on its current "
            f"position vs task target). Replan the mission with the full "
            f"fleet. Redistribute work if {robot_name} is healthy enough to "
            f"take on new tasks."
        )
        return await self.process_command(prompt)

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
