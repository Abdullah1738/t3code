from collections import Counter
import secrets

INTERVAL_SECONDS = 300
WRITER = secrets.token_hex(8)
STATES = {}
NAMES = {'proxy.request','proxy.retry','proxy.progress','proxy.fallback','proxy.sticky_miss','account.health','account.locked','account.lock','account.unlock','endpoint.get','poll.complete','usage.errors','usage.coverage','spend.snapshot','spend.unavailable','log.cap','log.rollup','restart.scan','restart.phase','restart.decision','restart.late','stream.scan','stream.phase','stall.scan','catalog.check','catalog.decision','relogin.tick','relogin.needed','img.request','img.result','img.fallback','img.fallback.result','img.write','auth.helper','recovery.sendToThread','recovery.dispatchCommand','recovery.telegram','other'}
REASONS = {'daily_cap','line_size','queue_full','invalid_event','write_error'}


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991


def state_for(root, day):
    return STATES.setdefault((str(root), day), dict(root=root, day=day, lines=Counter(), drops=Counter(), writtenLines=0, writeErrors=0, version=0, reported=0))


def written(state, name):
    state['lines'][name if name in NAMES else 'other'] += 1
    state['writtenLines'] += 1
    state['version'] += 1


def dropped(state, reason):
    state['drops'][reason] += 1
    state['version'] += 1


def write_error(state, lost=True):
    state['writeErrors'] += 1
    state['version'] += 1
    if lost:
        dropped(state, 'write_error')


def snapshot(state, bytes_today):
    lines = sorted(state['lines'].items(), key=lambda row: (-row[1], row[0]))
    return dict(version=state['version'], ids={'writer': WRITER}, props=dict(bytesToday=bytes_today,
        writtenLines=state['writtenLines'], linesByName=dict(lines[:10]), otherLines=sum(n for _, n in lines[10:]),
        droppedByReason=dict(state['drops']), droppedLines=sum(state['drops'].values()), writeErrors=state['writeErrors']))


def clean_props(source):
    props = {key: source[key] for key in ('bytesToday','writtenLines','otherLines','droppedLines','writeErrors') if integer(source.get(key))}
    for key, allowed, limit in (('linesByName', NAMES, 10), ('droppedByReason', REASONS, 5)):
        if isinstance(source.get(key), dict):
            props[key] = dict([(name, count) for name, count in source[key].items() if name in allowed and integer(count)][:limit])
    return props
