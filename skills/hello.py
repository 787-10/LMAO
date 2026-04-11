"""Hello skill — proves brain_client picks up new skills via hot reload.

T4 in the validation pack. This skill does nothing useful; the point is
that dropping it into ~/innate-os/skills/hello.py (via the symlink) makes
the brain register it without any rebuild or restart.

Modify the return string and save → brain_client picks up the new version
within ~2 seconds via its file watcher.
"""
from brain_client.skill_types import Skill, SkillResult


class Hello(Skill):
    def __init__(self, logger):
        self.logger = logger
        logger.info("hello skill loaded")

    @property
    def name(self) -> str:
        return "hello"

    def guidelines(self) -> str:
        return (
            "Test skill for the LMAO validation pack. Use only when an "
            "operator explicitly asks the robot to say hello, or as part "
            "of T4 of the day-1 validation checklist."
        )

    def execute(self) -> tuple[str, SkillResult]:
        self.logger.info("hello skill called")
        return "hello from LMAO", SkillResult.SUCCESS

    def cancel(self) -> str:
        return "hello cancelled"
