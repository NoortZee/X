"""orchestrator.py — async replay (NO frame gate). v7.6.

v7.6:
  * pre-check covered_by_user_tap для idx=0:
      - jc_baseline снимается в run() ДО user-tap
      - перед первым tap проверяем pump_jump_log_since(jc_baseline)
      - если user-tap уже дал jumpFn на frame ~target → covered (не тапаем)
      - это устраняет double-jump и ловит случай когда user-tap уже прыгнул

v7.5:
  * jc_baseline capture в run() до user-tap
  * pre-connect phantom в run()
  * pre_state(a0, g80) в fire log
  * OVERSHOOT_TOLERANCE = 10

v7.4:
  * Убраны jc_start / _consumed_jump_frames
  * overshoot tolerance: frames_to_go < 0 и overshoot ≤ tol → тапаем
"""
from __future__ import annotations

import logging
import statistics
import time
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger("orch")

OVERSHOOT_TOLERANCE = 10


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
        self.jc_baseline = None

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
        tail = self.agent.ring_tail(4) or []
        for r in tail:
            if int(r.get("frame", -1)) == frame:
                return {k: r.get(k) for k in
                        ("a0", "b0", "g80", "g84",
                         "px", "py", "vx", "vy")}
        return {}

    def _try_covered_by_user_tap(self, jump, target_frame) -> Optional[FireRecord]:
        """Pre-tap check: user-tap мог уже сделать jumpFn. Если так — covered,
        не тапаем (избегаем double jump и ловим случай когда user-tap уже прыгнул).
        """
        if self.jc_baseline is None:
            return None
        try:
            early = self.agent.pump_jump_log_since(self.jc_baseline) or []
        except Exception as e:
            log.warning("pump_jump_log_since(jc_baseline) failed: %s", e)
            return None
        for ej in early:
            ff = int(ej["frame"])
            if abs(ff - target_frame) <= 5:
                log.info(
                    "fired idx=%d fired@%d target=%d err=%+d "
                    "note=covered_by_user_tap (jc_baseline=%d, user-tap)",
                    jump["idx"], ff, target_frame, ff - target_frame,
                    self.jc_baseline)
                return FireRecord(
                    idx=jump["idx"], abs_frame=ff,
                    target_frame=target_frame,
                    frame_error=ff - target_frame,
                    tap_ack_ms=0.0,
                    tap_x=self.tap_x, tap_y=self.tap_y,
                    tap_count=0,
                    snap_before=jump.get("snap") or {},
                    snap_after=self._snap_at_frame(ff + 1) or {},
                    note="covered_by_user_tap",
                )
        return None

    def _fire_async(self, jump, initial_state=None) -> FireRecord:
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
        stall_s = 2.0

        # v7.6: pre-check для idx=0 — user-tap мог уже дать jumpFn
        if jump["idx"] == 0 and initial_state is not None:
            anchor_est = int(initial_state["anchor"])
            target_est = anchor_est + int(jump["frame_delta"])
            covered = self._try_covered_by_user_tap(jump, target_est)
            if covered is not None:
                return covered

        t_start = time.monotonic()
        cur_before = None
        target_frame = None
        last_cur = -1
        last_cur_t = t_start
        first_iter = True
        overshoot = 0

        while True:
            if first_iter and initial_state is not None:
                st = initial_state
                first_iter = False
            else:
                st = self.agent.play_state()
            if st.get("phase") != "playing":
                raise ReplayError(
                    f"fire idx={jump['idx']}: phase={st.get('phase')}")
            anchor = int(st["anchor"])
            target_frame = anchor + int(jump["frame_delta"])
            cur = int(st.get("frame", 0))

            now = time.monotonic()
            if cur != last_cur:
                last_cur = cur
                last_cur_t = now
            elif now - last_cur_t > stall_s:
                log.warning(
                    "fire idx=%d GAME STALLED cur=%d target=%d",
                    jump["idx"], cur, target_frame)
                return FireRecord(
                    idx=jump["idx"], abs_frame=-1,
                    target_frame=target_frame, frame_error=MISSED,
                    tap_ack_ms=0.0, tap_x=self.tap_x, tap_y=self.tap_y,
                    snap_before=jump.get("snap") or {},
                    snap_after={}, note="game_stalled",
                )

            frames_to_go = target_frame - cur

            if frames_to_go < 0:
                overshoot = -frames_to_go
                if overshoot <= OVERSHOOT_TOLERANCE:
                    # На случай если user-tap запоздал и уже прыгнул:
                    covered = self._try_covered_by_user_tap(jump, target_frame)
                    if covered is not None:
                        return covered
                    log.info(
                        "fire idx=%d cur=%d target=%d overshoot=%d ≤%d "
                        "— tapping anyway",
                        jump["idx"], cur, target_frame,
                        overshoot, OVERSHOOT_TOLERANCE)
                    cur_before = cur
                    break
                log.warning(
                    "fire idx=%d SKIP (cur=%d target=%d overshoot=%d >%d)",
                    jump["idx"], cur, target_frame,
                    overshoot, OVERSHOOT_TOLERANCE)
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
                log.warning(
                    "fire idx=%d SKIP deadline (cur=%d target=%d)",
                    jump["idx"], cur, target_frame)
                return FireRecord(
                    idx=jump["idx"], abs_frame=-1,
                    target_frame=target_frame, frame_error=MISSED,
                    tap_ack_ms=0.0, tap_x=self.tap_x, tap_y=self.tap_y,
                    snap_before=jump.get("snap") or {},
                    snap_after={}, note="deadline_skipped",
                )

        # pre_state диагностика
        pre_state = {}
        try:
            tail = self.agent.ring_tail(1) or [{}]
            pre_state = tail[-1] if tail else {}
        except Exception:
            pass

        log.info(
            "fire idx=%d cur=%d target=%d frames_to_go=%d overshoot=%d "
            "lead=%d tap=(%d,%d) pre_state(a0=%s g80=%s)",
            jump["idx"], cur_before, target_frame,
            target_frame - cur_before, overshoot, int(lead_ms),
            self.tap_x, self.tap_y,
            pre_state.get("a0"), pre_state.get("g80"))

        # для idx=0 используем baseline (0), для остальных — текущий count
        if jump["idx"] == 0 and self.jc_baseline is not None:
            jc_before = self.jc_baseline
        else:
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

        # Pre-connect phantom (экономит 5-10 мс на первом tap)
        try:
            self.phantom.connect()
            log.info("phantom pre-connected")
        except Exception as e:
            log.warning("phantom pre-connect failed: %s", e)

        # Baseline jump count до пользовательского тапа
        try:
            self.jc_baseline = int(self.agent.pump_jump_count())
        except Exception as e:
            log.warning("pump_jump_count baseline failed: %s", e)
            self.jc_baseline = None

        o = self.cfg["orchestrator"]
        log.info(
            "playSetup: anchor=%s@%s jumps=%d lead=%dms check=%dms retry=%s "
            "overshoot_tol=%d jc_baseline=%s",
            anchor_kind, anchor_rec, len(plan),
            o["predict_lead_ms"], o["post_tap_check_ms"],
            o.get("retry_on_miss", False), OVERSHOOT_TOLERANCE,
            self.jc_baseline)
        log.info("tap position: (%d, %d)", self.tap_x, self.tap_y)

        self._wall0 = time.monotonic()
        st = self._wait_playing()

        for i, j in enumerate(plan):
            if time.monotonic() - self._wall0 > o["wall_timeout_s"]:
                raise ReplayError(
                    f"wall_timeout (fired={len(self.fire_log)}/{len(plan)})")
            fr = self._fire_async(j, initial_state=st if i == 0 else None)
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
            "mode": "async_no_gate_v7.6",
            "anchor_kind": anchor_kind,
            "anchor_rec": anchor_rec,
            "tap_xy": [self.tap_x, self.tap_y],
            "jumps_planned": len(plan),
            "jumps_fired": sum(1 for fr in self.fire_log if fr.frame_error != MISSED),
            "jumps_missed": sum(1 for fr in self.fire_log if fr.frame_error == MISSED),
            "covered_by_user_tap": sum(
                1 for fr in self.fire_log if fr.note == "covered_by_user_tap"),
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
