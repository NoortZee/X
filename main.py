#!/usr/bin/env python3
import frida, sys, json, os, threading

PKG = "com.zeptolab.thieves.google"
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
LOG_PATH = os.path.join(LOG_DIR, "replay.json")

FRIDA_HOST = os.environ.get("FRIDA_HOST", "127.0.0.1:41337")

_done_event = threading.Event()
_done_status = {"error": None}

PRINT_TYPES = {
    "event",
    "detect_started", "detect_stopped", "detect_installed",
    "pump_installed", "pump_already",
    "module_base", "fatal",
    "hero_resolved",
    "jumps_analysis", "jumps_plan",
    "jumps_waiting_first_update",
    "jumps_armed",
    "jumps_progress",
    "jumps_done", "jumps_error", "jumps_timeout",
    "jump_fired", "jump_error", "jump_deferred", "jump_skipped", "onframe_error",
    "fps",
    "anchor_state_check",
    "divergence",
    "determinism_result",
    "dbg",
}

REPLAY_FORMAT_VERSION = 3


# ------------------------------------------------------------
# FRIDA ATTACH
# ------------------------------------------------------------

def attach():
    device = frida.get_device_manager().add_remote_device(FRIDA_HOST)
    session = None
    last_err = None

    for target in (PKG, "King of Thieves"):
        try:
            session = device.attach(target)
            print(f"[OK] attached by name: {target}", flush=True)
            break
        except frida.ProcessNotFoundError as e:
            last_err = e
            print(f"[..] not found by name: {target}", flush=True)

    if session is None:
        for p in device.enumerate_processes():
            if "thieves" in p.name.lower():
                session = device.attach(p.pid)
                print(f"[OK] attached by PID {p.pid}: {p.name}", flush=True)
                break

    if session is None:
        raise last_err or RuntimeError("Game not running.")

    agent_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.js")
    with open(agent_path) as f:
        script = session.create_script(f.read())

    def on_msg(msg, _data):
        if msg["type"] == "send":
            p = msg["payload"]
            t = p.get("type") if isinstance(p, dict) else None

            if t == "jumps_error":
                _done_status["error"] = p.get("msg")
                _done_event.set()
            elif t == "jumps_done":
                v = p.get("verify")
                if v:
                    ok = (v.get("divergences") == 0)
                    _print_verify({"ok": ok, "verify": v})
                print(f"[AGENT] jumps_done: fired={p.get('fired')} "
                      f"skipped={p.get('skipped')} total={p.get('total_planned')}",
                      flush=True)
                _done_event.set()
            elif t == "jumps_timeout":
                _done_status["error"] = f"timeout ({p.get('reason')})"
                _done_event.set()

            if t in PRINT_TYPES:
                if t == "dbg":
                    print(f"[DBG] {p}", flush=True)
                else:
                    print(f"[AGENT] {p}", flush=True)
        else:
            print(f"[FRIDA ERROR] {msg}", flush=True)

    script.on("message", on_msg)
    script.load()

    script.exports_sync.pump_install()
    script.exports_sync.detect_install()
    try:
        script.exports_sync.pump_resume()
    except Exception:
        pass

    return session, script


# ------------------------------------------------------------
# PRINT HELPERS
# ------------------------------------------------------------

def _print_verify(p):
    if p.get("ok"):
        print("╔══════════════════════════════════════════════╗", flush=True)
        print("║  ✅ BIT-EXACT MATCH — идеальный реплей        ║", flush=True)
        print("╚══════════════════════════════════════════════╝", flush=True)
        return
    v = p.get("verify") or {}
    print("╔══════════════════════════════════════════════╗", flush=True)
    print("║  ⚠ РАСХОЖДЕНИЕ В РЕПЛЕЕ                      ║", flush=True)
    print("╚══════════════════════════════════════════════╝", flush=True)
    print(f"   compared={v.get('compared')}  divergences={v.get('divergences')}  max_u32_diff={v.get('max_abs_diff_u32')}", flush=True)
    fd = v.get("first_divergence")
    if fd:
        print(f"   first divergence: replayFrame={fd.get('f')}  recFrame={fd.get('recFrame')}", flush=True)
        for d in fd.get("diffs", [])[:6]:
            print(f"     {d.get('field')}: actual={d.get('actual')}  expected={d.get('expected')}", flush=True)
    for s in (v.get("samples") or [])[:3]:
        print(f"   sample f={s.get('f')} rec={s.get('recFrame')}", flush=True)
        for d in s.get("diffs", [])[:4]:
            print(f"     {d.get('field')}: actual={d.get('actual')}  expected={d.get('expected')}", flush=True)


def prompt(msg):
    try:
        input(msg); return True
    except (EOFError, KeyboardInterrupt):
        return False


# ------------------------------------------------------------
# LOG I/O
# ------------------------------------------------------------

def _find_anchor(events):
    for e in events:
        if e.get("name") == "first_hero_update":
            return e["frame"]
    for e in events:
        if e.get("name") in ("unfreeze", "unfreeze_attack"):
            return e["frame"]
    return None


def _build_report_lines(events, bodies, anchor):
    L = []
    L.append("=" * 78)
    L.append("  REPLAY REPORT  (v3.6 — pure input replay, frame-synced)")
    L.append("=" * 78)
    L.append(f"  events:       {len(events)}")
    L.append(f"  body_frames:  {len(bodies)}")
    L.append(f"  anchor_frame: {anchor}")
    if bodies:
        L.append(f"  body range:   {bodies[0]['frame']}..{bodies[-1]['frame']}")
    L.append("")
    L.append("-" * 78)
    L.append(f"  {'frame':>6}  {'rel':>5}  {'t_ms':>6}  {'name':<22}  details")
    L.append("-" * 78)
    for e in events:
        snap = e.get("snap") or {}
        details = ""
        if e["name"] == "jump":
            g = (snap.get("ground_80") or 0) + (snap.get("ground_84") or 0)
            details = f"state={snap.get('state_a0')}  ground={g}  cd={snap.get('cooldown_b0')}"
        elif "state_a0" in snap:
            details = f"state={snap['state_a0']}"
        rel = e.get("rel_frame")
        L.append(f"  {e['frame']:>6}  {str(rel):>5}  {int(e.get('t_ms', 0)):>6}  "
                 f"{e['name']:<22}  {details}")
    return L


def save_log(events, body_frames, timeline_ns=None, rng_log=None):
    os.makedirs(LOG_DIR, exist_ok=True)
    body_frames = body_frames or []
    anchor = _find_anchor(events)

    rich_events = []
    for e in events:
        ev = dict(e)
        f, t = ev.get("frame"), ev.get("t_ms")
        if isinstance(f, int) and isinstance(anchor, int):
            ev["rel_frame"] = f - anchor
        if isinstance(t, (int, float)):
            ev["t_sec"] = round(t / 1000.0, 3)
        rich_events.append(ev)

    rich_bodies = []
    for b in body_frames:
        nb = dict(b)
        for k in ("px", "py", "ang", "vx", "vy", "av"):
            if isinstance(nb.get(k), float):
                nb[k] = float(nb[k])
        rich_bodies.append(nb)

    report_lines = _build_report_lines(rich_events, rich_bodies, anchor)

    out = []
    out.append("{")
    out.append('  "replay_report": {')
    out.append(f'    "anchor_frame": {json.dumps(anchor)},')
    out.append(f'    "events_count": {len(rich_events)},')
    out.append(f'    "body_frames_count": {len(rich_bodies)},')
    out.append('    "lines": [')
    for i, ln in enumerate(report_lines):
        comma = "," if i < len(report_lines) - 1 else ""
        out.append('      ' + json.dumps(ln, ensure_ascii=False) + comma)
    out.append('    ]')
    out.append('  },')
    out.append(f'  "version": {REPLAY_FORMAT_VERSION},')
    out.append(f'  "anchor_frame": {json.dumps(anchor)},')

    out.append('  "events": [')
    for i, e in enumerate(rich_events):
        pretty = json.dumps(e, indent=2, ensure_ascii=False)
        pretty = "\n".join("    " + line for line in pretty.split("\n"))
        out.append(pretty + ("," if i < len(rich_events) - 1 else ""))
    out.append('  ],')

    out.append('  "body_frames": [')
    for i, b in enumerate(rich_bodies):
        out.append('    ' + json.dumps(b, ensure_ascii=False)
                   + ("," if i < len(rich_bodies) - 1 else ""))
    out.append('  ]')

    if timeline_ns:
        out.append(',')
        out.append('  "timeline_ns": ' + json.dumps(timeline_ns))
    if rng_log:
        out.append(',')
        out.append('  "rng_log": ' + json.dumps(rng_log[:2000]))

    out.append('}')

    tmp_path = LOG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.replace(tmp_path, LOG_PATH)
    return LOG_PATH


def load_log(path=None):
    path = path or LOG_PATH
    if not os.path.exists(path):
        return [], [], None, None

    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"[main] WARN: не удалось открыть {path}: {e}", flush=True)
        return [], [], None, None

    if not text.strip():
        print(f"[main] WARN: {path} пустой — пропускаю загрузку", flush=True)
        return [], [], None, None

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"[main] WARN: {path} повреждён ({e}) — пропускаю загрузку",
              flush=True)
        return [], [], None, None

    if isinstance(data, list):
        return [], data, None, None

    return (
        data.get("events", []),
        data.get("body_frames", []),
        data.get("timeline_ns"),
        data.get("rng_log"),
    )


# ------------------------------------------------------------
# ACTIONS
# ------------------------------------------------------------

def do_record(script):
    print()
    print("═══ RECORD (with body-state + diagnostics) ═══")
    print("Зайдите на уровень чтоб он был в ЗАМОРОЖЕННОМ состоянии.")
    if not prompt("Enter — НАЧАТЬ запись... "):
        print("Отменено.")
        return None

    script.exports_sync.detect_start()
    print()
    print("🔴 ЗАПИСЬ ИДЁТ — тапните по экрану и играйте.")
    prompt("Enter — ОСТАНОВИТЬ запись... ")

    events = script.exports_sync.detect_stop()
    body_frames = script.exports_sync.detect_get_body_frames()
    timeline = script.exports_sync.detect_get_frame_ns_timeline()
    rng_log = script.exports_sync.detect_get_rng_log()

    if not events:
        print("❌ событий нет.")
        return None

    save_log(events, body_frames, timeline, rng_log)

    print()
    print(f"✅ Записано {len(events)} событий + {len(body_frames)} body_frames")
    print(f"   timeline: {len(timeline) if timeline else 0} сэмплов  |  rng: {len(rng_log or [])} вызовов")

    unfreeze_f = None
    first_update_f = None
    effective_jumps = 0
    total_jumps = 0

    for e in events:
        snap = e.get("snap") or {}
        marker = ""
        if e['name'] in ('unfreeze', 'unfreeze_attack'):
            marker = " ← якорь-fallback"
            if unfreeze_f is None:
                unfreeze_f = e['frame']
        if e['name'] == 'first_hero_update':
            marker = " ← ЯКОРЬ (first_hero_update)"
            first_update_f = e['frame']
        if e['name'] == 'jump':
            total_jumps += 1
            eff = (
                isinstance(snap.get('state_a0'), int) and (snap['state_a0'] & 7) == 0
                and (snap.get('ground_80', 0) or 0) + (snap.get('ground_84', 0) or 0) > 0
            )
            if eff:
                effective_jumps += 1
            marker = " ← эффективный" if eff else " (no-op)"
        print(
            f"   frame {e['frame']:4d}  t={e.get('t_ms', 0):5d}ms  {e['name']:20s}  "
            f"state={snap.get('state_a0','?')} ground={snap.get('ground_80','?')}/{snap.get('ground_84','?')} "
            f"cd={snap.get('cooldown_b0','?')}{marker}"
        )

    if first_update_f is not None and unfreeze_f is not None:
        print()
        print(f"   ⏱  unfreeze → first_hero_update: {first_update_f - unfreeze_f} кадров")

    if body_frames:
        sample = body_frames[0]
        print()
        print(f"   📦 body_frames: {len(body_frames)} записей, "
              f"кадры {body_frames[0].get('frame')}..{body_frames[-1].get('frame')}")
        print(f"      sample[0]: px={sample.get('px'):.17g} py={sample.get('py'):.17g} "
              f"ang={sample.get('ang'):.17g} vx={sample.get('vx'):.17g} vy={sample.get('vy'):.17g}")

    print()
    print(f"   📊 Прыжков всего: {total_jumps}, эффективных: {effective_jumps}")
    print(f"   → {LOG_PATH}")
    return events, body_frames


def do_determinism(script):
    print()
    print("═══ DETERMINISM CHECK ═══")
    print("Сделаем ДВА прогона с идентичным вводом и сравним бит-в-бит.")
    print("Важно: вход в уровень и набор действий должны быть одинаковыми!")

    if not prompt("Enter — запись A... "):
        return
    script.exports_sync.detect_start()
    print("🔴 A ИДЁТ — играйте как обычно.")
    prompt("Enter — ОСТАНОВИТЬ A... ")
    script.exports_sync.detect_stop()
    bfA = script.exports_sync.detect_get_body_frames()

    if not prompt("Enter — запись B (тот же ввод)... "):
        return
    script.exports_sync.detect_start()
    print("🔴 B ИДЁТ — ТОЧНО ТОТ ЖЕ ввод.")
    prompt("Enter — ОСТАНОВИТЬ B... ")
    script.exports_sync.detect_stop()
    bfB = script.exports_sync.detect_get_body_frames()

    if not bfA or not bfB:
        print("❌ нет body_frames в одном из прогонов.")
        return

    result = script.exports_sync.compare_two_recordings(bfA, bfB)
    print()
    print("═══ DETERMINISM RESULT ═══")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if result.get("deterministic"):
        print("✅ ФИЗИКА ДЕТЕРМИНИРОВАНА (бит-в-бит)")
    else:
        print(f"⚠ РАСХОЖДЕНИЙ: {result.get('diffs')} — искать источник недетерминизма")


def do_play(script, events, body_frames, rng_log=None, verbose=False):
    if not events:
        print("Нет данных для воспроизведения (сначала сделайте record).")
        return

    print()
    print(f"═══ PLAY (pure, frame-synced, jump from onLeave, verbose={verbose}) ═══")
    if rng_log:
        print(f"   RNG replay: enabled ({len(rng_log)} calls)")
    else:
        print(f"   RNG replay: disabled (no rng_log — libc rng hooks будут пропущены)")
    print("   Физика НЕ модифицируется (только чтение и сравнение)")
    print("   Time hooks (clock_gettime/gettimeofday): DISABLED в play")
    if verbose:
        print("   verbose=true: диагностические send() ВКЛЮЧЕНЫ (виден трафик)")
    else:
        print("   verbose=false: ноль send() во время игры, только один jumps_done в конце")
    print("В игре:")
    print("  1. Зайдите на уровень чтоб он был в ЗАМОРОЖЕННОМ состоянии")
    print("  2. запустите режим слежки и запустите уровень")

    if not prompt("Enter — программа встанет на слежку... "):
        print("Отменено.")
        return

    _done_event.clear()
    _done_status["error"] = None

    opts = {
        "body_frames": body_frames or [],
        "verbose": bool(verbose),
    }
    if rng_log:
        opts["rng_log"] = rng_log

    script.exports_sync.replay_jumps_only(events, opts)

    print()
    print("🟢 Готов. Тапните ОДИН раз по экрану в игре.")

    while not _done_event.wait(timeout=1.0):
        pass

    if _done_status["error"]:
        print(f"\n❌ Ошибка: {_done_status['error']}")
    else:
        print("\n✅ Jumps playback завершён.")


def do_rehearse(script, verbose=False):
    res = do_record(script)
    if not res:
        return None
    events, body_frames = res
    ev, bf, tl, rng = load_log()
    do_play(script, events, body_frames, rng, verbose)
    return events, body_frames


def do_clear():
    if os.path.exists(LOG_PATH):
        try:
            os.remove(LOG_PATH)
            print(f"Удалено: {LOG_PATH}")
        except Exception as e:
            print(f"Не удалось удалить: {e}")
    else:
        print("Лог уже пуст.")
    return [], [], None, None


# ------------------------------------------------------------
# MENU LOOP
# ------------------------------------------------------------

def print_menu(events, body_frames):
    log_exists = os.path.exists(LOG_PATH)
    if events:
        log_state = f"есть {len(events)} соб. / {len(body_frames)} bf"
    elif log_exists:
        log_state = "есть на диске"
    else:
        log_state = "пусто"

    print()
    print("─────────────────────────────────────────────────")
    print(f"  Лог: {log_state}")
    print("─────────────────────────────────────────────────")
    print("  Enter / rehearse       — запись + воспроизведение")
    print("  rehearse-verbose       — запись + воспроизведение (debug)")
    print("  record                 — только запись")
    print("  play                   — только воспроизведение")
    print("  play-verbose           — воспроизведение (debug)")
    print("  determinism            — два прогона + сравнение")
    print("  clear                  — удалить лог")
    print("  exit / q               — выход")
    print("─────────────────────────────────────────────────")


def main_loop(script):
    events, body_frames, timeline_ns, rng_log = load_log()
    if events:
        print(f"[main] загружен существующий лог: {len(events)} событий, {len(body_frames)} body_frames")

    while True:
        print_menu(events, body_frames)
        try:
            cmd = input("> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n[main] выход")
            return

        try:
            if cmd in ("", "rehearse", "r"):
                do_rehearse(script, verbose=False)
                events, body_frames, timeline_ns, rng_log = load_log()
            elif cmd in ("rehearse-verbose", "rv"):
                do_rehearse(script, verbose=True)
                events, body_frames, timeline_ns, rng_log = load_log()
            elif cmd in ("record", "rec"):
                res = do_record(script)
                if res:
                    events, body_frames, timeline_ns, rng_log = load_log()
            elif cmd in ("play", "p"):
                if not events:
                    events, body_frames, timeline_ns, rng_log = load_log()
                do_play(script, events, body_frames, rng_log, verbose=False)
            elif cmd in ("play-verbose", "pv"):
                if not events:
                    events, body_frames, timeline_ns, rng_log = load_log()
                do_play(script, events, body_frames, rng_log, verbose=True)
            elif cmd in ("determinism", "det"):
                do_determinism(script)
            elif cmd in ("clear", "c"):
                events, body_frames, timeline_ns, rng_log = do_clear()
            elif cmd in ("exit", "quit", "q"):
                print("[main] выход")
                return
            else:
                print(f"Неизвестная команда: '{cmd}'")
        except frida.InvalidOperationError as e:
            print(f"\n[!] Frida сессия потеряна: {e}")
            print("[!] Перезапустите игру и запустите скрипт заново.")
            return
        except Exception as e:
            print(f"\n[!] Ошибка: {e}")


# ------------------------------------------------------------

if __name__ == "__main__":
    print(f"[main] v{REPLAY_FORMAT_VERSION} start")
    print("[main] attaching to King of Thieves...")
    try:
        _session, _script = attach()
    except Exception as e:
        print(f"[main] не удалось подключиться: {e}")
        print("[main] Убедитесь, что игра запущена и frida-server активен.")
        sys.exit(1)
    print("[main] готово. Интерактивный режим.")
    main_loop(_script)
