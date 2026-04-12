"""Channel L — frozen camera feed detection.

Computes mean absolute difference between consecutive frames.
If diff < threshold for N consecutive seconds → FROZEN.
Publishes /lmao/fdir/camera_health at 1 Hz.
"""
from __future__ import annotations

import base64
import json
import time
from typing import Any

from lmao_fdir.transport import Transport

FROZEN_THRESHOLD = 1.5       # mean pixel diff below this = "same frame"
FROZEN_SECONDS = 3.0         # must stay frozen for this long to flag
GLITCH_THRESHOLD = 100.0     # sudden huge diff = glitch/cut
CAMERA_TOPIC = "/mars/main_camera/left/image_raw/compressed"


class FrozenFeed:
    """Detects camera freeze by frame-to-frame pixel diff."""

    def __init__(self, transport: Transport, topic: str = CAMERA_TOPIC) -> None:
        self._transport = transport
        self._topic = topic
        self._prev_gray: Any = None  # numpy array or None
        self._frozen_since: float | None = None
        self._last_diff: float = 0.0
        self._status = "NOMINAL"
        self._frame_count = 0

    def start(self) -> None:
        self._transport.subscribe(
            self._topic,
            "sensor_msgs/CompressedImage",
            self._on_image,
        )
        self._transport.create_timer(1.0, self._publish)

    def _on_image(self, msg: dict) -> None:
        """Process a compressed image frame."""
        try:
            import numpy as np

            # Decode compressed image to grayscale
            data = msg.get("data")
            if data is None:
                return

            # data can be base64 string or byte array
            if isinstance(data, str):
                raw = base64.b64decode(data)
            elif isinstance(data, list):
                raw = bytes(data)
            else:
                raw = data

            # Decode JPEG/PNG to numpy
            arr = np.frombuffer(raw, dtype=np.uint8)
            try:
                import cv2
                img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
            except ImportError:
                # Fallback without opencv: just use raw byte stats
                img = arr

            if img is None:
                return

            self._frame_count += 1
            now = time.monotonic()

            if self._prev_gray is not None and img.shape == self._prev_gray.shape:
                diff = float(np.abs(img.astype(np.float32) - self._prev_gray.astype(np.float32)).mean())
                self._last_diff = diff

                if diff < FROZEN_THRESHOLD:
                    if self._frozen_since is None:
                        self._frozen_since = now
                    elif (now - self._frozen_since) >= FROZEN_SECONDS:
                        self._status = "FROZEN"
                elif diff > GLITCH_THRESHOLD:
                    self._status = "GLITCH"
                    self._frozen_since = None
                else:
                    self._status = "NOMINAL"
                    self._frozen_since = None
            else:
                self._frozen_since = None

            self._prev_gray = img

        except Exception:
            pass  # Don't crash the FDIR system on a bad frame

    def _publish(self) -> None:
        frozen_s = 0.0
        if self._frozen_since is not None:
            frozen_s = time.monotonic() - self._frozen_since

        report = {
            "topic": self._topic,
            "status": self._status,
            "diff_mean": round(self._last_diff, 2),
            "frozen_seconds": round(frozen_s, 1),
            "frame_count": self._frame_count,
        }
        self._transport.publish(
            "/lmao/fdir/camera_health",
            "std_msgs/String",
            {"data": json.dumps(report)},
        )

    def get_status(self) -> str:
        return self._status

    def is_frozen(self) -> bool:
        return self._status == "FROZEN"
