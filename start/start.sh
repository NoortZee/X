#!/usr/bin/env bash
# Run as desktop user. The EXIT trap owns all resources created by this session.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/kot-tas"
DEVICE="${TAS_ADB_DEVICE:-192.168.240.112:5555}"
export PATH="$HOME/.cargo/bin:$PATH"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
if [[ "${1:-}" == --help ]]; then
    echo 'Usage: start/start.sh [config.yaml]'
    echo 'TAS_ADB_DEVICE defaults to 192.168.240.112:5555.'
    echo 'Requires Konsole, start/install.sh, running Waydroid session and an open game.'
    echo 'Opens separate Frida and Phantom windows; TAS stays in this terminal.'
    echo 'WARNING: restarts the global ADB server and existing sysmon/Phantom servers in Waydroid.'
    echo 'On exit stops owned Android servers, removes owned forwards and stops ADB.'
    exit 0
fi
[[ $# -le 1 ]] || fail 'Too many arguments; use --help.'
[[ $EUID != 0 ]] || fail 'Run without sudo.'
[[ "$DEVICE" =~ ^[0-9.]+:[0-9]+$ ]] || fail 'TAS_ADB_DEVICE must be an IPv4 address:port.'
for cmd in adb sudo waydroid python3 timeout flock realpath konsole setsid tee; do
    command -v "$cmd" >/dev/null || fail "Missing $cmd; run start/install.sh."
done
CONFIG="$(realpath -e -- "${1:-$ROOT/config.yaml}")"
[[ -s "$DATA/bin/sysmon" && -s "$DATA/bin/phantom-server.jar" && -x "$DATA/venv/bin/python" ]] || fail 'Server files or Frida client missing; run start/install.sh.'
[[ -x "$ROOT/target/release/kot-tas" ]] || fail 'TAS executable missing; run start/install.sh.'
mkdir -p "$DATA"
exec 9>"$DATA/session.lock"
flock -n 9 || fail 'Another installer or TAS session is active.'
mkdir -p "$DATA/sessions"
RUN="$(mktemp -d "$DATA/sessions/session.XXXXXXXX")"
REMOTE="/data/local/tmp/kot-tas-$UID-$$"
TAS_PID=''
WATCH_PID=''
TERMINAL_PIDS=()
ADB_OWNED=0
REMOTE_OWNED=0
FORWARDS=()
adb_device() { timeout --kill-after=2 20 adb -s "$DEVICE" "$@"; }
android_root() { timeout --kill-after=2 20 sudo -n waydroid shell -- "$@"; }
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
    local code=$?
    trap - EXIT
    trap '' INT TERM HUP
    set +e
    [[ -z "$WATCH_PID" ]] || { kill "$WATCH_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null; }
    if [[ -n "$TAS_PID" ]] && kill -0 "$TAS_PID" 2>/dev/null; then
        kill -TERM "$TAS_PID" 2>/dev/null
        for _ in {1..30}; do kill -0 "$TAS_PID" 2>/dev/null || break; sleep 0.1; done
        kill -KILL "$TAS_PID" 2>/dev/null
        wait "$TAS_PID" 2>/dev/null
    fi
    if (( REMOTE_OWNED )); then
        # Waydroid transport still works if ADB itself failed. Check identity before killing a PID.
        if ! android_root sh -c "
            for name in sysmon phantom; do
                file=$REMOTE/\$name.pid
                [ -f \"\$file\" ] || continue
                read pid < \"\$file\"
                case \$pid in ''|*[!0-9]*) continue;; esac
                case \$name in
                    sysmon) pattern='/data/local/tmp/sysmon';;
                    phantom) pattern='com.phantom.server.PhantomServer';;
                esac
                if [ -r /proc/\$pid/cmdline ] && tr '\\000' ' ' < /proc/\$pid/cmdline 2>/dev/null | grep -Fq \"\$pattern\"; then
                    kill \$pid 2>/dev/null || :
                    sleep 1
                    if [ -r /proc/\$pid/cmdline ] && tr '\\000' ' ' < /proc/\$pid/cmdline 2>/dev/null | grep -Fq \"\$pattern\"; then
                        kill -9 \$pid 2>/dev/null || exit 1
                    fi
                fi
            done
            rm -rf $REMOTE
        "; then
            echo "WARNING: cannot clean Android processes. Check $REMOTE in Waydroid." >&2
            (( code != 0 )) || code=1
        fi
    fi
    # Each Konsole owns a private process group (including its foreground bridge and tee).
    for pid in "${TERMINAL_PIDS[@]}"; do
        kill -TERM -- "-$pid" 2>/dev/null
    done
    for pid in "${TERMINAL_PIDS[@]}"; do
        for _ in {1..20}; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.1; done
        kill -KILL -- "-$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
    done
    for port in "${FORWARDS[@]}"; do
        adb_device forward --remove "tcp:$port" || echo "WARNING: failed removing forward $port" >&2
    done
    (( ADB_OWNED == 0 )) || timeout --kill-after=2 10 adb kill-server
    echo "TAS session stopped; diagnostics preserved in $RUN"
    exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Parse YAML as data, never source/eval it. Runtime endpoints follow the selected config.
python3 - "$CONFIG" >"$RUN/settings" <<'PY'
import re, sys, yaml
with open(sys.argv[1]) as f: config = yaml.safe_load(f)
phantom, frida = config['phantom'], config['frida']
if phantom['host'] not in ('127.0.0.1', 'localhost'):
    raise SystemExit('phantom.host must be localhost for managed ADB forwards')
m = re.fullmatch(r'(?:127\.0\.0\.1|localhost):([0-9]+)', frida['device'])
if not m: raise SystemExit('frida.device must be localhost:port')
ports = [phantom['port'], int(m[1])]
if any(isinstance(p, bool) or not isinstance(p, int) or not 1 <= p <= 65535 for p in ports) or ports[0] == ports[1]:
    raise SystemExit('Invalid or duplicate local ports')
package = frida['package']
if not isinstance(package, str) or not re.fullmatch(r'[A-Za-z0-9_.]+', package):
    raise SystemExit('Invalid Android package')
print(*ports, package, sep='\n')
PY
mapfile -t SETTINGS < "$RUN/settings"
PHANTOM_PORT="${SETTINGS[0]}"
FRIDA_PORT="${SETTINGS[1]}"
PACKAGE="${SETTINGS[2]}"
# Logs stay outside logging.log_dir: TAS prunes that directory on startup.
echo "Session diagnostics: $RUN (preserved on exit)"
sudo -v
android_root true || fail 'Waydroid container unavailable. Start Waydroid and open the game.'
timeout --kill-after=2 10 adb kill-server
ADB_OWNED=1
timeout --kill-after=2 20 adb start-server
timeout --kill-after=2 20 adb connect "$DEVICE"
adb_device wait-for-device
[[ $(adb_device get-state | tr -d '\r') == device ]] || fail 'ADB device not ready/authorized.'
adb devices
[[ $(adb_device shell getprop ro.product.cpu.abi | tr -d '\r') == x86_64 ]] || fail 'TAS hooks require Android x86_64.'
[[ $(adb_device shell "su -c id" | tr -d '\r') == *uid=0* ]] || fail 'ADB su root access is required.'
adb_device shell "pidof $PACKAGE" >/dev/null || fail "Open the game ($PACKAGE) in Waydroid first."

# Explicitly restart the old servers, as in the manual launch procedure.
android_root sh -c 'pkill -9 -f "/data/local/tmp/[s]ysmon( |$)" || [ "$?" = 1 ]'
android_root sh -c 'pkill -9 -f "com.phantom.server.[P]hantomServer" || [ "$?" = 1 ]'
sleep 1
# Deploy only after the device/root/ABI checks have passed.
adb_device push "$DATA/bin/sysmon" /data/local/tmp/sysmon
adb_device push "$DATA/bin/phantom-server.jar" /data/local/tmp/phantom-server.jar
adb_device shell 'chmod 755 /data/local/tmp/sysmon'
EXPECTED="$(tr -d '\r\n' < "$ROOT/third_party/frida-rust/frida-sys/FRIDA_VERSION")"
ACTUAL="$(adb_device shell '/data/local/tmp/sysmon --version' | tr -d '\r')"
[[ "$ACTUAL" == "$EXPECTED" ]] || fail "Frida version mismatch: server=$ACTUAL client=$EXPECTED"
adb_device shell "mkdir $REMOTE"
REMOTE_OWNED=1
# Keep the Waydroid shell connected to each foreground server in its own Konsole.
# A new terminal may ask for sudo independently (per-TTY sudo timestamps).
start_server_console() {
    local name="$1" title="$2" command="$3" remote_command runner="$RUN/$1.sh"
    printf -v remote_command 'echo $$ > %s/%s.pid; exec %s' "$REMOTE" "$name" "$command"
    {
        printf '#!/usr/bin/env bash\nset -uo pipefail\n'
        printf '%q ' sudo waydroid shell -- sh -c "$remote_command"
        printf '2>&1 | tee %q\n' "$RUN/$name.log"
        # shellcheck disable=SC2016 # Expanded by the generated server runner, not here.
        printf 'status=${PIPESTATUS[0]}\nprintf "%%s\\n" "$status" > %q\nexit "$status"\n' "$RUN/$name.exit"
    } > "$runner"
    chmod 700 "$runner"
    setsid konsole --separate --nofork -p "tabtitle=$title" -e bash "$runner" &
    TERMINAL_PIDS+=("$!")
}
start_server_console sysmon 'TAS — Frida server' '/data/local/tmp/sysmon -l unix:/data/local/tmp/sysmon.sock'
start_server_console phantom 'TAS — Phantom server' 'env CLASSPATH=/data/local/tmp/phantom-server.jar /system/bin/app_process /system/bin com.phantom.server.PhantomServer --host 0.0.0.0 --port 27183'

# --no-rebind never steals a forward established by someone else.
adb_device forward --no-rebind "tcp:$FRIDA_PORT" localabstract:/data/local/tmp/sysmon.sock
FORWARDS+=("$FRIDA_PORT")
adb_device forward --no-rebind "tcp:$PHANTOM_PORT" tcp:27183
FORWARDS+=("$PHANTOM_PORT")
adb forward --list

# Require real protocol replies, not merely accepting TCP connections behind adb forward.
check_servers() {
    timeout --kill-after=2 5 "$DATA/venv/bin/python" - "$FRIDA_PORT" "$PHANTOM_PORT" "$PACKAGE" "${1:-startup}" >"$RUN/health.log" 2>&1 <<'PY'
import frida, socket, sys
# Closing an extra Phantom client invokes cancelAll: never probe during live TAS input.
if sys.argv[4] == 'startup':
    with socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=1) as s:
        s.sendall(b'\x7f')
        if s.recv(1) != b'\x7f': raise RuntimeError('Bad Phantom PING reply')
device = frida.get_device_manager().add_remote_device('127.0.0.1:' + sys.argv[1])
if not any(p.name == sys.argv[3] or 'thieves' in p.name.lower() for p in device.enumerate_processes()):
    raise RuntimeError('Game not visible through Frida')
PY
}
ready=0
for _ in {1..60}; do
    for name in sysmon phantom; do
        if [[ -f "$RUN/$name.exit" ]]; then
            cat "$RUN/$name.log" >&2
            fail "$name exited before becoming ready (see $RUN/$name.log)."
        fi
    done
    for pid in "${TERMINAL_PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null || fail "Server console closed before readiness; see $RUN."
    done
    if check_servers; then ready=1; break; fi
    sleep 1
done
if (( ! ready )); then
    cat "$RUN/health.log" >&2
    for name in sysmon phantom; do
        [[ ! -f "$RUN/$name.log" ]] || cat "$RUN/$name.log" >&2
    done
    fail 'Servers did not become ready.'
fi

cd "$ROOT"
"$ROOT/target/release/kot-tas" "$CONFIG" <&0 &
TAS_PID=$!
PARENT_PID=$$
# Supervise both servers while TAS is running; renew sudo for reliable EXIT cleanup.
(
    trap - EXIT INT TERM HUP
    while sleep 5; do
        for name in sysmon phantom; do
            if [[ -f "$RUN/$name.exit" ]]; then
                echo "ERROR: $name console/server exited. Stopping TAS. Logs: $RUN" >&2
                kill -TERM "$PARENT_PID"
                exit 1
            fi
        done
        for pid in "${TERMINAL_PIDS[@]}"; do
            if ! kill -0 "$pid" 2>/dev/null; then
                echo "ERROR: server console closed. Stopping TAS. Logs: $RUN" >&2
                kill -TERM "$PARENT_PID"
                exit 1
            fi
        done
        if ! timeout --kill-after=2 5 sudo -n -v || ! check_servers monitor || ! android_root sh -c "
            read a < $REMOTE/sysmon.pid && read b < $REMOTE/phantom.pid && kill -0 \$a && kill -0 \$b
        " >"$RUN/watch.log" 2>&1; then
            echo 'ERROR: game, sudo or an Android server was lost/unresponsive. Stopping TAS.' >&2
            kill -TERM "$PARENT_PID"
            exit 1
        fi
    done
) &
WATCH_PID=$!
# wait preserves the application exit status; EXIT always tears down the session.
status=0
wait "$TAS_PID" || status=$?
TAS_PID=''
exit "$status"
