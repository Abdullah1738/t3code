"""Fake email fixtures exercise IDs through collection, classifier requests and wakes."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('assist_email_redact', ROOT / 'checks/assist-offers/offers.py')
o = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o)

SECRET = 'Fake#Pass123'
SUBJECTS = [
    'Browser Stack Email - qa.user@example.com pass - ' + SECRET,
    '**credentials:**\nqa@example.com\n' + SECRET,
    'pwd "fake pass 99"',
]


class EmailRedactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = time.time()
        self.real_classify = o.classify
        self.cfg = {'work_pattern': 'crpko|equicom', 'min_confidence': .5}
        for field in ['HOME', 'DATA', 'LIVE']:
            p = self.root / field.lower()
            p.mkdir()
            patcher = patch.object(o, field, p)
            patcher.start()
            self.addCleanup(patcher.stop)
        key = o.HOME / '.config/opencode/openrouter-key'
        key.parent.mkdir(parents=True)
        key.write_text('fake-test-api-key')

    def legacy_id(self, subject, account='icloud'):
        return f'mail:{account}:{o.norm_subject(subject).lower()[:120]}'

    def collect(self, subject, account='icloud'):
        row = dict(id=11, account=account, ts=self.now - 10, msgid='fake-message-id',
                   recipients='support@example.test', subject=subject,
                   body='Could you find availability for a family booking next Tuesday?')
        with patch.object(o, 'agent_mail_ids', return_value=set()), \
             patch.object(o, 'archive_query', side_effect=[[row], []]):
            return o.collect_email(None, self.now - 3600, self.now, self.cfg, None)

    def history(self, subject):
        legacy = self.legacy_id(subject)
        return [dict(conv=legacy, topic='availability booking', offer=subject,
                     at_ts=self.now - 100, key='old-key', who='QA')]

    def context(self, conversations, history):
        (o.DATA / 'offers.json').write_text(json.dumps({'offers': history}))
        with patch.object(o, 'money_cases_text', return_value=''), \
             patch.object(o, 'recent_activity', return_value=''):
            return o.build_context(conversations, [], self.now)

    def classify(self, conversations, context):
        requests = []
        def respond(request, **kwargs):
            serialized = json.loads(request.data)
            body = json.loads(serialized['messages'][1]['content'])
            requests.append(body)
            cid = body['conversations'][0]['conv']
            reply = dict(conv=cid, who='QA', doing='booking a family visit', offer='Want me to check availability?',
                         why='A slot needs finding', kind='research', topic='availability booking', confidence=.95)
            return io.StringIO(json.dumps({'choices': [{'message': {'content': json.dumps({'offers': [reply]})}}]}))
        with patch.object(o.urllib.request, 'urlopen', side_effect=respond):
            offers, meta = self.real_classify(conversations, context, 10)
        return offers, requests[0]

    def assert_safe(self, value):
        text = json.dumps(value).lower()
        self.assertNotIn(SECRET.lower(), text)
        self.assertNotIn('fake pass 99', text)

    def test_collection_through_request_and_previous_offers(self):
        for subject in SUBJECTS:
            with self.subTest(subject=subject):
                collected = self.collect(subject)
                conversations = collected['convs']
                cid = conversations[0]['conv']
                self.assertRegex(cid, r'^mail:opaque:[0-9a-f]{24}$')
                self.assert_safe(collected)
                history = self.history(subject)
                context = self.context(conversations, history)
                self.assertEqual(len(context['previous_offers']), 1)
                self.assertTrue(context['previous_offers'][0].startswith(cid + ':'))
                self.assert_safe(context)
                offers, payload = self.classify(conversations, context)
                self.assert_safe(payload)
                self.assertEqual(offers[0]['conv'], cid)
                self.assertTrue(o.already_offered(offers[0], history, self.now))
                self.assertEqual(o.offer_key(history[0]['conv'], offers[0]['topic']), o.offer_key(cid, offers[0]['topic']))
                self.assertEqual(o.offer_history()[0]['conv'], cid)
                for manual in [False, True]:
                    event = o.event_text('/tmp/fake-batch.json', offers, {}, manual)
                    self.assert_safe(event)
                    self.assertIn(cid, event)

    def test_stable_ids_preserve_account_reply_and_existing_grouping(self):
        subject = SUBJECTS[0]
        cid = self.collect(subject)['convs'][0]['conv']
        for related in [subject.lower(), 'Re: ' + subject, 'Fw: Re: ' + subject]:
            self.assertEqual(self.collect(related)['convs'][0]['conv'], cid)
        self.assertNotEqual(self.collect(subject, 'gmail')['convs'][0]['conv'], cid)
        self.assertNotEqual(self.collect(subject + ' changed')['convs'][0]['conv'], cid)
        long = 'Fixture subject ' * 20
        self.assertEqual(self.collect(long + 'a')['convs'][0]['conv'], self.collect(long + 'b')['convs'][0]['conv'])
        for other in ['wa:123@lid', 'imsg:7']:
            self.assertEqual(o.conversation_id(other), other)
        self.assertEqual(o.conversation_id(cid), cid)
        self.assertTrue(o.already_offered(dict(conv=cid, topic='availability booking', offer='new wording'),
                                         self.history(subject), self.now))

    def test_legacy_email_ids_are_opaque_at_classifier_and_wake_boundary(self):
        subject = SUBJECTS[0]
        conversations = self.collect(subject)['convs']
        conversations[0]['conv'] = self.legacy_id(subject)
        offers, payload = self.classify(conversations, self.context(conversations, self.history(subject)))
        self.assert_safe(payload)
        self.assertRegex(offers[0]['conv'], r'^mail:opaque:[0-9a-f]{24}$')
        legacy_offer = dict(offers[0], conv=self.legacy_id(subject))
        self.assert_safe(o.event_text('/tmp/fake-batch.json', [legacy_offer], {}))

    def test_run_reports_and_manual_wakes_use_opaque_collected_ids(self):
        for mode in ['dry', 'normal', 'manual']:
            with self.subTest(mode=mode):
                collected = self.collect(SUBJECTS[0])
                wd = self.root / ('watch-' + mode)
                wd.mkdir()
                (wd / 'state-offers.json').write_text(json.dumps({'cursors': {}, 'last_analysis_at': 0}))
                (o.DATA / 'offers.json').write_text('{"offers":[]}')
                args = types.SimpleNamespace(dry_run_hours=2 if mode == 'dry' else None, force=True, report=None)
                state = {'cursors': {}, 'last_analysis_at': 0, 'classifier_failures': o.CLASSIFIER_RETRIES - 1}
                (wd / 'state-offers.json').write_text(json.dumps(state))
                output = io.StringIO()
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'fake-run'}))
                    for name, value in [('settings', self.cfg), ('active_watchers', []), ('collect_all', ({'email': collected}, {})),
                                        ('recent_activity_lines', []), ('money_cases_raw', ''), ('money_cases_text', ''),
                                        ('recent_activity', ''), ('in_day_window', True)]:
                        stack.enter_context(patch.object(o, name, return_value=value))
                    stack.enter_context(patch.object(o, 'OcProbe', return_value=None))
                    def classify_run(convs, context, seconds):
                        if mode == 'manual':
                            raise ValueError('fake classifier failure')
                        offers, _ = self.classify(convs, context)
                        return offers, {}
                    stack.enter_context(patch.object(o, 'classify', side_effect=classify_run))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    self.assertEqual(o.run(args), 0)
                self.assert_safe(output.getvalue())
                self.assertIn('mail:opaque:', output.getvalue())
                for p in wd.rglob('*.json'):
                    self.assert_safe(json.loads(p.read_text()))


if __name__ == '__main__':
    unittest.main()
