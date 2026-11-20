"""Source-level guards for Rust integration; not a substitute for Cargo/device tests."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class CatacombsIntegrationTests(unittest.TestCase):
    def test_rpc_message_handler_is_installed_before_load_and_install(self):
        source = (ROOT / 'catacombs/mod.rs').read_text()
        handler = source.index('script.handle_message(CatacombsHandler)?')
        load = source.index('script.load()?')
        install = source.index('script.exports.call_cancellable("install"')
        self.assertLess(handler, load)
        self.assertLess(load, install)

    def test_commands_receive_the_existing_ctrl_c_flag(self):
        source = (ROOT / 'TAS/main.rs').read_text()
        self.assertIn('catacombs_mod.command(parts.get(1).copied().unwrap_or("help"), &aborted)', source)
        source = (ROOT / 'catacombs/mod.rs').read_text()
        self.assertIn('aborted.load(Ordering::SeqCst)', source)
        self.assertNotIn('script.exports.call(', source)

    def test_wait_is_bounded_and_matches_reply_id(self):
        source = (ROOT / 'third_party/frida-rust/frida/src/script.rs').read_text()
        source = source[source.index('pub fn call_cancellable('):]
        self.assertNotIn('rx.recv().unwrap()', source)
        self.assertIn('rx.recv_timeout(', source)
        self.assertIn('if cancelled()', source)
        self.assertIn('remaining.is_zero()', source)
        self.assertIn('Some(request_id as u64)', source)
        self.assertIn('RecvTimeoutError::Disconnected', source)

    def test_cleanup_does_not_wait_for_stop_rpc(self):
        source = (ROOT / 'catacombs/mod.rs').read_text()
        stop = source[source.index('pub fn stop('):]
        self.assertIn('script.unload()', stop)
        self.assertNotIn('exports.call', stop)
