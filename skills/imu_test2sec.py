#!/usr/bin/env python3
"""imu_test2sec.py — live IMU acceleration display + press 'g' to run 2s motion check.

Shows live xacc/yacc/zacc. Press 'g' to start a 2-second window that
tracks peak acceleration on all 3 axes (X/Y/Z), then prints result.

Run: python3 ~/skills/imu_test2sec.py
"""

import math
import select
import sys
import termios
import threading
import time
import tty

from pymavlink import mavutil

PORT = '/dev/ttyACM2'
BAUD = 115200
G_MG = 1000.0   # 1g in milli-g

MOTION_THRESH_MG = 80   # mg — peak accel must exceed this on any axis to count as motion
CHECK_SECS = 2.0


# ── terminal helpers ─────────────────────────────────────────────────────────

def set_raw():
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    return old

def restore(old):
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)

def key_pressed():
    return select.select([sys.stdin], [], [], 0)[0]


# ── shared state ──────────────────────────────────────────────────────────────

latest = {'xacc': 0, 'yacc': 0, 'zacc': 0,
          'pitch': 0.0, 'roll': 0.0, 'yaw': 0.0}
lock = threading.Lock()


def read_loop(conn):
    while True:
        msg = conn.recv_match(
            type=['SCALED_IMU2', 'SCALED_IMU', 'ATTITUDE'],
            blocking=True, timeout=0.5)
        if msg is None:
            continue
        mtype = msg.get_type()
        with lock:
            if mtype in ('SCALED_IMU2', 'SCALED_IMU'):
                latest['xacc'] = int(msg.xacc)
                latest['yacc'] = int(msg.yacc)
                latest['zacc'] = int(msg.zacc)
            elif mtype == 'ATTITUDE':
                latest['pitch'] = math.degrees(msg.pitch)
                latest['roll']  = math.degrees(msg.roll)
                latest['yaw']   = math.degrees(msg.yaw)


def run_check():
    """Collect 2 seconds of IMU data and check for physical motion on all 3 axes."""
    print(f'\n\033[93m▶ MOTION CHECK — {CHECK_SECS}s (move/jiggle the robot or Pixhawk)...\033[0m\n')

    # collect baseline (static noise floor) for 0.3s first
    baseline = {'x': [], 'y': [], 'z': []}
    t_end = time.monotonic() + 0.3
    while time.monotonic() < t_end:
        time.sleep(0.01)
        with lock:
            pitch_r = math.radians(latest['pitch'])
            roll_r  = math.radians(latest['roll'])
            xacc = latest['xacc']
            yacc = latest['yacc']
            zacc = latest['zacc']
        # subtract static gravity component from each axis
        grav_x = -math.sin(pitch_r) * G_MG
        grav_y =  math.sin(roll_r)  * G_MG
        grav_z = -math.cos(pitch_r) * math.cos(roll_r) * G_MG
        baseline['x'].append(abs(xacc - grav_x))
        baseline['y'].append(abs(yacc - grav_y))
        baseline['z'].append(abs(zacc - grav_z))

    noise = {
        'x': sum(baseline['x']) / len(baseline['x']) if baseline['x'] else 0,
        'y': sum(baseline['y']) / len(baseline['y']) if baseline['y'] else 0,
        'z': sum(baseline['z']) / len(baseline['z']) if baseline['z'] else 0,
    }

    # motion window
    peak = {'x': 0.0, 'y': 0.0, 'z': 0.0}
    t_end = time.monotonic() + CHECK_SECS
    while time.monotonic() < t_end:
        time.sleep(0.01)
        with lock:
            xacc = latest['xacc']
            yacc = latest['yacc']
            zacc = latest['zacc']
            pitch_r = math.radians(latest['pitch'])
            roll_r  = math.radians(latest['roll'])

        grav_x = -math.sin(pitch_r) * G_MG
        grav_y =  math.sin(roll_r)  * G_MG
        grav_z = -math.cos(pitch_r) * math.cos(roll_r) * G_MG

        ax = abs(xacc - grav_x)
        ay = abs(yacc - grav_y)
        az = abs(zacc - grav_z)

        peak['x'] = max(peak['x'], ax)
        peak['y'] = max(peak['y'], ay)
        peak['z'] = max(peak['z'], az)

        remaining = t_end - time.monotonic()

        def bar(val):
            n = int(min(val / 500 * 20, 20))
            return '█' * n + '░' * (20 - n)

        motion_flag = ''
        if ax > MOTION_THRESH_MG or ay > MOTION_THRESH_MG or az > MOTION_THRESH_MG:
            motion_flag = '  \033[92m⚡MOTION\033[0m'

        print(
            f'\r  t-{remaining:.1f}s'
            f'  X={ax:6.1f}mg [{bar(ax)}]'
            f'  Y={ay:6.1f}mg [{bar(ay)}]'
            f'  Z={az:6.1f}mg [{bar(az)}]'
            f'{motion_flag}   ',
            end='', flush=True)

    print()

    axes_detected = {ax: peak[ax] > MOTION_THRESH_MG for ax in ('x', 'y', 'z')}
    any_motion = any(axes_detected.values())

    print(f'\n\033[96m── MOTION CHECK RESULT ({CHECK_SECS}s) ──────────────────────\033[0m')
    print(f'  noise floor  X:{noise["x"]:6.1f}  Y:{noise["y"]:6.1f}  Z:{noise["z"]:6.1f}  mg')
    print(f'  peak accel   X:{peak["x"]:6.1f}  Y:{peak["y"]:6.1f}  Z:{peak["z"]:6.1f}  mg')
    print(f'  threshold    {MOTION_THRESH_MG} mg  (any axis)')
    print(f'\033[96m────────────────────────────────────────────────\033[0m')

    for axis in ('x', 'y', 'z'):
        label = {'x': 'X (fwd)', 'y': 'Y (left)', 'z': 'Z (up)'}[axis]
        if axes_detected[axis]:
            print(f'\033[92m  ✓ {label:<10} MOTION  (peak {peak[axis]:.1f} mg > {MOTION_THRESH_MG} mg)\033[0m')
        else:
            print(f'\033[90m  – {label:<10} static  (peak {peak[axis]:.1f} mg)\033[0m')

    print()
    if any_motion:
        triggered = [ax.upper() for ax in ('x', 'y', 'z') if axes_detected[ax]]
        print(f'\033[92m  ✓ PHYSICAL MOTION DETECTED on axis: {", ".join(triggered)}\033[0m')
    else:
        print(f'\033[91m  ⚠ NO PHYSICAL MOTION (all axes below {MOTION_THRESH_MG} mg)\033[0m')
        print(f'\033[91m    → If encoders reported movement: WHEEL SLIP FAULT\033[0m')
    print()


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    print(f'Connecting to Pixhawk on {PORT}...')
    conn = mavutil.mavlink_connection(PORT, baud=BAUD)
    conn.wait_heartbeat()
    print(f'Heartbeat from system {conn.target_system}')

    conn.mav.request_data_stream_send(
        conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS, 100, 1)
    conn.mav.request_data_stream_send(
        conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 50, 1)

    threading.Thread(target=read_loop, args=(conn,), daemon=True).start()
    time.sleep(0.5)   # let first samples arrive

    print('\nLive IMU acceleration (press g to run 2s motion check, q to quit)\n')

    old_term = set_raw()
    checking = False

    try:
        while True:
            if not checking:
                with lock:
                    x = latest['xacc']
                    y = latest['yacc']
                    z = latest['zacc']
                    p = latest['pitch']
                    r = latest['roll']
                    yw = latest['yaw']
                print(f'\r  xacc={x:+6d}mg  yacc={y:+6d}mg  zacc={z:+6d}mg  '
                      f'pitch={p:+6.1f}°  roll={r:+6.1f}°  yaw={yw:+7.1f}°   ',
                      end='', flush=True)

            if key_pressed():
                ch = sys.stdin.read(1)
                if ch == 'g' and not checking:
                    checking = True
                    restore(old_term)
                    run_check()
                    old_term = set_raw()
                    checking = False
                elif ch in ('q', '\x03'):
                    break

            time.sleep(0.05)

    finally:
        restore(old_term)
        print('\nDone.')


if __name__ == '__main__':
    main()
