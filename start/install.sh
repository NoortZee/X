#!/usr/bin/env bash
# CachyOS/Arch, Ubuntu/Debian or NixOS + existing, initialized Waydroid.
# Run as the desktop user, not root.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/kot-tas"
export PATH="$HOME/.cargo/bin:$PATH"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "Installation failed at line %s. TAS was not started.\n" "$LINENO" >&2' ERR
if [[ "${1:-}" == --help ]]; then
    echo 'Usage: start/install.sh'
    echo 'Creates config.yaml, then installs only the missing or damaged dependencies:'
    echo 'system packages, Rust, Android SDK, modified Phantom server and modified Frida.'
    echo 'Requires CachyOS/Arch, Ubuntu/Debian or NixOS, sudo, initialized Waydroid, internet and ~5 GB disk space.'
    printf 'Artifacts: %s; existing config.yaml is preserved.\n' "$DATA"
    exit 0
fi
[[ $# == 0 ]] || fail 'Unknown arguments; use --help.'
[[ $EUID != 0 ]] || fail 'Run without sudo: the script requests sudo only when needed.'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'TAS currently supports Linux / Android x86_64 only.'

# ---------------------------------------------------------------------------
# Integrity helpers: every artifact gets a .sha256 sidecar next to it at install
# time, so a later run can prove the file is still the one that was installed.
# ---------------------------------------------------------------------------
digest_of() { sha256sum -- "$1" | cut -d' ' -f1; }
record_digest() { digest_of "$1" > "$1.sha256"; chmod 644 -- "$1.sha256"; }
# 1 = missing, 0 = present and intact, 2 = present but damaged.
# An artifact installed before checksums were recorded is adopted once its own
# content check passes; from then on the sidecar detects any later damage.
artifact_state() {
    local file=$1
    [[ -e $file ]] || return 1
    [[ -f $file && -s $file ]] || return 2
    if [[ -f $file.sha256 ]]; then
        [[ $(digest_of "$file") == "$(tr -d '\r\n' < "$file.sha256")" ]] && return 0 || return 2
    fi
    record_digest "$file"
    return 0
}
skip_existing() { printf '%s: exists and is intact — skipping (%s)\n' "$1" "$2"; }
reinstall_damaged() { printf 'WARN: %s is damaged — reinstalling (%s)\n' "$1" "$2" >&2; }
# ELF64 little-endian x86_64, matching what the launcher pushes to Android.
is_elf_x86_64() { python3 -c 'import struct, sys
d = open(sys.argv[1], "rb").read(20)
sys.exit(0 if len(d) == 20 and d[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", d, 18)[0] == 62 else 1)' "$1"; }

# ---------------------------------------------------------------------------
# 1. Config first: nothing is installed until config.yaml is in place.
# ---------------------------------------------------------------------------
config_intact() {
    local file=$1 example="$ROOT/config.example.yaml" key
    [[ -f $file && -s $file ]] || return 1
    # Every top-level section of the example must be present: a truncated or
    # partially written config.yaml fails here instead of at first TAS start.
    while read -r key; do
        grep -q "^${key}:" "$file" || return 1
    done < <(grep -oE '^[a-z_]+' <(grep -E '^[a-z_]+:' "$example"))
    # Full YAML validation when PyYAML is already available (installed later on a fresh system).
    if python3 -c 'import yaml' 2>/dev/null; then
        python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$file" 2>/dev/null || return 1
    fi
    return 0
}
check_config() {
    local target="$ROOT/config.yaml" example="$ROOT/config.example.yaml"
    [[ -f $example ]] || fail "Missing $example; cannot create config.yaml."
    if [[ -e $target ]]; then
        if config_intact "$target"; then
            skip_existing config.yaml "$target"
            return
        fi
        local backup="$target.broken.$(date +%Y%m%d-%H%M%S)"
        mv -- "$target" "$backup"
        printf 'WARN: config.yaml was damaged — moved to %s and recreated from config.example.yaml.\n' "$backup" >&2
    fi
    install -m 600 -- "$example" "$target"
    config_intact "$target" || fail "Created $target but it fails the integrity check."
    echo 'Created config.yaml from config.example.yaml. Check coordinates and configure or disable Telegram before use.'
}
check_config

# NixOS is detected first: it can legitimately have pacman or apt-get installed
# through nix, and neither of them can write to a read-only /nix store system.
if [[ -e /etc/NIXOS ]] || command -v nixos-rebuild >/dev/null; then
    PACKAGE_MANAGER=nix
elif command -v pacman >/dev/null; then
    PACKAGE_MANAGER=pacman
elif command -v apt-get >/dev/null; then
    PACKAGE_MANAGER=apt-get
else
    fail 'Supported distributions: CachyOS/Arch (pacman), Ubuntu/Debian (apt-get), NixOS (nix/nixos-rebuild).'
fi
command -v sudo >/dev/null || fail 'Install sudo first.'
command -v waydroid >/dev/null || fail 'Install and initialize Waydroid first (distribution-specific setup).'
sudo -v

# NixOS has no mutable /usr: dependencies go into the user profile, and
# `nix profile install` refuses a package that is already there, so probe each
# tool first. Arguments are <binary to probe>:<nixpkgs attribute>.
nix_install() {
    local spec tool attr missing=()
    for spec in "$@"; do
        tool=${spec%%:*}
        attr=${spec##*:}
        command -v "$tool" >/dev/null || missing+=("nixpkgs#$attr")
    done
    if (( ${#missing[@]} == 0 )); then
        skip_existing 'Nix dependencies' 'all tools already on PATH'
        return
    fi
    # --extra-experimental-features works whether or not the user enabled the new
    # CLI in nix.conf, so a stock NixOS install needs no configuration change.
    echo "Installing into the user Nix profile: ${missing[*]}"
    nix --extra-experimental-features 'nix-command flakes' profile install "${missing[@]}"
}

# NixOS keeps the JDK in /nix/store, not /usr/lib/jvm: derive JAVA_HOME from the
# javac that is actually on PATH so SDK tools and d8 find their runtime.
java_home_from_javac() {
    local javac
    javac="$(command -v javac)" || return 1
    javac="$(readlink -f -- "$javac")" || return 1
    [[ $javac == */bin/javac ]] || return 1
    printf '%s\n' "${javac%/bin/javac}"
}

case "$PACKAGE_MANAGER" in
    pacman)
        echo 'Installing TAS dependencies only (no system upgrade or database refresh).'
        # Use existing sync databases. System upgrades and mirror maintenance belong to the user.
        sudo pacman -S --needed --noconfirm android-tools base-devel pkgconf clang llvm openssl \
            git curl ca-certificates unzip xz python python-pip python-yaml \
            jdk17-openjdk util-linux
        export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
        ;;
    apt-get)
        sudo apt-get update
        sudo apt-get install -y adb build-essential pkg-config libclang-dev clang libssl-dev \
            git curl ca-certificates unzip xz-utils python3 python3-venv python3-yaml \
            openjdk-17-jdk-headless util-linux
        export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
        ;;
    nix)
        echo 'Installing TAS dependencies only, into the user Nix profile; the system configuration is not touched.'
        nix_install \
            adb:android-tools make:gnumake cc:gcc pkg-config:pkg-config clang:clang \
            llvm-config:llvm git:git curl:curl unzip:unzip xz:xz python3:python3 \
            javac:jdk17 flock:util-linux find:findutils \
            cargo:cargo rustc:rustc
        # No hardcoded /usr/lib/jvm path exists here; resolve what nix linked in.
        JAVA_HOME="$(java_home_from_javac)" \
            || fail 'JDK 17 was installed but javac is not on PATH; re-open the shell or check your Nix profile.'
        export JAVA_HOME
        ;;
esac
# Use the installed JDK for SDK tools and javac without changing the system Java default.
export PATH="$JAVA_HOME/bin:$PATH"
[[ -x "$JAVA_HOME/bin/java" && -x "$JAVA_HOME/bin/javac" ]] || fail "JDK 17 is missing in $JAVA_HOME."
mkdir -p "$DATA/bin" "$DATA/src" "$DATA/downloads"
# Serializes installation against another installer or running TAS session.
exec 9>"$DATA/session.lock"
flock -n 9 || fail 'Another installer or TAS session is active.'

if command -v cargo >/dev/null; then
    skip_existing 'Rust toolchain' "$(cargo --version) at $(command -v cargo)"
elif [[ $PACKAGE_MANAGER == nix ]]; then
    # A rustup toolchain cannot link on NixOS: there is no FHS /usr/lib and no
    # ld at a fixed path. nixpkgs cargo/rustc were installed above, so a missing
    # cargo here means the profile install did not take effect.
    fail 'Rust toolchain missing: nixpkgs#cargo did not land on PATH (re-open the shell, or check `nix profile list`).'
else
    curl --fail --location --proto '=https' --tlsv1.2 https://sh.rustup.rs -o "$DATA/downloads/rustup.sh"
    sh "$DATA/downloads/rustup.sh" -y --profile minimal --default-toolchain stable
fi
cargo --version
rustc --version

# Obtain Android command-line tools from Google's SDK manifest and check its published checksum.
# This SDK is private to TAS; an existing Android SDK is not modified.
export ANDROID_SDK_ROOT="$DATA/android-sdk"
SDKMANAGER="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
if [[ -x $SDKMANAGER && -s $SDKMANAGER ]]; then
    skip_existing cmdline-tools "$SDKMANAGER"
else
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
    [[ -x $SDKMANAGER ]] || fail "sdkmanager was not installed in $SDKMANAGER."
fi
# SDK platforms are installed once; sdkmanager itself reports the existing ones as up to date.
ANDROID_JAR="$ANDROID_SDK_ROOT/platforms/android-35/android.jar"
D8_BIN="$ANDROID_SDK_ROOT/build-tools/35.0.0/d8"
if [[ -s $ANDROID_JAR && -x $D8_BIN ]]; then
    skip_existing "'platforms;android-35' + 'build-tools;35.0.0'" "$ANDROID_SDK_ROOT"
else
    echo 'Android SDK licenses: review and accept the prompts below.'
    "$SDKMANAGER" --sdk_root="$ANDROID_SDK_ROOT" --licenses
    "$SDKMANAGER" --sdk_root="$ANDROID_SDK_ROOT" 'platforms;android-35' 'build-tools;35.0.0'
fi

# Google ships `d8` in build-tools as a shell script with a `#!/bin/bash` shebang,
# and NixOS has no /bin/bash: the kernel fails with "bad interpreter" before Java
# is even reached. Phantom's build script executes $D8 directly, so when the
# interpreter named in the shebang is missing, hand it an executable shim that
# re-runs the very same script through the bash this installer is running.
# The SDK itself is never modified.
resolve_d8() {
    local d8=$1 shim=$2 shebang interpreter
    if ! "$d8" --version >/dev/null 2>&1; then
        shebang=$(head -n 1 -- "$d8" 2>/dev/null) || shebang=''
        interpreter=''
        if [[ $shebang == '#!'* ]]; then
            interpreter=${shebang#\#!}
            interpreter=${interpreter%% *}
        fi
        if [[ $interpreter == */bash && ! -x $interpreter ]]; then
            mkdir -p -- "$(dirname -- "$shim")"
            {
                printf '#!/usr/bin/env bash\n'
                printf '# Generated by TAS: %s does not exist on this system.\n' "$interpreter"
                printf 'exec bash %q "$@"\n' "$d8"
            } > "$shim"
            chmod 755 -- "$shim"
            "$shim" --version >/dev/null 2>&1 || {
                printf 'ERROR: %s needs %s, which is missing, and the shim %s does not work.\n' \
                    "$d8" "$interpreter" "$shim" >&2
                return 1
            }
            printf 'd8: %s is missing; using the %s shim for %s\n' "$interpreter" "$shim" "$d8" >&2
            printf '%s\n' "$shim"
            return 0
        fi
    fi
    printf '%s\n' "$d8"
}
D8_BIN="$(resolve_d8 "$D8_BIN" "$DATA/bin/d8")" || fail "d8 in $ANDROID_SDK_ROOT/build-tools/35.0.0 cannot be executed."

# Validate the configured repository, not the transport URL expanded by Git insteadOf.
validate_phantom_source() {
    local remote
    remote="$(git -C "$SOURCE" config --local --get-all remote.origin.url)" || fail "Missing Phantom origin in $SOURCE."
    remote="${remote,,}"
    remote="${remote%/}"
    remote="${remote%.git}"
    case "$remote" in
        https://github.com/noortzee/phantom_keymaper|git@github.com:noortzee/phantom_keymaper|ssh://git@github.com/noortzee/phantom_keymaper|ssh://git@github.com:22/noortzee/phantom_keymaper)
            ;;
        *)
            # Do not print raw URLs: they can contain embedded credentials.
            fail "Unexpected Phantom source remote in $SOURCE. Expected NoortZee/phantom_keymaper on github.com; check git config --local --get-all remote.origin.url in that directory. Existing files were not changed."
            ;;
    esac
}

# Build the Android server component required by TAS, not the unrelated desktop mapper/GUI.
KEYMAPPER_COMMIT=bc4f338488f03f229e9a9812e4b48baee56a45d8
SOURCE="$DATA/src/phantom_keymaper"
JAR="$DATA/bin/phantom-server.jar"
JAR_OK=0
JAR_STATE=0
artifact_state "$JAR" || JAR_STATE=$?
if (( JAR_STATE == 0 )); then
    if unzip -p "$JAR" classes.dex >/dev/null 2>&1; then
        skip_existing phantom-server.jar "$JAR"
        JAR_OK=1
    else
        reinstall_damaged phantom-server.jar "no readable classes.dex"
    fi
elif (( JAR_STATE == 2 )); then
    reinstall_damaged phantom-server.jar "checksum mismatch"
fi
if (( ! JAR_OK )); then
    if [[ ! -d "$SOURCE/.git" ]]; then
        git clone https://github.com/NoortZee/phantom_keymaper.git "$SOURCE"
    else
        skip_existing 'Phantom source checkout' "$SOURCE"
    fi
    validate_phantom_source
    [[ -z $(git -C "$SOURCE" status --porcelain) ]] || fail "Local edits in $SOURCE; refusing to overwrite."
    if [[ $(git -C "$SOURCE" rev-parse HEAD) != "$KEYMAPPER_COMMIT" ]]; then
        git -C "$SOURCE" fetch origin "$KEYMAPPER_COMMIT"
        git -C "$SOURCE" checkout --detach "$KEYMAPPER_COMMIT"
    fi
    ANDROID_JAR="$ANDROID_JAR" D8="$D8_BIN" bash "$SOURCE/contrib/android-server/build.sh"
    unzip -p "$SOURCE/contrib/android-server/build/phantom-server.jar" classes.dex >/dev/null
    install -m 644 "$SOURCE/contrib/android-server/build/phantom-server.jar" "$JAR"
    record_digest "$JAR"
fi

# Pin the modified x86 release, not upstream frida-server. Verify the GitHub asset digest.
SYSMON="$DATA/bin/sysmon"
FRIDA_VERSION="$(tr -d '\r\n' < "$ROOT/third_party/frida-rust/frida-sys/FRIDA_VERSION")"
SYSMON_OK=0
SYSMON_STATE=0
artifact_state "$SYSMON" || SYSMON_STATE=$?
if (( SYSMON_STATE == 0 )); then
    if is_elf_x86_64 "$SYSMON"; then
        skip_existing sysmon "$SYSMON"
        SYSMON_OK=1
    else
        reinstall_damaged sysmon "not an x86_64 ELF"
    fi
elif (( SYSMON_STATE == 2 )); then
    reinstall_damaged sysmon "checksum mismatch"
fi
if (( ! SYSMON_OK )); then
    FRIDA_ZIP="$DATA/downloads/phantom-frida-build.zip"
    FRIDA_SHA256=3ab4aa44d62e86a3be490c24a76ac4c6d1109e411ad6db714a06937ac48f27bc
    if [[ -f $FRIDA_ZIP && $(digest_of "$FRIDA_ZIP") == "$FRIDA_SHA256" ]]; then
        skip_existing 'phantom-frida-build.zip' "$FRIDA_ZIP"
    else
        curl -fL --retry 3 https://github.com/NoortZee/phantom-frida/releases/download/x86/phantom-frida-build.zip -o "$FRIDA_ZIP"
        echo "$FRIDA_SHA256  $FRIDA_ZIP" | sha256sum --check -
    fi
    python3 - "$FRIDA_ZIP" "$SYSMON" "$FRIDA_VERSION" <<'PY'
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
    record_digest "$SYSMON"
fi

# The venv is verified by importing the exact pinned Frida version, not by its existence.
VENV_PY="$DATA/venv/bin/python"
# PyYAML goes into the venv on every distribution: start.sh parses config.yaml
# with it, and a NixOS system python3 has no site-packages to provide it.
if [[ -x $VENV_PY ]] && "$VENV_PY" -c "import sys, yaml, frida; sys.exit(0 if frida.__version__ == '$FRIDA_VERSION' else 1)" 2>/dev/null; then
    skip_existing "frida==$FRIDA_VERSION + PyYAML (venv)" "$DATA/venv"
else
    [[ -x $VENV_PY ]] || python3 -m venv "$DATA/venv"
    "$VENV_PY" -m pip install --disable-pip-version-check "frida==$FRIDA_VERSION" pyyaml
fi

# Rebuild only when the binary is missing or older than the tracked Rust sources.
needs_cargo_build() {
    local bin="$ROOT/target/release/kot-tas" path watched=()
    [[ -x $bin ]] || return 0
    for path in TAS catacombs stones memory third_party Cargo.toml Cargo.lock; do
        [[ -e "$ROOT/$path" ]] && watched+=("$ROOT/$path")
    done
    (( ${#watched[@]} )) || return 0
    # Compare files only: a directory's mtime changes when any entry is created,
    # which would force a rebuild after a plain `git checkout` of nothing relevant.
    [[ -n $(find "${watched[@]}" -type f -newer "$bin" -print -quit 2>/dev/null) ]] && return 0
    return 1
}
cd "$ROOT"
if needs_cargo_build; then
    if [[ $PACKAGE_MANAGER == nix ]]; then
        # NixOS keeps pkg-config files and C headers in `dev` outputs that a user
        # profile does not expose, so build inside a shell that has them instead
        # of relying on the linked binaries alone.
        #   gcc      — Rust links through `cc`, which the clang package does not provide
        #   libclang — frida-sys runs bindgen 0.72, whose setup hook exports LIBCLANG_PATH
        nix-shell -p cargo rustc gcc clang libclang pkg-config openssl gnumake \
            --run "cd $(printf '%q' "$ROOT") && cargo build --release"
    else
        cargo build --release
    fi
else
    skip_existing 'kot-tas (release build is current)' "$ROOT/target/release/kot-tas"
fi
printf '\nInstalled. Open Waydroid and the game, then run:\n  %s/start/start.sh\n' "$ROOT"
