"""Lifecycle tests with fake ADB/Waydroid/TAS; no Android or sudo execution.

Run: python3 -m unittest discover -s tests -v (requires PyYAML, as does start.sh).
"""
import ast
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''#!PYTHON
import json, os, pathlib, signal, subprocess, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as f:
    f.write(json.dumps([name, *args]) + '\n')
if name == 'sleep':
    time.sleep(0.02)
elif name == 'sudo':
    if 'echo $$' in ' '.join(args) and 'exec ' in ' '.join(args):
        print('foreground server output', flush=True)
        if os.environ.get('FAIL_BRIDGE'):
            print('simulated bridge failure', flush=True)
            sys.exit(1)
        assert sys.stdin.read() == ''  # server bridges must not consume TAS input
        if os.environ.get('DIE_BRIDGE_AFTER'):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if any(json.loads(line)[0] == 'kot-tas' for line in pathlib.Path(os.environ['MOCK_LOG']).read_text().splitlines()):
                    break
                time.sleep(0.01)
            time.sleep(float(os.environ['DIE_BRIDGE_AFTER']))
            sys.exit(1)
        time.sleep(30)  # fake connected foreground server
    if 'waydroid' in args and 'kill -0' in ' '.join(args) and os.environ.get('FAIL_WATCH'):
        sys.exit(1)
elif name == 'adb':
    command = ' '.join(args)
    if 'forward --no-rebind tcp:27183' in command and os.environ.get('FAIL_FORWARD'):
        sys.exit(1)
    if 'get-state' in command: print('device')
    if 'ro.product.cpu.abi' in command: print('x86_64')
    if 'su -c id' in command: print('uid=0(root)')
    if 'wm size' in command: print(os.environ.get('WM_SIZE', 'Physical size: 1920x1048'))
    if '--version' in command: print(os.environ.get('SERVER_VERSION', '17.16.4'))
elif name == 'python':
    # start.sh parses the config with this interpreter when the system python3 has
    # no PyYAML (NixOS); the health check calls it with five arguments instead.
    if args[:1] == ['-c']:
        sys.exit(0)
    if args[:1] == ['-'] and len(args) == 2:
        import re, yaml
        with open(args[1]) as f:
            config = yaml.safe_load(f)
        port = re.fullmatch(r'(?:127\.0\.0\.1|localhost):([0-9]+)', config['frida']['device'])
        print(config['phantom']['port'])
        print(int(port[1]))
        print(config['frida']['package'])
        sys.exit(0)
    print('health check: ' + args[-1])
    sys.stdin.read()
    if os.environ.get('FAIL_HEALTH'): sys.exit(1)
elif name == 'kot-tas':
    with open(os.environ['MOCK_LOG'], 'a') as f:
        f.write(json.dumps(['kot-tas-env', os.environ.get('KOT_TAS_SCREEN_WIDTH'),
                            os.environ.get('KOT_TAS_SCREEN_HEIGHT')]) + '\n')
    if os.environ.get('MOCK_QUIT_FILE'):
        def cancel_command(signum, frame):
            with open(os.environ['MOCK_LOG'], 'a') as f:
                f.write(json.dumps(['menu-after-sigint']) + '\n')
        signal.signal(signal.SIGINT, cancel_command)
        with open(os.environ['MOCK_LOG'], 'a') as f:
            f.write(json.dumps(['fake-tas-ready']) + '\n')
        while not pathlib.Path(os.environ['MOCK_QUIT_FILE']).exists():
            time.sleep(0.01)
        sys.exit(0)
    if os.environ.get('RESTRICT_LOGS'):
        sessions = pathlib.Path(os.environ['XDG_DATA_HOME']) / 'kot-tas/sessions'
        for session in sessions.glob('session.*'):
            for name in ('watch.log', 'health.log'):
                path = session / name
                path.touch(exist_ok=True)
                path.chmod(0o400)
            session.chmod(0o500)
    time.sleep(float(os.environ.get('APP_SLEEP', '0.08')))
    sys.exit(int(os.environ.get('APP_EXIT', '0')))
'''.replace('PYTHON', sys.executable, 1)


class ScriptSyntaxTests(unittest.TestCase):
    def test_bash_syntax_and_help(self):
        for script in ('install.sh', 'start.sh'):
            path = ROOT / 'start' / script
            subprocess.run(['bash', '-n', path], check=True)
            result = subprocess.run([path, '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Usage:', result.stdout)

    def test_embedded_python_syntax(self):
        for path in (ROOT / 'start').glob('*.sh'):
            source = path.read_text()
            for part in source.split("<<'PY'\n")[1:]:
                ast.parse(part.split('\nPY\n', 1)[0], filename=str(path))


class PhantomRemoteTests(unittest.TestCase):
    """Real local Git repositories, no fetches or network calls."""

    def validate(self, urls, rewrite=False):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            subprocess.run(['git', 'init', '-q', source], check=True)
            for url in urls:
                subprocess.run(['git', '-C', source, 'config', '--local', '--add',
                                'remote.origin.url', url], check=True)
            global_config = Path(directory) / 'gitconfig'
            global_config.write_text('')
            if rewrite:
                subprocess.run(['git', 'config', '--file', global_config,
                                'url.https://mirror.example/.insteadOf', 'https://github.com/'], check=True)
            env = {**os.environ, 'SOURCE': str(source), 'GIT_CONFIG_GLOBAL': str(global_config),
                   'GIT_CONFIG_NOSYSTEM': '1'}
            script = (ROOT / 'start/install.sh').read_text()
            function = script.split('validate_phantom_source() {', 1)[1].split('\n}\n', 1)[0]
            command = 'fail() { echo "$*" >&2; exit 1; }; validate_phantom_source() {' + function + '\n}\nvalidate_phantom_source'
            result = subprocess.run(['bash', '-c', command], env=env, capture_output=True, text=True)
            stored = subprocess.run(['git', '-C', source, 'config', '--local', '--get-all',
                                     'remote.origin.url'], capture_output=True, text=True).stdout.splitlines()
            self.assertEqual(stored, urls)  # validation never rewrites the user's remote
            if rewrite:
                effective = subprocess.check_output(['git', '-C', source, 'remote', 'get-url', 'origin'],
                                                     env=env, text=True)
                self.assertIn('mirror.example', effective)
            return result

    def test_equivalent_github_urls(self):
        for url in ('https://github.com/NoortZee/phantom_keymaper.git',
                    'https://github.com/noortzee/phantom_keymaper',
                    'https://github.com/NoortZee/phantom_keymaper.git/',
                    'git@github.com:NoortZee/phantom_keymaper.git',
                    'ssh://git@github.com/NoortZee/phantom_keymaper.git',
                    'ssh://git@github.com:22/NoortZee/phantom_keymaper.git'):
            with self.subTest(url=url):
                result = self.validate([url])
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_instead_of_rewrite_does_not_trigger_false_rejection(self):
        result = self.validate(['https://github.com/NoortZee/phantom_keymaper.git'], rewrite=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_other_repositories_and_multiple_urls_are_rejected(self):
        for urls in (['https://github.com/other/phantom_keymaper.git'],
                     ['https://github.com/NoortZee/phantom_keymaper-other.git'],
                     ['https://github.com.evil.example/NoortZee/phantom_keymaper.git'],
                     ['https://user:secret@example.com/NoortZee/phantom_keymaper.git'],
                     ['https://github.com/NoortZee/phantom_keymaper.git'] * 2, []):
            with self.subTest(urls=urls):
                result = self.validate(urls)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('secret', result.stderr)


@unittest.skipIf(os.geteuid() == 0, 'Installer intentionally refuses root')
class InstallerDependencyTests(unittest.TestCase):
    """Execute the real dependency-selection prefix, with an isolated mock PATH."""

    def run_dependencies(self, managers, fail_install=False, nixos=False, present=()):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            (root / 'start').mkdir()
            log = root / 'commands.jsonl'
            mock = "#!" + sys.executable + "\n" + r'''
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
if name == 'uname':
    print('Linux' if sys.argv[1] == '-s' else 'x86_64')
elif name == 'sudo':
    with open(os.environ['MOCK_LOG'], 'a') as f:
        f.write(json.dumps(sys.argv[1:]) + '\n')
    if os.environ.get('FAIL_INSTALL') and sys.argv[1] != '-v':
        sys.exit(42)
elif name == 'nix':
    args = sys.argv[1:]
    with open(os.environ['MOCK_LOG'], 'a') as f:
        f.write(json.dumps(args) + '\n')
    if os.environ.get('FAIL_INSTALL') and 'profile' in args:
        sys.exit(42)
    # A real `nix profile install nixpkgs#jdk17` puts javac on PATH; the installer
    # derives JAVA_HOME from it, so the mock has to reproduce that side effect.
    if any(a.endswith('#jdk17') for a in args):
        for tool in ('javac', 'java'):
            path = pathlib.Path(sys.argv[0]).resolve().parent / tool
            path.write_text('#!/bin/sh\n')
            path.chmod(0o755)
'''
            for name in ('uname', 'sudo', 'waydroid', *managers):
                path = bin_dir / name
                path.write_text(mock)
                path.chmod(0o755)
            if nixos:
                # NixOS is identified by nixos-rebuild, not by the nix binary alone.
                for name in ('nixos-rebuild', 'nix'):
                    path = bin_dir / name
                    path.write_text(mock)
                    path.chmod(0o755)
            # Tools the installer should find already installed and leave alone.
            for name in present:
                path = bin_dir / name
                path.write_text('#!/bin/sh\n')
                path.chmod(0o755)
            # The harness owns PATH, so the coreutils the prefix really executes
            # have to be linked in explicitly.
            for name in ('dirname', 'grep', 'install', 'mv', 'date', 'sha256sum',
                         'cut', 'tr', 'chmod', 'readlink'):
                real = shutil.which(name)
                if real:
                    (bin_dir / name).symlink_to(real)
            # install.sh resolves ROOT as the parent of its own directory and
            # creates config.yaml from config.example.yaml before anything else.
            shutil.copy2(ROOT / 'config.example.yaml', root / 'config.example.yaml')
            script = root / 'start/install.sh'
            prefix = (ROOT / 'start/install.sh').read_text().split('# Use the installed JDK', 1)[0]
            script.write_text(prefix + 'printf "JAVA_HOME=%s\\n" "$JAVA_HOME"\n')
            result = subprocess.run([shutil.which('bash'), script], capture_output=True, text=True,
                                    env={**os.environ, 'PATH': str(bin_dir), 'HOME': str(root),
                                         'MOCK_LOG': str(log), 'FAIL_INSTALL': '1' if fail_install else ''})
            commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            # The temporary tree disappears on return, so anything worth asserting
            # about the filesystem has to be read here.
            config = root / 'config.yaml'
            paths = {'root': str(root), 'bin': str(bin_dir),
                     'config_created': config.is_file(),
                     'config_mode': config.stat().st_mode & 0o777 if config.is_file() else None}
            return result, commands, paths

    def test_cachyos_pacman_dependencies(self):
        result, commands, _ = self.run_dependencies(('pacman',))
        self.assertEqual(result.returncode, 0, result.stderr)
        install = commands[-1]
        self.assertEqual(install[:4], ['pacman', '-S', '--needed', '--noconfirm'])
        for package in ('android-tools', 'base-devel', 'pkgconf', 'clang', 'llvm', 'openssl',
                        'python', 'python-pip', 'python-yaml', 'jdk17-openjdk', 'procps-ng'):
            self.assertIn(package, install)
        self.assertNotIn('python3-venv', install)
        self.assertNotIn('shellcheck', install)
        self.assertNotIn('konsole', install)
        self.assertEqual(len(commands), 2)  # sudo -v and the targeted install only
        for command in commands:
            if command[0] == 'pacman':
                self.assertFalse(any('y' in arg or 'u' in arg for arg in command[1:]
                                     if arg.startswith('-') and not arg.startswith('--')))
        self.assertIn('JAVA_HOME=/usr/lib/jvm/java-17-openjdk', result.stdout)

    def test_debian_apt_dependencies_preserved(self):
        result, commands, _ = self.run_dependencies(('apt-get',))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(commands[1], ['apt-get', 'update'])
        self.assertEqual(commands[2][:3], ['apt-get', 'install', '-y'])
        self.assertIn('python3-venv', commands[2])
        self.assertIn('openjdk-17-jdk-headless', commands[2])
        self.assertIn('JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64', result.stdout)

    def test_pacman_preferred_if_both_commands_exist(self):
        result, commands, _ = self.run_dependencies(('pacman', 'apt-get'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c[0] == 'apt-get' for c in commands))

    def test_unsupported_manager_fails_without_sudo(self):
        result, commands, _ = self.run_dependencies(())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Supported distributions', result.stderr)
        self.assertEqual(commands, [])

    def test_package_failure_stops_installation(self):
        result, commands, _ = self.run_dependencies(('pacman',), fail_install=True)
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual(len(commands), 2)
        self.assertNotIn('JAVA_HOME=', result.stdout)

    def nix_command(self, commands):
        nix = [c for c in commands if c[0] == '--extra-experimental-features']
        self.assertEqual(len(nix), 1, commands)
        self.assertEqual(nix[0][:4], ['--extra-experimental-features', 'nix-command flakes',
                                      'profile', 'install'])
        return nix[0][4:]

    def test_nixos_is_preferred_over_pacman_and_apt(self):
        # NixOS can have pacman or apt-get installed through nix; neither can write
        # to a read-only store, so the distribution marker must win.
        result, commands, _ = self.run_dependencies(('pacman', 'apt-get'), nixos=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c[0] in ('pacman', 'apt-get') for c in commands), commands)
        self.assertEqual([c for c in commands if c[0] == '-v'], [['-v']])
        self.nix_command(commands)

    def test_nixos_installs_dependencies_into_the_user_profile(self):
        result, commands, _ = self.run_dependencies((), nixos=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        attrs = self.nix_command(commands)
        for attr in ('android-tools', 'gnumake', 'gcc', 'pkg-config', 'clang', 'llvm',
                     'git', 'curl', 'unzip', 'xz', 'python3', 'jdk17',
                     'util-linux', 'procps', 'findutils', 'cargo', 'rustc'):
            self.assertIn(f'nixpkgs#{attr}', attrs)
        # Every argument is a store path spec, never a bare attribute.
        self.assertTrue(all(a.startswith('nixpkgs#') for a in attrs), attrs)
        self.assertEqual(len(commands), 2)  # sudo -v and the profile install only

    def test_nixos_derives_java_home_from_the_javac_it_installed(self):
        result, commands, paths = self.run_dependencies((), nixos=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # There is no /usr/lib/jvm on NixOS: JAVA_HOME comes from readlink -f javac.
        # javac lives in <home>/bin/javac here, so JAVA_HOME is the directory
        # holding bin/, exactly as $out/lib/openjdk would be in the real store.
        self.assertIn(f"JAVA_HOME={paths['root']}\n", result.stdout)
        self.assertNotIn('/usr/lib/jvm', result.stdout)

    def test_nixos_skips_tools_already_on_path(self):
        # `nix profile install` refuses duplicates, so present tools must be probed out.
        result, commands, _ = self.run_dependencies((), nixos=True, present=('git', 'curl', 'unzip'))
        self.assertEqual(result.returncode, 0, result.stderr)
        attrs = self.nix_command(commands)
        for gone in ('nixpkgs#git', 'nixpkgs#curl', 'nixpkgs#unzip'):
            self.assertNotIn(gone, attrs)
        self.assertIn('nixpkgs#android-tools', attrs)

    def test_nixos_package_failure_stops_installation(self):
        result, commands, _ = self.run_dependencies((), nixos=True, fail_install=True)
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertNotIn('JAVA_HOME=', result.stdout)

    def test_installer_creates_config_before_touching_packages(self):
        result, commands, paths = self.run_dependencies(('pacman',))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(paths['config_created'], 'config.yaml was not created next to the checkout')
        self.assertEqual(paths['config_mode'], 0o600)
        self.assertIn('Created config.yaml', result.stdout)


@unittest.skipIf(os.geteuid() == 0, 'Launcher intentionally refuses root')
class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'start').mkdir()
        shutil.copy2(ROOT / 'start/start.sh', self.root / 'start/start.sh')
        version = self.root / 'third_party/frida-rust/frida-sys/FRIDA_VERSION'
        version.parent.mkdir(parents=True)
        version.write_text('17.16.4\n')
        shutil.copy2(ROOT / 'config.example.yaml', self.root / 'config.yaml')
        self.bin = self.root / 'mock-bin'
        self.bin.mkdir()
        for name in ('adb', 'sudo', 'waydroid', 'sleep'):
            self.executable(self.bin / name)
        data = self.root / 'data/kot-tas'
        self.executable(data / 'venv/bin/python')
        (data / 'bin').mkdir()
        (data / 'bin/sysmon').write_bytes(b'fake-server')
        (data / 'bin/phantom-server.jar').write_bytes(b'fake-jar')
        self.executable(self.root / 'target/release/kot-tas')
        self.log = self.root / 'commands.jsonl'
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        HOME=str(self.root), XDG_DATA_HOME=str(self.root / 'data'),
                        MOCK_LOG=str(self.log))

    def executable(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(MOCK)
        path.chmod(0o755)

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def run_launcher(self, **extra):
        return subprocess.run([self.root / 'start/start.sh'], env={**self.env, **extra},
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)

    def assert_cleanup(self, ports=('41337', '27183')):
        commands = self.commands()
        for port in ports:
            self.assertIn(['adb', '-s', '192.168.240.112:5555', 'forward', '--remove', f'tcp:{port}'], commands)
        self.assertEqual(commands[-1], ['adb', 'kill-server'])
        remote_cleanup = [c for c in commands if c[0] == 'sudo' and 'rm -rf /data/local/tmp/kot-tas-' in ' '.join(c)]
        self.assertEqual(len(remote_cleanup), 1)
        self.assertIn('/proc/$pid/cmdline', ' '.join(remote_cleanup[0]))

    def test_normal_exit(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_cleanup()
        self.assertTrue(any(c[0] == 'kot-tas' for c in self.commands()))

    def test_waydroid_display_size_reaches_tas(self):
        result = self.run_launcher(WM_SIZE='Physical size: 1920x1048')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['adb', '-s', '192.168.240.112:5555', 'shell', 'wm', 'size'], self.commands())
        self.assertEqual([c for c in self.commands() if c[0] == 'kot-tas-env'],
                         [['kot-tas-env', '1920', '1048']])
        self.assertIn('Waydroid display: 1920x1048', result.stdout)

    def test_override_size_wins_over_physical_size(self):
        # A resized Waydroid window reports both lines; the game renders into the override.
        result = self.run_launcher(WM_SIZE='Physical size: 1920x1080\nOverride size: 1280x720')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c for c in self.commands() if c[0] == 'kot-tas-env'],
                         [['kot-tas-env', '1280', '720']])

    def test_carriage_returns_in_wm_size_output_are_tolerated(self):
        result = self.run_launcher(WM_SIZE='Physical size: 1080x1920\r')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c for c in self.commands() if c[0] == 'kot-tas-env'],
                         [['kot-tas-env', '1080', '1920']])

    def test_unreadable_display_size_stops_before_tas(self):
        result = self.run_launcher(WM_SIZE='error: device offline')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Cannot read Waydroid display size', result.stderr)
        self.assertFalse(any(c[0] == 'kot-tas' for c in self.commands()))
        # Nothing was deployed yet, but the ADB server this session started is stopped.
        self.assertEqual(self.commands()[-1], ['adb', 'kill-server'])

    def test_system_python_without_pyyaml_falls_back_to_the_venv(self):
        # A NixOS system python3 has no site-packages, so `import yaml` fails and
        # the launcher must parse the config with the TAS venv interpreter instead.
        broken = self.bin / 'python3'
        broken.write_text('#!' + sys.executable + '\nimport sys\nsys.exit(1)\n')
        broken.chmod(0o755)
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['adb', '-s', '192.168.240.112:5555', 'forward', '--no-rebind',
                       'tcp:41337', 'localabstract:/data/local/tmp/sysmon.sock'], self.commands())
        self.assertTrue(any(c[0] == 'kot-tas' for c in self.commands()))

    def test_restricted_log_permissions_do_not_stop_healthy_tas(self):
        # Reproduce an unwritable watch.log/directory after TAS has already started.
        sessions = self.root / 'data/kot-tas/sessions'
        try:
            result = self.run_launcher(RESTRICT_LOGS='1', APP_SLEEP='1.2')
        finally:
            if sessions.exists():
                for session in sessions.iterdir():
                    session.chmod(0o700)
                    for path in session.iterdir():
                        path.chmod(0o600)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('Stopping TAS', result.stderr)
        self.assertNotIn('Permission denied', result.stderr)
        self.assert_cleanup()
        log = next(sessions.glob('session.*/health.log')).read_text()
        self.assertGreaterEqual(log.count('health check: monitor'), 2)

    def test_background_servers_without_graphical_session(self):
        self.env.pop('DISPLAY', None)
        self.env.pop('WAYLAND_DISPLAY', None)
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        self.assertFalse(any(c[0] in ('konsole', 'xterm', 'gnome-terminal') for c in commands))
        bridges = [c for c in commands if c[0] == 'sudo' and 'echo $$' in ' '.join(c)]
        self.assertEqual(len(bridges), 2)
        for bridge in bridges:
            self.assertEqual(bridge[1:5], ['-n', 'waydroid', 'shell', '--'])
        session = next((self.root / 'data/kot-tas/sessions').glob('session.*'))
        for name in ('sysmon', 'phantom'):
            runner = session / f'{name}.sh'
            content = runner.read_text()
            self.assertIn('sudo -n waydroid shell', content)
            self.assertNotIn('nohup', content)
            self.assertNotIn('& echo', content)
            subprocess.run(['bash', '-n', runner], check=True)
            self.assertIn('foreground server output', (session / f'{name}.log').read_text())
        self.assertNotIn('foreground server output', result.stdout)
        self.assertTrue((session / 'health.log').is_file())
        self.assert_cleanup()

    def test_failed_bridge_aborts_startup(self):
        result = self.run_launcher(FAIL_BRIDGE='1', FAIL_HEALTH='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[0] == 'kot-tas' for c in self.commands()))
        self.assertIn('simulated bridge failure', result.stderr)
        self.assert_cleanup()

    def test_background_bridge_exit_stops_tas(self):
        result = self.run_launcher(DIE_BRIDGE_AFTER='0.3', APP_SLEEP='30')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Stopping TAS', result.stderr)
        self.assert_cleanup()

    def test_tas_failure_preserves_exit_status(self):
        result = self.run_launcher(APP_EXIT='7')
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assert_cleanup()

    def test_second_forward_failure_cleans_only_owned_forward(self):
        result = self.run_launcher(FAIL_FORWARD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assert_cleanup(ports=('41337',))
        commands = self.commands()
        self.assertFalse(any(c[0] == 'kot-tas' for c in commands))
        self.assertFalse(any(c[-2:] == ['--remove', 'tcp:27183'] for c in commands))

    def test_version_mismatch_stops_before_starting_servers(self):
        result = self.run_launcher(SERVER_VERSION='0.0.0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('version mismatch', result.stderr)
        commands = self.commands()
        self.assertFalse(any('nohup /data/local/tmp/sysmon' in ' '.join(c) for c in commands))
        self.assertEqual(commands[-1], ['adb', 'kill-server'])

    def test_readiness_failure_cleans_servers_without_running_tas(self):
        result = self.run_launcher(FAIL_HEALTH='1')
        self.assertNotEqual(result.returncode, 0)
        self.assert_cleanup()
        self.assertFalse(any(c[0] == 'kot-tas' for c in self.commands()))

    def test_server_death_stops_tas(self):
        result = self.run_launcher(FAIL_WATCH='1', APP_SLEEP='30')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Stopping TAS', result.stderr)
        self.assert_cleanup()

    def test_terminal_ctrl_c_keeps_tas_menu_and_servers_alive(self):
        quit_file = self.root / 'quit-tas'
        process = subprocess.Popen([self.root / 'start/start.sh'],
                                   env={**self.env, 'MOCK_QUIT_FILE': str(quit_file)},
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.log.exists() and ['fake-tas-ready'] in self.commands():
                break
            time.sleep(0.02)
        else:
            self.fail('TAS did not become ready')
        # Like a terminal Ctrl+C: signal the launcher's entire foreground group.
        os.killpg(process.pid, signal.SIGINT)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if ['menu-after-sigint'] in self.commands():
                break
            time.sleep(0.02)
        else:
            self.fail('SIGINT was not forwarded to TAS')
        time.sleep(0.3)  # allow several supervisor ticks after cancellation
        self.assertIsNone(process.poll())
        self.assertFalse(any(c[-2:] == ['--remove', 'tcp:27183'] for c in self.commands()))
        quit_file.touch()  # simulate an explicit q/exit in the menu
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr)
        self.assert_cleanup()

    def test_signal_stops_tas_and_cleans_servers(self):
        process = subprocess.Popen([self.root / 'start/start.sh'], env={**self.env, 'APP_SLEEP': '30'},
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.log.exists() and any(c[0] == 'kot-tas' for c in self.commands()):
                break
            time.sleep(0.02)
        else:
            self.fail('TAS did not start')
        process.send_signal(signal.SIGTERM)
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 143, stderr)
        self.assert_cleanup()


if __name__ == '__main__':
    unittest.main()
