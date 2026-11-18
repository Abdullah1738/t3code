import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import importlib.util
import io
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'watchers/activity-digest/summarize.py'
spec = importlib.util.spec_from_file_location('activity_digest', SOURCE)
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)


class ActivityDigestTests(unittest.TestCase):
    def assert_counts_match_lines(self, text):
        count = int(re.search(r'Activity log: (\d+)', text)[1])
        sections = re.split(r'^## (.+) \((\d+)\)\n', text, flags=re.M)
        observed = 0
        for name, size, body in zip(sections[1::3], sections[2::3], sections[3::3]):
            lines = [line for line in body.splitlines() if line.startswith('- ')]
            self.assertEqual(int(size), len(lines), name)
            self.assertTrue(all(digest.topic(line)[0] == name for line in lines), name)
            observed += len(lines)
        self.assertEqual(count, observed)

    def test_every_source_and_counted_entry_is_rendered(self):
        lines = [f'- 2026-11-10 10:17 · source{i} · event {j}' for i in range(16) for j in range(i % 3 + 1)]
        lines += ['- 2026-11-10 10:17 · noon · N123 tracking_problem, no ping',
                  '2026-11-10 ~10:2x · noon · exact order still unconfirmed',
                  '- 2026-11-11 09:00 · careem · delivery arrived']
        rendered = digest.render('\n'.join(lines) + '\n\n')
        self.assert_counts_match_lines(rendered)
        for line in lines:
            self.assertIn('- ' + line.removeprefix('- '), rendered)

    def run_main(self, raw):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'digest.md'
            output = io.StringIO()
            with patch.object(digest.sys, 'argv', ['summarize.py', str(path)]), \
                    patch.object(digest.sys, 'stdin', io.StringIO(raw)), patch.object(digest.sys, 'stdout', output):
                digest.main()
            return output.getvalue(), path.read_text() if path.exists() else ''

    def test_small_wake_is_the_complete_digest(self):
        out, saved = self.run_main('- 2026-11-10 10:17 · noon · tracking_problem\n')
        self.assertEqual(out, saved)
        self.assert_counts_match_lines(out)

    def test_oversized_wake_has_no_counts_missing_their_lines(self):
        raw = '\n'.join(f'- 2026-11-10 10:17 · source{i % 20} · event {i} ' + 'detail ' * 40 for i in range(80))
        out, saved = self.run_main(raw)
        self.assertLess(len(out), digest.WAKE_BUDGET)
        self.assertNotIn('unreported', out)
        self.assertNotIn('##', out)
        self.assert_counts_match_lines(saved)
        self.assertIn('event 79', saved)

    def test_redacted_text_is_counted_and_rendered_together(self):
        out, saved = self.run_main('- 2026-11-10 10:17 · noon · password: Fake#Pass123\n')
        self.assertNotIn('Fake#Pass123', out + saved)
        self.assert_counts_match_lines(saved)

    def test_empty_input_has_no_digest(self):
        self.assertEqual(self.run_main('\n '), ('', ''))


if __name__ == '__main__':
    unittest.main()
