"""Private, best-effort tool metrics and the shared nightly reader. Stdlib only."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re

CAP_BYTES = 50 * 1024 * 1024
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_LABEL = re.compile(r"[A-Za-z0-9_.:-]{1,120}\Z")
_ID_VALUE = re.compile(r"[A-Za-z0-9_.:%/-]{1,300}\Z")
# Data is allowlisted at the boundary; raw commands, prompts and exception text
# cannot accidentally become metadata when a caller passes its input dictionary.
_FIELDS = {'harness', 'guard', 'decision', 'rule', 'firstWord', 'commandLength',
           'filesChanged', 'driftFound', 'differingCount', 'platform', 'billedMinutes',
           'exitCode', 'failingStep', 'count', 'dryRun', 'toolCount', 'operation', 'status'}
_IDS = {'sessionId', 'threadId', 'serverId', 'home', 'sampleId'}
_WORDS = set('git rg grep find ls cat cp mv rm python python3 node bun npm pnpm yarn vp go cargo rustc make docker offbox bash sh zsh curl sqlite3 terraform aws rcsim runcloud printf echo env sudo'.split())


def command_props(command):
    if not isinstance(command, str):
        return {}
    match = re.match(r"\s*([A-Za-z0-9_./+-]+)(?=\s|$)", command)
    word = match.group(1).rsplit('/', 1)[-1] if match else ''
    return {'firstWord': word if word in _WORDS else 'other', 'commandLength': len(command)}


def root():
    return Path(os.environ.get('TOOLLOG_ROOT', str(Path.home() / '.robob/logs/tools')))


def board_dir(board):
    if not isinstance(board, str) or not _SLUG.fullmatch(board):
        raise ValueError('invalid board slug')
    return root() / board


def _private_dir(path):
    if not path.exists():
        if not path.parent.exists():
            _private_dir(path.parent)
        path.mkdir(mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def _claim(path):
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        return True
    except FileExistsError:
        return False


def _append(path, row):
    data = (json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode()
    fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, data)
    finally:
        os.close(fd)


def _metadata(values, keys):
    result = {}
    for key, value in (values or {}).items():
        if key not in keys:
            continue
        if type(value) is bool or type(value) in (int, float) and math.isfinite(value):
            result[key] = value
        elif isinstance(value, str) and (_ID_VALUE if keys is _IDS else _LABEL).fullmatch(value):
            result[key] = value
    return result


def emit(component, kind, name, *, board='agent-tools', duration_ms=None, ok=None,
         ids=None, props=None, error_tag=None):
    """Drop write failures. Error messages are fixed tags, never exception messages."""
    try:
        if kind not in {'event', 'perf', 'error'} or not _LABEL.fullmatch(component) or not _LABEL.fullmatch(name):
            return
        now = datetime.now(timezone.utc)
        day = now.strftime('%Y-%m-%d')
        directory = board_dir(board)
        _private_dir(directory)
        if _claim(directory / ('.retained-' + day)):
            cutoff = (now.date() - timedelta(days=30)).isoformat()
            for path in directory.iterdir():
                date = re.fullmatch(r'(?:rollup-|\.retained-|\.cap-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json)?', path.name)
                if date and date[1] < cutoff:
                    try:
                        path.unlink()
                    except OSError:
                        pass
        row = {'ts': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
               'tool': board, 'component': component, 'kind': kind, 'name': name}
        if type(duration_ms) in (int, float) and math.isfinite(duration_ms) and duration_ms >= 0:
            row['durationMs'] = round(duration_ms, 3)
        if type(ok) is bool:
            row['ok'] = ok
        for key, value in [('ids', _metadata(ids, _IDS)), ('props', _metadata(props, _FIELDS))]:
            if value:
                row[key] = value
        if error_tag:
            tag = error_tag if isinstance(error_tag, str) and _LABEL.fullmatch(error_tag) else 'other'
            row['error'] = {'tag': tag, 'message': tag}
        path = directory / (day + '.ndjson')
        if path.exists() and path.stat().st_size >= CAP_BYTES:
            if _claim(directory / ('.cap-' + day)):
                _append(path, {**{k: row[k] for k in ('ts', 'tool', 'component')},
                               'kind': 'error', 'name': 'log.cap', 'ok': False,
                               'error': {'tag': 'log.cap', 'message': 'Daily log cap reached'}})
            if kind != 'error':
                return
        _append(path, row)
    except Exception:
        pass


def hook(harness, guard, decision, rule, duration_ms, command=None, error_tag=None, ids=None):
    emit('hooks', 'error' if decision == 'denied' or error_tag else 'perf', 'hook.decision',
         duration_ms=duration_ms, ok=decision != 'denied' and not error_tag, ids=ids,
         props={'harness': harness, 'guard': guard, 'decision': decision, 'rule': rule,
                **command_props(command)}, error_tag=error_tag or (rule if decision == 'denied' else None))


def _read_records(board, day):
    # Validate dates before constructing paths, including dates supplied by another board.
    if datetime.strptime(day, '%Y-%m-%d').strftime('%Y-%m-%d') != day:
        raise ValueError('invalid UTC day')
    path = board_dir(board) / (day + '.ndjson')
    if not path.exists():
        return
    with path.open(encoding='utf-8') as source:
        for line_number, line in enumerate(source, 1):
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    continue
                yield line_number, row
            except (ValueError, UnicodeError):
                continue


def read(board, day, kind=None, name=None):
    for _, row in _read_records(board, day):
        if kind and row.get('kind') != kind or name and row.get('name') != name:
            continue
        yield row


def rollup(board, day):
    from collections import Counter, defaultdict
    counts_name, counts_kind, tags = Counter(), Counter(), Counter()
    samples, references, durations = {}, {}, defaultdict(list)
    total = oks = failed = errors = observed = 0
    for line_number, row in _read_records(board, day):
        total += 1
        name, kind = row.get('name', 'unknown'), row.get('kind', 'unknown')
        counts_name[name] += 1
        counts_kind[kind] += 1
        if type(row.get('ok')) is bool:
            observed += 1
            oks += row['ok']
            failed += not row['ok']
        errors += kind == 'error'
        duration = row.get('durationMs')
        if type(duration) in (int, float) and math.isfinite(duration) and duration >= 0:
            durations[name].append(duration)
        tag = (row.get('error') or {}).get('tag')
        if isinstance(tag, str):
            tags[tag] += 1
            references.setdefault(tag, {'file': day + '.ndjson', 'line': line_number, 'ts': row.get('ts')})
            identity = row.get('ids')
            if isinstance(identity, dict) and identity:
                samples.setdefault(tag, identity)
    def percentiles(values):
        values.sort()
        return {'p50': values[max(0, math.ceil(len(values) * .5) - 1)],
                'p95': values[max(0, math.ceil(len(values) * .95) - 1)], 'max': values[-1]}
    return {'schemaVersion': 1, 'tool': board, 'day': day, 'total': total,
            'countsByName': dict(counts_name), 'countsByKind': dict(counts_kind),
            'okCount': oks, 'failedCount': failed, 'okRate': oks / observed if observed else None,
            'errorRate': errors / total if total else 0,
            'durationMsByName': {name: percentiles(values) for name, values in sorted(durations.items())},
            'topErrorTags': [{'tag': tag, 'count': count, 'sampleId': samples.get(tag, references[tag])}
                             for tag, count in sorted(tags.items(), key=lambda x: (-x[1], x[0]))[:20]]}


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    for cmd in ('read', 'rollup'):
        p = sub.add_parser(cmd)
        p.add_argument('--board', required=True)
        p.add_argument('--day', default=datetime.now(timezone.utc).strftime('%Y-%m-%d'))
        if cmd == 'read':
            p.add_argument('--kind', choices=['event', 'perf', 'error'])
            p.add_argument('--name')
            p.add_argument('--limit', type=int, default=100)
    args = parser.parse_args(argv)
    try:
        if args.cmd == 'read':
            if args.limit < 0:
                raise ValueError('limit must be nonnegative')
            from itertools import islice
            for row in islice(read(args.board, args.day, args.kind, args.name), args.limit):
                print(json.dumps(row, separators=(',', ':')))
        else:
            result = rollup(args.board, args.day)
            directory = board_dir(args.board)
            _private_dir(directory)
            path = directory / ('rollup-' + args.day + '.json')
            import tempfile
            fd, tmp = tempfile.mkstemp(dir=directory, prefix='.rollup-')
            try:
                with os.fdopen(fd, 'w') as dest:
                    json.dump(result, dest, indent=2, allow_nan=False)
                    dest.write('\n')
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            print(path)
        return 0
    except (OSError, ValueError) as error:
        print(f'toollog: {error}', file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
