"""Operator REPL — human interface before the React UI is ready."""
from __future__ import annotations

import asyncio
import logging

from prompt_toolkit import PromptSession
from prompt_toolkit.patch_stdout import patch_stdout

from orchestrator.health.fleet_monitor import FleetHealthMonitor
from orchestrator.reasoner.claude_reasoner import ClaudeReasoner
from orchestrator.world_model.model import WorldModel

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


class OperatorREPL:
    """Interactive CLI for the human operator."""

    def __init__(
        self,
        reasoner: ClaudeReasoner,
        world: WorldModel,
        health: FleetHealthMonitor,
    ) -> None:
        self._reasoner = reasoner
        self._world = world
        self._health = health

    async def run(self) -> None:
        session: PromptSession[str] = PromptSession()
        print("\n" + HELP_TEXT)

        with patch_stdout():
            while True:
                try:
                    line = await session.prompt_async("lmao> ")
                except (KeyboardInterrupt, EOFError):
                    break

                line = line.strip()
                if not line:
                    continue

                if line in ("quit", "exit"):
                    break

                if line == "help":
                    print(HELP_TEXT)
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

                # Everything else → Claude reasoner
                print("  thinking...")
                try:
                    response = await self._reasoner.process_command(line)
                    print(f"\n{response}\n")
                except Exception as exc:
                    log.exception("Reasoner error")
                    print(f"  ERROR: {exc}\n")
