"""Tool definitions for the Claude API reasoner."""
from __future__ import annotations

TOOLS = [
    {
        "name": "query_world_state",
        "description": (
            "Get the current state of all robots: positions, battery levels, "
            "health tiers, and current task assignments.  Use this to understand "
            "the fleet before making decisions.  Pass a robot_name to query a "
            "single robot, or omit for the full fleet summary."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "robot_name": {
                    "type": "string",
                    "description": "Optional: query a specific robot.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "assign_task",
        "description": (
            "Create and assign a task to a specific robot.  The task allocator "
            "validates that the robot is capable and available.  Returns the "
            "created task ID."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "robot_name": {
                    "type": "string",
                    "description": "Name of the robot to assign the task to.",
                },
                "task_type": {
                    "type": "string",
                    "enum": ["navigate", "manipulate", "scan", "wait"],
                    "description": "Type of task.",
                },
                "description": {
                    "type": "string",
                    "description": "Human-readable description of the task.",
                },
                "parameters": {
                    "type": "object",
                    "description": (
                        "Task-specific parameters.  For navigate: {x, y, theta}. "
                        "For manipulate: {action, target}.  For scan: {area}."
                    ),
                },
            },
            "required": ["robot_name", "task_type", "description", "parameters"],
        },
    },
    {
        "name": "navigate_robot",
        "description": (
            "Send a robot to a specific map position.  Shortcut for assigning "
            "a navigate task and triggering Nav2."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "robot_name": {"type": "string"},
                "x": {
                    "type": "number",
                    "description": "Target X coordinate in meters.",
                },
                "y": {
                    "type": "number",
                    "description": "Target Y coordinate in meters.",
                },
                "theta": {
                    "type": "number",
                    "description": "Target heading in radians (default 0).",
                },
            },
            "required": ["robot_name", "x", "y"],
        },
    },
    {
        "name": "execute_skill",
        "description": (
            "Trigger a named skill on a specific robot.  Skills are pre-defined "
            "behaviors registered in the robot's brain_client."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "robot_name": {"type": "string"},
                "skill_name": {
                    "type": "string",
                    "description": "Name of the skill to execute.",
                },
                "parameters": {
                    "type": "object",
                    "description": "Skill-specific parameters (optional).",
                },
            },
            "required": ["robot_name", "skill_name"],
        },
    },
    {
        "name": "get_fleet_health",
        "description": (
            "Get detailed health status of all robots including degradation "
            "tiers, per-topic message rates, and any active alerts."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "replan_mission",
        "description": (
            "Trigger replanning for the current mission.  Use when a robot "
            "goes down, a task fails, or conditions change significantly.  "
            "Provide the reason for replanning and optionally the IDs of "
            "failed tasks."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why replanning is needed.",
                },
                "failed_task_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "IDs of tasks that failed or need reassignment.",
                },
            },
            "required": ["reason"],
        },
    },
    {
        "name": "stop_robot",
        "description": (
            "Emergency stop a specific robot.  Publishes zero velocity and "
            "cancels any current task."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "robot_name": {"type": "string"},
            },
            "required": ["robot_name"],
        },
    },
]
