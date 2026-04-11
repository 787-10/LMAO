#!/usr/bin/env python3
"""T5 — cmd_vel nudge.

Publishes a tiny forward Twist for 0.5 seconds, then commands stop. The
robot should creep forward ~5 cm.

SAFETY: put the robot on the floor with at least 1 m of clear space in
front of it before running. The script waits 5 seconds before publishing
so you can Ctrl+C if anything looks wrong.

Validates: cmd_vel pipeline works end-to-end (subscriber on the firmware
side, motors actually responding). This is what every LMAO scout will use
to execute its assigned mission.

Run on the robot:
    python3 tests/05_cmd_vel_nudge.py
"""
from __future__ import annotations

import sys
import time

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node


LINEAR_X = 0.10        # m/s — gentle creep
DURATION_S = 0.5       # how long to drive forward
TICK_HZ = 20           # publish rate while driving


class CmdVelNudge(Node):
    def __init__(self) -> None:
        super().__init__("lmao_cmd_vel_nudge")
        self.pub = self.create_publisher(Twist, "/cmd_vel", 10)

    def drive(self, linear_x: float, duration_s: float) -> None:
        msg = Twist()
        msg.linear.x = linear_x
        deadline = time.monotonic() + duration_s
        period = 1.0 / TICK_HZ
        while time.monotonic() < deadline and rclpy.ok():
            self.pub.publish(msg)
            time.sleep(period)

    def stop(self) -> None:
        # Send several zero messages to be safe — one might be lost.
        zero = Twist()
        for _ in range(10):
            self.pub.publish(zero)
            time.sleep(0.05)


def countdown(seconds: int) -> None:
    print(f"\nABOUT TO PUBLISH A {LINEAR_X} m/s FORWARD COMMAND FOR {DURATION_S}s.")
    print("Confirm robot is on the floor with clear space in front.")
    print(f"Ctrl+C in the next {seconds}s to abort.\n")
    for i in range(seconds, 0, -1):
        print(f"  {i}...")
        time.sleep(1)


def main() -> int:
    rclpy.init()
    node = CmdVelNudge()
    try:
        countdown(5)
        print("Driving...")
        node.drive(LINEAR_X, DURATION_S)
        print("Stopping...")
        node.stop()
        print(f"\nDone. Robot should have moved ~{LINEAR_X * DURATION_S * 100:.0f} cm.")
        print("If it didn't move at all:")
        print("  - Check `ros2 topic info /cmd_vel` shows a subscriber on the firmware side")
        print("  - Check `ros2 node list` shows maurice_bringup nodes alive")
        print("  - Try increasing LINEAR_X to 0.15 (some bases have a deadband)")
        return 0
    except KeyboardInterrupt:
        print("\nAborted. Sending stop just in case...")
        try:
            node.stop()
        except Exception:
            pass
        return 130
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    sys.exit(main())
