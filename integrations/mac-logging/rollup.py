#!/usr/bin/python3
"""Daily aggregation; only the bounded shared fields reach the output."""
import argparse
from collections import Counter, defaultdict
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import tempfile
from toollog import directory, private_dir, safe_fields, finite_number, memory_command, emit
from status import report
from jobs import INVENTORY_PARTS_FRESH_S


def budget_rows(source):
    try:
        with source.open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if row.get('tool') != 'mac' or row.get('name') != 'disk.budget':
                        continue
                    props = safe_fields(row.get('props'), 'disk.budget')
                    at = dt.datetime.fromisoformat(row['ts'].replace('Z', '+00:00'))
                    if (at.tzinfo is not None and props.get('path') and props.get('owner')
                            and finite_number(props.get('sizeGb')) and props.get('source') in ('inventory', 'deep')
                            and finite_number(props.get('sizeAgeS'))
                            and finite_number(props.get('budgetGb'))):
                        yield at.timestamp(), props
                except (ValueError, TypeError, KeyError, AttributeError):
                    continue
    except OSError:
        return


def budget_rollup(day, root):
    date = dt.date.fromisoformat(day)
    current = list(budget_rows(root/(day+'.ndjson')))
    history = list(current)
    # Decomposed sizes can be 72h old while fresh. Their 24h baseline can
    # predate that again, plus the two-hour comparison tolerance.
    history_days = math.ceil((INVENTORY_PARTS_FRESH_S+26*3600)/86400)
    for delta in range(1, history_days+1):
        history.extend(budget_rows(root/((date-dt.timedelta(days=delta)).isoformat()+'.ndjson')))
    latest, by_path = {}, defaultdict(list)
    for at, props in history:
        by_path[props['path']].append((at-props['sizeAgeS'], props))
    for at, props in current:
        if at > latest.get(props['path'], (float('-inf'), {}))[0]:
            latest[props['path']] = at, props
    over = []
    for path, (at, props) in latest.items():
        if props['sizeGb'] <= props['budgetGb']:
            continue
        # Never call the first/last samples of a short day "24h growth".
        measured_at = at-props['sizeAgeS']
        baselines = [(abs(measured_at-old_at-86400), old_at, old) for old_at, old in by_path[path]
                     if abs(measured_at-old_at-86400) <= 7200]
        baseline = min(baselines, key=lambda b: b[:2]) if baselines else None
        over.append(dict(props, overBy=max(0, props['sizeGb']-props['budgetGb']),
                         sampleTs=dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(),
                         sizeTs=dt.datetime.fromtimestamp(measured_at, dt.timezone.utc).isoformat(),
                         growth24hGb=props['sizeGb']-baseline[2]['sizeGb'] if baseline else None,
                         growthWindowS=measured_at-baseline[1] if baseline else None))
    return dict(pathsMeasured=len(latest), topOverBudget=sorted(over, key=lambda p: (-p['overBy'], p['path']))[:10])


def rollup(day, root=None, publish=False, now=None):
    day = dt.date.fromisoformat(day).isoformat()
    root = Path(root) if root else directory()
    private_dir(root/'state')
    # A delayed boot can repair a completed day while the hourly collector is
    # rolling it up. Serialize the snapshot, replacement and published counts.
    with (root/'state'/('rollup-'+day+'.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = aggregate(day, root)
        if publish:
            props = {'backup.'+key+'.'+target: count
                     for key, targets in result['backup'].items() for target, count in targets.items()}
            props.update(day=day, boots=result['boots'], uncleanBoots=result['uncleanBoots'])
            if not emit('rollup', 'event', 'log.rollup', ok=True, props=props, now=now):
                raise OSError('rollup publication failed')
        return result


def aggregate(day, root):
    day = dt.date.fromisoformat(day).isoformat()
    root = Path(root) if root else directory()
    names, kinds, durations, tags, samples = Counter(), Counter(), defaultdict(list), Counter(), {}
    disk = dict(probes=0, timeouts=0, maxDurationMs=None, latestBlockedIn=None)
    inventory = dict(scans=0, rootsOk=0, rootsPartial=0, rootsTimeout=0, rootsDenied=0, scanMs=0)
    backup = {key: dict.fromkeys(('memory', 'health', 'other'), 0)
              for key in ('skipped_runs', 'ok_runs', 'failed_runs')}
    latest_blocked_at = ''
    waits = dict(runs=0, maxStuckForS=None, latestStuckUnmountMountPoint=None, busyRuns=0, topBusyComms=[])
    busy_comms = Counter()
    latest_unmount_at = ''
    boots = {}
    spikes = dict(minutes=0, highestLoad=[])
    u_episodes = {}
    total = oks = failed = outcomes = malformed = 0
    source = root / (day + '.ndjson')
    if source.exists():
        with source.open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if row.get('tool') != 'mac' or row.get('kind') not in ('event', 'perf', 'error'):
                        raise ValueError()
                    name, kind = row['name'], row['kind']
                    names[name] += 1
                    kinds[kind] += 1
                    total += 1
                    if name == 'boot.observed':
                        props = safe_fields(row.get('props'), name)
                        if props.get('bootTime') and type(props.get('clean')) is bool:
                            boots[props['bootTime']] = props['clean']
                    if name == 'cpu.spike':
                        props = safe_fields(row.get('props', {}), name)
                        load = props.get('load')
                        if load:
                            spikes['minutes'] += 1
                            # These are names already sanitized on write. Apply
                            # path/credential guards without mistaking long Apple
                            # basenames for opaque argv tokens a second time.
                            raw = row.get('props', {})
                            families = Counter()
                            for proc in raw.get('top', [])[:15]:
                                if isinstance(proc, dict) and finite_number(proc.get('cpuPct')) and proc['cpuPct'] >= 0:
                                    families[memory_command(proc.get('family'))] += proc['cpuPct']
                            spawned = [dict(family=memory_command(p.get('family')), count=p['count'])
                                       for p in raw.get('spawnedFamilies', [])[:8]
                                       if isinstance(p, dict) and type(p.get('count')) is int and p['count'] >= 0]
                            minute = dict(ts=row.get('ts'), load1=load[0],
                                          systemCpuPct=props.get('systemCpuPct'),
                                          unattributedCpuPct=props.get('unattributedCpuPct'),
                                          families=[dict(family=f, cpuPct=round(v, 3)) for f, v in families.most_common(3)],
                                          spawnedFamilies=sorted(spawned, key=lambda p: (-p['count'], p['family']))[:3])
                            spikes['highestLoad'].append(minute)
                            spikes['highestLoad'] = sorted(spikes['highestLoad'], key=lambda p: -p['load1'])[:5]
                    if type(row.get('ok')) is bool:
                        outcomes += 1
                        oks += row['ok']
                        failed += not row['ok']
                    if name == 'backup.run':
                        props = row.get('props', {})
                        target = props.get('target')
                        if target in ('memory', 'health', 'other'):
                            if props.get('skipped') == 1:
                                backup['skipped_runs'][target] += 1
                            elif props.get('skipped') == 0 and row.get('ok') is True:
                                backup['ok_runs'][target] += 1
                            elif props.get('skipped') == 0 and row.get('ok') is False:
                                backup['failed_runs'][target] += 1
                    value = row.get('durationMs')
                    if finite_number(value) and value >= 0:
                        durations[name].append(value)
                    if name == 'disk.tooling_probe':
                        props = row.get('props', {})
                        if not props.get('skipped'):
                            disk['probes'] += 1
                            disk['timeouts'] += props.get('timedOut') is True
                            if finite_number(value) and value >= 0:
                                disk['maxDurationMs'] = max(disk['maxDurationMs'] or 0, value)
                        blocked = props.get('blockedIn')
                        stamp = row.get('ts', '')
                        if blocked in ('SKHelperClient', 'SKManager', 'DiskArbitration', 'DASession', 'unknown') and stamp >= latest_blocked_at:
                            disk['latestBlockedIn'], latest_blocked_at = blocked, stamp
                    if name == 'disk.inventory' and not row.get('props', {}).get('skipReason'):
                        inventory['scans'] += 1
                        props = safe_fields(row.get('props'))
                        for key in ('rootsOk', 'rootsPartial', 'rootsTimeout', 'rootsDenied', 'scanMs'):
                            value = props.get(key)
                            if type(value) in (int, float) and value >= 0:
                                inventory[key] += value
                    if name == 'proc.disk_wait':
                        raw = row.get('props', {})
                        props = safe_fields(raw, name)
                        # Legacy ageS measured uptime, not a stuck duration. Keep
                        # its maximum separate so old days remain readable.
                        for proc in raw.get('procs', []):
                            age = proc.get('ageS') if isinstance(proc, dict) and 'processAgeS' not in proc else None
                            if type(age) is int and age >= 0:
                                waits['legacyMaxProcessAgeS'] = max(waits.get('legacyMaxProcessAgeS', 0), age)
                        count = props.get('count', 0)
                        if count > 0:
                            waits['runs'] += 1
                        for proc in props.get('procs', []):
                            waits['maxStuckForS'] = max(waits['maxStuckForS'] or 0, proc['stuckForS'])
                        if props.get('busyCount', 0) > 0:
                            waits['busyRuns'] += 1
                        busy_comms.update(p['comm'] for p in props.get('busy', []))
                        mount = props.get('mountPoint')
                        stamp = row.get('ts', '')
                        if props.get('stuckUnmount') and mount and stamp >= latest_unmount_at:
                            waits['latestStuckUnmountMountPoint'], latest_unmount_at = mount, stamp
                    if name in ('proc.u_sample', 'proc.u_episode') and row.get('ok') is True:
                        props = safe_fields(row.get('props'), name)
                        episode = props.get('episode', {}) if name == 'proc.u_sample' else props
                        if episode:
                            start = episode['start']
                            stamp = row.get('ts', '')
                            if stamp >= u_episodes.get(start, ('', {}))[0]:
                                u_episodes[start] = (stamp, episode)
                    tag = row.get('error', {}).get('tag')
                    if tag:
                        tags[tag] += 1
                        samples.setdefault(tag, safe_fields(row.get('ids')))
                except (ValueError, TypeError, KeyError, AttributeError):
                    malformed += 1
    waits['topBusyComms'] = [dict(comm=comm, count=count) for comm, count in busy_comms.most_common(5)]
    stats = {}
    for name, values in durations.items():
        values.sort()
        stats[name] = {key: values[max(0, math.ceil(len(values) * pct) - 1)] for key, pct in [('p50', .5), ('p95', .95), ('max', 1)]}
    result = dict(day=day, tool='mac', boots=len(boots), uncleanBoots=sum(not clean for clean in boots.values()), cpuSpikes=spikes, backup=backup, diskTooling=disk, diskWait=waits, diskInventory=inventory, total=total, countsByName=dict(names), countsByKind=dict(kinds),
                  outcomes=outcomes, okRate=oks / outcomes if outcomes else None,
                  errorRate=kinds['error'] / total if total else None,
                  failedRate=failed / outcomes if outcomes else None, durationMs=stats, malformed=malformed,
                  topErrors=[dict(tag=t, count=c, sampleIds=samples[t]) for t, c in tags.most_common(20)])
    # Freeze the cadence view at this day's end, regardless of when it is rebuilt.
    date = dt.date.fromisoformat(day)
    end = dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), dt.timezone.utc)
    cadence = report(end, root, day=date)
    result.update(jobs=cadence['jobs'], missingJobs=cadence['missingJobs'])
    result['spawnSample'] = cadence.get('spawnSample')
    result['diskBudgets'] = budget_rollup(day, root)
    result['uEpisodes'] = [dict(start=ep['start'], end=ep['end'], lastSeen=ep['lastSeen'],
                              peakCount=ep['peakCount'], volumes=ep['volumes'], topComms=ep['topComms'])
                           for _, (_, ep) in sorted(u_episodes.items())]
    private_dir(root)
    fd, temp = tempfile.mkstemp(prefix='.rollup-', dir=root)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, separators=(',', ':'))
        os.replace(temp, root / ('rollup-' + day + '.json'))
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--day', default=(dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat())
    args = parser.parse_args()
    print(json.dumps(rollup(args.day), indent=2))


if __name__ == '__main__':
    main()
