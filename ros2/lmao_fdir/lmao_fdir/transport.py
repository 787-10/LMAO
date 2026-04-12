"""Transport abstraction — run FDIR channels on rclpy OR roslibpy.

On-robot:  RclpyTransport wraps an rclpy.Node
Off-robot: RoslibpyTransport wraps a roslibpy.Ros client

Both normalise messages to plain dicts so channel logic is identical.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Callable

log = logging.getLogger(__name__)

MsgCallback = Callable[[dict[str, Any]], None]
TimerCallback = Callable[[], None]


class Transport(ABC):
    """Thin shim over either rclpy or roslibpy."""

    @abstractmethod
    def subscribe(
        self,
        topic: str,
        msg_type: str,
        callback: MsgCallback,
        throttle_hz: float | None = None,
    ) -> None: ...

    @abstractmethod
    def publish(self, topic: str, msg_type: str, msg: dict) -> None: ...

    @abstractmethod
    def create_timer(self, period_s: float, callback: TimerCallback) -> None: ...

    @abstractmethod
    def now(self) -> float:
        """Monotonic time in seconds."""
        ...


# ------------------------------------------------------------------
# rclpy transport (on-robot)
# ------------------------------------------------------------------

class RclpyTransport(Transport):
    """Wraps an rclpy.Node.  Messages arrive as ROS2 msg objects —
    we convert to dicts via the built-in message_to_ordereddict helper."""

    def __init__(self, node: Any) -> None:  # rclpy.node.Node
        self._node = node
        self._pubs: dict[str, Any] = {}

    def subscribe(
        self,
        topic: str,
        msg_type: str,
        callback: MsgCallback,
        throttle_hz: float | None = None,
    ) -> None:
        from rclpy.qos import QoSProfile, ReliabilityPolicy
        qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT)

        ros_type = _resolve_ros_type(msg_type)

        def _cb(msg: Any) -> None:
            d = _ros_msg_to_dict(msg)
            callback(d)

        self._node.create_subscription(ros_type, topic, _cb, qos)

    def publish(self, topic: str, msg_type: str, msg: dict) -> None:
        if topic not in self._pubs:
            ros_type = _resolve_ros_type(msg_type)
            self._pubs[topic] = self._node.create_publisher(ros_type, topic, 10)

        ros_type = _resolve_ros_type(msg_type)
        if msg_type == "std_msgs/String":
            from std_msgs.msg import String
            ros_msg = String(data=json.dumps(msg) if not isinstance(msg.get("data"), str) else msg["data"])
        else:
            ros_msg = _dict_to_ros_msg(ros_type, msg)
        self._pubs[topic].publish(ros_msg)

    def create_timer(self, period_s: float, callback: TimerCallback) -> None:
        self._node.create_timer(period_s, callback)

    def now(self) -> float:
        return time.monotonic()


# ------------------------------------------------------------------
# roslibpy transport (off-robot)
# ------------------------------------------------------------------

class RoslibpyTransport(Transport):
    """Wraps a roslibpy.Ros client.  Messages are already dicts."""

    def __init__(self, client: Any) -> None:  # roslibpy.Ros
        import roslibpy
        self._client: roslibpy.Ros = client
        self._timers: list[threading.Timer] = []
        self._pubs: dict[str, Any] = {}

    def subscribe(
        self,
        topic: str,
        msg_type: str,
        callback: MsgCallback,
        throttle_hz: float | None = None,
    ) -> None:
        import roslibpy
        listener = roslibpy.Topic(self._client, topic, msg_type)

        if throttle_hz:
            listener.subscribe(callback, throttle_rate=int(1000 / throttle_hz))
        else:
            listener.subscribe(callback)

    def publish(self, topic: str, msg_type: str, msg: dict) -> None:
        import roslibpy
        if topic not in self._pubs:
            self._pubs[topic] = roslibpy.Topic(self._client, topic, msg_type)
            self._pubs[topic].advertise()
        self._pubs[topic].publish(roslibpy.Message(msg))

    def create_timer(self, period_s: float, callback: TimerCallback) -> None:
        def _loop() -> None:
            while True:
                time.sleep(period_s)
                try:
                    callback()
                except Exception:
                    log.exception("Timer callback error")

        t = threading.Thread(target=_loop, daemon=True)
        t.start()

    def now(self) -> float:
        return time.monotonic()


# ------------------------------------------------------------------
# Helpers for rclpy type resolution
# ------------------------------------------------------------------

_TYPE_CACHE: dict[str, Any] = {}


def _resolve_ros_type(msg_type: str) -> Any:
    """Resolve 'sensor_msgs/LaserScan' or 'std_msgs/String' to a Python class."""
    if msg_type in _TYPE_CACHE:
        return _TYPE_CACHE[msg_type]

    # Normalise: 'sensor_msgs/LaserScan' -> ('sensor_msgs.msg', 'LaserScan')
    parts = msg_type.replace("/msg/", "/").split("/")
    if len(parts) == 2:
        pkg, cls_name = parts
    else:
        raise ValueError(f"Cannot parse msg_type: {msg_type}")

    import importlib
    mod = importlib.import_module(f"{pkg}.msg")
    cls = getattr(mod, cls_name)
    _TYPE_CACHE[msg_type] = cls
    return cls


def _ros_msg_to_dict(msg: Any) -> dict:
    """Convert a ROS2 message to a plain dict (recursive)."""
    from rclpy.serialization import serialize_message
    # Fast path: use rosidl if available
    try:
        from rosidl_runtime_py import message_to_ordereddict
        return dict(message_to_ordereddict(msg))
    except ImportError:
        pass

    # Fallback: manual attribute extraction
    result = {}
    for field_name in msg.get_fields_and_field_types():
        val = getattr(msg, field_name)
        if hasattr(val, "get_fields_and_field_types"):
            result[field_name] = _ros_msg_to_dict(val)
        elif isinstance(val, (list, tuple)):
            result[field_name] = list(val)
        else:
            result[field_name] = val
    return result


def _dict_to_ros_msg(ros_type: Any, d: dict) -> Any:
    """Best-effort dict → ROS2 message."""
    msg = ros_type()
    for key, val in d.items():
        if hasattr(msg, key):
            setattr(msg, key, val)
    return msg
