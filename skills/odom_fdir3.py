"""odom_fdir3 — odometry FDIR with Pixhawk IMU as third source.

Three independent motion sources:
  1. /odom          — wheel encoder dead-reckoning (the suspect)
  2. /amcl_pose     — lidar scan-matching against saved map
  3. Pixhawk IMU    — SCALED_IMU via pymavlink (body-frame forward acceleration)

FAULT conditions:
  - odom_delta >> amcl_delta  (lidar says robot didn't move)
  - odom_delta > threshold but IMU peak forward accel near zero
    (Pixhawk felt no physical motion despite encoders spinning)

Demo: run skill, lift rear wheels. Encoders report ~1m; AMCL stays flat;
Pixhawk feels nothing. All three contradict each other = wheel_slip_fault.
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

from std_msgs.msg import String
from brain_client.skill_types import Skill, SkillResult

ROSBRIDGE       = 'ws://localhost:9090'
DRIVE_SPEED     = 0.2    # m/s forward
DRIVE_SECS      = 5.0    # seconds → ~1 m
SETTLE_SECS     = 1.5    # pause after stopping
SLIP_RATIO      = 0.50   # fault if amcl_delta < odom_delta * this
MIN_ODOM_DELTA  = 0.15   # metres

# Pixhawk serial — try ACM0 first (USB), fallback to ttyUSB0
PIXHAWK_PORTS   = ['/dev/ttyACM2', '/dev/ttyACM1', '/dev/ttyACM0', '/dev/ttyUSB0']
PIXHAWK_BAUD    = 115200

# SCALED_IMU xacc is in milli-g. 1g = 9810 mg.
# A robot accelerating at even 0.1 m/s² ≈ 10 mg body-frame.
# "No motion" threshold: peak xacc < 50 mg after gravity subtraction.
IMU_MOTION_THRESH_MG = 60   # mg — peak forward accel must exceed this


def _fix_json(raw: str) -> str:
    raw = raw.replace('[,', '[null,')
    raw = re.sub(r',(?=[,\]])', ',null', raw)
    return raw


def _get_pos(msg: dict) -> tuple[float, float] | None:
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
    """Reads SCALED_IMU + ATTITUDE from Pixhawk in a background thread."""

    def __init__(self, logger):
        self.logger = logger
        self.xacc_samples: list[float] = []   # milli-g, body frame
        self.pitch_deg: float = 0.0
        self._running = False
        self._thread: threading.Thread | None = None
        self._conn = None
        self.connected = False

    def connect(self) -> bool:
        if not HAS_MAVLINK:
            self.logger.warn('pymavlink not installed — IMU source unavailable')
            return False
        for port in PIXHAWK_PORTS:
            try:
                conn = mavutil.mavlink_connection(port, baud=PIXHAWK_BAUD)
                conn.wait_heartbeat(timeout=3)
                # request SCALED_IMU @ 20 Hz and ATTITUDE @ 10 Hz
                conn.mav.request_data_stream_send(
                    conn.target_system, conn.target_component,
                    mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS, 20, 1)
                conn.mav.request_data_stream_send(
                    conn.target_system, conn.target_component,
                    mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 10, 1)
                self._conn = conn
                self.connected = True
                self.logger.info(f'Pixhawk connected on {port}')
                return True
            except Exception as e:
                self.logger.warn(f'Pixhawk not on {port}: {e}')
        return False

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)

    def _read_loop(self) -> None:
        if not self._conn:
            return
        while self._running:
            try:
                msg = self._conn.recv_match(
                    type=['SCALED_IMU2', 'SCALED_IMU', 'ATTITUDE'],
                    blocking=True, timeout=0.1)
                if msg is None:
                    continue
                mtype = msg.get_type()
                if mtype in ('SCALED_IMU2', 'SCALED_IMU'):
                    # xacc in milli-g, body frame forward
                    self.xacc_samples.append(float(msg.xacc))
                elif mtype == 'ATTITUDE':
                    self.pitch_deg = math.degrees(msg.pitch)
            except Exception:
                pass

    def peak_forward_accel(self) -> float | None:
        """Peak |xacc| corrected for static gravity component due to pitch."""
        if not self.xacc_samples:
            return None
        # gravity component in X = -sin(pitch) * 1000 mg (1g = 1000 mg)
        gravity_x_mg = -math.sin(math.radians(self.pitch_deg)) * 1000.0
        corrected = [abs(a - gravity_x_mg) for a in self.xacc_samples]
        return max(corrected)


class OdomFdir3(Skill):

    def __init__(self, logger):
        self.logger = logger
        self._tts_pub = None

    def _speak(self, text: str) -> None:
        if self._tts_pub is None:
            self._tts_pub = self.node.create_publisher(String, '/brain/tts', 10)
            time.sleep(0.1)
        self._tts_pub.publish(String(data=text))

    @property
    def name(self) -> str:
        return 'odom_fdir3'

    def guidelines(self) -> str:
        return (
            'FDIR odometry cross-validation using wheel encoders, lidar AMCL, '
            'and Pixhawk IMU (pymavlink). Drives robot ~1 m forward then compares '
            'all three sources. Detects wheel slip for demo: lift rear wheels during run.'
        )

    def execute(self) -> tuple[str, SkillResult]:
        self._speak('Starting odometry fault check.')

        # --- IMU setup ---
        imu = ImuReader(self.logger)
        imu_available = imu.connect()
        if imu_available:
            imu.start()
        else:
            self.logger.warn('Running without IMU — odom vs AMCL only')

        odom_msgs: list[dict] = []
        amcl_msgs: list[dict] = []

        try:
            ws = websocket.WebSocket()
            ws.connect(ROSBRIDGE, timeout=5)

            for i, (topic, mtype) in enumerate([
                ('/odom',      'nav_msgs/msg/Odometry'),
                ('/amcl_pose', 'geometry_msgs/msg/PoseWithCovarianceStamped'),
            ]):
                ws.send(json.dumps({
                    'op': 'subscribe', 'id': f'fdir_{i}',
                    'topic': topic, 'type': mtype,
                    'throttle_rate': 100,
                }))

            ws.settimeout(0.1)

            def drain(duration: float) -> None:
                t_end = time.monotonic() + duration
                while time.monotonic() < t_end:
                    try:
                        msg = json.loads(_fix_json(ws.recv()))
                        if msg.get('op') != 'publish':
                            continue
                        d, t = msg.get('msg', {}), msg.get('topic')
                        if t == '/odom':        odom_msgs.append(d)
                        elif t == '/amcl_pose': amcl_msgs.append(d)
                    except Exception:
                        pass

            # baseline
            drain(1.0)
            odom_start = _get_pos(odom_msgs[-1]) if odom_msgs else None
            amcl_start = _get_pos(amcl_msgs[-1]) if amcl_msgs else None

            if odom_start is None:
                ws.close()
                return json.dumps({'verdict': 'error', 'message': 'No /odom data'}), SkillResult.FAILURE

            self.logger.info(f'Baseline: odom={odom_start}  amcl={amcl_start}')
            self._speak('Moving forward. Lift wheels now to trigger fault.')

            # clear IMU samples — only count motion during the drive
            imu.xacc_samples.clear()

            # drive forward
            t_end = time.monotonic() + DRIVE_SECS
            while time.monotonic() < t_end:
                _cmd_vel(ws, DRIVE_SPEED)
                drain(0.1)

            # stop
            _cmd_vel(ws, 0.0)
            drain(SETTLE_SECS)

            odom_end = _get_pos(odom_msgs[-1]) if odom_msgs else None
            amcl_end = _get_pos(amcl_msgs[-1]) if amcl_msgs else None
            ws.close()

        except Exception as e:
            self.logger.error(f'rosbridge: {e}')
            imu.stop()
            return json.dumps({'verdict': 'error', 'message': str(e)}), SkillResult.FAILURE

        imu.stop()

        # --- compute ---
        if odom_end is None:
            return json.dumps({'verdict': 'error', 'message': 'Lost /odom'}), SkillResult.FAILURE

        odom_delta = math.hypot(odom_end[0] - odom_start[0], odom_end[1] - odom_start[1])
        amcl_delta = math.hypot(amcl_end[0] - amcl_start[0], amcl_end[1] - amcl_start[1]) \
                     if (amcl_end and amcl_start) else None
        imu_peak   = imu.peak_forward_accel()  # mg, or None if unavailable

        # --- verdict ---
        faults = []
        if odom_delta >= MIN_ODOM_DELTA:
            if amcl_delta is not None and amcl_delta < odom_delta * SLIP_RATIO:
                faults.append(
                    f'AMCL {amcl_delta:.3f}m << odom {odom_delta:.3f}m '
                    f'(ratio {amcl_delta/odom_delta:.2f})'
                )
            if imu_peak is not None and imu_peak < IMU_MOTION_THRESH_MG:
                faults.append(
                    f'IMU peak accel {imu_peak:.1f} mg — no physical motion detected '
                    f'(threshold {IMU_MOTION_THRESH_MG} mg)'
                )

        verdict = 'wheel_slip_fault' if faults else 'nominal'
        message = ' | '.join(faults) if faults else 'All sources agree — nominal.'

        result = {
            'verdict':        verdict,
            'message':        message,
            'odom_delta_m':   round(odom_delta, 4),
            'amcl_delta_m':   round(amcl_delta, 4) if amcl_delta is not None else None,
            'imu_peak_mg':    round(imu_peak, 1) if imu_peak is not None else None,
            'imu_samples':    len(imu.xacc_samples),
            'imu_available':  imu_available,
            'faults':         faults,
        }

        self.logger.info(f'odom_fdir3:\n{json.dumps(result, indent=2)}')
        self._speak('Fault detected. Wheel slip confirmed.' if faults else 'Odometry nominal.')
        return json.dumps(result, indent=2), SkillResult.FAILURE if faults else SkillResult.SUCCESS

    def cancel(self) -> str:
        try:
            ws = websocket.WebSocket()
            ws.connect(ROSBRIDGE, timeout=2)
            _cmd_vel(ws, 0.0)
            ws.close()
        except Exception:
            pass
        return 'odom_fdir3 cancelled'
