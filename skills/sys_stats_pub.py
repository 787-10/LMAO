"""sys_stats_pub — starts a background publisher for CPU/GPU/RAM/thermal stats.

Spawns a persistent subprocess that publishes to /robot/sys_stats every 2s.
Call this skill once; the publisher keeps running until the robot reboots
or you kill the process.
"""

import json
import os
import signal
import subprocess
import sys
import time

from std_msgs.msg import String
from brain_client.skill_types import Skill, SkillResult

TOPIC    = '/robot/sys_stats'
INTERVAL = 2.0   # seconds between publishes

# The actual publisher logic runs in a subprocess so it doesn't block the skill.
PUBLISHER_SCRIPT = '''
import json, os, re, subprocess, sys, time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

def cpu_load():
    try:
        p = open("/proc/loadavg").read().split()
        return {"load_1m": float(p[0]), "load_5m": float(p[1]), "load_15m": float(p[2])}
    except: return {}

def memory():
    try:
        info = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":")
            info[k.strip()] = int(v.strip().split()[0])
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", 0)
        used  = total - avail
        return {"total_mb": total//1024, "used_mb": used//1024,
                "used_pct": round((used/total)*100,1) if total else 0}
    except: return {}

def thermal():
    import os as _os
    zones = []
    try:
        for e in sorted(_os.listdir("/sys/class/thermal")):
            if not e.startswith("thermal_zone"): continue
            try:
                name = open(f"/sys/class/thermal/{e}/type").read().strip()
                tc   = int(open(f"/sys/class/thermal/{e}/temp").read()) / 1000.0
                zones.append({"zone": name, "temp_c": round(tc,1)})
            except: pass
    except: pass
    if not zones: return {}
    hot = max(zones, key=lambda z: z["temp_c"])
    return {"hottest": hot, "all": zones}

def tegrastats():
    try:
        r = subprocess.run(["tegrastats","--interval","100"],
                           capture_output=True, text=True, timeout=2)
        line = r.stdout.strip().splitlines()[0] if r.stdout.strip() else ""
        if not line: return {}
        out = {}
        m = re.search(r"GR3D_FREQ\\s+(\\d+)%(?:@(\\d+))?", line)
        if m:
            out["gpu_pct"] = int(m.group(1))
            if m.group(2): out["gpu_mhz"] = int(m.group(2))
        m = re.search(r"RAM\\s+(\\d+)/(\\d+)MB", line)
        if m:
            out["ram_used_mb"] = int(m.group(1)); out["ram_total_mb"] = int(m.group(2))
            out["ram_pct"] = round(int(m.group(1))/int(m.group(2))*100,1)
        m = re.search(r"CPU \\[([^\\]]+)\\]", line)
        if m:
            pcts = [int(p.strip().split("%")[0]) for p in m.group(1).split(",") if "%" in p]
            if pcts:
                out["cpu_cores"] = pcts
                out["cpu_avg_pct"] = round(sum(pcts)/len(pcts),1)
        m = re.search(r"VDD_IN\\s+(\\d+)mW", line)
        if m: out["power_mw"] = int(m.group(1))
        return out
    except: return {}

rclpy.init()
node = Node("sys_stats_pub")
pub  = node.create_publisher(String, "/robot/sys_stats", 10)

def publish(_):
    stats = {"cpu": cpu_load(), "memory": memory(), "thermal": thermal(), "gpu": tegrastats()}
    msg = String(); msg.data = json.dumps(stats)
    pub.publish(msg)

node.create_timer(2.0, publish)
rclpy.spin(node)
'''


class SysStatsPub(Skill):

    def __init__(self, logger):
        self.logger = logger
        self._tts_pub = None

    def _speak(self, text: str) -> None:
        if self._tts_pub is None:
            self._tts_pub = self.node.create_publisher(String, '/brain/tts', 10)
            time.sleep(0.1)
        self._tts_pub.publish(String(data=text))

    @property
    def name(self) -> str:
        return 'sys_stats_pub'

    def guidelines(self) -> str:
        return (
            'Starts a background publisher that streams CPU, GPU, RAM, and thermal stats '
            f'to {TOPIC} every {INTERVAL}s. Call once to enable live system monitoring '
            'on the dashboard. Runs until the robot reboots.'
        )

    def execute(self) -> tuple[str, SkillResult]:
        self._speak('Starting system stats publisher.')

        # Write the publisher script to a temp file and launch it
        script_path = '/tmp/sys_stats_pub_daemon.py'
        with open(script_path, 'w') as f:
            f.write(PUBLISHER_SCRIPT)

        proc = subprocess.Popen(
            [sys.executable, script_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,   # detach from parent process group
        )

        time.sleep(1.5)   # give it a moment to start

        if proc.poll() is not None:
            msg = f'Publisher failed to start (exit code {proc.returncode})'
            self.logger.error(msg)
            return json.dumps({'status': 'error', 'message': msg}), SkillResult.FAILURE

        result = {
            'status':  'running',
            'pid':     proc.pid,
            'topic':   TOPIC,
            'message': f'Publishing CPU/GPU/RAM/thermal to {TOPIC} every {INTERVAL}s (pid {proc.pid})',
        }
        self.logger.info(result['message'])
        self._speak('System stats live.')
        return json.dumps(result, indent=2), SkillResult.SUCCESS

    def cancel(self) -> str:
        return 'sys_stats_pub cancel requested'
