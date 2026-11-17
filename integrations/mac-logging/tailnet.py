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
THRESHOLD_SECONDS = 180
UNKNOWN_THRESHOLD_CHECKS = 5
UNKNOWN_THRESHOLD_SECONDS = 300
STATUS_TIMEOUT = 15
CLI_SLOW_INTERVAL = 900
PROBE_HOST = '100.75.104.72'
# Mullvad's de-dus-wg-102 DNS listener is remote, unlike our local userspace nodes.
CONFIRM_PROBES = ((PROBE_HOST, 22), ('100.64.1.71', 53))
PROBE_TIMEOUT = 6
SELF_HTTPS_URL = 'https://abdullahs-macbook-pro.tailcca332.ts.net:18400/'
SELF_HTTPS_TIMEOUT = 8
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


def probe(run, host, port):
    started = time.monotonic()
    code, _, failure = command(['/usr/bin/nc', '-z', '-G', '5', host, str(port)], PROBE_TIMEOUT, run)
    return dict(port=port, ok=code == 0, error=failure, ms=round((time.monotonic()-started)*1000, 3))


def https_probe(run):
    _, output, failure = command(['/usr/bin/curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}',
                                  '--max-time', str(SELF_HTTPS_TIMEOUT), SELF_HTTPS_URL],
                                 SELF_HTTPS_TIMEOUT+1, run)
    # A real HTTP response proves reachability, including an application error
    # or a response whose body curl could not finish downloading.
    status = output.strip()
    reachable = len(status) == 3 and status.isascii() and status.isdigit() and 100 <= int(status) <= 599
    return dict(ok=reachable, error=None if reachable else failure or 'parse')


def observe(run, probe_host=PROBE_HOST, confirm_probes=CONFIRM_PROBES):
    started = time.monotonic()
    code, output, failure = command([APP_CLI, 'status', '--json'], STATUS_TIMEOUT, run)
    props = dict(backendState='Unknown', selfOnline=None, tailscaleIPsCount=None,
                 exitCode=code, timedOut=failure == 'timeout', statusError=failure,
                 cliMs=round((time.monotonic()-started)*1000, 3))
    props.update(statusDurationMs=props['cliMs'], loadAvg1=os.getloadavg()[0], confirmedBy=None)
    if failure is None:
        try:
            data = json.loads(output)
            state, own, ips = data['BackendState'], data.get('Self'), data.get('TailscaleIPs')
            if state not in STATES or ips is not None and not isinstance(ips, list):
                raise ValueError('invalid status')
            online = own.get('Online') if isinstance(own, dict) else None
            if online is not None and type(online) is not bool or state == 'Running' and online is None:
                raise ValueError('invalid online flag')
            props.update(backendState=state, selfOnline=online, tailscaleIPsCount=len(ips) if ips is not None else 0)
        except (ValueError, KeyError, TypeError, AttributeError):
            props['statusError'] = 'parse'
    cli_outcome = ('unknown' if props['statusError'] else 'up'
                   if props['backendState'] == 'Running' and props['selfOnline'] is True else 'down')
    props.update(cliOutcome=cli_outcome, outcome=cli_outcome, homeReachable=None, homeProbeError=None)
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
    if cli_outcome == 'unknown':
        results = {host: probe(run, host, port) for host, port in confirm_probes}
        props['confirmProbes'] = results
        home = results.get(probe_host)
        if home:
            props.update(homeReachable=home['ok'], homeProbeError=home['error'])
        if any(p['ok'] for p in results.values()):
            props['outcome'] = 'up'
            props['confirmedBy'] = 'home_tcp' if home and home['ok'] else 'peer_tcp'
        else:
            https = https_probe(run)
            props.update(selfHttpsReachable=https['ok'], selfHttpsError=https['error'])
            if https['ok']:
                props.update(outcome='up', confirmedBy='self_https')
            elif (len(results) >= 2 and all(p['error'] in ('exit', 'timeout') for p in results.values())
                  and https['error'] in ('exit', 'timeout', 'parse')):
                props['outcome'] = 'down'
    elif props['backendState'] == 'Running':
        home = probe(run, probe_host, 22)
        props.update(homeReachable=home['ok'], homeProbeError=home['error'])
    props.update(up=props['outcome'] == 'up', confirmedDown=props['outcome'] == 'down')
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


def transition(state, props, now, threshold, threshold_seconds,
               unknown_threshold, unknown_threshold_seconds):
    pending = state.setdefault('pending', [])
    outage = state.get('outage')
    if props['up']:
        if outage and outage.get('alertQueued'):
            minutes = max(0, int((now-outage['start'])/60))
            pending.append(dict(kind='recovery', key=outage['key']+':recovery',
                                text='Mac Tailscale back up after %d min' % minutes))
        state['outage'] = None
    elif props['confirmedDown']:
        if not outage:
            outage = dict(start=now, checks=0, alertQueued=False)
            state['outage'] = outage
        outage['checks'] += 1
        if props['cliOutcome'] == 'unknown':
            threshold, threshold_seconds = unknown_threshold, unknown_threshold_seconds
        if (outage['checks'] >= threshold and now-outage['start'] >= threshold_seconds
                and not outage['alertQueued']):
            label = props['backendState'] if props['cliOutcome'] == 'down' else 'unreachable'
            if label == 'Running':
                label = 'Running (offline)'
            # Freeze the payload before sending: a timeout can follow successful
            # queueing, and the bridge requires identical retries.
            outage['key'] = 'mac-tailnet:%s:%d' % (label, outage['start'])
            since = dt.datetime.fromtimestamp(outage['start'], DUBAI).strftime('%H:%M')
            if label == 'unreachable':
                label = ('unreachable (status CLI timing out)' if props['timedOut']
                         else 'unreachable (status CLI unavailable)')
            text = ('Mac Tailscale is %s since %s Dubai: offbox, .tail and phone access to Robob '
                    'are down. If you turned it off on purpose, ignore this.' % (label, since))
            pending.append(dict(kind='alert', key=outage['key'], text=text))
            outage['alertQueued'] = True
    elif outage:
        # Missing probe evidence breaks the confirmed streak, but cannot prove
        # recovery of an already alerted outage.
        outage['checks'] = 0
        if not outage.get('alertQueued'):
            state['outage'] = None
    props['notUpChecks'] = state['outage']['checks'] if state.get('outage') else 0
    props['outageStart'] = state['outage']['start'] if state.get('outage') else None


def cli_slow(state, props, now):
    if props['cliOutcome'] != 'unknown' or not props['up']:
        return
    last = state.get('cliSlowAt')
    if last is None or now-last >= CLI_SLOW_INTERVAL:
        event = dict(props, suppressed=state.get('cliSlowSuppressed', 0))
        state.update(cliSlowAt=now, cliSlowSuppressed=0)
        return event
    else:
        state['cliSlowSuppressed'] = state.get('cliSlowSuppressed', 0)+1


def explicit_outage_key(key):
    return any(key.startswith('mac-tailnet:'+label+':')
               for label in (STATES-{'Running'}) | {'Running (offline)'})


def check(run=subprocess.run, now=None, threshold=THRESHOLD_CHECKS, probe_host=PROBE_HOST,
          confirm_probes=CONFIRM_PROBES, threshold_seconds=THRESHOLD_SECONDS,
          unknown_threshold=UNKNOWN_THRESHOLD_CHECKS, unknown_threshold_seconds=UNKNOWN_THRESHOLD_SECONDS):
    started = time.monotonic()
    props = dict(outcome='unknown', cliOutcome='unknown', cliMs=None, confirmedDown=False, up=False)
    try:
        with state_path('tailnet').with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            state = read_state('tailnet')
            # Legacy counters include CLI timeouts. Do not inherit an unproven
            # streak or retry an old timeout alert after this fix is installed.
            if state.get('version') != 2:
                outage = state.get('outage')
                if not (outage and outage.get('alertQueued') and explicit_outage_key(outage.get('key', ''))):
                    state['outage'] = None
                state['pending'] = [message for message in state.get('pending', [])
                                    if explicit_outage_key(message.get('key', ''))]
                state['version'] = 2
            props = observe(run, probe_host, confirm_probes)
            now = time.time() if now is None else now
            previous = state.get('previous', {})
            fields = ('backendState', 'selfOnline', 'tailscaleIPsCount', 'exitCode', 'timedOut',
                      'statusError', 'outcome')
            if (not previous or any(props[k] != previous.get(k) for k in fields)
                    or bool(props['confirmedBy']) != bool(previous.get('confirmedBy'))):
                emit('tailnet', 'event', 'tailnet.state', ok=props['up'], props=props)
            if not previous or props['extensionPids'] != previous.get('extensionPids'):
                emit('tailnet', 'event', 'tailnet.extension', props=props)
            transition(state, props, now, threshold, threshold_seconds, unknown_threshold, unknown_threshold_seconds)
            slow_event = cli_slow(state, props, now)
            state['previous'] = props.copy()
            save_state('tailnet', state)
            if slow_event is not None:
                emit('tailnet', 'event', 'tailnet.cli_slow', ok=True, props=slow_event)
            emit('tailnet', 'event' if props['statusError'] is None else 'error', 'tailnet.sample',
                 ok=props['up'], duration_ms=(time.monotonic()-started)*1000, props=props,
                 error_tag='tailnet.status_failed' if props['statusError'] else None)
            # One send caps subprocess time at 15 + 3 + 2*6 + 9 + 10 = 49 s.
            for _ in range(min(1, len(state['pending']))):
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
        emit('tailnet', 'error', 'tailnet.sample', ok=False, props=props, error_tag='tailnet.check_failed')
        return None
