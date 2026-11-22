"""A narrow scheduling tier for critical helpers; never inherit it to descendants."""
import json
import os
from pathlib import Path
import subprocess
import time

from protected_native import Native, identity

PYTHON = '/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python'


def config(home):
    data = json.loads(Path(__file__).with_suffix('.json').read_text())
    for entry in data['roots'] + data['children']:
        entry['argv'] = [s.replace('{home}', str(home)).replace('{python}', PYTHON) for s in entry['argv']]
    return data


def prefix(row, entry):
    argv = row.get('argv', [])
    expected = entry['argv']
    return (row['pid'] > 1 and row['uid'] == os.getuid()
            and argv[:len(expected)] == expected)


def select(rows, labels, rules):
    selected = []
    roots = {}
    for entry in rules['roots']:
        label = entry['label']
        matches = [row for row in rows.values()
                   if prefix(row, entry) and row['ppid'] == 1
                   and (label not in labels or labels[label] == row['pid'])]
        # Ambiguous fallback candidates do not get promoted.
        if len(matches) == 1:
            item = dict(matches[0], label=label, matched_by='label' if label in labels else 'argv')
            selected.append(item)
            roots[label] = item
    for entry in rules['children']:
        parent = roots.get(entry['parent'])
        if parent:
            for row in rows.values():
                if prefix(row, entry) and row['ppid'] == parent['pid']:
                    selected.append(dict(row, label=entry['label'], matched_by='supervised-argv', parent=parent))
    return selected


def command(argv):
    # Do not include command output in exceptions: sudo diagnostics must never
    # echo material received from the credential pipe.
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError('command exit %s' % result.returncode)
    return result.stdout.decode()


def launch_labels():
    labels = {}
    for line in command(['/bin/launchctl', 'list']).splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[0].isdigit():
            labels[fields[2]] = int(fields[0])
    return labels


def unchanged(native, row):
    current = native.read(row['pid'])
    if identity(current) != identity(row) or current['argv'] != row['argv']:
        raise ValueError('identity changed')
    if row.get('parent'):
        parent = row['parent']
        fresh = native.read(parent['pid'])
        if identity(fresh) != identity(parent) or fresh['argv'] != parent['argv']:
            raise ValueError('supervisor changed')
    return current


def checked_command(action, row, deadline=None):
    return ['/usr/bin/python3', '-I', str(Path(__file__).with_name('protected_native.py')),
            action, json.dumps(row, separators=(',', ':')), str(deadline if deadline is not None else time.time()+10)]


def renice(native, row):
    # Start the credential producer separately so its stdout only reaches sudo.
    # Both ends are bounded, reaped, and their captured diagnostics are discarded.
    started = time.monotonic()
    deadline = time.time()+10
    producer = subprocess.Popen(['/usr/bin/security', 'find-generic-password', '-s',
        'robob-mac-login', '-a', 'ardud', '-w'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        unchanged(native, row)
        result = subprocess.run(['/usr/bin/sudo', '-S', '-k', '-p', ''] + checked_command('nice', row, deadline), stdin=producer.stdout,
            capture_output=True, timeout=10)
        producer.stdout.close()
        producer.wait(timeout=max(.001, 10-(time.monotonic()-started)))
        if producer.returncode or result.returncode:
            raise RuntimeError('renice failed')
    finally:
        producer.stdout.close()
        if producer.poll() is None:
            producer.kill()
        producer.wait(timeout=10)


def adjust(native, row, run=command, set_nice=renice, emit=lambda event: None):
    before = unchanged(native, row)
    reasons = []
    if before['pri'] <= 4:
        # Native priority is ps's task priority; confirm the requested ps gate
        # only on a drift tick. A stable tick spawns no child processes.
        pri = int(run(['/bin/ps', '-p', str(row['pid']), '-o', 'pri=']).strip())
        unchanged(native, row)
        if pri <= 4:
            run(checked_command('background', row))
            reasons.append('background-policy')
            record_action(native, row, before, reasons[-1], emit)
    current = unchanged(native, row)
    if current['nice'] > -5:
        set_nice(native, row)
        reasons.append('nice-drift')
        record_action(native, row, current, reasons[-1], emit)
    return reasons


def record_action(native, row, before, reason, emit):
    try:
        after = unchanged(native, row)
    except (OSError, ValueError, RuntimeError) as error:
        emit(dict(adjust_event(row, before, None, reason), readback_error=type(error).__name__))
        raise
    emit(adjust_event(row, before, after, reason))


def adjust_event(row, before, after, reason):
    return dict(event='protected_tier.adjust', label=row['label'], pid=row['pid'],
                lstart=row['lstart'], start=row['start'], matched_by=row['matched_by'],
                before={k: before[k] for k in ('nice', 'pri')},
                after={k: after[k] if after is not None else None for k in ('nice', 'pri')},
                reason=reason, outcome='command-succeeded')


def tick(home, native=None, labels_read=launch_labels, run=command, set_nice=renice):
    root = home / '.local/state/robob-guard'
    log = root / 'guard.log'
    def emit(event):
        with log.open('a') as out:
            out.write(json.dumps(dict(at=time.time(), **event), separators=(',', ':')) + '\n')
    try:
        native = native or Native()
        rules = config(home)
        rows = native.inventory()
        cache_path = root / 'protected-tier-labels.json'
        try:
            cache = json.loads(cache_path.read_text())
        except (OSError, ValueError):
            cache = {}
        # The guard is an interval job, so its own PID changes on every tick.
        # Exact argv identifies that job without invalidating all cached labels.
        candidates = select(rows, {}, rules)
        tokens = {r['label']: [r['pid'], r['start']] for r in candidates
                  if r['label'] != 'com.ardud.robob-guard' and 'parent' not in r}
        issues = []
        if cache.get('tokens') != tokens:
            try:
                labels = {k: v for k, v in labels_read().items()
                          if k in {r['label'] for r in rules['roots']}}
                temp = cache_path.with_suffix('.new')
                temp.write_text(json.dumps(dict(tokens=tokens, labels=labels)))
                temp.replace(cache_path)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                labels = {}
                issues.append(dict(reason=type(error).__name__, step='launchctl', fallback='exact-argv'))
        else:
            labels = cache.get('labels', {})
        labels.pop('com.ardud.robob-guard', None)
        selected = select(rows, labels, rules)
        for row in selected:
            try:
                reasons = adjust(native, row, run, set_nice, emit)
                if reasons:
                    issues.append(dict(label=row['label'], pid=row['pid'], reason='adjusted', actions=reasons))
                after = unchanged(native, row)
                if after['nice'] > -5 or after['pri'] <= 4:
                    issues.append(dict(label=row['label'], pid=row['pid'], reason='still-drifted'))
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                issues.append(dict(label=row['label'], pid=row['pid'], reason=type(error).__name__))
        found = {r['label'] for r in selected}
        issues += [dict(label=r['label'], reason='missing') for r in rules['roots'] + rules['children']
                   if r['label'] not in found]
        if issues:
            emit(dict(event='protected_tier.tick', issues=issues))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        emit(dict(event='protected_tier.tick', issues=[dict(reason=type(error).__name__)]))
