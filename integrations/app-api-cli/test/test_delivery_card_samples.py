import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import delivery_card_samples as s
import delivery_cards as c


class SampleTests(unittest.TestCase):
    def test_every_case_builds_a_public_card_without_tracker_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Point tracker state somewhere empty and unreadable by the samples.
            with patch.object(c, 'ROOT', root / 'state'), patch.object(c, 'APPS', root / 'apps'):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    s.main(['--out', str(root / 'cards')])
            lines = [json.loads(x) for x in out.getvalue().splitlines()]
            self.assertEqual([x['state'] for x in lines], list(s.cases()))
            self.assertFalse((root / 'state').exists())
            self.assertFalse((root / 'apps').exists())
            for x in lines:
                d = Path(x['dir'])
                for f in ('index.html', 'status.json', 'preview.png'):
                    self.assertTrue((d / f).exists(), f'{x["state"]} {f}')
                self.assertFalse((d / 'items.json').exists(), x['state'])
            stages = {x['state']: json.loads((Path(x['dir']) / 'status.json').read_text()) for x in lines}
            self.assertEqual(stages['noeta']['big'], 'No estimate yet')
            self.assertTrue(stages['stale']['unavailable'])
            self.assertTrue(stages['partial']['partial'])
            self.assertTrue(stages['sample']['sample'])
            dirs = {x['state']: Path(x['dir']) for x in lines}
            self.assertTrue((dirs['photos'] / 'photo-0.png').exists())

    def test_only_limits_the_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                s.main(['--out', tmp, '--only', 'pizza,noeta'])
            self.assertEqual([json.loads(x)['state'] for x in out.getvalue().splitlines()], ['noeta', 'pizza'])


if __name__ == '__main__':
    unittest.main()
