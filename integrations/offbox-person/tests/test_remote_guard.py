import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

class Tests(unittest.TestCase):
    def test_raw_moni_check_refuses_before_contacting_offbox(self):
        with tempfile.TemporaryDirectory() as td:
            config = Path(td) / 'config.json'
            config.write_text(json.dumps({'chatBackends': {'moni': {'kind': 'remote-box'}}}))
            helper = Path(__file__).resolve().parents[1] / 'bin/offbox-person-wa-new'
            result = subprocess.run(['zsh', str(helper), 'moni', '971500000001'], env={**os.environ, 'SPECTRUM_BRIDGE_CONFIG': str(config)}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertIn('on her box', result.stderr)

if __name__ == '__main__': unittest.main()
