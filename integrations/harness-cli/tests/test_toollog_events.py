import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import harness_cli as hc


class CanaryEvents(unittest.TestCase):
    def test_canary_success_and_failure(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs'}):
            staged=Path(temp)/'version'
            (staged/'bin').mkdir(parents=True)
            (staged/'bin/claude').write_text('fixture')
            result={model:{'ok':True} for model in hc.MODEL_CANARIES['claude']}
            result.update(memoryCanaryChecked=True,requests=1,thinkingSettingsChecked=True,thinkingCheckChecked=True,thinkingReplayed=True,inputTransformationsEmpty=True)
            with patch.object(hc,'version_dir',return_value=staged), patch.object(hc,'write_record'), patch.object(hc,'check_minimums'), patch.object(hc,'verify_companions',return_value={}), patch.object(hc,'binary_version',return_value='fixture'), patch.object(hc,'canary_claude',return_value=result), patch.object(hc,'valid_claude_canary',return_value=True), patch.object(hc,'harness_home_hashes',return_value={}):
                self.assertTrue(hc.canary('claude','fixture')['passed'])
                with patch.object(hc,'canary_claude',side_effect=RuntimeError('prompt secret')):
                    self.assertFalse(hc.canary('claude','fixture')['passed'])
            rows=[json.loads(line) for path in Path(temp+'/logs/agent-tools').glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertEqual([r['name'] for r in rows],['canary.run']*2)
            self.assertEqual([r['ok'] for r in rows],[True,False])
            self.assertEqual(rows[-1]['props']['failingStep'],'runtime')
            for row in rows: print('TOOLLOG_SAMPLE ' + json.dumps(row, separators=(',', ':')), file=sys.__stdout__)
            self.assertNotIn('prompt secret',json.dumps(rows))
