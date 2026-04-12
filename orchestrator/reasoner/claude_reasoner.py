"""ClaudeReasoner — the 'brain' of the hub planner.

Agent-organized task logic:
    resource target → move → verify motion → recover if stuck → retry.

The agent does NOT check for faults before acting. It issues a motion
command, THEN verifies the robot actually moved by running
`local/imu_servo_odometry`. Only if that check reports 'stationary' (fault)
after a motion command is the robot considered stuck.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
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
You are the mission planner for LMAO — a planetary resource-retrieval system
directing scout rovers from a base station.

## Your job
Dispatch scouts to resources and acquire them. Motion verification and
recovery are ONLY performed when the operator explicitly asks for them.

## Skills (always use the full prefixed name)

Movement (produces wheel/base motion):
- `innate-os/navigate_to_position`  — go to {x, y, theta} in map frame (primary)
- `local/move_forward`              — short forward drive
- `local/turn_left` / `local/turn_right` — turn in place

IMPORTANT: `innate-os/navigate_to_position` and `innate-os/navigate_with_vision`
commonly return `TaskResult.FAILED` / `success_type=failure` even when the
rover IS in fact navigating. The response message from these skills is NOT a
reliable indicator of success or failure — the orchestrator layer wraps them
with `status: "dispatched"` to make this explicit. When you see
`status: "dispatched"`, treat the nav goal as successfully sent. Do NOT
conclude the rover is stuck or that the navigation failed.

Search & acquire:
- `local/wait_and_look`           — observe with camera
- `local/turn_left` / `local/turn_right`
- `local/approach_target_onboard` — vision-guided final approach
- `local/scout_mission`           — autonomous sweep

Operator-gated skills — NEVER invoke these on your own initiative. Only run
them when the operator explicitly tells you to (e.g. "check if it's stuck",
"verify motion", "run the imu check", "recover the rover", "run a battery
check"):
- `local/imu_servo_odometry` — compares commanded motion vs IMU
    success → robot actually moved
    fault   → wheels moving but IMU stationary → rover is STUCK
- `local/recovery`            — arm/scoop pushes rover free
- `local/check_arm`, `local/check_battery`

## The loop

1. **Move.** Given a target, call `navigate_robot` (preferred for
   coordinates) or an `execute_skill` movement. Wait for its result.

2. **Report.** Tell the operator what happened.
   - success → "Move to (x, y) succeeded."
   - failure → "Navigation rejected: <reason>."
   Then STOP and await the next operator instruction. Do NOT auto-run
   `imu_servo_odometry`, `recovery`, or any other diagnostic.

3. **Search / acquire** is fine to do on your own once motion is confirmed
   and you're at the destination (wait_and_look, turn_left/right,
   approach_target_onboard, scout_mission). These don't need operator
   permission.

## Handling operator-gated skills

When the operator asks you to check for stuck, run `imu_servo_odometry`:
- `verdict: "fault"` / STATIONARY → report "Rover is stuck." and stop.
  If (and only if) the operator then asks you to recover, run
  `local/recovery`, report the result, and stop.
- success → report "Motion verified."

## Rules

- Never run `imu_servo_odometry`, `recovery`, `check_arm`, or
  `check_battery` speculatively. The operator drives those.
- A failed motion command is NOT "stuck"; it just means the move wasn't
  executed. Report the failure and wait for instructions.
- Do not do pre-flight health checks, battery checks, or comms checks.
- Do not use `assign_task` to drive the robot — it only records tasks.
  Dispatch real motion via `navigate_robot` or `execute_skill`.
- Keep replies short: "Dispatching to (x, y)...", "Move succeeded.",
  "Navigation rejected — reporting.", "Motion verified.",
  "Rover is stuck.", "Recovery complete.", "Arrived."
- Speak as a mission controller: direct, professional, no hedging.
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
        broadcaster: Any = None,
    ) -> None:
        self._world = world
        self._conn = conn
        self._health = health
        self._config = config
        self._broadcaster = broadcaster
        self._client = anthropic.Anthropic()  # uses ANTHROPIC_API_KEY
        self._messages: list[dict[str, Any]] = []
        self._current_mission: MissionPlan | None = None

    async def _emit(self, role: str, content: str, kind: str = "text") -> None:
        """Broadcast a claude-conversation event to WS subscribers."""
        if self._broadcaster is None:
            return
        try:
            await self._broadcaster.broadcast(
                {
                    "type": "CLAUDE_MESSAGE",
                    "robot": "",
                    "data": {"role": role, "kind": kind, "content": content},
                    "timestamp": time.time(),
                }
            )
        except Exception:
            log.exception("failed to broadcast claude event")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def process_command(self, command: str) -> str:
        """Process a human operator command. Returns the reasoner's text reply."""
        fleet_summary = await self._world.get_fleet_summary()
        mission_ctx = ""
        if self._current_mission:
            mission_ctx = "\n[Active Mission]\n" + mission_summary(
                self._current_mission
            )
        augmented = (
            f"[Fleet State]\n{fleet_summary}{mission_ctx}\n\n"
            f"[Operator Command]\n{command}"
        )
        self._messages.append({"role": "user", "content": augmented})
        return await self._run_loop()

    async def handle_health_event(self, event: WorldEvent) -> str:
        """Health transitions are informational only — reasoner doesn't pre-empt
        the active plan. It just gets notified so it can factor the change into
        its next decision."""
        robot_name = event.robot
        new_tier = event.data.get("new_tier", "?")
        old_tier = event.data.get("old_tier", "?")
        prompt = (
            f"[HEALTH NOTICE] {robot_name}: {old_tier} → {new_tier}. "
            f"If the active plan is affected, adjust. Otherwise continue."
        )
        return await self.process_command(prompt)

    async def handle_comms_lost(self, event: WorldEvent) -> str:
        robot_name = event.robot
        prompt = (
            f"[COMMS LOST] Contact dropped with {robot_name}. "
            f"The scout is running last-known parameters locally. "
            f"Continue the mission without it for now."
        )
        return await self.process_command(prompt)

    async def handle_comms_restored(self, event: WorldEvent) -> str:
        robot_name = event.robot
        prompt = (
            f"[COMMS RESTORED] {robot_name} is reachable again. "
            f"Fold it back into the plan if there's work to dispatch."
        )
        return await self.process_command(prompt)

    # ------------------------------------------------------------------
    # Claude API loop
    # ------------------------------------------------------------------

    async def _run_loop(self) -> str:
        """Call Claude in a tool-use loop until end_turn."""
        # broadcast the most recent user turn (command or tool_result batch)
        if self._messages:
            last = self._messages[-1]
            if last["role"] == "user":
                content = last["content"]
                if isinstance(content, str):
                    await self._emit("user", content, "prompt")
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "tool_result":
                            await self._emit(
                                "tool",
                                f"{item.get('tool_use_id', '?')}: {item.get('content', '')}",
                                "tool_result",
                            )

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
            self._messages.append({"role": "assistant", "content": response.content})

            # broadcast assistant content (text + tool_use)
            for block in response.content:
                if getattr(block, "type", None) == "text":
                    text = getattr(block, "text", "")
                    if text:
                        await self._emit("assistant", text, "text")
                elif getattr(block, "type", None) == "tool_use":
                    args_str = json.dumps(block.input, default=str)
                    await self._emit(
                        "assistant",
                        f"{block.name}({args_str})",
                        "tool_use",
                    )

            if response.stop_reason == "end_turn":
                return self._extract_text(response.content)

            if response.stop_reason == "tool_use":
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        result = await self._dispatch_tool(block.name, block.input)
                        result_json = json.dumps(result, default=str)
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": result_json,
                            }
                        )
                        await self._emit(
                            "tool",
                            f"{block.name} → {result_json}",
                            "tool_result",
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
        """Record a task in the mission plan. Does NOT gate on health/connection —
        the reasoner is expected to dispatch the actual command with
        navigate_robot or execute_skill and react to whatever the robot returns."""
        robot_name = args["robot_name"]
        task_type_str = args["task_type"]
        description = args["description"]
        parameters = args.get("parameters", {})

        try:
            task_type = TaskType(task_type_str)
        except ValueError:
            return {"error": f"Invalid task_type: {task_type_str}"}

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

        return {
            "task_id": task.id,
            "assigned_to": robot_name,
            "status": "assigned",
            "hint": "Task recorded. Dispatch motion via navigate_robot or execute_skill, then verify with local/imu_servo_odometry.",
        }

    _MOTION_SKILLS = (
        "innate-os/navigate_to_position",
        "innate-os/navigate_with_vision",
        "local/move_forward",
        "local/turn_left",
        "local/turn_right",
    )

    @staticmethod
    def _motion_succeeded(result: Any) -> bool:
        """A motion command is only considered to have moved the rover when
        the underlying skill reports success. Anything else (rejection, plan
        failure, timeout) means the rover was never commanded to move."""
        if not isinstance(result, dict):
            return False
        if result.get("success") is True:
            return True
        raw = result.get("raw")
        if isinstance(raw, dict) and raw.get("success_type") == "success":
            return True
        return False

    async def _tool_navigate_robot(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        # force floats — Claude often serializes integers as ints (1 instead of
        # 1.0), and innate-os/navigate_to_position requires float coordinates
        x = float(args["x"])
        y = float(args["y"])

        # Theta policy:
        #   1. if Claude explicitly passed theta, honor it.
        #   2. otherwise compute the heading from current pos -> goal pos:
        #        theta = atan2(gy - cy, gx - cx)
        #      so the rover ends up facing the direction it traveled,
        #      which is always a feasible end-orientation for nav2.
        #   3. if we have no current position yet (no /amcl_pose received),
        #      fall back to 0.0.
        if "theta" in args and args["theta"] is not None:
            theta = float(args["theta"])
            theta_src = "explicit"
        else:
            rs = await self._world.get_robot_state(robot_name)
            if (
                rs is not None
                and rs.position is not None
                and len(rs.position) >= 2
            ):
                cx, cy = float(rs.position[0]), float(rs.position[1])
                dx, dy = x - cx, y - cy
                if dx == 0.0 and dy == 0.0:
                    # goal == current pos — keep current yaw
                    theta = float(rs.position[2]) if len(rs.position) >= 3 else 0.0
                    theta_src = f"goal==current, kept current-yaw ({rs.position})"
                else:
                    theta = math.atan2(dy, dx)
                    theta_src = (
                        f"heading-from ({cx:.3f},{cy:.3f}) -> ({x:.3f},{y:.3f}) "
                        f"dx={dx:.3f} dy={dy:.3f} atan2={theta:.4f} rad"
                    )
            else:
                theta = 0.0
                theta_src = "fallback-zero (no amcl_pose yet)"

        print(
            f"[reasoner] navigate_robot robot={robot_name} "
            f"x={x!r} y={y!r} theta={theta!r} theta_src={theta_src}",
            flush=True,
        )

        result = await self._conn.send_nav_goal(robot_name, x, y, theta)
        print(f"[reasoner] send_nav_goal returned: {result}", flush=True)
        return {
            "robot": robot_name,
            "target": {"x": x, "y": y, "theta": theta},
            "status": "dispatched",
            "skill_response": result,
            "note": (
                "innate-os/navigate_to_position commonly responds with "
                "TaskResult.FAILED / success_type=failure even when the rover "
                "is actively navigating. The response message is NOT an "
                "authoritative indicator of success or failure. Treat the goal "
                "as successfully dispatched."
            ),
            "hint": (
                "Report to the operator that navigation has been dispatched. "
                "Wait for the next operator instruction. Do NOT invoke "
                "imu_servo_odometry or recovery on your own."
            ),
        }

    async def _tool_execute_skill(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        skill_name = args["skill_name"]
        parameters = args.get("parameters", {})

        result = await self._conn.execute_skill(robot_name, skill_name, parameters)

        # innate-os nav skills lie about success — the dashboard sees the same
        # TaskResult.FAILED and the rover still navigates. Treat nav calls as
        # dispatch-only regardless of the skill response.
        if skill_name in (
            "innate-os/navigate_to_position",
            "innate-os/navigate_with_vision",
        ):
            return {
                "robot": robot_name,
                "skill": skill_name,
                "status": "dispatched",
                "skill_response": result,
                "note": (
                    f"{skill_name} commonly responds with TaskResult.FAILED / "
                    "success_type=failure even when the rover is actively "
                    "navigating. The response message is NOT an authoritative "
                    "indicator of success or failure."
                ),
                "hint": (
                    "Report to the operator that the skill was dispatched. "
                    "Do NOT invoke imu_servo_odometry or recovery on your own."
                ),
            }

        payload: dict[str, Any] = {
            "robot": robot_name,
            "skill": skill_name,
            "result": result,
        }
        if skill_name in self._MOTION_SKILLS:
            payload["hint"] = (
                "Report the result to the operator and wait for the next "
                "instruction. Do NOT invoke imu_servo_odometry or recovery "
                "on your own."
            )
        return payload

    async def _tool_get_fleet_health(self, _args: dict) -> Any:
        return self._health.get_health_report()

    async def _tool_replan_mission(self, args: dict) -> Any:
        reason = args["reason"]
        failed_ids = args.get("failed_task_ids", [])

        if self._current_mission is None:
            return {"status": "no active mission to replan"}

        for tid in failed_ids:
            await self._world.update_task_status(tid, TaskStatus.FAILED)

        self._current_mission.status = MissionStatus.REPLANNING
        available = await self._world.get_available_robots()

        return {
            "status": "replanning",
            "reason": reason,
            "failed_tasks": failed_ids,
            "available_robots": available,
            "hint": "Reassign via assign_task, then dispatch motion.",
        }

    async def _tool_stop_robot(self, args: dict) -> Any:
        robot_name = args["robot_name"]
        self._conn.stop_robot(robot_name)

        rs = await self._world.get_robot_state(robot_name)
        if rs and rs.current_task_id:
            await self._world.update_task_status(rs.current_task_id, TaskStatus.FAILED)

        return {"robot": robot_name, "status": "stopped"}
