# MARS / InnateOS Reference Card — RoboHacks 2026

Verified directly from `innate/innate-os/` source. Use this as the day-1 cheat sheet.

## Repo layout
```
innate/
├── innate-os/                    ← deploys to the Jetson; you add code here
│   ├── ros2_ws/src/
│   │   ├── maurice_bot/          ← sensors, actuators, nav, cam, sim
│   │   │   ├── maurice_bringup/  ← LiDAR, battery, I2C, UART, /cmd_vel, /odom
│   │   │   ├── maurice_cam/      ← stereo cam + VPI SGM depth
│   │   │   ├── maurice_arm/      ← arm servos, MoveIt, IK, /joint_states
│   │   │   ├── maurice_nav/      ← Nav2 + SLAM
│   │   │   ├── maurice_control/  ← rosbridge websocket
│   │   │   ├── maurice_sim/      ← simulator (stage_ros2 based)
│   │   │   └── maurice_msgs/     ← custom msg/srv/action
│   │   ├── brain/
│   │   │   ├── brain_client/     ← cloud agent bridge
│   │   │   ├── brain_messages/   ← Skill/Behavior actions, services
│   │   │   └── manipulation/     ← record/replay + learned policies
│   │   └── cloud/                ← training, logger, uninavid client
│   ├── skills/                   ← drop Python skill files here (auto-loaded)
│   └── agents/                   ← BASIC agent definitions
├── behavior-examples/            ← standalone skills library reference
├── robohacks-utils/              ← auth + HDF5↔LeRobot converter
├── ros-websocket/                ← efficient C++ rosbridge (port 9090)
├── GraspGen/                     ← off-robot rosbridge demo (good template)
└── innate-uninavid/              ← VLN server (Uni-NaVid, EVA-ViT-G)
```

## Hardware (confirmed from source)
- **Compute**: Jetson Orin Nano 8GB (per innate-os README). ROS2 Humble.
- **Base**: differential drive, commanded via `/cmd_vel`, publishes `/odom` + `/battery_state`. Firmware I2C addr 0x42.
- **LiDAR**: **Slamtec RPLidar** — 2D spinning scanner, serial `/dev/rplidar`, 115200 baud, "Express" mode. TF `base_link → base_laser` at `(x=-0.0764, y=0, z=0.17165)`, identity rotation. Throttled to 6 Hz.
- **Main camera**: stereo @ 2560×720 capture → published 640×480 per eye @ 15 Hz. Frame `camera_optical_frame`. JPEG compressed at q=80.
- **Arm camera**: Arducam, 640×480 @ 30 Hz, YUYV.
- **Depth**: **stereo-derived via VPI SGM on CUDA** — NOT an RGBD sensor. Max 8 Hz. Depth band clamped `[0.25m, 2.0m]`. 60-pixel invalid border margin. Point cloud decimation = 1 (76k points) or 2 (19k).
- **Arm**: 6 joints via Dynamixel smart servos (XL430/XC430/XL330 family), 0.088° encoder resolution. MoveIt + KDL IK. **`effort[]` IS populated** in `/mars/arm/state` and `/joint_states` (verified in `arm.cpp:683`, `arm_control.cpp:61`) — that's Dynamixel present-current, so commanded-vs-actual current checks are feasible.
- **Stock firmware gap**: I2C protocol to Jetson exposes **only** battery voltage (×100), motor temp (°C), and a 1-byte fault code. No motor current, no encoder velocity, no IMU via this path. **MARS has no stock IMU topic** (zero matches across innate-os source tree).

## External / BYO hardware — Pixhawk 6X (team-supplied)
Team is bringing a **Pixhawk 6X** from personal drone kit to mount on MARS as a supplementary sensor package. This fills the MARS IMU gap and legitimizes triple-redundant voting.
- **3x onboard IMUs** (triple-redundant) — genuine NASA-AOCS-style redundancy pattern is accurate with this hardware
- Barometer, magnetometer
- **Bridge**: `mavros` ROS2 node on the Jetson, connected via USB or UART/telem cable
- **Topics once mavros is running**:
  - `/mavros/imu/data` (`sensor_msgs/Imu`, filtered fused state, ~100 Hz default)
  - `/mavros/imu/data_raw` (raw accel/gyro)
  - `/mavros/imu/mag` (`sensor_msgs/MagneticField`)
  - Per-IMU diagnostics available via `/mavros/sys_status` or ekf topics for voting logic
- **Day-1 integration blockers** (address before FDIR math):
  1. Physically mount Pixhawk rigidly to MARS chassis (no wobble or the IMU fusion is junk)
  2. Wire USB or UART to Jetson; pick a persistent `/dev/ttyACM*` or `/dev/ttyUSB*` path
  3. Launch `mavros_node` with correct FCU URL (e.g. `/dev/ttyACM0:921600`)
  4. **Calibrate static TF from Pixhawk frame to MARS `base_link`** — without this, any FK-vs-IMU math has a bogus offset. Measure with calipers or use a known-pose alignment procedure.
  5. Confirm `/mavros/imu/data` topic publishes at expected rate with `ros2 topic hz`

## Critical ROS2 topics (verified in source)

### Base & odometry
| Topic | Type | Direction | Rate | Notes |
|---|---|---|---|---|
| `/cmd_vel` | `geometry_msgs/Twist` | sub | — | Base velocity input |
| `/odom` | `nav_msgs/Odometry` | pub | **unverified** | Confirm with `ros2 topic hz` at kickoff |
| `/battery_state` | `sensor_msgs/BatteryState` | pub | **0.2 Hz** | Set in `robot_config.yaml: battery_state_frequency: 0.2` |

### BASIC cloud bridge (for comms-blackout detection)
| Topic | Type | Direction | Notes |
|---|---|---|---|
| `ws_messages` | `std_msgs/String` | pub | Inbound from cloud BASIC agent (JSON payloads). **Monitor timestamp gaps to detect comms loss.** Confirmed in `brain_client/ws_client_node.py:149`, `ws_bridge.py`. |
| `ws_outgoing` | `std_msgs/String` | sub | Outbound to cloud BASIC agent (JSON payloads). Confirmed in `ws_client_node.py:153`. |

### Pixhawk / mavros (after BYO integration)
| Topic | Type | Expected rate | Notes |
|---|---|---|---|
| `/mavros/imu/data` | `sensor_msgs/Imu` | ~100 Hz | Filtered fused IMU from Pixhawk EKF |
| `/mavros/imu/data_raw` | `sensor_msgs/Imu` | ~100 Hz | Raw accel/gyro |
| `/mavros/imu/mag` | `sensor_msgs/MagneticField` | ~50 Hz | Magnetometer |
| `/mavros/sys_status` | `mavros_msgs/SysStatus` | ~1 Hz | Per-sensor health, feeds triple-IMU voting logic |
| `/mavros/state` | `mavros_msgs/State` | ~1 Hz | FCU connection state |

### LiDAR
| Topic | Type | Notes |
|---|---|---|
| `/scan_fast` | `sensor_msgs/LaserScan` | Full-rate raw scan |
| `/scan` | `sensor_msgs/LaserScan` | Throttled 6 Hz via `topic_tools/throttle` |
| frame | `base_laser` | |

### Stereo camera + depth (`maurice_cam`)
| Topic | Type | Notes |
|---|---|---|
| `/mars/main_camera/left/image_raw` | `sensor_msgs/Image` | Left rectified input |
| `/mars/main_camera/right/image_raw` | `sensor_msgs/Image` | Right |
| `/mars/main_camera/left/camera_info` | `sensor_msgs/CameraInfo` | Intrinsics for projection |
| `/mars/main_camera/right/camera_info` | `sensor_msgs/CameraInfo` | |
| `/mars/main_camera/stereo` | `sensor_msgs/Image` | Combined stereo frame |
| `/mars/main_camera/left/image_rect` | `sensor_msgs/Image` | Rectified mono8 |
| `/mars/main_camera/left/image_rect_color` | `sensor_msgs/Image` | Rectified color |
| `/mars/main_camera/left/image_rect_color/compressed` | `sensor_msgs/CompressedImage` | For remote viewing |
| **`/mars/main_camera/depth/image_rect_raw`** | `sensor_msgs/Image` (16SC1, mm) | **Primary depth — FDIR input** |
| `/mars/main_camera/disparity` | `stereo_msgs/DisparityImage` | Filtered |
| `/mars/main_camera/disparity_unfiltered` | `stereo_msgs/DisparityImage` | Raw VPI output |
| `/mars/main_camera/points` | `sensor_msgs/PointCloud2` | XYZRGB |
| frame | `camera_optical_frame` | |

**Depth gotchas for FDIR**:
- **Lazy publication** — depth only computed when subscribed. Subscribing costs Jetson CPU+GPU.
- **Max 8 Hz** — your FDIR loop is upper-bounded here.
- **Valid range [0.25–2.0 m] only** — cross-check with LiDAR is meaningful only inside this band.
- **60-pixel border invalid** — mask borders before computing per-sector stats.
- **Depth encoding**: `16SC1` in **millimetres** (not meters). Convert.

### Arm (`maurice_arm`)
| Topic/Service | Type | Notes |
|---|---|---|
| `/mars/arm/state` | `sensor_msgs/JointState` | 6-joint actual state with `position[]`, `velocity[]`, **`effort[]` (= Dynamixel present-current)**. Verified in `arm.cpp:683`. |
| `/mars/arm/command_state` | `sensor_msgs/JointState` | Commanded (for cmd↔actual FDIR check) |
| `/mars/arm/status` | `maurice_msgs/ArmStatus` | Health |
| `/joint_states` | `sensor_msgs/JointState` | 7-joint (includes head) |
| `/mars/arm/commands` | (sub) | Command input |
| `/mars/arm/goto_js` | service | Joint-space goto |
| `/mars/arm/goto_js_v2` | service | Newer variant |
| `/mars/arm/goto_js_trajectory` | service | Trajectory |
| `/mars/arm/torque_on` / `torque_off` / `reboot` / `fix_error` | services | Motor control |
| `/ik_delta` | `geometry_msgs/Twist` (sub) | Incremental IK input (GraspGen uses this) |
| `/ik_solution` | `sensor_msgs/JointState` (pub) | IK output |

### Navigation
- Use `nav2_simple_commander.BasicNavigator` with namespaces `''`, `mapfree`, or `navigation`.
- Behavior trees: `"mapfree"` (local) or `"navigation"` (global map).
- Mode switching via `/brain/change_navigation_mode` service (`ChangeNavigationMode.srv`).

## Skill framework (the real pattern, not the stale README)

**`skills/README.md` is out of date** — it describes "Primitive" base classes, but actual skill files in `skills/` inherit from `Skill` (`brain_client.skill_types`). Follow real examples like `skills/navigate_to_position.py`.

```python
from brain_client.skill_types import Skill, SkillResult

class FaultRecovery(Skill):
    def __init__(self, logger):
        self.logger = logger

    @property
    def name(self):
        return "fault_recovery"

    def guidelines(self):
        return (
            "Use when FDIR anomaly score exceeds threshold. Parks the robot "
            "safely, stops motion, waits for operator intervention."
        )

    def execute(self, severity: str = "high"):
        self.logger.info(f"Executing fault recovery, severity={severity}")
        # your recovery logic: stop base, park arm, publish alert, etc.
        return "Robot parked, awaiting operator", SkillResult.SUCCESS

    def cancel(self):
        return "Recovery canceled"
```

Drop the file into `innate-os/skills/` — auto-discovered, no manual import needed. Skill IDs are namespaced as `innate-os/<skill_name>` when referenced from agents.

## Agent framework

```python
from typing import List
from brain_client.agent_types import Agent

class FdirAgent(Agent):
    @property
    def id(self) -> str:
        return "fdir_agent"

    @property
    def display_name(self) -> str:
        return "FDIR Monitor"

    def get_skills(self) -> List[str]:
        return [
            "innate-os/navigate_to_position",
            "innate-os/fault_recovery",
        ]

    def get_inputs(self) -> List[str]:
        return ["micro"]  # also: camera, lidar, etc.

    def get_prompt(self) -> str | None:
        return "You are monitoring robot health..."
```

Drop into `innate-os/agents/`.

## Available Actions / Services (from `brain_messages/`)

- **Actions**: `ExecuteBehavior`, `ExecutePolicy`, `ExecuteSkill`
- **Key services**: `ActivateManipulationTask`, `ChangeMap`, `ChangeNavigationMode`, `CreatePhysicalSkill`, `GetAvailableDirectives`, `ReloadSkillsAgents`, `ResetBrain`, `LoadEpisode`, `GetDatasetInfo`

## Off-robot development path (MacBook)

1. Clone already done under `innate/`.
2. **Don't install ROS2 on macOS.** Develop against `ros-websocket` bridge (port 9090).
3. Use `roslibpy` in a `uv`-managed Python 3.10 env:
   ```python
   import roslibpy
   client = roslibpy.Ros(host='<robot-ip>', port=9090)
   client.run()
   depth_sub = roslibpy.Topic(client, '/mars/main_camera/depth/image_rect_raw', 'sensor_msgs/Image')
   lidar_sub = roslibpy.Topic(client, '/scan', 'sensor_msgs/LaserScan')
   # subscribe with callbacks, do FDIR logic off-board, publish alerts back
   ```
4. For fast iteration without blocking the robot: **record a rosbag early** (10 min of driving + induced faults) and replay it on any laptop.

## FDIR channel catalog (Tier S / A / B / C)

**Tier S — must build (core demo)**
1. **Comms blackout → local autonomous mode** ⭐⭐⭐ (the thesis beat). Monitor `ws_messages` timestamp gaps → declare comms loss → switch to pre-loaded mission → voice narration. Real spacecraft pattern (Curiosity earth-contact windows). Verified instrumentation (`brain_client/ws_client_node.py`).
2. **LiDAR sector ↔ stereo-depth occupancy** (tape demo). Project `/scan` into `/mars/main_camera/depth/image_rect_raw` along the LiDAR plane row, disagree-map by angular sector. Valid only inside `[0.25–2.0 m]`, masked at 60-px border.
3. **Wheel ↔ visual ↔ Pixhawk IMU cross-modal voting**. Three *different* sensors, not three identical ones. Use `/mavros/sys_status` for per-Pixhawk-IMU voting within that channel.
4. **Commanded ↔ actual joint position** from `/mars/arm/state` vs `/mars/arm/command_state`. Free signal, already published.
5. **ROS2 topic liveness / rate health** (Channel K). Rolling 2s window; <50% = degraded, ==0 = failed. Use the corrected expected-rate table below.
6. **Self-diagnostic stretch routine** (Channel N). Prelaunch checklist as the demo opening. Wheels, head, arm, LiDAR SNR, LED-flash-via-camera, speaker-chirp-via-mic.
7. **Graceful degradation mode tiers** (Channel R). `FULL_CAPABILITY → DEGRADED_SENSORS → LOCAL_ONLY → SAFE_MODE → HIBERNATION`, each transition narrated.

**Tier A — strongly add if Tier S lands fast**
8. **Forward kinematics ↔ camera-observed gripper** (Channel F). Load `maurice_sim/urdf/maurice.urdf` via `urdfpy` or `robot_state_publisher`, compute gripper pose in `base_link`, project into `camera_optical_frame`, compare to AprilTag observation. Bring a printed AprilTag.
9. **Motor current ↔ expected load** (Channel O physics subchannel). `/mars/arm/state.effort[]` is Dynamixel present-current — predict expected current from trajectory dynamics, flag deviation.
10. **Frame-to-frame image consistency** (Channel L). `|curr - prev|.mean()` low for N seconds = frozen feed. ~20 lines of Python.
11. **Fault injection dashboard** (Channel S). UI that triggers specific fault types on demand — makes the live demo bulletproof and tells a real-mission-software-validation story.
12. **VLM-as-fault-interpreter** (Channel Q). Qwen2.5-VL-3B 4-bit on Jetson (~3GB, tight with ROS). Fallback: run VLM on team laptop via `ros-websocket`.

**Tier B — stretch**
13. **Bayesian fault isolation** (Channel T). Posterior over fault hypotheses given observed cross-check disagreements. The literal "I" in FDIR.
14. **Learned anomaly detector** (Channel P). Autoencoder over healthy multi-sensor state. Give the project a real ML component.
15. **Self-healing recovery actions** (Channel U). Per-fault-type recovery library.

**Tier C — skip unless trivially free**
16. **Motor temperature baseline** — only `bringup/i2c.py` reports this at low rate
17. **Battery voltage under load** — only `/battery_state` at 0.2 Hz

## Day-1 priorities

1. **Pixhawk integration** (BYO hardware): physically mount, wire to Jetson, launch mavros, calibrate Pixhawk→`base_link` TF. Assume ~2-4 hours — this gates Tier S #3 and Channel O.
2. **Confirm your track** (robot vs simulator). Decides LMAO vs FDIR viability.
3. **Record a nominal-driving + induced-fault rosbag** within hour 3 on the robot.
4. **Skill stub first**: write a no-op `fault_recovery.py` and confirm it loads into a stub agent. Integration is the risky piece, not the math.
5. **Subscribe to depth lazily** — depth is a lazy topic; only subscribe when actively cross-checking.

## Rate-sanity baseline for Channel K (verified, not guessed)

| Topic | Expected rate | Source |
|---|---|---|
| `/scan` | **6 Hz** | `lidar.launch.py`: `topic_tools/throttle` at 6.0 |
| `/mars/main_camera/*/image_raw` | **15 Hz** | `main_camera_driver.yaml: fps: 15.0` |
| arm camera | **30 Hz** | `main_camera_driver.yaml: arm_camera_driver.fps: 30.0` |
| `/mars/main_camera/depth/image_rect_raw` | **≤8 Hz, lazy** | `stereo_depth_estimator.yaml: max_fps: 8.0` |
| `/battery_state` | **0.2 Hz** | `robot_config.yaml: battery_state_frequency: 0.2` |
| `/mars/arm/state` | **unverified** | `ros2 topic hz` at kickoff |
| `/odom` | **unverified** | `ros2 topic hz` at kickoff |
| `/mavros/imu/data` | **~100 Hz** (default) | mavros default; confirm after launching |

---

## Skills built at RoboHacks 2026 (team-authored)

All skills live in `skills/` and are auto-loaded by the brain. Invoke via dashboard or agent.

### FDIR: LiDAR ↔ Camera cross-validation — `lidar_cross_validate.py`

**What it does:** Compares lidar `/scan` occupancy against stereo depth `/mars/main_camera/depth/image_rect_raw` to detect sensor disagreement. Projects lidar points into the camera plane and checks whether the depth image agrees in each angular sector. A sector where lidar says "obstacle" but depth says "clear" (or vice versa) raises a fault.

**Verdict outputs:** `nominal` | `fault` (with per-sector breakdown)

**Key parameters:**
- Valid depth range: 0.25–2.0 m (hardware limit of stereo SGM)
- 60-pixel border masked (invalid SGM margin)
- Sector angular resolution: configurable, default 15°

**Demo:** Place an object at ~0.5–1.5 m. Cover the camera (or lidar). Skill detects the disagreement.

---

### FDIR: Encoder ↔ IMU stuck detection — `encoder_imu_odometry_check.py`

**What it does:** Drives the robot forward for 4 seconds while simultaneously reading wheel encoder odometry (`/odom`) and Pixhawk IMU acceleration (via pymavlink). If the encoders report displacement ≥ 10 cm but the IMU detects no physical motion on 2+ axes → **STUCK fault**.

**Verdict outputs:** `stuck` | `moving` | `no_encoder_movement` | `error`

**Key parameters:**
- Drive speed: 0.2 m/s for 4 s
- Min encoder delta to trigger check: 0.10 m
- IMU motion threshold: 150 mg per axis (gravity-subtracted)
- Stuck declared if 2+ axes are static

**Axis mapping (physical on MARS):**
- `yacc` → X (forward/back)
- `zacc` → Y (left/right)
- `xacc` → Z (up/down, dominated by gravity ~−1000 mg when flat)

**Demo:** Physically block the robot or hold it in place. Run the skill. Encoders accumulate displacement; IMU stays flat → `stuck` verdict.

**Prerequisite:** Pixhawk connected on `/dev/ttyACM2`. Run `sudo systemctl stop ModemManager` first.

---

### IMU motion check (standalone) — `movement_check.py`

**What it does:** 2-second IMU snapshot to determine if the robot is physically moving — no driving involved. Reads all 3 axes with gravity subtraction. If 2+ axes are below 150 mg → `stuck`. Useful as a fast pre-check or called by an agent to confirm robot state.

**Verdict outputs:** `stuck` | `moving` | `error`

---

### Navigate to position — `navigate_to_position` (innate-os built-in)

Available via the dashboard Skills panel with inline X / Y / θ parameter inputs. Sends a Nav2 goal in the **map frame** (same coordinate system as `/amcl_pose`). Coordinates shown in the LOCATION TRACK panel match these inputs directly.

**Float serialization note:** All parameter values are sent as floats (e.g. `0.0` not `0`). The dashboard enforces this automatically.

---

### IMU dashboard stream — `imu_odom_pub2.py` (run manually on Jetson)

Not a skill — a standalone ROS2 node that publishes Pixhawk IMU data to `/robot/imu_odom` at 50 Hz as a JSON string. Required for the IMU ACCEL panel on the dashboard.

```bash
sudo systemctl stop ModemManager
python3 ~/skills/imu_odom_pub2.py
```

Published JSON: `{ "xacc": int, "yacc": int, "zacc": int, "roll": float, "pitch": float, "yaw": float }` (acceleration in milli-g, angles in degrees)

---

### Why raw IMU cannot give X/Y position (important for judges)

The Pixhawk accelerometer is used **only for motion detection (binary yes/no)**, not position tracking. Double-integrating raw accelerometer readings to get position is fundamentally broken without GPS: even a 1 mg bias accumulates ~5 m of drift in 10 seconds. Drones solve this with GPS + barometer fused into an EKF. Indoors without GPS, the IMU is only trusted for ~100 ms before drift dominates. Our FDIR uses it correctly: "did the robot physically move?" not "where did it go?"

---

## Open questions to resolve with staff at kickoff

- How many physical robots per team?
- Is `/odom` from wheel-based integration or visual/other? (Matters for the wheel-vs-visual consistency check.)
- Any pre-recorded sample rosbags available to devs?
- Can we flash custom firmware on the motor PCB, or is the I2C protocol fixed?
- Is the Jetson networked such that all 5 laptops can hit `ros-websocket` simultaneously?
- Is mounting external hardware (Pixhawk 6X + cable to Jetson) allowed? Any rules against physical modifications?
