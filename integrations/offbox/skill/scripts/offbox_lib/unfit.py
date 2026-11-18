"""Durable box exclusions independent of lease notes and lifecycle operations."""
import contextlib
import json

from . import common

PREFIX = 'box_unfit:'
AUTO_TTL = 24 * 3600


def record_event(con, event_name, box, detail):
    con.execute('INSERT INTO events VALUES (?,?,?,?)',
                (common.now(), box, event_name, json.dumps(dict(box_id=box, **detail))))


def publish(event_name, box, detail):
    # Human reasons belong in local state, not metadata logs or a command's output log.
    common.log(f"{event_name} {box} run={detail.get('run_id') or '-'}")
    import toollog
    toollog.emit('box', event_name, ids={'box': box, 'run': detail.get('run_id'),
                                       'newRun': detail.get('new_run_id'), 'newBox': detail.get('to_box')},
                 props=detail)


def emit(con, event_name, box, **detail):
    with common.write(con):
        record_event(con, event_name, box, detail)
    publish(event_name, box, detail)


def get(con, box):
    value = common.kv_get(con, PREFIX + box)
    if value and value.get('expires_at') is not None and value['expires_at'] <= common.now():
        if con.in_transaction:
            return None
        clear(con, box, expected=value, expired=True)
        # A manual mark may have replaced the expired value before the conditional clear.
        value = common.kv_get(con, PREFIX + box)
        if value and value.get('expires_at') is not None and value['expires_at'] <= common.now():
            return None
    return value


def set_mark(con, box, reason, *, kind='suspect', source='manual', run_id=None, trigger='manual'):
    stamp = common.now()
    value = dict(kind=kind, reason=reason, since=stamp, source=source, run_id=run_id,
                 expires_at=stamp + AUTO_TTL if source == 'auto' else None, trigger=trigger)
    with common.write(con):
        old = common.kv_get(con, PREFIX + box)
        if source == 'auto' and run_id:
            seen_key = f'box_unfit_seen:{kind}:{box}:{run_id}'
            seen = common.kv_get(con, seen_key)
            if seen:
                return old or seen
            # Clearing/expiry must survive a later read of the same retained run, including
            # evidence first observed while a manual hold was already in place.
            con.execute('INSERT INTO kv VALUES (?,?,?)', (seen_key, json.dumps(value), stamp))
        # Settlement may be read repeatedly; neither extend that run's TTL nor downgrade a manual hold.
        if source == 'auto' and old and (old['source'] == 'manual' or old.get('run_id') == run_id):
            return old
        con.execute('INSERT OR REPLACE INTO kv VALUES (?,?,?)', (PREFIX + box, json.dumps(value), stamp))
        record_event(con, 'box_suspect_set', box, value)
    publish('box_suspect_set', box, value)
    return value


def clear(con, box, *, expected=None, expired=False):
    with common.write(con):
        old = common.kv_get(con, PREFIX + box)
        if not old or expected is not None and old != expected:
            return False
        con.execute('DELETE FROM kv WHERE k=?', (PREFIX + box,))
        detail = dict(old, expired=expired)
        record_event(con, 'box_suspect_cleared', box, detail)
    publish('box_suspect_cleared', box, detail)
    return True


def available(con, box, run_id=None):
    mark = get(con, box)
    if not mark:
        return True
    if run_id and not con.in_transaction and not con.execute(
            "SELECT 1 FROM events WHERE box_id=? AND kind='box_skipped_suspect' "
            "AND json_extract(detail,'$.run_id')=?", (box, run_id)).fetchone():
        emit(con, 'box_skipped_suspect', box, run_id=run_id, reason=mark['reason'])
    return False


def command(me, box, action, reason=None):
    from . import pool
    from .identity import require_proven
    require_proven(me, 'box-' + action)
    if action == 'suspect' and (not reason or not reason.strip()):
        raise common.OffboxError('box suspect requires --reason', code=2)
    with contextlib.closing(common.db()) as con:
        common.require_mine(con, box)
        # Pool selection owns these locks too; never take the box lock or interfere with its live wrapper.
        keys = {r[0] for r in con.execute('SELECT pool_key FROM pool_members WHERE box_id=?', (box,))}
        row = con.execute('SELECT repo_key FROM leases WHERE box_id=?', (box,)).fetchone()
        if row:
            keys.add(row['repo_key'])
        with contextlib.ExitStack() as stack:
            for key in sorted(keys):
                stack.enter_context(common.file_lock(pool.lock_name(key)))
            if action == 'suspect':
                set_mark(con, box, reason.strip())
            else:
                clear(con, box)
        common.say(f'{box}: ' + ('suspect: ' + reason.strip() if action == 'suspect' else 'suspect mark cleared'))
