"""Tap coordinates scale to the Waydroid window instead of a hardcoded resolution.

These tests pin the shipped contract: the fractions in config.example.yaml must
reproduce the pixel values that used to be hardcoded, and the environment
variable names must agree between start/start.sh and TAS/config.rs.

Run: python3 -m unittest discover -s tests -v (requires PyYAML, as does start.sh).
"""
import math
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

# The window the shipped fractions were measured on, and the pixels they stood
# for before scaling existed. The example config no longer mentions any of these
# numbers, so this test is the only record that the tap points did not move:
# on that window the fractions must still land on exactly those pixels.
REFERENCE = (1920, 1048)


def scale(frac, span):
    """Mirror Rust's `(f * span as f64).round() as i32` (half away from zero)."""
    return math.floor(frac * span + 0.5)


class ConfigExampleScalingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = yaml.safe_load((ROOT / 'config.example.yaml').read_text(encoding='utf-8'))

    def test_tap_uses_fractions_and_reproduces_the_old_pixels(self):
        tap = self.config['tap']
        self.assertEqual(tap['position'], 'fraction')
        self.assertEqual((scale(tap['x_frac'], REFERENCE[0]), scale(tap['y_frac'], REFERENCE[1])),
                         (540, 960))

    def test_skip_button_uses_fractions_and_reproduces_the_old_pixels(self):
        skip = self.config['stones']['skip_on_no_match']
        self.assertEqual((scale(skip['x_frac'], REFERENCE[0]), scale(skip['y_frac'], REFERENCE[1])),
                         (1775, 970))

    def test_fractions_stay_inside_the_window_on_other_resolutions(self):
        for name, coords in (('tap', self.config['tap']),
                             ('skip', self.config['stones']['skip_on_no_match'])):
            for w, h in (REFERENCE, (1080, 1920), (2560, 1440), (1280, 720)):
                x, y = scale(coords['x_frac'], w), scale(coords['y_frac'], h)
                self.assertTrue(0 <= x < w and 0 <= y < h, f'{name} out of bounds on {w}x{h}')

    def test_example_carries_no_hardcoded_pixels_or_resolution(self):
        # Coordinates scale, so the example must not pin one device's numbers.
        raw = (ROOT / 'config.example.yaml').read_text(encoding='utf-8')
        pattern = re.compile(r'(?<![\d.])(1920|1048|540|960|1775|970)(?![\d.])')
        for number, line in enumerate(raw.splitlines(), 1):
            found = pattern.search(line)
            if found:
                self.fail(f'hardcoded {found[1]} is back in config.example.yaml:{number}: {line.strip()}')
        for section in (self.config['tap'], self.config['stones']['skip_on_no_match']):
            for key in ('x', 'y', 'screen_width', 'screen_height'):
                self.assertNotIn(key, section)
        # The screen section stays as an (empty) autodetection placeholder, which
        # parses as null; config.rs must accept that instead of failing to load.
        self.assertIn('screen', self.config)
        self.assertIn(self.config['screen'], (None, {}))
        self.assertIn('fn screen_or_default', (ROOT / 'TAS/config.rs').read_text(encoding='utf-8'))


class LauncherAndRustAgreementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.launcher = (ROOT / 'start/start.sh').read_text(encoding='utf-8')
        cls.config_rs = (ROOT / 'TAS/config.rs').read_text(encoding='utf-8')
        cls.screen_rs = (ROOT / 'stones/config.rs').read_text(encoding='utf-8')

    def test_launcher_reads_wm_size_and_exports_both_dimensions(self):
        self.assertIn('adb_device shell wm size', self.launcher)
        for name in ('KOT_TAS_SCREEN_WIDTH', 'KOT_TAS_SCREEN_HEIGHT'):
            self.assertRegex(self.launcher, rf'export {name}=')

    def test_rust_reads_exactly_the_names_the_launcher_exports(self):
        exported = set(re.findall(r'export (KOT_TAS_SCREEN_[A-Z]+)=', self.launcher))
        self.assertEqual(exported, {'KOT_TAS_SCREEN_WIDTH', 'KOT_TAS_SCREEN_HEIGHT'})
        for name in sorted(exported):
            self.assertIn(f'env_dim("{name}")', self.config_rs)
        # No stale name survives on either side.
        for name in set(re.findall(r'KOT_TAS_[A-Z_]+', self.launcher + self.config_rs)) - exported:
            self.fail(f'unexpected KOT_TAS_ variable: {name}')

    def test_launcher_prefers_override_size_and_rejects_garbage(self):
        override = self.launcher.index('Override size')
        physical = self.launcher.index('Physical size')
        self.assertLess(override, physical, 'Override size must be tried before Physical size')
        self.assertIn('Cannot read Waydroid display size', self.launcher)

    def test_screen_section_is_optional_in_the_rust_config(self):
        self.assertRegex(self.config_rs,
                         r'#\[serde\(default, deserialize_with = "screen_or_default"\)\]\s*\n'
                         r'\s*pub screen: ScreenConfig,')
        self.assertIn('pub struct ScreenConfig', self.config_rs)

    def test_all_tap_modes_are_still_supported(self):
        for mode in ('"explicit"', '"fraction"', '"center_lower_third"'):
            self.assertIn(f'{mode} =>', self.config_rs)

    def test_skip_coords_accept_both_absolute_and_fractional(self):
        for field in ('pub x: Option<i32>', 'pub y: Option<i32>',
                      'pub x_frac: Option<f64>', 'pub y_frac: Option<f64>'):
            self.assertIn(field, self.screen_rs)

    def test_no_call_site_still_uses_the_old_resolve_signature(self):
        for path in ROOT.glob('TAS/*.rs'):
            text = path.read_text(encoding='utf-8')
            self.assertNotRegex(text, r'\.tap\s*\n?\s*\.resolve\(\s*\)',
                                f'{path.name} calls tap.resolve() without the screen')


if __name__ == '__main__':
    unittest.main()
