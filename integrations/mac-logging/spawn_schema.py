"""Bounded allowlist for spawn events and their status/onset context."""
import math
import re

NUMBERS = set('windowS ticks births exits births_per_min identityCovered identityTotal sampleAgeS wallMs cpuMs cpuPct intervalS tickWallMaxMs ppid pid covered total candidateCoverage candidateTotal runnable_low_cpu cpuUnknown count rssBytes cpuDeltaNs metricsUnreadable distinctRunIds'.split())
NUMBERS.update(('inFlightWallMs', 'offboxWindowS', 'cpuWindowMaxS'))
NUMBERS.update(('threadLimit', 'previousThreadLimit', 'processLimit', 'previousIntervalS',
                'threadsWallMs', 'previousThreadsWallMs', 'births_cadence_s'))
BOOLS = {'lower_bound', 'baseline', 'partial', 'threadsEnabled', 'costIncomplete'}
OBJECTS = {'runnable', 'offbox', 'buckets', 'wait', '_bg-queue', 'run', 'other', 'argv-unreadable', 'argv-pending'}
OBJECTS.update(('phaseCosts', 'identity', 'parents', 'cpu', 'argv', 'offbox', 'threads', 'thread_selection'))
REASONS = {a+b for a in ('identity', 'argv', 'cpu_offbox', 'threads') for b in ('_budget', '_unreadable', '_coverage')} | {'threads_disabled', 'threads_incomplete', 'identity_changed', 'inventory_unavailable', 'stale', 'native_call_in_flight', 'late_tick', 'task_unreadable'}
REASONS.add('tick_in_flight')
FAMILIES = {'Robob server', 'codex app-server', 'claude provider', 'robob-watch runner', 'agent-bridges'}


def fields(values, depth=0):
    from toollog import SECRET
    if not isinstance(values, dict) or depth > 5:
        return {}
    result = {}
    for key, value in values.items():
        if key in NUMBERS or key in ('pri<=4', '5-19', '20-31', '32-46', '47+') or key == 'runnable' and type(value) is int:
            if value is None or type(value) in (int, float) and math.isfinite(value) and value >= 0:
                result[key] = value
        elif key in BOOLS and type(value) is bool:
            result[key] = value
        elif key in ('parent_start', 'start'):
            if value is None or isinstance(value, (list, tuple)) and len(value) == 2 and all(type(v) is int and v >= 0 for v in value):
                result[key] = value
        elif key == 'method' and value == 'proc_listallpids+pid_start_snapshot_delta':
            result[key] = value
        elif key == 'reason' and value in ('tick_wall', 'tick_cpu', 'minute_wall', 'minute_cpu', 'recover'):
            result[key] = value
        elif key == 'limitNote' and value in ('threads_wall_not_reduced', 'threads_cost_unavailable'):
            result[key] = value
        elif key == 'births_cadences_s' and isinstance(value, list):
            result[key] = sorted({v for v in value if type(v) is int and v in (5, 15)})
        elif key in ('parent_comm', 'comm') and isinstance(value, str):
            result[key] = value if re.fullmatch(r'[A-Za-z0-9_.: +()-]{1,96}', value) and not SECRET.search(value) else '[redacted]'
        elif key == 'family' and (value is None or isinstance(value, str) and value in FAMILIES):
            result[key] = value
        elif key == 'partialReasons' and isinstance(value, list):
            result[key] = [v for v in value[:32] if isinstance(v, str) and v in REASONS]
        elif key in ('top_spawners', 'top', 'child_comms_top3', 'guardActions') and isinstance(value, list):
            limit = 3 if key == 'child_comms_top3' else 32 if key == 'guardActions' else 10
            result[key] = [fields(v, depth+1) for v in value[:limit]]
        elif key in OBJECTS:
            result[key] = None if value is None else fields(value, depth+1)
    return result


def summary(values):
    p = fields(values)
    cadence = p.get('births_cadence_s', p.get('intervalS'))
    return dict(births_per_min=p.get('births_per_min'), lower_bound=True,
                births_cadence_s=cadence,
                births_cadences_s=p.get('births_cadences_s') or ([cadence] if cadence is not None else []),
                top_spawners=p.get('top_spawners', [])[:3],
                runnable_pri_le4=((p.get('runnable') or {}).get('buckets') or {}).get('pri<=4'),
                partial=p.get('partial', True), sampleAgeS=p.get('sampleAgeS'))
