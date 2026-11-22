"""Detached supervisor: keep child failures observable without retaining private stderr."""
import datetime as dt
import fcntl
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import marketplace
import data_io

MAX_STDERR = 16 * 1024


def supervise(data, command, timeout=190):
    from state_json import write_json
    from charges import toollog
    data = Path(data)
    path = data / 'marketplace-worker.lock'
    with data_io.scope(time.time() + .5):
        lock = data_io.materialize_io(lambda: path.open('a'), path)
    with lock:
        try:
            with data_io.scope(time.time() + .5):
                data_io.materialize_io(lambda: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB), path)
        except BlockingIOError:
            return 0
        tails = {'out': b'', 'err': b''}
        sizes = {'out': 0, 'err': 0}
        code, failure = 1, None
        try:
            with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, close_fds=True) as child:
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(child.stdout, selectors.EVENT_READ, 'out')
                        selector.register(child.stderr, selectors.EVENT_READ, 'err')
                        end = time.monotonic() + timeout
                        while selector.get_map():
                            if time.monotonic() >= end:
                                raise subprocess.TimeoutExpired(command, timeout)
                            for key, _ in selector.select(min(1, max(0, end - time.monotonic()))):
                                chunk = os.read(key.fileobj.fileno(), 4096)
                                if not chunk:
                                    selector.unregister(key.fileobj)
                                    continue
                                sizes[key.data] += len(chunk)
                                tails[key.data] = (tails[key.data] + chunk)[-MAX_STDERR:]
                        code = child.wait(timeout=max(.001, end - time.monotonic()))
                except subprocess.TimeoutExpired:
                    child.kill()  # This PID was spawned here; never kill by name.
                    child.wait()
                    failure = 'timeout'
        except OSError:
            failure = 'spawn_error'
        # Free-form stderr can include credentials, receipts and order timestamps.
        # Persist only its size and known exception classes, never its text/frames.
        exceptions = [name for name in ('ImportError', 'ModuleNotFoundError', 'SyntaxError',
                      'PermissionError', 'FileNotFoundError', 'TimeoutError', 'DataUnavailable')
                      if (name + ':').encode() in tails['err']]
        message = f'exit_code={code}\nstderr_bytes={sizes["err"]}\n'
        message += ''.join(f'exception={name}\n' for name in exceptions)
        if sizes['err']:
            message += 'stderr content omitted\n'
        if failure:
            message += f'failure={failure}\n'
        try:
            marketplace.write_refresh_error(data, message)
        except (OSError, data_io.DataUnavailable):
            pass
        if code:
            at = dt.datetime.now(dt.timezone.utc).isoformat()
            try:
                with data_io.scope(time.time() + .5):
                    write_json(data / 'marketplace-refresh.json', {'last_result': 'launch_error', 'last_at': at})
            except (OSError, data_io.DataUnavailable):
                pass
            toollog.emit('money-cases', 'marketplace.refresh', kind='error', ok=False,
                 props={'result': 'launch_error', 'exitCode': code})
        return code


if __name__ == '__main__':
    try:
        sys.exit(supervise(sys.argv[1], sys.argv[2:]))
    except (Exception, data_io.DataUnavailable):
        # The parent's pre-created error file also covers supervisor startup failure.
        print('marketplace supervisor failed', file=sys.stderr)
        sys.exit(1)
