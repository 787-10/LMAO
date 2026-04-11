# LMAO — Large Multi-Agent Orchestration

> Adaptive resource retrieval under extreme, changing, and uncertain conditions
> on the Innate MARS rover. RoboHacks 2026.

**Status:** day-1 platform validation. We're proving the platform behaves the
way the docs claim before writing any project code. See `tests/README.md` and
run those 7 tests in order before adding anything new.

## What's here

```
lmao/
├── README.md
├── .gitignore
│
├── tests/                                  ← validation pack (run these first)
│   ├── README.md                           ← master checklist
│   ├── 02_topic_check.py                   ← topic + rate verification
│   ├── 05_cmd_vel_nudge.py                 ← motion smoke test
│   └── 06_laptop_subscribe.py              ← laptop ↔ robot rosbridge
│
├── ros2/lmao_fdir/                         ← minimal ROS2 package
│   ├── package.xml, setup.py, setup.cfg
│   ├── resource/lmao_fdir
│   └── lmao_fdir/
│       ├── __init__.py
│       └── hello_node.py                   ← T3 deploy validation
│
├── skills/
│   └── hello.py                            ← T4 hot-reload validation
│
├── scripts/
│   └── install_symlinks.sh                 ← one-time robot setup
│
└── docs/
    └── REFERENCE.md                        ← verified MARS topic cheat sheet
```

That's it. 14 files. Everything else got cut — we'll add it back once validated.

## What we're building toward

> *Planetary rovers are slow, rigid, and limited to linear exploration.*
> *We introduce a distributed system where a central hub deploys adaptive scout*
> *rovers that autonomously select and retrieve resources, dynamically replanning*
> *when conditions change, enabling flexible and scalable exploration missions.*

The longer arc is a **hub + scouts** architecture: a laptop-side hub orchestrates
one or more MARS rovers, each running its own self-monitoring layer. When a
scout detects its mission has become infeasible — comms loss, blocked goal,
sensor degradation — the hub replans across the remaining fleet.

None of that is built yet. The repo today contains only what's needed to
validate the platform fundamentals. Earn the rest by validation.

## Day-1 sequence

1. Push this repo to GitHub from your laptop
2. Get the robot, find its IP, SSH in (`jetson1@<robot-ip>`)
3. Clone the repo on the robot, run `scripts/install_symlinks.sh`
4. Walk through `tests/README.md` (~40 min)
5. Update `docs/REFERENCE.md` with whatever T2 reveals about topic rates
6. Record a baseline rosbag (manual `ros2 bag record` for now — no helper script yet)
7. Then — and only then — start building hub + scout layers

## Edit on your laptop, deploy to the robot

The robot is a deploy target, not a workstation. Code lives in this repo;
the robot pulls it.

```bash
# On the robot, one time:
git clone https://github.com/787-10/LMAO.git ~/lmao
~/lmao/scripts/install_symlinks.sh

# Every deploy after that:
cd ~/lmao && git pull && innate build lmao_fdir
```

Skills are hot-reloaded by `brain_client` without rebuild. ROS2 package changes
need `innate build lmao_fdir`. Don't SSH in to write code — write on your Mac,
push, pull on the robot.

## References

- `docs/REFERENCE.md` — verified MARS topics, rates, Pixhawk integration
- `tests/README.md` — validation pack checklist
- The vendored Innate repos (a level up at `../innate/`) are read-only reference
- Innate docs site: https://docs.innate.bot
