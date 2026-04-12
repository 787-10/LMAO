"""Move the robot forward for a specified duration."""

import time
from brain_client.skill_types import Skill, SkillResult, Interface, InterfaceType


class MoveForward(Skill):
    mobility = Interface(InterfaceType.MOBILITY)

    @property
    def name(self):
        return "move_forward"

    def guidelines(self):
        return "Drive the robot forward in a straight line. Use duration_s to control how far (default 1.5s at 0.15 m/s = ~0.22m)."

    def execute(self, duration_s: float = 2.0):
        """Drive forward for duration_s seconds at 0.15 m/s.

        Args:
            duration_s: seconds to drive (default 2.0 = ~0.30m)
        """
        self._cancelled = False
        speed = 0.15
        self._send_feedback(f"Moving forward {speed * duration_s:.2f}m ({duration_s}s)")
        self.mobility.send_cmd_vel(linear_x=speed, angular_z=0.0, duration=duration_s)
        deadline = time.time() + duration_s + 0.3
        while time.time() < deadline:
            if self._cancelled:
                self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
                return "Stopped", SkillResult.CANCELLED
            time.sleep(0.1)
        return f"Moved forward ~{speed * duration_s:.2f}m", SkillResult.SUCCESS

    def cancel(self):
        self._cancelled = True
        try:
            self.mobility.send_cmd_vel(linear_x=0.0, angular_z=0.0)
        except Exception:
            pass
        return "Move forward cancelled"
