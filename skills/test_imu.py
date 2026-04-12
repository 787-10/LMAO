#!/usr/bin/env python3
"""Quick test — print Pixhawk IMU data to terminal."""

from pymavlink import mavutil

PORT = '/dev/ttyACM2'
BAUD = 115200

print(f"Connecting to {PORT}...")
conn = mavutil.mavlink_connection(PORT, baud=BAUD)

print("Waiting for heartbeat...")
conn.wait_heartbeat()
print(f"Heartbeat received from system {conn.target_system}")

# Request raw sensors @ 20 Hz and attitude @ 10 Hz
conn.mav.request_data_stream_send(
    conn.target_system, conn.target_component,
    mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS, 20, 1)
conn.mav.request_data_stream_send(
    conn.target_system, conn.target_component,
    mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 10, 1)

print("Streaming IMU data (Ctrl+C to stop)...\n")

while True:
    msg = conn.recv_match(type=['SCALED_IMU', 'SCALED_IMU2', 'ATTITUDE'], blocking=True, timeout=1.0)
    if msg is None:
        print("(no message)")
        continue
    t = msg.get_type()
    if t in ('SCALED_IMU', 'SCALED_IMU2'):
        print(f"[{t}] xacc={msg.xacc:6d} mg  yacc={msg.yacc:6d} mg  zacc={msg.zacc:6d} mg  "
              f"xgyro={msg.xgyro:6d}  ygyro={msg.ygyro:6d}  zgyro={msg.zgyro:6d}")
    elif t == 'ATTITUDE':
        import math
        print(f"[ATTITUDE] roll={math.degrees(msg.roll):+7.2f}°  "
              f"pitch={math.degrees(msg.pitch):+7.2f}°  "
              f"yaw={math.degrees(msg.yaw):+7.2f}°")
