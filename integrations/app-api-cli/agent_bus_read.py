"""Read the bridge-owned request metadata; never fetch request or answer text."""
import datetime as dt
from contextlib import closing
import os
from pathlib import Path
import re
import sqlite3

BUS_DB = Path.home() / '.config/spectrum-bridge/state.sqlite'
MAX_AGE_MS = 24 * 60 * 60 * 1000


class BusError(ValueError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(f'{code}: {detail}')


def bus_request(request_id, *, db=None, now=None):
    """Return only metadata for a recent Moni→owner request still being worked.

    The SELECT checks every column we consume, even when the id does not exist.
    Unknown statuses and malformed timestamps fail closed. Epoch ms come from
    spectrum-bridge's Date.now(), rather than the ISO dates in owner-go.
    """
    if not isinstance(request_id, str) or not re.fullmatch(r'areq_[A-Za-z0-9]+', request_id):
        raise BusError('BUS_REQUEST_MISSING', 'invalid request id')
    try:
        path = Path(db if db is not None else os.environ.get('AGENT_BUS_DB', BUS_DB)).expanduser().resolve()
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=0.2)) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute('SELECT id, from_slug, to_slug, status, created_at '
                                     'FROM agent_requests WHERE id = ?', (request_id,)).fetchone()
    except (sqlite3.Error, OSError, ValueError) as exc:
        raise BusError('BUS_UNREADABLE', 'cannot read bus metadata or schema') from exc
    if row is None:
        raise BusError('BUS_REQUEST_MISSING', 'no such request')
    row = dict(row)
    if row['from_slug'] != 'moni':
        raise BusError('BUS_WRONG_SENDER', 'request is not from moni')
    if row['to_slug'] != 'owner':
        raise BusError('BUS_WRONG_TARGET', 'request is not to owner')
    if row['status'] not in ('open', 'pending', 'timed_out'):
        raise BusError('BUS_REQUEST_CLOSED', 'request is closed or has an unknown status')
    now = now or dt.datetime.now(dt.timezone.utc)
    created = row['created_at']
    if type(created) is not int:
        raise BusError('BUS_UNREADABLE', 'created_at must be epoch milliseconds')
    if not 0 <= now.timestamp() * 1000 - created <= MAX_AGE_MS:
        raise BusError('BUS_REQUEST_STALE', 'request is future-dated or older than 24 hours')
    return row
