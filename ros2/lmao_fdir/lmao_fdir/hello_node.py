"""Heartbeat node — proves the LMAO deploy pipeline works end-to-end.

Trivial: publishes a counter on /lmao/heartbeat at 1 Hz. If you see these
messages on the robot after `innate build lmao_fdir && ros2 run lmao_fdir
hello_node`, the entire build → install → execute pipeline works.

This is the smallest possible thing that uses every link in the chain.
Don't delete it — keep it as a smoke test for future deploys.
"""
from __future__ import annotations

import rclpy
from rclpy.node import Node
from std_msgs.msg import String


class HelloNode(Node):
    def __init__(self) -> None:
        super().__init__("lmao_hello")
        self.pub = self.create_publisher(String, "/lmao/heartbeat", 10)
        self.tick = 0
        self.create_timer(1.0, self._on_tick)
        self.get_logger().info("LMAO hello_node alive — publishing /lmao/heartbeat")

    def _on_tick(self) -> None:
        self.tick += 1
        self.pub.publish(String(data=f"alive (tick={self.tick})"))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = HelloNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
