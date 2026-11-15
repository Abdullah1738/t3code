"""Observe the Mac app's tailnet; never change its preferences or connection."""
import datetime as dt
import fcntl
import json
import os
import subprocess
import time

from jobs import read_state, save_state, state_path
from toollog import emit

APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
EXTENSION = 'io.tailscale.ipn.macsys.network-extension'
THRESHOLD_CHECKS = 3
PROBE_HOST = '100.75.104.72'
STATES = {'Running', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState'}
DUBAI = dt.timezone(dt.timedelta(hours=4))


def command(argv, timeout, run):
    try:
        result = run(argv, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout, None if result.returncode == 0 else 'exit'
    except subprocess.TimeoutExpired:
        return None, '', 'timeout'
    except OSError:
        return None, '', 'unavailable'


def observe(run, probe_host):
    code, output, failure = command([APP_CLI, 'status', '--json'], 5, run)
    props = dict(backendState='Unknown', selfOnline=None, tailscaleIPsCount=None,
                 exitCode=code, timedOut=failure == 'timeout', statusError=failure)
    if failure is None:
        try:
            data = json.loads(output)
            state, own, ips = data['BackendState'], data.get('Self'), data.get('TailscaleIPs')
            if state not in STATES or ips is not None and not isinstance(ips, list):
                raise ValueError('invalid status')
            online = own.get('Online') if isinstance(own, dict) else None
            if online is not None and type(online) is not bool:
                raise ValueError('invalid online flag')
            props.update(backendState=state, selfOnline=online, tailscaleIPsCount=len(ips) if ips is not None else 0)
        except (ValueError, KeyError, TypeError, AttributeError):
            props['statusError'] = 'parse'
    props['up'] = (props['statusError'] is None and props['backendState'] == 'Running'
                   and props['selfOnline'] is True)
    code, output, failure = command(['/usr/bin/pgrep', '-x', EXTENSION], 3, run)
    try:
        pids = sorted({int(pid) for pid in output.split()}) if code == 0 else []
        if any(pid <= 0 for pid in pids):
            raise ValueError('invalid pid')
        props['extensionPids'] = ' '.join(map(str, pids)) or None
        props['extensionPid'] = pids[0] if pids else None
        props['extensionError'] = failure if code != 1 else None
    except ValueError:
        props.update(extensionPids=None, extensionPid=None, extensionError='parse')
    props.update(homeReachable=None, homeProbeError=None)
    if props['backendState'] == 'Running':
        code, _, failure = command(['/usr/bin/nc', '-z', '-G', '3', probe_host, '22'], 4, run)
        props.update(homeReachable=code == 0, homeProbeError=failure)
    return props


def notify(message, run):
    env = dict(os.environ)
    env.pop('BUN_INSPECT', None)
    result = run(['/Users/ardud/.bun/bin/bun',
                  '/Users/ardud/.local/share/telegram-bridge/src/cli.ts', 'notify',
                  '--source', 'Mac Upkeep', '--severity', 'attention',
                  '--text', message['text'], '--key', message['key']],
                 capture_output=True, timeout=10, env=env)
    return result.returncode == 0


def transition(state, props, now, threshold):
    pending = state.setdefault('pending', [])
    outage = state.get('outage')
    if props['up']:
        if outage and outage.get('alertQueued'):
            minutes = max(0, int((now-outage['start'])/60))
            pending.append(dict(kind='recovery', key=outage['key']+':recovery',
                                text='Mac Tailscale back up after %d min' % minutes))
        state['outage'] = None
    else:
        if not outage:
            outage = dict(start=int(now), checks=0, alertQueued=False)
            state['outage'] = outage
        outage['checks'] += 1
        if outage['checks'] >= threshold and not outage['alertQueued']:
            label = props['statusError'] or props['backendState']
            if label == 'Running':
                label = 'Running (offline)'
            # Both payload and key are frozen before sending: a CLI timeout can
            # follow successful queueing, and the bridge requires identical retries.
            outage['key'] = 'mac-tailnet:%s:%d' % (label, outage['start'])
            since = dt.datetime.fromtimestamp(outage['start'], DUBAI).strftime('%H:%M')
            pending.append(dict(kind='alert', key=outage['key'], text=(
                'Mac Tailscale is %s since %s Dubai: offbox, .tail and phone access to Robob '
                'are down. If you turned it off on purpose, ignore this.' % (label, since))))
            outage['alertQueued'] = True
    props['notUpChecks'] = state['outage']['checks'] if state.get('outage') else 0
    props['outageStart'] = state['outage']['start'] if state.get('outage') else None


def check(run=subprocess.run, now=None, threshold=THRESHOLD_CHECKS, probe_host=PROBE_HOST):
    started = time.monotonic()
    now = time.time() if now is None else now
    try:
        with state_path('tailnet').with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            state = read_state('tailnet')
            props = observe(run, probe_host)
            previous = state.get('previous', {})
            # Reachability is evidence about home, never an outage trigger.
            fields = ('backendState', 'selfOnline', 'tailscaleIPsCount', 'exitCode', 'timedOut', 'statusError')
            if not previous or any(props[k] != previous.get(k) for k in fields):
                emit('tailnet', 'event', 'tailnet.state', ok=props['up'], props=props)
            if not previous or props['extensionPids'] != previous.get('extensionPids'):
                emit('tailnet', 'event', 'tailnet.extension', props=props)
            transition(state, props, now, threshold)
            state['previous'] = props.copy()
            save_state('tailnet', state)
            emit('tailnet', 'event' if props['statusError'] is None else 'error', 'tailnet.sample',
                 ok=props['up'], duration_ms=(time.monotonic()-started)*1000, props=props,
                 error_tag='tailnet.status_failed' if props['statusError'] else None)
            # Bounded to two attempts per tick so failures never overrun a minute.
            for _ in range(min(2, len(state['pending']))):
                message = state['pending'][0]
                try:
                    sent = notify(message, run)
                except (OSError, subprocess.TimeoutExpired):
                    sent = False
                emit('tailnet', 'event' if sent else 'error', 'tailnet.'+message['kind'],
                     ok=sent, error_tag=None if sent else 'tailnet.notify_failed')
                if not sent:
                    break
                state['pending'].pop(0)
                save_state('tailnet', state)
            return props
    except Exception:
        emit('tailnet', 'error', 'tailnet.sample', ok=False, error_tag='tailnet.check_failed')
        return None
