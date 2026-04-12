"""movement_check — uses Pixhawk IMU to detect if the robot is physically moving.

Reads 2 seconds of IMU data (all 3 axes, gravity-subtracted).
If 2 or more axes are below the motion threshold → verdict: 'stuck'.
If 2 or more axes exceed the threshold     → verdict: 'moving'.

Axis mapping (physical on this robot):
  yacc → X (forward/back)
  zacc → Y (left/right)
  xacc → Z (up/down, dominated by gravity)
"""

import json
import math
import threading
import time

try:
    from pymavlink import mavutil
    HAS_MAVLINK = True
except ImportError:
    HAS_MAVLINK = False

from brain_client.skill_types import Skill, SkillResult

PIXHAWK_PORTS    = ['/dev/ttyACM2', '/dev/ttyACM1', '/dev/ttyACM0', '/dev/ttyUSB0']
PIXHAWK_BAUD     = 115200
G_MG             = 1000.0
CHECK_SECS       = 2.0
BASELINE_SECS    = 0.3
# Higher threshold so only real motion (not jiggles) triggers — noise floor ~20-40 mg
MOTION_THRESH_MG = 150


class ImuReader:
    def __init__(self):
        self._data = {'xacc': 0, 'yacc': 0, 'zacc': 0,
                      'pitch': 0.0, 'roll': 0.0}
        self._lock = threading.Lock()
        self._running = False
        self._conn = None
        self.connected = False

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
            except Exception:
                pass

    def snapshot(self):
        with self._lock:
            return dict(self._data)


def _gravity_corrected(d: dict) -> tuple[float, float, float]:
    """Return gravity-subtracted absolute accelerations (ax_fwd, ay_left, az_up) in mg."""
    pitch_r = math.radians(d['pitch'])
    roll_r  = math.radians(d['roll'])
    # axis mapping: yacc=fwd, zacc=left, xacc=up
    grav_fwd  = -math.sin(pitch_r) * G_MG
    grav_left =  math.sin(roll_r)  * G_MG
    grav_up   = -math.cos(pitch_r) * math.cos(roll_r) * G_MG
    ax = abs(d['yacc'] - grav_fwd)
    ay = abs(d['zacc'] - grav_left)
    az = abs(d['xacc'] - grav_up)
    return ax, ay, az


class MovementCheck(Skill):

    def __init__(self, logger):
        self.logger = logger

    @property
    def name(self) -> str:
        return 'movement_check'

    def guidelines(self) -> str:
        return (
            'Uses Pixhawk IMU to determine if the robot is physically moving. '
            'Runs a 2-second acceleration check on all 3 axes. '
            'If 2 or more axes show no motion → verdict: stuck. '
            'Useful for detecting when the robot is commanded to move but is physically blocked.'
        )

    def execute(self) -> tuple[str, SkillResult]:
        imu = ImuReader()
        if not imu.connect():
            result = {'verdict': 'error', 'message': 'Pixhawk not found'}
            return json.dumps(result), SkillResult.FAILURE

        imu.start()
        time.sleep(0.3)  # let samples arrive

        # baseline noise floor
        baseline = {'fwd': [], 'left': [], 'up': []}
        t_end = time.monotonic() + BASELINE_SECS
        while time.monotonic() < t_end:
            time.sleep(0.01)
            ax, ay, az = _gravity_corrected(imu.snapshot())
            baseline['fwd'].append(ax)
            baseline['left'].append(ay)
            baseline['up'].append(az)

        noise = {k: sum(v) / len(v) for k, v in baseline.items()}

        # motion window
        peak = {'fwd': 0.0, 'left': 0.0, 'up': 0.0}
        t_end = time.monotonic() + CHECK_SECS
        while time.monotonic() < t_end:
            time.sleep(0.01)
            ax, ay, az = _gravity_corrected(imu.snapshot())
            peak['fwd']  = max(peak['fwd'],  ax)
            peak['left'] = max(peak['left'], ay)
            peak['up']   = max(peak['up'],   az)

        imu.stop()

        moving_axes = [k for k, v in peak.items() if v > MOTION_THRESH_MG]
        static_axes = [k for k, v in peak.items() if v <= MOTION_THRESH_MG]

        # stuck if 2 or more axes show no motion
        is_stuck = len(static_axes) >= 2

        verdict = 'stuck' if is_stuck else 'moving'
        message = (
            f'No motion on {len(static_axes)}/3 axes — robot is STUCK'
            if is_stuck else
            f'Motion detected on {len(moving_axes)}/3 axes — robot is MOVING'
        )

        result = {
            'verdict':        verdict,
            'message':        message,
            'threshold_mg':   MOTION_THRESH_MG,
            'peak_fwd_mg':    round(peak['fwd'],  1),
            'peak_left_mg':   round(peak['left'], 1),
            'peak_up_mg':     round(peak['up'],   1),
            'noise_fwd_mg':   round(noise['fwd'],  1),
            'noise_left_mg':  round(noise['left'], 1),
            'noise_up_mg':    round(noise['up'],   1),
            'moving_axes':    moving_axes,
            'static_axes':    static_axes,
        }

        self.logger.info(f'movement_check:\n{json.dumps(result, indent=2)}')
        return json.dumps(result, indent=2), SkillResult.SUCCESS if is_stuck else SkillResult.SUCCESS

    def cancel(self) -> str:
        return 'movement_check cancelled'
