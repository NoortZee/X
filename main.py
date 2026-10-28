#!/usr/bin/env python3
import frida, sys, json, time, os, threading

PKG = "com.zeptolab.thieves.google"
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")

_done_event = threading.Event()
_done_status = {"error": None}

PRINT_TYPES = {
    "event",
    "detect_started", "detect_stopped", "detect_installed",
    "pump_installed", "pump_already",
    "module_base", "fatal",
    "hero_resolved", "hero_rescanned",
    "jumps_analysis", "jumps_plan", "jumps_timeline", "jumps_filter",
    "jumps_waiting_first_update",
    "jumps_armed", "jumps_ready",
    "jumps_progress",
    "jumps_done", "jumps_error",
    "jump_fired", "jump_error", "jump_deferred", "jump_skipped", "onframe_error",
    "fps",
}


def attach():
    device = frida.get_usb_device(timeout=5)
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

    def on_msg(msg, data):
        if msg["type"] == "send":
            p = msg["payload"]
            t = p.get("type") if isinstance(p, dict) else None

            if t == "jumps_error":
                _done_status["error"] = p.get("msg")
                _done_event.set()
            elif t == "jumps_done":
                _done_event.set()

            if t in PRINT_TYPES:
                print(f"[AGENT] {p}", flush=True)
        else:
            print(f"[FRIDA ERROR] {msg}", flush=True)

    script.on("message", on_msg)
    script.load()
    return session, script


def prompt(msg):
    try:
        input(msg); return True
    except (EOFError, KeyboardInterrupt):
        return False


def save_events(events):
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, "replay.json")
    with open(path, "w") as f:
        json.dump(events, f, indent=2)
    return path


def interactive_record(script):
    print("[..] pump_install", flush=True)
    script.exports_sync.pump_install()
    try: script.exports_sync.pump_resume()
    except Exception: pass
    print("[..] detect_install", flush=True)
    script.exports_sync.detect_install()

    print()
    print("═══ RECORD ═══", flush=True)
    print("В игре: зайдите в уровень, дождитесь ЗАМОРОЖЕННОГО состояния.", flush=True)

    if not prompt("Enter — НАЧАТЬ запись... "):
        return None

    script.exports_sync.detect_start()

    print()
    print("🔴 ЗАПИСЬ ИДЁТ — тапните по экрану в игре и играйте.", flush=True)
    print("   Каждый тап = один прыжок. Ждите приземления перед следующим.", flush=True)
    prompt("Enter — ОСТАНОВИТЬ запись... ")

    events = script.exports_sync.detect_stop()
    if not events:
        print("❌ событий нет.", flush=True)
        return None

    f0, fN = events[0], events[-1]
    dt = max(1, fN.get("t_ms", 0) - f0.get("t_ms", 0))
    df = max(0, fN["frame"] - f0["frame"])
    avg = round(df * 1000 / dt, 1) if df > 0 and dt > 0 else "n/a"

    path = save_events(events)
    print()
    print(f"✅ Записано {len(events)} событий (avg_fps ~{avg}):", flush=True)

    unfreeze_f = None
    first_update_f = None
    effective_jumps = 0
    for e in events:
        snap = e.get("snap") or {}
        marker = ""
        if e['name'] == 'unfreeze' or e['name'] == 'unfreeze_attack':
            marker = " ← якорь-fallback"
            if unfreeze_f is None:
                unfreeze_f = e['frame']
        if e['name'] == 'first_hero_update':
            marker = " ← ЯКОРЬ"
            first_update_f = e['frame']
        if e['name'] == 'jump':
            eff = (
                isinstance(snap.get('state_a0'), int) and (snap['state_a0'] & 7) == 0
                and (snap.get('ground_80', 0) or 0) + (snap.get('ground_84', 0) or 0) > 0
            )
            if eff: effective_jumps += 1
            marker = " ← эффективный" if eff else " (no-op)"
        print(
            f"   frame {e['frame']:4d}  t={e.get('t_ms', 0):5d}ms  {e['name']:20s}  "
            f"state={snap.get('state_a0','?')} ground={snap.get('ground_80','?')}/{snap.get('ground_84','?')} "
            f"cd={snap.get('cooldown_b0','?')}{marker}", flush=True)

    if first_update_f is not None and unfreeze_f is not None:
        spawn_delay = first_update_f - unfreeze_f
        print()
        print(f"   ⏱  unfreeze → first_hero_update: {spawn_delay} кадров", flush=True)

    print()
    print(f"   📊 Прыжков всего: {sum(1 for e in events if e['name']=='jump')}, "
          f"эффективных: {effective_jumps}", flush=True)
    print(f"   → {path}", flush=True)
    return events


def interactive_jumps(script, events, only_effective=False):
    mode_label = "ONLY-EFFECTIVE" if only_effective else "ALL-JUMPS"
    print()
    print(f"═══ JUMPS-ONLY PLAY ({mode_label}) ═══", flush=True)
    print("В игре:", flush=True)
    print("  1. Выйдите в лобби → зайдите в уровень заново", flush=True)
    print("  2. Дождитесь ЗАМОРОЖЕННОГО состояния", flush=True)
    print("  3. НЕ тапайте, пока программа не скажет «готово»", flush=True)
    print()
    print("⚠️  Игру НЕ перезапускайте — только уровень.", flush=True)

    if not prompt("Enter — программа встанет на слежку... "):
        print("Отменено.", flush=True)
        return

    _done_event.clear()
    _done_status["error"] = None

    script.exports_sync.replay_jumps_only(events, {"only_effective": only_effective})

    print()
    print("🟢 Программа готова. СЕЙЧАС тапните ОДИН раз по экрану в игре.", flush=True)
    print("   Ждём: unfreeze → first HeroBody::update → прыжки по якорю.", flush=True)

    while not _done_event.wait(timeout=1.0):
        pass

    if _done_status["error"]:
        print(f"\n❌ Ошибка: {_done_status['error']}", flush=True)
    else:
        print("\n✅ Jumps playback завершён.", flush=True)


if __name__ == "__main__":
    print("[main] start", flush=True)

    if len(sys.argv) < 2:
        print("Usage:", flush=True)
        print("  main.py rehearse [--only-effective]   — запись + jumps-playback", flush=True)
        print("  main.py record                        — только запись", flush=True)
        print("  main.py jumps [log] [--only-effective] — только jumps-playback", flush=True)
        print()
        print("  По умолчанию: воспроизводятся ВСЕ jump из лога (для точной траектории).", flush=True)
        print("  --only-effective: только эффективные (state=0, на земле) — короче, но может разойтись.", flush=True)
        sys.exit(1)

    mode_cmd = sys.argv[1]
    print(f"[main] mode={mode_cmd}", flush=True)

    only_effective = "--only-effective" in sys.argv

    session, script = attach()
    print("[main] attached & script loaded", flush=True)

    if mode_cmd == "rehearse":
        events = interactive_record(script)
        if events:
            interactive_jumps(script, events, only_effective)

    elif mode_cmd == "record":
        interactive_record(script)

    elif mode_cmd == "jumps":
        args = [a for a in sys.argv[2:] if not a.startswith("--")]
        log_path = args[0] if args else os.path.join(LOG_DIR, "replay.json")
        with open(log_path) as f:
            events = json.load(f)
        print(f"[main] загружено {len(events)} событий из {log_path}", flush=True)
        interactive_jumps(script, events, only_effective)

    else:
        print(f"Unknown mode: {mode_cmd}", flush=True)
