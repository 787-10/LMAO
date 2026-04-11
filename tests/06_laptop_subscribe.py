#!/usr/bin/env python3
"""T6 — Laptop → robot rosbridge subscribe.

Connects to the robot's rosbridge_server (port 9090 by default) from a
laptop and prints the next 5 /battery_state messages. Validates the
exact path the LMAO hub will use to talk to scouts.

Run on your Mac (NOT the robot):
    pip install roslibpy
    ROBOT_IP=192.168.1.42 python3 tests/06_laptop_subscribe.py

Pass: prints 5 messages within 30 seconds.
"""
from __future__ import annotations

import os
import sys
import time

try:
    import roslibpy
except ImportError:
    print("ERROR: roslibpy not installed. Run: pip install roslibpy", file=sys.stderr)
    sys.exit(2)


ROBOT_IP = os.environ.get("ROBOT_IP", "127.0.0.1")
PORT = int(os.environ.get("ROSBRIDGE_PORT", "9090"))
TARGET_TOPIC = os.environ.get("TARGET_TOPIC", "/battery_state")
TARGET_TYPE = os.environ.get("TARGET_TYPE", "sensor_msgs/BatteryState")
WANT = 5
TIMEOUT_S = 30


def main() -> int:
    print(f"LMAO T6 — laptop rosbridge subscribe")
    print(f"  connecting to ws://{ROBOT_IP}:{PORT}")
    print(f"  subscribing to {TARGET_TOPIC} ({TARGET_TYPE})")
    print(f"  want {WANT} messages within {TIMEOUT_S}s\n")

    client = roslibpy.Ros(host=ROBOT_IP, port=PORT)

    try:
        client.run(timeout=10)
    except Exception as e:
        print(f"FATAL: connection failed: {e}", file=sys.stderr)
        print(
            "Hint: on the robot, run "
            "`ros2 launch rosbridge_server rosbridge_websocket_launch.xml`",
            file=sys.stderr,
        )
        return 1

    if not client.is_connected:
        print("FATAL: client.is_connected is False after run()", file=sys.stderr)
        return 1

    print(f"  connected. waiting for messages...\n")

    received: list[dict] = []

    def on_msg(msg: dict) -> None:
        received.append(msg)
        idx = len(received)
        # /battery_state has voltage + percentage; print whichever fields exist
        voltage = msg.get("voltage", "?")
        percentage = msg.get("percentage", "?")
        print(f"  [{idx}/{WANT}] voltage={voltage} percentage={percentage}")

    listener = roslibpy.Topic(client, TARGET_TOPIC, TARGET_TYPE)
    listener.subscribe(on_msg)

    deadline = time.monotonic() + TIMEOUT_S
    try:
        while len(received) < WANT and time.monotonic() < deadline:
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        listener.unsubscribe()
        client.terminate()

    if len(received) >= WANT:
        print(f"\nOK — received {len(received)} messages")
        return 0
    print(f"\nFAIL — only received {len(received)} of {WANT} messages in {TIMEOUT_S}s")
    print("Hint: check `ros2 topic hz /battery_state` on the robot")
    return 1


if __name__ == "__main__":
    sys.exit(main())
