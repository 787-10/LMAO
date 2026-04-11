# React UI Integration Guide

How to connect the Mission Dashboard (React) to the LMAO Hub Planner.

## Architecture

```
React UI  ──HTTP POST──▶  FastAPI server  ──▶  ClaudeReasoner.process_command()
React UI  ◀──WebSocket──  FastAPI server  ◀──  WorldModel event queue
```

The hub planner exposes two async Python APIs that the React UI should consume through a thin HTTP/WebSocket layer:

| API | Signature | Purpose |
|-----|-----------|---------|
| **Command** | `reasoner.process_command(str) → str` | Send operator commands, get Claude's response |
| **Events** | `world.get_next_event(timeout) → WorldEvent` | Stream health alerts and task updates in real time |

Additionally, the `WorldModel` has query methods for populating the dashboard:

| Method | Returns |
|--------|---------|
| `world.get_fleet_summary()` | Human-readable fleet state string |
| `world.get_all_robots()` | `dict[str, RobotState]` — position, battery, health, task |
| `world.get_active_missions()` | `list[MissionPlan]` — tasks with status and assignments |
| `health.get_health_report()` | `dict[str, dict]` — per-robot tier + topic rates |

## FastAPI Server Example

Add `fastapi` and `uvicorn` to the project:
```bash
uv add fastapi uvicorn
```

Create `orchestrator/api.py`:

```python
"""Thin HTTP/WebSocket layer for the React dashboard."""
import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from pydantic import BaseModel

# These are initialized in __main__.py and passed in
from orchestrator.reasoner.claude_reasoner import ClaudeReasoner
from orchestrator.world_model.model import WorldModel
from orchestrator.health.fleet_monitor import FleetHealthMonitor

# Module-level references (set during startup)
reasoner: ClaudeReasoner = None
world: WorldModel = None
health: FleetHealthMonitor = None

app = FastAPI(title="LMAO Hub Planner API")


class CommandRequest(BaseModel):
    command: str


class CommandResponse(BaseModel):
    response: str


# --- REST: operator commands ---

@app.post("/api/command", response_model=CommandResponse)
async def post_command(req: CommandRequest):
    result = await reasoner.process_command(req.command)
    return CommandResponse(response=result)


# --- REST: fleet state queries ---

@app.get("/api/fleet")
async def get_fleet():
    robots = await world.get_all_robots()
    return {
        name: {
            "connected": rs.connected,
            "health_tier": rs.health_tier.value,
            "position": rs.position,
            "battery_percentage": rs.battery_percentage,
            "current_task": rs.current_task_id,
            "task_status": rs.task_status.value,
        }
        for name, rs in robots.items()
    }


@app.get("/api/health")
async def get_health():
    return health.get_health_report()


@app.get("/api/missions")
async def get_missions():
    missions = await world.get_active_missions()
    return [
        {
            "id": m.id,
            "description": m.description,
            "status": m.status.value,
            "tasks": [
                {
                    "id": t.id,
                    "type": t.task_type.value,
                    "description": t.description,
                    "assigned_robot": t.assigned_robot,
                    "status": t.status.value,
                }
                for t in m.tasks
            ],
        }
        for m in missions
    ]


# --- WebSocket: real-time event stream ---

@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    """Push WorldEvents to the React dashboard in real time."""
    await ws.accept()
    try:
        while True:
            event = await world.get_next_event(timeout=5.0)
            if event:
                await ws.send_json({
                    "type": event.type.value,
                    "robot": event.robot,
                    "data": event.data,
                    "timestamp": event.timestamp,
                })
    except Exception:
        pass
```

## Running with the API server

Modify `orchestrator/__main__.py` to optionally start the FastAPI server alongside the REPL:

```python
# After initializing all components:
if args.api:
    import orchestrator.api as api_mod
    api_mod.reasoner = reasoner
    api_mod.world = world
    api_mod.health = health
    
    import uvicorn
    api_task = asyncio.create_task(
        asyncio.to_thread(uvicorn.run, api_mod.app, host="0.0.0.0", port=8000)
    )
```

## React Integration

From the React dashboard:

```typescript
// Send a command
const res = await fetch("http://localhost:8000/api/command", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "Send scout-1 to (3, 2)" }),
});
const { response } = await res.json();

// Poll fleet state (or use SWR/React Query)
const fleet = await fetch("http://localhost:8000/api/fleet").then(r => r.json());

// Real-time events via WebSocket
const ws = new WebSocket("ws://localhost:8000/ws/events");
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.type: "ROBOT_DEGRADED" | "TASK_COMPLETED" | ...
  // data.robot: "scout-1"
  // data.data: { old_tier, new_tier, topic_health }
};
```

## Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/command` | Send natural language command to Claude reasoner |
| GET | `/api/fleet` | Current state of all robots |
| GET | `/api/health` | Detailed health report (tiers + topic rates) |
| GET | `/api/missions` | Active missions with task breakdowns |
| WS | `/ws/events` | Real-time stream of WorldEvents (health alerts, task updates) |
