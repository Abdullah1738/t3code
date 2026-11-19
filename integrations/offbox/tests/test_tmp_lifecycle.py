"""Drive the server entry points, with host mutations confined to the scratch boundary."""
from contextlib import ExitStack
import json
import subprocess
from unittest.mock import Mock, patch

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd


class ScratchLifecycle(Base):
    def setUp(self):
        super().setUp()
        self.host = Mock()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(boatd, 'scratch', return_value=self.host))
        self.stack.enter_context(patch.object(boatd, '_ensure_proxy'))
        self.stack.enter_context(patch.object(boatd, '_ensure_mgmt_proxy'))
        self.stack.enter_context(patch.object(boatd, '_fresh_identity'))
        self.stack.enter_context(patch.object(boatd, '_instance_bytes', return_value=0))
        self.workers = []
        workers = self.workers
        class DeferredThread:
            def __init__(self, target, args=(), kwargs=None, **unused):
                self.target, self.args, self.kwargs = target, args, kwargs or {}

            def start(self):
                workers.append(self)
        self.stack.enter_context(patch.object(boatd, 'threading', Mock(Thread=DeferredThread)))
        self.stack.enter_context(patch.object(boatd, 'disk_admit'))

    def run_workers(self):
        # Resume workers acquire the lifecycle lock after their caller returns.
        while self.workers:
            worker = self.workers.pop(0)
            worker.target(*worker.args, **worker.kwargs)

    def test_every_new_source_allocates_before_start_and_checks_mount(self):
        for index, source in enumerate((('image', 'offbox-base'), ('saved', 'sv-base'), ('box', 'bx_zzzzzzzz'))):
            bid = f'bx_aaaaaaa{index}'
            self.box(bid, state='provisioning', running=False)
            self.host.reset_mock()
            boatd.provision(bid, source, 'default')
            self.assertEqual([c[0] for c in self.host.method_calls], ['create', 'start', 'verify'])
            self.host.create.assert_called_once_with(bid, 'ardud')
            self.assertEqual(self.state(bid)['state'], 'ready')
            creates = [c for c in self.f.calls if c[0] in ('init', 'copy') and c[2] == boatd.ct(bid)]
            self.assertIn(f'user.offbox.provision={bid}', creates[0])

    def test_resume_and_recovery_start_but_live_resume_does_not_touch_scratch(self):
        bid = self.box(state='archived', running=False)
        boatd.resume_box(self.con, bid, {})
        self.assertEqual(self.state(bid)['state'], 'resuming')
        self.assertFalse(self.host.method_calls)
        self.run_workers()
        self.host.start.assert_called_once_with(bid)
        self.host.verify.assert_called_once_with(bid)
        self.host.reset_mock()
        boatd.resume_box(self.con, bid, {})
        self.assertFalse(self.workers)
        self.assertFalse(self.host.method_calls)
        self.host.reset_mock()
        boatd.start_container(bid)
        self.host.start.assert_called_once_with(bid)
        self.host.verify.assert_called_once_with(bid)

    def test_failed_provision_and_interrupted_provision_use_managed_delete(self):
        bid = self.box(state='provisioning', running=False)
        self.host.create.side_effect = RuntimeError('allocation failed')
        boatd.provision(bid, ('image', 'offbox-base'), 'default')
        self.host.delete.assert_called_once_with(bid, 'ardud')
        self.host.start.assert_not_called()
        self.assertEqual(self.state(bid)['state'], 'error')
        self.host.reset_mock()
        boatd.set_box(self.con, bid, state='provisioning')
        boatd.reconcile(self.con)
        self.host.delete.assert_called_once_with(bid, 'ardud')

    def test_delete_failure_keeps_database_row_for_cleanup_retry(self):
        bid = self.box(state='archived', running=False)
        self.host.delete.side_effect = RuntimeError('backing still referenced')
        with self.assertRaisesRegex(RuntimeError, 'still referenced'):
            boatd.delete_box(self.con, bid)
        self.assertIsNone(self.state(bid)['deleted_at'])
        self.host.delete.side_effect = None
        boatd.delete_box(self.con, bid)
        self.assertIsNotNone(self.state(bid)['deleted_at'])

    def test_saved_copy_drops_reference_before_publishing_ready(self):
        bid = self.box()
        boatd.save_box(self.con, bid, 'base', 'ardud')
        self.assertEqual(self.con.execute('SELECT status FROM saved WHERE name=?', ('base',)).fetchone()['status'],
                         'pending')
        self.run_workers()
        row = self.con.execute('SELECT * FROM saved WHERE name=?', ('base',)).fetchone()
        self.host.detach_copy.assert_called_once_with(row['instance'])
        self.assertEqual(row['status'], 'ready')

    def test_recovery_cleanup_failure_is_reported_without_blocking_other_boxes(self):
        bid = self.box(state='provisioning', running=False)
        self.host.delete.side_effect = RuntimeError('identity mismatch')
        boatd.reconcile(self.con)
        self.assertEqual(self.state(bid)['state'], 'error')
        self.assertIn('cleanup deferred: identity mismatch', self.state(bid)['error'])

    def test_failed_create_identity_guard_survives_reaping_and_explicit_delete(self):
        identities = ({}, {'user.offbox.provision': None}, {'user.offbox.provision': 'bx_otherbox'})
        for index, config in enumerate(identities):
            bid = self.box(f'bx_zzzzzzz{index}', state='provisioning', running=False)
            def foreign(*args, **kwargs):
                if args[0] == 'init':
                    raise RuntimeError('instance already exists')
                if args[0] == 'query':
                    value={'status':'Stopped'} if args[1].endswith('/state') else {'config':config}
                    return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
                self.fail(f'unexpected mutation of foreign instance: {args}')
            with self.subTest(config=config), patch.object(boatd, 'incus', side_effect=foreign):
                boatd.provision(bid, ('image', 'offbox-base'), 'default')
                boatd.reconcile(self.con)
                self.assertEqual(self.state(bid)['provision_identity'], 1)
                for state in ('error', 'archived'):
                    with self.subTest(state=state):
                        self.con.execute('UPDATE boxes SET state=?, updated_at=?, stopped_at=? WHERE id=?',
                                         (state, boatd.now() - 40 * 86400, boatd.now() - 40 * 86400, bid))
                        boatd.reap_once(self.con)
                        with self.assertRaisesRegex(boatd.Fail, 'refusing cleanup'):
                            boatd.delete_box(self.con, bid)
                        self.assertIsNone(self.state(bid)['deleted_at'])
                self.assertIn('refusing cleanup', self.state(bid)['error'])
            self.con.execute('UPDATE boxes SET updated_at=?, stopped_at=? WHERE id=?',
                             (boatd.now(), boatd.now(), bid))
        self.host.delete.assert_not_called()

    def test_instance_identity_query_error_prevents_deletion(self):
        bid = self.box(state='error', running=False)
        boatd.set_box(self.con, bid, provision_identity=1)
        for result in (subprocess.CompletedProcess([], 1, b'', b'connection failed'),
                       subprocess.CompletedProcess([], 0, b'not json', b'')):
            with self.subTest(result=result), patch.object(boatd, 'incus', return_value=result) as call:
                with self.assertRaises((boatd.Fail, ValueError)):
                    boatd.delete_box(self.con, bid)
                self.assertEqual([c.args[0] for c in call.call_args_list], ['query'])
                self.assertIsNone(self.state(bid)['deleted_at'])
        self.host.delete.assert_not_called()
