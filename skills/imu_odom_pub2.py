#!/usr/bin/env python3
"""imu_odom_pub — publishes raw Pixhawk IMU acceleration to /robot/imu_odom.

Run on Jetson (after: sudo systemctl stop ModemManager):
  python3 ~/skills/imu_odom_pub.py

Topic: /robot/imu_odom  (std_msgs/String, JSON)
  { "xacc": float, "yacc": float, "zacc": float,   # milli-g
    "roll": float, "pitch": float, "yaw": float }   # degrees
"""

import json
import math
import threading
import time

import rclpy
from rclpy.node import Node
from std_msgs.msg import String

from pymavlink import mavutil

PORT = '/dev/ttyACM2'
BAUD = 115200


class ImuOdomPublisher(Node):
    def __init__(self, conn):
        super().__init__('imu_odom_pub')
        self._pub  = self.create_publisher(String, '/robot/imu_odom', 10)
        self._conn = conn
        self._data = {'xacc': 0, 'yacc': 0, 'zacc': 0,
                      'roll': 0.0, 'pitch': 0.0, 'yaw': 0.0}
        self._lock = threading.Lock()

        threading.Thread(target=self._read_loop, daemon=True).start()
        self.create_timer(0.02, self._publish)   # 50 Hz
        self.get_logger().info('imu_odom_pub: publishing to /robot/imu_odom')

    def _read_loop(self):
        while rclpy.ok():
            msg = self._conn.recv_match(
                type=['SCALED_IMU2', 'SCALED_IMU', 'ATTITUDE'],
                blocking=True, timeout=0.5)
            if msg is None:
                continue
            mtype = msg.get_type()
            with self._lock:
                if mtype in ('SCALED_IMU2', 'SCALED_IMU'):
                    self._data['xacc'] = int(msg.xacc)
                    self._data['yacc'] = int(msg.yacc)
                    self._data['zacc'] = int(msg.zacc)
                elif mtype == 'ATTITUDE':
                    self._data['roll']  = round(math.degrees(msg.roll),  2)
                    self._data['pitch'] = round(math.degrees(msg.pitch), 2)
                    self._data['yaw']   = round(math.degrees(msg.yaw),   2)

    def _publish(self):
        with self._lock:
            data = dict(self._data)
        msg = String()
        msg.data = json.dumps(data)
        self._pub.publish(msg)


def main():
    print(f'Connecting to Pixhawk on {PORT}...')
    conn = mavutil.mavlink_connection(PORT, baud=BAUD)
    conn.wait_heartbeat()
    print(f'Heartbeat from system {conn.target_system}')

    conn.mav.request_data_stream_send(
        conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS, 50, 1)
    conn.mav.request_data_stream_send(
        conn.target_system, conn.target_component,
        mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 20, 1)

    rclpy.init()
    node = ImuOdomPublisher(conn)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
