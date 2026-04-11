"""FastAPI server — REST + WebSocket bridge for the React dashboard."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from orchestrator.world_model.robot_state import RobotState
from orchestrator.world_model.task_state import MissionPlan, Task, WorldEvent

if TYPE_CHECKING:
    from orchestrator.health.fleet_monitor import FleetHealthMonitor
    from orchestrator.reasoner.claude_reasoner import ClaudeReasoner
    from orchestrator.sim import Simulator
    from orchestrator.world_model.model import WorldModel

log = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Serialization helpers
# ------------------------------------------------------------------

def _robot_dict(rs: RobotState) -> dict[str, Any]:
    return {
        "name": rs.name,
        "connected": rs.connected,
        "health_tier": rs.health_tier.value,
        "position": rs.position,
        "velocity": rs.velocity,
        "battery_voltage": rs.battery_voltage,
        "battery_percentage": rs.battery_percentage,
        "current_task_id": rs.current_task_id,
        "task_status": rs.task_status.value,
        "capabilities": rs.capabilities,
    }


def _task_dict(t: Task) -> dict[str, Any]:
    return {
        "id": t.id,
        "description": t.description,
        "task_type": t.task_type.value,
        "assigned_robot": t.assigned_robot,
        "status": t.status.value,
        "target": t.target,
        "created_at": t.created_at,
    }


def _mission_dict(m: MissionPlan) -> dict[str, Any]:
    return {
        "id": m.id,
        "description": m.description,
        "status": m.status.value,
        "tasks": [_task_dict(t) for t in m.tasks],
        "created_at": m.created_at,
    }


def _event_dict(e: WorldEvent) -> dict[str, Any]:
    return {
        "type": e.type.value,
        "robot": e.robot,
        "data": e.data,
        "timestamp": e.timestamp,
    }


# ------------------------------------------------------------------
# EventBroadcaster — fans events out to WS clients + reasoner
# ------------------------------------------------------------------

class EventBroadcaster:
    """Drains the WorldModel event queue and fans out to multiple consumers.

    Each WebSocket client gets its own asyncio.Queue.  The reasoner's
    auto-replan handler is registered as a callback.
    """

    def __init__(self) -> None:
        self._client_queues: set[asyncio.Queue[dict]] = set()
        self._lock = asyncio.Lock()

    async def add_client(self) -> asyncio.Queue[dict]:
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._client_queues.add(q)
        return q

    async def remove_client(self, q: asyncio.Queue[dict]) -> None:
        async with self._lock:
            self._client_queues.discard(q)

    async def broadcast(self, msg: dict) -> None:
        async with self._lock:
            dead: list[asyncio.Queue[dict]] = []
            for q in self._client_queues:
                try:
                    q.put_nowait(msg)
                except asyncio.QueueFull:
                    dead.append(q)
            for q in dead:
                self._client_queues.discard(q)


# ------------------------------------------------------------------
# Request / response models
# ------------------------------------------------------------------

class CommandRequest(BaseModel):
    text: str


class CommandResponse(BaseModel):
    response: str


# ------------------------------------------------------------------
# App factory
# ------------------------------------------------------------------

def create_api(
    world: WorldModel,
    health: FleetHealthMonitor,
    reasoner: ClaudeReasoner,
    broadcaster: EventBroadcaster,
    simulator: Simulator | None = None,
) -> FastAPI:
    app = FastAPI(title="LMAO Hub Planner API")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # --- REST: commands ---

    @app.post("/api/command", response_model=CommandResponse)
    async def post_command(req: CommandRequest):
        result = await reasoner.process_command(req.text)
        return CommandResponse(response=result)

    # --- REST: fleet ---

    @app.get("/api/fleet")
    async def get_fleet():
        robots = await world.get_all_robots()
        return {"robots": [_robot_dict(rs) for rs in robots.values()]}

    @app.get("/api/fleet/{robot}/trail")
    async def get_trail(robot: str, last_n: int = Query(default=200)):
        trail = await world.get_position_trail(robot, last_n=last_n)
        return {"trail": trail}

    # --- REST: health ---

    @app.get("/api/health")
    async def get_health():
        return health.get_health_report()

    # --- REST: missions ---

    @app.get("/api/missions")
    async def get_missions():
        missions = await world.get_active_missions()
        return {"missions": [_mission_dict(m) for m in missions]}

    # --- REST: sim controls (only when simulator is present) ---

    if simulator is not None:
        class FaultRequest(BaseModel):
            robot: str
            topic: str = "/scan"

        class DrainRequest(BaseModel):
            robot: str
            percentage: float = 10.0

        class RecoverRequest(BaseModel):
            robot: str

        @app.post("/api/sim/fault")
        async def sim_fault(req: FaultRequest):
            simulator.inject_fault(req.robot, req.topic)
            return {"status": "fault_injected", "robot": req.robot, "topic": req.topic}

        @app.post("/api/sim/recover")
        async def sim_recover(req: RecoverRequest):
            simulator.clear_fault(req.robot)
            return {"status": "recovered", "robot": req.robot}

        @app.post("/api/sim/drain")
        async def sim_drain(req: DrainRequest):
            simulator.set_battery(req.robot, req.percentage)
            return {"status": "drained", "robot": req.robot, "percentage": req.percentage}

    # --- WebSocket: event stream ---

    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket):
        await ws.accept()
        q = await broadcaster.add_client()
        try:
            while True:
                msg = await asyncio.wait_for(q.get(), timeout=30.0)
                await ws.send_json(msg)
        except (WebSocketDisconnect, asyncio.TimeoutError, TimeoutError, Exception):
            pass
        finally:
            await broadcaster.remove_client(q)

    return app
