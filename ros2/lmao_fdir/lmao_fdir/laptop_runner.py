"""Off-robot FDIR runner — same detection logic, roslibpy transport.

Usage:
    ROBOT_IP=192.168.1.42 uv run python -m lmao_fdir.laptop_runner
    ROBOT_IP=192.168.1.42 ROSBRIDGE_PORT=9090 uv run python -m lmao_fdir.laptop_runner
"""
from __future__ import annotations

import logging
import os
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("lmao_fdir")


def main() -> None:
    try:
        import roslibpy
    except ImportError:
        print("ERROR: roslibpy not installed. Run: uv add roslibpy", file=sys.stderr)
        sys.exit(2)

    from lmao_fdir.transport import RoslibpyTransport
    from lmao_fdir.fdir_node import FDIRCoordinator

    robot_ip = os.environ.get("ROBOT_IP", "127.0.0.1")
    port = int(os.environ.get("ROSBRIDGE_PORT", "9090"))

    print(f"LMAO FDIR — laptop runner")
    print(f"  connecting to ws://{robot_ip}:{port}")

    client = roslibpy.Ros(host=robot_ip, port=port)
    try:
        client.run(timeout=10)
    except Exception as e:
        print(f"FATAL: connection failed: {e}", file=sys.stderr)
        sys.exit(1)

    if not client.is_connected:
        print("FATAL: client.is_connected is False", file=sys.stderr)
        sys.exit(1)

    print(f"  connected. Starting FDIR channels...\n")

    transport = RoslibpyTransport(client)
    coordinator = FDIRCoordinator(transport)
    coordinator.start()

    print("FDIR channels active: rate_health, frozen_feed, joint_check, fault_injector")
    print("Publishing unified status on /lmao/fdir/status")
    print("Press Ctrl+C to stop.\n")

    try:
        while client.is_connected:
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        print("\nShutting down...")
        client.terminate()
        print("FDIR laptop runner stopped.")


if __name__ == "__main__":
    main()
