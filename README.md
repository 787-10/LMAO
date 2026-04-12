# LMAO — Large Multi-Agent Orchestration

> Adaptive resource retrieval under extreme, changing, and uncertain conditions
> on the Innate MARS rover. RoboHacks 2026.

## Quick start

### 1. Robot setup (after battery connect / reboot)

```bash
ssh jetson1@mars-the-18th.local
# password: goodbot18

# Verify innate services are running (14 nodes in tmux)
innate service view
# Ctrl+B then d to detach
```

The robot's WebSocket server (`rws_server`) starts automatically on **port 9090**.
The orchestrator and dashboard both connect to this — no extra launch needed.

**If you need rosbridge** (e.g. for raw roslibpy scripts or third-party tools), launch
it inside the innate service tmux so it joins the Zenoh DDS mesh:

```bash
innate service view
# Ctrl+B then c  (new tmux window)
RMW_IMPLEMENTATION=rmw_zenoh_cpp ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9091
```

> **Why inside tmux?** MARS uses Zenoh as its DDS layer. Nodes launched outside
> the innate service tmux can't discover the Zenoh router and won't see topic data.

### 2. Laptop — orchestrator

```bash
# From repo root
cp .env.example .env          # add your ANTHROPIC_API_KEY
uv run python -m orchestrator          # real robot
uv run python -m orchestrator --sim    # simulated (no robot needed)
```

The orchestrator connects to `rws_server` on port 9090 (configured in
`orchestrator/fleet_config.yaml`), starts the health monitor, Claude
reasoner, and API server on port 8000.

### 3. Laptop — dashboard

```bash
cd lucas_dashboard
pnpm install
pnpm dev
```

Open `http://localhost:5173`:
- **Agent pages** — live camera feeds, telemetry, drive controls, IMU, LiDAR (direct to robot via port 9090)
- **Mission page** (`/mission`) — Claude command input, fleet health, task assignments, event stream (via orchestrator API on port 8000)

## Robot connection details

| Method | Command |
|--------|---------|
| WiFi | `ssh jetson1@mars-the-18th.local` |
| Ethernet | `ssh jetson1@192.168.50.2` (set laptop to 192.168.50.1/24) |
| USB-C | `ssh jetson1@192.168.55.1` |

Password: `goodbot18`  
Robot IP (on Robot WiFi): `172.17.30.66`

| Port | Service | Used by |
|------|---------|---------|
| 9090 | rws_server (innate WebSocket) | Dashboard agent pages + orchestrator |
| 9091 | rosbridge (if launched) | Raw roslibpy scripts |
| 8000 | Orchestrator API | Dashboard mission page |
| 8765 | Foxglove bridge (if launched) | Foxglove Studio visualization |

## What's here

```
lmao/
├── orchestrator/                   ← hub planner (laptop-side)
│   ├── __main__.py                 ← entry point: python -m orchestrator
│   ├── fleet_config.yaml           ← robot IPs, health thresholds
│   ├── api.py                      ← FastAPI server for dashboard
│   ├── comms/connection_manager.py ← WebSocket to rws_server
│   ├── world_model/                ← fleet state, tasks, events
│   ├── health/                     ← rate monitoring, degradation tiers
│   ├── reasoner/                   ← Claude API tool-use reasoning
│   ├── allocator/                  ← task assignment scoring
│   ├── cli/repl.py                 ← operator CLI
│   └── sim.py                      ← simulated robots for offline dev
│
├── lucas_dashboard/                ← React dashboard (Vite + TanStack Router)
│   └── src/routes/mission.tsx      ← orchestrator mission control page
│
├── ros2/lmao_fdir/                 ← on-robot FDIR (ROS2 package)
│   └── lmao_fdir/
│       ├── fdir_node.py            ← coordinator node
│       ├── transport.py            ← ROS2/roslibpy dual transport
│       ├── laptop_runner.py        ← off-robot dev entry point
│       └── channels/               ← fault injection, rate health, frozen feed, joint check
│
├── skills/                         ← robot skills (hot-reloaded)
├── tests/                          ← platform validation tests
└── docs/
    ├── REFERENCE.md                ← MARS topics, rates, FDIR channels
    └── REACT_UI_INTEGRATION.md     ← API surface for dashboard integration
```

## Edit on your laptop, deploy to the robot

```bash
# On the robot, one time:
git clone https://github.com/787-10/LMAO.git ~/lmao
~/lmao/scripts/install_symlinks.sh

# Every deploy after that:
cd ~/lmao && git pull && innate build lmao_fdir
```

Skills are hot-reloaded by `brain_client` without rebuild. ROS2 package changes
need `innate build lmao_fdir`.

## References

- `docs/REFERENCE.md` — verified MARS topics, rates, FDIR channels
- `docs/REACT_UI_INTEGRATION.md` — orchestrator API for dashboard
- `tests/README.md` — validation pack checklist
- Innate docs: https://docs.innate.bot
