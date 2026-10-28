#!/usr/bin/env python3
import frida, sys, json, os, threading

PKG = "com.zeptolab.thieves.google"
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
LOG_PATH = os.path.join(LOG_DIR, "replay.json")

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
    "jumps_armed", "jumps_ready",
    "jumps_progress",
    "jumps_done", "jumps_error",
    "jump_fired", "jump_error", "jump_deferred", "jump_skipped", "onframe_error",
    "fps",
}

REPLAY_FORMAT_VERSION = 2


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

    def on_msg(msg, _data):
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

    # install + detect прицепляем один раз за сессию
    script.exports_sync.pump_install()
    script.exports_sync.detect_install()
    try:
        script.exports_sync.pump_resume()
    except Exception:
        pass

    return session, script


# ------------------------------------------------------------
# I/O helpers
# ------------------------------------------------------------

def prompt(msg):
    try:
        input(msg); return True
    except (EOFError, KeyboardInterrupt):
        return False


def save_log(events, body_frames):
    os.makedirs(LOG_DIR, exist_ok=True)
    data = {
        "version": REPLAY_FORMAT_VERSION,
        "events": events,
        "body_frames": body_frames or [],
    }
    with open(LOG_PATH, "w") as f:
        json.dump(data, f)
    return LOG_PATH


def load_log(path=None):
    path = path or LOG_PATH
    if not os.path.exists(path):
        return [], []
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, list):
        return data, []
    return data.get("events", []), data.get("body_frames", [])


# ------------------------------------------------------------
# ACTIONS
# ------------------------------------------------------------

def do_record(script):
    print()
    print("═══ RECORD (with body-state) ═══")
    print("В игре: зайдите в уровень, дождитесь ЗАМОРОЖЕННОГО состояния.")
    if not prompt("Enter — НАЧАТЬ запись... "):
        print("Отменено.")
        return None

    script.exports_sync.detect_start()
    print()
    print("🔴 ЗАПИСЬ ИДЁТ — тапните по экрану и играйте.")
    prompt("Enter — ОСТАНОВИТЬ запись... ")

    events = script.exports_sync.detect_stop()
    body_frames = script.exports_sync.detect_get_body_frames()

    if not events:
        print("❌ событий нет.")
        return None

    save_log(events, body_frames)

    print()
    print(f"✅ Записано {len(events)} событий + {len(body_frames)} body_frames")

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
            marker = " ← ЯКОРЬ"
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
        print(f"      sample[0]: px={sample.get('px'):.2f} py={sample.get('py'):.2f} "
              f"ang={sample.get('ang'):.3f} vx={sample.get('vx'):.2f} vy={sample.get('vy'):.2f}")

    print()
    print(f"   📊 Прыжков всего: {total_jumps}, эффективных: {effective_jumps}")
    print(f"   → {LOG_PATH}")
    return events, body_frames


def do_play(script, events, body_frames):
    if not events:
        print("Нет данных для воспроизведения (сначала сделайте record).")
        return

    print()
    print("═══ JUMPS-ONLY PLAY (body-force) ═══")
    print("В игре:")
    print("  1. Выйдите в лобби → зайдите в уровень заново")
    print("  2. Дождитесь ЗАМОРОЖЕННОГО состояния")
    print("  3. НЕ тапайте, пока программа не скажет «готово»")
    print("⚠️  Игру НЕ перезапускайте — только уровень.")

    if not prompt("Enter — программа встанет на слежку... "):
        print("Отменено.")
        return

    _done_event.clear()
    _done_status["error"] = None

    script.exports_sync.replay_jumps_only(events, {"body_frames": body_frames or []})

    print()
    print("🟢 Программа готова. СЕЙЧАС тапните ОДИН раз по экрану в игре.")
    print("   Anchor = first_hero_update; body state форсится каждый кадр.")

    while not _done_event.wait(timeout=1.0):
        pass

    if _done_status["error"]:
        print(f"\n❌ Ошибка: {_done_status['error']}")
    else:
        print("\n✅ Jumps playback завершён.")


def do_rehearse(script):
    res = do_record(script)
    if not res:
        return None, [], []
    events, body_frames = res
    do_play(script, events, body_frames)
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
    return [], []


# ------------------------------------------------------------
# MENU LOOP
# ------------------------------------------------------------

def print_menu(in_memory_events, in_memory_body):
    log_exists = os.path.exists(LOG_PATH)
    print()
    print("─────────────────────────────────────────────────")
    print(f"  Лог: {'есть ' + str(len(in_memory_events)) + ' событий / ' + str(len(in_memory_body)) + ' body_frames' if in_memory_events else ('есть на диске' if log_exists else 'пусто')}")
    print("─────────────────────────────────────────────────")
    print("  Enter / rehearse   — запись + воспроизведение")
    print("  record             — только запись")
    print("  play               — только воспроизведение")
    print("  clear              — удалить лог")
    print("  exit / q           — выход")
    print("─────────────────────────────────────────────────")


def main_loop(script):
    events, body_frames = load_log()
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
                events, body_frames = do_rehearse(script) or (events, body_frames)
            elif cmd in ("record", "rec"):
                res = do_record(script)
                if res:
                    events, body_frames = res
            elif cmd in ("play", "p"):
                if not events:
                    events, body_frames = load_log()
                do_play(script, events, body_frames)
            elif cmd in ("clear", "c"):
                events, body_frames = do_clear()
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
    print("[main] start")
    print("[main] attaching to King of Thieves...")
    try:
        _session, _script = attach()
    except Exception as e:
        print(f"[main] не удалось подключиться: {e}")
        print("[main] Убедитесь, что игра запущена и frida-server активен.")
        sys.exit(1)
    print("[main] готово. Интерактивный режим.")
    main_loop(_script)
