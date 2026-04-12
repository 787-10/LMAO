"""Local brain server — replaces wss://agent-v1.innate.bot with Qwen2.5-VL.

Action-gated inference: Qwen only decides after seeing the result of its
last action. No cooldown timer — the state machine prevents repetition.

    OBSERVE → THINK → ACT → WAIT_COMPLETE → WAIT_FRESH → OBSERVE

Run:
    python3 local_brain/server.py

Robot config (.env):
    BRAIN_WEBSOCKET_URI=ws://<mac-ip>:8765
"""

import asyncio
import base64
import json
import logging
import re
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from enum import Enum

import websockets
from websockets.server import WebSocketServerProtocol


# ---------------------------------------------------------------------------
# Protocol constants
# ---------------------------------------------------------------------------

IN_AUTH = "auth"
IN_DIRECTIVE = "directive"
IN_IMAGE = "image"
IN_POSE_IMAGE = "pose_image"
IN_CHAT_IN = "chat_in"
IN_CUSTOM_INPUT = "custom_input"
IN_PRIMITIVE_ACTIVATED = "primitive_activated"
IN_PRIMITIVE_COMPLETED = "primitive_completed"
IN_PRIMITIVE_INTERRUPTED = "primitive_interrupted"
IN_PRIMITIVE_FAILED = "primitive_failed"
IN_PRIMITIVE_FEEDBACK = "primitive_feedback"
IN_REGISTER = "register_primitives_and_directive"
IN_RESET = "reset"

OUT_READY_FOR_IMAGE = "ready_for_image"
OUT_VISION_AGENT_OUTPUT = "vision_agent_output"
OUT_CHAT_OUT = "chat_out"
OUT_THOUGHTS = "thoughts"
OUT_ERROR = "error"
OUT_STOP_AND_GO_BACK = "stop_and_go_back"
OUT_REGISTERED = "primitives_and_directive_registered"
OUT_MEMORY_POSITIONS = "memory_positions"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("local-brain")


# ---------------------------------------------------------------------------
# Skills catalog
# ---------------------------------------------------------------------------

SKILLS_CATALOG = [
    # --- Movement ---
    {
        "name": "move_forward",
        "description": "Drive forward in a straight line. Specify duration to control distance.",
        "params": "duration_s: float",
    },
    {
        "name": "turn_left",
        "description": "Rotate left (counter-clockwise).",
        "params": "degrees: float",
    },
    {
        "name": "turn_right",
        "description": "Rotate right (clockwise).",
        "params": "degrees: float",
    },
    {
        "name": "navigate_to_position",
        "description": "Navigate to x,y coordinates with heading theta (radians). Set local_frame=true for relative coordinates.",
        "params": "x: float, y: float, theta: float, local_frame: bool",
    },
    {
        "name": "navigate_with_vision",
        "description": "Navigate using a natural-language instruction, e.g. 'walk to the red chair'.",
        "params": "instruction: str",
    },
    # --- Arm ---
    {
        "name": "arm_move_to_xyz",
        "description": "Move the arm end-effector to a Cartesian position (meters, relative to base).",
        "params": "x: float, y: float, z: float, roll: float, pitch: float, yaw: float, duration: int",
    },
    {
        "name": "arm_zero_position",
        "description": "Move the arm to its home/zero position (all joints at 0 radians).",
        "params": "duration: int",
    },
    {
        "name": "arm_circle_motion",
        "description": "Move the arm in a circular motion pattern in the YZ plane.",
        "params": "center_x: float, center_y: float, center_z: float, radius: float, num_loops: int",
    },
    {
        "name": "arm_utils",
        "description": "Low-level arm commands: 'torque_on', 'torque_off', or 'reboot_arm'.",
        "params": "command: str",
    },
    # --- Expression ---
    {
        "name": "wave",
        "description": "Wave at a person nearby using the arm.",
        "params": "(no parameters)",
    },
    {
        "name": "tell_joke",
        "description": "Tell a joke out loud through the speaker.",
        "params": "(no parameters)",
    },
    # --- Observation / Diagnostics ---
    {
        "name": "wait_and_look",
        "description": "Pause to observe the environment before deciding. Use when uncertain.",
        "params": "duration_s: float",
    },
    {
        "name": "get_robot_state",
        "description": "Full telemetry snapshot: battery, thermal, compute, lidar, arm, odom.",
        "params": "(no parameters)",
    },
    {
        "name": "check_battery",
        "description": "Read battery voltage and percentage. FAILURE if below safe levels.",
        "params": "(no parameters)",
    },
    {
        "name": "check_thermal",
        "description": "Read Jetson thermal zones. FAILURE if any zone >= 80°C.",
        "params": "(no parameters)",
    },
    {
        "name": "check_arm",
        "description": "Verify all 6 arm joints report valid positions.",
        "params": "(no parameters)",
    },
    {
        "name": "check_disk",
        "description": "Report disk space. FAILURE if < 5% free or < 2GB free.",
        "params": "(no parameters)",
    },
    # --- FDIR ---
    {
        "name": "lidar_cross_validate",
        "description": "Cross-validate lidar anomalies against stereo depth camera.",
        "params": "(no parameters)",
    },
    {
        "name": "odom_fdir",
        "description": "Drive forward ~1m and compare wheel-encoder odom against lidar AMCL to detect drift.",
        "params": "(no parameters)",
    },
    {
        "name": "validate_lidar",
        "description": "Detect false lidar obstacles by cross-checking with the vision LLM.",
        "params": "(no parameters)",
    },
    # --- Vision-guided approach (YOLO on Mac, commands sent to robot) ---
    {
        "name": "approach_target",
        "description": "Use YOLO vision to detect and drive toward a target object. Handles steering and stops when close. After it completes successfully for a target, do NOT call it again for the same target — set action to 'none'.",
        "params": "target: str (e.g. 'bottle', 'person', 'chair', 'cup', 'laptop', 'cardboard box')",
    },
    # --- Mission ---
    {
        "name": "scout_mission",
        "description": "Deploy as scout: drive forward, rotate to scan for a resource, report if found.",
        "params": "resource_tag: str, travel_duration_s: float, scan_directions: int, time_budget_s: float",
    },
    {
        "name": "standby",
        "description": "Stop all autonomous behavior. Puts brain into standby mode.",
        "params": "(no parameters)",
    },
    # --- Learned / Replay skills ---
    {
        "name": "recovery",
        "description": "Recovery maneuver to get unstuck or recover from a bad position. Performs an arm movement and repositioning sequence. ONE-SHOT: run exactly once, then set action to 'none'. Use this when the robot is stuck, trapped, needs to recover, or is told to 'get unstuck'.",
        "params": "(no parameters)",
    },
    # --- Communication ---
    {
        "name": "send_email",
        "description": "Send an emergency email notification.",
        "params": "subject: str, message: str",
    },
    {
        "name": "send_picture_via_email",
        "description": "Send an email with the latest camera view attached.",
        "params": "subject: str, message: str, recipient: str",
    },
]

DEFAULT_DIRECTIVE = (
    "You are MARS, a scout robot with a 6-DOF arm, stereo cameras, lidar, "
    "and diagnostic capabilities. Explore your environment, interact with "
    "people, perform diagnostics when asked, and report findings. "
    "Wave at people you encounter. Use the arm for manipulation tasks."
)


def _build_skills_block() -> str:
    lines = []
    for s in SKILLS_CATALOG:
        lines.append(f"- {s['name']}({s['params']}): {s['description']}")
    return "\n".join(lines)


SKILLS_BLOCK = _build_skills_block()


# ---------------------------------------------------------------------------
# Inference state machine
# ---------------------------------------------------------------------------

class WorkerState(Enum):
    OBSERVE = "observe"           # waiting for a fresh frame
    THINKING = "thinking"         # Qwen inference running
    WAIT_COMPLETE = "wait_complete"  # action dispatched, waiting for completion
    WAIT_FRESH = "wait_fresh"     # action done, waiting for fresh camera frame


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

MODEL_PATH = "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"

_model = None
_processor = None
_config = None
_model_ready = threading.Event()

# Frame buffer
_frame_lock = threading.Lock()
_latest_frame_bytes: bytes | None = None
_frame_event = threading.Event()
_frame_counter = 0  # monotonic, incremented on each new frame

# Qwen output (consumed by the WS handler)
_obs_lock = threading.Lock()
_latest_obs = "model loading..."
_latest_task: dict | None = None
_latest_chat_reply: str | None = None
_latest_obs_time = 0.0
_inference_count = 0

# Worker state machine
_worker_state = WorkerState.OBSERVE
_worker_lock = threading.Lock()
_action_complete_event = threading.Event()
_last_action_description = "none (just started)"
_approach_consecutive_fails = 0
_oneshot_skills_used: set = set()  # tracks one-shot skills already dispatched

ONESHOT_SKILLS = {"recovery"}  # skills that must only run once per goal
_approach_completed_targets: set = set()  # tracks targets approach_target already reached

# Goal (persistent)
_goal_lock = threading.Lock()
_current_goal: str | None = None

# Recent events
_events_lock = threading.Lock()
_recent_events: deque = deque(maxlen=8)

# Directive
_directive = DEFAULT_DIRECTIVE


_event_loop = None  # set in main(), used by worker thread to schedule broadcasts


def _emit_brain_event(event_type: str, data: dict) -> None:
    """Broadcast a brain_event to all connected sessions (thread-safe)."""
    if _event_loop is None:
        return
    payload = {
        "event": event_type,
        "data": data,
        "timestamp": time.time(),
    }
    asyncio.run_coroutine_threadsafe(
        _broadcast("brain_event", payload), _event_loop
    )


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def _load_model():
    global _model, _processor, _config
    from mlx_vlm import load
    from mlx_vlm.utils import load_config
    log.info("loading %s ...", MODEL_PATH)
    t0 = time.time()
    _model, _processor = load(MODEL_PATH)
    _config = load_config(MODEL_PATH)
    log.info("model loaded in %.1fs", time.time() - t0)
    _model_ready.set()


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

def _build_prompt() -> str:
    with _goal_lock:
        goal = _current_goal

    with _events_lock:
        events = list(_recent_events)

    goal_block = ""
    if goal:
        goal_block = f"\nGOAL: {goal}\n"
    else:
        goal_block = "\nGOAL: None — wait for a user command.\n"

    events_block = ""
    if events:
        events_block = "\nRECENT:\n" + "\n".join(events[-4:]) + "\n"

    return (
        f"You are MARS, a mobile robot. You move by choosing one action at a time.\n"
        f"{goal_block}"
        f"\nLAST ACTION: {_last_action_description} -> COMPLETED\n"
        f"The camera now shows the result AFTER that action.\n"
        f"{events_block}\n"
        f"SKILLS (you may ONLY use these — no other skills exist):\n{SKILLS_BLOCK}\n\n"
        f"RULES (follow strictly):\n"
        f"1. You may ONLY use skills listed above. NEVER use navigate_with_vision or navigate_to_position.\n"
        f"2. approach_target: use to drive toward a visible target. It handles ALL steering and stopping internally. After it completes successfully, the target has been REACHED — set action to 'none'. Do NOT call approach_target again for the same target.\n"
        f"3. If you CANNOT see the target at all, search: turn_left(60) or turn_right(60), then move_forward, then look again.\n"
        f"4. Only use wait_and_look if there is NO goal set.\n"
        f"5. If you see a wall or obstacle directly ahead, turn to avoid it.\n"
        f"6. recovery is ONE-SHOT: run it exactly ONCE, then set action to 'none'. NEVER call recovery twice.\n"
        f"7. 'get unstuck' or 'recover' means: run recovery once, then stop.\n"
        f"8. When RECENT events show a skill '[completed]', that task is DONE. Set action to 'none' unless you have a different task to do.\n"
        f"9. Respond with ONLY valid JSON.\n\n"
        f'FORMAT: {{"action": "<skill or none>", "inputs": {{<params>}}, '
        f'"observation": "<what you see>", '
        f'"reply": "<response to user, or null>", '
        f'"reason": "<why>"}}'
    )


# ---------------------------------------------------------------------------
# JSON parsing
# ---------------------------------------------------------------------------

def _parse_json_from_text(text: str) -> dict | None:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    return None


# ---------------------------------------------------------------------------
# Inference worker (state machine)
# ---------------------------------------------------------------------------

def _inference_worker():
    global _latest_obs, _latest_task, _latest_chat_reply
    global _latest_obs_time, _inference_count
    global _worker_state, _last_action_description, _frame_counter, _approach_consecutive_fails
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    _model_ready.wait()
    log.info("inference worker ready — state machine active")
    tmp_path = "/tmp/mars_qwen_input.jpg"

    while True:
      try:
        # ── OBSERVE: wait for a frame ────────────────────────────────
        with _worker_lock:
            _worker_state = WorkerState.OBSERVE

        _frame_event.wait()
        _frame_event.clear()

        with _frame_lock:
            frame = _latest_frame_bytes
        if frame is None:
            continue

        log.info("WORKER: got frame (%d bytes), starting inference...", len(frame))

        try:
            with open(tmp_path, "wb") as f:
                f.write(frame)
        except OSError:
            continue

        # Save a copy for the decision frame log
        _current_frame_bytes = frame

        # ── THINK: run Qwen ─────────────────────────────────────────
        with _worker_lock:
            _worker_state = WorkerState.THINKING

        prompt = _build_prompt()
        formatted = apply_chat_template(
            _processor, _config, prompt, num_images=1
        )

        t0 = time.time()
        try:
            result = generate(
                _model, _processor, formatted, [tmp_path],
                max_tokens=200, verbose=False,
            )
            raw_text = getattr(result, "text", None) or str(result)
        except Exception as exc:
            raw_text = f'{{"action": "wait_and_look", "inputs": {{}}, "observation": "inference error", "reason": "error: {exc}"}}'

        dt = time.time() - t0
        _inference_count += 1

        parsed = _parse_json_from_text(raw_text)
        obs = raw_text.strip()
        task = None
        chat_reply = None

        if parsed:
            obs = parsed.get("observation", obs)
            action = (parsed.get("action") or "none").strip().lower()
            chat_reply = parsed.get("reply")
            if isinstance(chat_reply, str) and chat_reply.lower() in ("null", "none", ""):
                chat_reply = None

            log.info("DECIDE [%d] action=%s reason=%s",
                     _inference_count, action,
                     (parsed.get("reason") or "?")[:80])

            ALLOWED_SKILLS = {s["name"] for s in SKILLS_CATALOG}
            if action not in ("none", "wait_and_look"):
                if action not in ALLOWED_SKILLS:
                    log.warning("BLOCKED [%d] skill=%s — not in allowed set",
                                _inference_count, action)
                elif action in ONESHOT_SKILLS and action in _oneshot_skills_used:
                    log.warning("BLOCKED [%d] skill=%s — one-shot already used, ignoring",
                                _inference_count, action)
                elif action == "approach_target":
                    target_param = (parsed.get("inputs") or {}).get("target", "").lower().strip()
                    if target_param in _approach_completed_targets:
                        log.warning("BLOCKED [%d] approach_target(%s) — already reached this target",
                                    _inference_count, target_param)
                    elif _approach_consecutive_fails >= 2:
                        _approach_consecutive_fails += 1
                        if _approach_consecutive_fails >= 5:
                            _approach_consecutive_fails = 0
                            log.info("APPROACH RESET — allowing retry after %d blocks", _inference_count)
                        else:
                            log.warning("BLOCKED [%d] approach_target — %d consecutive fails, search first",
                                        _inference_count, _approach_consecutive_fails)
                    else:
                        # Allow dispatch — falls through to the dispatch block below
                        inputs = parsed.get("inputs") or {}
                        task = {
                            "type": action,
                            "inputs": inputs,
                            "primitive_id": str(uuid.uuid4()),
                        }
                        params_str = ", ".join(f"{k}={v}" for k, v in inputs.items())
                        _last_action_description = (
                            f"{action}({params_str})" if params_str else f"{action}()"
                        )
                        log.info("DISPATCH [%d] skill=%s inputs=%s",
                                 _inference_count, action, json.dumps(inputs))
                else:
                    inputs = parsed.get("inputs") or {}
                    task = {
                        "type": action,
                        "inputs": inputs,
                        "primitive_id": str(uuid.uuid4()),
                    }
                    params_str = ", ".join(f"{k}={v}" for k, v in inputs.items())
                    _last_action_description = (
                        f"{action}({params_str})" if params_str else f"{action}()"
                    )
                    if action in ONESHOT_SKILLS:
                        _oneshot_skills_used.add(action)
                    log.info("DISPATCH [%d] skill=%s inputs=%s",
                             _inference_count, action, json.dumps(inputs))
            elif action == "wait_and_look":
                _last_action_description = "wait_and_look() — paused to observe"
                log.info("WAIT [%d]", _inference_count)
        else:
            log.warning("PARSE FAIL [%d]: %s", _inference_count, raw_text[:200])

        with _obs_lock:
            _latest_obs = obs
            _latest_task = task
            _latest_chat_reply = chat_reply
            _latest_obs_time = time.time()

        log.info("QWEN [%d] (%.1fs): %s", _inference_count, dt, obs[:120])
        if chat_reply:
            log.info("REPLY [%d]: %s", _inference_count, chat_reply[:120])

        # Broadcast decision to all sessions (orchestrator dashboard)
        action_name = parsed.get("action", "?") if parsed else "parse_fail"
        _emit_brain_event("decision", {
            "decision": _inference_count,
            "action": action_name,
            "observation": obs[:200],
            "reason": (parsed.get("reason") or "")[:150] if parsed else "",
            "inference_time_s": round(dt, 2),
        })

        # Save the frame + decision metadata to the frame log
        try:
            import os
            frame_dir = "/tmp/mars_frames"
            os.makedirs(frame_dir, exist_ok=True)
            frame_path = os.path.join(frame_dir, f"decision_{_inference_count:04d}.jpg")
            with open(frame_path, "wb") as f:
                f.write(_current_frame_bytes)
            meta_path = os.path.join(frame_dir, f"decision_{_inference_count:04d}.json")
            with open(meta_path, "w") as f:
                json.dump({
                    "decision": _inference_count,
                    "action": parsed.get("action") if parsed else "parse_fail",
                    "inputs": parsed.get("inputs") if parsed else {},
                    "observation": obs[:300],
                    "reason": (parsed.get("reason") or "")[:200] if parsed else "",
                    "reply": chat_reply,
                    "inference_time_s": round(dt, 2),
                    "timestamp": datetime.now().isoformat(),
                }, f, indent=2)
        except Exception as exc:
            log.warning("frame log save failed: %s", exc)

        # ── ACT or continue ─────────────────────────────────────────
        if task is not None:
            # Check if this is an approach_target meta-skill
            if task["type"] == "approach_target" and _servo is not None:
                target_desc = (task.get("inputs") or {}).get("target", "object")
                log.info("SERVO MODE: approaching '%s'", target_desc)

                # Notify the app via chat + to_tell_user
                with _obs_lock:
                    _latest_chat_reply = f"🎯 approach_target(target=\"{target_desc}\") — using YOLO to navigate to {target_desc}"
                    _latest_obs = f"APPROACHING: {target_desc}"

                def _get_frame():
                    with _frame_lock:
                        return _latest_frame_bytes

                def _dispatch_skill(skill, inputs):
                    global _latest_task, _latest_obs
                    servo_task = {
                        "type": skill,
                        "inputs": inputs,
                        "primitive_id": str(uuid.uuid4()),
                    }
                    with _obs_lock:
                        _latest_task = servo_task
                        _latest_obs = f"SERVO: {skill}({json.dumps(inputs)})"
                    log.info("SERVO DISPATCH: %s(%s) id=%s",
                             skill, json.dumps(inputs), servo_task["primitive_id"])
                    # Wait for the WS handler to consume and dispatch
                    time.sleep(0.5)

                def _wait_complete():
                    _action_complete_event.clear()
                    completed = _action_complete_event.wait(timeout=8.0)
                    if not completed:
                        log.warning("SERVO: action timed out (8s)")

                def _wait_fresh():
                    with _frame_lock:
                        c = _frame_counter
                    deadline_f = time.time() + 2.0
                    while time.time() < deadline_f:
                        with _frame_lock:
                            if _frame_counter > c + 1:
                                break
                        time.sleep(0.1)

                result = _servo.approach(
                    get_frame_fn=_get_frame,
                    dispatch_fn=_dispatch_skill,
                    wait_complete_fn=_wait_complete,
                    wait_fresh_fn=_wait_fresh,
                    target=target_desc,
                    timeout_s=45.0,
                )
                _last_action_description = f"approach_target('{target_desc}') -> {result}"
                with _events_lock:
                    _recent_events.append(f"[servo] approach '{target_desc}': {result}")
                with _obs_lock:
                    _latest_chat_reply = f"approach_target('{target_desc}') result: {result}"
                log.info("SERVO DONE: %s", result)
                _emit_brain_event("servo_done", {
                    "target": target_desc,
                    "result": result,
                })

            else:
                # Regular skill dispatch — wait for completion
                with _worker_lock:
                    _worker_state = WorkerState.WAIT_COMPLETE
                _action_complete_event.clear()

                log.info("STATE: waiting for action to complete...")
                completed = _action_complete_event.wait(timeout=30.0)
                if not completed:
                    log.warning("ACTION TIMEOUT — no completion after 30s, resuming")
                    with _events_lock:
                        _recent_events.append(f"[timeout] {_last_action_description}")

            # ── WAIT_FRESH: let 1-2 new frames arrive ───────────────
            with _worker_lock:
                _worker_state = WorkerState.WAIT_FRESH
            log.info("STATE: waiting for fresh frame...")

            with _frame_lock:
                counter_before = _frame_counter
            deadline = time.time() + 2.0
            while time.time() < deadline:
                with _frame_lock:
                    if _frame_counter > counter_before + 1:
                        break
                time.sleep(0.1)

            log.info("STATE: fresh frame acquired, back to OBSERVE")
        else:
            # No action dispatched (none or wait_and_look).
            # Still wait briefly for a fresh frame to avoid re-deciding
            # on the same visual input.
            time.sleep(1.0)

      except Exception as exc:
        log.exception("WORKER CRASH: %s — restarting loop", exc)
        time.sleep(2.0)


_servo = None

def _start_vlm():
    global _servo
    _load_model()
    # Load YOLO-World for visual servoing
    from visual_servo import VisualServo
    _servo = VisualServo()
    _servo.load()
    t_worker = threading.Thread(target=_inference_worker, daemon=True)
    t_worker.start()


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

_all_sessions: set["RobotSession"] = set()


class RobotSession:
    def __init__(self, ws: WebSocketServerProtocol):
        self.ws = ws
        self.directive: str | None = None
        self.primitives: list[dict] = []
        self.frames_seen: int = 0
        self.authed: bool = False

    async def send(self, msg_type: str, payload: dict) -> None:
        body = json.dumps({"type": msg_type, "payload": payload})
        await self.ws.send(body)


async def _broadcast(msg_type: str, payload: dict) -> None:
    """Send a message to ALL connected sessions (robot + orchestrator)."""
    body = json.dumps({"type": msg_type, "payload": payload})
    dead = []
    for s in _all_sessions:
        try:
            await s.ws.send(body)
        except Exception:
            dead.append(s)
    for s in dead:
        _all_sessions.discard(s)


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

async def handle_auth(session: RobotSession, payload: dict) -> None:
    session.authed = True
    log.info("AUTH ok (token=%s... version=%s)",
             (payload.get("token") or "")[:6],
             payload.get("client_version"))
    await session.send(OUT_READY_FOR_IMAGE, {})


async def handle_register(session: RobotSession, payload: dict) -> None:
    global _directive
    prims = payload.get("primitives") or payload.get("skills") or []
    directive = payload.get("directive")
    session.primitives = prims if isinstance(prims, list) else []
    log.info("REGISTER %d primitives", len(session.primitives))
    for i, p in enumerate(session.primitives):
        if isinstance(p, dict):
            log.info("  [%d] %s", i, p.get("name") or p.get("id") or "?")
    if directive:
        _directive = directive
        log.info("DIRECTIVE: %s", directive[:300].replace("\n", " | "))
    await session.send(OUT_REGISTERED, {"success": True})
    await session.send(OUT_READY_FOR_IMAGE, {})


async def handle_pose_image(session: RobotSession, payload: dict) -> None:
    global _latest_frame_bytes, _latest_task, _latest_chat_reply, _frame_counter

    session.frames_seen += 1

    img_b64 = payload.get("image") or payload.get("image_b64") or ""
    if isinstance(img_b64, str) and img_b64:
        try:
            raw = base64.b64decode(img_b64)
            with open("/tmp/mars_last_frame.jpg", "wb") as f:
                f.write(raw)
            with _frame_lock:
                _latest_frame_bytes = raw
                _frame_counter += 1
            _frame_event.set()
        except Exception as exc:
            log.warning("frame decode failed: %s", exc)

    # Read and consume Qwen's output
    with _obs_lock:
        obs = _latest_obs
        task = _latest_task
        chat_reply = _latest_chat_reply
        obs_age = time.time() - _latest_obs_time if _latest_obs_time else -1
        if task is not None:
            _latest_task = None
        if chat_reply is not None:
            _latest_chat_reply = None

    next_task = None
    if task is not None:
        next_task = task

    if chat_reply:
        await session.send(OUT_CHAT_OUT, {"message": chat_reply})

    with _worker_lock:
        state = _worker_state.value

    thoughts = f"frame #{session.frames_seen} | inf #{_inference_count} | state={state}"
    if next_task:
        thoughts += f" | DISPATCH {next_task['type']}"

    vao = {
        "stop_current_task": False,
        "observation": obs,
        "thoughts": thoughts,
        "new_goal": None,
        "next_task": next_task,
        "anticipation": None,
        "to_tell_user": chat_reply or (obs if next_task else None),
    }
    await session.send(OUT_VISION_AGENT_OUTPUT, vao)
    await session.send(OUT_READY_FOR_IMAGE, {})

    if session.frames_seen % 20 == 0:
        log.info("frame=%d state=%s obs_age=%.1fs",
                 session.frames_seen, state, obs_age)


async def handle_primitive_event(
    session: RobotSession, kind: str, payload: dict
) -> None:
    pid = payload.get("primitive_id", "?")
    name = payload.get("type", payload.get("name", "?"))
    # feedback events use "feedback" key, result events use "message" key
    msg = payload.get("feedback") or payload.get("message") or ""
    if msg:
        log.info("PRIMITIVE %s  skill=%s  id=%s  msg=%s", kind, name, pid, msg[:120])
    else:
        log.info("PRIMITIVE %s  skill=%s  id=%s", kind, name, pid)

    if kind in (IN_PRIMITIVE_COMPLETED, IN_PRIMITIVE_FAILED, IN_PRIMITIVE_INTERRUPTED):
        global _approach_consecutive_fails
        status = {
            IN_PRIMITIVE_COMPLETED: "completed",
            IN_PRIMITIVE_FAILED: "failed",
            IN_PRIMITIVE_INTERRUPTED: "interrupted",
        }[kind]
        with _events_lock:
            _recent_events.append(f"[{status}] {_last_action_description}")

        # Track approach_target consecutive failures and completed targets
        if "approach_target" in _last_action_description:
            if kind == IN_PRIMITIVE_COMPLETED:
                _approach_consecutive_fails = 0
                # Extract target from last action description and mark as reached
                # Format: "approach_target(target=bottle)"
                import re as _re
                m = _re.search(r'target=(\S+)', _last_action_description)
                if m:
                    reached = m.group(1).rstrip(')')
                    _approach_completed_targets.add(reached)
                    log.info("APPROACH REACHED: '%s' — will block re-dispatch for same target", reached)
            else:
                _approach_consecutive_fails += 1
                log.info("APPROACH FAIL #%d", _approach_consecutive_fails)
        else:
            # Any non-approach action resets the counter
            _approach_consecutive_fails = 0

        _action_complete_event.set()
        log.info("ACTION %s — signaling worker", status.upper())
        await _broadcast("brain_event", {
            "event": f"skill_{status}",
            "data": {"skill": _last_action_description, "status": status},
            "timestamp": time.time(),
        })


async def handle_chat(session: RobotSession, payload: dict) -> None:
    global _current_goal
    text = payload.get("text") or payload.get("message") or ""
    log.info("CHAT_IN: %s", text)
    _oneshot_skills_used.clear()  # new goal = fresh one-shot allowance
    _approach_completed_targets.clear()  # new goal = can re-approach same targets
    with _goal_lock:
        _current_goal = text
    with _events_lock:
        _recent_events.append(f"[user] new goal: {text}")
    log.info("GOAL SET: %s", text)
    await session.send(OUT_CHAT_OUT, {"message": f"Goal set: {text}. Working on it..."})
    await _broadcast("brain_event", {
        "event": "goal_set",
        "data": {"goal": text},
        "timestamp": time.time(),
    })


async def handle_message(session: RobotSession, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return

    t = msg.get("type")
    payload = msg.get("payload") or {}

    if t not in (IN_POSE_IMAGE, IN_IMAGE, IN_CUSTOM_INPUT):
        log.info("-> %s", t)

    if t == IN_AUTH:
        await handle_auth(session, payload)
    elif t == IN_REGISTER:
        await handle_register(session, payload)
    elif t in (IN_POSE_IMAGE, IN_IMAGE):
        await handle_pose_image(session, payload)
    elif t in (IN_PRIMITIVE_ACTIVATED, IN_PRIMITIVE_COMPLETED,
               IN_PRIMITIVE_INTERRUPTED, IN_PRIMITIVE_FAILED,
               IN_PRIMITIVE_FEEDBACK):
        await handle_primitive_event(session, t, payload)
    elif t == IN_CHAT_IN:
        await handle_chat(session, payload)
    elif t == IN_DIRECTIVE:
        global _directive
        _directive = payload.get("directive") or DEFAULT_DIRECTIVE
        log.info("DIRECTIVE updated: %s", _directive[:200])
    elif t == IN_CUSTOM_INPUT:
        pass
    elif t == IN_RESET:
        global _current_goal, _worker_state
        global _latest_obs, _latest_task, _latest_chat_reply
        global _last_action_description, _approach_consecutive_fails
        session.frames_seen = 0
        session.directive = None
        # Clear all persistent state so Qwen starts fresh
        with _goal_lock:
            _current_goal = None
        with _events_lock:
            _recent_events.clear()
        with _obs_lock:
            _latest_obs = "reset — waiting for first frame"
            _latest_task = None
            _latest_chat_reply = None
        with _worker_lock:
            _worker_state = WorkerState.OBSERVE
        _action_complete_event.clear()
        _last_action_description = "none (just reset)"
        _approach_consecutive_fails = 0
        _oneshot_skills_used.clear()
        _approach_completed_targets.clear()
        _directive = DEFAULT_DIRECTIVE
        log.info("RESET — all state cleared")


async def connection(ws: WebSocketServerProtocol) -> None:
    peer = f"{ws.remote_address[0]}:{ws.remote_address[1]}"
    log.info("+ client connected from %s", peer)
    session = RobotSession(ws)
    _all_sessions.add(session)
    try:
        async for raw in ws:
            await handle_message(session, raw)
    except websockets.ConnectionClosed as exc:
        log.info("- client %s disconnected (%s)", peer, exc.code)
    except Exception as exc:
        log.exception("handler crashed: %s", exc)
    finally:
        _all_sessions.discard(session)
        log.info("  session: frames=%d", session.frames_seen)


async def main(host: str = "0.0.0.0", port: int = 8765) -> None:
    global _event_loop
    _event_loop = asyncio.get_running_loop()
    log.info("starting VLM (sync load) ...")
    _start_vlm()
    log.info("local-brain on ws://%s:%d", host, port)
    async with websockets.serve(
        connection, host, port, max_size=20_000_000,
        ping_interval=30, ping_timeout=60,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
