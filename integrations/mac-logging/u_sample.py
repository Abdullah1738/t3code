#!/usr/bin/python3
"""Minute U-state observations; no volume access or process intervention."""
from collections import Counter
import datetime as dt
import fcntl
import os
from pathlib import PurePosixPath
import re
import subprocess
import time

from cpu import ProbeError, command, seconds
from jobs import read_state, save_state, state_path
from toollog import emit, finite_number, u_episode_fields, u_sample_fields, u_text

# Darwin truncates non-final comm to its header width (normally 16), even
# with -ww. Reserve MAXPATHLEN before taking the basename; keep argv last.
COMM_HEADER = 'COMM'+'_'*1020
PS = ['/bin/ps', '-ww', '-axo', 'pid,ppid,lstart,etime,time,stat,comm='+COMM_HEADER+',args']
MAX_GAP_S = 180


def parse_ps(text, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else {}
    lines = text.splitlines()
    if not lines or not re.fullmatch(
            r'\s*PID\s+PPID\s+STARTED\s+ELAPSED\s+TIME\s+STAT\s+'+COMM_HEADER+r'\s+ARGS\s*', lines[0]):
        raise ProbeError('parse')
    comm_at, args_at = lines[0].index('COMM'), lines[0].index('ARGS')
    rows, bad = {}, []
    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            parts = line[:comm_at].split()
            if len(parts) != 10:
                raise ValueError()
            pid, ppid = int(parts[0]), int(parts[1])
            start = ' '.join(parts[2:7])
            time.strptime(start, '%a %b %d %H:%M:%S %Y')
            comm = line[comm_at:args_at].strip()
            if pid <= 0 or ppid < 0 or pid in rows or not comm or not re.fullmatch(r'[?A-Za-z+<>-]{1,16}', parts[9]):
                raise ValueError()
            if comm.startswith('(') and comm.endswith(')'):
                comm = comm[1:-1]
            rows[pid] = dict(pid=pid, ppid=ppid, start=start, ageS=seconds(parts[7]),
                             cpuS=seconds(parts[8]), stat=parts[9],
                             comm=PurePosixPath(comm).name, args=line[args_at:].strip())
        except (ValueError, OverflowError, ProbeError):
            # Exiting processes can yield a torn row. Never retain its argv.
            bad.append(u_text(line[:comm_at], 160)+' [comm/argv omitted]')
    if bad:
        diagnostics.update(skippedRows=len(bad), firstBadRow=bad[0])
    if not rows or len(bad) > max(5, (len(rows)+len(bad))//10):
        raise ProbeError('parse')
    return rows


def volume(args):
    # ps argv has no reliable quoting; record a path hint, never resolve/stat it.
    match = re.search(r'/Volumes/[^/\s\"\']+|/var/folders\b|/Users/[^/\s\"\']+', args)
    return match[0] if match else None


def observations(rows, previous, now):
    at = previous.get('at')
    continuous = finite_number(at) and 0 < now-at <= MAX_GAP_S
    old = previous.get('waiting', {})
    old = old if isinstance(old, dict) else {}
    waiting, qualified = {}, []
    for proc in rows.values():
        if not proc['stat'].startswith('U'):
            continue
        prior = old.get(str(proc['pid']), {})
        prior = prior if isinstance(prior, dict) else {}
        since = prior.get('since')
        same = (continuous and prior.get('start') == proc['start'] and
                finite_number(since) and 0 <= since <= at and now-since <= proc['ageS'])
        since = since if same else now
        waiting[str(proc['pid'])] = dict(start=proc['start'], since=since)
        if now-since >= 60 and proc['ageS'] >= 60:
            parent = rows.get(proc['ppid'], {})
            qualified.append(dict(proc, parentComm=parent.get('comm'),
                                  parentArgs=parent.get('args'), volume=volume(proc['args'])))
    return waiting, qualified


def episode_update(episode, procs, now, incomplete=False):
    if not procs:
        if episode and not incomplete:
            episode['emptySamples'] = episode.get('emptySamples', 0)+1
            if episode['emptySamples'] >= 3:
                episode['end'] = now
        return episode
    if not episode:
        episode = dict(start=now, end=None, lastSeen=now, peakCount=0,
                       volumes=[], topComms=[], emptySamples=0)
    episode.update(lastSeen=now, emptySamples=0, peakCount=max(episode['peakCount'], len(procs)))
    # Peak concurrency by comm, rather than a counter that grows every minute.
    comms = Counter({p['comm']: p['count'] for p in episode['topComms']})
    for comm, count in Counter(p['comm'] for p in procs).items():
        comms[comm] = max(comms[comm], count)
    episode['topComms'] = [dict(comm=c, count=n) for c, n in sorted(comms.items(), key=lambda p: (-p[1], p[0]))[:10]]
    episode['volumes'] = sorted(set(episode['volumes']) | {p['volume'] for p in procs if p['volume']})[:15]
    return u_episode_fields(episode)


def sample(run=subprocess.run, now=None, clock=time.monotonic):
    started = clock()
    now = now or dt.datetime.now(dt.timezone.utc)
    now = now.astimezone(dt.timezone.utc)
    observed = now.timestamp()
    try:
        with state_path('proc-u').with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            diagnostics = {}
            try:
                rows = parse_ps(command(PS, run, timeout=5), diagnostics)
            finally:
                if diagnostics:
                    emit('proc', 'error', 'proc.u_parse', now=now, ok=False,
                         props=diagnostics, error_tag='proc.u_parse')
            state = read_state('proc-u')
            episode = u_episode_fields(state.get('episode'))
            if finite_number(state.get('at')) and observed < state['at']:
                episode = {}
            # Retain a closed episode until its append succeeds, even on restart.
            if episode.get('end') is not None:
                if not emit('proc', 'event', 'proc.u_episode', now=now, ok=True, props=episode):
                    return None
                episode = {}
            waiting, procs = observations(rows, state, observed)
            props = None
            episode = episode_update(episode, procs, observed, incomplete=bool(diagnostics))
            if procs:
                callers = Counter(p['ppid'] for p in procs if p['comm'] == 'lsof')
                props = u_sample_fields(dict(count=len(procs), byComm=dict(Counter(p['comm'] for p in procs)),
                    procs=sorted((p for p in procs if not (p['pid'] == 99184 and state.get('umountDay') == now.date().isoformat())),
                                 key=lambda p: (p['pid'] != 99184, -p['ageS'], p['pid'])),
                    lsofStuck=sum(callers.values()), lsofCallers=[dict(parentPid=pid, n=n, parentArgs=rows.get(pid, {}).get('args'))
                        for pid, n in sorted(callers.items(), key=lambda p: (-p[1], p[0]))[:5]], episode=episode))
                if emit('proc', 'event', 'proc.u_sample', now=now, ok=True,
                        duration_ms=(clock()-started)*1000, props=props):
                    if any(p['pid'] == 99184 for p in props['procs']):
                        state['umountDay'] = now.date().isoformat()
            state = dict(at=observed, waiting=waiting, umountDay=state.get('umountDay'), episode=episode)
            save_state('proc-u', state)
            if episode.get('end') is not None:
                if emit('proc', 'event', 'proc.u_episode', now=now, ok=True, props=episode):
                    state['episode'] = {}
                    save_state('proc-u', state)
            return props
    except Exception as exc:
        # This optional probe must never prevent the CPU sampler from running.
        failure = str(exc) if isinstance(exc, ProbeError) else 'unavailable'
        props = dict(failure=failure)
        emit('proc', 'error', 'proc.u_sample', now=now, ok=False,
             duration_ms=(clock()-started)*1000, props=props, error_tag='proc.u_'+failure)
        return props


if __name__ == '__main__':
    sample()
