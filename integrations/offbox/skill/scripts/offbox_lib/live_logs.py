"""Bound silent attaches without introducing another log writer."""
import contextlib
import contextvars
import json
import queue
import threading
import time

from . import api, common

ATTACH_S = 5
HISTORY_S = 10
PAGE_BYTES = 64 * 1024


def note(run_id, kind, *, directory=None, **details):
    if not run_id:
        return
    with contextlib.suppress(OSError, ValueError, TypeError):
        directory = directory or common.LOGS_DIR
        path = directory / f'{run_id}.follower.json'
        state = common.read_json(path, {})
        state.update(event=kind, at=common.now(), **details)
        if kind == 'flush':
            state['last_write'] = state['at']
            state['remaining_bytes'] = None
        if kind == 'backlog':
            state['backlog_at'] = state['at']
        if kind == 'stream_silent':
            state['server_output_at'] = state['at']
        common.atomic_write_json(path, state)
        line = 'follower ' + json.dumps(dict(run_id=run_id, event=kind, at=state['at'], **details), separators=(',', ':'))
        common.log(line)
        with (directory / f'{run_id}.client.log').open('a') as dst:
            dst.write(line + '\n')


def pages(box, command, offsets, *, until, clock=None, stats=None):
    """Fetch both streams inside one deadline; only the caller may write the returned pages."""
    clock = clock or time.time
    if clock() >= until:
        return
    ready, stopped = queue.Queue(), threading.Event()
    scopes = [api.RequestScope(max(.001, until - clock()), parent=api._REQUEST_SCOPE.get()) for _ in offsets]
    def fetch(i):
        cursor, remaining, snapshot = offsets[i], PAGE_BYTES, None
        first = True
        try:
            with scopes[i].active():
                while not stopped.is_set() and remaining > 0 and (first or clock() < until):
                    first = False
                    started = time.monotonic()
                    page, error, data = None, None, b''
                    try:
                        page = api.history_logs(box, command, ('stdout', 'stderr')[i], cursor,
                                                deadline=until, limit_bytes=remaining)
                        if clock() > until:
                            raise TimeoutError('history page deadline passed')
                        data = (page.get('data') or '').encode()
                        nxt = int(page.get('nextOffset', cursor + len(data)))
                        if nxt != cursor + len(data):
                            raise common.OffboxError('invalid history offset')
                        if snapshot is None and page.get('size') is not None:
                            snapshot = int(page['size'])
                    except (common.OffboxError, OSError, ValueError, TypeError) as failure:
                        page, error = None, 'timeout' if clock() >= until else str(failure)
                    elapsed = round((time.monotonic() - started) * 1000, 3)
                    ready.put((i, page, error, elapsed))
                    if error or not data or page.get('done') or snapshot is not None and nxt >= snapshot:
                        break
                    cursor = nxt
                    remaining -= len(data)
        except BaseException as error:
            ready.put(error)
        finally:
            ready.put(i)
    workers = [threading.Thread(target=contextvars.copy_context().run, args=(fetch, i), daemon=True,
                                name=f'offbox-history-{i}') for i in range(2)]
    finished = set()
    try:
        for worker in workers:
            worker.start()
        while len(finished) < 2:
            try:
                # The transport cancels at `until`; allow its shutdown to publish already validated pages.
                result = ready.get(timeout=max(0, until - clock()) + .1)
            except queue.Empty:
                for i in set(range(2)) - finished:
                    yield i, None, 'timeout'
                break
            if isinstance(result, BaseException):
                raise result
            if isinstance(result, int):
                finished.add(result)
                continue
            i, page, error, elapsed = result
            if stats is not None:
                stats['pages'][i] += 1
                stats['slowest_ms'] = max(stats['slowest_ms'], elapsed)
                if len(stats['page_ms'][i]) < 8:
                    stats['page_ms'][i].append(elapsed)
                else:
                    stats['page_ms_omitted'][i] += 1
            yield i, page, error
    finally:
        stopped.set()
        for scope in scopes:
            scope.cancel()
        for worker in workers:
            if worker.ident is not None:
                worker.join(.1)


def frames(box, pid, out, err, *, timeout, until, stop, run_id, clock, command=None, log_dir=None):
    if not command:
        # Recipe/template follows have no retained command history to recover from.
        yield from api.cmd_attach(box, pid, out, err, timeout=timeout, deadline=until)
        return
    # A new stream starts at the last frame consumed by the sole writer. The old stream is closed before polling,
    # so late frames cannot race a poll or replay bytes it has already written.
    offsets = [out, err]
    def emit(kind, **details):
        if log_dir is not None:
            note(run_id, kind, directory=log_dir, **details)
    while not stop.is_set():
        end = clock() + ATTACH_S
        if until is not None:
            end = min(end, until)
        source = None
        emit('attaching', stdoutOffset=offsets[0], stderrOffset=offsets[1])
        last_byte = clock()
        attached = False
        answered = False
        failure = None
        try:
            source = api.cmd_attach(box, pid, *offsets, timeout=min(timeout, max(.001, end - clock())), deadline=end)
            for frame in source:
                if not attached:
                    emit('attached')
                    attached = True
                typ = frame.get('type')
                if typ in ('stdout', 'stderr'):
                    i = 0 if typ == 'stdout' else 1
                    offsets[i] = frame.get('nextOffset', offsets[i] + len((frame.get('data') or '').encode()))
                    last_byte = clock()
                yield frame
                if typ == 'exit' or stop.is_set():
                    return
                if clock() >= end:
                    break
            else:
                raise common.OffboxError('output stream closed without an exit frame')
        except (api.StreamDeadline, OSError, common.OffboxError) as error:
            failure = error
            if clock() < end or until is not None and clock() >= until:
                raise
        finally:
            close = getattr(source, 'close', None)
            if close:
                close()
        if until is not None and clock() >= until:
            raise api.StreamDeadline('follower deadline passed')
        if stop.is_set():
            return
        if command:
            emit('fallback', silent_s=round(clock() - last_byte, 3))
            poll_end = clock() + HISTORY_S
            if until is not None:
                poll_end = min(poll_end, until)
            with contextlib.closing(pages(box, command, offsets, until=poll_end, clock=clock)) as history:
                for i, page, error in history:
                    if error:
                        emit('poll_error', stream=('stdout', 'stderr')[i], error='history unavailable')
                        continue
                    answered = True
                    data = page.get('data') or ''
                    metadata = {key: page[key] for key in ('attempt', 'commandId', 'nodeSetup') if key in page}
                    if data:
                        emit('stream_silent', server_has_output=True, silent_s=round(clock() - last_byte, 3))
                        offsets[i] += len(data.encode())
                        yield dict(metadata, type=('stdout', 'stderr')[i], data=data, nextOffset=offsets[i],
                                   _history_until=poll_end)
                    elif metadata:
                        yield dict(metadata, type='follow_tick', _history_until=poll_end)
        if not attached and not answered:
            # A local timer is not a remote heartbeat. Let the outer follower account for a failed epoch through
            # its existing retries and outage window, rather than clearing failures with a synthetic tick.
            raise common.OffboxError('live attach and history unavailable', outage=True) from failure
        emit('reconnect', stdoutOffset=offsets[0], stderrOffset=offsets[1])
        # Short attaches may never reach the server heartbeat interval. Keep the caller's periodic status probe
        # reachable after recovered output has passed through its writer.
        yield dict(type='follow_tick')
