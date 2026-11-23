"""Bring-up failures retain their box evidence when no command was accepted."""
import contextlib
import io
import json
import os
from unittest.mock import patch

from test_capacity import Isolated
from offbox_lib import api, cli, common, home, runs


class BoxErrorTests(Isolated):
    def test_cleanup_pending_keeps_each_failure_class_and_does_not_wait(self):
        with patch.dict(os.environ, OFFBOX_BACKEND='server'):
            for code in (*sorted(api.BOX_BOOT_CODES), 'future_start_failure'):
                for since in (None, 1794787200, 1794787300):
                    with self.subTest(code=code, since=since):
                        view = {'state': 'stopping', 'error': f'500 {code}: start failed',
                                'startError': {'class': code, 'cleanup': 'unknown'},
                                'updatedAt': '2026-11-16T00:00:01Z'}
                        with patch.object(api, 'readiness_get', return_value=view) as get, \
                                patch.object(api.time, 'sleep', side_effect=AssertionError('failure must be immediate')):
                            with self.assertRaises(api.BoxBootFailed) as cm:
                                api.wait_state('bx_pending', ('ready',), since=since)
                        get.assert_called_once()
                        self.assertEqual(cm.exception.api_code, code)
                        self.assertEqual(cm.exception.box_error, {'box_id': 'bx_pending', 'error': view['error']})

    def test_ordinary_stopping_without_a_failure_marker_is_not_a_failed_start(self):
        for failure in (None, {}, {'cleanup': 'unknown'}, 'invalid'):
            with self.subTest(failure=failure):
                view = {'state': 'stopping', 'error': '500 boot_timeout: old error', 'startError': failure}
                self.assertFalse(api.start_failure_pending(view))
                self.assertIsNone(api.box_boot_failure('bx_pending', view))

    def test_pending_generic_failure_persists_in_foreground_and_background(self):
        for code in ('boot_timeout', 'incus_failed'):
            for background in (False, True):
                with self.subTest(code=code, background=background), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, OFFBOX_BACKEND='server'))
                    if background:
                        stack.enter_context(patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: common.new_id('run')}))
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    view = {'state': 'stopping', 'error': f'500 {code}: boot failed; stop unconfirmed',
                            'startError': {'class': code, 'cleanup': 'unknown'},
                            'updatedAt': '2026-11-16T00:00:01Z'}
                    stack.enter_context(patch.object(api, 'readiness_get', return_value=view))
                    stack.enter_context(patch.object(api.time, 'sleep', side_effect=AssertionError('must not wait')))
                    ids = []
                    def start(runner):
                        ids.append(runner.run_id)
                        api.wait_state('bx_pending', ('ready',), since=1794787200)
                    stack.enter_context(patch.object(runs.Runner, 'start', start))
                    args = cli.build_parser().parse_args(['run', '--remote', '--', 'true'])
                    self.assertEqual(cli.cmd_run(args, self.me), common.EXIT_INFRA)
                    state = runs.read_json(runs.LOGS_DIR / f'{ids[0]}.state.json', {})
                    self.assertIs(state['infra_failure'], True)
                    self.assertEqual(state['infra_reason'], 'box_error')
                    self.assertEqual(state['box_error'], {'box_id': 'bx_pending', 'error': view['error']})

    def test_typed_stopped_or_cleanup_pending_failure_is_immediate_and_recorded_once(self):
        with patch.dict(os.environ, OFFBOX_BACKEND='server', OFFBOX_BACKGROUND_RUN='run-slow'):
            for state in ('archived', 'stopping'):
                with self.subTest(state=state):
                    view = {'state': state, 'error': '503 incus_slow: config.device.add exceeded 120s',
                            'startError': {'class': 'incus_slow'}, 'updatedAt': '2026-11-16T00:00:01Z'}
                    with patch.object(api, 'readiness_get', return_value=view), \
                            patch.object(api.time, 'sleep', side_effect=AssertionError('failure must be immediate')):
                        with self.assertRaises(api.BoxBootFailed) as cm:
                            api.wait_state('bx_slow', ('ready',), since=1794787200)
                    self.assertEqual(cm.exception.api_code, 'incus_slow')
                    home.record_box_failure(cm.exception)
            records = [json.loads(line) for line in common.HOME_FAILURES.read_text().splitlines()]
            self.assertEqual(len(records), 2)
            self.assertTrue(all(row['class'] == 'incus_slow' for row in records))

    def test_precommand_error_persists_for_foreground_and_background_and_survives_logs_read(self):
        for background in (False, True):
            for typed in (False, True):
                with self.subTest(background=background, typed=typed), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, OFFBOX_BACKEND='server'))
                    if background:
                        stack.enter_context(patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: common.new_id('run')}))
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    ids = []
                    text = '503 incus_slow: config.device.set exceeded 120s' if typed else 'server refused box start'
                    error = api.BoxBootFailed('bx_slow', 'archived', text, 503, 'incus_slow') if typed else common.OffboxError(text)
                    error.box_error = {'box_id': 'bx_slow', 'error': text}
                    def start(runner):
                        ids.append(runner.run_id)
                        home.record_box_failure(error)
                        # Fresh allocation can wrap the typed failure before it reaches run_remote.
                        raise common.OffboxError('allocation failed') from error
                    stack.enter_context(patch.object(runs.Runner, 'start', start))
                    args = cli.build_parser().parse_args(['run', '--remote', '--', 'true'])
                    self.assertEqual(cli.cmd_run(args, self.me), common.EXIT_INFRA)
                    state = runs.read_json(runs.LOGS_DIR / f'{ids[0]}.state.json', {})
                    self.assertIs(state['infra_failure'], True)
                    self.assertEqual(state['infra_reason'], 'box_error')
                    self.assertEqual(state['box_error'], {'box_id': 'bx_slow', 'error': text})
                    self.assertEqual(runs.space_result(ids[0], common.EXIT_INFRA), common.EXIT_INFRA)
                    self.assertEqual(runs.read_json(runs.LOGS_DIR / f'{ids[0]}.state.json', {})['box_error'], state['box_error'])
                    if typed:
                        records = [json.loads(line) for line in common.HOME_FAILURES.read_text().splitlines()]
                        self.assertEqual(records[-1]['run'], ids[0])

    def test_log_sanitizer_keeps_box_error_reason(self):
        import toollog
        self.assertEqual(toollog._props({'infra_reason': 'box_error'}), {'infra_reason': 'box_error'})
