"""Append cursors shared by aggregate and sparse-history caches."""
import datetime as dt
from collections import Counter, defaultdict
import hashlib
import json
import os
import tempfile
from observer import count_bytes, submeasured, substep


def request_group():
    return dict(count=0, aborted=0)


def provider_group():
    return dict(count=0, aborted=0, statuses=Counter())


FACTORIES = {f.__name__: f for f in (list, set, Counter, request_group, provider_group)}


def encode(value):
    # JSON pairs retain tuple keys and insertion order (including tied top counts).
    if isinstance(value, dict):
        kind = ('defaultdict:' + value.default_factory.__name__ if isinstance(value, defaultdict)
                else 'counter' if isinstance(value, Counter) else 'dict')
        return [kind, [[encode(k), encode(v)] for k, v in value.items()]]
    if isinstance(value, (tuple, set, list)):
        return [type(value).__name__, [encode(v) for v in value]]
    if isinstance(value, dt.datetime):
        return ['datetime', value.isoformat()]
    return value


def decode(value):
    if not isinstance(value, list):
        return value
    kind, payload = value
    if kind in ('tuple', 'set', 'list'):
        return {'tuple': tuple, 'set': set, 'list': list}[kind](decode(v) for v in payload)
    if kind == 'datetime':
        return dt.datetime.fromisoformat(payload)
    if kind == 'dict':
        result = {}
    elif kind == 'counter':
        result = Counter()
    elif kind.startswith('defaultdict:'):
        result = defaultdict(FACTORIES[kind.split(':', 1)[1]])
    else:
        raise ValueError('unknown aggregate type')
    result.update({decode(k): decode(v) for k, v in payload})
    return result


@submeasured('LoadState')
def load(path, version):
    try:
        value = json.loads(path.read_text())
        return value if value.get('version') == version else {}
    except (OSError, ValueError, AttributeError):
        return {}


@submeasured('SaveState')
def save(path, version, cursor, aggregate):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cursor['sha256'] = cursor.digest.hexdigest()
    fd, temporary = tempfile.mkstemp(prefix='.aggregate-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(dict(version=version, cursor=cursor, aggregate=encode(aggregate)), out, separators=(',', ':'))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Cursor(dict):
    def __init__(self, digest, **values):
        super().__init__(values)
        self.digest = digest


@submeasured('ValidateCursor')
def cursor_for(source, previous):
    previous = previous if isinstance(previous, dict) else {}
    info = os.fstat(source.fileno())
    identity = [info.st_dev, info.st_ino]
    offset = previous.get('offset')
    append = (previous.get('identity') == identity and type(offset) is int
              and type(previous.get('size')) is int and 0 <= offset <= previous['size'] <= info.st_size
              and (previous['size'] < info.st_size or previous.get('mtime') == info.st_mtime_ns))
    digest = hashlib.sha256()
    if append:
        # Size/inode cannot distinguish append from copytruncate followed by
        # regrowth. Verify all committed bytes, without parsing their JSON.
        source.seek(0)
        remaining = offset
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            digest.update(chunk)
            count_bytes('BytesHashed', len(chunk))
            remaining -= len(chunk)
        append = remaining == 0 and previous.get('sha256') == digest.hexdigest()
    if not append:
        digest = hashlib.sha256()
    return Cursor(digest, identity=identity, size=info.st_size, offset=offset if append else 0,
                  mtime=info.st_mtime_ns, sha256=digest.hexdigest()), append


def lines(source, cursor):
    with substep('ParseLines'):
        if cursor['offset'] == 0:
            # A caller may reject the aggregate after validating its cursor.
            cursor.digest = hashlib.sha256()
        source.seek(cursor['offset'])
        while source.tell() < cursor['size']:
            line = source.readline(cursor['size'] - source.tell())
            if not line:
                break
            complete = line.endswith(b'\n')
            count_bytes('BytesParsed', len(line))
            if complete:
                cursor.digest.update(line)
                count_bytes('BytesHashed', len(line))
                cursor['offset'] = source.tell()
            yield line, complete
