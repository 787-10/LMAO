"""LMAO Hub Planner — entry point.

    uv run python -m orchestrator
    uv run python -m orchestrator --sim          # simulated robots
    uv run python -m orchestrator --config path/to/fleet_config.yaml
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()  # reads .env from project root

from orchestrator.api import EventBroadcaster, _event_dict, create_api
from orchestrator.cli.repl import OperatorREPL
from orchestrator.comms.connection_manager import ConnectionManager
from orchestrator.config import HubConfig, load_config
from orchestrator.health.fleet_monitor import FleetHealthMonitor
from orchestrator.reasoner.claude_reasoner import ClaudeReasoner
from orchestrator.world_model.model import WorldModel
from orchestrator.world_model.task_state import EventType

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("orchestrator")


# ------------------------------------------------------------------
# Event loop — fans events to reasoner + WS broadcaster
# ------------------------------------------------------------------

async def event_loop(
    world: WorldModel,
    reasoner: ClaudeReasoner,
    broadcaster: EventBroadcaster,
    health: FleetHealthMonitor,
) -> None:
    """Background task: drain events, broadcast to WS clients, auto-replan."""
    health_tick = 0
    while True:
        event = await world.get_next_event(timeout=1.0)

        if event is not None:
            log.info("EVENT  %s", event.describe())
            # Broadcast to all WS clients
            await broadcaster.broadcast(_event_dict(event))

            # Route to reasoner based on event type
            try:
                if event.type in (
                    EventType.ROBOT_DEGRADED,
                    EventType.TASK_FAILED,
                ):
                    response = await reasoner.handle_health_event(event)
                    print(f"\n[REPLAN] {response}\n")
                elif event.type == EventType.COMMS_LOST:
                    response = await reasoner.handle_comms_lost(event)
                    print(f"\n[COMMS LOST] {response}\n")
                elif event.type == EventType.COMMS_RESTORED:
                    response = await reasoner.handle_comms_restored(event)
                    print(f"\n[COMMS RESTORED] {response}\n")
            except Exception:
                log.exception("Auto-replan failed for event %s", event.type)

        # Periodic health snapshot for WS clients (every ~2s)
        health_tick += 1
        if health_tick >= 2:
            health_tick = 0
            report = health.get_health_report()
            if report:
                await broadcaster.broadcast({
                    "type": "HEALTH_SNAPSHOT",
                    "robot": "",
                    "data": report,
                    "timestamp": __import__("time").time(),
                })


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

async def async_main(config: HubConfig, *, sim_mode: bool = False, api_port: int = 8000) -> None:
    # 1. Initialize components
    world = WorldModel()
    simulator = None

    if sim_mode:
        from orchestrator.sim import SimConnectionManager, Simulator
        conn = SimConnectionManager(config.fleet)
        simulator = Simulator(conn, world, config.fleet)
    else:
        conn = ConnectionManager(config.fleet)

    health = FleetHealthMonitor(conn, world, config.health)

    # Connect to local vision brain (Qwen VLM)
    from orchestrator.comms.local_brain_client import LocalBrainClient
    brain_client = None
    if config.local_brain:
        brain_url = f"ws://{config.local_brain.host}:{config.local_brain.port}"
        brain_client = LocalBrainClient(brain_url)
        ok = await brain_client.connect()
        status = "connected" if ok else "FAILED (will retry on first goal)"
        print(f"  Local brain: {status} ({brain_url})")

    reasoner = ClaudeReasoner(world, conn, health, config.claude, brain_client=brain_client)
    broadcaster = EventBroadcaster()

    # Wire brain events into the dashboard event stream
    if brain_client:
        async def _on_brain_event(event_type: str, data: dict, timestamp: float) -> None:
            await broadcaster.broadcast({
                "type": f"BRAIN_{event_type.upper()}",
                "robot": "mars-the-18th",
                "data": data,
                "timestamp": timestamp,
            })

        brain_client.on_brain_event = _on_brain_event
    repl = OperatorREPL(reasoner, world, health, simulator=simulator)

    # 2. Create FastAPI app
    app = create_api(world, health, reasoner, broadcaster, simulator=simulator)

    # 3. Register robots in world model
    for robot_cfg in config.fleet:
        world.register_robot(robot_cfg.name, robot_cfg.capabilities)

    # 4. Connect to all robots
    print("\nConnecting to fleet...")
    results = await conn.connect_all()
    for name, ok in results.items():
        status = "connected" if ok else "FAILED"
        if sim_mode:
            status += " (simulated)"
        await world.update_connection(name, ok)
        print(f"  {name}: {status}")

    connected_robots = [name for name, ok in results.items() if ok]
    if not connected_robots and not sim_mode:
        print("\nWARNING: No robots connected.  The reasoner will still work")
        print("but cannot dispatch tasks.  Check fleet_config.yaml and robot IPs.\n")

    # 5. Start simulator telemetry (before health monitor so callbacks exist)
    if simulator:
        await simulator.start()

    # 6. Start health monitoring
    if connected_robots:
        await health.start(connected_robots)

    # 7. Start API server
    import uvicorn
    uvi_config = uvicorn.Config(app, host="0.0.0.0", port=api_port, log_level="warning")
    server = uvicorn.Server(uvi_config)
    api_task = asyncio.create_task(server.serve())
    print(f"  API server: http://0.0.0.0:{api_port}")

    # 8. Start background event loop
    ev_task = asyncio.create_task(event_loop(world, reasoner, broadcaster, health))

    # 9. Run the operator REPL (blocks until quit)
    try:
        await repl.run()
    finally:
        print("\nShutting down...")
        ev_task.cancel()
        server.should_exit = True
        try:
            await ev_task
        except asyncio.CancelledError:
            pass
        await api_task
        if brain_client:
            await brain_client.close()
        if simulator:
            await simulator.stop()
        await health.stop()
        await conn.shutdown()
        print("Hub planner stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description="LMAO Hub Planner")
    parser.add_argument(
        "--config",
        default=None,
        help="Path to fleet_config.yaml (default: bundled config)",
    )
    parser.add_argument(
        "--sim",
        action="store_true",
        help="Simulation mode — fake robots with synthetic telemetry",
    )
    parser.add_argument(
        "--api-port",
        type=int,
        default=8000,
        help="Port for the REST/WS API server (default: 8000)",
    )
    args = parser.parse_args()

    try:
        config = load_config(args.config)
    except FileNotFoundError as exc:
        print(f"Config not found: {exc}", file=sys.stderr)
        sys.exit(1)

    print("=" * 50)
    print("  LMAO Hub Planner")
    print("  Large Multi-Agent Orchestration")
    if args.sim:
        print("  ** SIMULATION MODE **")
    print("=" * 50)
    print(f"  Fleet: {len(config.fleet)} robot(s)")
    for r in config.fleet:
        print(f"    {r.name} @ {r.host}:{r.port}")
    print(f"  Claude model: {config.claude.model}")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("\n  WARNING: ANTHROPIC_API_KEY not set.")
        print("  Copy .env.example to .env and add your key.")
        print("  The reasoner will fail until this is configured.\n")
    print()

    asyncio.run(async_main(config, sim_mode=args.sim, api_port=args.api_port))


if __name__ == "__main__":
    main()
