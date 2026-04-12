"""odom_fdir — odometry fault detection via multi-source cross-validation.

Drives the robot forward at 0.2 m/s for 5 seconds (~1 m), then stops.
Simultaneously records /odom and /amcl_pose displacement.

FAULT if wheel encoders report significant travel but AMCL (lidar
scan-matching) shows the robot barely moved — i.e. wheels slipped.

Demo: lift rear wheels while skill runs. Encoders spin, AMCL stays flat.
"""

import json
import math
import re
import time

import websocket

from std_msgs.msg import String
from brain_client.skill_types import Skill, SkillResult

ROSBRIDGE      = 'ws://localhost:9090'
DRIVE_SPEED    = 0.2    # m/s forward
DRIVE_SECS     = 5.0    # seconds → ~1 m
SETTLE_SECS    = 1.5    # pause after stopping before reading final position
SLIP_RATIO     = 0.50   # fault if amcl_delta < odom_delta * this
MIN_ODOM_DELTA = 0.15   # ignore trivially small moves (metres)


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


class OdomFdir(Skill):

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
        return 'odom_fdir2'

    def guidelines(self) -> str:
        return (
            'FDIR odometry cross-validation. Drives robot forward ~1 m then '
            'compares wheel-encoder displacement (odom) against lidar AMCL. '
            'Detects wheel slip: encoders report motion but robot did not move. '
            'Demo: lift rear wheels while skill runs.'
        )

    def execute(self) -> tuple[str, SkillResult]:
        self._speak('Starting odometry fault check.')

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

            # drive forward
            t_end = time.monotonic() + DRIVE_SECS
            while time.monotonic() < t_end:
                _cmd_vel(ws, DRIVE_SPEED)
                drain(0.1)

            # stop
            _cmd_vel(ws, 0.0)
            self.logger.info('Stopped. Settling…')
            drain(SETTLE_SECS)

            odom_end = _get_pos(odom_msgs[-1]) if odom_msgs else None
            amcl_end = _get_pos(amcl_msgs[-1]) if amcl_msgs else None
            ws.close()

        except Exception as e:
            self.logger.error(f'rosbridge: {e}')
            return json.dumps({'verdict': 'error', 'message': str(e)}), SkillResult.FAILURE

        # compute displacements
        if odom_end is None:
            return json.dumps({'verdict': 'error', 'message': 'Lost /odom'}), SkillResult.FAILURE

        odom_delta = math.hypot(odom_end[0] - odom_start[0], odom_end[1] - odom_start[1])
        amcl_delta = math.hypot(amcl_end[0] - amcl_start[0], amcl_end[1] - amcl_start[1]) \
                     if (amcl_end and amcl_start) else None

        faults = []
        if odom_delta >= MIN_ODOM_DELTA:
            if amcl_delta is not None and amcl_delta < odom_delta * SLIP_RATIO:
                faults.append(
                    f'AMCL {amcl_delta:.3f}m << odom {odom_delta:.3f}m '
                    f'(ratio {amcl_delta/odom_delta:.2f})'
                )

        verdict = 'wheel_slip_fault' if faults else 'nominal'
        message = ' | '.join(faults) if faults else 'Odometry sources agree — nominal.'

        result = {
            'verdict':      verdict,
            'message':      message,
            'odom_delta_m': round(odom_delta, 4),
            'amcl_delta_m': round(amcl_delta, 4) if amcl_delta is not None else None,
            'faults':       faults,
        }

        self.logger.info(f'odom_fdir:\n{json.dumps(result, indent=2)}')
        self._speak('Fault detected. Wheel slip confirmed.' if faults else 'Odometry nominal.')
        return json.dumps(result, indent=2), SkillResult.FAILURE if faults else SkillResult.SUCCESS

    def cancel(self) -> str:
        # stop the robot if cancelled mid-run
        try:
            ws = websocket.WebSocket()
            ws.connect(ROSBRIDGE, timeout=2)
            _cmd_vel(ws, 0.0)
            ws.close()
        except Exception:
            pass
        return 'odom_fdir cancelled'
