"""Listener transitions are sparse; a recovery carries the original start time."""
import datetime as dt
import json
import math
import re
import time
import append_cursor as cache

from host import clean_host
from guard import recent_failure
from observer import GAP_NAMES, gap_bounds, measured
from causes import launchctl_info, positive, unknown as unknown_cause

HISTORY_NAMES = {'deploy.result', 'health.request.late', 'pool.exhausted', 'pool.recovered', 'poll.complete'}


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() * 1000 if parsed.tzinfo is not None else None
    except (ValueError, AttributeError, TypeError, OverflowError):
        return None


def history_rows(path, incremental=True):
    state_path = path.with_name('.listener-state-' + path.stem + '.json')
    saved = cache.load(state_path, 2) if incremental else {}
    try:
        with path.open('rb') as source:
            cursor, append = cache.cursor_for(source, saved.get('cursor', {}))
            try:
                rows = cache.decode(saved['aggregate']) if append else []
                if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
                    raise ValueError('invalid history')
            except (ValueError, TypeError, KeyError, AttributeError):
                rows, append = [], False
            if not append:
                cursor['offset'] = 0
            tail = []
            checkpoint_offset, checkpoint_time = cursor["offset"], time.monotonic()
            for line, complete in cache.lines(source, cursor):
                if b'listener.' in line or any(name.encode() in line for name in HISTORY_NAMES | GAP_NAMES):
                    try:
                        row = json.loads(line)
                        if isinstance(row, dict):
                            (rows if complete else tail).append(row)
                    except (ValueError, UnicodeError):
                        pass
                if incremental and complete and (cursor['offset'] - checkpoint_offset >= 8 * 1024 * 1024
                                                  or time.monotonic() - checkpoint_time >= 30):
                    cache.save(state_path, 2, cursor, rows)
                    checkpoint_offset, checkpoint_time = cursor['offset'], time.monotonic()
            if incremental and (not append or cursor != saved.get('cursor')):
                cache.save(state_path, 2, cursor, rows)
            yield from rows
            yield from tail
    except FileNotFoundError:
        return


def transitions(path, observations=None, incremental=True):
    for row in history_rows(path, incremental):
        try:
            bounds = gap_bounds(row.get('props')) if row.get('name') == 'pool.endpoint.get' else None
            if (observations is not None and row.get('tool') == '9router' and row.get('name') in (*GAP_NAMES, 'poll.complete', 'listener.down', 'listener.up', 'listener.state_unknown', 'listener.state_resolved')
                    and (row['name'] != 'pool.endpoint.get' or
                         positive(row.get('durationMs')) and row['durationMs'] > 120000 or
                         bounds is not None and bounds[1] - bounds[0] > 120000)):
                observations.append(row)
            if row.get('tool') == '9router' and row.get('name') in ('listener.down', 'listener.up', 'listener.state_unknown', 'listener.state_resolved', 'deploy.result') and timestamp(row.get('ts')) is not None:
                yield row
        except (ValueError, AttributeError):
            continue


@measured('listener_history')
def windows(day, root, generated, observations=None, incremental=True):
    start = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc)
    floor, ceiling = start.timestamp() * 1000, min((start + dt.timedelta(days=1)).timestamp() * 1000, generated.timestamp() * 1000)
    rows = []
    # Keep the prior day's sparse transitions so recovery evidence and unknown
    # intervals beginning at the same tick both survive midnight.
    for source in sorted((p for p in root.glob('????-??-??.ndjson') if p.stem < day), reverse=True):
        prior = list(transitions(source, observations, incremental))
        if any(row['name'] in ('listener.down', 'listener.up', 'listener.state_resolved') or
               row.get('props', {}).get('unknownSince') for row in prior):
            rows.extend(prior)
            break
    rows.extend(transitions(root / (day + '.ndjson'), observations, incremental))
    # Recovery may follow several missing or empty days; downSince joins it back.
    for source in sorted(p for p in root.glob('????-??-??.ndjson') if day < p.stem <= generated.date().isoformat()):
        rows.extend(transitions(source, observations, incremental))
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
                                                 **unknown_cause('listener_probe'), confirmed=False))
        if unknown and row['name'] == 'listener.state_unknown':
            incident.update(launchctl_info(props, legacy=True))
        elif unknown and incident['cause'] == 'unknown_no_data':
            explanation = launchctl_info(props, legacy=True)
            if explanation['cause'] != 'unknown_no_data' or incident.get('missingEvidence') == 'listener_probe':
                incident.pop('missingEvidence', None)
                incident.update(explanation)
        for field in ('hostStart', 'hostEnd'):
            host = clean_host(props.get(field))
            if host:
                incident[field] = host
                at_ms = props.get(field + 'AtMs')
                if type(at_ms) in (int, float) and math.isfinite(at_ms):
                    incident[field + 'AtMs'] = at_ms
        if 'l1' in incident.get('hostStart', {}):
            incident['load1Start'] = incident['hostStart']['l1']
        if confirmed:
            incident.pop('missingEvidence', None)
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
