"""Both hook consumers keep their own event, once per guard decision."""
if __package__:
    from . import test_environment
else:
    import test_environment

import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import engine


class BoardLoggingCoexistence(unittest.TestCase):
    def setUp(self):
        sampling = patch.object(engine.toollog.random, 'random', return_value=0)
        sampling.start()
        self.addCleanup(sampling.stop)

    def test_each_guard_decision_reaches_each_board_once(self):
        heavy = {'heavy': True, 'rule': 'go-test', 'class': 'go-test', 'size': 'large',
                 'why': 'fixture', 'rewrite': 'offbox run -- go test ./...'}
        cases = [
            ('observe', heavy, False, False, 'allow', 'allowed', True),
            ('enforce', heavy, False, False, 'deny', 'denied', True),
            ('enforce', {'heavy': False}, False, False, 'allow', 'allowed', True),
            ('off', heavy, False, False, 'allow', 'allowed', True),
            ('enforce', heavy, True, False, 'allow', 'local-override', True),
            ('observe', RuntimeError('private-classifier-body'), False, False, 'allow', 'allowed', False),
            ('enforce', heavy, False, True, 'allow', 'allowed', False),
        ]
        with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as stack:
            root = Path(temp)
            stack.enter_context(patch.dict(os.environ, {
                'TOOLLOG_ROOT': str(root/'logs'), 'OFFBOX_TOOL_LOG_DIR': str(root/'logs/offbox'),
                'HARNESS_HOOKS_STATE_DIR': str(root/'state'), 'HARNESS_HOOKS_COMMAND_IDENTITY': '',

            }))
            stack.enter_context(patch.object(engine, 'resolve_identity', return_value={
                'resolution': 'resolved', 'robobThreadId': 'thread-fixture'}))
            stack.enter_context(patch.object(engine, '_command_identity', return_value=None))
            stack.enter_context(patch.object(engine, '_offbox_available', return_value=True))
            stack.enter_context(patch.object(engine, '_offbox_state', return_value=root/'offbox-state'))

            def records(board):
                return [json.loads(line) for path in (root/'logs'/board).glob('*.ndjson')
                        for line in path.read_text().splitlines()]

            for mode, verdict, exempt, fail_denial, decision, offbox_decision, ok in cases:
                with self.subTest(mode=mode, verdict=type(verdict).__name__):
                    before = {board: len(records(board)) for board in ('agent-tools', 'offbox')}
                    classifier = patch.object(engine, '_classify_offbox',
                        **({'side_effect': verdict} if isinstance(verdict, Exception) else {'return_value': verdict}))
                    with contextlib.ExitStack() as case:
                        case.enter_context(patch.object(engine, '_offbox_mode', return_value=mode))
                        case.enter_context(patch.object(engine, '_exempt', return_value=exempt))
                        case.enter_context(classifier)
                        if fail_denial:
                            case.enter_context(patch.object(engine, '_offbox_denial', side_effect=RuntimeError('private-rewrite-body')))
                        result = engine.decide({'hook_event_name': 'PreToolUse', 'tool_name': 'exec_command',
                            'session_id': '11111111-2222-3333-4444-555555555555', 'cwd': temp,
                            'tool_input': {'cmd': 'go test ./... -run PrivateFixtureArgument'}}, 'codex')
                    self.assertEqual(result['decision'], decision)
                    for board, event_name in [('agent-tools', 'hook.decision'), ('offbox', 'gate.decision')]:
                        emitted = records(board)[before[board]:]
                        self.assertEqual(len(emitted), 1, (board, emitted))
                        self.assertEqual(emitted[0]['tool'], board)
                        self.assertEqual(emitted[0]['name'], event_name)
                        self.assertRegex(emitted[0]['ts'], r'\.\d{3}Z$')
                        self.assertNotIn('PrivateFixtureArgument', json.dumps(emitted))
                        self.assertNotIn('private-classifier-body', json.dumps(emitted))
                        self.assertNotIn('private-rewrite-body', json.dumps(emitted))
                        if board == 'offbox':
                            self.assertEqual(emitted[0]['props']['decision'], offbox_decision)
                            self.assertEqual(emitted[0]['ok'], ok)
            for board, event_name in [('agent-tools', 'hook.decision'), ('offbox', 'gate.decision')]:
                day = next((root/'logs'/board).glob('*.ndjson')).stem
                summary = engine.toollog.rollup(board, day)
                expected = sum(engine.toollog._sample_rate(row) for row in records(board))
                self.assertEqual(summary['recordedRows'], len(cases))
                self.assertEqual(summary['total'], expected)
                self.assertEqual(summary['countsByName'], {event_name: expected})
