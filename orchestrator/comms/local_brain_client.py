"""Persistent WebSocket client to the local vision brain (Qwen VLM).

Speaks the brain's native JSON protocol ({type, payload}), NOT rosbridge.
Sends chat_in goals, captures chat_out replies, and forwards brain_event
messages to a callback for dashboard integration.

Usage:
    client = LocalBrainClient("ws://localhost:8765")
    client.on_brain_event = my_callback  # called with (event_type, data)
    await client.connect()
    result = await client.send_goal("find the water bottle")
    state = await client.get_state()
    await client.close()
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import websockets

log = logging.getLogger(__name__)


class LocalBrainClient:
    """Lightweight WS client that sends goals to the local brain server."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._connected = False
        self._current_goal: str | None = None
        self._last_reply: str | None = None
        self._last_observation: str | None = None
        self._listen_task: asyncio.Task | None = None
        self._reply_event = asyncio.Event()
        # Callback for brain events: async fn(event_type: str, data: dict)
        self.on_brain_event: Callable[[str, dict], Any] | None = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        try:
            self._ws = await websockets.connect(
                self._url, max_size=2_000_000, ping_interval=30,
            )
            self._connected = True
            self._listen_task = asyncio.create_task(self._listen_loop())
            log.info("LocalBrainClient connected to %s", self._url)
            return True
        except Exception as exc:
            log.warning("LocalBrainClient connect failed: %s", exc)
            self._connected = False
            return False

    async def _ensure_connected(self) -> bool:
        if self._ws and self._connected:
            return True
        log.info("LocalBrainClient reconnecting to %s ...", self._url)
        return await self.connect()

    async def _listen_loop(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue

                msg_type = msg.get("type")
                payload = msg.get("payload") or {}

                if msg_type == "chat_out":
                    text = payload.get("message") or ""
                    self._last_reply = text
                    self._reply_event.set()

                elif msg_type == "brain_event":
                    event = payload.get("event", "unknown")
                    data = payload.get("data", {})
                    ts = payload.get("timestamp", 0)

                    # Update local state from events
                    if event == "decision":
                        self._last_observation = data.get("observation", "")

                    # Forward to callback
                    if self.on_brain_event:
                        try:
                            result = self.on_brain_event(event, data, ts)
                            if asyncio.iscoroutine(result):
                                await result
                        except Exception as exc:
                            log.warning("brain event callback error: %s", exc)

        except websockets.ConnectionClosed:
            log.warning("LocalBrainClient connection closed")
        except Exception as exc:
            log.warning("LocalBrainClient listen error: %s", exc)
        finally:
            self._connected = False

    # ------------------------------------------------------------------
    # Goal dispatch
    # ------------------------------------------------------------------

    async def send_goal(self, goal: str) -> dict:
        if not await self._ensure_connected():
            return {"success": False, "error": "cannot connect to local brain"}

        self._reply_event.clear()
        msg = json.dumps({"type": "chat_in", "payload": {"text": goal}})
        try:
            await self._ws.send(msg)
        except Exception as exc:
            self._connected = False
            return {"success": False, "error": str(exc)}

        self._current_goal = goal

        # Wait briefly for the ack chat_out from handle_chat
        ack = None
        try:
            await asyncio.wait_for(self._reply_event.wait(), timeout=2.0)
            ack = self._last_reply
        except (asyncio.TimeoutError, TimeoutError):
            ack = "(no ack within 2s — goal may still have been set)"

        log.info("LocalBrainClient goal dispatched: %s -> %s", goal, ack)
        return {"success": True, "goal": goal, "ack": ack}

    async def get_state(self) -> dict:
        return {
            "connected": self._connected,
            "current_goal": self._current_goal,
            "last_reply": self._last_reply,
            "last_observation": self._last_observation,
        }

    async def close(self) -> None:
        if self._listen_task:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()
        self._connected = False
        log.info("LocalBrainClient closed")
