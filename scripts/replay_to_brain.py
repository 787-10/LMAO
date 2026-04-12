#!/usr/bin/env python3
"""Replay a ROS2 bag into local_brain/server.py via WebSocket.

Reads camera frames from a recorded rosbag and feeds them to the local
brain server using the same WebSocket protocol the robot uses. This lets
you test and iterate on Qwen inference without the physical robot.

Usage:
    # Start the local brain first:
    python3 local_brain/server.py

    # Then replay a bag:
    python3 scripts/replay_to_brain.py bags/20260411_143000/

    # Replay at 2x speed:
    python3 scripts/replay_to_brain.py bags/20260411_143000/ --speed 2.0

    # Replay only the first 30 seconds:
    python3 scripts/replay_to_brain.py bags/20260411_143000/ --duration 30

Requirements:
    pip install rosbags websockets
"""

import argparse
import asyncio
import base64
import json
import sys
import time
from pathlib import Path

import websockets
from rosbags.highlevel import AnyReader
from rosbags.typesys import Stores, get_typestore


# ── Camera topic priorities (first found wins) ──────────────────────
CAMERA_TOPICS = [
    "/mars/main_camera/left/image_rect_color/compressed",
    "/mars/main_camera/left/image_rect_color",
    "/mars/main_camera/left/image_raw",
    "/mars/main_camera/stereo",
]

# Topics to log for context (not sent to brain, just printed)
CONTEXT_TOPICS = [
    "/odom",
    "/scan",
    "/cmd_vel",
    "/battery_state",
    "/mars/arm/state",
    "/mavros/imu/data",
]


def decode_image_msg(msg, topic: str) -> bytes | None:
    """Extract JPEG bytes from a ROS2 image message."""
    if "compressed" in topic.lower() or "Compressed" in type(msg).__name__:
        # sensor_msgs/CompressedImage — data is already JPEG/PNG
        return bytes(msg.data)
    else:
        # sensor_msgs/Image — raw pixels, need to encode to JPEG
        try:
            import cv2
            import numpy as np

            encoding = msg.encoding if hasattr(msg, "encoding") else "bgr8"
            h, w = msg.height, msg.width
            raw = np.frombuffer(msg.data, dtype=np.uint8)

            if encoding in ("bgr8", "rgb8"):
                raw = raw.reshape((h, w, 3))
                if encoding == "rgb8":
                    raw = raw[:, :, ::-1]  # RGB→BGR for cv2
            elif encoding == "mono8":
                raw = raw.reshape((h, w))
            else:
                # Best-effort reshape
                channels = len(msg.data) // (h * w)
                if channels > 1:
                    raw = raw.reshape((h, w, channels))
                else:
                    raw = raw.reshape((h, w))

            _, jpeg = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, 85])
            return jpeg.tobytes()
        except Exception as exc:
            print(f"  [warn] failed to encode raw image: {exc}")
            return None


async def replay(
    bag_path: str,
    brain_uri: str = "ws://localhost:8765",
    speed: float = 1.0,
    duration: float | None = None,
    loop: bool = False,
):
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    bag = Path(bag_path)

    if not bag.exists():
        print(f"ERROR: bag path not found: {bag}")
        sys.exit(1)

    print(f"Opening bag: {bag}")
    print(f"Brain URI:   {brain_uri}")
    print(f"Speed:       {speed}x")
    if duration:
        print(f"Duration:    {duration}s of bag time")
    print()

    while True:
        async with websockets.connect(brain_uri, max_size=20_000_000) as ws:
            # ── Handshake: send auth ──
            await ws.send(json.dumps({
                "type": "auth",
                "payload": {
                    "token": "replay-offline",
                    "client_version": "replay-1.0",
                },
            }))
            resp = json.loads(await ws.recv())
            print(f"Auth response: {resp.get('type')}")

            # ── Register skills (so brain knows what it can dispatch) ──
            await ws.send(json.dumps({
                "type": "register_primitives_and_directive",
                "payload": {
                    "primitives": [
                        {"name": "move_forward", "type": "move_forward"},
                        {"name": "turn_left", "type": "turn_left"},
                        {"name": "turn_right", "type": "turn_right"},
                        {"name": "wave", "type": "wave"},
                        {"name": "head_emotion", "type": "head_emotion"},
                    ],
                    "directive": None,
                },
            }))
            resp = json.loads(await ws.recv())
            print(f"Register response: {resp.get('type')}")

            # Wait for ready_for_image
            resp = json.loads(await ws.recv())
            print(f"Ready: {resp.get('type')}")
            print()

            # ── Find which camera topic exists in this bag ──
            with AnyReader([bag], default_typestore=typestore) as reader:
                available = {c.topic for c in reader.connections}
                print(f"Bag topics: {sorted(available)}")

                camera_topic = None
                for t in CAMERA_TOPICS:
                    if t in available:
                        camera_topic = t
                        break

                if not camera_topic:
                    print(f"ERROR: no camera topic found in bag.")
                    print(f"  Looked for: {CAMERA_TOPICS}")
                    print(f"  Available:  {sorted(available)}")
                    sys.exit(1)

                context_available = [t for t in CONTEXT_TOPICS if t in available]
                print(f"Camera topic: {camera_topic}")
                print(f"Context topics: {context_available}")
                print()

                # ── Replay loop ──
                topics_to_read = [camera_topic] + context_available
                connections = [
                    c for c in reader.connections
                    if c.topic in topics_to_read
                ]

                frame_count = 0
                skipped = 0
                first_ts = None
                wall_start = None
                last_context: dict[str, str] = {}
                dispatched_skills: list[dict] = []

                for conn, timestamp, rawdata in reader.messages(connections):
                    msg = reader.deserialize(rawdata, conn.msgtype)
                    bag_ts_sec = timestamp / 1e9

                    if first_ts is None:
                        first_ts = bag_ts_sec
                        wall_start = time.time()

                    elapsed_bag = bag_ts_sec - first_ts

                    # Duration limit
                    if duration and elapsed_bag > duration:
                        print(f"\n  Reached duration limit ({duration}s)")
                        break

                    # Context topics: just log
                    if conn.topic != camera_topic:
                        topic_short = conn.topic.split("/")[-1]
                        last_context[conn.topic] = f"t={elapsed_bag:.1f}s"
                        continue

                    # Camera frame — pace to match bag timing
                    target_wall = wall_start + (elapsed_bag / speed)
                    now = time.time()
                    if target_wall > now:
                        await asyncio.sleep(target_wall - now)

                    # Decode image
                    jpeg_bytes = decode_image_msg(msg, conn.topic)
                    if jpeg_bytes is None:
                        skipped += 1
                        continue

                    img_b64 = base64.b64encode(jpeg_bytes).decode("ascii")

                    # Send pose_image (same format the robot sends)
                    await ws.send(json.dumps({
                        "type": "pose_image",
                        "payload": {
                            "image": img_b64,
                            "timestamp": bag_ts_sec,
                        },
                    }))

                    # Read the brain's response
                    resp_raw = await ws.recv()
                    resp = json.loads(resp_raw)

                    # There may be multiple responses (vision_agent_output,
                    # ready_for_image, chat_out, etc). Drain them.
                    pending = []
                    pending.append(resp)
                    try:
                        while True:
                            extra = await asyncio.wait_for(ws.recv(), timeout=0.05)
                            pending.append(json.loads(extra))
                    except (asyncio.TimeoutError, TimeoutError):
                        pass

                    frame_count += 1
                    elapsed_wall = time.time() - wall_start

                    # Parse the vision_agent_output
                    for r in pending:
                        if r.get("type") == "vision_agent_output":
                            payload = r.get("payload", {})
                            obs = (payload.get("observation") or "")[:100]
                            task = payload.get("next_task")
                            thoughts = payload.get("thoughts", "")

                            status = f"[{elapsed_bag:6.1f}s] frame {frame_count:4d}"
                            if task:
                                skill_name = task.get("type", "?")
                                inputs = json.dumps(task.get("inputs", {}))
                                print(f"{status} >>> DISPATCH: {skill_name}({inputs})")
                                dispatched_skills.append({
                                    "time": elapsed_bag,
                                    "frame": frame_count,
                                    "skill": skill_name,
                                    "inputs": task.get("inputs", {}),
                                })

                                # Simulate skill completion after a short delay
                                # so the brain doesn't stay blocked
                                asyncio.create_task(_simulate_skill_completion(
                                    ws, task, delay=3.0 / speed,
                                ))
                            else:
                                print(f"{status} obs: {obs}")

                print(f"\n{'='*60}")
                print(f"Replay complete")
                print(f"  Frames sent:      {frame_count}")
                print(f"  Frames skipped:   {skipped}")
                print(f"  Bag time:         {elapsed_bag:.1f}s")
                print(f"  Wall time:        {time.time() - wall_start:.1f}s")
                print(f"  Skills dispatched: {len(dispatched_skills)}")
                if dispatched_skills:
                    print(f"\n  Skill log:")
                    for s in dispatched_skills:
                        print(f"    t={s['time']:.1f}s frame={s['frame']} "
                              f"{s['skill']}({json.dumps(s['inputs'])})")
                print(f"{'='*60}")

        if not loop:
            break
        print("\n  Looping — replaying again...\n")


async def _simulate_skill_completion(ws, task: dict, delay: float):
    """After a delay, send primitive_completed so the brain unblocks."""
    await asyncio.sleep(delay)
    try:
        await ws.send(json.dumps({
            "type": "primitive_completed",
            "payload": {
                "primitive_id": task.get("primitive_id", ""),
                "type": task.get("type", ""),
                "name": task.get("type", ""),
                "message": f"simulated completion of {task.get('type', '?')}",
            },
        }))
    except Exception:
        pass  # connection may have closed


def main():
    parser = argparse.ArgumentParser(
        description="Replay a ROS2 bag into the local brain via WebSocket"
    )
    parser.add_argument("bag_path", help="Path to the rosbag directory")
    parser.add_argument(
        "--brain-uri", default="ws://localhost:8765",
        help="WebSocket URI of local_brain/server.py (default: ws://localhost:8765)",
    )
    parser.add_argument(
        "--speed", type=float, default=1.0,
        help="Playback speed multiplier (default: 1.0)",
    )
    parser.add_argument(
        "--duration", type=float, default=None,
        help="Only replay this many seconds of bag time",
    )
    parser.add_argument(
        "--loop", action="store_true",
        help="Loop the bag continuously",
    )
    args = parser.parse_args()

    asyncio.run(replay(
        bag_path=args.bag_path,
        brain_uri=args.brain_uri,
        speed=args.speed,
        duration=args.duration,
        loop=args.loop,
    ))


if __name__ == "__main__":
    main()
