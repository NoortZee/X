"""orchestrator.py — async replay (NO frame gate). v6.2.

Changes vs v6.1:
  * fire at cur == target (не target-1)
  * _is_jump_transition поддерживает combo (a0:1→2, 2→4)
  * allow frames_to_go == 0
  * poll_interval_ms из config (было хардкод 2 ms → 5 ms)
  * f_max = target + 8 (для delayed detection)
  * v7.0: JUMP-hook детекция (pumpJumpCount) + retry при MISSED
"""
from __future__ import annotations

import logging
import statistics
import time
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger("orch")


def find_anchor(events, body_frames):
    for e in events:
        if e.get("name") == "first_hero_update":
            return ("first_hero_update", int(e["frame"]))
    if body_frames:
        return ("first_body_frame", int(body_frames[0]["frame"]))
    for e in events:
        if e.get("name") in ("unfreeze", "unfreeze_attack"):
            return ("unfreeze", int(e["frame"]))
    return (None, None)


def build_plan(events, anchor_rec_frame):
    jumps = sorted(
        [e for e in events if e.get("name") == "jump"],
        key=lambda e: e["frame"],
    )
    return [
        {"idx": i, "rec_frame": int(j["frame"]),
         "frame_delta": max(0, int(j["frame"]) - int(anchor_rec_frame)),
         "snap": j.get("snap") or {}}
        for i, j in enumerate(jumps)
    ]


def resolve_tap(cfg):
    t = cfg["tap"]
    if t["position"] == "explicit":
        return int(t["x"]), int(t["y"])
    if t["position"] == "center_lower_third":
        return (int(int(t["screen_width"]) // 2),
                int(int(t["screen_height"]) * 2 // 3))
    raise ValueError(f"unknown tap.position={t['position']}")


class ReplayError(RuntimeError):
    pass


MISSED = -99999


@dataclass
class FireRecord:
    idx: int
    abs_frame: int
    target_frame: int
    frame_error: int
    tap_ack_ms: float
    tap_x: int = 0
    tap_y: int = 0
    tap_count: int = 0
    snap_before: dict = field(default_factory=dict)
    snap_after: dict = field(default_factory=dict)
    note: str = ""


class Orchestrator:
    def __init__(self, cfg, agent, phantom, replay):
        self.cfg = cfg
        self.agent = agent
        self.phantom = phantom
        self.replay = replay
        self.events = replay.get("events", []) or []
        self.body_frames = replay.get("body_frames", []) or []
        self.fire_log: list[FireRecord] = []
        self.tap_x, self.tap_y = resolve_tap(cfg)
        self._wall0 = None

    def _wait_playing(self):
        o = self.cfg["orchestrator"]
        t0 = time.monotonic()
        while True:
            st = self.agent.play_state()
            phase = st.get("phase")
            if phase == "playing":
                return st
            if phase == "idle":
                raise ReplayError("play setup not initialised")
            if time.monotonic() - t0 > o["wall_timeout_s"]:
                raise ReplayError(f"wall_timeout (phase={phase})")
            time.sleep(o["poll_interval_ms"] / 1000.0)

    def _snap_at_frame(self, frame: int) -> dict:
        tail = self.agent.ring_tail(120) or []
        for r in tail:
            if int(r.get("frame", -1)) == frame:
                return {k: r.get(k) for k in
                        ("a0", "b0", "g80", "g84",
                         "px", "py", "vx", "vy")}
        return {}

    def _fire_async(self, jump) -> FireRecord:
        o = self.cfg["orchestrator"]
        lead_ms = float(o["predict_lead_ms"])
        margin_ms = float(o["predict_margin_ms"])
        fps = float(o["nominal_fps"])
        check_ms = float(o["post_tap_check_ms"])
        hard_s = float(o["fire_hard_deadline_s"])
        retry_on_miss = bool(o.get("retry_on_miss", False))
        retry_delay_ms = float(o.get("retry_delay_ms", 50))
        trigger_at_ms = lead_ms + margin_ms
        poll_s = o["poll_interval_ms"] / 1000.0

        t_start = time.monotonic()
        cur_before = None
        target_frame = None
        while True:
            st = self.agent.play_state()
            if st.get("phase") != "playing":
                raise ReplayError(
                    f"fire idx={jump['idx']}: phase={st.get('phase')}")
            anchor = int(st["anchor"])
            target_frame = anchor + int(jump["frame_delta"])
            cur = int(st.get("frame", 0))
            frames_to_go = target_frame - cur

            if frames_to_go < 0:
                log.warning(
                    "fire idx=%d SKIP (cur=%d > target=%d)",
                    jump["idx"], cur, target_frame)
                return FireRecord(
                    idx=jump["idx"], abs_frame=-1,
                    target_frame=target_frame, frame_error=MISSED,
                    tap_ack_ms=0.0, tap_x=self.tap_x, tap_y=self.tap_y,
                    snap_before=jump.get("snap") or {},
                    snap_after={}, note="skipped_past_target",
                )

            ttm_ms = frames_to_go * 1000.0 / fps
            if ttm_ms <= trigger_at_ms:
                cur_before = cur
                break

            time.sleep(poll_s)
            if time.monotonic() - t_start > hard_s:
                raise ReplayError(
                    f"fire idx={jump['idx']}: deadline (cur={cur})")

        log.info(
            "fire idx=%d cur=%d target=%d frames_to_go=%d lead=%d tap=(%d,%d)",
            jump["idx"], cur_before, target_frame,
            target_frame - cur_before, int(lead_ms),
            self.tap_x, self.tap_y)

        try:
            jc_before = int(self.agent.pump_jump_count())
        except Exception as e:
            raise ReplayError(f"pump_jump_count failed: {e}")

        total_taps = 0
        total_tap_ms = 0.0
        new_jumps = []

        max_attempts = 2 if retry_on_miss else 1
        for attempt in range(1, max_attempts + 1):
            tr = self.phantom.tap(self.tap_x, self.tap_y)
            if not tr.ok:
                raise ReplayError(f"phantom tap failed: {tr.error}")
            total_taps += 1
            total_tap_ms += tr.duration_ms

            time.sleep(check_ms / 1000.0)

            try:
                jc_after = int(self.agent.pump_jump_count())
                new_jumps = self.agent.pump_jump_log_since(jc_before) or []
            except Exception as e:
                raise ReplayError(f"pump_jump_log_since failed: {e}")

            if new_jumps:
                break

            if attempt < max_attempts:
                log.warning(
                    "fired idx=%d attempt=%d no jumpFn, retry in %.0fms",
                    jump["idx"], attempt, retry_delay_ms)
                time.sleep(retry_delay_ms / 1000.0)
                jc_before = jc_after

        if not new_jumps:
            log.warning(
                "fired idx=%d MISSED target=%d taps=%d tap_ms=%.2f",
                jump["idx"], target_frame, total_taps, total_tap_ms)
            return FireRecord(
                idx=jump["idx"], abs_frame=-1,
                target_frame=target_frame, frame_error=MISSED,
                tap_ack_ms=total_tap_ms, tap_x=self.tap_x, tap_y=self.tap_y,
                tap_count=total_taps,
                snap_before=jump.get("snap") or {},
                snap_after={}, note="missed_no_jumpfn",
            )

        if len(new_jumps) > 1:
            log.warning(
                "fired idx=%d MULTI-JUMP count=%d frames=%s",
                jump["idx"], len(new_jumps),
                [int(j["frame"]) for j in new_jumps])
        fired_frame = min(
            (int(j["frame"]) for j in new_jumps),
            key=lambda f: abs(f - target_frame))
        frame_error = fired_frame - target_frame
        snap_after = self._snap_at_frame(fired_frame + 1) or \
                     self._snap_at_frame(fired_frame)

        log.info(
            "fired idx=%d fired@%d target=%d err=%+d tap=%.2fms taps=%d "
            "snap_after(a0=%s g80=%s)",
            jump["idx"], fired_frame, target_frame, frame_error,
            total_tap_ms, total_taps,
            snap_after.get("a0"), snap_after.get("g80"))

        return FireRecord(
            idx=jump["idx"], abs_frame=fired_frame,
            target_frame=target_frame, frame_error=frame_error,
            tap_ack_ms=total_tap_ms, tap_x=self.tap_x, tap_y=self.tap_y,
            tap_count=total_taps,
            snap_before=jump.get("snap") or {},
            snap_after=snap_after, note="async_no_gate",
        )

    def run(self) -> dict:
        anchor_kind, anchor_rec = find_anchor(self.events, self.body_frames)
        if anchor_kind is None:
            raise ReplayError("no anchor")
        plan = build_plan(self.events, anchor_rec)
        if not plan:
            raise ReplayError("no jumps")

        setup = self.agent.play_setup(
            self.events, {"body_frames": self.body_frames})
        if not setup.get("ok"):
            raise ReplayError(f"playSetup failed: {setup}")

        o = self.cfg["orchestrator"]
        log.info(
            "playSetup: anchor=%s@%s jumps=%d lead=%dms check=%dms retry=%s",
            anchor_kind, anchor_rec, len(plan),
            o["predict_lead_ms"], o["post_tap_check_ms"],
            o.get("retry_on_miss", False))
        log.info("tap position: (%d, %d)", self.tap_x, self.tap_y)

        self._wall0 = time.monotonic()
        self._wait_playing()

        for j in plan:
            if time.monotonic() - self._wall0 > o["wall_timeout_s"]:
                raise ReplayError(
                    f"wall_timeout (fired={len(self.fire_log)}/{len(plan)})")
            fr = self._fire_async(j)
            self.fire_log.append(fr)

        verify_bf = {}
        if o.get("verify_body_frames", False):
            try:
                verify_bf = self.agent.play_verify()
            except Exception as e:
                log.warning("play_verify: %s", e)

        durations = [fr.tap_ack_ms for fr in self.fire_log] or [0.0]
        errors = [fr.frame_error for fr in self.fire_log if fr.frame_error != MISSED]
        abs_errors = [abs(e) for e in errors]
        tap_counts = [fr.tap_count for fr in self.fire_log] or [0]

        report = {
            "ok": True,
            "mode": "async_no_gate_v7.0",
            "anchor_kind": anchor_kind,
            "anchor_rec": anchor_rec,
            "tap_xy": [self.tap_x, self.tap_y],
            "jumps_planned": len(plan),
            "jumps_fired": sum(1 for fr in self.fire_log if fr.frame_error != MISSED),
            "jumps_missed": sum(1 for fr in self.fire_log if fr.frame_error == MISSED),
            "retries": sum(1 for tc in tap_counts if tc > 1),
            "frame_error_stats": {
                "min": min(errors) if errors else None,
                "med": statistics.median(errors) if errors else None,
                "max": max(errors) if errors else None,
                "abs_med": statistics.median(abs_errors) if abs_errors else None,
                "abs_max": max(abs_errors) if abs_errors else None,
            },
            "tap_stats_ms": {
                "min": min(durations),
                "med": statistics.median(durations),
                "max": max(durations),
            },
            "fired_log": [fr.__dict__ for fr in self.fire_log],
            "verify_body_frames": verify_bf,
            "elapsed_s": time.monotonic() - self._wall0,
        }

        try:
            self.agent.play_stop()
        except Exception:
            pass
        return report
