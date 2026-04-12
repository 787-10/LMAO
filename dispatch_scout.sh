#!/bin/bash
# Dispatch scout_mission via the ROS2 action interface.
set -e
export RMW_IMPLEMENTATION=rmw_zenoh_cpp
export ROS_DOMAIN_ID=0
source /opt/ros/humble/setup.bash
source /home/jetson1/innate-os/ros2_ws/install/setup.bash

INPUTS='{"resource_tag":"black_water_bottle","travel_duration_s":3.0,"linear_speed_mps":0.10,"scan_directions":4,"time_budget_s":60}'

exec ros2 action send_goal -f /execute_skill \
  brain_messages/action/ExecuteSkill \
  "{skill_type: 'local/scout_mission', inputs: '${INPUTS}'}"
