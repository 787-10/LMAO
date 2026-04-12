"""Channel S — command-driven fault injection.

Subscribes to /lmao/fdir/inject (std_msgs/String, JSON).
Publishes active faults on /lmao/fdir/active_faults.

Command format:
  {"action": "inject", "fault": "lidar_occlude", "params": {"sector_min": 60, "sector_max": 120}}
  {"action": "inject", "fault": "camera_freeze"}
  {"action": "inject", "fault": "encoder_drift", "params": {"joint": 2, "offset_deg": 5.0}}
  {"action": "inject", "fault": "node_kill", "params": {"topic": "/scan"}}
  {"action": "clear", "fault": "lidar_occlude"}
  {"action": "clear_all"}
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from lmao_fdir.transport import Transport

log = logging.getLogger(__name__)

VALID_FAULTS = {
    "lidar_occlude",
    "camera_freeze",
    "encoder_drift",
    "node_kill",
    "comms_delay",
    "battery_drain",
}


class FaultInjector:
    """Manages injected faults.  Other channels can query active faults."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._active: dict[str, dict[str, Any]] = {}  # fault_id -> {fault, params, injected_at}

    def start(self) -> None:
        self._transport.subscribe(
            "/lmao/fdir/inject",
            "std_msgs/String",
            self._on_command,
        )
        self._transport.create_timer(1.0, self._publish_status)

    def _on_command(self, msg: dict) -> None:
        raw = msg.get("data", "")
        try:
            cmd = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            log.warning("Invalid fault injection command: %s", raw)
            return

        action = cmd.get("action", "")
        fault = cmd.get("fault", "")
        params = cmd.get("params", {})

        if action == "inject":
            if fault not in VALID_FAULTS:
                log.warning("Unknown fault type: %s", fault)
                return
            self._active[fault] = {
                "fault": fault,
                "params": params,
                "injected_at": time.time(),
            }
            log.info("FAULT INJECTED: %s params=%s", fault, params)

        elif action == "clear":
            if fault in self._active:
                del self._active[fault]
                log.info("FAULT CLEARED: %s", fault)

        elif action == "clear_all":
            self._active.clear()
            log.info("ALL FAULTS CLEARED")

        else:
            log.warning("Unknown action: %s", action)

    def _publish_status(self) -> None:
        faults_list = list(self._active.values())
        self._transport.publish(
            "/lmao/fdir/active_faults",
            "std_msgs/String",
            {"data": json.dumps(faults_list)},
        )

    # -- Query API for other channels --

    def get_active_faults(self) -> dict[str, dict[str, Any]]:
        return dict(self._active)

    def is_fault_active(self, fault_id: str) -> bool:
        return fault_id in self._active

    def get_fault_params(self, fault_id: str) -> dict[str, Any]:
        entry = self._active.get(fault_id)
        return entry.get("params", {}) if entry else {}
