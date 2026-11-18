"""Listener transitions are sparse; a recovery carries the original start time."""
import datetime as dt
import json


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() * 1000 if parsed.tzinfo is not None else None
    except (ValueError, AttributeError, TypeError, OverflowError):
        return None


def transitions(path):
    try:
        with path.open() as lines:
            for line in lines:
                if 'listener.down' not in line and 'listener.up' not in line:
                    continue
                try:
                    row = json.loads(line)
                    if row.get('tool') == '9router' and row.get('name') in ('listener.down', 'listener.up') and timestamp(row.get('ts')) is not None:
                        yield row
                except (ValueError, AttributeError):
                    continue
    except FileNotFoundError:
        return


def windows(day, root, generated):
    start = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc)
    floor, ceiling = start.timestamp() * 1000, min((start + dt.timedelta(days=1)).timestamp() * 1000, generated.timestamp() * 1000)
    rows = []
    # Only the last prior transition matters for a window still open at midnight.
    for source in sorted((p for p in root.glob('????-??-??.ndjson') if p.stem < day), reverse=True):
        prior = list(transitions(source))
        if prior:
            rows.append(max(prior, key=lambda row: timestamp(row['ts'])))
            break
    rows.extend(transitions(root / (day + '.ndjson')))
    # Recovery may follow several missing or empty days; downSince joins it back.
    for source in sorted(p for p in root.glob('????-??-??.ndjson') if day < p.stem <= generated.date().isoformat()):
        rows.extend(transitions(source))
    incidents = {}
    for row in sorted(rows, key=lambda row: timestamp(row['ts'])):
        at = timestamp(row['ts'])
        if at > generated.timestamp() * 1000:
            continue
        props = row.get('props') if isinstance(row.get('props'), dict) else {}
        since = timestamp(props.get('downSince'))
        if since is None:
            since = at if row['name'] == 'listener.down' else None
        if since is None or since > at:
            continue
        incident = incidents.setdefault(since, dict(start=props.get('downSince') or row['ts'], end=None, cause=props.get('cause', 'unknown')))
        if row['name'] == 'listener.up':
            incident['end'] = row['ts']
    output = []
    for since, incident in sorted(incidents.items()):
        end = timestamp(incident['end']) if incident['end'] is not None else ceiling
        elapsed = max(0, min(ceiling, end) - max(floor, since))
        if elapsed > 0:
            output.append(dict(**incident, downMs=round(elapsed, 3)))
    return dict(count=len(output), totalDownMs=round(sum(row['downMs'] for row in output), 3),
                maxDownMs=max((row['downMs'] for row in output), default=0), windows=output)
