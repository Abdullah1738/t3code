"""Offline proofs for message collectors and wake helpers; no real inbox reads."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'helpers'))
from test_redact import CASES


def load(name, path):
    loader = SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class MessageSinkTests(unittest.TestCase):
    def test_collectors_redact_before_truncation_and_line_collapse(self):
        for name, path in [('triage', 'checks/inbox-triage/triage.py'), ('offers', 'checks/assist-offers/offers.py')]:
            mod = load('sink_' + name, ROOT / path)
            for message, secret in CASES:
                with self.subTest(name=name, message=message):
                    self.assertNotIn(secret, mod.clean(message, 2000))
            self.assertNotIn('fake', mod.clean('password "fake\npass 99"', 15))

    def test_money_cases_preserves_legacy_and_removes_whole_quotes(self):
        mod = load('sink_cases', ROOT / 'checks/money-cases/cases.py')
        for message, secret in CASES + [('password: "fake pass 99"', 'fake pass 99'),
                                        ('pwd "Fake123 TailSecret!"', 'TailSecret!'),
                                        ('pwd `Fake123 TailSecret!`', 'TailSecret!'),
                                        ("pwd 'Fake123 TailSecret!'", 'TailSecret!'),
                                        ('OTP is 482 913', '913')]:
            with self.subTest(message=message):
                self.assertNotIn(secret, mod.redact(message))
        self.assertEqual(mod.redact('OTP is 482 913'), '[secret removed]')
        for label in ['pwd', 'password', 'passwd', 'passcode', 'pin', 'otp']:
            for wrapper in ['"', "'", '`', '**', '__', '*', '_']:
                for sep in [' ', ': ', ' - ']:
                    for quote in ['"', "'", '`']:
                        text = wrapper + label + wrapper + sep + quote + 'Fake123 TailSecret!' + quote
                        with self.subTest(text=text):
                            self.assertNotIn('TailSecret!', mod.redact(text))

    def test_wa_message_lines_and_replay_output(self):
        mod = load('sink_wadb', ROOT / 'helpers/wa-db')
        row = dict(text='', media_type='', filename='', media_caption='', reaction_emoji='',
                   display_text='', edited=0, revoked=0)
        for text, secret in CASES:
            self.assertNotIn(secret, mod.body(dict(row, text=text)))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                mod.emit([text], '', '/unused')
            self.assertNotIn(secret, out.getvalue())

    def test_email_wake_sanitizes_subject_before_flattening(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            stub = wd / 'himalaya'
            stub.write_text('#!/bin/sh\ncat "$REDACT_EMAIL_FIXTURE"\n')
            stub.chmod(0o700)
            fixture = wd / 'mail.json'
            fixture.write_text(json.dumps([{'id': 2, 'date': '2026-11-13', 'from': {'name': 'QA'},
                                            'subject': 'login details:\nqa@example.com\nFake#Pass123'}]))
            key = hashlib.sha256(b'icloud|Inbox|from qa').hexdigest()[:16]
            (wd / f'mail-{key}.seen').write_text('1\n')
            env = dict(os.environ, PATH=str(wd) + ':' + os.environ['PATH'], WATCH_DIR=tmp, REDACT_EMAIL_FIXTURE=str(fixture))
            out = subprocess.run(['zsh', str(ROOT / 'helpers/email-new-message'), 'icloud', 'from qa'],
                                 env=env, text=True, capture_output=True, timeout=10)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn('New email', out.stdout)
            self.assertIn('[redacted]', out.stdout)
            self.assertNotIn('Fake#Pass123', out.stdout)

    def test_output_changed_redacts_before_clipping_and_diff(self):
        for show in [True, False]:
            with tempfile.TemporaryDirectory() as tmp:
                env = dict(os.environ, WATCH_DIR=tmp)
                fixture = Path(tmp) / 'data'
                cmd = ['zsh', str(ROOT / 'helpers/output-changed'), *(['--show'] if show else []), '--', 'cat', str(fixture)]
                fixture.write_text('initial')
                subprocess.run(cmd, env=env, check=True, capture_output=True, timeout=5)
                fixture.write_text('login details:\nqa@example.com\nFake#Pass123')
                out = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=5)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertIn('[redacted]', out.stdout)
                self.assertNotIn('Fake#Pass123', out.stdout)
                for saved in Path(tmp).glob('*.last'):
                    self.assertNotIn('Fake#Pass123', saved.read_text())

    def test_copied_watchers_load_installed_helper(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            helper = root / 'home/.local/share/robob-watch/helpers'
            helper.mkdir(parents=True)
            shutil.copy2(ROOT / 'helpers/redact.py', helper / 'redact.py')
            env = dict(os.environ, HOME=str(root / 'home'))
            for rel in ['checks/inbox-triage/triage.py', 'checks/assist-offers/offers.py',
                        'checks/money-cases/cases.py', 'watchers/claude-ultra-5h-lift/check.py']:
                src = ROOT / rel
                scratch = root / 'scratch' / src.parent.name
                scratch.mkdir(parents=True, exist_ok=True)
                for code in src.parent.glob('*.py'):
                    shutil.copy2(code, scratch / code.name)
                if src.name == 'cases.py':
                    shutil.copy2(ROOT / 'helpers/robob_readonly.py', scratch / 'robob_readonly.py')
                (scratch / 'accounts.json').write_text('[]')
                script = ('import importlib.util,sys;spec=importlib.util.spec_from_file_location("scratch_module",sys.argv[1]);'
                          'm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);'
                          'print(m.redact_credentials("pass: Fake#Pass123") if hasattr(m,"redact_credentials") else m.redact("pass: Fake#Pass123"))')
                out = subprocess.run([sys.executable, '-c', script, str(scratch / src.name)], cwd=tmp,
                                     env={**env, 'WATCH_DIR': str(scratch)}, text=True, capture_output=True, timeout=10)
                self.assertEqual(out.returncode, 0, (rel, out.stderr))
                self.assertNotIn('Fake#Pass123', out.stdout)
                self.assertIn('[redacted]', out.stdout)
            scratch = root / 'scratch/activity-digest'
            scratch.mkdir()
            shutil.copy2(ROOT / 'watchers/activity-digest/summarize.py', scratch / 'summarize.py')
            out = subprocess.run([sys.executable, str(scratch / 'summarize.py'), str(root / 'digest.md')], cwd=tmp, env=env,
                                 input='- 2026-11-13 10:00 · password: Fake#Pass123 · note\n',
                                 text=True, capture_output=True, timeout=10)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertNotIn('Fake#Pass123', out.stdout)

    def test_activity_topics_sanitized_before_shortening(self):
        with tempfile.TemporaryDirectory() as temp:
            out = subprocess.run([sys.executable, str(ROOT / 'watchers/activity-digest/summarize.py'), str(Path(temp) / 'digest.md')],
                                 input='- 2026-11-13 10:00 · password: Fake#Pass123 · note\n',
                                 text=True, capture_output=True, timeout=5)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertNotIn('Fake#Pass123', out.stdout)


if __name__ == '__main__':
    unittest.main()
