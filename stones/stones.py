"""stones.py — доп. модуль: получение камней соперника.

v14 (stability):
  * `burst_pause_every` / `burst_pause_ms` — периодический cooldown,
    чтобы Waydroid/Android InputDispatcher не забивался.
  * Health-check Frida-сессии раз в `health_check_interval_s`.
  * `session.on('detached')` — мгновенный abort если игра/Frida умерли.
  * `tap_fail_abort` — abort после N подряд FAILED-тапов (phantom dead).
  * `verbose_output=false` по умолчанию: 1 строка на non-match,
    детали только для MATCH; каждый тап — раз в 10.

v13: без `stones tune`/`stones show`.
v12: burst-режим.
v11: ускорение (тик 10мс).
v10: ретрай отложенного skip.
v9: skip_wait_ms, skip_delay_ms.
v8: auto-skip на non-match, стоп на MATCH.
v7: `stones <filter>` без префикса live; `clear` внутри LIVE.
v6: stdin polling через select().
v5: автопоказ, robust loading rival_hook.js, sanity-check, ASCII fallback.
"""
from __future__ import annotations

import logging
import select
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import frida

log = logging.getLogger("stones")

HOOK_PATH = Path(__file__).resolve().parent / "rival_hook.js"


# ------------------------------------------------------------
# Console clear
# ------------------------------------------------------------
def _clear_console() -> None:
    sys.stdout.write("\033[H\033[2J\033[3J")
    sys.stdout.flush()


# ------------------------------------------------------------
# Robust file loading + sanity check
# ------------------------------------------------------------
_BAD_CHARS = (
    0x0085, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF,
)

_FOREIGN_MARKERS = (
    "#!/usr/bin/env python",
    "#!/usr/bin/python",
    "\"\"\"",
    "r'''",
    "'''",
    "import ",
    "from __future__",
)


def _sanity_check_source(src: str) -> None:
    head = src.lstrip()[:200]
    for marker in _FOREIGN_MARKERS:
        if head.startswith(marker):
            raise RuntimeError(
                f"rival_hook.js содержит не JavaScript, а чужой файл "
                f"(начинается с {marker!r}). Скорее всего, кто-то записал "
                f"main.py поверх rival_hook.js. Перезапишите {HOOK_PATH} "
                f"правильным rival_hook.js. "
                f"Первая строка сейчас: {head.splitlines()[0][:120]!r}"
            )
    if "RivalDungeon" not in src[:2000] and "0xF680D0" not in src[:2000]:
        log.warning(
            "rival_hook.js doesn't mention RivalDungeon/0xF680D0 in "
            "first 2000 chars — is it the right file?"
        )


def _load_hook_source() -> str:
    raw = HOOK_PATH.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
        log.debug("stripped UTF-8 BOM")
    try:
        src = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        log.warning("UTF-8 decode failed (%s) — trying latin-1", e)
        src = raw.decode("latin-1")

    _sanity_check_source(src)

    src = src.replace("\r\n", "\n").replace("\r", "\n")
    src = src.replace("\u2028", "\n").replace("\u2029", "\n")

    stripped = 0
    for code in _BAD_CHARS:
        ch = chr(code)
        n = src.count(ch)
        if n:
            src = src.replace(ch, "")
            stripped += n
    if stripped:
        log.info("stripped %d invisible char(s) from rival_hook.js", stripped)

    return src


def _log_source_head(src: str, n_lines: int = 3, hex_bytes: int = 100) -> None:
    lines = src.split("\n")
    log.info("rival_hook.js: %d bytes, %d lines", len(src), len(lines))
    for i, line in enumerate(lines[:n_lines], 1):
        log.info("  L%02d (%d ch): %r", i, len(line), line[:150])
    if hex_bytes:
        head = src[:hex_bytes].encode("utf-8", errors="replace")
        log.info("  first %d bytes (hex): %s",
                 len(head), head.hex(" "))


# ------------------------------------------------------------
# StonesModule
# ------------------------------------------------------------
class StonesModule:
    def __init__(self,
                 session: frida.core.Session,
                 phantom=None,
                 skip_xy: Optional[tuple] = None,
                 skip_wait_ms: int = 80,
                 burst_interval_ms: int = 120,
                 stall_timeout_ms: int = 5000,
                 burst_pause_every: int = 500,
                 burst_pause_ms: int = 3000,
                 tap_fail_abort: int = 10,
                 health_check_interval_s: float = 3.0,
                 verbose_output: bool = False):
        self.session = session
        self.script: Optional[frida.core.Script] = None
        self._installed = False

        # auto-skip
        self.phantom = phantom
        self.skip_xy = skip_xy
        self.skip_wait_ms = max(0, int(skip_wait_ms))
        self.burst_interval_ms = max(10, int(burst_interval_ms))
        self.stall_timeout_ms = max(500, int(stall_timeout_ms))

        # stability
        self.burst_pause_every = max(0, int(burst_pause_every))
        self.burst_pause_ms = max(0, int(burst_pause_ms))
        self.tap_fail_abort = max(1, int(tap_fail_abort))
        self.health_check_interval_s = max(0.5, float(health_check_interval_s))
        self.verbose_output = bool(verbose_output)

        self._last_skip_t = 0.0
        self._tap_ok_count = 0
        self._session_dead = False
        self._session_detach_reason = None

        # live-mode plumbing
        self._live = False
        self._pending_seqs: list = []
        self._live_event = threading.Event()
        self._live_lock = threading.Lock()

        # Listen for session detach (game crash / frida-server death)
        self._attach_session_listener()

    # ---------- session listener ----------
    def _attach_session_listener(self) -> None:
        try:
            self.session.on("detached", self._on_session_detached)
        except Exception as e:
            log.warning("session.on('detached') not available: %s", e)

    def _on_session_detached(self, reason, crash):
        self._session_dead = True
        self._session_detach_reason = f"reason={reason} crash={crash}"
        log.error("frida session detached: %s", self._session_detach_reason)

    def is_session_dead(self) -> bool:
        return self._session_dead

    def session_detach_reason(self) -> Optional[str]:
        return self._session_detach_reason

    @property
    def last_skip_monotonic(self) -> float:
        return self._last_skip_t

    # ---------- lifecycle ----------
    def ensure_loaded(self) -> None:
        if self.script is not None:
            return
        if not HOOK_PATH.exists():
            raise RuntimeError(f"rival_hook.js not found: {HOOK_PATH}")

        src = _load_hook_source()
        _log_source_head(src)

        try:
            self.script = self.session.create_script(src)
        except frida.InvalidArgumentError as e1:
            log.error("create_script (original) failed: %s", e1)
            ascii_src = "".join(c if ord(c) < 128 else " " for c in src)
            if ascii_src == src:
                raise
            log.warning("retrying with ASCII fallback")
            _log_source_head(ascii_src, n_lines=3, hex_bytes=0)
            try:
                self.script = self.session.create_script(ascii_src)
                log.warning("loaded via ASCII fallback")
            except frida.InvalidArgumentError as e2:
                log.error("create_script (ASCII) also failed: %s", e2)
                raise RuntimeError(
                    f"rival_hook.js parse failed. "
                    f"original: {e1}; ascii: {e2}. "
                    f"Check the file: head -5 {HOOK_PATH} | cat -A"
                ) from e2

        self.script.on("message", self._on_msg)
        self.script.load()
        base = self.script.exports_sync.module_base()
        log.info("rival_hook loaded, module_base=%s", base)
        self.script.exports_sync.install_hooks()
        self._installed = True
        log.info("rival_hook installed")

    def stop(self) -> None:
        self._live = False
        self._live_event.set()
        if self.script is None:
            return
        try:
            self.script.exports_sync.unhook_all()
        except Exception as e:
            log.warning("unhook_all failed: %s", e)
        try:
            self.script.unload()
        except Exception:
            pass
        self.script = None
        self._installed = False
        log.info("rival_hook stopped")

    # ---------- live plumbing ----------
    def set_live(self, on: bool) -> None:
        with self._live_lock:
            self._live = on
            self._pending_seqs.clear()
            self._live_event.clear()

    def drain_pending(self) -> list:
        with self._live_lock:
            p = list(self._pending_seqs)
            self._pending_seqs.clear()
            return p

    def wait_live(self, timeout: float) -> bool:
        return self._live_event.wait(timeout)

    def clear_live_event(self) -> None:
        self._live_event.clear()

    # ---------- auto-skip ----------
    def do_skip(self) -> bool:
        """Тап «найти следующего». Возвращает True при успехе."""
        if self.phantom is None or self.skip_xy is None:
            return False
        x, y = self.skip_xy
        t_now = time.monotonic()
        since_last = (t_now - self._last_skip_t) * 1000.0 \
            if self._last_skip_t > 0 else 0.0
        try:
            tr = self.phantom.tap(x, y)
            self._last_skip_t = time.monotonic()
            if tr.ok:
                self._tap_ok_count += 1
                # вывод: всегда первые 10 тапов, потом раз в 10; verbose — всё
                if (self.verbose_output
                        or self._tap_ok_count <= 10
                        or self._tap_ok_count % 10 == 0):
                    print(f"   (skip: tap {x},{y}  {tr.duration_ms:.1f}ms  "
                          f"[+{since_last:.0f}ms]  #{self._tap_ok_count})")
                return True
            log.warning("skip tap failed: %s", tr.error)
            print(f"   (skip tap FAILED: {tr.error})")
            return False
        except Exception as e:
            log.warning("skip tap exception: %s", e)
            print(f"   (skip tap exception: {e})")
            return False

    # ---------- frida message handler ----------
    def _on_msg(self, msg, _data):
        if msg["type"] == "send":
            p = msg["payload"] or {}
            t = p.get("type")
            if t == "rival_update":
                log.debug("[rival] seq=%s gold=%s total=%s",
                          p.get("seq"), p.get("gold"), p.get("total_rating"))
                if self._live:
                    with self._live_lock:
                        self._pending_seqs.append(p.get("seq"))
                    self._live_event.set()
            elif t == "ready":
                log.info("[rival] ready base=%s", p.get("base"))
            elif t == "rival_aob":
                log.info("[rival] rival_aob method=%s offset=%s",
                         p.get("method"), p.get("offset"))
            elif t == "hooked":
                log.info("[rival] hooked at %s offset=%s",
                         p.get("at"), p.get("offset"))
            elif t == "err":
                log.error("[rival] err where=%s: %s",
                          p.get("where"), p.get("msg"))
        else:
            log.error("[rival frida] %s", msg)

    # ---------- data ----------
    def last(self) -> dict:
        self.ensure_loaded()
        return self.script.exports_sync.get_last_rival() or {}

    def log(self) -> dict:
        self.ensure_loaded()
        return self.script.exports_sync.get_rivals_log() or {}

    def reset(self) -> bool:
        if self.script is None:
            return False
        try:
            return bool(self.script.exports_sync.reset_log())
        except Exception:
            return False


# ------------------------------------------------------------
# Formatting
# ------------------------------------------------------------
def _fmt_stones(stones: list) -> str:
    if not stones:
        return "—"
    parts = []
    for s in stones:
        if not isinstance(s, dict):
            continue
        slot = s.get("slot")
        rating = s.get("rating")
        if slot is None or rating is None:
            continue
        parts.append(f"{slot}:{rating}")
    return "(" + ", ".join(parts) + ")" if parts else "—"


def _row(r: dict) -> str:
    return (
        f"seq={r.get('seq', '?'):>3} "
        f"gold={str(r.get('gold')):>8} "
        f"lvl={str(r.get('player_level')):>3} "
        f"total={str(r.get('total_rating')):>7} "
        f"stones={_fmt_stones(r.get('stones', []))}"
    )


def _print_stones_detail(r: dict) -> None:
    for s in r.get("stones") or []:
        if isinstance(s, dict) and s.get("rating") is not None:
            print(f"        slot={s.get('slot')} "
                  f"rating={s.get('rating')} "
                  f"cnt={s.get('cnt')} "
                  f"flag={s.get('flag')}")


def _stones_ratings(r: dict) -> list:
    out = []
    for s in r.get("stones") or []:
        if isinstance(s, dict):
            v = s.get("rating")
            if isinstance(v, int):
                out.append(v)
    return out


def _stones_all_ge(r: dict, m: int) -> bool:
    vals = _stones_ratings(r)
    return bool(vals) and all(v >= m for v in vals)


def _stones_count_ge(r: dict, m: int, n: int) -> bool:
    return sum(1 for v in _stones_ratings(r) if v >= m) >= n


def _parse_int(s: str) -> Optional[int]:
    try:
        return int(s, 0)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------
# Filter parsing
# ------------------------------------------------------------
def _looks_like_filter(sub: str) -> bool:
    return sub == "gold" or (sub.endswith("stone") and sub[:1].isdigit())


def _build_filter(argv: list):
    if not argv:
        return None, ""
    sub = argv[0].lower()

    if sub == "gold":
        if len(argv) < 2:
            log.warning("filter: gold requires MIN")
            return None, ""
        m = _parse_int(argv[1])
        if m is None:
            log.warning("filter: bad MIN %r", argv[1])
            return None, ""
        return (lambda r: (r.get("gold") or 0) >= m), f"gold >= {m} "

    if sub.endswith("stone") and sub[:1].isdigit():
        if len(argv) < 2:
            log.warning("filter: %s requires MIN", sub)
            return None, ""
        try:
            cnt = int(sub[0])
        except ValueError:
            return None, ""
        if cnt < 1 or cnt > 3:
            log.warning("filter: count must be 1..3, got %d", cnt)
            return None, ""
        m = _parse_int(argv[1])
        if m is None:
            log.warning("filter: bad MIN %r", argv[1])
            return None, ""
        if cnt >= 3:
            return (lambda r: _stones_all_ge(r, m)), f"all stones >= {m} "
        return (lambda r: _stones_count_ge(r, m, cnt)), \
            f">= {cnt} stone(s) >= {m} "

    log.warning("filter: unknown %r (use gold/1stone/2stone/3stone)", sub)
    return None, ""


# ------------------------------------------------------------
# LIVE
# ------------------------------------------------------------
LIVE_TICK_S = 0.01  # 10 мс тик


def _print_live_header(filter_label: str) -> None:
    print(f"=== filter: {filter_label or 'none'} ===")


def _print_live_banner(module: StonesModule, has_filter: bool) -> None:
    print("Слежение за Find a Match. Каждый новый соперник печатается "
          "автоматически.")
    print("Во время LIVE: `stones <filter>` — фильтр, `clear` — консоль, "
          "`stones stop` — выход.")
    if has_filter and module.skip_xy is not None and module.phantom is not None:
        x, y = module.skip_xy
        print(f"AUTO-SKIP (burst): non-match → tap ({x},{y})  "
              f"wait={module.skip_wait_ms}ms  "
              f"burst={module.burst_interval_ms}ms  "
              f"stall={module.stall_timeout_ms}ms")
        if module.burst_pause_every > 0:
            print(f"  Cooldown: каждые {module.burst_pause_every} тапов → "
                  f"{module.burst_pause_ms}ms пауза")
        print(f"  Health-check: каждые {module.health_check_interval_s:.0f}s  "
              f"tap_fail_abort={module.tap_fail_abort}")
        print(f"  verbose_output={module.verbose_output}")
    elif has_filter:
        print("AUTO-SKIP: отключён (нет stones.skip_on_no_match "
              "в config.yaml или phantom).")
    print()


def _reset_live_state(ctx: dict) -> None:
    ctx["state"] = "idle"
    ctx["next_tap_at"] = 0.0
    ctx["last_rival_at"] = 0.0
    ctx["taps_sent"] = 0
    ctx["matched_seqs"] = []
    ctx["fail_streak"] = 0
    ctx["last_health_check"] = 0.0
    ctx["pause_until"] = 0.0


def _handle_live_line(line: str, ctx: dict) -> bool:
    line = line.strip()
    if not line:
        return True

    if line.lower() in ("clear", "cls"):
        _clear_console()
        _print_live_header(ctx["label"])
        return True

    parts = line.split()
    if not parts or parts[0].lower() != "stones":
        print(f"(during LIVE: `stones <filter>`, `clear`, `stones stop`, "
              f"Ctrl+C; ignored: {line!r})")
        return True

    if len(parts) == 1:
        print(HELP)
        return True

    sub = parts[1].lower()
    mod = ctx.get("module")

    if sub in ("help", "?", "-h", "--help"):
        print(HELP)
        return True

    if sub in ("stop", "q", "quit", "exit"):
        print("\nLIVE stopped (by command).")
        return False

    if sub in ("clear", "cls"):
        _clear_console()
        _print_live_header(ctx["label"])
        return True

    if sub == "now":
        if mod is not None:
            r = mod.last()
            if r.get("ok"):
                print(f"[now] {_row(r)}")
                _print_stones_detail(r)
            else:
                print("[now] no rival yet")
        return True

    if sub == "live":
        fn, label = _build_filter(parts[2:])
        ctx["fn"] = fn
        ctx["label"] = label
        _reset_live_state(ctx)
        _print_live_header(label)
        return True

    if _looks_like_filter(sub):
        fn, label = _build_filter(parts[1:])
        if fn is None and label == "" and len(parts) >= 2:
            print(f"bad filter: {line!r} "
                  f"(usage: stones {sub} <MIN>)")
            return True
        ctx["fn"] = fn
        ctx["label"] = label
        _reset_live_state(ctx)
        _print_live_header(label)
        return True

    print(f"(during LIVE: `stones <filter>`, `clear`, `stones stop`, "
          f"Ctrl+C; ignored: {line!r})")
    return True


def stones_live(module: StonesModule,
                filter_fn=None,
                filter_label: str = "") -> None:
    """Blocking: BURST taps until rival; MATCH stop; non-match resume."""
    module.ensure_loaded()
    module.set_live(True)

    ctx = {
        "fn": filter_fn,
        "label": filter_label,
        "module": module,
        "state": "idle",
        "next_tap_at": 0.0,
        "last_rival_at": 0.0,
        "taps_sent": 0,
        "matched_seqs": [],
        "fail_streak": 0,
        "last_health_check": time.monotonic(),
        "pause_until": 0.0,
    }

    print()
    _print_live_header(ctx["label"])
    r = module.last()
    if r.get("ok"):
        print(f"[prev] {_row(r)}")
        _print_stones_detail(r)
    _print_live_banner(module, has_filter=ctx["fn"] is not None)

    is_interactive = False
    try:
        is_interactive = sys.stdin.isatty()
    except Exception:
        pass

    try:
        while True:
            module.wait_live(LIVE_TICK_S)
            module.clear_live_event()
            pending = module.drain_pending()

            # --- 0) fatal: Frida session detached (game crash / server death)
            if module.is_session_dead():
                print(f"\nLIVE ABORT: frida session detached "
                      f"({module.session_detach_reason()})")
                return

            # --- 0.1) periodic health-check
            now = time.monotonic()
            if (module.health_check_interval_s > 0
                    and now - ctx["last_health_check"]
                        >= module.health_check_interval_s):
                ctx["last_health_check"] = now
                try:
                    module.script.exports_sync.module_base()
                except Exception as e:
                    print(f"\nLIVE ABORT: frida session dead: {e}")
                    return

            # --- 1) обработка новых соперников
            if pending:
                lg = module.log()
                by_seq = {rr.get("seq"): rr
                          for rr in (lg.get("rivals") or [])}
                ctx["last_rival_at"] = time.monotonic()

                any_match = False
                any_nonmatch = False

                for seq in sorted(pending):
                    rr = by_seq.get(seq)
                    if rr is None:
                        continue
                    fn = ctx["fn"]
                    hit = None
                    marker = ""
                    if fn is not None:
                        try:
                            hit = bool(fn(rr))
                        except Exception:
                            hit = False
                        marker = "  >>> MATCH <<<" if hit else ""
                    print(f"[{seq:>3}]{marker} {_row(rr)}")
                    if hit or module.verbose_output:
                        _print_stones_detail(rr)

                    if hit:
                        any_match = True
                        ctx["matched_seqs"].append(seq)
                    elif fn is not None:
                        any_nonmatch = True

                fn = ctx["fn"]
                if fn is not None:
                    if any_match:
                        prev = ctx["state"]
                        ctx["state"] = "frozen_match"
                        ctx["next_tap_at"] = 0.0
                        if prev == "tapping":
                            print(f"   (MATCH on seq {ctx['matched_seqs']} — "
                                  f"останавливаю тапы)")
                        else:
                            print(f"   (MATCH on seq {ctx['matched_seqs']} — "
                                  f"авто-скип НЕ делаю, стоп)")
                    elif any_nonmatch and ctx["state"] != "frozen_match":
                        if ctx["state"] != "tapping":
                            ctx["state"] = "tapping"
                            now2 = time.monotonic()
                            ctx["next_tap_at"] = now2 + \
                                module.skip_wait_ms / 1000.0
                            print(f"   (burst START: первый тап через "
                                  f"{module.skip_wait_ms}ms, "
                                  f"interval={module.burst_interval_ms}ms)")

            # --- 2) burst: тап по расписанию
            if ctx["state"] == "tapping" and module.phantom and module.skip_xy:
                now = time.monotonic()

                # stall
                if (ctx["last_rival_at"] > 0
                        and now - ctx["last_rival_at"]
                            > module.stall_timeout_ms / 1000.0):
                    print(f"   (WARN: нет новых соперников "
                          f"{module.stall_timeout_ms}ms — прекращаю тапы)")
                    ctx["state"] = "stalled"
                    ctx["next_tap_at"] = 0.0
                elif now < ctx["pause_until"]:
                    # cooldown активен — пропускаем тик
                    pass
                elif now >= ctx["next_tap_at"]:
                    ok = module.do_skip()
                    ctx["taps_sent"] += 1
                    if ok:
                        ctx["fail_streak"] = 0
                    else:
                        ctx["fail_streak"] += 1
                        if ctx["fail_streak"] >= module.tap_fail_abort:
                            print(f"\nLIVE ABORT: {ctx['fail_streak']} "
                                  f"подряд FAILED-тапов — phantom/game dead")
                            return

                    # cooldown после N успешных
                    if (module.burst_pause_every > 0
                            and ctx["taps_sent"] % module.burst_pause_every == 0
                            and ctx["taps_sent"] > 0):
                        ctx["pause_until"] = now + module.burst_pause_ms / 1000.0
                        print(f"   (cooldown: {module.burst_pause_ms}ms "
                              f"после {ctx['taps_sent']} тапов)")

                    ctx["next_tap_at"] = now + module.burst_interval_ms / 1000.0

            # --- 3) stdin
            if not is_interactive:
                continue
            try:
                rlist, _, _ = select.select([sys.stdin], [], [], 0)
            except (OSError, ValueError):
                rlist = []
            if not rlist:
                continue

            line = sys.stdin.readline()
            if not line:
                print("\nLIVE stopped (stdin EOF).")
                return
            if not _handle_live_line(line, ctx):
                return
    except KeyboardInterrupt:
        print("\nLIVE stopped.")
    finally:
        module.set_live(False)


# ------------------------------------------------------------
# Help
# ------------------------------------------------------------
HELP = """\
=== stones — камни соперника (burst-режим) ===

  stones                     эта справка
  stones <filter>            автопоказ (Ctrl+C — выход)
  stones now                 текущий соперник (последний снимок)
  stones log [N]             последние N из журнала (default 10)
  stones reset               очистить журнал в агенте
  stones stop                detach хука
  stones clear               очистить консоль
  stones debug               диагностика rival_hook.js
  help                       то же, что stones help

Фильтры (live + burst-тапы на non-match):
  stones gold 50000          gold >= 50000
  stones 1stone 100000       хотя бы 1 камень rating >= 100000
  stones 2stone 100000       хотя бы 2 камня  rating >= 100000
  stones 3stone 200000       все камни rating >= 200000

BURST + STABILITY (config.yaml `stones.*`):
  skip_on_no_match   координаты тапа «следующий»
  skip_wait_ms       пауза перед первым тапом серии (default 80)
  burst_interval_ms  интервал между тапами (default 120)
  stall_timeout_ms   нет rival дольше → стоп (default 5000)

  burst_pause_every  каждые N тапов пауза (default 500, 0=off)
  burst_pause_ms     длительность паузы (default 3000)
  tap_fail_abort     N подряд FAILED-тапов → abort (default 10)
  health_check_interval_s  проверка Frida-сессии, сек (default 3)
  verbose_output     true = полный дамп (как раньше), false = компакт

Логика:
  * non-match → тап (x,y), потом ещё тап через burst_interval_ms,
    ещё... — непрерывно, пока не придёт rival_update.
  * rival пришёл → MATCH → стоп; non-match → тот же темп.
  * Game/Frida умерли (session.on('detached') или health-check) → ABORT.
  * Phantom сдох (N подряд FAILED) → ABORT.

Во время LIVE:
  stones <new filter>        сменить фильтр (сброс state)
  clear  /  stones clear     очистить консоль
  stones now                 показать последний снимок
  stones stop                выйти в меню
  Ctrl+C                     выйти в меню
"""


# ------------------------------------------------------------
# Dispatch
# ------------------------------------------------------------
def handle(module: StonesModule, argv: list) -> None:
    if not argv:
        print(HELP)
        return

    sub = argv[0].lower()

    if sub in ("help", "?", "-h", "--help"):
        print(HELP)
        return

    if sub == "now":
        r = module.last()
        if not r or not r.get("ok"):
            print("no rival yet — зайдите в Find a Match, пока идёт поиск.")
            if r.get("reason"):
                print(f"  reason: {r['reason']} seq={r.get('seq')}")
            return
        print("=== current rival ===")
        print(_row(r))
        print(f"  addr={r.get('addr')}")
        print(f"  fraction={r.get('fraction')}  n_items={r.get('n_items')}")
        _print_stones_detail(r)
        return

    if sub == "log":
        n = 10
        if len(argv) >= 2:
            v = _parse_int(argv[1])
            if v is not None:
                n = max(1, v)
        lg = module.log()
        rivals = (lg.get("rivals") or [])[-n:]
        if not rivals:
            print("журнал пуст — ещё не было Find a Match.")
            return
        print(f"=== last {len(rivals)} rival(s) ===")
        for r in rivals:
            print(_row(r))
        return

    if sub == "reset":
        ok = module.reset()
        print("journal cleared" if ok else "journal not cleared (hook not loaded?)")
        return

    if sub == "stop":
        module.stop()
        print("rival_hook stopped")
        return

    if sub in ("clear", "cls"):
        _clear_console()
        return

    if sub == "debug":
        if not HOOK_PATH.exists():
            print(f"rival_hook.js NOT FOUND: {HOOK_PATH}")
            return
        print(f"path: {HOOK_PATH}")
        print(f"size: {HOOK_PATH.stat().st_size} bytes")
        try:
            src = _load_hook_source()
            _log_source_head(src, n_lines=10, hex_bytes=200)
            print("sanitized OK (not yet passed to Frida)")
        except Exception as e:
            print(f"load failed: {e}")
        return

    if sub == "live":
        fn, label = _build_filter(argv[1:])
        stones_live(module, fn, label)
        return

    if _looks_like_filter(sub):
        if len(argv) < 2:
            print(f"usage: stones {sub} <MIN>")
            return
        fn, label = _build_filter(argv)
        if fn is None:
            print(f"bad filter: {' '.join(argv)!r}")
            print(f"usage: stones {sub} <MIN>")
            return
        stones_live(module, fn, label)
        return

    print(f"unknown subcommand: {sub}")
    print("try: stones")
