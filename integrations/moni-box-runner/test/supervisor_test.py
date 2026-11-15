import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
from contextlib import nullcontext

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).resolve().parents[1] / 'supervisor.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Child:
    def __init__(self): self.stopped = False
    def terminate(self): self.stopped = True
    def wait(self, timeout): return 0
    def poll(self): return 0 if self.stopped else None

class Deps:
    def __init__(self):
        self.events = []; self.stopped = True; self.enabled = True; self.fail = False; self.resume_pending = False
    def active(self): return self.enabled
    def ensure(self, box):
        self.events.append(('ensure', box))
        if self.resume_pending: self.events.append(('confirm', box))
        elif self.stopped: self.events.append(('resume', box))
        self.stopped = False
    def setup(self, box): self.events.append(('ssh-setup', box))
    def runner_ready(self, box): self.events.append(('runner-ready', box))
    def tunnel(self, box, reverse):
        self.events.append(('reverse' if reverse else 'forward', box))
        if self.fail and reverse: raise RuntimeError('failed')
        return Child()
    def both_ready(self): self.events.append(('both-ready', None))

class Tests(unittest.TestCase):
    def test_stopped_box_recovery_never_allocates(self):
        deps = Deps(); supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps)
        self.assertTrue(supervisor.connect())
        self.assertEqual(deps.events, [('ensure', 'bx_moni'), ('resume', 'bx_moni'), ('ssh-setup', 'bx_moni'), ('runner-ready', 'bx_moni'), ('forward', 'bx_moni'), ('reverse', 'bx_moni'), ('both-ready', None)])
        deps.stopped = True
        self.assertTrue(supervisor.connect())
        self.assertEqual(set(box for _, box in deps.events if box), {'bx_moni'})
        self.assertFalse(any(name in ('create', 'fork', 'acquire') for name, _ in deps.events))
    def test_partial_connection_never_declares_ready(self):
        deps = Deps(); deps.fail = True; supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps)
        with self.assertRaises(RuntimeError): supervisor.connect()
        self.assertNotIn(('both-ready', None), deps.events)
        self.assertEqual(supervisor.children, [])
    def test_pending_resume_is_confirmed_and_rollback_disables_connections(self):
        deps = Deps(); deps.resume_pending = True; supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps)
        self.assertTrue(supervisor.connect()); self.assertIn(('confirm', 'bx_moni'), deps.events)
        deps.enabled = False
        self.assertFalse(supervisor.connect()); self.assertEqual(supervisor.children, [])

class ColdStartupTests(unittest.TestCase):
    def test_readiness_retries_while_tunnels_remain_alive(self):
        deps = Deps(); attempts = []; children = []
        original = deps.tunnel
        def tunnel(box, reverse):
            child = original(box, reverse); children.append(child); return child
        def ready():
            self.assertTrue(all(not child.stopped for child in children))
            attempts.append(True)
            if len(attempts) < 3: raise ConnectionRefusedError()
        deps.tunnel = tunnel; deps.both_ready = ready
        clock = [0.0]
        supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=lambda: clock[0], sleep=lambda dt: clock.__setitem__(0, clock[0] + dt))
        self.assertTrue(supervisor.connect()); self.assertEqual(len(attempts), 3)
        self.assertTrue(all(not child.stopped for child in children))

class ExactBoxTests(unittest.TestCase):
    def test_production_ensure_resumes_only_the_bound_box(self):
        events = []
        states = iter([{'state': 'archived', 'owner': 'moni'}, {'state': 'ready', 'owner': 'moni'}])
        deps = module.OffboxDeps.__new__(module.OffboxDeps)
        deps.home = SimpleNamespace(person_gate=lambda: None)
        deps.allocation = SimpleNamespace(clear_resume=lambda con, box: None)
        deps.common = SimpleNamespace(db=lambda: nullcontext(SimpleNamespace(execute=lambda *args: SimpleNamespace(fetchone=lambda: None))), box_owner=lambda con, box: 'moni', require_mine=lambda con, box: None)
        deps.api = SimpleNamespace(LIVE_STATES=('ready', 'idle', 'running'), STOPPED_STATES=('archived',), STARTING_STATES=('init', 'provisioning', 'provisioned', 'cloning', 'starting', 'resuming'), get=lambda box: events.append(('get', box)) or next(states), wait_state=lambda box, want, timeout: events.append(('wait', box, timeout)) or next(states))
        deps.lease = SimpleNamespace(_resume_confirmed=lambda con, box, ttl, size: events.append(('resume', box, ttl, size)))
        deps.ensure('bx_moni')
        self.assertEqual(events, [('get', 'bx_moni'), ('resume', 'bx_moni', 1800, None), ('wait', 'bx_moni', 60)])
        deps.common.box_owner = lambda con, box: 'ardud'
        with self.assertRaisesRegex(RuntimeError, 'owner'): deps.ensure('bx_moni')

    def test_all_box_states_resume_only_archived_and_poll_existing_startup(self):
        for state in ('archived', 'init', 'provisioning', 'provisioned', 'cloning', 'starting', 'resuming', 'ready', 'idle', 'running', 'stopping', 'error', 'cancelled'):
            with self.subTest(state=state):
                calls = []
                deps = module.OffboxDeps.__new__(module.OffboxDeps)
                deps.home = SimpleNamespace(person_gate=lambda: None)
                deps.allocation = SimpleNamespace(clear_resume=lambda con, box: None)
                deps.common = SimpleNamespace(db=lambda: nullcontext(SimpleNamespace(execute=lambda *args: SimpleNamespace(fetchone=lambda: None))), box_owner=lambda con, box: 'moni', require_mine=lambda con, box: None)
                deps.api = SimpleNamespace(LIVE_STATES=('ready', 'idle', 'running'), STOPPED_STATES=('archived',), STARTING_STATES=('init', 'provisioning', 'provisioned', 'cloning', 'starting', 'resuming'),
                    get=lambda box: {'state': state, 'owner': 'moni'},
                    wait_state=lambda box, want, timeout: calls.append(('get-until-ready', box)) or {'state': 'ready', 'owner': 'moni'})
                deps.lease = SimpleNamespace(_resume_confirmed=lambda con, box, ttl, size: calls.append(('resume', box)))
                if state in ('stopping', 'error', 'cancelled'):
                    with self.assertRaisesRegex(RuntimeError, 'not_ready'): deps.ensure('bx_moni')
                else: deps.ensure('bx_moni')
                self.assertEqual(calls.count(('resume', 'bx_moni')), int(state == 'archived'))
                self.assertEqual(calls.count(('get-until-ready', 'bx_moni')), int(state in deps.api.STARTING_STATES or state == 'archived'))

    def test_resume_timeout_reconnect_polls_without_resending(self):
        calls = []; state = ['archived']; waits = []
        deps = module.OffboxDeps.__new__(module.OffboxDeps)
        deps.home = SimpleNamespace(person_gate=lambda: None)
        deps.allocation = SimpleNamespace(clear_resume=lambda con, box: None)
        deps.common = SimpleNamespace(db=lambda: nullcontext(SimpleNamespace(execute=lambda *args: SimpleNamespace(fetchone=lambda: None))), box_owner=lambda con, box: 'moni', require_mine=lambda con, box: None)
        def resume(con, box, ttl, size): calls.append(box); state[0] = 'resuming'
        def wait(box, want, timeout):
            waits.append(box)
            if len(waits) == 1: raise RuntimeError('box_not_ready')
            state[0] = 'ready'; return {'state': 'ready', 'owner': 'moni'}
        deps.api = SimpleNamespace(LIVE_STATES=('ready',), STOPPED_STATES=('archived',), STARTING_STATES=('resuming',), get=lambda box: {'state': state[0], 'owner': 'moni'}, wait_state=wait)
        deps.lease = SimpleNamespace(_resume_confirmed=resume)
        with self.assertRaisesRegex(RuntimeError, 'not_ready'): deps.ensure('bx_moni')
        deps.ensure('bx_moni')
        self.assertEqual(calls, ['bx_moni']); self.assertEqual(waits, ['bx_moni', 'bx_moni'])

    def test_persisted_unanswered_resume_is_confirmed_before_any_new_request(self):
        for state in ('archived', 'resuming', 'ready'):
            with self.subTest(state=state):
                calls = []
                deps = module.OffboxDeps.__new__(module.OffboxDeps)
                deps.home = SimpleNamespace(person_gate=lambda: None)
                con = SimpleNamespace(execute=lambda sql, args: SimpleNamespace(fetchone=lambda: ('',)))
                deps.common = SimpleNamespace(db=lambda: nullcontext(con), box_owner=lambda con, box: 'moni', require_mine=lambda con, box: None)
                deps.api = SimpleNamespace(LIVE_STATES=('ready',), STOPPED_STATES=('archived',), STARTING_STATES=('resuming',), get=lambda box: {'state': state, 'owner': 'moni'}, wait_state=lambda box, want, timeout: {'state': 'ready', 'owner': 'moni'})
                deps.lease = SimpleNamespace(_resume_confirmed=lambda con, box, ttl, size, **options: calls.append(('confirm', options.get('pending', False))))
                deps.allocation = SimpleNamespace(clear_resume=lambda con, box: calls.append(('settled', box)))
                deps.ensure('bx_moni')
                self.assertEqual(calls, [('confirm', True), ('settled', 'bx_moni')])

if __name__ == '__main__': unittest.main()
