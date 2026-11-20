#!/usr/bin/env bash
# CachyOS/Arch or Ubuntu/Debian + existing, initialized Waydroid. Run as the desktop user, not root.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/kot-tas"
export PATH="$HOME/.cargo/bin:$PATH"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "Installation failed at line %s. TAS was not started.\n" "$LINENO" >&2' ERR
if [[ "${1:-}" == --help ]]; then
    echo 'Usage: start/install.sh'
    echo 'Installs build dependencies, Rust, Android SDK, modified Phantom server and modified Frida.'
    echo 'Requires CachyOS/Arch or Ubuntu/Debian, sudo, initialized Waydroid, internet and ~5 GB disk space.'
    printf 'Artifacts: %s; existing config.yaml is preserved.\n' "$DATA"
    exit 0
fi
[[ $# == 0 ]] || fail 'Unknown arguments; use --help.'
[[ $EUID != 0 ]] || fail 'Run without sudo: the script requests sudo only when needed.'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'TAS currently supports Linux / Android x86_64 only.'
if command -v pacman >/dev/null; then
    PACKAGE_MANAGER=pacman
elif command -v apt-get >/dev/null; then
    PACKAGE_MANAGER=apt-get
else
    fail 'Supported distributions: CachyOS/Arch (pacman), Ubuntu/Debian (apt-get).'
fi
command -v sudo >/dev/null || fail 'Install sudo first.'
command -v waydroid >/dev/null || fail 'Install and initialize Waydroid first (distribution-specific setup).'
sudo -v
case "$PACKAGE_MANAGER" in
    pacman)
        echo 'Installing CachyOS/Arch dependencies (full system upgrade: pacman -Syu).'
        # Never use -Sy without -u: partial upgrades are unsupported on Arch-based systems.
        sudo pacman -Syu --needed --noconfirm android-tools base-devel pkgconf clang llvm openssl \
            git curl ca-certificates unzip xz python python-pip python-yaml \
            jdk17-openjdk util-linux procps-ng shellcheck
        export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
        ;;
    apt-get)
        sudo apt-get update
        sudo apt-get install -y adb build-essential pkg-config libclang-dev clang libssl-dev \
            git curl ca-certificates unzip xz-utils python3 python3-venv python3-yaml \
            openjdk-17-jdk-headless util-linux procps shellcheck
        export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
        ;;
esac
# Use the installed JDK for SDK tools and javac without changing the system Java default.
export PATH="$JAVA_HOME/bin:$PATH"
[[ -x "$JAVA_HOME/bin/java" && -x "$JAVA_HOME/bin/javac" ]] || fail "JDK 17 is missing in $JAVA_HOME."
mkdir -p "$DATA/bin" "$DATA/src" "$DATA/downloads"
# Serializes installation against another installer or running TAS session.
exec 9>"$DATA/session.lock"
flock -n 9 || fail 'Another installer or TAS session is active.'

if ! command -v cargo >/dev/null; then
    curl --fail --location --proto '=https' --tlsv1.2 https://sh.rustup.rs -o "$DATA/downloads/rustup.sh"
    sh "$DATA/downloads/rustup.sh" -y --profile minimal --default-toolchain stable
fi
cargo --version
rustc --version

# Obtain Android command-line tools from Google's SDK manifest and check its published checksum.
# This SDK is private to TAS; an existing Android SDK is not modified.
export ANDROID_SDK_ROOT="$DATA/android-sdk"
if [[ ! -x "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]]; then
    curl -fL --retry 3 https://dl.google.com/android/repository/repository2-1.xml -o "$DATA/downloads/sdk.xml"
    python3 - "$DATA/downloads" "$ANDROID_SDK_ROOT" <<'PY'
import hashlib, pathlib, sys, urllib.request, xml.etree.ElementTree as ET, zipfile
cache, sdk = map(pathlib.Path, sys.argv[1:])
root = ET.parse(cache / 'sdk.xml').getroot()
def tag(e): return e.tag.rsplit('}', 1)[-1]
def child(e, name): return next(x for x in e if tag(x) == name)
pkg = next(e for e in root if tag(e) == 'remotePackage' and e.get('path') == 'cmdline-tools;latest')
archive = next(a for a in child(pkg, 'archives') if child(a, 'host-os').text == 'linux')
complete = child(archive, 'complete')
url = child(complete, 'url').text
if not url or '/' in url or not url.endswith('.zip'):
    raise SystemExit('Unexpected SDK download path')
checksum = child(complete, 'checksum')
algorithm = checksum.get('type', 'sha1')
if algorithm not in ('sha1', 'sha256'):
    raise SystemExit('Unsupported SDK checksum')
path = cache / 'sdk-tools.zip'
with urllib.request.urlopen('https://dl.google.com/android/repository/' + url, timeout=120) as src, path.open('wb') as out:
    while chunk := src.read(1024 * 1024): out.write(chunk)
if hashlib.new(algorithm, path.read_bytes()).hexdigest() != checksum.text.strip():
    raise SystemExit('SDK checksum mismatch')
destination = sdk / 'cmdline-tools' / 'latest'
destination.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(path) as z:
    for member in z.infolist():
        parts = pathlib.PurePosixPath(member.filename).parts
        if not parts or parts[0] != 'cmdline-tools' or '..' in parts:
            raise SystemExit('Unexpected SDK archive entry')
        target = destination.joinpath(*parts[1:])
        if member.is_dir(): target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(member))
            target.chmod(0o755 if 'bin' in parts else 0o644)
PY
fi
SDKMANAGER="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
echo 'Android SDK licenses: review and accept the prompts below.'
"$SDKMANAGER" --sdk_root="$ANDROID_SDK_ROOT" --licenses
"$SDKMANAGER" --sdk_root="$ANDROID_SDK_ROOT" 'platforms;android-35' 'build-tools;35.0.0'

# Build the Android server component required by TAS, not the unrelated desktop mapper/GUI.
KEYMAPPER_COMMIT=bc4f338488f03f229e9a9812e4b48baee56a45d8
SOURCE="$DATA/src/phantom_keymaper"
if [[ ! -d "$SOURCE/.git" ]]; then
    git clone https://github.com/NoortZee/phantom_keymaper.git "$SOURCE"
fi
[[ $(git -C "$SOURCE" remote get-url origin) == https://github.com/NoortZee/phantom_keymaper.git ]] || fail 'Unexpected Phantom source remote.'
[[ -z $(git -C "$SOURCE" status --porcelain) ]] || fail "Local edits in $SOURCE; refusing to overwrite."
git -C "$SOURCE" fetch origin "$KEYMAPPER_COMMIT"
git -C "$SOURCE" checkout --detach "$KEYMAPPER_COMMIT"
ANDROID_JAR="$ANDROID_SDK_ROOT/platforms/android-35/android.jar" \
D8="$ANDROID_SDK_ROOT/build-tools/35.0.0/d8" bash "$SOURCE/contrib/android-server/build.sh"
unzip -p "$SOURCE/contrib/android-server/build/phantom-server.jar" classes.dex >/dev/null
install -m 644 "$SOURCE/contrib/android-server/build/phantom-server.jar" "$DATA/bin/phantom-server.jar"

# Pin the modified x86 release, not upstream frida-server. Verify the GitHub asset digest.
FRIDA_ZIP="$DATA/downloads/phantom-frida-build.zip"
curl -fL --retry 3 https://github.com/NoortZee/phantom-frida/releases/download/x86/phantom-frida-build.zip -o "$FRIDA_ZIP"
echo "3ab4aa44d62e86a3be490c24a76ac4c6d1109e411ad6db714a06937ac48f27bc  $FRIDA_ZIP" | sha256sum --check -
FRIDA_VERSION="$(tr -d '\r\n' < "$ROOT/third_party/frida-rust/frida-sys/FRIDA_VERSION")"
python3 - "$FRIDA_ZIP" "$DATA/bin/sysmon" "$FRIDA_VERSION" <<'PY'
import gzip, json, pathlib, struct, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    metadata = [n for n in z.namelist() if pathlib.PurePosixPath(n).name == 'build-info.json']
    if metadata and json.loads(z.read(metadata[0])).get('frida_version') != sys.argv[3]:
        raise SystemExit('Modified Frida release does not match the TAS client version')
    candidates = []
    for n in z.namelist():
        name = pathlib.PurePosixPath(n).name
        if ('server' not in name and name != 'sysmon') or '.so' in name:
            continue
        data = z.read(n)
        if n.endswith('.gz'): data = gzip.decompress(data)
        if data[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', data, 18)[0] == 62:
            candidates.append(data)
    unique = {data for data in candidates}
    if len(unique) != 1:
        raise SystemExit('Expected exactly one x86_64 ELF server in the modified Frida release')
    path = pathlib.Path(sys.argv[2])
    path.write_bytes(unique.pop())
    path.chmod(0o755)
PY
python3 -m venv "$DATA/venv"
"$DATA/venv/bin/python" -m pip install --disable-pip-version-check "frida==$FRIDA_VERSION"

cd "$ROOT"
cargo build --release
if [[ ! -e config.yaml ]]; then
    install -m 600 config.example.yaml config.yaml
    echo 'Created config.yaml. Check coordinates and configure or disable Telegram before use.'
fi
printf '\nInstalled. Open Waydroid and the game, then run:\n  %s/start/start.sh\n' "$ROOT"
