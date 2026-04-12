#!/usr/bin/env bash
# Record a rosbag on the MARS robot with all sensor topics needed
# for offline Qwen replay and FDIR development.
#
# Usage (on robot):
#   cd ~/lmao && bash scripts/record_trajectory.sh [duration_seconds]
#
# Default: 120 seconds. Bags land in ~/lmao/bags/<timestamp>/

set -euo pipefail

DURATION=${1:-120}
BAG_DIR="$(cd "$(dirname "$0")/.." && pwd)/bags"
STAMP=$(date +%Y%m%d_%H%M%S)
BAG_PATH="${BAG_DIR}/${STAMP}"

mkdir -p "$BAG_DIR"

# Source ROS2
source /opt/ros/humble/setup.bash 2>/dev/null || true
source ~/innate-os/install/setup.bash 2>/dev/null || true
export RMW_IMPLEMENTATION=rmw_zenoh_cpp
export ROS_DOMAIN_ID=0

TOPICS=(
    # Camera (primary Qwen input)
    /mars/main_camera/left/image_rect_color/compressed

    # Depth
    /mars/main_camera/depth/image_rect_raw

    # LiDAR
    /scan

    # Odometry & base
    /odom
    /cmd_vel
    /battery_state

    # Arm
    /mars/arm/state
    /mars/arm/command_state
    /joint_states

    # Cloud agent bridge (comms-loss detection)
    ws_messages

    # Pixhawk IMU (if mounted)
    /mavros/imu/data
)

echo "=== LMAO Trajectory Recorder ==="
echo "Duration:  ${DURATION}s"
echo "Output:    ${BAG_PATH}"
echo "Topics:    ${#TOPICS[@]}"
echo ""
echo "Recording starts in 3 seconds — drive the robot around!"
sleep 3

ros2 bag record \
    --output "$BAG_PATH" \
    --max-cache-size 200000000 \
    ${TOPICS[@]} &

BAG_PID=$!
echo "Recording PID: $BAG_PID"

sleep "$DURATION"
kill -INT "$BAG_PID" 2>/dev/null || true
wait "$BAG_PID" 2>/dev/null || true

echo ""
echo "=== Recording complete ==="
echo "Bag saved to: ${BAG_PATH}"
echo ""
echo "To copy to your Mac:"
echo "  scp -r jetson1@<robot-ip>:~/lmao/bags/${STAMP} bags/"
