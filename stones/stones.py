"""stones.py — доп. модуль: получение камней соперника.

v16 (telegram):
  * TgNotifier — отправка уведомления в Telegram при MATCH.
    Использует только stdlib (urllib), без внешних зависимостей.
  * Отправка в daemon-thread — не блокирует stones loop.
  * Антиспам `min_interval_s` между сообщениями.
  * `stones tg-test` — проверить отправку.
  * Фикс: matched_seqs теперь per-batch (раньше копились между пачками).

v15 (diagnostics): обработка rival_data_suspect / rival_data_invalid.
v14: stability (cooldown, health-check, tap_fail_abort).
v13: без tune/show.
v12: burst.
v11: ускорение.
v10: ретрай отложенного skip.
v9: skip_wait_ms, skip_delay_ms.
v8: auto-skip на non-match.
v7: `stones <filter>` без live; clear внутри LIVE.
v6: stdin polling через select().
v5: автопоказ, robust loading, sanity-check, ASCII fallback.
"""
from __future__ import annotations

import logging
import select
import sys
import threading
import time
import urllib.parse
import urllib.request
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
# Telegram notifier
# ------------------------------------------------------------
class TgNotifier:
    """Отправка уведомлений в Telegram Bot API через stdlib urllib.

    - enabled=False или пустой token/chat_id → no-op.
    - min_interval_s: антиспам между сообщениями.
    - Отправка в daemon-thread → не блокирует stones loop.
    """

    API_TMPL = "https://api.telegram.org/bot{token}/sendMessage"

    def __init__(self,
                 bot_token: str = "",
                 chat_id: str = "",
                 enabled: bool = False,
                 timeout_s: float = 5.0,
                 min_interval_s: float = 10.0):
        self.bot_token = (bot_token or "").strip()
        self.chat_id = str(chat_id or "").strip()
        self.timeout_s = max(1.0, float(timeout_s))
        self.min_interval_s = max(0.0, float(min_interval_s))

        raw_enabled = bool(enabled)
        self.enabled = raw_enabled and bool(self.bot_token) and bool(self.chat_id)

        if raw_enabled and not self.enabled:
            log.warning(
                "telegram: enabled=true, но token/chat_id пустые — "
                "уведомления отключены"
            )
        if self.enabled:
            log.info(
                "telegram: enabled (chat_id=%s, min_interval=%.0fs, timeout=%.0fs)",
                self.chat_id, self.min_interval_s, self.timeout_s,
            )

        self._last_sent_t = 0.0
        self._lock = threading.Lock()

    # ---------- internals ----------
    def _should_send(self) -> bool:
        if not self.enabled:
            return False
        now = time.monotonic()
        with self._lock:
            if now - self._last_sent_t < self.min_interval_s:
                return False
            self._last_sent_t = now
            return True

    def _http_send(self, text: str) -> bool:
        url = self.API_TMPL.format(token=self.bot_token)
        data = urllib.parse.urlencode({
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                body = resp.read()
                if resp.status != 200:
                    log.warning("telegram: HTTP %s body=%r",
                                resp.status, body[:200])
                    return False
                return True
        except Exception as e:
            log.warning("telegram send failed: %s", e)
            return False

    @staticmethod
    def _format_rival(r: dict) -> str:
        seq = r.get("seq", "?")
        gold = r.get("gold")
        lvl = r.get("player_level")
        total = r.get("total_rating")
        lines = [f"seq={seq} gold={gold} lvl={lvl} total={total}"]
        for s in (r.get("stones") or []):
            if not isinstance(s, dict):
                continue
            if s.get("rating") is None:
                continue
            lines.append(
                f"  slot={s.get('slot')} rating={s.get('rating')} "
                f"cnt={s.get('cnt')} flag={s.get('flag')}"
            )
        return "\n".join(lines)

    # ---------- public ----------
    def force_send(self, text: str) -> bool:
        """Синхронная отправка без throttle. Для `stones tg-test`."""
        if not self.enabled:
            return False
        return self._http_send(text)

    def notify_match(self, rivals: list, filter_label: str = "") -> None:
        """Отправляет уведомление о MATCH в фоне (не блокирует caller)."""
        if not self.enabled:
            return
        if not self._should_send():
            log.debug("telegram: throttled (min_interval=%.0fs)",
                      self.min_interval_s)
            return

        header = f"🎯 <b>MATCH</b> — filter: {filter_label or 'none'}"
        body_parts = [header]
        for r in rivals:
            body_parts.append("")
            body_parts.append(self._format_rival(r))
        text = "\n".join(body_parts)

        t = threading.Thread(
            target=self._http_send,
            args=(text,),
            name="tg-send",
            daemon=True,
        )
        t.start()


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
                 verbose_output: bool = False,
                 tg_notifier: Optional[TgNotifier] = None):
        self.session = session
        self.script: Optional[frida.core.Script] = None
        self._installed = False

        self.phantom = phantom
        self.skip_xy = skip_xy
        self.skip_wait_ms = max(0, int(skip_wait_ms))
        self.burst_interval_ms = max(10, int(burst_interval_ms))
        self.stall_timeout_ms = max(500, int(stall_timeout_ms))

        self.burst_pause_every = max(0, int(burst_pause_every))
        self.burst_pause_ms = max(0, int(burst_pause_ms))
        self.tap_fail_abort = max(1, int(tap_fail_abort))
        self.health_check_interval_s = max(0.5, float(health_check_interval_s))
        self.verbose_output = bool(verbose_output)

        self.tg_notifier = tg_notifier

        self._last_skip_t = 0.0
        self._tap_ok_count = 0
        self._session_dead = False
        self._session_detach_reason = None

        self._live = False
        self._pending_seqs: list = []
        self._live_event = threading.Event()
        self._live_lock = threading.Lock()

        self._attach_session_listener()

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

    def do_skip(self) -> bool:
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
            elif t == "rival_data_suspect":
                log.warning("[rival] suspect data seq=%s issues=%s sample=%s",
                            p.get("seq"), p.get("issues"), p.get("sample"))
            elif t == "rival_data_invalid":
                print()
                print("=" * 64)
                print("!!!  RIVAL DATA INVALID — offsets или AOB устарели  !!!")
                print("=" * 64)
                print("msg:", p.get("msg"))
                print("hint:", p.get("hint"))
                print("=" * 64)
                print()
                log.error("[rival] rival_data_invalid: %s", p.get("msg"))
            elif t == "err":
                log.error("[rival] err where=%s: %s",
                          p.get("where"), p.get("msg"))
        else:
            log.error("[rival frida] %s", msg)

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
LIVE_TICK_S = 0.01


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
    tg = getattr(module, "tg_notifier", None)
    if tg is not None and tg.enabled:
        print(f"  TELEGRAM: enabled (chat_id={tg.chat_id}, "
              f"min_interval={tg.min_interval_s:.0f}s)")
    else:
        print("  TELEGRAM: disabled")
    print()


def _reset_live_state(ctx: dict) -> None:
    ctx["state"] = "idle"
    ctx["next_tap_at"] = 0.0
    ctx["last_rival_at"] = 0.0
    ctx["taps_sent"] = 0
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

    if sub in ("tg-test", "tg_test", "tgtest"):
        tg = getattr(mod, "tg_notifier", None) if mod else None
        if tg is None or not tg.enabled:
            print("telegram disabled (config.yaml: telegram.enabled / "
                  "bot_token / chat_id)")
            return True
        ok = tg.force_send("🧪 <b>stones</b>: test message")
        print("tg-test sent (check chat)" if ok else "tg-test FAILED (см. лог)")
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

            # --- 0) fatal
            if module.is_session_dead():
                print(f"\nLIVE ABORT: frida session detached "
                      f"({module.session_detach_reason()})")
                return

            # --- 0.1) health-check
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
                batch_matched = []

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
                        batch_matched.append(seq)
                    elif fn is not None:
                        any_nonmatch = True

                fn = ctx["fn"]
                if fn is not None:
                    if any_match:
                        prev = ctx["state"]
                        ctx["state"] = "frozen_match"
                        ctx["next_tap_at"] = 0.0
                        if prev == "tapping":
                            print(f"   (MATCH on seq {batch_matched} — "
                                  f"останавливаю тапы)")
                        else:
                            print(f"   (MATCH on seq {batch_matched} — "
                                  f"авто-скип НЕ делаю, стоп)")
                        # Telegram — только на текущий batch, без throttle
                        # от прошлых матчей (throttle внутри notify_match)
                        tg = getattr(module, "tg_notifier", None)
                        if tg is not None and tg.enabled:
                            matched_rivals = [by_seq[s] for s in batch_matched
                                              if s in by_seq]
                            tg.notify_match(matched_rivals, ctx["label"])
                            print(f"   (telegram: уведомление отправляется)")
                    elif any_nonmatch and ctx["state"] != "frozen_match":
                        if ctx["state"] != "tapping":
                            ctx["state"] = "tapping"
                            now2 = time.monotonic()
                            ctx["next_tap_at"] = now2 + \
                                module.skip_wait_ms / 1000.0
                            print(f"   (burst START: первый тап через "
                                  f"{module.skip_wait_ms}ms, "
                                  f"interval={module.burst_interval_ms}ms)")

            # --- 2) burst
            if ctx["state"] == "tapping" and module.phantom and module.skip_xy:
                now = time.monotonic()

                if (ctx["last_rival_at"] > 0
                        and now - ctx["last_rival_at"]
                            > module.stall_timeout_ms / 1000.0):
                    print(f"   (WARN: нет новых соперников "
                          f"{module.stall_timeout_ms}ms — прекращаю тапы)")
                    ctx["state"] = "stalled"
                    ctx["next_tap_at"] = 0.0
                elif now < ctx["pause_until"]:
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
  stones tg-test             отправить тестовое сообщение в Telegram
  help                       то же, что stones help

Фильтры (live + burst-тапы на non-match):
  stones gold 50000          gold >= 50000
  stones 1stone 100000       хотя бы 1 камень rating >= 100000
  stones 2stone 100000       хотя бы 2 камня  rating >= 100000
  stones 3stone 200000       все камни rating >= 200000

Telegram (config.yaml `telegram.*`):
  enabled        false = выключено
  bot_token      токен от @BotFather
  chat_id        твой user_id / -100… для группы
  timeout_s      HTTP timeout (default 5)
  min_interval_s антиспам между сообщениями (default 10)

  При MATCH уходит сообщение в чат. Проверить: `stones tg-test`.

BURST + STABILITY (config.yaml `stones.*`):
  skip_on_no_match, skip_wait_ms, burst_interval_ms, stall_timeout_ms
  burst_pause_every, burst_pause_ms, tap_fail_abort,
  health_check_interval_s, verbose_output

Во время LIVE:
  stones <new filter>        сменить фильтр (сброс state)
  clear  /  stones clear     очистить консоль
  stones now                 показать последний снимок
  stones tg-test             тест Telegram
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

    if sub in ("tg-test", "tg_test", "tgtest"):
        tg = getattr(module, "tg_notifier", None)
        if tg is None or not tg.enabled:
            print("telegram disabled (config.yaml: telegram.enabled / "
                  "bot_token / chat_id)")
            return
        ok = tg.force_send("🧪 <b>stones</b>: test message")
        print("tg-test sent (check chat)" if ok else "tg-test FAILED (см. лог)")
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
