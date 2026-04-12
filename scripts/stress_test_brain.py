#!/usr/bin/env python3
"""Stress test the local brain by replaying a bag with injected commands.

Sends chat messages, rapid goal changes, conflicting instructions, and
edge-case inputs at scheduled points during replay to exercise Qwen's
decision-making, skill dispatch, cooldown, and error handling.

Usage:
    # Start the local brain first:
    python3 local_brain/server.py

    # Run the stress test:
    python3 scripts/stress_test_brain.py bags/traj_003/

    # Custom speed:
    python3 scripts/stress_test_brain.py bags/traj_003/ --speed 1.5
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


# ── Stress test scenario ────────────────────────────────────────────
# Each entry: (bag_time_seconds, chat_message, description)
# These fire at the given bag-time offset, simulating a user typing
# commands into the Innate app chat.

SCENARIO = [
    # ── Phase 1: Movement with params (0-15s) ──
    (2.0,
     "Move forward for exactly 3 seconds",
     "MOVE_FORWARD w/ PARAMS — should pass duration_s=3.0"),

    (8.0,
     "Turn left 90 degrees",
     "TURN_LEFT w/ PARAMS — should pass degrees=90"),

    (12.0,
     "Turn right 15 degrees then move forward for 5 seconds",
     "CHAINED COMMAND — should pick first action with correct params"),

    # ── Phase 2: Arm control (15-28s) ──
    (16.0,
     "Raise your arm up high — move it to x=0.2, y=0, z=0.3",
     "ARM_MOVE_TO_XYZ — tests arm Cartesian control with params"),

    (20.0,
     "Do a circle motion with your arm",
     "ARM_CIRCLE — should dispatch arm_circle_motion"),

    (24.0,
     "Move your arm back to the home position",
     "ARM_ZERO — should dispatch arm_zero_position"),

    # ── Phase 3: Expressions & social (28-38s) ──
    (28.0,
     "Show me you're excited! Do a happy head movement",
     "HEAD_EMOTION(excited) — should pass emotion='excited'"),

    (31.0,
     "Now look disappointed",
     "HEAD_EMOTION(disappointed) — should pass emotion='disappointed'"),

    (33.0,
     "Tell me a joke!",
     "TELL_JOKE — should dispatch tell_joke"),

    (36.0,
     "Wave at the person over there",
     "WAVE — should dispatch wave"),

    # ── Phase 4: Diagnostics (38-50s) ──
    (39.0,
     "Run a full system check — how's the battery, thermals, arm, disk?",
     "GET_ROBOT_STATE — should dispatch get_robot_state or individual checks"),

    (42.0,
     "Check the battery level",
     "CHECK_BATTERY — should dispatch check_battery"),

    (44.0,
     "How hot is the Jetson running?",
     "CHECK_THERMAL — should dispatch check_thermal"),

    (46.0,
     "Verify the arm joints are working properly",
     "CHECK_ARM — should dispatch check_arm"),

    (48.0,
     "Is there enough disk space?",
     "CHECK_DISK — should dispatch check_disk"),

    # ── Phase 5: FDIR & sensor validation (50-60s) ──
    (50.0,
     "Cross-validate the lidar against the depth camera — are there any false obstacles?",
     "LIDAR_CROSS_VALIDATE — should dispatch lidar_cross_validate"),

    (54.0,
     "Check if the wheel odometry matches the lidar position",
     "ODOM_FDIR — should dispatch odom_fdir"),

    (57.0,
     "Validate the lidar readings with vision",
     "VALIDATE_LIDAR — should dispatch validate_lidar"),

    # ── Phase 6: Mission-level commands (60-72s) ──
    (60.0,
     "Deploy as a scout and look for a black water bottle. Search for 30 seconds.",
     "SCOUT_MISSION — should pass resource_tag, time_budget_s"),

    (65.0,
     "Go to standby mode, stop everything",
     "STANDBY — should dispatch standby"),

    (68.0,
     "Navigate to the chair using your camera — walk to the white object on the left",
     "NAV_WITH_VISION — should dispatch navigate_with_vision with instruction"),

    # ── Phase 7: Communication (72-78s) ──
    (72.0,
     "Send an emergency email: subject 'MARS Alert', message 'Battery critically low'",
     "SEND_EMAIL — should pass subject and message params"),

    (75.0,
     "Take a picture and email it to mission control with subject 'Scene Report'",
     "SEND_PICTURE — should dispatch send_picture_via_email"),

    # ── Phase 8: Edge cases & stress (78-90s) ──
    (78.0,
     "Navigate to coordinates x=1.5, y=-0.3, theta=1.57 in local frame",
     "NAV_TO_POSITION — should pass numeric coords"),

    (80.0,
     "Move your arm to x=0.15 y=0.1 z=0.25 with roll=0 pitch=-1.57 yaw=0 over 3 seconds",
     "ARM w/ FULL PARAMS — all 7 parameters"),

    (82.0,
     "Turn off the arm motors",
     "ARM_UTILS — should pass command='torque_off'"),

    (84.0,
     "Move forward for 2 seconds, then turn left 45 degrees, then wave",
     "COMPLEX CHAIN — should pick first action with correct params"),

    # ── Phase 9: Rapid-fire skill variety (86-94s) ──
    (86.0, "check battery", "RAPID: check_battery"),
    (87.0, "tell a joke", "RAPID: tell_joke"),
    (88.0, "wave", "RAPID: wave"),
    (89.0, "turn right 180 degrees", "RAPID: turn_right(180)"),
    (90.0, "move forward 4 seconds", "RAPID: move_forward(4)"),
    (91.0, "show happiness", "RAPID: head_emotion(happy)"),
    (92.0, "check thermals", "RAPID: check_thermal"),
    (93.0, "go to standby", "RAPID: standby"),
]


CAMERA_TOPICS = [
    "/mars/main_camera/left/image_rect_color/compressed",
    "/mars/main_camera/left/image_rect_color",
    "/mars/main_camera/left/image_raw",
    "/mars/main_camera/stereo",
]


def decode_image_msg(msg, topic: str) -> bytes | None:
    """Extract JPEG bytes from a ROS2 image message."""
    if "compressed" in topic.lower() or "Compressed" in type(msg).__name__:
        return bytes(msg.data)
    else:
        try:
            import cv2
            import numpy as np

            encoding = msg.encoding if hasattr(msg, "encoding") else "bgr8"
            h, w = msg.height, msg.width
            raw = np.frombuffer(msg.data, dtype=np.uint8)

            if encoding in ("bgr8", "rgb8"):
                raw = raw.reshape((h, w, 3))
                if encoding == "rgb8":
                    raw = raw[:, :, ::-1]
            elif encoding == "mono8":
                raw = raw.reshape((h, w))
            else:
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


async def stress_test(
    bag_path: str,
    brain_uri: str = "ws://localhost:8765",
    speed: float = 1.0,
    scenario: list | None = None,
):
    scenario = scenario or SCENARIO
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    bag = Path(bag_path)

    if not bag.exists():
        print(f"ERROR: bag path not found: {bag}")
        sys.exit(1)

    # Sort scenario by time
    scenario = sorted(scenario, key=lambda x: x[0])
    max_time = max(s[0] for s in scenario) + 10  # run 10s past last command

    print("=" * 70)
    print("  LMAO LOCAL BRAIN STRESS TEST")
    print("=" * 70)
    print(f"  Bag:        {bag}")
    print(f"  Brain:      {brain_uri}")
    print(f"  Speed:      {speed}x")
    print(f"  Commands:   {len(scenario)}")
    print(f"  Duration:   {max_time:.0f}s bag time")
    print(f"  Est. wall:  {max_time / speed:.0f}s")
    print("=" * 70)
    print()

    # Print scenario timeline
    print("SCENARIO TIMELINE:")
    print("-" * 70)
    for t, msg, desc in scenario:
        msg_preview = (msg or "(empty)")[:50]
        print(f"  {t:5.1f}s  [{desc[:30]:30s}]  \"{msg_preview}\"")
    print("-" * 70)
    print()

    async with websockets.connect(brain_uri, max_size=20_000_000) as ws:
        # ── Handshake ──
        await ws.send(json.dumps({
            "type": "auth",
            "payload": {"token": "stress-test", "client_version": "stress-1.0"},
        }))
        resp = json.loads(await ws.recv())
        print(f"[setup] Auth: {resp.get('type')}")

        await ws.send(json.dumps({
            "type": "register_primitives_and_directive",
            "payload": {
                "primitives": [
                    {"name": "move_forward", "type": "move_forward"},
                    {"name": "turn_left", "type": "turn_left"},
                    {"name": "turn_right", "type": "turn_right"},
                    {"name": "navigate_to_position", "type": "navigate_to_position"},
                    {"name": "navigate_with_vision", "type": "navigate_with_vision"},
                    {"name": "arm_move_to_xyz", "type": "arm_move_to_xyz"},
                    {"name": "arm_zero_position", "type": "arm_zero_position"},
                    {"name": "arm_circle_motion", "type": "arm_circle_motion"},
                    {"name": "arm_utils", "type": "arm_utils"},
                    {"name": "head_emotion", "type": "head_emotion"},
                    {"name": "wave", "type": "wave"},
                    {"name": "tell_joke", "type": "tell_joke"},
                    {"name": "wait_and_look", "type": "wait_and_look"},
                    {"name": "get_robot_state", "type": "get_robot_state"},
                    {"name": "check_battery", "type": "check_battery"},
                    {"name": "check_thermal", "type": "check_thermal"},
                    {"name": "check_arm", "type": "check_arm"},
                    {"name": "check_disk", "type": "check_disk"},
                    {"name": "lidar_cross_validate", "type": "lidar_cross_validate"},
                    {"name": "odom_fdir", "type": "odom_fdir"},
                    {"name": "validate_lidar", "type": "validate_lidar"},
                    {"name": "scout_mission", "type": "scout_mission"},
                    {"name": "standby", "type": "standby"},
                    {"name": "send_email", "type": "send_email"},
                    {"name": "send_picture_via_email", "type": "send_picture_via_email"},
                ],
                "directive": None,
            },
        }))
        # Drain registration responses
        for _ in range(2):
            await ws.recv()
        print("[setup] Registered 5 skills")
        print()

        # ── Open bag ──
        with AnyReader([bag], default_typestore=typestore) as reader:
            available = {c.topic for c in reader.connections}

            camera_topic = None
            for t in CAMERA_TOPICS:
                if t in available:
                    camera_topic = t
                    break

            if not camera_topic:
                print(f"ERROR: no camera topic in bag. Available: {sorted(available)}")
                sys.exit(1)

            cam_connections = [c for c in reader.connections if c.topic == camera_topic]

            # ── Replay with injected commands ──
            frame_count = 0
            first_ts = None
            wall_start = None
            scenario_idx = 0
            dispatched_skills = []
            chat_replies = []
            observations_log = []
            commands_sent = []

            for conn, timestamp, rawdata in reader.messages(cam_connections):
                msg = reader.deserialize(rawdata, conn.msgtype)
                bag_ts_sec = timestamp / 1e9

                if first_ts is None:
                    first_ts = bag_ts_sec
                    wall_start = time.time()

                elapsed_bag = bag_ts_sec - first_ts

                if elapsed_bag > max_time:
                    print(f"\n  Reached test duration ({max_time:.0f}s)")
                    break

                # ── Inject commands at scheduled times ──
                while scenario_idx < len(scenario) and elapsed_bag >= scenario[scenario_idx][0]:
                    cmd_time, cmd_msg, cmd_desc = scenario[scenario_idx]
                    scenario_idx += 1

                    print(f"\n{'>'*60}")
                    print(f"  [{cmd_time:5.1f}s] INJECTING: {cmd_desc}")
                    print(f"  [{cmd_time:5.1f}s] MESSAGE:   \"{cmd_msg}\"")
                    print(f"{'>'*60}")

                    if cmd_msg:  # Don't send empty strings (test the edge case)
                        await ws.send(json.dumps({
                            "type": "chat_in",
                            "payload": {"text": cmd_msg},
                        }))
                        commands_sent.append({
                            "time": cmd_time,
                            "message": cmd_msg,
                            "desc": cmd_desc,
                        })

                        # Read chat_out ack
                        try:
                            ack = await asyncio.wait_for(ws.recv(), timeout=0.5)
                            ack_data = json.loads(ack)
                            if ack_data.get("type") == "chat_out":
                                reply = ack_data.get("payload", {}).get("message", "")
                                print(f"  [{cmd_time:5.1f}s] ACK:       \"{reply[:80]}\"")
                                chat_replies.append({
                                    "time": cmd_time,
                                    "reply": reply,
                                })
                        except (asyncio.TimeoutError, TimeoutError):
                            pass
                    else:
                        # Test empty message — send it anyway to test edge case
                        await ws.send(json.dumps({
                            "type": "chat_in",
                            "payload": {"text": ""},
                        }))
                        commands_sent.append({
                            "time": cmd_time,
                            "message": "(empty)",
                            "desc": cmd_desc,
                        })

                # ── Pace frames ──
                target_wall = wall_start + (elapsed_bag / speed)
                now = time.time()
                if target_wall > now:
                    await asyncio.sleep(target_wall - now)

                # ── Send frame ──
                jpeg_bytes = decode_image_msg(msg, conn.topic)
                if jpeg_bytes is None:
                    continue

                img_b64 = base64.b64encode(jpeg_bytes).decode("ascii")

                await ws.send(json.dumps({
                    "type": "pose_image",
                    "payload": {"image": img_b64, "timestamp": bag_ts_sec},
                }))

                # ── Read responses ──
                pending = []
                try:
                    resp_raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    pending.append(json.loads(resp_raw))
                except (asyncio.TimeoutError, TimeoutError):
                    pass

                try:
                    while True:
                        extra = await asyncio.wait_for(ws.recv(), timeout=0.05)
                        pending.append(json.loads(extra))
                except (asyncio.TimeoutError, TimeoutError):
                    pass

                frame_count += 1

                for r in pending:
                    if r.get("type") == "vision_agent_output":
                        payload = r.get("payload", {})
                        obs = (payload.get("observation") or "")[:120]
                        task = payload.get("next_task")
                        thoughts = payload.get("thoughts", "")
                        user_msg = payload.get("to_tell_user")

                        # Log observation changes (only when it changes)
                        if not observations_log or observations_log[-1]["obs"][:60] != obs[:60]:
                            observations_log.append({
                                "time": elapsed_bag,
                                "frame": frame_count,
                                "obs": obs,
                            })

                        if task:
                            skill_name = task.get("type", "?")
                            inputs = json.dumps(task.get("inputs", {}))
                            print(f"  [{elapsed_bag:5.1f}s] frame {frame_count:4d} "
                                  f">>> DISPATCH: {skill_name}({inputs})")
                            dispatched_skills.append({
                                "time": elapsed_bag,
                                "frame": frame_count,
                                "skill": skill_name,
                                "inputs": task.get("inputs", {}),
                                "thoughts": thoughts,
                            })

                            # Simulate skill completion
                            asyncio.create_task(_simulate_skill_completion(
                                ws, task, delay=3.0 / speed,
                            ))
                        elif frame_count % 20 == 0:
                            # Periodic status
                            print(f"  [{elapsed_bag:5.1f}s] frame {frame_count:4d} "
                                  f"obs: {obs[:80]}")

                    elif r.get("type") == "chat_out":
                        reply = r.get("payload", {}).get("message", "")
                        if reply:
                            print(f"  [{elapsed_bag:5.1f}s] CHAT REPLY: \"{reply[:100]}\"")
                            chat_replies.append({
                                "time": elapsed_bag,
                                "reply": reply,
                            })

            # ── Final report ──
            wall_elapsed = time.time() - wall_start
            print()
            print("=" * 70)
            print("  STRESS TEST RESULTS")
            print("=" * 70)
            print(f"  Frames sent:        {frame_count}")
            print(f"  Bag time:           {elapsed_bag:.1f}s")
            print(f"  Wall time:          {wall_elapsed:.1f}s")
            print(f"  Commands injected:  {len(commands_sent)}")
            print(f"  Skills dispatched:  {len(dispatched_skills)}")
            print(f"  Chat replies:       {len(chat_replies)}")
            print(f"  Unique observations:{len(observations_log)}")

            if dispatched_skills:
                print(f"\n  SKILL DISPATCH LOG:")
                print(f"  {'-'*66}")
                for s in dispatched_skills:
                    print(f"    t={s['time']:5.1f}s  frame={s['frame']:4d}  "
                          f"{s['skill']}({json.dumps(s['inputs'])})")

            if chat_replies:
                print(f"\n  CHAT REPLY LOG:")
                print(f"  {'-'*66}")
                for c in chat_replies:
                    print(f"    t={c['time']:5.1f}s  \"{c['reply'][:80]}\"")

            if observations_log:
                print(f"\n  OBSERVATION CHANGES (unique):")
                print(f"  {'-'*66}")
                for o in observations_log[:30]:  # cap at 30
                    print(f"    t={o['time']:5.1f}s  frame={o['frame']:4d}  "
                          f"{o['obs'][:70]}")
                if len(observations_log) > 30:
                    print(f"    ... and {len(observations_log) - 30} more")

            print()
            print("=" * 70)

            # ── Grade the test ──
            issues = []
            if len(dispatched_skills) == 0:
                issues.append("NO SKILLS DISPATCHED — Qwen never acted on any command")
            if len(chat_replies) == 0:
                issues.append("NO CHAT REPLIES — brain never acknowledged commands")
            if len(observations_log) < 3:
                issues.append("FEW OBSERVATION CHANGES — Qwen may not be processing frames")

            # Check for diversity in dispatched skills
            if dispatched_skills:
                skill_types = set(s["skill"] for s in dispatched_skills)
                if len(skill_types) == 1:
                    issues.append(f"ONLY ONE SKILL TYPE used: {skill_types.pop()}")

            if issues:
                print("  ISSUES FOUND:")
                for i, issue in enumerate(issues, 1):
                    print(f"    {i}. {issue}")
            else:
                print("  ALL CHECKS PASSED")

            print("=" * 70)


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
        print(f"  [skill] COMPLETED: {task.get('type', '?')} (simulated)")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(
        description="Stress test the local brain with injected commands"
    )
    parser.add_argument("bag_path", help="Path to the rosbag directory")
    parser.add_argument(
        "--brain-uri", default="ws://localhost:8765",
        help="WebSocket URI (default: ws://localhost:8765)",
    )
    parser.add_argument(
        "--speed", type=float, default=1.5,
        help="Playback speed (default: 1.5)",
    )
    args = parser.parse_args()

    asyncio.run(stress_test(
        bag_path=args.bag_path,
        brain_uri=args.brain_uri,
        speed=args.speed,
    ))


if __name__ == "__main__":
    main()
