"""Card masking at recall persistence boundaries, using isolated synthetic data."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from card_mask import mask_json_text, mask_text
from recall_hook_state import Store

PAN = '4111111111111111'
SECRET = PAN + ' CVV: 123 expiry: 12/25'
MASKED = '•••• 1111 CVV: ••• expiry: ••/••'


# All representations of the numeric-secret class share the ingest matrix.
PROJECTION_CASES = [
    ('exponent', '{"cvv":1.23e2}', {'cvv': '•••'}),
    ('integer', '{"cvv":123}', {'cvv': '•••'}),
    ('decimal', '{"cvv":123.0}', {'cvv': '•••'}),
    ('upper_exponent', '{"cvc":1.234E+3}', {'cvc': '•••'}),
    ('negative_exponent', '{"csc":12300e-2}', {'csc': '•••'}),
    ('nested', '{"fields":[{"cvn":1.23e2,"security code":123.0}]}',
     {'fields': [{'cvn': '•••', 'security code': '•••'}]}),
    ('pan_exponent', '{"number":4.111111111111111e15,"expiry":"12/25"}',
     {'number': '•••• 1111', 'expiry': '••/••'}),
    ('encoded_json', json.dumps({'arguments': '{"cvv":1.23e2}'}),
     {'arguments': '{"cvv": "•••"}'}),
]
PROJECTION_CASES = [
    (name, text[:-1] + ',"case":' + json.dumps(name) + ',"count":123,"ok":true}',
     dict(expected, case=name, count=123, ok=True))
    for name, text, expected in PROJECTION_CASES
]


class CardMaskCaptureTests(unittest.TestCase):
    def assert_masked(self, text):
        self.assertNotIn(PAN, text)
        self.assertNotIn('CVV: 123', text)
        self.assertNotIn('expiry: 12/25', text)
        self.assertIn('•••• 1111', text)

    def test_masker_copies_are_byte_identical(self):
        self.assertEqual((ROOT / 'src/card_mask.py').read_bytes(),
                         (ROOT.parent / 'harness-hooks/src/card_mask.py').read_bytes())

    def test_json_records_keep_types_and_escaped_text(self):
        original = {'sessionId': 'fixture', 'input': {'cvv': '123'}, 'count': 123, 'ok': True,
                    'output': json.dumps({'cvv': '•••'}), 'text': SECRET}
        masked = json.loads(mask_json_text(json.dumps(original)))
        self.assertEqual(masked['sessionId'], 'fixture')
        self.assertEqual(masked['input'], {'cvv': '•••'})
        self.assertEqual(masked['count'], 123)
        self.assertIs(masked['ok'], True)
        self.assertEqual(json.loads(masked['output']), {'cvv': '•••'})
        self.assertEqual(masked['text'], MASKED)

    def test_recall_numeric_secret_corpus(self):
        for pan in ['4111111111111111', '5555555555554444', '378282246310005']:
            for shape in [int(pan), {'number': int(pan)}, [int(pan)],
                          {'nested': [{'card_number': int(pan)}]}]:
                with self.subTest(pan=pan, shape=shape):
                    masked = mask_json_text(json.dumps(shape))
                    self.assertNotIn(pan, masked)
                    self.assertIn('•••• ' + pan[-4:], masked)
                    json.loads(masked)
        for label in ['cvc', 'CVV', 'csc', 'cvn', 'security code']:
            for number in [123, 1234, 123.0]:
                with self.subTest(label=label, number=number):
                    value = {'nested': [{label: number}], 'count': 123, 'ok': True,
                             'order_id': 1234567890123456, 'amount': 123.5}
                    expected = {**value, 'nested': [{label: '•••'}]}
                    self.assertEqual(json.loads(mask_json_text(json.dumps(value))), expected)
        self.assertEqual(json.loads(mask_json_text(json.dumps({'number': PAN, 'cvv': '123'}))),
                         {'number': '•••• 1111', 'cvv': '•••'})
        nested = json.dumps({'arguments': json.dumps({'number': int(PAN), 'cvv': 123})})
        result = json.loads(mask_json_text(nested))
        self.assertEqual(json.loads(result['arguments']), {'number': '•••• 1111', 'cvv': '•••'})
        self.assertEqual(json.loads(mask_json_text('{"cvv": 1.23e2}')), {'cvv': '•••'})

    def test_claude_ingest_masks_numeric_secrets_in_raw_and_projection(self):
        import test_sync_claude as fixture
        f = fixture.ClaudeSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        value = {'number': int(PAN), 'cvv': 123, 'expiry': '12/25', 'count': 123}
        fixture.write_lines(f.top, [fixture.rec('numeric-tool', 'assistant', '', block=[
            {'type': 'tool_use', 'id': 'numeric', 'name': 'Bash', 'input': value}])])
        f.sync()
        with sqlite3.connect(f.db) as db:
            raw = json.loads(db.execute('SELECT raw FROM native_capture_raw').fetchone()[0])
            self.assertEqual(raw['message']['content'][0]['input'],
                             {'number': '•••• 1111', 'cvv': '•••', 'expiry': '••/••', 'count': 123})
            for (content,) in db.execute('SELECT content FROM episodic_events'):
                self.assertNotIn(PAN, content)
                self.assertNotIn('"cvv": 123', content)

    def test_codex_ingest_masks_numeric_secrets_in_raw(self):
        import test_sync_codex as fixture
        f = fixture.CodexSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        value = {'number': int(PAN), 'cvv': 123, 'expiry': '12/25', 'count': 123}
        fixture.write_rollout(f.rollout, [fixture.meta(fixture.CHILD_ID, fixture.ROOT_ID),
            fixture.fcall('Bash', json.dumps(value), 'numeric')])
        f.sync()
        with sqlite3.connect(f.db) as db:
            rows = [json.loads(row[0]) for row in db.execute('SELECT raw FROM native_capture_raw')]
            call = next(r for r in rows if r.get('payload', {}).get('type') == 'function_call')
            self.assertEqual(json.loads(call['payload']['arguments']),
                             {'number': '•••• 1111', 'cvv': '•••', 'expiry': '••/••', 'count': 123})

    def test_opencode_ingest_masks_numeric_secrets_in_raw(self):
        import test_sync_opencode as fixture
        f = fixture.SyncOpencodeTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        value = {'number': int(PAN), 'cvv': 123, 'expiry': '12/25', 'count': 123}
        f.src.execute("UPDATE session_message SET data=? WHERE id='msg_u1'", (json.dumps(value),))
        f.src.commit()
        f.run_sync(f.load())
        with sqlite3.connect(f.raw_path) as db:
            raw = json.loads(zlib.decompress(db.execute('SELECT data_zlib FROM raw_messages').fetchone()[0]))
            self.assertEqual(raw, {'number': '•••• 1111', 'cvv': '•••', 'expiry': '••/••', 'count': 123})

    def test_muse_titles_mask_initial_and_late_metadata(self):
        import test_sync_muse as fixture
        for late in [False, True]:
            for source in ['robob', 'index']:
                with self.subTest(late=late, source=source):
                    f = fixture.MuseSyncTest()
                    f.setUp()
                    try:
                        fixture.write(f.main, fixture.main_log('S1'))
                        if late:
                            f.sync()
                            with sqlite3.connect(f.db) as db:
                                db.execute('UPDATE muse_sessions SET title=NULL')
                        title = SECRET if source == 'robob' else None
                        titles = {'S1': SECRET} if source == 'index' else {}
                        with patch.object(f.sm.Robob, 'describe', return_value=('fixture-thread', title, 'fixture-parent')), \
                                patch.object(f.sm, 'index_titles', return_value=titles):
                            stats = f.sync()
                        if late:
                            self.assertEqual(stats['changed'], 0)
                            self.assertEqual(stats['late_meta'], 1)
                        with sqlite3.connect(f.db) as db:
                            row = db.execute('SELECT title,parent_id,robob_thread_id FROM muse_sessions').fetchone()
                            self.assertEqual(row, (MASKED, 'fixture-parent', 'fixture-thread'))
                    finally:
                        f.tearDown()

    def assert_tool_projections(self, path, expected_rows, expected_payloads):
        expected = {value['case']: value for value in expected_payloads}
        with sqlite3.connect(path) as db:
            rows = db.execute("SELECT content_type,content FROM episodic_events "
                              "WHERE content_type IN ('tool_call','tool_result','error')").fetchall()
        self.assertEqual(len(rows), expected_rows)
        seen = set()
        for ctype, content in rows:
            if ctype == 'tool_call':
                name, content = content.split('\n', 1)
                self.assertEqual(name, 'fixture')
            for text in content.splitlines():
                text = text.removeprefix('[error] ')
                value = json.loads(text)
                self.assertEqual(value, expected[value['case']])
                seen.add(value['case'])
        self.assertEqual(seen, set(expected))

    def test_codex_numeric_tool_projection_matrix(self):
        import test_sync_codex as fixture
        f = fixture.CodexSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        records = [fixture.meta(fixture.CHILD_ID, fixture.ROOT_ID)]
        for name, text, _ in PROJECTION_CASES:
            for kind in ['function', 'custom_tool']:
                for form in [text, json.loads(text)]:
                    records.extend([
                        {'type': 'response_item', 'payload': {'type': kind + '_call', 'name': 'fixture',
                         'arguments' if kind == 'function' else 'input': form, 'call_id': name}},
                        {'type': 'response_item', 'payload': {'type': kind + '_call_output', 'output': form,
                         'call_id': name}},
                    ])
        fixture.write_rollout(f.rollout, records)
        f.sync()
        self.assert_tool_projections(f.db, len(PROJECTION_CASES) * 8, [v for _, _, v in PROJECTION_CASES])

    def test_claude_numeric_tool_projection_matrix(self):
        import test_sync_claude as fixture
        f = fixture.ClaudeSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        records = []
        for name, text, _ in PROJECTION_CASES:
            records.append(fixture.rec(name + '-call', 'assistant', '', block=[
                {'type': 'tool_use', 'id': name, 'name': 'fixture', 'input': json.loads(text)}]))
            for idx, content in enumerate([text, json.loads(text), [{'type': 'text', 'text': text}] * 2]):
                for error in [False, True]:
                    records.append(fixture.rec(name + f'-result-{idx}-{error}', 'user', '', block=[
                        {'type': 'tool_result', 'tool_use_id': name, 'content': content, 'is_error': error}]))
        fixture.write_lines(f.top, records)
        f.sync()
        self.assert_tool_projections(f.db, len(PROJECTION_CASES) * 7, [v for _, _, v in PROJECTION_CASES])

    def test_muse_numeric_tool_projection_matrix(self):
        import test_sync_muse as fixture
        f = fixture.MuseSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        records = fixture.main_log('S1')[:4]
        seq = 20
        for name, text, _ in PROJECTION_CASES:
            for form in [text, json.loads(text)]:
                records.extend([
                    fixture.run(seq, {'kind': 'assistant_tool_calls_committed',
                                     'tool_calls': [{'call_id': name, 'name': 'fixture', 'args': form}]}, 'S1'),
                    fixture.run(seq + 1, {'kind': 'tool_result_batch_committed',
                                         'results': [{'tool_call_id': name, 'text': form}]}, 'S1'),
                ])
                seq += 2
        fixture.write(f.main, records)
        f.sync()
        self.assert_tool_projections(f.db, len(PROJECTION_CASES) * 4, [v for _, _, v in PROJECTION_CASES])

    def test_opencode_numeric_tool_projection_matrix(self):
        import test_sync_opencode as fixture
        f = fixture.SyncOpencodeTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        tools = []
        for name, text, _ in PROJECTION_CASES:
            for form in [text, json.loads(text)]:
                tools.append({'type': 'tool', 'id': name, 'name': 'fixture', 'state': {
                    'status': 'completed', 'input': form,
                    'content': [{'type': 'text', 'text': text}] * 2, 'error': form}})
        data = {'content': tools, 'time': {'completed': fixture.NOW - 20000}}
        f.src.execute("INSERT INTO session_message VALUES ('numeric','ses_a','assistant',2,?,?,?)",
                      (fixture.NOW - 30000, fixture.NOW - 20000, json.dumps(data)))
        f.src.commit()
        f.run_sync(f.load())
        self.assert_tool_projections(f.mem_path, len(PROJECTION_CASES) * 4, [v for _, _, v in PROJECTION_CASES])

    def test_recall_hook_masks_persisted_task_before_clipping(self):
        spec = importlib.util.spec_from_file_location('card_mask_recall_hook', ROOT / 'hooks/recall_hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'state.db')
            with patch.dict(os.environ, RECALL_HOOK_STATE=path), \
                    patch.object(hook, 'config', return_value={'mode': 'on'}), \
                    patch.object(hook, 'native_key', return_value='fixture'), \
                    patch.object(hook, 'first_transcript', return_value=True), \
                    patch.object(hook, 'resolve', return_value=None):
                hook.handle('claude', {'hook_event_name': 'UserPromptSubmit', 'prompt': SECRET,
                                      'tool_input': {'text': SECRET}, 'tool_response': SECRET})
            db = Store(path)
            self.addCleanup(db.close)
            self.assertEqual(db.get('fixture')['task'], MASKED)
            # Older activity buffers and pending notes can also flow through save.
            state = db.get('fixture')
            state['activity'] = [{'input': SECRET, 'result': SECRET}]
            db.save('fixture', state)
            for item in db.get('fixture')['activity']:
                self.assertEqual(item, {'input': MASKED, 'result': MASKED})

    def test_recall_hook_masks_raw_tool_input_before_parallel_check(self):
        spec = importlib.util.spec_from_file_location('card_mask_recall_hook', ROOT / 'hooks/recall_hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        with patch.object(hook, 'config', return_value={'mode': 'on'}), \
                patch('recall_local.preflight', return_value=([], None)) as preflight, \
                patch('recall_local.local_note', return_value=None), patch.object(hook, 'log'), \
                patch.dict(os.environ, RECALL_DECISION_LOG=os.devnull):
            hook.handle('codex', {'hook_event_name': 'PreToolUse', 'tool_name': 'fixture',
                                 'tool_input': {'text': SECRET}})
        self.assertEqual(preflight.call_args.args[1], {'text': MASKED})

    def test_recall_hook_and_state_mask_numeric_activity(self):
        spec = importlib.util.spec_from_file_location('card_mask_recall_hook', ROOT / 'hooks/recall_hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        value = {'number': int(PAN), 'cvv': 123, 'expiry': '12/25', 'count': 123}
        expected = {'number': '•••• 1111', 'cvv': '•••', 'expiry': '••/••', 'count': 123}
        with patch.object(hook, 'config', return_value={'mode': 'on'}), \
                patch('recall_local.preflight', return_value=([], None)) as preflight, \
                patch('recall_local.local_note', return_value=None), patch.object(hook, 'log'), \
                patch.dict(os.environ, RECALL_DECISION_LOG=os.devnull):
            hook.handle('claude', {'hook_event_name': 'PreToolUse', 'tool_name': 'fixture', 'tool_input': value})
        self.assertEqual(preflight.call_args.args[1], expected)
        with tempfile.TemporaryDirectory() as directory:
            db = Store(str(Path(directory) / 'state.db'))
            try:
                state = db.get('fixture')
                state['activity'] = [{'input': value, 'result': value}]
                db.save('fixture', state)
                self.assertEqual(db.get('fixture')['activity'], [{'input': expected, 'result': expected}])
            finally:
                db.close()

    def test_claude_ingest_masks_projection_and_raw_tool_input(self):
        import test_sync_claude as fixture
        f = fixture.ClaudeSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        fixture.write_lines(f.top, [fixture.rec('tool-call', 'assistant', '', block=[
            {'type': 'tool_use', 'id': 'call1', 'name': 'Bash', 'input': {'command': SECRET}}]),
            fixture.rec('tool-result', 'user', '', block=[
            {'type': 'tool_result', 'tool_use_id': 'call1', 'content': SECRET}])])
        f.sync()
        with sqlite3.connect(f.db) as db:
            rows = db.execute('SELECT content,metadata_json FROM episodic_events').fetchall()
            self.assertEqual(len(rows), 2)
            for content, metadata in rows:
                self.assert_masked(content)
                self.assertNotIn(PAN, metadata)
            for (raw,) in db.execute('SELECT raw FROM native_capture_raw'):
                self.assert_masked(raw.decode())
                json.loads(raw)

    def test_codex_ingest_masks_projection_and_raw_tool_input(self):
        import test_sync_codex as fixture
        f = fixture.CodexSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        fixture.write_rollout(f.rollout, [fixture.meta(fixture.CHILD_ID, fixture.ROOT_ID),
            fixture.fcall('Bash', json.dumps({'command': SECRET}), 'call1'), fixture.fout('call1', SECRET)])
        f.sync()
        with sqlite3.connect(f.db) as db:
            rows = db.execute('SELECT content,metadata_json FROM episodic_events').fetchall()
            self.assertEqual(len(rows), 2)
            for content, metadata in rows:
                self.assert_masked(content)
                self.assertNotIn(PAN, metadata)
            raw = '\n'.join(row[0].decode() for row in db.execute('SELECT raw FROM native_capture_raw'))
            self.assert_masked(raw)

    def test_opencode_ingest_masks_projection_and_compressed_raw(self):
        import test_sync_opencode as fixture
        f = fixture.SyncOpencodeTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        data = json.dumps({'text': SECRET})
        f.src.execute("UPDATE session_message SET data=? WHERE id='msg_u1'", (data,))
        f.src.commit()
        s = f.load()
        f.run_sync(s)
        with sqlite3.connect(f.mem_path) as db:
            rows = db.execute('SELECT content FROM episodic_events').fetchall()
            self.assertTrue(rows)
            for (content,) in rows:
                self.assert_masked(content)
        with sqlite3.connect(f.raw_path) as db:
            rows = db.execute('SELECT raw_size,data_zlib FROM raw_messages').fetchall()
            self.assertTrue(rows)
            for size, blob in rows:
                raw = zlib.decompress(blob)
                self.assertEqual(size, len(raw))
                self.assert_masked(raw.decode())
                json.loads(raw)

    def test_muse_ingest_masks_tool_text_and_checkpoint_state(self):
        import test_sync_muse as fixture
        f = fixture.MuseSyncTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        records = fixture.main_log('S1')
        for record in records:
            payload = record.get('payload', {})
            event = payload.get('event', {})
            for call in event.get('tool_calls', []):
                call['args'] = json.dumps({'command': SECRET})
            for result in event.get('results', []):
                result['text'] = SECRET
        fixture.write(f.main, records)
        f.sync()
        with sqlite3.connect(f.db) as db:
            rows = db.execute("SELECT content FROM episodic_events WHERE content_type IN ('tool_call','tool_result')").fetchall()
            self.assertEqual(len(rows), 2)
            for (content,) in rows:
                self.assert_masked(content)
            for (state,) in db.execute('SELECT state_json FROM muse_sync_files'):
                self.assertNotIn(PAN, state)


if __name__ == '__main__':
    unittest.main()
