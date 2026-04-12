"""encoder_imu_odometry_check — cross-validates wheel encoders vs Pixhawk IMU.

Drives the robot forward for 4 seconds while simultaneously reading:
  1. /odom  — wheel encoder dead-reckoning (what the robot *thinks* it moved)
  2. Pixhawk IMU — physical acceleration (what actually happened)

FAULT condition:
  - Encoders report displacement > MIN_ODOM_DELTA
  - AND IMU sees no physical motion on 2+ axes (peak < threshold)
  → Robot is STUCK: wheels spinning but body not moving.

Demo usage: physically block the robot or hold it in place, then run this skill.
"""

import json
import math
import re
import threading
import time

import websocket

try:
    from pymavlink import mavutil
    HAS_MAVLINK = True
except ImportError:
    HAS_MAVLINK = False

from brain_client.skill_types import Skill, SkillResult

ROSBRIDGE        = 'ws://localhost:9090'
DRIVE_SPEED      = 0.2   # m/s
DRIVE_SECS       = 4.0   # seconds
SETTLE_SECS      = 1.0

PIXHAWK_PORTS    = ['/dev/ttyACM2', '/dev/ttyACM1', '/dev/ttyACM0', '/dev/ttyUSB0']
PIXHAWK_BAUD     = 115200
G_MG             = 1000.0

MIN_ODOM_DELTA   = 0.10   # metres — encoders must report at least this to call a fault
IMU_THRESH_MG    = 150    # mg — peak accel per axis (gravity-subtracted)
IMU_STUCK_AXES   = 2      # number of static axes required to declare stuck


def _fix_json(raw: str) -> str:
    raw = raw.replace('[,', '[null,')
    raw = re.sub(r',(?=[,\]])', ',null', raw)
    return raw


def _get_odom_pos(msg: dict) -> tuple[float, float] | None:
    try:
        p = msg['pose']['pose']['position']
        return float(p['x']), float(p['y'])
    except Exception:
        return None


def _cmd_vel(ws: websocket.WebSocket, linear_x: float) -> None:
    ws.send(json.dumps({
        'op': 'publish',
        'topic': '/cmd_vel',
        'type': 'geometry_msgs/msg/Twist',
        'msg': {
            'linear':  {'x': linear_x, 'y': 0.0, 'z': 0.0},
            'angular': {'x': 0.0,      'y': 0.0, 'z': 0.0},
        },
    }))


class ImuReader:
    def __init__(self):
        self._data = {'xacc': 0, 'yacc': 0, 'zacc': 0,
                      'pitch': 0.0, 'roll': 0.0}
        self._lock = threading.Lock()
        self._running = False
        self._conn = None
        self.connected = False
        self.peak = {'fwd': 0.0, 'left': 0.0, 'up': 0.0}

    def connect(self) -> bool:
        if not HAS_MAVLINK:
            return False
        for port in PIXHAWK_PORTS:
            try:
                conn = mavutil.mavlink_connection(port, baud=PIXHAWK_BAUD)
                conn.wait_heartbeat(timeout=3)
                conn.mav.request_data_stream_send(
                    conn.target_system, conn.target_component,
                    mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS, 100, 1)
                conn.mav.request_data_stream_send(
                    conn.target_system, conn.target_component,
                    mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 50, 1)
                self._conn = conn
                self.connected = True
                return True
            except Exception:
                pass
        return False

    def start(self):
        self._running = True
        self.peak = {'fwd': 0.0, 'left': 0.0, 'up': 0.0}
        threading.Thread(target=self._read_loop, daemon=True).start()

    def stop(self):
        self._running = False

    def _read_loop(self):
        while self._running and self._conn:
            try:
                msg = self._conn.recv_match(
                    type=['SCALED_IMU2', 'SCALED_IMU', 'ATTITUDE'],
                    blocking=True, timeout=0.1)
                if msg is None:
                    continue
                mtype = msg.get_type()
                with self._lock:
                    if mtype in ('SCALED_IMU2', 'SCALED_IMU'):
                        self._data['xacc'] = int(msg.xacc)
                        self._data['yacc'] = int(msg.yacc)
                        self._data['zacc'] = int(msg.zacc)
                    elif mtype == 'ATTITUDE':
                        self._data['pitch'] = math.degrees(msg.pitch)
                        self._data['roll']  = math.degrees(msg.roll)

                    # track peak gravity-corrected accel in real time
                    d = self._data
                    pitch_r = math.radians(d['pitch'])
                    roll_r  = math.radians(d['roll'])
                    grav_fwd  = -math.sin(pitch_r) * G_MG
                    grav_left =  math.sin(roll_r)  * G_MG
                    grav_up   = -math.cos(pitch_r) * math.cos(roll_r) * G_MG
                    ax = abs(d['yacc'] - grav_fwd)
                    ay = abs(d['zacc'] - grav_left)
                    az = abs(d['xacc'] - grav_up)
                    self.peak['fwd']  = max(self.peak['fwd'],  ax)
                    self.peak['left'] = max(self.peak['left'], ay)
                    self.peak['up']   = max(self.peak['up'],   az)
            except Exception:
                pass


class EncoderImuOdometryCheck(Skill):

    def __init__(self, logger):
        self.logger = logger

    @property
    def name(self) -> str:
        return 'encoder_imu_odometry_check'

    def guidelines(self) -> str:
        return (
            'Cross-validates wheel encoders against Pixhawk IMU to detect a stuck robot. '
            f'Drives forward at {DRIVE_SPEED} m/s for {DRIVE_SECS}s. '
            'If encoders report movement but IMU detects no physical motion → STUCK fault. '
            'Use this during demo: physically block the robot before running.'
        )

    def execute(self) -> tuple[str, SkillResult]:
        # connect IMU
        imu = ImuReader()
        imu_available = imu.connect()
        if not imu_available:
            self.logger.warn('Pixhawk not found — cannot run encoder/IMU check')
            return json.dumps({'verdict': 'error', 'message': 'Pixhawk not found'}), SkillResult.FAILURE

        odom_msgs: list[dict] = []

        try:
            ws = websocket.WebSocket()
            ws.connect(ROSBRIDGE, timeout=5)

            ws.send(json.dumps({
                'op': 'subscribe', 'id': 'enc_imu_odom',
                'topic': '/odom', 'type': 'nav_msgs/msg/Odometry',
                'throttle_rate': 100,
            }))
            ws.settimeout(0.1)

            def drain(duration: float) -> None:
                t_end = time.monotonic() + duration
                while time.monotonic() < t_end:
                    try:
                        msg = json.loads(_fix_json(ws.recv()))
                        if msg.get('op') == 'publish' and msg.get('topic') == '/odom':
                            odom_msgs.append(msg.get('msg', {}))
                    except Exception:
                        pass

            # baseline
            drain(0.5)
            odom_start = _get_odom_pos(odom_msgs[-1]) if odom_msgs else None
            if odom_start is None:
                ws.close()
                imu.stop()
                return json.dumps({'verdict': 'error', 'message': 'No /odom data'}), SkillResult.FAILURE

            self.logger.info(f'Baseline odom: {odom_start}')

            # start IMU collection, then drive
            imu.start()
            t_end = time.monotonic() + DRIVE_SECS
            while time.monotonic() < t_end:
                _cmd_vel(ws, DRIVE_SPEED)
                drain(0.1)

            # stop
            _cmd_vel(ws, 0.0)
            drain(SETTLE_SECS)

            odom_end = _get_odom_pos(odom_msgs[-1]) if odom_msgs else None
            ws.close()

        except Exception as e:
            self.logger.error(f'rosbridge error: {e}')
            imu.stop()
            return json.dumps({'verdict': 'error', 'message': str(e)}), SkillResult.FAILURE

        imu.stop()

        if odom_end is None:
            return json.dumps({'verdict': 'error', 'message': 'Lost /odom during check'}), SkillResult.FAILURE

        odom_delta = math.hypot(odom_end[0] - odom_start[0], odom_end[1] - odom_start[1])
        peak = imu.peak

        # how many axes saw no physical motion
        static_axes  = [k for k, v in peak.items() if v <= IMU_THRESH_MG]
        moving_axes  = [k for k, v in peak.items() if v >  IMU_THRESH_MG]
        imu_no_motion = len(static_axes) >= IMU_STUCK_AXES

        # fault: encoders say it moved, but IMU says it didn't
        is_stuck = odom_delta >= MIN_ODOM_DELTA and imu_no_motion

        if is_stuck:
            verdict = 'stuck'
            message = (
                f'STUCK DETECTED — encoders reported {odom_delta:.3f}m displacement '
                f'but IMU shows no physical motion on {len(static_axes)}/3 axes '
                f'(peak fwd={peak["fwd"]:.1f}mg left={peak["left"]:.1f}mg up={peak["up"]:.1f}mg, '
                f'threshold={IMU_THRESH_MG}mg)'
            )
        elif not imu_no_motion and odom_delta >= MIN_ODOM_DELTA:
            verdict = 'moving'
            message = f'Robot moved normally — odom: {odom_delta:.3f}m, IMU confirms motion on {len(moving_axes)}/3 axes'
        elif odom_delta < MIN_ODOM_DELTA:
            verdict = 'no_encoder_movement'
            message = f'Encoders reported minimal movement ({odom_delta:.3f}m < {MIN_ODOM_DELTA}m threshold)'
        else:
            verdict = 'nominal'
            message = 'All sources agree'

        result = {
            'verdict':         verdict,
            'message':         message,
            'odom_delta_m':    round(odom_delta, 4),
            'imu_peak_fwd_mg': round(peak['fwd'],  1),
            'imu_peak_left_mg':round(peak['left'], 1),
            'imu_peak_up_mg':  round(peak['up'],   1),
            'imu_threshold_mg':IMU_THRESH_MG,
            'static_axes':     static_axes,
            'moving_axes':     moving_axes,
            'imu_available':   imu_available,
        }

        self.logger.info(f'encoder_imu_odometry_check:\n{json.dumps(result, indent=2)}')
        return json.dumps(result, indent=2), SkillResult.FAILURE if is_stuck else SkillResult.SUCCESS

    def cancel(self) -> str:
        try:
            ws = websocket.WebSocket()
            ws.connect(ROSBRIDGE, timeout=2)
            _cmd_vel(ws, 0.0)
            ws.close()
        except Exception:
            pass
        return 'encoder_imu_odometry_check cancelled'
