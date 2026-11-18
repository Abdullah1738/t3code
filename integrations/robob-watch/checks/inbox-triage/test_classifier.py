"""Offline reply validation; fixture keys and HTTP stubs never reach a provider."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import io
import json
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_triage import t


class ClassifierReplyTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(t, 'HOME', self.root))
        key = self.root / '.config/opencode/openrouter-key'
        key.parent.mkdir(parents=True)
        key.write_text('offline-fixture-key')
        self.stack.enter_context(patch.dict(os.environ, ROBOB_TEST='1', TOOLLOG_DIR=str(self.root / 'logs')))
        self.stack.enter_context(patch.object(t.subprocess, 'run', side_effect=AssertionError('no subprocesses')))
        self.http = self.stack.enter_context(patch.object(t.urllib.request, 'urlopen'))
        self.items = [{'id': 'imsg:fixture', 'source': 'imessage', 'sender': 'Fixture', 'subject': '',
                       'preview': 'Fixture update', 'ts': 1234.0}]

    def reply(self, parsed=None):
        return {'model': t.MODEL, 'choices': [{'finish_reason': 'length',
                'message': {'content': json.dumps({'hits': []} if parsed is None else parsed)}}],
                'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'cost': None}}

    def run_reply(self, reply):
        self.http.return_value = io.BytesIO(json.dumps(reply).encode())
        return t.classify_batch(self.items, {})

    def reject(self, reply, message):
        before = self.http.call_count
        hits, meta = self.run_reply(reply)
        self.assertEqual(self.http.call_count - before, 1)
        self.assertEqual([hit['id'] for hit in hits], [self.items[0]['id']])
        self.assertEqual(hits[0]['reason'], 'Classifier unavailable; manually review')
        self.assertIn('ValueError: classifier ' + message, meta['classifier_error'])
        self.assertIn('(finish_reason=length)', meta['classifier_error'])
        self.assertRegex(meta['classifier_error'], r'; at classify:\d+; endpoint=' +
                         re.escape(t.CLASSIFIER_ENDPOINT) + r'; elapsed_ms=\d+; attempts=1$')
        self.assertEqual(meta['classifier_attempts'], 1)
        self.assertEqual(meta['classifier_causes'][0]['cause'], meta['classifier_error'].split('; endpoint=')[0])
        rows = [json.loads(line) for path in (self.root / 'logs').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        row = [row for row in rows if row['name'] == 'triage.classify'][-1]
        self.assertFalse(row['ok'])
        self.assertEqual(row['props']['classifier_error'], meta['classifier_error'])

    def test_valid_reply_and_optional_usage_defaults(self):
        for usage in ({'prompt_tokens': 2, 'completion_tokens': 3, 'cost': None}, {},
                      {'prompt_tokens': 2, 'completion_tokens': 3, 'cost': 0.25}):
            with self.subTest(usage=usage):
                reply = self.reply({'hits': [{'id': 'imsg:fixture', 'reason': 'Fixture update', 'urgency': 'info'}]})
                reply['usage'] = usage
                hits, meta = self.run_reply(reply)
                self.assertEqual(len(hits), 1)
                self.assertNotIn('classifier_error', meta)
                self.assertEqual(meta['cost_usd'], usage.get('cost') if usage.get('cost') is not None else
                                 usage.get('prompt_tokens', 0) * t.INPUT_USD + usage.get('completion_tokens', 0) * t.OUTPUT_USD)

    def test_null_or_nonstring_content(self):
        for value in (None, [], {}, 1, True):
            with self.subTest(shape=type(value).__name__):
                reply = self.reply()
                reply['choices'][0]['message']['content'] = value
                self.reject(reply, 'content not a string')

    def test_null_or_nonobject_usage(self):
        for value in (None, [], 'invalid', 1, True):
            with self.subTest(shape=type(value).__name__):
                reply = self.reply()
                reply['usage'] = value
                self.reject(reply, 'usage not an object')

    def test_null_or_nonnumeric_token_counts(self):
        for field in ('prompt_tokens', 'completion_tokens'):
            for value in (None, [], {}, '2', True, -1, float('nan'), float('inf'), 10 ** 400):
                with self.subTest(field=field, shape=type(value).__name__):
                    reply = self.reply()
                    reply['usage'][field] = value
                    self.reject(reply, 'usage.' + field + ' not a nonnegative finite number')

    def test_invalid_cost(self):
        for value in ([], {}, '2', True, -1, float('nan'), float('inf')):
            with self.subTest(shape=type(value).__name__):
                reply = self.reply()
                reply['usage']['cost'] = value
                self.reject(reply, 'usage.cost not a nonnegative finite number')

    def test_list_or_dict_hit_id_and_other_nonstrings(self):
        for value in ([], {}, None, 1, True):
            with self.subTest(shape=type(value).__name__):
                self.reject(self.reply({'hits': [{'id': value, 'reason': 'Fixture', 'urgency': 'info'}]}),
                            'hit id not a string')

    def test_parsed_reply_not_an_object(self):
        for value in ('null', '[]', '"invalid"', '1', 'true'):
            with self.subTest(shape=value):
                reply = self.reply()
                reply['choices'][0]['message']['content'] = value
                self.reject(reply, 'parsed response not an object')

    def test_hit_not_an_object(self):
        for value in (None, [], 'invalid', 1, True):
            with self.subTest(shape=type(value).__name__):
                self.reject(self.reply({'hits': [value]}), 'hit not an object')

    def test_missing_or_nonarray_hits(self):
        for parsed in ({}, {'hits': None}, {'hits': {}}, {'hits': 'invalid'}):
            with self.subTest(parsed=parsed):
                self.reject(self.reply(parsed), 'response missing hits array')

    def test_malformed_content_json(self):
        reply = self.reply()
        reply['choices'][0]['message']['content'] = '{'
        self.reject(reply, 'content not valid JSON')

    def test_malformed_envelope(self):
        for reply, message in ((None, 'response not an object'), ([], 'response not an object'),
                               ({}, 'response missing choice object'), ({'choices': []}, 'response missing choice object'),
                               ({'choices': [None]}, 'response missing choice object')):
            with self.subTest(reply=reply):
                _, meta = self.run_reply(reply)
                self.assertIn('ValueError: classifier ' + message, meta['classifier_error'])

    def test_nonobject_message(self):
        for value in (None, [], 'invalid', 1, True):
            with self.subTest(shape=type(value).__name__):
                reply = self.reply()
                reply['choices'][0]['message'] = value
                self.reject(reply, 'message not an object')

    def test_finish_reason_is_optional_and_cleaned(self):
        for reason, expected in ((None, 'null'), ('length', 'length'), ('stop', 'stop')):
            with self.subTest(reason=reason):
                reply = self.reply()
                reply['choices'][0].update(finish_reason=reason, message={'content': None})
                _, meta = self.run_reply(reply)
                self.assertIn('(finish_reason=' + expected + ')', meta['classifier_error'])
        reply = self.reply()
        del reply['choices'][0]['finish_reason']
        reply['choices'][0]['message']['content'] = None
        _, meta = self.run_reply(reply)
        self.assertNotIn('finish_reason=', meta['classifier_error'])

    def test_deadline_keeps_retry_cause_and_attempt_metadata(self):
        self.http.side_effect = t.ClassifierDeadline()
        hits, meta = t.classify_batch(self.items, {})
        self.assertTrue(meta['classifier_error'].startswith('deadline; endpoint=' + t.CLASSIFIER_ENDPOINT))
        self.assertTrue(meta['classifier_error'].endswith('; attempts=2'))
        self.assertEqual(meta['classifier_attempts'], 2)
        self.assertEqual([cause['cause'] for cause in meta['classifier_causes']], ['deadline', 'deadline'])
        self.assertEqual(len(hits), 1)
        self.assertEqual(self.http.call_count, 2)
        self.assertEqual(t.signal.getitimer(t.signal.ITIMER_REAL), (0.0, 0.0))

    def test_socket_timeout_keeps_retry_cause_and_failure_event(self):
        self.http.side_effect = TimeoutError('fixture socket timed out')
        with patch.object(t, 'log_failure') as log:
            _, meta = t.classify_batch(self.items, {})
        log.assert_called_once_with('classifier.failed')
        self.assertTrue(meta['classifier_error'].startswith('socket_timeout; endpoint=' + t.CLASSIFIER_ENDPOINT))
        self.assertTrue(meta['classifier_error'].endswith('; attempts=2'))
        self.assertEqual(meta['classifier_attempts'], 2)
        self.assertEqual([cause['cause'] for cause in meta['classifier_causes']], ['socket_timeout', 'socket_timeout'])
        self.assertEqual(self.http.call_count, 2)

    def test_validation_after_transient_failure_stops_and_retains_both_causes(self):
        reply = self.reply()
        reply['choices'][0]['message']['content'] = None
        self.http.side_effect = [TimeoutError(), io.BytesIO(json.dumps(reply).encode())]
        hits, meta = t.classify_batch(self.items, {})
        self.assertEqual(self.http.call_count, 2)
        self.assertEqual(meta['classifier_attempts'], 2)
        self.assertEqual(meta['classifier_causes'][0]['cause'], 'socket_timeout')
        self.assertTrue(meta['classifier_causes'][1]['cause'].startswith(
            'ValueError: classifier content not a string (finish_reason=length); at classify:'))
        self.assertEqual(meta['classifier_error'].split('; endpoint=')[0], meta['classifier_causes'][1]['cause'])
        self.assertTrue(meta['classifier_error'].endswith('; attempts=2'))
        self.assertIsNone(meta['cost_usd'])
        self.assertEqual(len(hits), 1)
        rows = [json.loads(line) for path in (self.root / 'logs').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        self.assertEqual([row for row in rows if row['name'] == 'triage.classify'][-1]['props']['classifier_error'],
                         meta['classifier_error'])

    def test_forced_typeerror_retains_clean_message_and_innermost_frame(self):
        self.http.side_effect = TypeError('fixture decode failed\x00 password=FixtureSecret89 OTP 123456 https://fixture.invalid/private ' + 'x' * 200)
        _, meta = t.classify_batch(self.items, {})
        error = meta['classifier_error']
        self.assertTrue(error.startswith('TypeError: fixture decode failed'))
        self.assertRegex(error, r'; at classify:\d+; endpoint=' + re.escape(t.CLASSIFIER_ENDPOINT) +
                         r'; elapsed_ms=\d+; attempts=1$')
        self.assertEqual(meta['classifier_attempts'], 1)
        self.assertLessEqual(len(error.split('; at ')[0].removeprefix('TypeError: ')), 160)
        for value in ('FixtureSecret89', '123456', 'fixture.invalid', '\x00'):
            self.assertNotIn(value, error)
        self.http.assert_called_once()


if __name__ == '__main__':
    unittest.main()
