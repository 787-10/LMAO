# Validation Pack

Run these in order on day 1, before writing any new code. Each test exists to
verify one assumption we've made about the platform or to prove one capability
the project will depend on. Each takes <5 minutes. Total walk-through: ~40 minutes.

These are **platform validation only** — they don't test any LMAO-specific
code. Once T1–T7 pass, we know the platform behaves the way docs claim, and
we can start writing project code with confidence.

If a test fails, **stop and fix it** before moving on — every later test
assumes the earlier ones passed.

| # | Test | Where it runs | Validates | Why it matters for LMAO |
|---|---|---|---|---|
| 1 | SSH + `innate diag` | manual | network, creds, robot is alive | prerequisite for everything |
| 2 | Topic introspection | robot | REFERENCE.md is accurate; topic rates match | scouts will need accurate topic facts |
| 3 | Hello node deploy | robot | full deploy pipeline works end-to-end | how all future code reaches the robot |
| 4 | Hello skill hot-reload | robot | brain_client picks up new skills without rebuild | fast iteration on scout behaviors |
| 5 | `cmd_vel` nudge | robot | base motion API works | hub → scout assignment → scout moves |
| 6 | Laptop rosbridge subscribe | laptop | off-board ROS access works | hub will run on a laptop |
| 7 | Foxglove visual | laptop | live visualization works | demo dashboard prerequisite |

---

## T1 — SSH + `innate diag`

**Why:** prerequisite. Confirms you can reach the robot, your credentials work,
and the robot's stack is alive.

**Run:**
```bash
ssh jetson1@<robot-ip>            # password from staff
innate view                       # attach to ros_nodes tmux — Ctrl+b d to detach
innate diag                       # hardware diagnostics
ros2 topic list | head            # sanity check
```

**Pass when:**
- `innate view` shows ROS nodes in tmux without errors
- `innate diag` reports hardware nominal
- `ros2 topic list` shows `/scan`, `/odom`, `/battery_state`, `/mars/main_camera/...`

**If it fails:**
- Wrong IP → ask staff for the right one or `nmap -sn <subnet>`
- SSH refused → check the robot is actually powered on and on the wifi
- `innate view` shows no tmux → run `sudo systemctl restart ros-app.service`

---

## T2 — Topic introspection

**Why:** REFERENCE.md was sourced from launch files and configs, but actual
behavior on the robot might differ. We want to know the *real* rates before
we hardcode them anywhere.

**Run on the robot:**
```bash
cd ~/lmao
python3 tests/02_topic_check.py
```

**Pass when:** every required topic is present and within ±20% of its
expected rate.

**Critical things to discover:** `/odom` and `/mars/arm/state` rates are
unverified in REFERENCE.md. **Update REFERENCE.md and `config/topic_expectations.yaml`
with the real values discovered here.**

---

## T3 — Hello node deploy

**Why:** prove the entire deploy pipeline works end-to-end. Clone, symlink,
build, run, observe output. Without this, no further code can reach the robot.

**Run:**
```bash
# On the robot, first time only:
git clone https://github.com/787-10/LMAO.git ~/lmao
~/lmao/scripts/install_symlinks.sh

# Build:
innate build lmao_fdir

# Run the heartbeat node specifically:
ros2 run lmao_fdir hello_node

# In another terminal:
ros2 topic echo /lmao/heartbeat
```

**Pass when:** `ros2 topic echo /lmao/heartbeat` shows `alive (tick=N)`
messages at 1 Hz.

**If it fails:**
- Build error → `innate clean && innate build lmao_fdir`, paste the error
- Symlink error → `ls -la ~/innate-os/ros2_ws/src/lmao_fdir`, should point at `~/lmao/ros2/lmao_fdir`
- Module-not-found at runtime → confirm `setup.py` has `hello_node` entry point

---

## T4 — Hello skill hot-reload

**Why:** prove brain_client picks up new skills via the file watcher without
needing `innate build` or `innate restart`. This is the iteration loop that
makes scout-side development fast tomorrow.

**Run:**
```bash
# install_symlinks.sh from T3 already symlinked skills/hello.py
ls -la ~/innate-os/skills/hello.py     # should be a symlink

# Trigger the brain to scan for skills:
ros2 service call /brain/reload_skills_agents \
  brain_messages/srv/ReloadSkillsAgents "{skills: []}"

# Watch the brain_client logs:
sudo journalctl -u ros-app.service -f | grep -i hello
```

You should see the skill register. Now modify it:

```bash
# Edit on your laptop, push to git, pull on robot:
# (or on the robot for this one test:)
sed -i 's/hello from LMAO/hello from LMAO v2/' ~/lmao/skills/hello.py
```

**Pass when:** within ~2 seconds of the file change, brain_client logs
mention reloading the skill (no manual reload needed). If hot reload doesn't
fire automatically, the explicit `ros2 service call` above does the same job.

---

## T5 — `cmd_vel` nudge

**Why:** prove motion control. Every scout will need to publish to `/cmd_vel`
to execute its assigned mission. We want to know it works *and* feel how
much movement a given Twist produces.

**SAFETY: put the robot on the floor with at least 1 meter of clear space
in front of it. Be ready to grab it. The script will pause 5 seconds before
sending so you can Ctrl+C if not safe.**

**Run on the robot:**
```bash
python3 tests/05_cmd_vel_nudge.py
```

**Pass when:** robot creeps forward ~5 cm, then stops.

**If it fails:**
- Robot doesn't move → `ros2 topic info /cmd_vel` to see if anyone's
  subscribed; check `maurice_bringup` is running
- Robot keeps moving after the script ends → emergency stop, then
  `ros2 topic pub --once /cmd_vel geometry_msgs/Twist '{}'` to force-zero

---

## T6 — Laptop rosbridge subscribe

**Why:** the LMAO hub will run on a laptop and talk to scouts via rosbridge
on port 9090 (or Foxglove Bridge on 8765). Prove the laptop can actually
reach the robot before building anything that depends on it.

**Run on your laptop (Mac):**
```bash
pip install roslibpy   # if you don't have it
ROBOT_IP=192.168.1.42 python3 tests/06_laptop_subscribe.py
```

**Pass when:** prints at least 3 `/battery_state` messages within 30 seconds.

**If it fails:**
- Connection refused → `ros2 launch rosbridge_server rosbridge_websocket_launch.xml` on the robot
- No messages but connection works → check `/battery_state` is actually
  publishing on the robot (`ros2 topic hz /battery_state`)
- WebSocket disconnects randomly → robot wifi power-save not disabled
  (see `innate-os/SYSTEM_SETUP.md` step 2)

---

## T7 — Foxglove visual

**Why:** demo prerequisite. The team needs to be able to visualize live ROS
data from the robot on every laptop, simultaneously.

**Run on the robot:**
```bash
ros2 launch foxglove_bridge foxglove_bridge_launch.xml
```

**On every laptop:**
1. Download Foxglove Studio (https://foxglove.dev/download)
2. Open → "Open connection" → `ws://<robot-ip>:8765`
3. Add an Image panel → topic `/mars/main_camera/left/image_raw/compressed`
4. Add a 3D panel → display `/scan` and `/tf`
5. Save the layout, share the JSON in team chat

**Pass when:** every team laptop can connect simultaneously and see live
camera + LiDAR.

---

## Post-test action items

After all 7 pass, do these housekeeping items:

1. **Update `docs/REFERENCE.md`** with the actual `/odom` and `/mars/arm/state`
   rates discovered in T2.
2. **Save the Foxglove layout JSON** to `docs/foxglove_layout.json` and commit.
3. **Record a baseline rosbag** of nominal driving (~10 min) for offline dev.
   Upload to the team drive, post the link in chat.
4. **Mount the Pixhawk** and run `ros2 launch mavros apm.launch fcu_url:=/dev/ttyACM0:921600`
   to confirm `/mavros/imu/data` publishes.

Once all of this is done, you have a verified deploy pipeline, known-good
motion control, working visualization, and a baseline rosbag. *Then* you
start writing project code.
