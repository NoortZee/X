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
import json, os, pathlib, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as f:
    f.write(json.dumps([name, *args]) + '\n')
if name == 'sleep':
    time.sleep(0.02)
elif name == 'sudo':
    if 'waydroid' in args and 'kill -0' in ' '.join(args) and os.environ.get('FAIL_WATCH'):
        sys.exit(1)
elif name == 'adb':
    command = ' '.join(args)
    if 'forward --no-rebind tcp:27183' in command and os.environ.get('FAIL_FORWARD'):
        sys.exit(1)
    if 'get-state' in command: print('device')
    if 'ro.product.cpu.abi' in command: print('x86_64')
    if 'su -c id' in command: print('uid=0(root)')
    if '--version' in command: print(os.environ.get('SERVER_VERSION', '17.16.4'))
elif name == 'python':
    sys.stdin.read()
    if os.environ.get('FAIL_HEALTH'): sys.exit(1)
elif name == 'kot-tas':
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
