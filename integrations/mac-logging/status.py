#!/usr/bin/python3
"""Read-only cadence report; failures are data, never a failing command."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re

from toollog import directory

UTC = dt.timezone.utc
# Logging shipped on 2026-11-13 UTC (#10); older days cannot prove silence.
CADENCES = {
    # robob-watch/watchers/disk-space-guard/watcher.json: interval_s=1800;
    # allow two hours (four checks), as requested for the guard.
    'disk.sample': dict(name='disk.sample', target=None, gapHours=2, since='2026-11-13'),
    # launchd/com.abdullah.mac-log-collector.plist: StartInterval=3600;
    # allow one missed hourly collection for inventory and crashes.
    'disk.inventory': dict(name='disk.inventory', target=None, gapHours=2, since='2026-11-13'),
    'crash.collect': dict(name='crash.collect', target=None, gapHours=2, since='2026-11-13'),
    # Same hourly collector plist; both probes run from collector.main().
    'disk.tooling_probe': dict(name='disk.tooling_probe', target=None, gapHours=2, since='2026-11-13'),
    'proc.disk_wait': dict(name='proc.disk_wait', target=None, gapHours=2, since='2026-11-13'),
    # collector.disk_wait() calls clone_wait() on each hourly process snapshot;
    # first live disk.clone_wedge event was 2026-11-14 UTC.
    'disk.clone_wedge': dict(name='disk.clone_wedge', target=None, gapHours=2, since='2026-11-14'),
    # launchd/com.abdullah.mac-memory.plist: StartInterval=300 (five minutes);
    # allow two missed samples (15 minutes). Emitter: memory.sample(), live 14 Nov.
    'memory.sample': dict(name='memory.sample', target=None, gapHours=.25, since='2026-11-14'),
    # cpu.spike is conditional evidence, never a scheduled job to mark silent.
    # launchd/com.abdullah.mac-cpu.plist: StartInterval=60; allow three minutes.
    'cpu.sample': dict(name='cpu.sample', target=None, gapHours=.05, since='2026-11-15'),
    # launchd/com.abdullah.mac-tailnet.plist: StartInterval=60.
    'tailnet.sample': dict(name='tailnet.sample', target=None, gapHours=.05, since='2026-11-15'),
    # launchd/com.abdullah.mac-deep-inventory.plist: daily 03:30 local
    # (Asia/Dubai = previous day 23:30 UTC); allow daily plus two hours.
    # deep_inventory.run_pass() emits disk.deep.end; first live completion 14 Nov.
    'disk.deep.end': dict(name='disk.deep.end', target=None, gapHours=26, since='2026-11-14'),
    # ~/.local/share/robob-watch/watchers/dev-janitor/watcher.json:
    # interval_s=3600; allow one missed hourly run.
    'janitor.run': dict(name='janitor.run', target=None, gapHours=2, since='2026-11-13'),
    # ~/Library/LaunchAgents/com.abdullah.health-backup.plist:
    # StartInterval=21600 (six hours), plus one hour of slack.
    'backup.run:health': dict(name='backup.run', target='health', gapHours=7, since='2026-11-13'),
    # integrations/memory-system/scripts/com.abdullah.memory-backup.plist:
    # StartInterval=14400 (four hours), plus one hour of slack.
    'backup.run:memory': dict(name='backup.run', target='memory', gapHours=5, since='2026-11-13'),
    # Robob "Daily CVE sweep", verified 2026-11-13 via list_scheduled_tasks:
    # cron "0 9 * * *", Asia/Dubai (05:00 UTC); daily plus two hours slack.
    'sweep.run': dict(name='sweep.run', target=None, gapHours=26, since='2026-11-13'),
}


def timestamp(value):
    # Python 3.9 needs Z and compact offsets normalized before fromisoformat.
    if not isinstance(value, str):
        raise ValueError('invalid timestamp')
    value = re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', value.replace('Z', '+00:00'))
    at = dt.datetime.fromisoformat(value)
    if at.tzinfo is None:
        raise ValueError('timestamp requires timezone')
    return at.astimezone(UTC)


def stamp(at):
    return at.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def read_days(root, first_day, last_day):
    rows, missing, errors = [], [], []
    malformed = 0
    for offset in range((last_day - first_day).days + 1):
        date = first_day + dt.timedelta(days=offset)
        filename = date.isoformat() + '.ndjson'
        try:
            with (root / filename).open('rb') as stream:
                for line in stream:
                    try:
                        row = json.loads(line)
                        if (not isinstance(row, dict) or row.get('tool') != 'mac'
                                or row.get('kind') not in ('event', 'perf', 'error')
                                or not isinstance(row.get('name'), str)
                                or not isinstance(row.get('props', {}), dict)
                                or ('ok' in row and type(row['ok']) is not bool)):
                            raise ValueError('invalid row')
                        rows.append((timestamp(row.get('ts')), row))
                    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
                        malformed += 1
        except FileNotFoundError:
            missing.append(filename)
        except OSError:
            errors.append(filename)
    return rows, missing, errors, malformed


def report(now=None, root=None, *, day=None):
    try:
        now = dt.datetime.now(UTC) if now is None else timestamp(now) if isinstance(now, str) else now.astimezone(UTC)
        day = now.date() if day is None else day
        window_start = now - dt.timedelta(hours=36)
        # Before noon UTC the 36-hour window spans three day files.
        rows, missing, errors, malformed = read_days(
            Path(root) if root is not None else directory(), window_start.date(), day)
        jobs = {}
        for key, cadence in CADENCES.items():
            since = dt.datetime.combine(dt.date.fromisoformat(cadence['since']), dt.time(), UTC)
            cutoff = max(since, window_start)
            matching = [(at, row) for at, row in rows
                        if since <= at <= now and row['name'] == cadence['name']
                        and (cadence['target'] is None or row.get('props', {}).get('target') == cadence['target'])]
            last = max(matching, key=lambda item: item[0], default=None)
            age = (now - last[0]).total_seconds() / 60 if last else None
            gap = cadence['gapHours'] * 60
            recent = sum(at >= cutoff for at, _ in matching)
            elapsed = age if age is not None else (now - since).total_seconds() / 60
            state = 'PENDING' if now < since else 'OK'
            if now >= since and elapsed > gap:
                state = 'SILENT' if not recent else 'LATE'
            jobs[key] = dict(lastSeen=stamp(last[0]) if last else None,
                             lastOk=last[1].get('ok') if last else None,
                             ageMin=round(age, 3) if age is not None else None,
                             lines=recent, gapMaxMin=gap, since=cadence['since'], status=state)
        return dict(now=stamp(now), jobs=jobs,
                    missingJobs=[key for key, job in jobs.items() if job['status'] in ('LATE', 'SILENT')],
                    missingFiles=missing, readErrors=errors, malformed=malformed)
    except Exception:
        return dict(jobs={}, missingJobs=[], error='status.unavailable')


def main(argv=None):
    as_json = False
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--now', help='ISO timestamp with timezone')
        parser.add_argument('--json', action='store_true')
        args = parser.parse_args(argv)
        as_json = args.json
        result = report(args.now)
        if as_json:
            print(json.dumps(result, indent=2))
        elif 'error' in result:
            print(result['error'])
        else:
            for key, row in result['jobs'].items():
                age = 'unknown' if row['ageMin'] is None else '%g min' % row['ageMin']
                print('%-20s %-7s last=%s age=%s ok=%s' %
                      (key, row['status'], row['lastSeen'] or 'never', age, json.dumps(row['lastOk'])))
            for filename in result['missingFiles']:
                print('missing day file: ' + filename)
            for filename in result['readErrors']:
                print('unreadable day file: ' + filename)
            print('malformed lines: %d' % result['malformed'])
    except SystemExit:
        pass  # argparse help and invalid options both leave this command successful.
    except Exception:
        try:
            print(json.dumps({'error': 'status.unavailable'}) if as_json else 'status.unavailable')
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    main()
