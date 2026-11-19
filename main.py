#!/usr/bin/env python3
r'''main.py — CLI for King of Thieves TAS (Phantom + Frida, async v7.0).

FPS-optimized: pump_install вызывается ЛЕНИВО — только в record/play/calibrate.
Idle-режим (после attach, до действий) — без Interceptor на FRAME_FUNC.

Формат комментария в replay.json:

  """
  jumps: N
  anchor: <kind>@<frame>
  fps: 60
  tap_down_ms: 1
  delta: true

  +26
  +14
  loop 10 {
    +51
  }
  +60
  """

  * delta: true  → числа ниже — ДЕЛЬТЫ в кадрах: первый прыжок считается
    от якоря, каждый следующий — от предыдущего прыжка. Так удобно
    писать/править руками.
  * без delta:   → числа — абсолютные кадры (старый формат, совместим).
  * loop N { ... } — повторить блок N раз. Дельты внутри блока
    продолжают накапливаться от предыдущего значения; вложенные циклы
    поддерживаются. Семантика: cursor = anchor; для каждой итерации
    цикла cursor += delta; emit(cursor).
  * Каждая запись — либо `+51`, `51`, `-3`, `{"frame": 51},` —
    любая из форм распознаётся. Пустые строки и `//...` игнорируются.
  * mode: comment  → play игнорирует JSON-тело и берёт только список
    кадров из комментария (используй после ручной правки).
  * Если JSON-тело есть, но кадры в комментарии разошлись с
    events[].frame — play автоматически переключается на комментарий
    (body_frames отключаются, verify не работает).

Lazy pump: pump_install вызывается только в record/play/calibrate.

Логи:
  * в logs/ хранится только replay.json.
'''
from __future__ import annotations

import json
import logging
import re
import sys
import threading
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
from stones import (
    StonesModule, TgNotifier, handle as stones_handle, HELP as STONES_HELP,
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
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    for p in LOG_DIR.iterdir():
        if p.name == REPLAY_PATH.name:
            continue
        if p.is_file():
            try:
                p.unlink()
            except OSError:
                pass


def clear_console() -> None:
    sys.stdout.write("\033[H\033[2J\033[3J")
    sys.stdout.flush()


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
        self._stones = None

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
        self.script.exports_sync.detect_install()

    def ensure_pump(self) -> None:
        if self._pump_installed:
            return
        self.script.exports_sync.pump_install()
        self._pump_installed = True
        log.info("pump installed (lazy)")

    def stones_module(self, phantom=None) -> StonesModule:
        if self._stones is None:
            if self.session is None:
                raise RuntimeError("frida session not attached")

            sc = self.cfg.get("stones") or {}
            skip = sc.get("skip_on_no_match") or {}
            skip_xy = None
            if isinstance(skip, dict) and "x" in skip and "y" in skip:
                try:
                    skip_xy = (int(skip["x"]), int(skip["y"]))
                except (TypeError, ValueError):
                    log.warning("stones.skip_on_no_match: bad x/y: %r", skip)
            skip_wait_ms = int(sc.get("skip_wait_ms", 80))
            burst_interval_ms = int(sc.get(
                "burst_interval_ms", sc.get("skip_delay_ms", 120)))
            stall_timeout_ms = int(sc.get("stall_timeout_ms", 5000))

            burst_pause_every = int(sc.get("burst_pause_every", 500))
            burst_pause_ms = int(sc.get("burst_pause_ms", 3000))
            tap_fail_abort = int(sc.get("tap_fail_abort", 10))
            health_check_interval_s = float(sc.get("health_check_interval_s", 3))
            verbose_output = bool(sc.get("verbose_output", False))

            # --- Telegram ---
            tg_cfg = self.cfg.get("telegram") or {}
            tg_notifier = TgNotifier(
                bot_token=str(tg_cfg.get("bot_token", "") or ""),
                chat_id=str(tg_cfg.get("chat_id", "") or ""),
                enabled=bool(tg_cfg.get("enabled", False)),
                timeout_s=float(tg_cfg.get("timeout_s", 5)),
                min_interval_s=float(tg_cfg.get("min_interval_s", 10)),
            )

            self._stones = StonesModule(
                self.session,
                phantom=phantom,
                skip_xy=skip_xy,
                skip_wait_ms=skip_wait_ms,
                burst_interval_ms=burst_interval_ms,
                stall_timeout_ms=stall_timeout_ms,
                burst_pause_every=burst_pause_every,
                burst_pause_ms=burst_pause_ms,
                tap_fail_abort=tap_fail_abort,
                health_check_interval_s=health_check_interval_s,
                verbose_output=verbose_output,
                tg_notifier=tg_notifier,
            )
            if skip_xy is not None:
                log.info(
                    "stones burst: tap (%d,%d)  wait=%dms  "
                    "burst=%dms  stall=%dms  pause=%d/%dms  "
                    "fail_abort=%d  hc=%.0fs  verbose=%s  tg=%s",
                    skip_xy[0], skip_xy[1],
                    skip_wait_ms, burst_interval_ms, stall_timeout_ms,
                    burst_pause_every, burst_pause_ms,
                    tap_fail_abort, health_check_interval_s,
                    verbose_output, tg_notifier.enabled,
                )
        return self._stones

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
        if self._stones is not None:
            try:
                self._stones.stop()
            except Exception:
                pass
            self._stones = None
        if self.session:
            try:
                self.session.detach()
            except Exception:
                pass


# ------------------------------------------------------------
# replay.json parsing (comment format: header + frame list)
# ------------------------------------------------------------
_HEADER_LINE_RE = re.compile(
    r'^(jumps|anchor|fps|tap_down_ms|delta|mode)\s*:\s*(.*)$'
)
_FRAME_NUM_RE = re.compile(r'^([+-]?\d+)\s*,?\s*$')
_FRAME_OBJ_RE = re.compile(r'^\{\s*"frame"\s*:\s*([+-]?\d+)\s*\}\s*,?\s*$')
_LOOP_OPEN_RE = re.compile(r'^loop\s+(\d+)\s*\{\s*$')
_LOOP_CLOSE_RE = re.compile(r'^\}\s*,?\s*$')
_JSON_BODY_RE = re.compile(r'\{\s*"version"\s*:')


def _strip_line_comment(s: str) -> str:
    '''Убирает `// ...` в конце строки. Строки, начинающиеся с //, → пусто.'''
    p = s.find("//")
    if p >= 0:
        s = s[:p]
    return s.strip()


def _parse_frame_value(s: str):
    '''Возвращает int для одной записи кадра, иначе None.
    Понимает: `+26`, `26`, `-3`, `26,`, `{"frame": 26},`.'''
    m = _FRAME_NUM_RE.match(s)
    if m:
        return int(m.group(1))
    m = _FRAME_OBJ_RE.match(s)
    if m:
        return int(m.group(1))
    return None


def _parse_header_lines(text: str) -> dict:
    header: dict = {}
    for raw in text.splitlines():
        s = _strip_line_comment(raw)
        if not s or s.startswith('"""'):
            continue
        m = _HEADER_LINE_RE.match(s)
        if m:
            header[m.group(1)] = m.group(2).strip()
    return header


def _exec_ops(ops, cursor, out):
    '''Выполняет дерево операций (num | loop) в delta-режиме.
    cursor стартует с anchor; каждая num-операция сдвигает cursor и
    выдаёт абсолютный кадр. loop N { ... } повторяет тело N раз.
    Возвращает финальный cursor (для вложенности).'''
    for op in ops:
        if op[0] == "num":
            cursor += op[1]
            out.append(cursor)
        else:  # loop
            count, body = op[1], op[2]
            for _ in range(count):
                cursor = _exec_ops(body, cursor, out)
    return cursor


def _flatten_abs(ops, out):
    '''Абсолютный режим: собираем все num-значения. Циклы расширяем
    один раз (loop count игнорируется — warn делается в парсере).'''
    for op in ops:
        if op[0] == "num":
            out.append(op[1])
        else:
            _flatten_abs(op[2], out)


def _contains_loop(ops) -> bool:
    for op in ops:
        if op[0] == "loop":
            return True
    return False


def _recover_from_header_frames(text: str) -> dict:
    '''Восстанавливает минимальный replay из шапки + списка кадров
    (с поддержкой loop N { ... }). Возвращает dict или {}.'''
    header: dict = {}
    root: list = []
    stack: list = [root]

    for raw in text.splitlines():
        s = _strip_line_comment(raw)
        if not s:
            continue
        m = _HEADER_LINE_RE.match(s)
        if m:
            header[m.group(1)] = m.group(2).strip()
            continue
        m = _LOOP_OPEN_RE.match(s)
        if m:
            body: list = []
            stack[-1].append(("loop", int(m.group(1)), body))
            stack.append(body)
            continue
        if _LOOP_CLOSE_RE.match(s):
            if len(stack) <= 1:
                log.warning("unbalanced '}' in replay.json — ignored")
                continue
            stack.pop()
            continue
        v = _parse_frame_value(s)
        if v is not None:
            stack[-1].append(("num", v))
            continue
        # неизвестная строка — молча игнорируем (комментарии, мусор)

    if len(stack) != 1:
        log.warning("unclosed loop in replay.json — treating as closed at EOF")
        while len(stack) > 1:
            stack.pop()

    # anchor
    anchor_frame = None
    anchor_kind = None
    a = header.get("anchor", "")
    if "@" in a:
        kind_part, _, frame_part = a.partition("@")
        anchor_kind = kind_part.strip() or None
        try:
            anchor_frame = int(frame_part.strip())
        except ValueError:
            anchor_frame = None

    is_delta = header.get("delta", "").lower() in ("1", "true", "yes")
    if is_delta and anchor_frame is None:
        log.warning("delta: true but no valid anchor — treating as absolute")
        is_delta = False

    abs_frames: list = []
    if is_delta:
        _exec_ops(root, anchor_frame, abs_frames)
    else:
        if _contains_loop(root):
            log.warning(
                "loop { ... } in replay.json requires 'delta: true' — "
                "expanding loops once (count ignored)")
        _flatten_abs(root, abs_frames)

    if not abs_frames:
        return {}

    declared = header.get("jumps")
    if declared is not None:
        try:
            n = int(declared)
            if n != len(abs_frames):
                log.warning(
                    "replay.json: 'jumps: %d' declared but %d frame values "
                    "after expansion", n, len(abs_frames))
        except ValueError:
            pass

    events: list = []
    if anchor_frame is not None:
        events.append({
            "frame": anchor_frame,
            "name": anchor_kind or "first_hero_update",
            "snap": {},
        })
    for f in abs_frames:
        events.append({"frame": f, "name": "jump", "snap": {}})

    return {
        "version": 3,
        "anchor_frame": anchor_frame,
        "anchor_kind": anchor_kind or "first_hero_update",
        "events": events,
        "body_frames": [],
        "timeline_ns": [],
        "rng_log": None,
        "_recovered": True,
        "_recovered_jumps": len(abs_frames),
        "_recovered_delta_mode": is_delta,
        "_fps_from_header": header.get("fps"),
        "_tap_down_from_header": header.get("tap_down_ms"),
    }


def load_replay(path: Path = REPLAY_PATH) -> dict:
    '''Читает replay.json. Приоритет:

      1) mode: comment → только список кадров из комментария.
      2) JSON-тело + комментарий, кадры совпадают → JSON-тело
         (со snap и body_frames).
      3) JSON-тело + комментарий, кадры расходятся → комментарий
         (значит правили руками; body_frames отключаются).
      4) Только JSON-тело → оно.
      5) Только комментарий → восстановленный replay.
      6) Ничего → {}.

    Никогда не падает с трейсбеком.'''
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        log.error("failed to read %s: %s", path, e)
        return {}

    header = _parse_header_lines(text)
    mode = header.get("mode", "").lower()
    force_comment = mode in ("comment", "frames_only", "frames")

    body = None
    for m in _JSON_BODY_RE.finditer(text):
        candidate = text[m.start():].strip()
        try:
            body = json.loads(candidate)
            break
        except json.JSONDecodeError:
            last = candidate.rfind("}")
            if last > 0:
                try:
                    body = json.loads(candidate[:last + 1])
                    break
                except json.JSONDecodeError:
                    pass

    recovered = _recover_from_header_frames(text)

    if force_comment:
        if recovered:
            log.info("replay.json: mode=comment → using frame list from comment")
            return recovered
        if body:
            log.warning("mode=comment but no frame list — fallback to JSON body")
            return body
        return {}

    if body and recovered:
        body_jumps = sorted(
            int(e["frame"]) for e in body.get("events", [])
            if e.get("name") == "jump"
        )
        cmt_jumps = sorted(
            int(e["frame"]) for e in recovered.get("events", [])
            if e.get("name") == "jump"
        )
        if body_jumps != cmt_jumps:
            log.warning(
                "replay.json: comment frame list diverges from JSON body "
                "(%d vs %d jumps) — using comment; body_frames disabled",
                len(cmt_jumps), len(body_jumps))
            return recovered
        return body

    if body:
        return body
    if recovered:
        log.warning(
            "replay.json has no JSON body; recovered %d jumps (delta=%s)",
            recovered.get("_recovered_jumps", 0),
            recovered.get("_recovered_delta_mode"),
        )
        return recovered

    log.error("replay.json is empty or unparsable")
    return {}


# ------------------------------------------------------------
# Comment generation with auto-loop detection
# ------------------------------------------------------------
def _emit_delta_lines(deltas: list[int]) -> list[str]:
    '''Сворачивает повторяющиеся серии дельт в `loop N { ... }` и
    возвращает строки для комментария. Поддерживает только один уровень
    вложенности на выходе (это генератор, ему хватает).'''
    n = len(deltas)
    lines: list[str] = []
    i = 0
    while i < n:
        max_plen = min(6, (n - i) // 2)
        best_pat = None
        best_len = 0
        best_reps = 0
        for plen in range(1, max_plen + 1):
            pat = deltas[i:i + plen]
            reps = 1
            j = i + plen
            while j + plen <= n and deltas[j:j + plen] == pat:
                reps += 1
                j += plen
            if reps >= 2 and reps * plen > best_reps * best_len:
                best_pat = pat
                best_len = plen
                best_reps = reps
        if best_pat is not None and best_reps >= 2:
            lines.append(f"loop {best_reps} {{")
            for d in best_pat:
                lines.append(f"+{d}")
            lines.append("}")
            i += best_reps * best_len
        else:
            lines.append(f"+{deltas[i]}")
            i += 1
    return lines


def build_frame_script(events, anchor_frame):
    '''Скрипт-комментарий: в шапке delta: true, дальше дельты в кадрах
    от якоря (первый прыжок) и от предыдущего прыжка (остальные).
    Повторяющиеся серии сворачиваются в `loop N { ... }`.'''
    if anchor_frame is None:
        return ""
    jumps = sorted(
        (e for e in events if e.get("name") == "jump"),
        key=lambda e: int(e["frame"]),
    )
    if not jumps:
        return ""
    deltas: list[int] = []
    prev = int(anchor_frame)
    for j in jumps:
        f = int(j["frame"])
        deltas.append(f - prev)
        prev = f
    return "\n".join(_emit_delta_lines(deltas))


def do_record(agent: Agent, cfg: dict) -> None:
    log.info("=== RECORD ===")
    print("Войдите на уровень в замороженном состоянии.")
    input("Enter — НАЧАТЬ запись... ")

    agent.ensure_pump()
    agent.detect_start()
    print("🔴 запись... Играйте (первый тап — старт уровня).")
    try:
        input("Enter — ОСТАНОВИТЬ... ")
    except KeyboardInterrupt:
        log.warning("record stop forced by Ctrl+C")

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
    frame_script = build_frame_script(events, anchor)

    preamble = '"""\n'
    preamble += f"jumps: {jumps_count}\n"
    preamble += f"anchor: {kind}@{anchor}\n"
    preamble += f"fps: {fps:.0f}\n"
    preamble += f"tap_down_ms: {tap_down_ms}\n"
    if frame_script:
        preamble += "delta: true\n"
        preamble += "\n" + frame_script + "\n"
    preamble += '"""\n\n'

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    payload = preamble + json.dumps(out, indent=2, ensure_ascii=False)

    # Атомарная запись: Ctrl+C во время записи не оставит полуфайл.
    tmp = REPLAY_PATH.with_suffix(REPLAY_PATH.suffix + ".tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(REPLAY_PATH)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass

    log.info(
        "saved replay: %d events, %d body_frames, %d jumps, anchor=%s@%s",
        len(events), len(body), jumps_count, kind, anchor,
    )

    if not body:
        log.warning(
            "RECORD got 0 body_frames — проверьте pump_installed offset "
            "(должен быть 0x1612a20, не 0x161b7c0)"
        )


def do_play(agent: Agent, phantom: PhantomBridge, cfg: dict) -> None:
    replay = load_replay()
    if not replay.get("events"):
        if REPLAY_PATH.exists():
            print("replay.json есть, но в нём нет events.")
            print(f"Файл: {REPLAY_PATH}")
            print("Похоже, файл повреждён или был записан не до конца — "
                  "сделайте record заново.")
        else:
            print("нет replay.json — сначала record.")
        return

    if replay.get("_recovered"):
        d = "delta" if replay.get("_recovered_delta_mode") else "absolute"
        print(
            f"⚠ replay.json без JSON-тела: восстановлено "
            f"{replay.get('_recovered_jumps', 0)} прыжков "
            f"(mode={d}); body_frames недоступны (verify отключён)."
        )

    jumps_n = sum(1 for e in replay["events"] if e["name"] == "jump")
    print(f"anchor: {replay.get('anchor_kind')}={replay.get('anchor_frame')}, "
          f"jumps={jumps_n}")
    print("Войдите на уровень в замороженном состоянии.")
    try:
        input("Enter — старт play... ")
    except KeyboardInterrupt:
        log.warning("play cancelled before start")
        return

    agent.ensure_pump()

    orch = Orchestrator(cfg, agent, phantom, replay)
    try:
        report = orch.run()
    except KeyboardInterrupt:
        log.warning("play aborted by Ctrl+C — returning to menu")
        return
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


def do_calibrate(agent: Agent, phantom: PhantomBridge, cfg: dict) -> None:
    print("=== CALIBRATE (async, no gate) ===")
    print("Нужен активный уровень — персонаж бежит, не frozen.")
    try:
        input("Enter — старт... ")
    except KeyboardInterrupt:
        log.warning("calibrate cancelled before start")
        return

    agent.ensure_pump()

    x, y = resolve_tap(cfg)
    fps = float(cfg["orchestrator"]["nominal_fps"])
    samples_lead_ms: list = []
    samples_tap_ms: list = []

    import time as _time
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
            _time.sleep(0.5)
            continue
        samples_tap_ms.append(tr.duration_ms)

        _time.sleep(0.2)

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
            _time.sleep(0.5)
            continue

        lead_frames = change_frame - cur
        lead_ms = lead_frames * 1000.0 / fps
        samples_lead_ms.append(lead_ms)
        print(
            f"[{i}] cur={cur} → change@{change_frame} "
            f"lead_frames={lead_frames} lead≈{lead_ms:.1f}ms "
            f"tap={tr.duration_ms:.1f}ms"
        )
        _time.sleep(0.4)

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
    print("\n⚠ калибровка шумит (FPS-джиттер). "
          "Дефолт predict_lead_ms=0 — работает лучше.")


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
    print('   frame script: see logs/replay.json (block between """)')


def do_stones(agent: Agent, phantom: PhantomBridge, argv: list) -> None:
    try:
        mod = agent.stones_module(phantom=phantom)
        stones_handle(mod, argv)
    except frida.InvalidOperationError as e:
        log.error("frida session lost: %s", e)
        raise


MENU = """
─────────────────────────────────────────────────
  Enter / rehearse    record + play
  record              only record
  play                only play
  calibrate           predict_lead_ms test (10 taps)
  dry-run             plan only, no taps
  stones <filter>     rival stones live + burst-skip (см. help)
  help                справка по stones
  clear               wipe console + delete replay.json
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
            elif cmd in ("help", "h", "?"):
                print(STONES_HELP)
            elif cmd.startswith("stones"):
                parts = cmd.split()
                if parts[0] == "stones":
                    do_stones(agent, phantom, parts[1:])
                else:
                    print(f"unknown command: {cmd}")
            elif cmd in ("clear", "c"):
                err = None
                if REPLAY_PATH.exists():
                    try:
                        REPLAY_PATH.unlink()
                    except OSError as e:
                        err = e
                clear_console()
                if err is not None:
                    log.warning("failed to delete %s: %s", REPLAY_PATH, err)
            elif cmd in ("exit", "quit", "q"):
                break
            else:
                print(f"unknown command: {cmd}")
        except KeyboardInterrupt:
            log.warning("interrupted by user (Ctrl+C) — back to menu")
        except frida.InvalidOperationError as e:
            log.error("frida session lost: %s", e)
            break
        except Exception:
            log.exception("command error")

    phantom.close()
    agent.close()


if __name__ == "__main__":
    main()
