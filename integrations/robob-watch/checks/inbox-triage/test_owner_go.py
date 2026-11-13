import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owner_go_triage', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class MoneyContextTests(unittest.TestCase):
    def test_open_ledger_is_shared_with_attribution_context(self):
        rows = [{'kind':'ask', 'id':'q1', 'vendor':'hetzner','item':'server','amount':53400,'currency':'USD'}]
        with patch.object(t.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(rows))) as run:
            self.assertEqual(t.open_money_questions(), {'available':True, 'questions':rows})
        self.assertEqual(run.call_args.args[0][-3:], ['list','--open','--json'])

    def test_no_empty_ledger_claim_on_failure(self):
        for result in (subprocess.CompletedProcess([], 4, '[]'), subprocess.CompletedProcess([], 0, '{}'),
                       subprocess.CompletedProcess([], 0, '{bad')):
            with self.subTest(result=result), patch.object(t.subprocess, 'run', return_value=result):
                self.assertEqual(t.open_money_questions(), {'available':False})
        with patch.object(t.subprocess, 'run', side_effect=FileNotFoundError):
            self.assertEqual(t.open_money_questions(), {'available':False})


if __name__ == '__main__': unittest.main()
