"""Listener transitions are sparse; a recovery carries the original start time."""
import datetime as dt
import json
import re

from host import clean_host
from guard import recent_failure
from observer import GAP_NAMES, launchctl_cause, measured


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() * 1000 if parsed.tzinfo is not None else None
    except (ValueError, AttributeError, TypeError, OverflowError):
        return None


def transitions(path, observations=None):
    try:
        with path.open() as lines:
            for line in lines:
                if 'listener.' not in line and 'deploy.result' not in line and (observations is None or not any(name in line for name in (*GAP_NAMES, 'poll.complete'))):
                    continue
                try:
                    row = json.loads(line)
                    if (observations is not None and row.get('tool') == '9router' and row.get('name') in (*GAP_NAMES, 'poll.complete', 'listener.down', 'listener.up', 'listener.state_unknown', 'listener.state_resolved')
                            and (row['name'] != 'pool.endpoint.get' or isinstance(row.get('durationMs'), (int, float)) and row['durationMs'] > 120000)):
                        observations.append(row)
                    if row.get('tool') == '9router' and row.get('name') in ('listener.down', 'listener.up', 'listener.state_unknown', 'listener.state_resolved', 'deploy.result') and timestamp(row.get('ts')) is not None:
                        yield row
                except (ValueError, AttributeError):
                    continue
    except FileNotFoundError:
        return


@measured('listener_history')
def windows(day, root, generated, observations=None):
    start = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc)
    floor, ceiling = start.timestamp() * 1000, min((start + dt.timedelta(days=1)).timestamp() * 1000, generated.timestamp() * 1000)
    rows = []
    # Keep the prior day's sparse transitions so recovery evidence and unknown
    # intervals beginning at the same tick both survive midnight.
    for source in sorted((p for p in root.glob('????-??-??.ndjson') if p.stem < day), reverse=True):
        prior = list(transitions(source, observations))
        if any(row['name'] in ('listener.down', 'listener.up', 'listener.state_resolved') or
               row.get('props', {}).get('unknownSince') for row in prior):
            rows.extend(prior)
            break
    rows.extend(transitions(root / (day + '.ndjson'), observations))
    # Recovery may follow several missing or empty days; downSince joins it back.
    for source in sorted(p for p in root.glob('????-??-??.ndjson') if day < p.stem <= generated.date().isoformat()):
        rows.extend(transitions(source, observations))
    incidents = {}
    failures = [row.get('props', {}) for row in rows if row['name'] == 'deploy.result'
                and timestamp(row['ts']) <= generated.timestamp() * 1000]
    for row in sorted(rows, key=lambda row: timestamp(row['ts'])):
        at = timestamp(row['ts'])
        if at > generated.timestamp() * 1000 or row['name'] == 'deploy.result':
            continue
        props = row.get('props') if isinstance(row.get('props'), dict) else {}
        unknown = row['name'] in ('listener.state_unknown', 'listener.state_resolved')
        since_key = 'unknownSince' if unknown else 'downSince'
        since = timestamp(props.get(since_key))
        if since is None:
            since = at if row['name'] == 'listener.down' else None
        if since is None or since > at:
            continue
        probe = props.get('downListener') if row['name'] == 'listener.up' else props.get('listener')
        # Older guards omitted TCP results. Only an explicit refusal/timeout
        # cause proves their unhealthy decision came from the listener check.
        confirmed = not unknown and (probe in ('refused', 'unreachable') or
                    props.get('cause') in ('listener_refused', 'listener_unreachable'))
        key = (since, 'unknown' if unknown else 'listener')
        incident = incidents.setdefault(key, dict(start=props.get(since_key) or row['ts'], end=None,
                                                 cause='other', confirmed=False))
        if unknown and row['name'] == 'listener.state_unknown':
            incident['cause'] = launchctl_cause(props)
        elif unknown and incident['cause'] == 'other' and isinstance(props.get('cause'), str) and re.fullmatch(r'launchctl_unknown:(?:-?\d+|timeout|oserror)', props['cause']):
            incident['cause'] = props['cause']
        for field in ('hostStart', 'hostEnd'):
            host = clean_host(props.get(field))
            if host:
                incident[field] = host
        if 'l1' in incident.get('hostStart', {}):
            incident['load1Start'] = incident['hostStart']['l1']
        if confirmed:
            incident.update(confirmed=True, cause=props.get('cause') or 'listener_' + probe)
        if row['name'] in ('listener.up', 'listener.state_resolved'):
            incident['end'] = row['ts']
    down, unknown = [], []
    for (since, _), incident in sorted(incidents.items()):
        end = timestamp(incident['end']) if incident['end'] is not None else ceiling
        elapsed = max(0, min(ceiling, end) - max(floor, since))
        if elapsed > 0:
            confirmed = incident.pop('confirmed')
            # A failure result can be logged after detection but before recovery.
            # Attribute only the recorded transaction, never today's live marker.
            if confirmed and any(recent_failure(marker, since) and
                                 marker.get('finishedAtMs', marker.get('startedAtMs')) <= end for marker in failures):
                incident['cause'] = 'deploy_failed'
            bucket, duration = (down, 'downMs') if confirmed else (unknown, 'unknownMs')
            bucket.append(dict(**incident, **{duration: round(elapsed, 3)}))
    confirmed_ms = round(sum(row['downMs'] for row in down), 3)
    by_cause = {}
    for number, window in enumerate(unknown, 1):
        window['number'] = number
        group = by_cause.setdefault(window['cause'], dict(count=0, unknownMs=0))
        group['count'] += 1
        group['unknownMs'] += window['unknownMs']
    return dict(count=len(down), totalDownMs=confirmed_ms, confirmedDownMs=confirmed_ms,
                maxDownMs=max((row['downMs'] for row in down), default=0), windows=down,
                unknownStateMs=round(sum(row['unknownMs'] for row in unknown), 3), unknownWindows=unknown,
                unknownByCause=[dict(cause=cause, **group) for cause, group in sorted(by_cause.items())])
