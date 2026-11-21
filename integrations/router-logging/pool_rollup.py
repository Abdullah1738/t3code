import datetime as dt
import json
import hashlib
from collections import defaultdict
from listener_rollup import timestamp
from pool_alerts import valid
from guard import write_json
from observer import measured


def transitions(path):
    try:
        with path.open() as lines:
            for line in lines:
                if 'pool.exhausted' not in line and 'pool.recovered' not in line:
                    continue
                try:
                    row = json.loads(line)
                    if row.get('tool') == '9router' and row.get('name') in ('pool.exhausted', 'pool.recovered'):
                        yield row
                except (ValueError, AttributeError):
                    pass
    except FileNotFoundError:
        pass


def historical_transitions(root, paths):
    index_path = root / '.pool-transitions.json'
    try:
        index = json.loads(index_path.read_text())
        index = index['files'] if index.get('version') == 1 and isinstance(index.get('files'), dict) else {}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        index = {}
    updated, rows = {}, []
    for path in paths:
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        signature = [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
        entry = index.get(path.name)
        if not (isinstance(entry, dict) and entry.get('signature') == signature
                and isinstance(entry.get('rows'), list) and all(isinstance(row, dict) for row in entry['rows'])):
            entry = dict(signature=signature, rows=list(transitions(path)))
        updated[path.name] = entry
        rows.extend(entry['rows'])
    # Index actual source files rather than assuming the bounded API cache is
    # complete. Unchanged historical files need only a stat on later rollups.
    if updated != index:
        try:
            write_json(index_path, dict(version=1, files=updated))
        except OSError:
            pass
    return rows


@measured('pool_history')
def summarize(day, root, generated, rows):
    floor = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc).timestamp() * 1000
    ceiling = min(floor + 86400000, generated.timestamp() * 1000)
    episodes = {}
    try:
        cached = json.loads((root / '.pool-episodes.json').read_text())
        for identity, episode in cached.items():
            if valid(dict(episode, id=identity)):
                episodes[(episode['provider'], hashlib.sha256(identity.encode()).hexdigest()[:16])] = dict(since=episode['since'], end=episode.get('endedAt'), failed=episode.get('failedRequests', 0))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass
    neighbors = historical_transitions(root, sorted(path for path in root.glob('????-??-??.ndjson')
        if path.stem != day and path.stem <= generated.date().isoformat()))
    for row in sorted([*neighbors, *rows], key=lambda row: timestamp(row.get('ts')) or 0):
        props = row.get('props', {})
        provider = props.get('provider')
        identity = row.get('ids', {}).get('incident')
        since = timestamp(props.get('since'))
        at = timestamp(row.get('ts'))
        if not isinstance(provider, str) or not isinstance(identity, str) or since is None or at is None or since > at or at > generated.timestamp() * 1000:
            continue
        episode = episodes.setdefault((provider, identity), dict(since=since, end=None, failed=0))
        if row['name'] == 'pool.recovered':
            episode.update(end=min(episode['end'] or at, at), failed=props.get('failedRequests', 0))
    providers = defaultdict(lambda: dict(episodes=0, startedEpisodes=0, totalMs=0, openEpisodes=0))
    for (provider, _), episode in episodes.items():
        since, end = episode['since'], episode['end']
        overlap = max(0, min(ceiling, end if end is not None else ceiling) - max(floor, since))
        if overlap <= 0:
            continue
        group = providers[provider]
        group['episodes'] += 1
        group['startedEpisodes'] += floor <= since < ceiling
        group['openEpisodes'] += end is None or end > ceiling
        group['totalMs'] += overlap
    return [dict(provider=provider, **group, totalMinutes=round(group['totalMs'] / 60000, 6)) for provider, group in sorted(providers.items())]
