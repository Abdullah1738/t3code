#!/usr/bin/python3
"""Read-only cadence and launchd report; exit 1 when checks are not OK."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from toollog import directory
from spawn_schema import summary as spawn_summary

UTC = dt.timezone.utc
LAUNCHD_LABELS = (
    'com.abdullah.mac-log-collector',
    'com.abdullah.mac-deep-inventory',
    'com.abdullah.mac-memory',
    'com.abdullah.mac-cpu',
    'com.abdullah.mac-ssd-read-probe',
    'com.abdullah.mac-guard',
)
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
    # launchd/com.abdullah.mac-ssd-read-probe.plist: independent StartInterval=60.
    'disk.ssd_read_probe': dict(name='disk.ssd_read_probe', target=None, gapHours=.05, since='2026-11-17'),
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
        guard_rows = [(at, row) for at, row in rows if now-dt.timedelta(hours=24) <= at <= now
                      and row['name'].startswith('macguard.')]
        samples = [(at, row) for at, row in guard_rows if row['name'] == 'macguard.sample']
        last_guard = max(samples, key=lambda item: item[0], default=None)
        guard = dict(lastSample=stamp(last_guard[0]) if last_guard else None,
                     strain=last_guard[1].get('props', {}).get('strain') if last_guard else None,
                     actions24h=sum(row['name'] == 'macguard.action' and row.get('props', {}).get('result') == 'sent' for _, row in guard_rows),
                     restarts24h=sum(row['name'] == 'macguard.robob_restart' and row.get('props', {}).get('result') == 'launched' for _, row in guard_rows))
        spawn = max(((at, row) for at, row in rows if at <= now and row['name'] == 'host.spawn_sample'), key=lambda v:v[0], default=None)
        return dict(now=stamp(now), jobs=jobs, guard=guard,
                    spawnSample=dict(spawn_summary(spawn[1].get('props', {})), ts=stamp(spawn[0]), ageMin=(now-spawn[0]).total_seconds()/60) if spawn else None,
                    missingJobs=[key for key, job in jobs.items() if job['status'] in ('LATE', 'SILENT')],
                    missingFiles=missing, readErrors=errors, malformed=malformed)
    except Exception:
        return dict(jobs={}, missingJobs=[], error='status.unavailable')


def launchd_status(runner=None, uid=None):
    runner = subprocess.run if runner is None else runner
    uid = os.getuid() if uid is None else uid
    states = {}
    for label in LAUNCHD_LABELS:
        state = 'unknown'
        try:
            result = runner(['/bin/launchctl', 'print', 'gui/%d/%s' % (uid, label)],
                            capture_output=True, text=True, timeout=2)
            if result.returncode == 0:
                state = 'loaded'
            elif 'Could not find service' in (result.stderr or ''):
                state = 'not-loaded'
        except (OSError, subprocess.TimeoutExpired):
            pass
        states[label] = state
    return states


def live_report(now=None, root=None, *, runner=None):
    # Historical rollups use report() alone: current launchd state says nothing
    # about whether a job was loaded on the day being rebuilt.
    result = report(now, root)
    result['launchd'] = launchd_status(runner)
    result.setdefault('guard', {})['worker'] = guard_worker(runner)
    result['ok'] = (not result.get('error') and not result['missingJobs']
                    and not result.get('readErrors')
                    and all(state == 'loaded' for state in result['launchd'].values()))
    return result


def guard_worker(runner=None):
    try:
        path = Path.home()/'.local/state/mac-guard/worker.json'
        worker = json.loads(path.read_text())
        if not isinstance(worker, dict):
            return 'unknown'
        tid = worker.get('threadId')
        if not tid:
            return 'unknown' if worker.get('launchUnknown') else None
        run = subprocess.run if runner is None else runner
        result = run([str(Path.home()/'.local/bin/t3ctl'), 'status', tid],
                     capture_output=True, text=True, timeout=2)
        if result.returncode:
            return 'unknown: '+tid
        body = json.loads(result.stdout)
        if not isinstance(body, dict):
            return 'unknown: '+tid
        thread = body.get('thread', body)
        if not isinstance(thread, dict):
            return 'unknown: '+tid
        ended = (thread.get('state') == 'idle' and thread.get('status') in ('completed', 'cancelled', 'failed', 'interrupted')
                 and not thread.get('activeRunId') and not thread.get('pendingRequests'))
        return None if ended else tid
    except FileNotFoundError:
        return None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 'unknown'


def main(argv=None):
    as_json = False
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--now', help='ISO timestamp with timezone')
        parser.add_argument('--json', action='store_true')
        args = parser.parse_args(argv)
        as_json = args.json
        result = live_report(args.now)
        if as_json:
            print(json.dumps(result, indent=2))
        else:
            guard = result.get('guard', {})
            print('mac-guard last=%s strain=%s actions24h=%s restarts24h=%s worker=%s' %
                  (guard.get('lastSample') or 'never', guard.get('strain'), guard.get('actions24h', 0),
                   guard.get('restarts24h', 0), guard.get('worker') or 'none'))
            for label, state in result['launchd'].items():
                print('%-38s %s' % (label, state))
            if 'error' in result:
                print(result['error'])
            for key, row in result.get('jobs', {}).items():
                age = 'unknown' if row['ageMin'] is None else '%g min' % row['ageMin']
                print('%-20s %-7s last=%s age=%s ok=%s' %
                      (key, row['status'], row['lastSeen'] or 'never', age, json.dumps(row['lastOk'])))
            spawn = result.get('spawnSample')
            if spawn:
                parents = ', '.join('%s[%s]:%s' % (p.get('family') or p.get('parent_comm'), p.get('ppid'), p.get('births')) for p in spawn['top_spawners'])
                print('spawn >=%s births/min; runnable pri<=4=%s; partial=%s; age=%g min; top: %s' % (spawn['births_per_min'], spawn['runnable_pri_le4'], spawn['partial'], spawn['ageMin'], parents))
            for filename in result.get('missingFiles', []):
                print('missing day file: ' + filename)
            for filename in result.get('readErrors', []):
                print('unreadable day file: ' + filename)
            print('malformed lines: %d' % result.get('malformed', 0))
            print('ok: %s' % json.dumps(result['ok']))
        return 0 if result['ok'] else 1
    except SystemExit as error:
        return error.code
    except Exception:
        try:
            print(json.dumps({'ok': False, 'error': 'status.unavailable'}) if as_json else 'status.unavailable')
        except Exception:
            pass
    return 1


if __name__ == '__main__':
    sys.exit(main())
