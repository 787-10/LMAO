"""FDIR coordinator node — aggregates all channels, publishes unified status.

On-robot:  ros2 run lmao_fdir fdir_node
Off-robot: see laptop_runner.py
"""
from __future__ import annotations

import json
import time
from typing import Any

from lmao_fdir.channels.fault_injector import FaultInjector
from lmao_fdir.channels.frozen_feed import FrozenFeed
from lmao_fdir.channels.joint_check import JointCheck
from lmao_fdir.channels.rate_health import RateHealth
from lmao_fdir.transport import Transport


class FDIRCoordinator:
    """Ties all FDIR channels together and publishes a unified status."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self.fault_injector = FaultInjector(transport)
        self.rate_health = RateHealth(transport)
        self.frozen_feed = FrozenFeed(transport)
        self.joint_check = JointCheck(transport)

    def start(self) -> None:
        """Start all channels and the unified status publisher."""
        self.fault_injector.start()
        self.rate_health.start()
        self.frozen_feed.start()
        self.joint_check.start()
        self._transport.create_timer(1.0, self._publish_status)

    def _compute_tier(self) -> str:
        """Local degradation tier based on channel health."""
        # SAFE_MODE: multiple critical failures
        critical_failures = 0
        if self.rate_health.has_failures():
            critical_failures += 1
        if self.frozen_feed.is_frozen():
            critical_failures += 1
        if self.joint_check.get_overall() == "CRITICAL":
            critical_failures += 1

        if critical_failures >= 2:
            return "SAFE_MODE"

        # DEGRADED_SENSORS: any single failure
        if self.rate_health.has_degraded():
            return "DEGRADED_SENSORS"
        if self.frozen_feed.is_frozen():
            return "DEGRADED_SENSORS"
        if self.joint_check.has_faults():
            return "DEGRADED_SENSORS"

        return "FULL_CAPABILITY"

    def _publish_status(self) -> None:
        active_faults = self.fault_injector.get_active_faults()
        tier = self._compute_tier()

        status: dict[str, Any] = {
            "timestamp": time.time(),
            "tier": tier,
            "active_faults": list(active_faults.keys()),
            "rate_health": self.rate_health.get_report(),
            "camera_health": {
                "status": self.frozen_feed.get_status(),
            },
            "joint_health": {
                "overall": self.joint_check.get_overall(),
            },
        }

        self._transport.publish(
            "/lmao/fdir/status",
            "std_msgs/String",
            {"data": json.dumps(status)},
        )


# ------------------------------------------------------------------
# ROS2 entry point
# ------------------------------------------------------------------

def main(args=None) -> None:
    import rclpy
    from rclpy.node import Node
    from lmao_fdir.transport import RclpyTransport

    rclpy.init(args=args)
    node = Node("lmao_fdir")
    node.get_logger().info("LMAO FDIR node starting...")

    transport = RclpyTransport(node)
    coordinator = FDIRCoordinator(transport)
    coordinator.start()

    node.get_logger().info(
        "FDIR channels active: rate_health, frozen_feed, joint_check, fault_injector"
    )

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
