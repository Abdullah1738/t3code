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
