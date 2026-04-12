"""Turn the robot right (clockwise) by a specified angle."""

import math
from brain_client.skill_types import Skill, SkillResult, Interface, InterfaceType


class TurnRight(Skill):
    mobility = Interface(InterfaceType.MOBILITY)

    @property
    def name(self):
        return "turn_right"

    def guidelines(self):
        return "Rotate the robot right (clockwise). Default 45 degrees. Use for exploring or reorienting."

    def execute(self, degrees: float = 30.0):
        """Rotate right by the given angle in degrees.

        Args:
            degrees: angle to turn (default 45)
        """
        self._cancelled = False
        radians = -math.radians(abs(degrees))
        self._send_feedback(f"Turning right {degrees:.0f} degrees")
        self.mobility.rotate(radians)
        return f"Turned right {degrees:.0f} degrees", SkillResult.SUCCESS

    def cancel(self):
        self._cancelled = True
        try:
            self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
        except Exception:
            pass
        return "Turn cancelled"
