"""A signal alone cannot distinguish an explicit cancellation from an application force-quit."""
import contextlib
import contextvars
import os
import secrets
import signal

from . import common, queue_lifecycle

_CLIENT = contextvars.ContextVar('bg_cancel_client', default=None)


class ClientChanged(common.OffboxError):
    pass


def token():
    return secrets.token_hex(32)


def _path(run_id, kind):
    return common.LOGS_DIR / f'{run_id}.{kind}.json'


def publish(run_id, pid, capability):
    common.atomic_write_json(_path(run_id, 'client'), dict(pid=pid, token=capability))


def request(row):
    identity = common.read_json(_path(row['run_id'], 'client'), {})
    if not identity:
        return  # Clients accepted before this protocol still use the original signal path.
    if (not isinstance(identity, dict) or not isinstance(identity.get('token'), str)
            or len(identity['token']) != 64):
        raise common.OffboxError(f"{row['run_id']}: background client identity changed; nothing was signalled", code=2)
    if identity.get('pid') != row['client_pid']:
        raise ClientChanged(f"{row['run_id']}: background client identity changed; nothing was signalled", code=2)
    common.atomic_write_json(_path(row['run_id'], 'cancel'),
                             dict(**identity, requested_by=os.getpid(), at=common.now()))


@contextlib.contextmanager
def client(run_id, capability):
    marker = _CLIENT.set((run_id, capability))
    try:
        yield
    finally:
        _CLIENT.reset(marker)


def interrupt(run_id, signum, *, started=False):
    active = _CLIENT.get()
    if not started and active and active[0] == run_id and active[1]:
        request = common.read_json(_path(run_id, 'cancel'), {})
        if (not isinstance(request, dict) or request.get('pid') != os.getpid()
                or request.get('token') != active[1]):
            queue_lifecycle.record(run_id, 'signal', signal.Signals(signum).name,
                                   disposition='ignored', detail='no matching offbox kill request')
            return False
        queue_lifecycle.record(run_id, 'cancel', 'offbox_kill', requested_by=request.get('requested_by'))
    queue_lifecycle.received(run_id, signum)
    return True
