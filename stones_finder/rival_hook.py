#!/usr/bin/env python3
r'''rival_hook.py — читать соперника из Response_RivalDungeon.

v4:
  * fix: объект Response_RivalDungeon временный (Clear/free сразу после
    парсера). Снимок делается в onLeave в JS, а getLastRival возвращает
    уже снимок. Раньше поля были 0 из-за чтения после Clear.
  * --log: показать всех соперников, пойманных в этой сессии (до 50).
  * --reset-log: очистить журнал перед запуском.
  * stones печатаются как rating/slot/cnt/flag, сортировка по slot.
  * --verbose: + raw_hex и addr каждого Item.

Порядок:
  1) python rival_hook.py --watch
  2) Find a Match → выбрать соперника.
  3) В консоли gold / player_level / total_rating / список камней.
  4) --log (или L во время --watch? нет, только CLI) — вся история.

Если sysmon упал:
  sudo waydroid shell -- pkill -9 -f sysmon; sleep 1
  sudo waydroid shell -- setsid nohup /data/local/tmp/sysmon \
      -l unix:/data/local/tmp/sysmon.sock \
      >/data/local/tmp/sysmon.log 2>&1 < /dev/null &
  sleep 2
  adb forward tcp:41337 localabstract:/data/local/tmp/sysmon.sock
'''
import argparse
import json
import sys
import time
from pathlib import Path

import frida
import yaml

PROJECT = Path(__file__).resolve().parent
CFG_PATH = PROJECT / "config.yaml"
AGENT_PATH = PROJECT / "rival_hook.js"


def load_cfg():
    with open(CFG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


def attach(cfg):
    dev_addr = cfg["frida"]["device"]
    try:
        dev = frida.get_device_manager().add_remote_device(dev_addr)
    except Exception as e:
        raise SystemExit(
            f"cannot create remote device {dev_addr}: {e}\n"
            f"  Проверьте: adb forward tcp:41337 "
            f"localabstract:/data/local/tmp/sysmon.sock"
        )

    last_err = None
    for target in (cfg["frida"]["package"], "King of Thieves"):
        try:
            return dev.attach(target)
        except frida.ProcessNotFoundError as e:
            last_err = e
        except frida.ServerNotRunningError as e:
            raise SystemExit(
                f"frida-server (sysmon) is not running on {dev_addr}.\n"
                f"  Восстановить:\n"
                f"    sudo waydroid shell -- pkill -9 -f sysmon; sleep 1\n"
                f"    sudo waydroid shell -- setsid nohup "
                f"/data/local/tmp/sysmon -l unix:/data/local/tmp/sysmon.sock "
                f">/data/local/tmp/sysmon.log 2>&1 < /dev/null &\n"
                f"    sleep 2\n"
                f"    adb forward tcp:41337 "
                f"localabstract:/data/local/tmp/sysmon.sock\n"
                f"  Ошибка: {e}"
            )
        except frida.TransportError as e:
            raise SystemExit(
                f"transport error while attaching to {target}: {e}\n"
                f"  Проверьте adb forward и что sysmon жив:\n"
                f"    adb forward --list\n"
                f"    ./venv-phantom/bin/frida-ps -H {dev_addr} | grep thieves"
            )

    for p in dev.enumerate_processes():
        if "thieves" in p.name.lower():
            return dev.attach(p.pid)
    raise SystemExit(
        f"game not found: {last_err or 'no thieves process'}\n"
        f"  frida-ps -H {dev_addr} | grep thieves"
    )


def on_msg(msg, _):
    if msg["type"] == "send":
        p = msg["payload"] or {}
        t = p.get("type")
        if t == "rival_update":
            print(f"\n[rival #{p.get('seq')}] "
                  f"gold={p.get('gold')}  "
                  f"player_level={p.get('player_level')}  "
                  f"n_items={p.get('n_items')}  "
                  f"total_rating={p.get('total_rating')}",
                  file=sys.stderr)
        elif t == "hooked":
            print(f"[agent] hooked {p.get('at')}", file=sys.stderr)
        elif t == "ready":
            print(f"[agent] module base = {p.get('base')}", file=sys.stderr)
        elif t in ("fatal", "err"):
            print(f"[agent:{t}] {json.dumps(p, ensure_ascii=False)}",
                  file=sys.stderr)
    elif msg["type"] == "error":
        print(f"[frida:error] {msg}", file=sys.stderr)
        if msg.get("stack"):
            print(msg["stack"], file=sys.stderr)


def print_rival(r, verbose=False):
    if not r.get("ok"):
        print(f"[no rival yet] seq={r.get('seq')} reason={r.get('reason')}")
        return
    print(f"\n=== Response_RivalDungeon seq={r.get('seq')} ===")
    print(f"  gold          = {r.get('gold')}")
    print(f"  player_level  = {r.get('player_level')}")
    print(f"  n_items       = {r.get('n_items')}")
    print(f"  total_rating  = {r.get('total_rating')}")
    stones = r.get("stones") or []
    if stones:
        print(f"\n  stones:")
        print(f"    {'slot':>4}  {'rating':>8}  {'cnt':>4}  {'flag':>4}")
        for s in stones:
            if s.get("err"):
                print(f"    [{s.get('i')}] ERR: {s['err']}")
                continue
            print(f"    {s.get('slot', '?'):>4}  "
                  f"{s.get('rating', '?'):>8}  "
                  f"{s.get('cnt', '?'):>4}  "
                  f"{s.get('flag', '?'):>4}")
            if verbose and s.get("raw_hex"):
                print(f"      addr={s.get('addr')}  raw={s['raw_hex']}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--watch", action="store_true",
                    help="печатать каждое обновление (default: один rival)")
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--json", action="store_true",
                    help="сырой JSON")
    ap.add_argument("--verbose", action="store_true",
                    help="плюс raw_hex и addr каждого Item")
    ap.add_argument("--log", action="store_true",
                    help="показать историю всех соперников и выйти")
    ap.add_argument("--reset-log", action="store_true",
                    help="очистить журнал перед запуском")
    args = ap.parse_args()

    cfg = load_cfg()
    session = attach(cfg)
    print(f"[rival_hook] attached to {cfg['frida']['package']}",
          file=sys.stderr)

    script = session.create_script(AGENT_PATH.read_text(encoding="utf-8"))
    script.on("message", on_msg)
    script.load()

    base = script.exports_sync.module_base()
    if not base:
        print("agent init failed (см. stderr)", file=sys.stderr)
        session.detach(); sys.exit(2)
    print(f"[rival_hook] module base = {base}", file=sys.stderr)

    if args.reset_log:
        script.exports_sync.reset_log()
        print("[rival_hook] log reset", file=sys.stderr)

    script.exports_sync.install_hooks()
    print("\nХуки установлены. Откройте Find a Match и выберите соперника.",
          file=sys.stderr)

    try:
        if args.log:
            # просто печатаем всё, что уже в журнале
            log = script.exports_sync.get_rivals_log()
            rivals = log.get("rivals") or []
            if args.json:
                print(json.dumps(log, indent=2, ensure_ascii=False))
            else:
                if not rivals:
                    print("[log] пусто")
                for r in rivals:
                    print_rival(r, verbose=args.verbose)
            return

        last_seq = -1
        while True:
            r = script.exports_sync.get_last_rival()
            if r.get("ok") and r.get("seq") != last_seq:
                last_seq = r.get("seq")
                if args.json:
                    print(json.dumps(r, indent=2, ensure_ascii=False))
                else:
                    print_rival(r, verbose=args.verbose)
            if not args.watch and r.get("ok"):
                return
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[stopped]", file=sys.stderr)
    finally:
        try: script.exports_sync.unhook_all()
        except Exception: pass
        session.detach()


if __name__ == "__main__":
    main()
