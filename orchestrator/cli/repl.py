"""Operator REPL — human interface before the React UI is ready."""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from prompt_toolkit import PromptSession
from prompt_toolkit.patch_stdout import patch_stdout

from orchestrator.health.fleet_monitor import FleetHealthMonitor
from orchestrator.reasoner.claude_reasoner import ClaudeReasoner
from orchestrator.world_model.model import WorldModel

if TYPE_CHECKING:
    from orchestrator.sim import Simulator

log = logging.getLogger(__name__)

HELP_TEXT = """\
LMAO Hub Planner — Operator Commands
─────────────────────────────────────
  status    Show fleet state summary
  health    Show health tiers and topic rates
  mission   Show active mission tasks
  help      This message
  quit      Shut down the hub

Anything else is sent to the Claude reasoner as a natural-language command.
Examples:
  > Send scout-1 to position (3, 2)
  > Have all robots scan the perimeter
  > What is the status of the current mission?
"""

SIM_HELP_TEXT = """\
Simulation Commands
───────────────────
  fault <robot> [topic]   Kill a sensor feed (default: /scan)
  recover <robot>         Restore all feeds for a robot
  drain <robot> [pct]     Set battery to pct% (default: 10)
"""


class OperatorREPL:
    """Interactive CLI for the human operator."""

    def __init__(
        self,
        reasoner: ClaudeReasoner,
        world: WorldModel,
        health: FleetHealthMonitor,
        *,
        simulator: Simulator | None = None,
    ) -> None:
        self._reasoner = reasoner
        self._world = world
        self._health = health
        self._sim = simulator

    async def run(self) -> None:
        session: PromptSession[str] = PromptSession()
        print("\n" + HELP_TEXT)
        if self._sim:
            print(SIM_HELP_TEXT)

        prompt_str = "lmao[sim]> " if self._sim else "lmao> "

        with patch_stdout():
            while True:
                try:
                    line = await session.prompt_async(prompt_str)
                except (KeyboardInterrupt, EOFError):
                    break

                line = line.strip()
                if not line:
                    continue

                if line in ("quit", "exit"):
                    break

                if line == "help":
                    print(HELP_TEXT)
                    if self._sim:
                        print(SIM_HELP_TEXT)
                    continue

                if line == "status":
                    summary = await self._world.get_fleet_summary()
                    print(f"\n{summary}\n")
                    continue

                if line == "health":
                    report = self._health.get_health_report()
                    if not report:
                        print("  No robots being monitored.")
                    for name, info in report.items():
                        rates = info.get("topic_rates_hz", {})
                        rate_str = ", ".join(
                            f"{t}={r}Hz" for t, r in rates.items()
                        )
                        print(f"  {name}: {info['tier']} | {rate_str}")
                    print()
                    continue

                if line == "mission":
                    missions = await self._world.get_active_missions()
                    if not missions:
                        print("  No active missions.\n")
                    for m in missions:
                        from orchestrator.reasoner.mission import mission_summary
                        print(f"\n{mission_summary(m)}\n")
                    continue

                # --- Simulation-only commands ---
                if self._sim and self._handle_sim_command(line):
                    continue

                # Everything else → Claude reasoner
                print("  thinking...")
                try:
                    response = await self._reasoner.process_command(line)
                    print(f"\n{response}\n")
                except Exception as exc:
                    log.exception("Reasoner error")
                    print(f"  ERROR: {exc}\n")

    # ------------------------------------------------------------------
    # Sim helpers
    # ------------------------------------------------------------------

    def _handle_sim_command(self, line: str) -> bool:
        """Try to handle a sim-only command.  Returns True if handled."""
        parts = line.split()
        cmd = parts[0]

        if cmd == "fault":
            if len(parts) < 2:
                print("  Usage: fault <robot> [topic]")
                return True
            robot = parts[1]
            topic = parts[2] if len(parts) > 2 else "/scan"
            self._sim.inject_fault(robot, topic)
            print(f"  Fault injected: {robot} {topic} killed\n")
            return True

        if cmd == "recover":
            if len(parts) < 2:
                print("  Usage: recover <robot>")
                return True
            robot = parts[1]
            self._sim.clear_fault(robot)
            print(f"  All faults cleared for {robot}\n")
            return True

        if cmd == "drain":
            if len(parts) < 2:
                print("  Usage: drain <robot> [pct]")
                return True
            robot = parts[1]
            pct = float(parts[2]) if len(parts) > 2 else 10.0
            self._sim.set_battery(robot, pct)
            print(f"  Battery for {robot} set to {pct:.0f}%\n")
            return True

        return False
