#!/usr/bin/env python3
r'''main.py — CLI for King of Thieves TAS (Phantom + Frida, async v6.1).

FPS-optimized: pump_install вызывается ЛЕНИВО — только в record/play/calibrate.
Idle-режим (после attach, до действий) — без Interceptor на FRAME_FUNC.

Логи:
  * в logs/ хранится только replay.json;
  * .log-файлы не создаются;
  * play_*.json не создаются;
  * replay.json перезаписывается при каждом record;
  * преамбула обёрнута в тройные кавычки — удобно копировать:
        """
        jumps: N
        anchor: <kind>@<frame>
        fps: 60
        tap_down_ms: 1

        // задержка загрузки уровня и input lag примерно +26 мс
        SLEEP_U16 <ms>
        PRESS_MK hidmouse_0
        SLEEP_U16 <tap_down_ms>
        RELEASE_MK hidmouse_0
        //
        ...
        """
        {
          "version": 3,
          ...
        }
    Макрос НЕ печатается в консоль.
'''
from __future__ import annotations

import json
import logging
import sys
import threading
import time
from pathlib import Path

import frida
import yaml

from phantom_bridge import PhantomBridge, PhantomError
from orchestrator import (
    Orchestrator,
    ReplayError,
    MISSED,
    find_anchor,
    build_plan,
    resolve_tap,
)

PROJECT = Path(__file__).resolve().parent
CFG_PATH = PROJECT / "config.yaml"
LOG_DIR = PROJECT / "logs"
REPLAY_PATH = LOG_DIR / "replay.json"

_done = threading.Event()
_done_status = {"error": None}

PRINT_TYPES = {
    "event", "detect_started", "detect_stopped", "detect_installed",
    "pump_installed", "pump_already", "module_base", "fatal",
    "play_phase", "play_armed", "play_done", "gate_released",
    "jump_monitor_installed",
    "onframe_error", "dbg",
}

log = logging.getLogger("main")


def setup_logging(level: str = "INFO") -> None:
    """Только консоль. Файловые .log больше не создаются."""
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    root = logging.getLogger()
    root.setLevel(getattr(logging, level, logging.INFO))

    for h in list(root.handlers):
        root.removeHandler(h)
        try:
            h.close()
        except Exception:
            pass

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.addHandler(sh)


def prune_logs_dir() -> None:
    """Оставляем в logs/ только replay.json. Всё остальное удаляем."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    for p in LOG_DIR.iterdir():
        if p.name == REPLAY_PATH.name:
            continue
        if p.is_file():
            try:
                p.unlink()
            except OSError:
                pass


def load_config() -> dict:
    if not CFG_PATH.exists():
        raise SystemExit(f"config not found: {CFG_PATH}")
    with open(CFG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


class Agent:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.session = None
        self.script = None
        self._pump_installed = False

    def attach(self) -> None:
        device = frida.get_device_manager().add_remote_device(
            self.cfg["frida"]["device"]
        )
        last_err = None
        for target in (self.cfg["frida"]["package"], "King of Thieves"):
            try:
                self.session = device.attach(target)
                log.info("attached by name: %s", target)
                break
            except frida.ProcessNotFoundError as e:
                last_err = e
        if self.session is None:
            for p in device.enumerate_processes():
                if "thieves" in p.name.lower():
                    self.session = device.attach(p.pid)
                    log.info("attached by PID %d: %s", p.pid, p.name)
                    break
        if self.session is None:
            raise last_err or RuntimeError("game not running")

        src = (PROJECT / "agent.js").read_text(encoding="utf-8")
        self.script = self.session.create_script(src)
        self.script.on("message", self._on_msg)
        self.script.load()
        # ВАЖНО: pump_install НЕ вызываем здесь. Слишком дорого для idle.
        # detect_install дёшев (только 3 event hooks, не per-frame).
        self.script.exports_sync.detect_install()

    def ensure_pump(self) -> None:
        """Lazy pump_install — вызывать перед record/play/calibrate."""
        if self._pump_installed:
            return
        self.script.exports_sync.pump_install()
        self._pump_installed = True
        log.info("pump installed (lazy)")

    def _on_msg(self, msg, _data):
        if msg["type"] == "send":
            p = msg["payload"] or {}
            t = p.get("type")
            if t in PRINT_TYPES:
                log.info("[agent] %s", p)
            if t == "fatal":
                _done_status["error"] = p.get("msg")
                _done.set()
        else:
            log.error("[frida] %s", msg)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        def _call(*a, **kw):
            return getattr(self.script.exports_sync, name)(*a, **kw)
        return _call

    def close(self):
        if self.session:
            try:
                self.session.detach()
            except Exception:
                pass


def load_replay(path: Path = REPLAY_PATH) -> dict:
    r'''Читает replay.json.

    Всё до первого '{' считается преамбулой (блок с макросом) и
    пропускается. JSON-объект начинается с '{'.
    '''
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    brace = text.find("{")
    if brace < 0:
        return {}
    raw = text[brace:].strip()
    if not raw:
        return {}
    return json.loads(raw)


def build_macro_script(events, anchor, fps, tap_down_ms=1):
    """Строит текстовый скрипт в формате Phantom KeyMapper.

    // задержка загрузки уровня и input lag примерно +26 мс
    SLEEP_U16 <ms>
    PRESS_MK hidmouse_0
    SLEEP_U16 <tap_down_ms>
    RELEASE_MK hidmouse_0
    //

    Время считается по frame_delta от anchor при nominal_fps.
    """
    if anchor is None:
        return ""
    jumps = sorted(
        (e for e in events if e.get("name") == "jump"),
        key=lambda e: int(e["frame"]),
    )
    if not jumps:
        return ""
    fps = float(fps) if fps and fps > 0 else 60.0
    tap_down_ms = max(1, int(tap_down_ms))

    lines = []
    prev = int(anchor)
    first = True
    for j in jumps:
        frame = int(j["frame"])
        delta = frame - prev
        if delta < 0:
            delta = 0
        sleep_ms = max(1, int(round(delta * 1000.0 / fps)))
        if first:
            lines.append(
                "// задержка загрузки уровня и input lag примерно +26 мс"
            )
            first = False
        lines.append(f"SLEEP_U16 {sleep_ms}")
        lines.append("PRESS_MK hidmouse_0")
        lines.append(f"SLEEP_U16 {tap_down_ms}")
        lines.append("RELEASE_MK hidmouse_0")
        lines.append("//")
        prev = frame
    return "\n".join(lines)


# ------------------------------------------------------------
# RECORD
# ------------------------------------------------------------
def do_record(agent: Agent, cfg: dict) -> None:
    log.info("=== RECORD ===")
    print("Войдите на уровень в замороженном состоянии.")
    input("Enter — НАЧАТЬ запись... ")

    agent.ensure_pump()          # lazy install
    agent.detect_start()
    print("🔴 запись... Играйте (первый тап — старт уровня).")
    input("Enter — ОСТАНОВИТЬ... ")

    events = agent.detect_stop()
    body = agent.detect_get_body_frames()
    tl = agent.detect_get_frame_ns_timeline()
    rng = agent.detect_get_rng_log()

    kind, anchor = find_anchor(events, body)
    jumps_count = sum(1 for e in events if e.get("name") == "jump")

    out = {
        "version": 3,
        "anchor_frame": anchor,
        "anchor_kind": kind,
        "events": events,
        "body_frames": body,
        "timeline_ns": tl,
        "rng_log": rng[:2000] if rng else None,
    }

    fps = float(cfg.get("orchestrator", {}).get("nominal_fps", 60))
    tap_down_ms = int(cfg.get("phantom", {}).get("tap_down_to_up_ms", 1))
    macro = build_macro_script(events, anchor, fps, tap_down_ms)

    # Преамбула в трёх кавычках — удобно копировать как plain text.
    preamble = '"""\n'
    preamble += f"jumps: {jumps_count}\n"
    preamble += f"anchor: {kind}@{anchor}\n"
    preamble += f"fps: {fps:.0f}\n"
    preamble += f"tap_down_ms: {tap_down_ms}\n"
    if macro:
        preamble += "\n" + macro + "\n"
    preamble += '"""\n\n'

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    payload = preamble + json.dumps(out, indent=2, ensure_ascii=False)
    REPLAY_PATH.write_text(payload, encoding="utf-8")

    log.info(
        "saved replay: %d events, %d body_frames, %d jumps, anchor=%s@%s",
        len(events), len(body), jumps_count, kind, anchor,
    )

    if not body:
        log.warning(
            "RECORD got 0 body_frames — проверьте pump_installed offset "
            "(должен быть 0x1612a20, не 0x161b7c0)"
        )


# ------------------------------------------------------------
# PLAY
# ------------------------------------------------------------
def do_play(agent: Agent, phantom: PhantomBridge, cfg: dict) -> None:
    replay = load_replay()
    if not replay.get("events"):
        print("нет replay.json — сначала record.")
        return
    print(f"anchor: {replay.get('anchor_kind')}={replay.get('anchor_frame')}, "
          f"jumps={sum(1 for e in replay['events'] if e['name'] == 'jump')}")
    print("Войдите на уровень в замороженном состоянии.")
    input("Enter — старт play... ")

    # playSetup внутри orchestrator.run() сам вызовет pump.install()
    agent.ensure_pump()

    orch = Orchestrator(cfg, agent, phantom, replay)
    try:
        report = orch.run()
    except (ReplayError, PhantomError) as e:
        log.error("play failed: %s", e)
        return

    fe = report["frame_error_stats"]
    print(
        f"✅ jumps: {report['jumps_fired']}/{report['jumps_planned']} "
        f"(missed={report['jumps_missed']})"
    )
    if report.get("note"):
        print(f"   note: {report['note']}")
    print(
        f"   frame_error: min={fe['min']} med={fe['med']} max={fe['max']} "
        f"abs_med={fe['abs_med']} abs_max={fe['abs_max']}"
    )
    print(f"   tap ms: {report['tap_stats_ms']}")
    print("   report: console only (logs/replay.json is the only saved file)")


# ------------------------------------------------------------
# CALIBRATE
# ------------------------------------------------------------
def do_calibrate(agent: Agent, phantom: PhantomBridge, cfg: dict) -> None:
    print("=== CALIBRATE (async, no gate) ===")
    print("Нужен активный уровень — персонаж бежит, не frozen.")
    print("Каждый тап: снимок cur_frame → tap → ждём 200 ms → ищем переход a0/g80.")
    input("Enter — старт... ")

    agent.ensure_pump()          # lazy install

    x, y = resolve_tap(cfg)
    fps = float(cfg["orchestrator"]["nominal_fps"])
    samples_lead_ms: list[float] = []
    samples_tap_ms: list[float] = []

    for i in range(10):
        st = agent.play_state()
        cur = int(st.get("frame", 0))
        tail = agent.ring_tail(1) or [{}]
        prev = tail[-1]
        a0_before = prev.get("a0")
        g80_before = prev.get("g80")

        tr = phantom.tap(x, y)
        if not tr.ok:
            print(f"[{i}] tap failed: {tr.error}")
            time.sleep(0.5)
            continue
        samples_tap_ms.append(tr.duration_ms)

        time.sleep(0.2)

        tail = agent.ring_tail(200) or []
        change_frame = None
        prev_a, prev_g = a0_before, g80_before
        for r in tail:
            f = int(r["frame"])
            if f <= cur:
                continue
            a = r.get("a0")
            g = r.get("g80")
            is_jump = False
            if isinstance(prev_a, int) and isinstance(a, int):
                if prev_a == 0 and a != 0:
                    is_jump = True
            if prev_g == 1 and g == 0:
                is_jump = True
            if is_jump:
                change_frame = f
                break
            prev_a, prev_g = a, g

        if change_frame is None:
            print(f"[{i}] cur={cur} no change in 200ms")
            time.sleep(0.5)
            continue

        lead_frames = change_frame - cur
        lead_ms = lead_frames * 1000.0 / fps
        samples_lead_ms.append(lead_ms)
        print(
            f"[{i}] cur={cur} → change@{change_frame} "
            f"lead_frames={lead_frames} lead≈{lead_ms:.1f}ms "
            f"tap={tr.duration_ms:.1f}ms"
        )
        time.sleep(0.4)

    if not samples_lead_ms:
        print("не удалось зафиксировать ни одного отклика")
        return

    samples_lead_ms.sort()
    n = len(samples_lead_ms)
    med = samples_lead_ms[n // 2]
    p95 = samples_lead_ms[min(n - 1, int(n * 0.95))]
    print(
        f"\nsamples={n}  "
        f"min={samples_lead_ms[0]:.1f}ms  "
        f"med={med:.1f}ms  "
        f"p95={p95:.1f}ms  "
        f"max={samples_lead_ms[-1]:.1f}ms"
    )
    if samples_tap_ms:
        print(
            f"tap_ms: med="
            f"{sorted(samples_tap_ms)[len(samples_tap_ms) // 2]:.1f}ms"
        )
    print(f"\n⚠ калибровка шумит (FPS-джиттер). "
          f"Дефолт predict_lead_ms=0 — работает лучше.")


# ------------------------------------------------------------
# DRY RUN
# ------------------------------------------------------------
def do_dry_run(agent: Agent, cfg: dict) -> None:
    replay = load_replay()
    if not replay.get("events"):
        print("нет replay.json")
        return
    print("=== DRY-RUN: plan only ===")
    kind, anchor = find_anchor(replay["events"], replay.get("body_frames", []))
    if anchor is None:
        print("no anchor")
        return
    plan = build_plan(replay["events"], anchor)
    print(f"anchor={kind}@{anchor}")
    for p in plan:
        print(
            f"  idx={p['idx']:2d}  rec_frame={p['rec_frame']:5d}  "
            f"delta={p['frame_delta']:4d}"
        )
    print(f"total: {len(plan)} jumps")
    print('   macro: see logs/replay.json (block between """)')


MENU = """
─────────────────────────────────────────────────
  Enter / rehearse    record + play
  record              only record
  play                only play
  calibrate           predict_lead_ms test (10 taps)
  dry-run             plan only, no taps
  clear               delete replay.json
  exit / q            quit
─────────────────────────────────────────────────
"""


def main() -> None:
    cfg = load_config()
    setup_logging(cfg.get("logging", {}).get("level", "INFO"))
    prune_logs_dir()
    log.info("logging: console only; logs dir keeps only replay.json")

    agent = Agent(cfg)
    try:
        agent.attach()
    except Exception as e:
        log.error("attach failed: %s", e)
        sys.exit(1)

    phantom = PhantomBridge(cfg["phantom"])

    while True:
        print(MENU)
        try:
            cmd = input("> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            break
        try:
            if cmd in ("", "rehearse", "r"):
                do_record(agent, cfg)
                do_play(agent, phantom, cfg)
            elif cmd in ("record", "rec"):
                do_record(agent, cfg)
            elif cmd in ("play", "p"):
                do_play(agent, phantom, cfg)
            elif cmd in ("calibrate", "cal"):
                do_calibrate(agent, phantom, cfg)
            elif cmd in ("dry-run", "dry"):
                do_dry_run(agent, cfg)
            elif cmd in ("clear", "c"):
                if REPLAY_PATH.exists():
                    REPLAY_PATH.unlink()
                print("cleared")
            elif cmd in ("exit", "quit", "q"):
                break
            else:
                print(f"unknown command: {cmd}")
        except frida.InvalidOperationError as e:
            log.error("frida session lost: %s", e)
            break
        except Exception:
            log.exception("command error")

    phantom.close()
    agent.close()


if __name__ == "__main__":
    main()
