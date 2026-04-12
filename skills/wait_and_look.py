"""Pause and observe — gives the camera time to capture fresh visual state."""

import time
from brain_client.skill_types import Skill, SkillResult


class WaitAndLook(Skill):

    @property
    def name(self):
        return "wait_and_look"

    def guidelines(self):
        return "Pause to observe the environment before making a decision. Use when uncertain about what's ahead."

    def execute(self, duration_s: float = 1.5):
        """Pause for duration_s seconds, doing nothing.

        Args:
            duration_s: seconds to wait (default 1.5)
        """
        self._send_feedback(f"Observing for {duration_s:.1f}s")
        time.sleep(duration_s)
        return f"Observed for {duration_s:.1f}s", SkillResult.SUCCESS

    def cancel(self):
        return "Observation cancelled"
