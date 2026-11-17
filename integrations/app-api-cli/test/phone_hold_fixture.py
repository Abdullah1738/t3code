import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import phone_hold


class FakePhTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.config = self.folder / 'ph-response.json'
        self.ph = self.folder / 'ph'
        self.ph.write_text('''#!{python}
import json, os, sys, time
from pathlib import Path
assert sys.argv[1:] == ['hold', 'status', '--json']
assert not any(k.startswith('BUN_INSPECT') for k in os.environ)
config = json.loads(Path({config!r}).read_text())
if config.get('sleep'):
    time.sleep(config['sleep'])
print(config['stdout'])
sys.exit(config.get('exit_code', 0))
'''.format(python=sys.executable, config=str(self.config)))
        self.ph.chmod(0o700)
        self.respond(present=False)
        for p in (patch.dict(os.environ, {'PH_BIN': str(self.ph)}),
                  patch.object(phone_hold, 'PH_BIN', str(self.ph))):
            p.start()
            self.addCleanup(p.stop)

    def configure(self, stdout='', **options):
        self.config.write_text(json.dumps(dict(options, stdout=stdout)))

    def respond(self, **values):
        status = dict(present=False, age_s=None, stale_in_s=None,
                      holder_alive=None, agent_comm=None)
        self.configure(stdout=json.dumps(dict(status, **values)))
