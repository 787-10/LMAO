"""LMAO Hub Planner — entry point.

    uv run python -m orchestrator
    uv run python -m orchestrator --sim          # simulated robots
    uv run python -m orchestrator --config path/to/fleet_config.yaml
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from orchestrator.allocator.task_allocator import TaskAllocator
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
# Event loop — bridges health events to the reasoner
# ------------------------------------------------------------------

async def event_loop(world: WorldModel, reasoner: ClaudeReasoner) -> None:
    """Background task: drain health events and feed them to Claude."""
    while True:
        event = await world.get_next_event(timeout=1.0)
        if event is None:
            continue
        log.info("EVENT  %s", event.describe())

        # Only auto-replan on degradation / comms-loss events
        if event.type in (
            EventType.ROBOT_DEGRADED,
            EventType.COMMS_LOST,
            EventType.TASK_FAILED,
        ):
            try:
                response = await reasoner.handle_health_event(event)
                print(f"\n[REPLAN] {response}\n")
            except Exception:
                log.exception("Auto-replan failed for event %s", event.type)


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

async def async_main(config: HubConfig, *, sim_mode: bool = False) -> None:
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
    reasoner = ClaudeReasoner(world, conn, health, config.claude)
    repl = OperatorREPL(reasoner, world, health, simulator=simulator)

    # 2. Register robots in world model
    for robot_cfg in config.fleet:
        world.register_robot(robot_cfg.name, robot_cfg.capabilities)

    # 3. Connect to all robots
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

    # 4. Start simulator telemetry (before health monitor so callbacks exist)
    if simulator:
        await simulator.start()

    # 5. Start health monitoring
    if connected_robots:
        await health.start(connected_robots)

    # 6. Start background event loop
    event_task = asyncio.create_task(event_loop(world, reasoner))

    # 7. Run the operator REPL (blocks until quit)
    try:
        await repl.run()
    finally:
        print("\nShutting down...")
        event_task.cancel()
        try:
            await event_task
        except asyncio.CancelledError:
            pass
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
    print()

    asyncio.run(async_main(config, sim_mode=args.sim))


if __name__ == "__main__":
    main()
