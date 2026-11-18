"""Live output recovery exercises the sole writer and its committed stream offsets."""
import contextlib
import gc
import functools
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, live_logs, misc, runs
from test_capacity import Isolated


@contextlib.contextmanager
def history_order(first):
    original = live_logs.queue.Queue
    class Ordered(original):
        def __init__(self):
            super().__init__()
            self.first_ready = threading.Event()
        def put(self, item, *args, **kwargs):
            page = isinstance(item, tuple) and len(item) == 4
            if page and item[0] != first:
                if not self.first_ready.wait(2):
                    raise AssertionError('first history reader did not publish')
            super().put(item, *args, **kwargs)
            if page and item[0] == first:
                self.first_ready.set()
    with patch.object(live_logs.queue, 'Queue', Ordered):
        yield


def both_history_orders(test):
    @functools.wraps(test)
    def ordered(self):
        for first in (0, 1):
            with self.subTest(first=first), history_order(first):
                test(self)
    return ordered


@contextlib.contextmanager
def record_history_pages(pages):
    original = live_logs.pages
    def observed(*args, **kwargs):
        with contextlib.closing(original(*args, **kwargs)) as history:
            for i, page, error in history:
                if page is not None and page.get('data'):
                    pages.append((('stdout', 'stderr')[i], page['data'].encode()))
                yield i, page, error
    with patch.object(live_logs, 'pages', observed):
        yield


class LiveLogsTests(Isolated):
    def setUp(self):
        super().setUp()
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,start_at) "
                         "VALUES ('run-live','bx','cmd-live',7,'running','bg',1)")
        self.path = common.LOGS_DIR / 'run-live.log'
        self.path.touch()
        self.clock = [1000.0]
        self.real_time, self.real_call = time.time, api.call
        self.stack.enter_context(patch.object(runs, 'now', lambda: self.clock[0]))
        self.stack.enter_context(patch.object(live_logs.time, 'time', lambda: self.clock[0]))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline')))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-live'").fetchone()

    def history(self, box, cmd, stream, offset, **kw):
        data = {'stdout': b'out1\n', 'stderr': b'err1\n'}[stream]
        return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data), done=False)

    def test_silent_attach_polls_then_resumes_without_duplicate_bytes_on_both_backends(self):
        for backend in ('boat', 'server'):
            for first in (0, 1):
                with self.subTest(backend=backend, first=first), history_order(first):
                    self.path.write_bytes(b'')
                    common.offsets_path(self.path).unlink(missing_ok=True)
                    calls = []
                    initial = b'out1\nerr1\n' if first == 0 else b'err1\nout1\n'
                    def attach(box, pid, out, err, **kw):
                        calls.append((out, err))
                        if len(calls) == 1:
                            yield dict(type='hello')
                            self.clock[0] = kw['deadline']
                            raise api.StreamDeadline('silent stream, even with heartbeats')
                        self.assertEqual(self.path.read_bytes(), initial)
                        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=5, stderrOffset=5, logBytes=10))
                        self.assertLessEqual(self.clock[0] - began, 10)
                        yield dict(type='stdout', data='out2\n', nextOffset=10)
                        yield dict(type='stderr', data='err2\n', nextOffset=10)
                        yield dict(type='exit', exitCode=0)
                    began = self.clock[0]
                    with patch.object(api, 'BACKEND', backend), patch.object(api, 'cmd_attach', attach), \
                            patch.object(api, 'history_logs', side_effect=self.history):
                        self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live'), 0)
                    self.assertEqual(calls, [(0, 0), (5, 5)])
                    self.assertEqual(self.path.read_bytes(), initial + b'out2\nerr2\n')
                    self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=10, stderrOffset=10, logBytes=20))
                    events = [json.loads(line.removeprefix('follower '))['event'] for line in
                              (common.LOGS_DIR / 'run-live.client.log').read_text().splitlines()]
                    for event in ('attached', 'fallback', 'stream_silent', 'reconnect', 'first_byte', 'flush'):
                        self.assertIn(event, events)

    def test_queued_then_admitted_stream_fetches_output_after_the_queue_line(self):
        queue = 'offbox-server: waiting for earlier runs in the queue\n'
        calls = []
        def attach(box, pid, out, err, **kw):
            calls.append((out, err))
            if len(calls) == 1:
                yield dict(type='stderr', data=queue, nextOffset=len(queue))
                self.clock[0] = kw['deadline']
                raise api.StreamDeadline('heartbeats after admission')
            self.assertEqual(self.path.read_text(), queue + 'test passed\n')
            yield dict(type='exit', exitCode=0)
        def history(box, cmd, stream, offset, **kw):
            data = b'test passed\n' if stream == 'stdout' else queue.encode()
            return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data))
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_attach', attach), \
                patch.object(api, 'history_logs', history):
            self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live'), 0)
        self.assertEqual(calls, [(0, 0), (12, len(queue))])

    def test_silent_attach_history_keeps_retry_node_provenance(self):
        from offbox_lib import node_version, resources
        from test_node_version import node_receipt
        _, old = node_receipt('v24.22.1', 'run-live')
        facts, current = node_receipt('v24.22.3', 'run-live')
        first = old + 'offbox-command-started: run-live\n'
        last = current + 'offbox-command-started: run-live\n'
        calls = []
        def attach(box, pid, out, err, **kw):
            calls.append((out, err))
            if len(calls) == 1:
                yield dict(type='stderr', data=first, nextOffset=len(first.encode()),
                           attempt=1, commandId='cmd-live', nodeSetup=dict(stderrOffset=0))
                self.clock[0] = kw['deadline']
                raise api.StreamDeadline('silent stream after setup retry')
            yield dict(type='exit', exitCode=0)
        def history(box, cmd, stream, offset, **kw):
            raw = (first + last).encode() if stream == 'stderr' else b''
            return dict(data=raw[offset:].decode(), nextOffset=len(raw), size=len(raw),
                        attempt=2, commandId='cmd-live', nodeSetup=dict(stderrOffset=len(first.encode())))
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_attach', attach), \
                patch.object(api, 'history_logs', history):
            self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live'), 0)
        resources.finalize(dict(self.row()), node_only=True)
        self.assertEqual(common.read_json(self.path.with_suffix('.state.json'), {})['node'], facts)
        self.assertEqual(self.path.read_text(), first + last)
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=0, stderrOffset=len((first + last).encode()),
                                                          logBytes=len((first + last).encode())))
        self.assertEqual(common.read_json(self.path.with_suffix('.node-attempt.json'), {})['attempt'], 2)
        self.assertEqual(node_version.stderr_offset(self.path), len((first + last).encode()))

    def test_silent_attach_empty_retry_metadata_cannot_extend_history_deadline(self):
        from offbox_lib import node_version
        from test_node_version import node_receipt
        facts, _ = node_receipt('v24.22.1', 'run-live')
        runs.save_run_state('run-live', command_id='cmd-live', node=facts)
        runs.remember_interruption('run-live', dict(commandId='cmd-live', attempt=1,
                                                   nodeSetup=dict(stderrOffset=0)))
        runs.save_run_state('run-live', node=facts)
        calls, locks = [], []
        actual_lock = runs.file_lock
        @contextlib.contextmanager
        def contention(name, timeout=600):
            if name != 'run-state-run-live':
                with actual_lock(name, timeout=timeout) as held:
                    yield held
                return
            locks.append(timeout)
            self.clock[0] += timeout
            raise common.OffboxError('modeled isolated state lock contention')
            yield
        def attach(box, pid, out, err, **kw):
            calls.append((out, err))
            if len(calls) == 1:
                self.clock[0] = kw['deadline']
                raise api.StreamDeadline('silent stream after setup retry')
            yield dict(type='exit', exitCode=0)
        def history(box, cmd, stream, offset, **kw):
            return dict(data='', nextOffset=0, size=0, attempt=2,
                        commandId='cmd-live', nodeSetup=dict(stderrOffset=0))
        def advance(seconds):
            self.clock[0] += seconds
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_attach', attach), \
                patch.object(api, 'history_logs', history), patch.object(runs, 'file_lock', contention), \
                patch.object(runs.time, 'sleep', side_effect=advance):
            self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live'), 0)
        self.assertTrue(locks)
        self.assertEqual(set(locks), {0})
        self.assertLessEqual(self.clock[0], 1000 + live_logs.ATTACH_S + live_logs.HISTORY_S)
        self.assertEqual(common.read_json(self.path.with_suffix('.node-attempt.json'), {})['attempt'], 2)
        self.assertEqual(self.path.read_bytes(), b'')

    def test_successive_logs_advance_stderr_even_when_stdout_exceeds_its_page_budget(self):
        requests = []
        def history(box, cmd, stream, offset, **kw):
            requests.append((stream, offset, kw['limit_bytes']))
            if stream == 'stdout':
                self.clock[0] = kw['deadline']
                raise TimeoutError('slow stdout headers')
            self.clock[0] = kw['deadline']
            return dict(data='progress\n', nextOffset=offset + 9, size=offset + 18, done=False)
        with patch.object(api, 'history_logs', history):
            for count in (1, 2, 3):
                self.assertTrue(misc._catch_up_log(self.row(), budget=10, live=True).startswith('incomplete:'))
                self.assertEqual(self.path.read_bytes(), b'progress\n' * count)
                self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=0, stderrOffset=9*count, logBytes=9*count))
        self.assertEqual([offset for stream, offset, _ in requests if stream == 'stderr'], [0, 9, 18])
        self.assertTrue(all(limit == live_logs.PAGE_BYTES for _, _, limit in requests))

    def test_history_header_latency_cannot_permanently_starve_either_stream(self):
        for stream in ('stdout', 'stderr'):
            for latency in (3, 6, 9):
                with self.subTest(stream=stream, latency=latency):
                    self.path.write_bytes(b'')
                    common.offsets_path(self.path).unlink(missing_ok=True)
                    (common.LOGS_DIR / 'run-live.follower.json').unlink(missing_ok=True)
                    content = b''
                    def history(box, command, which, offset, **kw):
                        wait = latency if which == stream else 0
                        end = self.clock[0] + wait
                        if end > kw['deadline']:
                            self.clock[0] = kw['deadline']
                            raise TimeoutError('response headers delayed')
                        self.clock[0] = end
                        data = content if which == stream else b''
                        return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data))
                    with patch.object(api, 'history_logs', history):
                        for count in (1, 2, 3):
                            content += b'new output\n'
                            began = self.clock[0]
                            misc._catch_up_log(self.row(), budget=10, live=True)
                            self.assertLessEqual(self.clock[0] - began, 10)
                            self.assertEqual(self.path.read_bytes(), content)
                            self.assertEqual(common.checkpoint(self.path)[stream + 'Offset'], len(content))

    def test_three_second_http_headers_allow_plain_logs_and_silent_attach_recovery(self):
        real_time, real_call = self.real_time, self.real_call
        content = dict(stdout=b'', stderr=b'')
        delays = dict(stdout=3, stderr=0)
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                query = parse_qs(urlparse(self.path).query)
                which, offset = query['stream'][0], int(query['offset'][0])
                data = content[which]
                threading.Event().wait(delays[which])
                page = dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data), done=False)
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps(page).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def cleanup():
            server.shutdown()
            thread.join(2)
            server.server_close()
        self.addCleanup(cleanup)
        with patch.object(live_logs.time, 'time', real_time), patch.object(runs, 'now', real_time), \
                patch.object(api, 'call', real_call), patch.object(api, '_own_box'), \
                patch.object(api, '_key', return_value='isolated-fixture'), \
                patch.object(api, 'API', f'http://127.0.0.1:{server.server_port}'):
            for backend in ('boat', 'server'):
                with self.subTest(backend=backend):
                    self.path.write_bytes(b'')
                    common.offsets_path(self.path).unlink(missing_ok=True)
                    content.update(stdout=b'', stderr=b'')
                    delays.update(stdout=3, stderr=0)
                    with patch.object(api, 'BACKEND', backend):
                        for _ in range(2):
                            content['stdout'] += b'new stdout output\n'
                            self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'caught_up')
                            self.assertEqual(self.path.read_bytes(), content['stdout'])
                        content['stdout'] += b'fallback output\n'
                        calls = []
                        def attach(box, pid, out, err, **kw):
                            calls.append((out, err))
                            yield dict(type='hello')
                            if len(calls) == 1:
                                threading.Event().wait(max(0, kw['deadline'] - real_time()))
                                raise api.StreamDeadline('silent attach')
                            self.assertEqual(self.path.read_bytes(), content['stdout'])
                            yield dict(type='stdout', data='resumed\n', nextOffset=len(content['stdout']) + 8)
                            yield dict(type='exit', exitCode=0)
                        began = time.monotonic()
                        with patch.object(api, 'cmd_attach', attach):
                            self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live',
                                                        start_offsets=(36, 0)), 0)
                        self.assertLess(time.monotonic() - began, 10)
                        self.assertEqual(calls, [(36, 0), (len(content['stdout']), 0)])
                        self.assertEqual(self.path.read_bytes(), content['stdout'] + b'resumed\n')
                        self.assertEqual(common.checkpoint(self.path),
                                         dict(stdoutOffset=len(content['stdout']) + 8, stderrOffset=0,
                                              logBytes=len(content['stdout']) + 8))
                        for pair in ((9, 3), (3, 9)):
                            self.path.write_bytes(b'')
                            common.offsets_path(self.path).unlink(missing_ok=True)
                            delays.update(zip(('stdout', 'stderr'), pair))
                            content.update(stdout=b'', stderr=b'')
                            for _ in range(2):
                                content['stdout'] += b'output\n'
                                content['stderr'] += b'error\n'
                                began = time.monotonic()
                                self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'caught_up')
                                self.assertLess(time.monotonic() - began, 10.5)
                                self.assertEqual(common.checkpoint(self.path),
                                                 dict(stdoutOffset=len(content['stdout']), stderrOffset=len(content['stderr']),
                                                      logBytes=sum(map(len, content.values()))))
                                self.assertEqual(self.path.read_bytes().count(b'output\n'), len(content['stdout']) // 7)
                                self.assertEqual(self.path.read_bytes().count(b'error\n'), len(content['stderr']) // 6)

    def test_slow_history_pairs_both_advance_inside_the_shared_deadline(self):
        for delays in ((9, 3), (3, 9), (7, 4), (4, 7), (6, 6)):
            with self.subTest(delays=delays):
                self.path.write_bytes(b'')
                common.offsets_path(self.path).unlink(missing_ok=True)
                content = dict(stdout=b'out\n', stderr=b'err\n')
                def history(box, command, which, offset, **kw):
                    end = began + delays[which == 'stderr']
                    self.assertLessEqual(end, kw['deadline'])
                    self.clock[0] = max(self.clock[0], end)
                    data = content[which][offset:]
                    return dict(data=data.decode(), nextOffset=offset + len(data), size=len(content[which]))
                with patch.object(api, 'history_logs', history):
                    for _ in range(3):
                        content = {which: data + b'next\n' for which, data in content.items()}
                        began = self.clock[0]
                        self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'caught_up')
                        self.assertLessEqual(self.clock[0] - began, 10)
                        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=len(content['stdout']),
                                                                          stderrOffset=len(content['stderr']),
                                                                          logBytes=sum(map(len, content.values()))))

    def test_closing_history_iterator_cancels_its_readers_before_reattach(self):
        started = threading.Event()
        readers, scopes = [], []
        def history(box, command, which, offset, **kw):
            readers.append(threading.current_thread())
            scope = api._REQUEST_SCOPE.get()
            scopes.append(scope)
            if which == 'stdout':
                started.set()
                self.assertTrue(scope.stopped.wait(2))
                raise api.NetworkError('cancelled request')
            self.assertTrue(started.wait(2))
            return dict(data='error\n', nextOffset=6, size=6)
        with patch.object(api, 'history_logs', history):
            pages = live_logs.pages('bx', 'cmd-live', [0, 0], until=self.clock[0] + 10)
            self.assertEqual(next(pages)[:3], (1, dict(data='error\n', nextOffset=6, size=6), None))
            pages.close()
        self.assertEqual(len(readers), 2)
        self.assertTrue(all(scope.stopped.is_set() for scope in scopes))
        self.assertFalse(any(reader.is_alive() for reader in readers))

    def test_silent_attach_recovers_asymmetric_history_on_the_original_writer(self):
        owner = threading.get_ident()
        commit = runs._commit
        for delays in ((9, 3), (3, 9), (7, 4), (4, 7), (6, 6)):
            with self.subTest(delays=delays):
                self.path.write_bytes(b'')
                common.offsets_path(self.path).unlink(missing_ok=True)
                calls = []
                def checkpoint(*args):
                    self.assertEqual(threading.get_ident(), owner)
                    return commit(*args)
                def attach(box, pid, out, err, **kw):
                    nonlocal poll_began
                    calls.append((out, err))
                    if len(calls) == 1:
                        yield dict(type='hello')
                        self.clock[0] = poll_began = kw['deadline']
                        raise api.StreamDeadline('silent stream')
                    self.assertEqual((out, err), (4, 4))
                    self.assertEqual(self.path.read_bytes().count(b'out\n'), 1)
                    self.assertEqual(self.path.read_bytes().count(b'err\n'), 1)
                    yield dict(type='stdout', data='next\n', nextOffset=9)
                    yield dict(type='exit', exitCode=0)
                def history(box, command, which, offset, **kw):
                    self.clock[0] = max(self.clock[0], poll_began + delays[which == 'stderr'])
                    data = b'out\n' if which == 'stdout' else b'err\n'
                    return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data))
                poll_began = None
                with patch.object(api, 'cmd_attach', attach), patch.object(api, 'history_logs', history), \
                        patch.object(runs, '_commit', checkpoint):
                    self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live'), 0)
                self.assertEqual(len(calls), 2)
                self.assertTrue(self.path.read_bytes().endswith(b'next\n'))
                self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=9, stderrOffset=4, logBytes=13))

    def test_admission_and_failed_plain_flush_close_history_without_gc(self):
        class Timer:
            def __init__(self, *args):
                pass
            def start(self):
                pass
            def cancel(self):
                pass
        class Socket:
            def __init__(self):
                self.released = threading.Event()
            def shutdown(self):
                self.released.set()
        for backend in ('boat', 'server'):
            for path in ('admission', 'failed flush'):
                with self.subTest(backend=backend, path=path):
                    self.path.write_bytes(b'')
                    common.offsets_path(self.path).unlink(missing_ok=True)
                    readers = []
                    started = threading.Event()
                    marker = f'{runs.COMMAND_STARTED_MARKER} run-live\n'
                    cursors, calls = [], []
                    def attach(box, pid, out, err, **kw):
                        calls.append((out, err))
                        if len(calls) == 1:
                            yield dict(type='hello')
                            self.clock[0] = kw['deadline']
                            raise api.StreamDeadline('silent admission')
                        self.assertFalse(any(t.is_alive() for t, _, _ in readers))
                        yield dict(type='stdout', data='after\n', nextOffset=6)
                        yield dict(type='exit', exitCode=0)
                    def opening(req, timeout):
                        which = parse_qs(urlparse(req.full_url).query)['stream'][0]
                        scope = api._REQUEST_SCOPE.get()
                        while scope.parent is not None:
                            scope = scope.parent
                        sock = Socket()
                        scope.attach(sock)
                        readers.append((threading.current_thread(), scope, sock))
                        if which == 'stdout':
                            started.set()
                            self.assertTrue(sock.released.wait(2))
                            scope.check()
                            self.fail('cancelled reader continued')
                        self.assertTrue(started.wait(2))
                        return io.BytesIO(json.dumps(dict(data=marker, nextOffset=len(marker), size=len(marker))).encode())
                    enabled = gc.isenabled()
                    gc.disable()
                    try:
                        with patch.object(api, 'BACKEND', backend), patch.object(api, 'call', self.real_call), \
                                patch.object(api, '_own_box'), patch.object(api, '_key', return_value='fixture'), \
                                patch.object(api, '_open', opening), patch.object(api, 'cmd_attach', attach), \
                                patch.object(api, '_shutdown', lambda sock: sock.shutdown()), \
                                patch.object(api.threading, 'Timer', Timer):
                            if path == 'admission':
                                self.assertIs(runs.follow('bx', 7, self.path, echo=False, run_id='run-live',
                                                          until_command_started=True, admission_offsets=cursors), runs._COMMAND_RUNNING)
                            else:
                                with patch.object(runs, '_commit', side_effect=OSError('checkpoint unavailable')):
                                    with self.assertRaisesRegex(OSError, 'checkpoint unavailable'):
                                        misc._catch_up_live(self.row(), self.path, 10, None)
                            self.assertEqual(len(readers), 2)
                            self.assertTrue(all(scope.stopped.is_set() for _, scope, _ in readers))
                            self.assertFalse(any(t.is_alive() for t, _, _ in readers))
                            if path == 'admission':
                                runner = SimpleNamespace(box='bx', pid=7, run_id='run-live', log_path=self.path,
                                                         admission_offsets=cursors)
                                self.assertEqual(runs.Runner.stream(runner, echo=False), 0)
                                self.assertEqual(calls, [(0, 0), (0, len(marker))])
                                self.assertEqual(self.path.read_text(), marker + 'after\n')
                    finally:
                        with patch.object(api, '_shutdown', lambda sock: sock.shutdown()):
                            for _, scope, sock in readers:
                                scope.cancel()
                                sock.shutdown()
                        for reader, _, _ in readers:
                            reader.join(2)
                        if enabled:
                            gc.enable()

    def test_admission_continues_at_consumed_offsets_if_checkpoint_storage_failed(self):
        marker = f'{runs.COMMAND_STARTED_MARKER} run-live\n'
        offsets = []
        runs._commit(self.path, 0, 0, 0)
        def admission(*args, **kw):
            yield dict(type='stdout', data='prelude\n', nextOffset=8)
            yield dict(type='stderr', data=marker, nextOffset=len(marker))
        with patch.object(api, 'cmd_attach', admission), \
                patch.object(runs, 'atomic_write_json', side_effect=OSError('checkpoint storage unavailable')):
            self.assertIs(runs.follow('bx', 7, self.path, echo=False, run_id='run-live',
                                      until_command_started=True, admission_offsets=offsets), runs._COMMAND_RUNNING)
        self.assertEqual(common.checkpoint(self.path)['logBytes'], 0)
        def continuing(box, pid, out, err, **kw):
            self.assertEqual((out, err), (8, len(marker)))
            yield dict(type='stdout', data='new\n', nextOffset=12)
            yield dict(type='exit', exitCode=0)
        runner = SimpleNamespace(box='bx', pid=7, run_id='run-live', log_path=self.path, admission_offsets=offsets)
        with patch.object(api, 'cmd_attach', continuing):
            self.assertEqual(runs.Runner.stream(runner, echo=False), 0)
        self.assertEqual(self.path.read_text(), 'prelude\n' + marker + 'new\n')
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=12, stderrOffset=len(marker), logBytes=12 + len(marker)))

    def test_quiet_pages_are_caught_up_without_timeout_or_checkpoint_rewrite(self):
        runs._commit(self.path, 0, 0, 0)
        before = common.offsets_path(self.path).stat().st_mtime_ns
        with patch.object(api, 'history_logs', return_value=dict(data='', nextOffset=0, done=False)):
            self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'complete')
        self.assertEqual(common.offsets_path(self.path).stat().st_mtime_ns, before)

    def test_expired_budget_does_not_claim_an_unrequested_history_is_complete(self):
        with patch.object(api, 'history_logs') as fetch:
            self.assertEqual(misc._catch_up_log(self.row(), budget=0, live=True), 'incomplete:timeout')
        fetch.assert_not_called()
        self.assertEqual(self.path.read_bytes(), b'')

    def test_bounded_pages_advance_large_stdout_on_each_logs_call(self):
        data = b'x' * (live_logs.PAGE_BYTES * 2 + 7)
        def history(box, cmd, stream, offset, **kw):
            if stream == 'stderr':
                return dict(data='', nextOffset=0, size=0)
            # A full response would miss the caller's entire budget; the requested bound completes promptly.
            if kw.get('limit_bytes', len(data)) > live_logs.PAGE_BYTES:
                self.clock[0] += 11
                raise TimeoutError('full response is too slow')
            self.clock[0] += .5
            page = data[offset:offset + kw['limit_bytes']]
            return dict(data=page.decode(), nextOffset=offset + len(page), size=len(data))
        with patch.object(api, 'history_logs', history):
            for count, expected in enumerate((live_logs.PAGE_BYTES, live_logs.PAGE_BYTES * 2, len(data))):
                result = misc._catch_up_log(self.row(), budget=10, live=True)
                self.assertEqual(result, 'caught_up' if count == 2 else 'incomplete:more output available')
                self.assertEqual(self.path.read_bytes(), data[:expected])
                self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=expected, stderrOffset=0, logBytes=expected))
                state = common.read_json(common.LOGS_DIR / 'run-live.follower.json', {})
                self.assertEqual(state['remaining_bytes'], len(data) - expected if count < 2 else None)

    def test_invalid_checkpoints_are_not_used_as_remote_offsets(self):
        for checkpoint in ((-1, 0, 0), (0, -1, 0), (0, 0, -1), (1, 0, 1)):
            with self.subTest(checkpoint=checkpoint), patch.object(api, 'history_logs') as history:
                runs._commit(self.path, *checkpoint)
                self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'incomplete:invalid checkpoint')
                self.assertEqual(self.path.read_bytes(), b'')
                history.assert_not_called()

    def test_epoch_ticks_keep_terminal_probes_reachable_and_drain_history_first(self):
        for backend in ('boat', 'server'):
            for output in (b'', b'abc'):
                for terminal in (False, True):
                    with self.subTest(backend=backend, output=output, terminal=terminal):
                        self.path.write_bytes(b'')
                        calls = []
                        def attach(*args, **kw):
                            yield dict(type='hello')
                            self.clock[0] = kw['deadline']
                            raise api.StreamDeadline('no heartbeat or exit frame in this epoch')
                        def history(box, cmd, stream, offset, **kw):
                            data = output[offset:offset + 1] if stream == 'stdout' else b''
                            return dict(data=data.decode(), nextOffset=offset + len(data), size=len(output) if stream == 'stdout' else 0,
                                        done=terminal and offset + len(data) >= len(output), status='exited' if terminal else 'running')
                        def status(*args, **kw):
                            calls.append(common.checkpoint(self.path))
                            return dict(status='exited' if terminal else 'running', running=not terminal, exitCode=5 if terminal else None)
                        with patch.object(api, 'BACKEND', backend), patch.object(api, 'cmd_attach', attach), \
                                patch.object(api, 'history_logs', history), patch.object(api, 'cmd_status', status), \
                                patch.object(runs, 'QUIET_PROBE_S', 5):
                            if terminal:
                                self.assertEqual(runs.follow('bx', 7, self.path, echo=False, run_id='run-live', until=self.clock[0] + 40), 5)
                                self.assertEqual(self.path.read_bytes(), output)
                                if output:
                                    self.assertEqual(calls[-1]['stdoutOffset'], len(output))
                            else:
                                with self.assertRaises(common.OffboxError) as caught:
                                    runs.follow('bx', 7, self.path, echo=False, run_id='run-live', until=self.clock[0] + 20)
                                self.assertEqual(caught.exception.code, common.EXIT_WAIT_TIMEOUT)
                        self.assertGreaterEqual(len(calls), 2)

    def test_live_suffix_recovery_preserves_quiet_or_unavailable_uncommitted_bytes(self):
        cases = (
            ('recovered', b'rest\nmore\n', b'error\n', None, 'caught_up'),
            ('short nonmatching history', b'z', b'', None, 'incomplete:uncommitted suffix remains'),
            ('quiet sized', b'', b'', None, 'incomplete:history behind local log'),
            ('quiet no-size', b'', b'', False, 'incomplete:history behind local log'),
            ('unavailable', b'', b'', True, 'incomplete:history behind local log'),
        )
        for first in (0, 1):
            for name, stdout, stderr, failure, expected in cases:
                with self.subTest(name=name, first=first), history_order(first):
                    staged = self.path.with_name(self.path.name + '.recovery')
                    staged.unlink(missing_ok=True)
                    common.offsets_path(staged).unlink(missing_ok=True)
                    original = b'prefix\nrest\n'
                    self.path.write_bytes(original)
                    runs._commit(self.path, 7, 0, 7)
                    def history(box, cmd, stream, offset, **kw):
                        if failure is True:
                            raise common.OffboxError('unavailable')
                        data = b'prefix\n' + stdout if stream == 'stdout' else stderr
                        page = dict(data=data[offset:].decode(), nextOffset=len(data), done=False)
                        if failure is not False:
                            page['size'] = len(data)
                        return page
                    with patch.object(api, 'history_logs', side_effect=history) as fetch:
                        self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), expected)
                        self.assertEqual(fetch.call_count, 2)
                    if expected == 'caught_up':
                        self.assertEqual(self.path.read_bytes(), b'prefix\n' + (stdout + stderr if first == 0 else stderr + stdout))
                        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=17, stderrOffset=6, logBytes=23))
                    else:
                        self.assertEqual(self.path.read_bytes(), original)
                        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=7, stderrOffset=0, logBytes=7))

    def test_uncommitted_chunk_sizes_recover_across_successive_bounded_calls(self):
        limit = live_logs.PAGE_BYTES
        for stream in ('stdout', 'stderr'):
            for size in (1, limit - 1, limit, limit + 1, 2 * limit, 4 * limit):
                with self.subTest(stream=stream, size=size):
                    suffix = (b'o' if stream == 'stdout' else b'e') * size
                    expected = b'prefix\n' + suffix + b'new output\n'
                    original = b'prefix\n' + suffix
                    self.path.write_bytes(original)
                    runs._commit(self.path, 7, 0, 7)
                    requests = []
                    def history(box, command, which, offset, **kw):
                        requests.append((which, offset))
                        data = b'prefix\n' if which == 'stdout' else b''
                        if which == stream:
                            data += suffix + b'new output\n'
                        page = data[offset:offset + kw['limit_bytes']]
                        return dict(data=page.decode(), nextOffset=offset + len(page), size=len(data))
                    previous = 7 if stream == 'stdout' else 0
                    staged = self.path.with_name(self.path.name + '.recovery')
                    with patch.object(api, 'history_logs', history):
                        for _ in range(6):
                            result = misc._catch_up_log(self.row(), budget=10, live=True)
                            ck = common.checkpoint(self.path)
                            progress = common.checkpoint(staged) if staged.exists() else ck
                            self.assertGreater(progress[stream + 'Offset'], previous)
                            self.assertEqual(ck['stdoutOffset'] + ck['stderrOffset'], ck['logBytes'])
                            previous = progress[stream + 'Offset']
                            if result == 'caught_up':
                                break
                            self.assertTrue(result.startswith('incomplete:'), result)
                            self.assertTrue(self.path.read_bytes().startswith(original))
                        else:
                            self.fail('bounded recovery restarted instead of advancing')
                        self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'complete')
                    self.assertEqual(self.path.read_bytes(), expected)
                    self.assertFalse(staged.exists())
                    self.assertEqual(common.checkpoint(self.path), dict(
                        stdoutOffset=7 + (size + 11 if stream == 'stdout' else 0),
                        stderrOffset=size + 11 if stream == 'stderr' else 0, logBytes=len(expected)))
                    offsets = [offset for which, offset in requests if which == stream]
                    self.assertEqual(offsets, sorted(set(offsets[:-1])) + [offsets[-1]])

    @both_history_orders
    def test_interleaved_frames_after_failed_checkpoints_keep_recovery_progress(self):
        half = live_logs.PAGE_BYTES // 2
        cases = (
            [('stdout', b'o' * half), ('stderr', b'e' * (2 * half)), ('stdout', b'o' * (3 * half))],
            [('stderr', b'e' * half), ('stdout', b'o' * (2 * half)), ('stderr', b'e' * (3 * half))],
            [('stdout', b'o' * half), ('stderr', b'e' * half)] * 4,
            [('stdout', b'a' * half), ('stderr', b'a' * (2 * half)), ('stdout', b'b' * (3 * half))],
        )
        class ClientDied(BaseException):
            pass
        for chunks in cases:
            with self.subTest(chunks=[(which, data[:1], len(data)) for which, data in chunks]):
                self.path.write_bytes(b'prefix\n')
                runs._commit(self.path, 7, 0, 7)
                def attach(*args, **kw):
                    offsets = dict(stdout=7, stderr=0)
                    for which, data in chunks:
                        offsets[which] += len(data)
                        yield dict(type=which, data=data.decode(), nextOffset=offsets[which])
                    raise ClientDied()
                with patch.object(api, 'cmd_attach', attach), \
                        patch.object(runs, 'atomic_write_json', side_effect=OSError('checkpoint disk unavailable')):
                    with self.assertRaises(ClientDied):
                        runs.follow('bx', 7, self.path, echo=False, run_id='run-live', start_offsets=(7, 0))
                original = b'prefix\n' + b''.join(data for _, data in chunks)
                self.assertEqual(self.path.read_bytes(), original)
                base = dict(stdoutOffset=7, stderrOffset=0, logBytes=7)
                self.assertEqual(common.checkpoint(self.path), base)
                streams = dict(stdout=b'prefix\n' + b''.join(data for which, data in chunks if which == 'stdout') + b'new output\n',
                               stderr=b''.join(data for which, data in chunks if which == 'stderr'))
                requests, recovered_pages = [], []
                def history(box, command, which, offset, **kw):
                    data = streams[which][offset:offset + kw['limit_bytes']]
                    if data:
                        requests.append((which, offset))
                    return dict(data=data.decode(), nextOffset=offset + len(data), size=len(streams[which]))
                staged = self.path.with_name(self.path.name + '.recovery')
                previous = 0
                with patch.object(api, 'history_logs', history), record_history_pages(recovered_pages):
                    for call in range(6):
                        result = misc._catch_up_log(self.row(), budget=10, live=True)
                        if result == 'caught_up':
                            break
                        if staged.exists():
                            size = common.checkpoint(staged)['logBytes']
                            self.assertGreater(size, previous)
                            previous = size
                            self.assertEqual(self.path.read_bytes(), original)
                            self.assertEqual(common.checkpoint(self.path), base)
                            # A flushed staging page whose checkpoint failed is discarded on resume, not replayed.
                            with staged.open('ab') as pending:
                                pending.write(b'uncommitted staging bytes')
                    else:
                        self.fail('interleaved recovery did not finish')
                for stream in ('stdout', 'stderr'):
                    self.assertEqual(b''.join(data for which, data in recovered_pages if which == stream),
                                     streams[stream][base[stream + 'Offset']:])
                self.assertEqual(self.path.read_bytes(), b'prefix\n' + b''.join(data for _, data in recovered_pages))
                expected = dict(stdoutOffset=len(streams['stdout']), stderrOffset=len(streams['stderr']),
                                logBytes=sum(map(len, streams.values())))
                self.assertEqual(common.checkpoint(self.path), expected)
                self.assertEqual(self.path.read_bytes().count(b'new output\n'), 1)
                self.assertEqual(len(requests), len(set(requests)))
                self.assertFalse(staged.exists())

    @both_history_orders
    def test_stale_or_incomplete_staging_restarts_from_the_current_log_checkpoint(self):
        for failure in ('missing checkpoint', 'invalid checkpoint', 'short file', 'replaced source', 'advanced checkpoint', 'new command'):
            with self.subTest(failure=failure):
                stdout, stderr = b'o' * (2 * live_logs.PAGE_BYTES), b'e' * live_logs.PAGE_BYTES
                original = b'prefix\n' + stdout[:32768] + stderr + stdout[32768:]
                self.path.write_bytes(original)
                runs._commit(self.path, 7, 0, 7)
                requests, pages = [], []
                def history(box, command, which, offset, **kw):
                    requests.append((which, offset))
                    content = b'prefix\n' + stdout + b'new output\n' if which == 'stdout' else stderr
                    data = content[offset:offset + kw['limit_bytes']]
                    return dict(data=data.decode(), nextOffset=offset + len(data), size=len(content))
                staged = self.path.with_name(self.path.name + '.recovery')
                with patch.object(api, 'history_logs', history), record_history_pages(pages):
                    self.assertEqual(misc._catch_up_log(self.row(), budget=10, live=True), 'incomplete:uncommitted suffix remains')
                    self.assertEqual(self.path.read_bytes(), original)
                    if failure == 'missing checkpoint':
                        common.offsets_path(staged).unlink()
                    elif failure == 'invalid checkpoint':
                        saved = common.read_json(common.offsets_path(staged), {})
                        saved['logBytes'] = 'invalid'
                        common.atomic_write_json(common.offsets_path(staged), saved)
                    elif failure == 'short file':
                        staged.write_bytes(b'x')
                    elif failure == 'replaced source':
                        replacement = self.path.with_name('replacement')
                        replacement.write_bytes(original)
                        replacement.replace(self.path)
                    elif failure == 'advanced checkpoint':
                        runs._commit(self.path, 8, 0, 8)
                    else:
                        self.con.execute("UPDATE runs SET command_id=command_id || '-new' WHERE run_id='run-live'")
                    base = common.checkpoint(self.path)
                    requests.clear()
                    pages.clear()
                    for _ in range(4):
                        if misc._catch_up_log(self.row(), budget=10, live=True) == 'caught_up':
                            break
                    else:
                        self.fail('invalid staging prevented recovery')
                for stream in ('stdout', 'stderr'):
                    self.assertEqual(next(offset for which, offset in requests if which == stream), base[stream + 'Offset'])
                for stream, content in (('stdout', b'prefix\n' + stdout + b'new output\n'), ('stderr', stderr)):
                    self.assertEqual(b''.join(data for which, data in pages if which == stream),
                                     content[base[stream + 'Offset']:])
                self.assertEqual(self.path.read_bytes(), original[:base['logBytes']] + b''.join(data for _, data in pages))
                self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=7 + len(stdout) + 11,
                                                                  stderrOffset=len(stderr), logBytes=len(original) + 11))
                self.assertFalse(staged.exists())

    def test_failed_attach_and_history_epochs_reach_the_existing_outage_limit(self):
        for backend, window in (('server', 15), ('boat', 30)):
            with self.subTest(backend=backend):
                began = self.clock[0]
                requests = dict(attach=0, history=0, status=0)
                class Event:
                    stopped = False
                    def is_set(self):
                        return self.stopped
                    def set(self):
                        self.stopped = True
                    def wait(event, seconds):
                        self.clock[0] += seconds
                        return event.stopped
                def attach(*args, **kw):
                    requests['attach'] += 1
                    self.clock[0] = kw['deadline']
                    raise TimeoutError('no HTTP response headers')
                def history(*args, **kw):
                    requests['history'] += 1
                    self.clock[0] = kw['deadline']
                    raise api.NetworkError('history unavailable')
                def status(*args, **kw):
                    requests['status'] += 1
                    raise api.NetworkError('status unavailable')
                with patch.object(api, 'BACKEND', backend), patch.object(api, 'cmd_attach', attach), \
                        patch.object(api, 'history_logs', history), patch.object(api, 'cmd_status', status), \
                        patch.object(runs, 'HOME_RECONNECT_S', 15), patch.object(runs, 'OUTAGE_FOLLOW_S', 30):
                    with self.assertRaises(common.OffboxError) as caught:
                        runs.follow('bx', 7, self.path, echo=False, run_id='run-live', stop_evt=Event())
                self.assertEqual(caught.exception.code, common.EXIT_INFRA)
                self.assertIn(f'API was down for {window}s', str(caught.exception))
                self.assertLessEqual(self.clock[0] - began, window + 2 * (live_logs.ATTACH_S + live_logs.HISTORY_S))
                self.assertGreater(requests['attach'], 1)
                self.assertGreaterEqual(requests['history'], requests['attach'])
                self.assertLessEqual(requests['history'], 2 * requests['attach'])
                self.assertGreater(requests['status'], 0)

    def test_takeover_waits_for_inflight_logs_and_uses_its_new_checkpoint(self):
        requested, attempted, release = threading.Event(), threading.Event(), threading.Event()
        failures = []
        def history(box, cmd, stream, offset, **kw):
            if stream == 'stdout':
                requested.set()
                self.assertTrue(release.wait(3))
                return dict(data='prefix\n', nextOffset=7, size=7)
            return dict(data='', nextOffset=0, size=0)
        row = dict(self.row())
        def fetch():
            try:
                misc._catch_up_log(row, budget=10, live=True)
            except BaseException as error:
                failures.append(error)
        def resolve(row, path, until, start, replay, **kw):
            self.assertEqual(start, (7, 0))
            def attach(*args, **kw):
                yield dict(type='stderr', data='after\n', nextOffset=6)
                yield dict(type='exit', exitCode=0)
            with patch.object(api, 'cmd_attach', attach):
                return runs.follow('bx', 7, path, echo=False, run_id='run-live', start_offsets=start,
                                   replay_path=replay, mirror_path=path, mirror_keep=7)
        real_lock = runs.log_lock
        @contextlib.contextmanager
        def lock(*args, **kw):
            if threading.current_thread().name == 'takeover':
                attempted.set()
            with real_lock(*args, **kw) as waited:
                yield waited
        def take():
            try:
                misc._replay_takeover(row, False, None, (0, 0), self.path, 0)
            except BaseException as error:
                failures.append(error)
        with patch.object(api, 'history_logs', history), patch.object(runs, 'log_lock', lock), \
                patch.object(misc, '_resolve_exit', resolve), patch.object(misc, '_finalize', return_value=0):
            reader = threading.Thread(target=fetch)
            takeover = threading.Thread(target=take, name='takeover')
            reader.start()
            try:
                self.assertTrue(requested.wait(3))
                takeover.start()
                self.assertTrue(attempted.wait(3))
            finally:
                release.set()
                reader.join(4)
                if takeover.ident:
                    takeover.join(4)
            self.assertFalse(reader.is_alive())
            self.assertFalse(takeover.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(self.path.read_bytes(), b'prefix\nafter\n')
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=7, stderrOffset=6, logBytes=13))
