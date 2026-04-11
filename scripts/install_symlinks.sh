#!/usr/bin/env bash
# One-time setup on the robot. Symlinks LMAO repo dirs into ~/innate-os/ so
# that `git pull` on the LMAO repo immediately updates the code that runs
# on the robot.
#
# After this, the deploy loop is:
#   skill changes  → hot-reloaded by brain_client (no rebuild)
#   ROS2 changes   → `innate build lmao_fdir` (rebuild + restart)
#
# Usage (run on the robot, NOT your laptop):
#   ssh jetson1@<robot-ip>
#   git clone https://github.com/787-10/LMAO.git ~/lmao
#   ~/lmao/scripts/install_symlinks.sh

set -euo pipefail

LMAO_ROOT="${LMAO_ROOT:-$HOME/lmao}"
INNATE_ROOT="${INNATE_ROOT:-$HOME/innate-os}"

if [[ ! -d "$LMAO_ROOT" ]]; then
    echo "ERROR: $LMAO_ROOT not found. Clone the repo first." >&2
    exit 1
fi
if [[ ! -d "$INNATE_ROOT" ]]; then
    echo "ERROR: $INNATE_ROOT not found. Are you on the robot?" >&2
    exit 1
fi

echo "Symlinking ROS2 package..."
ln -snf "$LMAO_ROOT/ros2/lmao_fdir" "$INNATE_ROOT/ros2_ws/src/lmao_fdir"

echo "Symlinking skills..."
for skill in "$LMAO_ROOT"/skills/*.py; do
    [[ -e "$skill" ]] || continue
    name="$(basename "$skill")"
    ln -snf "$skill" "$INNATE_ROOT/skills/$name"
    echo "  $name"
done

echo
echo "Done. Next:"
echo "  innate build lmao_fdir   # build the ROS2 package"
echo "  innate restart            # restart ROS nodes (loads hello_node)"
echo "  innate view               # attach to tmux to watch logs"
