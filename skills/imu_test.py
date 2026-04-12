#!/usr/bin/env python3
"""imu_test.py — live IMU acceleration display + press 'g' to run 5s integration test.

Shows live xacc/yacc/zacc. Press 'g' to start a 5-second window that
integrates acceleration → velocity → displacement, then prints result.

Run: python3 ~/skills/imu_test.py
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


MOTION_THRESH_MG = 80   # mg — peak forward accel must exceed this to count as motion

def run_check():
    """Collect 5 seconds of IMU data and check for physical motion."""
    print('\n\033[93m▶ MOTION CHECK — 5 seconds (lift wheels or drive normally)...\033[0m\n')

    # collect baseline (static noise floor) for 0.5s first
    baseline_samples = []
    t_end = time.monotonic() + 0.5
    while time.monotonic() < t_end:
        time.sleep(0.01)
        with lock:
            pitch_r = math.radians(latest['pitch'])
            roll_r  = math.radians(latest['roll'])
            xacc = latest['xacc']
            yacc = latest['yacc']
        grav_x = -math.sin(pitch_r) * G_MG
        ax_body_mg = xacc - grav_x
        baseline_samples.append(abs(ax_body_mg))
    noise_floor = sum(baseline_samples) / len(baseline_samples) if baseline_samples else 0

    # now collect motion window
    peak_mg = 0.0
    samples = []
    t_end = time.monotonic() + 5.0
    while time.monotonic() < t_end:
        time.sleep(0.01)
        with lock:
            xacc = latest['xacc']
            yacc = latest['yacc']
            zacc = latest['zacc']
            pitch_r = math.radians(latest['pitch'])
            roll_r  = math.radians(latest['roll'])

        grav_x = -math.sin(pitch_r) * G_MG
        ax_body_mg = xacc - grav_x
        peak_mg = max(peak_mg, abs(ax_body_mg))
        samples.append(abs(ax_body_mg))

        remaining = t_end - time.monotonic()
        bar_len = int(min(abs(ax_body_mg) / 500 * 30, 30))
        bar = '█' * bar_len
        flag = ' ⚡MOTION' if abs(ax_body_mg) > MOTION_THRESH_MG else ''
        print(f'\r  t-{remaining:.1f}s  |xacc|={abs(ax_body_mg):6.1f}mg  [{bar:<30}]  peak={peak_mg:.1f}mg{flag}   ',
              end='', flush=True)

    print()

    avg_mg = sum(samples) / len(samples) if samples else 0
    motion_detected = peak_mg > MOTION_THRESH_MG

    print(f'\n\033[96m── MOTION CHECK RESULT ─────────────────────────\033[0m')
    print(f'  samples      : {len(samples)}')
    print(f'  noise floor  : {noise_floor:.1f} mg  (static baseline)')
    print(f'  avg |xacc|   : {avg_mg:.1f} mg')
    print(f'  peak |xacc|  : {peak_mg:.1f} mg')
    print(f'  threshold    : {MOTION_THRESH_MG} mg')
    print(f'\033[96m────────────────────────────────────────────────\033[0m')

    if motion_detected:
        print(f'\033[92m  ✓ PHYSICAL MOTION DETECTED (peak {peak_mg:.1f} mg > {MOTION_THRESH_MG} mg)\033[0m')
    else:
        print(f'\033[91m  ⚠ NO PHYSICAL MOTION (peak {peak_mg:.1f} mg < {MOTION_THRESH_MG} mg)\033[0m')
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

    print('\nLive IMU acceleration (press g to run 5s integration, q to quit)\n')

    old_term = set_raw()
    integrating = False

    try:
        while True:
            # print live accel
            if not integrating:
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

            # check for keypress
            if key_pressed():
                ch = sys.stdin.read(1)
                if ch == 'g' and not integrating:
                    integrating = True
                    restore(old_term)
                    run_integration()
                    old_term = set_raw()
                    integrating = False
                elif ch in ('q', '\x03'):
                    break

            time.sleep(0.05)

    finally:
        restore(old_term)
        print('\nDone.')


if __name__ == '__main__':
    main()
