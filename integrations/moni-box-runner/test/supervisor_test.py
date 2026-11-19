import ast
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).resolve().parents[1] / 'supervisor.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Child:
    def __init__(self): self.stopped = False; self.exit_code = None; self.on_stop = lambda: None
    def terminate(self): self.stopped = True; self.on_stop()
    def wait(self, timeout): return 0
    def poll(self): return self.exit_code if self.exit_code is not None else 0 if self.stopped else None

class Clock:
    def __init__(self): self.now = 0.0
    def __call__(self): return self.now
    def advance(self, seconds): self.now += seconds

class OffboxError(Exception): pass

class SupervisorTestCase(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        capture = redirect_stdout(self.output)
        capture.__enter__()
        self.addCleanup(capture.__exit__, None, None, None)

    def logs(self): return [json.loads(line) for line in self.output.getvalue().splitlines()]

class Deps:
    def __init__(self):
        self.events = []; self.stopped = True; self.enabled = True; self.fail = False; self.resume_pending = False
        self.readiness_error = None; self.maintenance_error = None
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
    def router_tunnel(self, box): self.events.append(('router-forward', box)); return Child()
    def livez_tunnel(self, box): self.events.append(('livez-forward', box)); return Child()
    def port_refused(self, port): return True
    def both_ready(self):
        self.events.append(('both-ready', None))
        if self.readiness_error: raise self.readiness_error
    def direct_ready(self, target): return True
    def pause(self): self.events.append(('pause', None))
    def refresh_lease(self):
        self.events.append(('refresh-lease', None))
        if self.maintenance_error: raise self.maintenance_error

class Tests(SupervisorTestCase):
    def test_stopped_box_recovery_never_allocates(self):
        deps = Deps(); supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        self.assertTrue(supervisor.connect())
        self.assertEqual(deps.events, [('ensure', 'bx_moni'), ('resume', 'bx_moni'), ('ssh-setup', 'bx_moni'), ('runner-ready', 'bx_moni'), ('forward', 'bx_moni'), ('reverse', 'bx_moni'), ('router-forward', 'bx_moni'), ('livez-forward', 'bx_moni'), ('both-ready', None)])
        deps.stopped = True
        for child in supervisor.children: child.exit_code = 255
        self.assertTrue(supervisor.connect())
        self.assertEqual(set(box for _, box in deps.events if box), {'bx_moni'})
        self.assertEqual(deps.events.count(('resume', 'bx_moni')), 2)
        self.assertFalse(any(name in ('create', 'fork', 'acquire') for name, _ in deps.events))
    def test_partial_connection_never_declares_ready(self):
        deps = Deps(); deps.fail = True; supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        with self.assertRaises(RuntimeError): supervisor.connect()
        self.assertNotIn(('both-ready', None), deps.events)
        self.assertEqual(supervisor.children, [])
    def test_pending_resume_is_confirmed_and_rollback_disables_connections(self):
        deps = Deps(); deps.resume_pending = True; supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        self.assertTrue(supervisor.connect()); self.assertIn(('confirm', 'bx_moni'), deps.events)
        deps.enabled = False
        self.assertFalse(supervisor.connect()); self.assertEqual(supervisor.children, [])
        self.assertEqual(deps.events.count(('pause', None)), 1)

class ColdStartupTests(SupervisorTestCase):
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
        clock = Clock()
        supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=clock, sleep=clock.advance)
        self.assertFalse(supervisor.connect()); self.assertFalse(supervisor.connect())
        self.assertTrue(supervisor.connect()); self.assertEqual(len(attempts), 3)
        self.assertTrue(all(not child.stopped for child in children))
        self.assertEqual(deps.events.count(('ensure', 'bx_moni')), 1)

class RouterTunnelTests(SupervisorTestCase):
    def test_target_is_only_the_configured_mac_loopback_port(self):
        for config, ports in [({}, (19465, 20128)), ({'boxRouterPort': 19475, 'macRouterPort': 20138}, (19475, 20138))]:
            calls = []
            deps = module.OffboxDeps.__new__(module.OffboxDeps)
            deps.config = config
            deps.ssh_sync = SimpleNamespace(tunnel=lambda *args: calls.append(args) or Child())
            deps.router_tunnel('bx_moni')
            self.assertEqual(calls, [('bx_moni', *ports, True)])
        for value in (None, True, 0, 1023, 65536, '20128', '20128:localhost:22'):
            for key in ('boxRouterPort', 'macRouterPort', 'boxLivezPort', 'macLivezPort'):
                with self.assertRaisesRegex(RuntimeError, 'invalid_router_port'): module.router_ports({key: value})

    def test_real_ssh_builder_binds_box_loopback_and_forwards_only_to_mac_router(self):
        source = Path(__file__).resolve().parents[2] / 'offbox/skill/scripts/offbox_lib/ssh_sync.py'
        node = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'tunnel')
        calls = []
        namespace = {'subprocess': SimpleNamespace(Popen=lambda args: calls.append(args) or Child()), 'ssh_base': lambda box: ['ssh', '-F', 'isolated-config']}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), namespace)
        deps = module.OffboxDeps.__new__(module.OffboxDeps); deps.config = {}; deps.ssh_sync = SimpleNamespace(tunnel=namespace['tunnel'])
        deps.router_tunnel('bx_moni')
        self.assertEqual(calls, [['ssh', '-F', 'isolated-config', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-R', '127.0.0.1:19465:127.0.0.1:20128', 'bx_moni']])

    def test_lost_router_tunnel_reconnects_without_resuming_a_running_box(self):
        deps = Deps(); supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        self.assertTrue(supervisor.connect()); first = supervisor.children.copy()
        first[2].stopped = True
        self.assertTrue(supervisor.connect())
        self.assertFalse(first[0].stopped); self.assertFalse(first[1].stopped)
        self.assertIs(supervisor.children[0], first[0]); self.assertIs(supervisor.children[1], first[1])
        self.assertEqual(deps.events.count(('resume', 'bx_moni')), 1)
        self.assertEqual(deps.events.count(('router-forward', 'bx_moni')), 2)
        deps.enabled = False; supervisor.connect()
        self.assertEqual(supervisor.children, [])

    def test_router_tunnel_failure_cleans_both_existing_tunnels(self):
        deps = Deps(); children = []
        original = deps.tunnel
        def tunnel(box, reverse):
            child = original(box, reverse); children.append(child); return child
        deps.tunnel = tunnel
        deps.router_tunnel = lambda box: (_ for _ in ()).throw(RuntimeError('router'))
        supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        with self.assertRaisesRegex(RuntimeError, 'router'): supervisor.connect()
        self.assertTrue(all(child.stopped for child in children)); self.assertEqual(supervisor.children, [])

class ExactBoxTests(SupervisorTestCase):
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

class RepairTests(SupervisorTestCase):
    def supervisor(self, deps=None, **kwargs):
        self.deps = deps or Deps()
        self.clock = Clock()
        supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, self.deps,
                                       clock=self.clock, sleep=self.clock.advance, **kwargs)
        self.assertTrue(supervisor.connect())
        return supervisor

    def test_single_failed_probe_and_recovery_keep_every_tunnel(self):
        supervisor = self.supervisor(); original = supervisor.children
        self.deps.readiness_error = TimeoutError('private request and token')
        self.assertFalse(supervisor.connect())
        self.assertEqual(supervisor.failures, 1)
        self.assertEqual(supervisor.children, original)
        self.assertTrue(all(not child.stopped for child in original))
        self.deps.readiness_error = None
        self.assertTrue(supervisor.connect()); self.assertEqual(supervisor.failures, 0)
        self.deps.readiness_error = TimeoutError()
        self.assertFalse(supervisor.connect()); self.assertFalse(supervisor.connect())
        self.assertEqual(supervisor.children, original)
        self.assertFalse(any(event['event'] == 'moni-supervisor-reconnect' for event in self.logs()))

    def test_router_slow_directly_for_a_minute_never_rebuilds_a_healthy_forward(self):
        supervisor = self.supervisor(); original = supervisor.children
        self.deps.readiness_error = module.ReadinessError('router', 503)
        self.deps.direct_ready = lambda target: False
        for _ in range(12):
            self.clock.advance(5); self.assertFalse(supervisor.connect())
        self.assertEqual(supervisor.children, original)
        self.assertTrue(all(not child.stopped for child in original))
        self.assertEqual(len([row for row in self.logs() if row['event'] == 'moni-supervisor-router-slow']), 4)
        self.assertFalse(any(row['event'] == 'moni-supervisor-reconnect' for row in self.logs()))

    def test_callback_unready_locally_and_paused_runner_never_rebuild(self):
        for error in (module.ReadinessError('callback', 503), module.ReadinessError('runner', 503)):
            supervisor = self.supervisor(); original = supervisor.children
            self.deps.readiness_error = error; self.deps.direct_ready = lambda target: False
            for _ in range(6): self.assertFalse(supervisor.connect())
            self.assertEqual(supervisor.children, original)
            self.assertTrue(all(not child.stopped for child in original))

    def test_sustained_failure_repairs_only_the_implicated_forward(self):
        for target in ('runner', 'callback', 'livez'):
            with self.subTest(target=target):
                supervisor = self.supervisor(); original = supervisor.children
                self.deps.readiness_error = (module.ReadinessError('runner', None, 'ConnectionRefusedError', 'ssh-transport') if target == 'runner'
                                             else module.ReadinessError('router' if target == 'livez' else target, 503))
                for _ in range(2):
                    self.assertFalse(supervisor.connect())
                    self.assertTrue(all(not child.stopped for child in original))
                self.assertFalse(supervisor.connect())
                for name, old, new in zip(module.TUNNELS, original, supervisor.children):
                    self.assertEqual(old.stopped, name == target)
                    if name == target: self.assertIsNot(old, new)
                    else: self.assertIs(old, new)
                reconnect = self.logs()[-1]
                self.assertEqual(reconnect['event'], 'moni-supervisor-reconnect')
                self.assertEqual(reconnect['consecutive_failures'], 3)
                self.assertEqual(reconnect['torn_down'], [target])
                self.assertEqual(reconnect['target'], target)
                self.assertNotIn(('pause', None), self.deps.events)
                self.assertEqual(self.deps.events.count(('ensure', 'bx_moni')), 1)
                self.assertEqual(self.deps.events.count(('runner-ready', 'bx_moni')), 1)
                for _ in range(3): self.assertFalse(supervisor.connect())
                self.assertEqual(self.logs()[-1]['consecutive_failures'], 6)

    def test_failure_threshold_is_internal_and_configurable(self):
        supervisor = self.supervisor(failure_limit=2); original = supervisor.children
        self.deps.readiness_error = ConnectionRefusedError()
        self.assertFalse(supervisor.connect()); self.assertFalse(original[0].stopped)
        self.assertFalse(supervisor.connect()); self.assertTrue(original[0].stopped)
        for invalid in (0, -1, True, 2.0, '3'):
            with self.assertRaises(ValueError): module.Supervisor({}, self.deps, failure_limit=invalid)

    def test_each_dead_ssh_child_is_named_and_restarted_individually(self):
        for target in module.TUNNELS:
            with self.subTest(target=target):
                supervisor = self.supervisor(); original = supervisor.children
                original[module.TUNNELS.index(target)].exit_code = 255
                self.assertTrue(supervisor.connect())
                for name, old, new in zip(module.TUNNELS, original, supervisor.children):
                    self.assertFalse(old.stopped)
                    if name == target: self.assertIsNot(old, new)
                    else: self.assertIs(old, new)
                event = self.logs()[-1]
                self.assertEqual((event['event'], event['check'], event['target'], event['exit_code']),
                                 ('moni-supervisor-reconnect', 'ssh-child', target, 255))
                self.assertEqual(event['torn_down'], [])
                self.assertEqual(self.deps.events.count(('ensure', 'bx_moni')), 1)

    def test_failed_child_restart_keeps_the_healthy_forwards(self):
        supervisor = self.supervisor(); original = supervisor.children
        original[2].exit_code = 255
        router_tunnel = self.deps.router_tunnel
        self.deps.router_tunnel = lambda box: (_ for _ in ()).throw(OSError('private ssh details'))
        with self.assertRaises(OSError): supervisor.connect()
        self.assertEqual(supervisor.children, original[:2] + original[3:])
        self.assertTrue(all(not child.stopped for child in original[:2]))
        self.assertEqual(self.logs()[-1]['torn_down'], [])
        self.deps.router_tunnel = router_tunnel
        self.assertTrue(supervisor.connect())

    def test_an_immediately_exited_child_never_declares_ready(self):
        deps = Deps(); original = deps.tunnel
        def tunnel(box, reverse):
            child = original(box, reverse)
            if not reverse: child.exit_code = 255
            return child
        deps.tunnel = tunnel
        supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        self.assertFalse(supervisor.connect())
        self.assertNotIn(('both-ready', None), deps.events)
        self.assertEqual(self.logs()[-1]['target'], 'runner')
        healthy = supervisor.children
        deps.tunnel = original
        self.assertTrue(supervisor.connect())
        self.assertEqual(supervisor.children[1:], healthy)
        self.assertTrue(all(not child.stopped for child in healthy))

    def test_a_child_exit_during_the_probe_never_declares_ready(self):
        supervisor = self.supervisor(); original = supervisor.children
        self.deps.both_ready = lambda: setattr(original[2], 'exit_code', 255)
        self.assertFalse(supervisor.connect())
        self.assertEqual(supervisor.children, original[:2] + original[3:])
        self.assertEqual(self.logs()[-1]['exit_code'], 255)
        self.assertEqual(self.logs()[-1]['torn_down'], [])

    def test_reconnect_does_not_pause_or_interrupt_an_active_model_turn(self):
        class Runner:
            def __init__(self): self.working = True; self.fail = False; self.paths = []
            def post(self, path):
                self.paths.append(path)
                if path == '/pause': self.working = False
                elif self.fail: raise TimeoutError('sensitive request')
            def model_disconnected(self): self.working = False
        runner = Runner(); deps = Deps()
        deps.both_ready = lambda: runner.post('/lease')
        deps.pause = lambda: runner.post('/pause')
        supervisor = self.supervisor(deps); router = supervisor.children[2]
        router.on_stop = runner.model_disconnected
        runner.fail = True
        for _ in range(3): self.assertFalse(supervisor.connect())
        self.assertTrue(runner.working)
        self.assertFalse(router.stopped); self.assertIs(supervisor.children[2], router)
        self.assertNotIn('/pause', runner.paths)
        runner.fail = False
        self.assertTrue(supervisor.connect()); self.assertTrue(runner.working)
        deps.enabled = False
        self.assertFalse(supervisor.connect())
        self.assertIn('/pause', runner.paths); self.assertFalse(runner.working)
        self.assertEqual(supervisor.children, [])

    def test_rollback_during_a_probe_pauses_and_stops_every_forward(self):
        for fail in (False, True):
            with self.subTest(fail=fail):
                supervisor = self.supervisor(); original = supervisor.children
                def ready():
                    self.deps.enabled = False
                    if fail: raise TimeoutError()
                self.deps.both_ready = ready
                self.assertFalse(supervisor.connect())
                self.assertEqual(supervisor.children, [])
                self.assertTrue(all(child.stopped for child in original))
                self.assertIn(('pause', None), self.deps.events)
                self.assertEqual(self.logs()[-1]['torn_down'], list(module.TUNNELS))

    def test_lease_maintenance_failures_never_count_as_readiness_failures(self):
        supervisor = self.supervisor(); original = supervisor.children
        self.deps.maintenance_error = RuntimeError('sensitive offbox error')
        self.assertTrue(supervisor.tick())
        for _ in range(3): self.assertTrue(supervisor.tick())
        self.assertEqual(self.deps.events.count(('refresh-lease', None)), 1)
        self.clock.advance(59); self.assertTrue(supervisor.tick())
        self.assertEqual(self.deps.events.count(('refresh-lease', None)), 1)
        self.clock.advance(1); self.assertTrue(supervisor.tick())
        self.assertEqual(self.deps.events.count(('refresh-lease', None)), 2)
        self.assertEqual(supervisor.failures, 0)
        self.assertEqual(supervisor.children, original)
        self.assertTrue(all(not child.stopped for child in original))
        self.assertTrue(all(event['check'] == 'offbox-lease' and event['torn_down'] == [] for event in self.logs()))
        self.deps.maintenance_error = None
        self.clock.advance(60); self.assertTrue(supervisor.tick())
        self.assertEqual(supervisor.lease_failures, 0)
        self.clock.advance(299); self.assertTrue(supervisor.tick())
        self.assertEqual(self.deps.events.count(('refresh-lease', None)), 3)
        self.clock.advance(1); self.assertTrue(supervisor.tick())
        self.assertEqual(self.deps.events.count(('refresh-lease', None)), 4)

    def test_run_loop_uses_the_same_failure_policy_and_keeps_maintenance_separate(self):
        deps = Deps(); clock = Clock(); before_shutdown = []
        def ready():
            if clock() > 0: raise TimeoutError('private turn')
        deps.both_ready = ready
        deps.maintenance_error = RuntimeError('private offbox error')
        def sleep(seconds):
            clock.advance(seconds)
            if clock() == 5: before_shutdown.extend(supervisor.children)
            if clock() >= 20:
                self.assertTrue(all(not child.stopped for child in before_shutdown[1:]))
                self.assertNotIn(('pause', None), deps.events)
                raise KeyboardInterrupt()
        supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=clock, sleep=sleep)
        with self.assertRaises(KeyboardInterrupt): supervisor.run()
        self.assertTrue(before_shutdown[0].stopped)
        reconnects = [event for event in self.logs() if event['event'] == 'moni-supervisor-reconnect']
        self.assertEqual(reconnects, [])
        self.assertEqual(supervisor.children, [])


class LoggingTests(SupervisorTestCase):
    def test_errors_and_reconnects_have_utc_time_safe_class_latency_count_and_actual_teardown(self):
        clock = Clock(); deps = Deps()
        supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=clock, sleep=clock.advance)
        self.assertTrue(supervisor.connect())
        supervisor.children[0].wait = lambda timeout: clock.advance(2)
        def ready():
            clock.advance(1.234)
            raise TimeoutError('Bearer control-token router-key private personal text\nraw ssh error')
        deps.both_ready = ready
        fixed_time = datetime(2026, 11, 16, 12, 0, 0, 123000, tzinfo=timezone.utc)
        with patch.object(module, 'datetime', SimpleNamespace(now=lambda zone: fixed_time)):
            for _ in range(3): self.assertFalse(supervisor.connect())
        events = self.logs(); self.assertEqual(len(events), 3)
        for event in events:
            self.assertEqual(event['timestamp'], '2026-11-16T12:00:00.123Z')
            self.assertEqual((event['check'], event['probe'], event['target']), ('runner-lease', 'POST /lease', 'runner'))
            self.assertEqual(event['exception_class'], 'TimeoutError'); self.assertIsNone(event['status'])
            self.assertEqual(event['latency_ms'], 1234)
        self.assertEqual([event['consecutive_failures'] for event in events], [1, 2, 3])
        self.assertEqual([event['torn_down'] for event in events], [[], [], []])
        self.assertAlmostEqual(clock(), 3.702)
        for secret in ('control-token', 'router-key', 'private personal text', 'raw ssh error'):
            self.assertNotIn(secret, self.output.getvalue())

    def test_ssh_stderr_is_bounded_and_only_fixed_diagnostics_reach_the_log(self):
        deps = module.OffboxDeps.__new__(module.OffboxDeps); deps.config = {}
        calls = []; old_fds = [(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in (1, 2)]
        def tunnel(*args):
            calls.append(args)
            self.assertTrue(stat.S_ISCHR(os.fstat(1).st_mode))
            self.assertTrue(stat.S_ISFIFO(os.fstat(2).st_mode))
            print('control-token private text')
            print('router-key raw ssh line', file=sys.stderr)
            os.write(2, b'x' * 3000 + b'PRIVATE_TOKEN private message: Permission denied\n')
            return Child()
        deps.ssh_sync = SimpleNamespace(tunnel=tunnel)
        stderr = io.StringIO()
        with redirect_stderr(stderr): child = deps.router_tunnel('bx_moni')
        self.assertEqual(calls, [('bx_moni', 19465, 20128, True)])
        self.assertEqual(self.output.getvalue(), ''); self.assertEqual(stderr.getvalue(), '')
        self.assertEqual([(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in (1, 2)], old_fds)
        self.assertEqual(child.moni_stderr.fields(), {'stderr_bytes': 2048, 'stderr_tail': ['permission-denied']})


class ReadinessContractTests(SupervisorTestCase):
    def deps(self):
        deps = module.OffboxDeps.__new__(module.OffboxDeps)
        deps.config = {'boxId': 'bx_moni', 'epoch': 'bound-epoch', 'url': 'http://127.0.0.1:19463',
                       'tokenFile': 'unused-token-file', 'boxRunnerPort': 19463,
                       'boxCallbackPort': 19464, 'callbackPort': 19464}
        return deps

    def test_outer_lease_budget_covers_both_sequential_five_second_checks_and_keeps_auth(self):
        deps = self.deps(); clock = Clock(); calls = []
        def urlopen(request, timeout):
            calls.append((request.full_url, request.get_header('Authorization'), timeout,
                          json.loads(request.data)))
            clock.advance(5); clock.advance(5)
            if timeout < 10: raise TimeoutError('outer budget expired')
            return io.BytesIO(json.dumps({'boxId': 'bx_moni', 'epoch': 'bound-epoch'}).encode())
        with patch.object(Path, 'read_text', return_value='control-token\n'), patch.object(module.urllib.request, 'urlopen', urlopen):
            deps.both_ready()
        self.assertEqual(calls, [('http://127.0.0.1:19463/lease', 'Bearer control-token', 12,
                                  {'boxId': 'bx_moni', 'epoch': 'bound-epoch'})])
        self.assertEqual(clock(), 10)
        self.assertEqual(self.output.getvalue(), '')

    def test_pause_keeps_a_short_budget_and_posts_with_auth(self):
        deps = self.deps(); calls = []
        def urlopen(request, timeout):
            calls.append((request.full_url, request.get_header('Authorization'), timeout, json.loads(request.data)))
            return io.BytesIO(b'{"paused":true}')
        with patch.object(Path, 'read_text', return_value='control-token'), patch.object(module.urllib.request, 'urlopen', urlopen):
            deps.pause()
        self.assertEqual(calls, [('http://127.0.0.1:19463/pause', 'Bearer control-token', 5, {})])

    def test_http_failures_only_use_the_two_fixed_readiness_names(self):
        cases = [(503, b'{"error":"Router unavailable"}', 'router'),
                 (503, b'{"error":"Callback unavailable"}', 'callback'),
                 (503, b'{"error":"private personal text"}', 'runner'),
                 (503, b'not json', 'runner'), (403, b'{"error":"Router unavailable"}', 'runner'),
                 (503, b'[]', 'runner'), (503, b'{"error":[]}', 'runner'),
                 (503, b'{"error":{}}', 'runner')]
        for status, body, target in cases:
            with self.subTest(status=status, body=body):
                deps = self.deps(); error_body = io.BytesIO(body)
                error = module.urllib.error.HTTPError('http://unused/control-token', status, 'private text', {}, error_body)
                deps.post = lambda *args: (_ for _ in ()).throw(error)
                with self.assertRaises(module.ReadinessError) as result: deps.both_ready()
                self.assertEqual((result.exception.target, result.exception.status), (target, status))
                self.assertTrue(error_body.closed)
                self.assertNotIn('private', str(result.exception))

    def test_separate_readiness_flags_and_connection_refusal_keep_distinct_phases(self):
        for target in ('router', 'callback'):
            deps = self.deps()
            deps.post = lambda *args: {'boxId': 'bx_moni', 'epoch': 'bound-epoch', 'routerReady': target != 'router', 'callbackReady': target != 'callback'}
            with self.assertRaises(module.ReadinessError) as error: deps.both_ready()
            self.assertEqual((error.exception.target, error.exception.phase), (target, target + '-http'))
        for cause, phase in ((ConnectionRefusedError('PRIVATE_TOKEN'), 'ssh-transport'), (TimeoutError('PRIVATE_TEXT'), 'runner-http')):
            deps = self.deps(); deps.post = lambda *args: (_ for _ in ()).throw(module.urllib.error.URLError(cause))
            with self.assertRaises(module.ReadinessError) as error: deps.both_ready()
            self.assertEqual(error.exception.phase, phase)
            self.assertNotIn('PRIVATE_', str(error.exception))

    def test_http_status_and_fixed_target_reach_the_supervisor_log(self):
        deps = Deps(); remote = self.deps()
        supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        self.assertTrue(supervisor.connect())
        def post(*args):
            raise module.urllib.error.HTTPError('http://unused/control-token', 503, 'private text', {},
                                              io.BytesIO(b'{"error":"Callback unavailable"}'))
        remote.post = post; deps.both_ready = remote.both_ready
        for _ in range(3): self.assertFalse(supervisor.connect())
        for event in [row for row in self.logs() if row['check'] == 'runner-lease']:
            self.assertEqual((event['target'], event['status'], event['exception_class']), ('callback', 503, 'HTTPError'))
        self.assertEqual(self.logs()[-1]['torn_down'], ['callback'])
        self.assertNotIn('control-token', self.output.getvalue()); self.assertNotIn('private text', self.output.getvalue())

    def test_identity_mismatch_never_declares_ready(self):
        for response in ({'boxId': 'bx_other', 'epoch': 'bound-epoch'}, {'boxId': 'bx_moni', 'epoch': 'old-epoch'}):
            deps = self.deps(); deps.post = lambda *args: response
            with self.assertRaises(module.ReadinessError) as error: deps.both_ready()
            self.assertEqual((error.exception.target, error.exception.status), ('runner', 200))

    def test_readiness_does_not_call_offbox_lease_maintenance(self):
        deps = self.deps(); calls = []
        deps.post = lambda *args: {'boxId': 'bx_moni', 'epoch': 'bound-epoch'}
        deps.lease = SimpleNamespace(touch=lambda *args: calls.append('touch'), ensure_ttl=lambda *args: calls.append('ttl'))
        deps.both_ready(); self.assertEqual(calls, [])

    def test_false_ttl_refresh_is_safe_logged_and_keeps_healthy_tunnels(self):
        deps = Deps(); remote = self.deps(); clock = Clock(); calls = []
        def ttl(box, seconds):
            calls.append((box, seconds)); print('private offbox warning', file=sys.stderr); return False
        remote.lease = SimpleNamespace(touch=lambda box: calls.append(box), ensure_ttl=ttl)
        deps.refresh_lease = remote.refresh_lease
        supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=clock, sleep=clock.advance)
        self.assertTrue(supervisor.tick()); original = supervisor.children
        for _ in range(4): self.assertTrue(supervisor.tick())
        self.assertEqual(calls, ['bx_moni', ('bx_moni', 1800)])
        self.assertEqual(supervisor.children, original)
        self.assertTrue(all(not child.stopped for child in original))
        self.assertEqual(supervisor.failures, 0)
        self.assertEqual(self.logs()[0]['check'], 'offbox-lease')
        self.assertEqual(self.logs()[0]['exception_class'], 'RuntimeError')
        self.assertEqual(self.logs()[0]['torn_down'], [])
        self.assertNotIn('private offbox warning', self.output.getvalue())

    def test_backend_binding_requires_exact_kind_box_and_epoch(self):
        deps = self.deps(); deps.bridge_config = Path('unused-bridge-config')
        bound = {'kind': 'remote-box', 'boxId': 'bx_moni', 'epoch': 'bound-epoch'}
        for change, active in (({}, True), ({'kind': 'robob'}, False), ({'boxId': 'bx_other'}, False), ({'epoch': 'old'}, False)):
            with patch.object(Path, 'read_text', return_value=json.dumps({'chatBackends': {'moni': {**bound, **change}}})):
                self.assertEqual(deps.active(), active)

    def test_invalid_cli_arguments_do_not_print_raw_values(self):
        stderr = io.StringIO()
        with patch.object(sys, 'argv', ['supervisor.py', '--unknown=private-control-token']), redirect_stderr(stderr):
            with self.assertRaisesRegex(ValueError, 'invalid_arguments'): module.main()
        self.assertEqual(stderr.getvalue(), ''); self.assertEqual(self.output.getvalue(), '')

    def test_existing_ssh_builder_preserves_all_three_loopback_mappings(self):
        source = Path(__file__).resolve().parents[2] / 'offbox/skill/scripts/offbox_lib/ssh_sync.py'
        node = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'tunnel')
        calls = []
        namespace = {'subprocess': SimpleNamespace(Popen=lambda args: calls.append(args) or Child()), 'ssh_base': lambda box: ['ssh', '-F', 'isolated-config']}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), namespace)
        deps = self.deps(); deps.ssh_sync = SimpleNamespace(tunnel=namespace['tunnel'])
        deps.tunnel('bx_moni', False); deps.tunnel('bx_moni', True); deps.router_tunnel('bx_moni')
        prefix = ['ssh', '-F', 'isolated-config', '-N', '-o', 'ExitOnForwardFailure=yes', '-o',
                  'ControlMaster=no', '-o', 'ControlPath=none']
        self.assertEqual(calls, [prefix + ['-L', '127.0.0.1:19463:127.0.0.1:19463', 'bx_moni'],
                                 prefix + ['-R', '127.0.0.1:19464:127.0.0.1:19464', 'bx_moni'],
                                 prefix + ['-R', '127.0.0.1:19465:127.0.0.1:20128', 'bx_moni']])


class LivezTests(SupervisorTestCase):
    def remote(self, config=None):
        deps = module.OffboxDeps.__new__(module.OffboxDeps)
        deps.config = config or {'boxId': 'bx_moni'}
        deps.common = SimpleNamespace(OffboxError=OffboxError)
        return deps

    def test_real_livez_ssh_arguments_defaults_and_overrides(self):
        source = Path(__file__).resolve().parents[2] / 'offbox/skill/scripts/offbox_lib/ssh_sync.py'
        node = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'tunnel')
        for config, mapping in (({}, '127.0.0.1:19466:127.0.0.1:20129'),
                                ({'boxLivezPort': 19476, 'macLivezPort': 20139}, '127.0.0.1:19476:127.0.0.1:20139')):
            calls = []
            namespace = {'subprocess': SimpleNamespace(Popen=lambda args: calls.append(args) or Child()), 'ssh_base': lambda box: ['ssh', '-F', 'isolated-config']}
            exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), namespace)
            deps = self.remote(config); deps.ssh_sync = SimpleNamespace(tunnel=namespace['tunnel'])
            deps.livez_tunnel('bx_moni')
            self.assertEqual(calls, [['ssh', '-F', 'isolated-config', '-N', '-o', 'ExitOnForwardFailure=yes', '-o',
                                      'ControlMaster=no', '-o', 'ControlPath=none', '-R', mapping, 'bx_moni']])

    def test_invalid_and_equal_ports_fail_before_forwarding(self):
        for value in (None, True, 0, 1023, 65536, 19466.5, '19466', '19466:owner:22'):
            for field in ('boxRouterPort', 'macRouterPort', 'boxLivezPort', 'macLivezPort'):
                with self.subTest(field=field, value=value), self.assertRaisesRegex(RuntimeError, 'invalid_router_port'):
                    module.livez_ports({field: value})
        for port in (1024, 19465, 65535):
            with self.assertRaisesRegex(RuntimeError, 'invalid_router_port'):
                module.router_ports({'boxRouterPort': port, 'boxLivezPort': port})

    def test_blocked_api_health_is_never_probed_and_causes_no_teardown_or_slow_log(self):
        deps = Deps(); remote = self.remote(); calls = []
        remote.post = lambda *args: {'boxId': 'bx_moni', 'epoch': 'epoch', 'routerReady': remote.direct_ready('router'), 'callbackReady': True}
        remote.config.update({'epoch': 'epoch', 'url': 'http://runner', 'tokenFile': 'unused'})
        deps.both_ready = remote.both_ready; deps.direct_ready = remote.direct_ready
        def urlopen(url, timeout):
            calls.append((url, timeout))
            if '/api/health' in url: raise AssertionError('worker loop must not be probed')
            response = io.BytesIO(b'{"ready":true}'); response.status = 200
            return response
        clock = Clock(); supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=clock)
        with patch.object(module.urllib.request, 'urlopen', urlopen):
            self.assertTrue(supervisor.connect()); original = supervisor.children
            for _ in range(12): clock.advance(5); self.assertTrue(supervisor.connect())
        self.assertEqual(set(calls), {('http://127.0.0.1:20129/livez', 1.5)})
        self.assertEqual(supervisor.children, original)
        self.assertFalse(any(c.stopped for c in original))
        self.assertEqual(self.logs(), [])

    def test_mac_livez_503_never_rebuilds_and_logs_only_safe_reason(self):
        for reason in ('no_worker', 'not_ready', 'heartbeat_stale', 'shutting_down', 'PRIVATE_KEY PRIVATE_TEXT', None, [], {}):
            deps = Deps(); remote = self.remote(); deps.direct_router_reason = None
            def direct(target):
                result = remote.direct_ready(target); deps.direct_router_reason = remote.direct_router_reason
                return result
            deps.direct_ready = direct
            deps.port_refused = lambda port: self.fail('no TCP repair probe when Mac is unready')
            supervisor = module.Supervisor({'boxId': 'bx_moni'}, deps, clock=Clock())
            self.assertTrue(supervisor.connect()); original = supervisor.children
            deps.readiness_error = module.ReadinessError('router', 200, 'DependencyUnavailable')
            def urlopen(url, timeout):
                self.assertEqual((url, timeout), ('http://127.0.0.1:20129/livez', 1.5))
                raise module.urllib.error.HTTPError(url, 503, 'PRIVATE_TOKEN', {}, io.BytesIO(json.dumps({'reason': reason, 'key': 'PRIVATE_KEY'}).encode()))
            with patch.object(module.urllib.request, 'urlopen', urlopen):
                for _ in range(6): self.assertFalse(supervisor.connect())
            self.assertEqual(supervisor.children, original); self.assertFalse(any(c.stopped for c in original))
            slow = [e for e in self.logs() if e['event'] == 'moni-supervisor-router-slow'][-1]
            self.assertEqual(slow['reason'], module.livez_reason(reason)); self.assertEqual(slow['torn_down'], [])
        self.assertNotIn('PRIVATE_', self.output.getvalue())

    def test_accepting_box_livez_port_never_rebuilds_on_readiness_alone(self):
        deps = Deps(); deps.port_refused = lambda port: False
        supervisor = module.Supervisor({'boxId': 'bx_moni', 'boxCallbackPort': 19464}, deps)
        self.assertTrue(supervisor.connect()); original = supervisor.children
        deps.readiness_error = module.ReadinessError('router', 200, 'DependencyUnavailable')
        for _ in range(6): self.assertFalse(supervisor.connect())
        self.assertEqual(supervisor.children, original); self.assertFalse(any(c.stopped for c in original))
        self.assertFalse(any(e['event'] in ('moni-supervisor-reconnect', 'moni-supervisor-router-slow') for e in self.logs()))

    def test_direct_livez_requires_exact_200_and_boolean_ready(self):
        for status, body, expected in ((200, b'{"ready":true}', True), (200, b'{"ready":false}', False),
                                       (200, b'{"ready":1}', False), (200, b'{"ready":"true"}', False),
                                       (200, b'null', False), (200, b'[]', False), (200, b'bad', False),
                                       (201, b'{"ready":true}', False)):
            deps = self.remote({'macLivezPort': 20139})
            def urlopen(url, timeout):
                self.assertEqual((url, timeout), ('http://127.0.0.1:20139/livez', 1.5))
                response = io.BytesIO(body); response.status = status
                return response
            with patch.object(module.urllib.request, 'urlopen', urlopen): self.assertEqual(deps.direct_ready('router'), expected)
        for body in (b'null', b'[]', b'bad'):
            error = module.urllib.error.HTTPError('unused', 503, '', {}, io.BytesIO(body))
            with patch.object(module.urllib.request, 'urlopen', side_effect=error):
                self.assertFalse(deps.direct_ready('router')); self.assertEqual(deps.direct_router_reason, 'unknown')

    def test_tcp_probe_is_exact_box_loopback_and_only_refusal_allows_repair(self):
        deps = self.remote({'boxId': 'bx_moni', 'boxLivezPort': 19476})
        deps.ssh_sync = SimpleNamespace(ssh_base=lambda box: ['ssh', '-F', 'isolated-config'])
        for code, expected in ((42, True), (0, False), (1, False), (255, False)):
            calls = []
            def run(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv[:4], ['ssh', '-F', 'isolated-config', 'bx_moni'])
                self.assertEqual(kwargs, {'timeout': 5, 'stdout': module.subprocess.DEVNULL, 'stderr': module.subprocess.DEVNULL})
                return SimpleNamespace(returncode=code)
            with patch.object(module.subprocess, 'run', run): self.assertEqual(deps.port_refused(19476), expected)
            probe = module.shlex.split(calls[0][4])
            self.assertEqual(probe[:2], ['python3', '-c'])
            import errno
            for result, exit_code in ((errno.ECONNREFUSED, 42), (0, 0), (errno.ETIMEDOUT, 43)):
                connections = []
                socket = SimpleNamespace(settimeout=lambda seconds: self.assertEqual(seconds, 1.5),
                                         connect_ex=lambda address: connections.append(address) or result, close=lambda: None)
                with patch('socket.socket', return_value=socket):
                    with self.assertRaises(SystemExit) as error: exec(probe[2], {})
                self.assertEqual(error.exception.code, exit_code); self.assertEqual(connections, [('127.0.0.1', 19476)])
        for error in (OSError('PRIVATE_KEY'), module.subprocess.TimeoutExpired('PRIVATE_TEXT', 5)):
            with patch.object(module.subprocess, 'run', side_effect=error): self.assertFalse(deps.port_refused(19476))
        self.assertNotIn('PRIVATE_', self.output.getvalue())


class CallbackRepairTests(SupervisorTestCase):
    supervisor = RepairTests.supervisor
    def test_routing_domain_errors_are_inconclusive_and_preserve_the_callback(self):
        for error in (OffboxError('PRIVATE_ENDPOINT'), OSError('PRIVATE_KEY'),
                      module.subprocess.TimeoutExpired('PRIVATE_TEXT', 5)):
            with self.subTest(error=type(error).__name__):
                supervisor = self.supervisor(); original = supervisor.children
                remote = module.OffboxDeps.__new__(module.OffboxDeps)
                remote.config = supervisor.config
                remote.common = SimpleNamespace(OffboxError=OffboxError)
                remote.ssh_sync = SimpleNamespace(ssh_base=lambda box: (_ for _ in ()).throw(error))
                self.deps.port_refused = remote.port_refused
                self.deps.readiness_error = module.ReadinessError('callback', 200, 'DependencyUnavailable')
                for _ in range(3): self.assertFalse(supervisor.connect())
                self.assertEqual(supervisor.children, original)
                self.assertTrue(all(not child.stopped for child in original))
                self.assertEqual(self.logs()[-2]['event'], 'moni-supervisor-tcp-probe')
                self.assertEqual(self.logs()[-2]['outcome'], 'unknown')
                self.assertEqual(self.logs()[-1]['event'], 'moni-supervisor-callback-slow')
        self.assertNotIn('PRIVATE_', self.output.getvalue())

    def test_box_timeout_with_accepting_port_preserves_callback_and_logs_slow(self):
        supervisor = self.supervisor(); original = supervisor.children
        probes = []
        self.deps.port_refused = lambda port: probes.append(port) or False
        def timeout():
            self.clock.advance(5.2)
            raise module.ReadinessError('callback', 200, 'DependencyUnavailable')
        self.deps.both_ready = timeout
        for _ in range(3): self.assertFalse(supervisor.connect())
        self.assertEqual(supervisor.children, original)
        self.assertTrue(all(not child.stopped for child in original))
        slow = [r for r in self.logs() if r['event'] == 'moni-supervisor-callback-slow']
        self.assertEqual(len(slow), 1)
        self.assertEqual((slow[0]['latency_ms'], slow[0]['torn_down']), (5200, []))
        self.assertEqual(probes, [19464])
        self.assertFalse(any(r['event'] == 'moni-supervisor-reconnect' for r in self.logs()))

    def test_dead_callback_child_rebuilds_only_callback(self):
        supervisor = self.supervisor(); original = dict(supervisor._children)
        original['callback'].exit_code = 255
        self.assertTrue(supervisor.connect())
        for name, child in original.items():
            if name == 'callback': self.assertIsNot(supervisor._children[name], child)
            else: self.assertIs(supervisor._children[name], child)
        self.assertEqual(self.deps.events.count(('ensure', 'bx_moni')), 1)

    def test_refused_callback_rebuilds_only_callback_and_logs_no_private_values(self):
        supervisor = self.supervisor(); original = dict(supervisor._children)
        probes = []; self.deps.port_refused = lambda port: probes.append(port) or True
        self.deps.readiness_error = module.ReadinessError('callback', 200, 'DependencyUnavailable')
        for _ in range(3): self.assertFalse(supervisor.connect())
        self.assertEqual(probes, [19464])
        for name, child in original.items():
            self.assertEqual(child.stopped, name == 'callback')
            if name != 'callback': self.assertIs(supervisor._children[name], child)
        self.assertEqual(self.logs()[-1]['torn_down'], ['callback'])


class RunnerStatsTests(SupervisorTestCase):
    def stats(self, count=0):
        counts = {'authority-expired': count, 'disabled': 0, 'harness-exit': 0}
        return {'interruptions': {'total': dict(counts), 'last24h': dict(counts)}, 'autoRetry': {'retried': count},
                'lastInterruptionAt': 1000 if count else None, 'lastInterruptionReason': 'authority-expired' if count else None,
                'stuck': count, 'historySince': 100, 'legacyRetained': 0}

    def deps(self):
        deps = module.OffboxDeps.__new__(module.OffboxDeps)
        deps.config = {'boxId': 'bx_moni', 'epoch': 'test', 'url': 'unused', 'tokenFile': 'unused'}
        self.reply = {'boxId': 'bx_moni', 'epoch': 'test', 'routerReady': True, 'callbackReady': True}
        deps.post = lambda *args: self.reply
        return deps

    def test_logs_on_change_only_with_count_deltas_and_a_null_initial_baseline(self):
        deps = self.deps(); self.reply['stats'] = self.stats()
        deps.both_ready(); deps.both_ready()
        self.assertEqual(len(self.logs()), 1); self.assertIsNone(self.logs()[0]['deltas'])
        self.reply['stats'] = self.stats(2); deps.both_ready(); deps.both_ready()
        self.assertEqual(len(self.logs()), 2)
        self.assertEqual(self.logs()[-1]['deltas']['interruptions']['total']['authority-expired'], 2)
        self.assertEqual(self.logs()[-1]['deltas']['autoRetry']['retried'], 2)
        self.reply['stats']['interruptions']['last24h']['authority-expired'] = 0
        self.reply['stats']['stuck'] = 0; deps.both_ready()
        self.assertEqual(self.logs()[-1]['deltas']['interruptions']['last24h']['authority-expired'], -2)
        self.assertEqual(self.logs()[-1]['deltas']['stuck'], -2)

    def test_missing_and_invalid_stats_do_not_change_readiness_or_baseline(self):
        deps = self.deps(); deps.both_ready()
        for invalid in (None, [], True, {}, 'PRIVATE_TEXT'):
            self.reply['stats'] = invalid; deps.both_ready()
        for invalid in (-1, True, 1.5, 'PRIVATE_KEY', 9007199254740992, None, []):
            self.reply['stats'] = self.stats(); self.reply['stats']['autoRetry']['retried'] = invalid
            deps.both_ready()
        for at, reason in ((None, 'disabled'), (1000, None), (1000, 'PRIVATE_REASON'), (True, 'disabled')):
            self.reply['stats'] = self.stats(); self.reply['stats']['lastInterruptionAt'] = at
            self.reply['stats']['lastInterruptionReason'] = reason; deps.both_ready()
        self.assertEqual(self.logs(), [])
        self.reply['stats'] = self.stats(); deps.both_ready()
        self.reply['stats'] = {}; deps.both_ready()
        self.reply['stats'] = self.stats(); deps.both_ready()
        self.assertEqual(len(self.logs()), 1)

    def test_history_change_or_cumulative_counter_reset_starts_a_new_delta_baseline(self):
        for change in ('history', 'legacy', 'authority-expired', 'disabled', 'harness-exit', 'retry'):
            with self.subTest(change=change):
                previous = self.stats(2); current = self.stats(2)
                if change == 'history': current['historySince'] = 200
                elif change == 'legacy': current['legacyRetained'] = 1
                elif change == 'retry': current['autoRetry']['retried'] = 0
                else:
                    previous['interruptions']['total'][change] = 3
                    current['interruptions']['total'][change] = 2
                self.assertIsNone(module.stats_delta(current, previous))
                self.assertEqual(module.stats_delta(current, current)['autoRetry']['retried'], 0)

    def test_stats_are_logged_for_a_valid_lease_even_when_dependencies_are_unready(self):
        deps = self.deps(); self.reply['stats'] = self.stats(1)
        self.reply['callbackReady'] = False
        for _ in range(2):
            with self.assertRaises(module.ReadinessError): deps.both_ready()
        self.assertEqual(len(self.logs()), 1)
        self.assertEqual(self.logs()[0]['event'], 'moni-box-runner-stats')

    def test_only_whitelisted_metadata_is_copied_to_the_log(self):
        deps = self.deps(); stats = self.stats(1)
        stats['token'] = 'PRIVATE_TOKEN'; stats['id'] = 'PRIVATE_MESSAGE_ID'
        stats['autoRetry']['text'] = 'PRIVATE_TEXT'; stats['interruptions']['total']['PRIVATE_REASON'] = 3
        self.reply['stats'] = stats; deps.both_ready()
        self.assertEqual(self.logs()[0]['stats'], self.stats(1))
        self.assertNotIn('PRIVATE_', self.output.getvalue())


if __name__ == '__main__': unittest.main()
