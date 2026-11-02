"""phantom_bridge.py — TCP client for Phantom's binary frame protocol.

Protocol (little-endian):
    TOUCH_DOWN   0x00  slot(u8) x(i32) y(i32)
    TOUCH_MOVE   0x01  slot(u8) x(i32) y(i32)
    TOUCH_UP     0x02  slot(u8)
    TOUCH_CANCEL 0x03  slot(u8)
    KEY_DOWN     0x04
    KEY_UP       0x05
    PING         0x7f

v1.2: tap() retries once on BrokenPipeError / ConnectionResetError.
"""
from __future__ import annotations

import logging
import socket
import struct
import time
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger("phantom")


class PhantomError(RuntimeError):
    pass


@dataclass
class TapResult:
    ok: bool
    duration_ms: float
    sync_mode: str
    slot: int
    x: int
    y: int
    error: Optional[str] = None


class PhantomBridge:
    def __init__(self, cfg: dict):
        self.host = cfg["host"]
        self.port = int(cfg["port"])
        self.slot = int(cfg.get("slot", 0))
        self.down_up_ms = int(cfg.get("tap_down_to_up_ms", 1))
        self.post_wait_ms = int(cfg.get("post_tap_wait_ms", 0))
        self.sync_mode = cfg.get("sync_mode", "async")
        if self.sync_mode not in ("async", "wait_for_finish"):
            raise PhantomError(f"unsupported sync_mode={self.sync_mode}")
        self.connect_timeout = cfg.get("connect_timeout_ms", 2000) / 1000.0
        self.ping_timeout = cfg.get("ping_timeout_ms", 1000) / 1000.0
        self.sock: Optional[socket.socket] = None

    def connect(self) -> None:
        if self.sock is not None:
            return
        try:
            self.sock = socket.create_connection(
                (self.host, self.port), timeout=self.connect_timeout
            )
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            log.info("connected to Phantom %s:%d", self.host, self.port)
        except OSError as e:
            raise PhantomError(f"connect failed: {e}") from e
        self._ping()

    def _ping(self) -> None:
        assert self.sock is not None
        try:
            self.sock.sendall(b"\x7f")
            self.sock.settimeout(self.ping_timeout)
            try:
                self.sock.recv(1)
            except socket.timeout:
                pass
            finally:
                self.sock.settimeout(None)
        except OSError:
            pass

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_):
        self.close()

    def _send_down(self, x: int, y: int) -> None:
        assert self.sock is not None
        self.sock.sendall(struct.pack("<BBii", 0x00, self.slot, int(x), int(y)))

    def _send_up(self) -> None:
        assert self.sock is not None
        self.sock.sendall(struct.pack("<BB", 0x02, self.slot))

    def tap(self, x: int, y: int, _retry: bool = True) -> TapResult:
        t0 = time.perf_counter()
        try:
            self.connect()
            if self.down_up_ms <= 0:
                self.sock.sendall(
                    struct.pack("<BBii", 0x00, self.slot, int(x), int(y))
                    + struct.pack("<BB", 0x02, self.slot)
                )
            else:
                self._send_down(x, y)
                time.sleep(self.down_up_ms / 1000.0)
                self._send_up()

            if self.sync_mode != "wait_for_finish" and self.post_wait_ms > 0:
                time.sleep(self.post_wait_ms / 1000.0)

            return TapResult(
                True, (time.perf_counter() - t0) * 1000,
                self.sync_mode, self.slot, x, y,
            )
        except (BrokenPipeError, ConnectionResetError) as e:
            self.close()
            log.warning("phantom connection broken (%s), reconnecting", e)
            if _retry:
                try:
                    self.connect()
                    return self.tap(x, y, _retry=False)
                except Exception as e2:
                    log.error("phantom reconnect failed: %s", e2)
                    return TapResult(
                        False, (time.perf_counter() - t0) * 1000,
                        self.sync_mode, self.slot, x, y,
                        error=f"reconnect_failed: {e2}")
            return TapResult(
                False, (time.perf_counter() - t0) * 1000,
                self.sync_mode, self.slot, x, y, error=str(e))
        except OSError as e:
            self.close()
            log.error("tap failed: %s", e)
            return TapResult(
                False, (time.perf_counter() - t0) * 1000,
                self.sync_mode, self.slot, x, y, error=str(e))
