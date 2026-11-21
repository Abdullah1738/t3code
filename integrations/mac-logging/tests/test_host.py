import ctypes as c
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import host
import host_native as native
import host_signal
import cpu
from process_argv import decode_args


def fake():
    vm = dict(pageSize=16384, freePages=10, activePages=20, inactivePages=30,
              compressedPages=40, pageins=100, pageouts=200, swapins=300, swapouts=400)
    return SimpleNamespace(swap=lambda: dict(swapTotalBytes=1000, swapUsedBytes=600, swapAvailableBytes=400),
        sysctl=lambda _: c.c_uint32(1), vm=lambda: vm.copy(), pids=lambda: [1, 2],
        states=lambda _: dict(runnable=1, uninterruptible=0, stateScanTimedOut=False))


class HostTests(unittest.TestCase):
    def test_vm_abi_and_read(self):
        self.assertEqual(c.sizeof(native.SwapUsage), 32)
        self.assertEqual(c.sizeof(native.VmStatistics64), 152)
        self.assertEqual(native.VmStatistics64.swapins.offset, 112)
        self.assertEqual(c.sizeof(native.ThreadInfo), 112)
        def read(port, flavor, target, count):
            self.assertEqual((port, flavor), (7, 4))
            self.assertEqual(c.cast(count, c.POINTER(c.c_uint))[0], 38)
            value = c.cast(target, c.POINTER(native.VmStatistics64)).contents
            value.free, value.compressed, value.swapins = 10, 20, 2**40
            return 0
        result = native.vm_statistics(read, 7)
        self.assertEqual((result['freePages'], result['compressedPages'], result['swapins']), (10, 20, 2**40))
        def short(*args):
            c.cast(args[3], c.POINTER(c.c_uint))[0] = 1
            return 0
        for broken in (lambda *a: 1, short):
            with self.subTest(broken=broken), self.assertRaises(ValueError): native.vm_statistics(broken, 7)

    def test_sysctl_bytes_and_failures(self):
        n = native.Native.__new__(native.Native)
        def read(name, target, size, new, length):
            self.assertEqual(name, b'vm.swapusage')
            value = c.cast(target, c.POINTER(native.SwapUsage)).contents
            value.total, value.used, value.available = 2**40, 2**39, 2**39
            return 0
        n.system = SimpleNamespace(sysctlbyname=read)
        self.assertEqual(n.swap()['swapUsedBytes'], 2**39)
        n.system.sysctlbyname = lambda *a: -1
        with self.assertRaises(OSError): n.swap()
        def short(*args):
            c.cast(args[2], c.POINTER(c.c_size_t))[0] = 4
            return 0
        n.system.sysctlbyname = short
        with self.assertRaises(ValueError): n.swap()

    def test_pid_inventory_returned_count_and_truncation(self):
        n = native.Native.__new__(native.Native)
        def pids(buf, size):
            if buf is None: return 10
            buf[:4] = [0, 1, 10, 20]
            return 4
        n.proc = SimpleNamespace(proc_listallpids=pids)
        self.assertEqual(n.pids(), [1, 10, 20])
        self.assertEqual(n.process_count(), 3)
        for value in (-1, 0, 9999):
            n.proc.proc_listallpids = lambda buf, size: 1 if buf is None else value
            with self.subTest(value=value), self.assertRaises(OSError): n.pids()

    def test_thread_states_process_counts_and_partial_coverage(self):
        n = native.Native.__new__(native.Native)
        def info(pid, flavor, tid, target, size):
            if pid == 3: return 0
            if flavor == 6:
                target[:3] = [1, 2, 3]
                return 24
            value = c.cast(target, c.POINTER(native.ThreadInfo)).contents
            value.runState = 1 if tid in (1, 2) else 4
            return c.sizeof(value)
        n.proc = SimpleNamespace(proc_pidinfo=info)
        result = n.states([1, 2, 3])
        self.assertEqual((result['runnable'], result['uninterruptible'], result['runnableThreads']), (2, 2, 4))
        self.assertEqual(result['stateProcessesSkipped'], 1)
        self.assertTrue(result['stateScanPartial'])
        self.assertFalse(result['stateScanTimedOut'])
        times = iter([0, 3, 3, 3])
        result = n.states([1], clock=lambda: next(times))
        self.assertTrue(result['stateScanTimedOut'])
        self.assertEqual(result['stateProcessesRead'], 0)

    def test_deltas_baseline_reset_and_failure(self):
        n = fake(); times = iter([0, 30, 60, 90])
        sampler = host.Sampler(n, clock=lambda: next(times))
        self.assertIsNone(sampler.tick()['swapinsDelta'])
        vm = n.vm();vm['swapins'] += 7;n.vm = lambda: vm.copy()
        self.assertEqual(sampler.tick()['swapinsDelta'], 7)
        vm['swapins'] = 1
        self.assertIsNone(sampler.tick()['swapinsDelta'])
        n.swap = Mock(side_effect=OSError())
        result = sampler.tick()
        self.assertIsNone(result['swapUsedBytes'])
        self.assertIn('swap', result['errors'])
        self.assertEqual(result['processCount'], 2)

    def test_slow_states_disabled(self):
        n = fake();n.states = Mock(return_value=dict(stateScanTimedOut=True))
        monitor = host.StateMonitor(n)
        monitor.loop(threading.Event())
        sampler = host.Sampler(fake(), states=monitor)
        self.assertFalse(sampler.tick()['statesEnabled'])
        self.assertFalse(sampler.tick()['statesAvailable'])
        self.assertEqual(sampler.tick()['processCount'], 2)
        n.states.assert_called_once()

    def test_state_snapshot_expires(self):
        clock = [0]
        monitor = host.StateMonitor(fake(), clock=lambda: clock[0])
        monitor.latest = (0, dict(runnable=9))
        self.assertEqual(monitor.snapshot()['runnable'], 9)
        clock[0] = 33
        self.assertFalse(monitor.snapshot()['statesAvailable'])
        self.assertNotIn('runnable', monitor.snapshot())
        self.assertEqual(monitor.snapshot()['stateAgeS'], 33)

    def test_python_input_forms(self):
        cases = [
            ('script', ['Python', '/a/offbox.py', 'argument.py'], 'python:offbox.py'),
            ('separate flags', ['python3', '-I', '-u', '/a/tool.py'], 'python:tool.py'),
            ('bundled flags', ['python3', '-Iu', 'tool.py'], 'python:tool.py'),
            ('code separate', ['python3', '-c', 'pass', 'argument.py'], 'python'),
            ('code attached', ['python3', '-cpass', 'argument.py'], 'python'),
            ('code bundled separate', ['python3', '-Ic', 'pass', 'argument.py'], 'python'),
            ('code bundled attached', ['python3', '-Iucpass', 'argument.py'], 'python'),
            ('module separate', ['python3', '-m', 'package.main', 'argument.py'], 'python:package.main'),
            ('module attached', ['python3', '-mpackage.main', 'argument.py'], 'python:package.main'),
            ('module bundled separate', ['python3', '-Ium', 'package.main', 'argument.py'], 'python:package.main'),
            ('module bundled attached', ['python3', '-Iumpackage.main', 'argument.py'], 'python:package.main'),
            ('warning separate', ['python3', '-W', 'ignore', 'tool.py'], 'python:tool.py'),
            ('warning attached', ['python3', '-Wignore', 'tool.py'], 'python:tool.py'),
            ('warning bundled separate', ['python3', '-IW', 'ignore', 'tool.py'], 'python:tool.py'),
            ('warning bundled attached', ['python3', '-IWignore', 'tool.py'], 'python:tool.py'),
            ('xoption separate', ['python3', '-X', 'dev', 'tool.py'], 'python:tool.py'),
            ('xoption attached', ['python3', '-Xdev', 'tool.py'], 'python:tool.py'),
            ('xoption bundled separate', ['python3', '-IX', 'dev', 'tool.py'], 'python:tool.py'),
            ('xoption bundled attached', ['python3', '-IXdev', 'tool.py'], 'python:tool.py'),
            ('hash policy separate', ['python3', '--check-hash-based-pycs', 'always', 'tool.py'], 'python:tool.py'),
            ('hash policy equals', ['python3', '--check-hash-based-pycs=always', 'tool.py'], 'python:tool.py'),
            ('invalid hash policy', ['python3', '--check-hash-based-pycs', 'bad', 'tool.py'], 'python'),
            ('stdin', ['python3', '-', 'argument.py'], 'python'),
            ('sentinel', ['python3', '--', '/a/tool.py'], 'python:tool.py'),
            ('sentinel whitespace', ['python3', '--', '/a/space name.py'], 'python'),
            ('option terminator', ['python3', '--', '-cpass'], 'python'),
            ('unknown long option', ['python3', '--unknown', 'tool.py'], 'python'),
            ('unknown short option', ['python3', '-j', 'tool.py'], 'python'),
            ('exit option', ['python3', '-V', 'tool.py'], 'python'),
            ('help option', ['python3', '--help', 'tool.py'], 'python'),
            ('no program', ['python3'], 'python'),
            ('missing code', ['python3', '-c'], 'python'),
            ('missing module', ['python3', '-m'], 'python'),
            ('invalid module', ['python3', '-m', '/a/tool.py'], 'python'),
        ]
        for form, argv, expected in cases:
            with self.subTest(form=form, argv=argv):
                self.assertEqual(host.python_label(argv), expected)

    def test_families_counts_and_argv_fallback(self):
        n = SimpleNamespace(pids=lambda: [1, 2, 3, 4, 5, 6],
            name=lambda p: {1:'claude', 2:'Python', 3:'node', 4:'cua-driver', 5:'Python', 6:'node'}[p],
            argv=lambda p: ['python3', '/a/a.py'] if p == 2 else (_ for _ in ()).throw(OSError()))
        result = host.families(n)
        self.assertEqual({r['name']:r['count'] for r in result['families']},
            {'claude':1, 'python:a.py':1, 'python':1, 'node':2, 'cua-driver':1})
        self.assertTrue(all(set(r) == {'name', 'count'} for r in result['families']))

    def test_native_name_and_argv(self):
        n = native.Native.__new__(native.Native)
        def name(pid, buf, size): buf.value = b'Python';return 6
        executable = b'/bin/python3\0'
        data = (2).to_bytes(4, sys.byteorder)+executable+b'\0'*((-len(executable))%8)+b'python3\0/a/tool.py\0SECRET=private\0'
        def args(mib, count, buf, size, new, newsize):
            self.assertEqual(list(mib), [1, 49, 10])
            c.memmove(buf, data, len(data));c.cast(size, c.POINTER(c.c_size_t))[0] = len(data)
            return 0
        n.proc = SimpleNamespace(proc_name=name);n.system = SimpleNamespace(sysctl=args)
        self.assertEqual(n.name(10), 'Python')
        self.assertEqual(n.argv(10), ['python3', '/a/tool.py'])
        with self.assertRaises(ValueError): decode_args(b'broken')

    def test_writer_schema_and_redaction(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, TOOLLOG_DIR=root):
            p = host.Sampler(fake()).tick();p['trigger'] = 'cpu.timeout'
            host.write_sample('host.vitals', p)
            host.write_sample('host.families_lite', dict(families=[dict(name='node', count=3, cpu=200),
                dict(name='password=private', count=1)], private='private'))
            rows = [json.loads(line) for path in Path(root).glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertEqual(rows[0]['props']['trigger'], 'cpu.timeout')
            self.assertEqual(rows[0]['props']['processCount'], 2)
            self.assertNotIn('private', json.dumps(rows))
            self.assertEqual(rows[1]['props']['families'], [dict(name='[redacted]', count=1), dict(name='node', count=3)])

    def test_cpu_hang_keeps_ticks_and_timeout_wakes(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, TOOLLOG_DIR=root,
                MAC_HOST_SOCKET=str(Path(root)/'host.sock')):
            server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM);self.addCleanup(server.close)
            server.bind(str(host_signal.socket_path()));server.setblocking(False)
            stop = threading.Event();entered = threading.Event();release = threading.Event()
            writes = [];second = threading.Event();triggered = threading.Event()
            def writer(name, props, duration):
                host.write_sample(name, props, duration);writes.append(props)
                if len(writes) >= 2: second.set()
                if props.get('trigger'): triggered.set()
            def hanging(*args, **kwargs):
                entered.set();release.wait(3);raise subprocess.TimeoutExpired('ps', 30)
            sampler = threading.Thread(target=host.serve, args=(host.Sampler(fake()), server, stop),
                kwargs=dict(interval=.04, duration=1, writer=writer))
            cpu_thread = threading.Thread(target=lambda: cpu.sample(run=hanging, reader_factory=lambda:False))
            with patch.object(host.os, 'fork', side_effect=AssertionError('forked')), patch.object(subprocess, 'Popen', side_effect=AssertionError('spawned')):
                sampler.start();cpu_thread.start()
                try:
                    self.assertTrue(entered.wait(1));self.assertTrue(second.wait(1));self.assertTrue(cpu_thread.is_alive())
                    release.set();self.assertTrue(triggered.wait(1))
                finally:
                    release.set();stop.set();host_signal.notify_cpu_timeout();sampler.join(2);cpu_thread.join(2)
            self.assertFalse(sampler.is_alive());self.assertFalse(cpu_thread.is_alive())
            events = [json.loads(line) for path in Path(root).glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertGreaterEqual(sum(row['name']=='host.vitals' for row in events), 3)
            self.assertTrue(any(row.get('error',{}).get('tag')=='cpu.timeout' for row in events))

    def test_blocked_proc_pidinfo_never_holds_vitals(self):
        entered = threading.Event();release = threading.Event();stop = threading.Event()
        n = native.Native.__new__(native.Native)
        n.pids = lambda: [1]
        def blocked(*args):
            entered.set();release.wait(3)
            return 0
        n.proc = SimpleNamespace(proc_pidinfo=blocked)
        monitor = host.StateMonitor(n)
        worker = threading.Thread(target=monitor.loop, args=(stop,), daemon=True)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, TOOLLOG_DIR=root):
            server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            self.addCleanup(server.close)
            server.bind(str(Path(root)/'states.sock'));server.setblocking(False)
            written = threading.Event();count = [0]
            def writer(name, props, duration):
                host.write_sample(name, props, duration);count[0] += 1
                if count[0] >= 2: written.set()
            sampler = threading.Thread(target=host.serve, args=(host.Sampler(fake(), states=monitor), server, stop),
                kwargs=dict(interval=.02, duration=1, writer=writer))
            worker.start()
            try:
                self.assertTrue(entered.wait(1));sampler.start()
                self.assertTrue(written.wait(1));self.assertTrue(worker.is_alive())
                rows = [json.loads(line) for path in Path(root).glob('*.ndjson') for line in path.read_text().splitlines()]
                self.assertGreaterEqual(len(rows), 2)
                self.assertTrue(all(not r['props']['statesAvailable'] and r['props']['processCount']==2 for r in rows))
            finally:
                stop.set();release.set();worker.join(2)
                if sampler.ident is not None: sampler.join(2)
            self.assertFalse(worker.is_alive());self.assertFalse(sampler.is_alive())

    def test_family_truncation_reports_missing_counts(self):
        import toollog
        for size in (0, 512, 513, 600):
            with self.subTest(size=size):
                data = dict(families=[dict(name='name'+str(i), count=2) for i in range(size)],
                            processesRead=2*size, partial=False)
                result = toollog.host_fields(data, 'host.families_lite')
                self.assertEqual(sum(r['count'] for r in result['families'])+result.get('processesOmitted', 0), 2*size)
                self.assertEqual(result['partial'], size>512)
                if size>512: self.assertEqual(result['familiesOmitted'], size-512)

    def test_trigger_does_not_wait_for_30_second_tick(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, MAC_HOST_SOCKET=str(Path(root)/'host.sock')):
            server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            self.addCleanup(server.close)
            server.bind(str(host_signal.socket_path()));server.setblocking(False)
            stop = threading.Event();triggered = threading.Event()
            def writer(name, props, duration):
                if props.get('trigger') == 'cpu.timeout':
                    triggered.set();stop.set()
                else:
                    self.assertTrue(host_signal.notify_cpu_timeout())
            thread = threading.Thread(target=host.serve, args=(host.Sampler(fake()), server, stop),
                kwargs=dict(interval=30, duration=1, writer=writer))
            thread.start();thread.join(2)
            self.assertFalse(thread.is_alive());self.assertTrue(triggered.is_set())

    def test_host_heartbeat_survives_day_cap(self):
        import toollog
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, TOOLLOG_DIR=root), patch.object(toollog, 'CAP_BYTES', 0):
            self.assertTrue(host.write_sample('host.vitals', host.Sampler(fake()).tick()))
            rows = [json.loads(line) for path in Path(root).glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertEqual([r['name'] for r in rows], ['log.cap', 'host.vitals'])

    def test_signal_missing_listener_and_launchd(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, MAC_HOST_SOCKET=str(Path(root)/'missing.sock')):
            self.assertFalse(host_signal.notify_cpu_timeout())
        data = plistlib.loads((HERE/'launchd/com.abdullah.mac-host.plist').read_bytes())
        self.assertTrue(data['KeepAlive']);self.assertEqual(data['ProcessType'], 'Standard')
        self.assertNotIn('StartInterval', data)


if __name__ == '__main__': unittest.main()
