"""Bounded shutdown context from the sources verified in Mac Upkeep #164."""
import datetime as dt
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def parse_shutdown(text, boot):
    from boot import epoch, iso
    request = dict(operation=None, requestedAt=None, confirmedAt=None, senderPid=None,
                   senderBundle=None, senderName=None, senderForeground=None,
                   humanActor='not established', callerChain=None, initiatedAt=None,
                   softwareUpdate=None)
    rows, dropped = [], 0
    for line in text.splitlines():
        try:
            row = json.loads(line)
            at = epoch(row['timestamp'])
            if not boot-180 <= at < boot:
                dropped += 1
                continue
            rows.append((at, row))
        except (ValueError, KeyError, TypeError):
            continue
    audit, apps, forced = None, {}, None
    receiver = logout_type = None

    def start_request(operation, at, sender=None):
        request.update(operation=operation, requestedAt=iso(at), confirmedAt=None,
                       senderPid=sender, senderBundle=None, senderName=None, senderForeground=None)
    for at, row in sorted(rows, key=lambda item: item[0]):
        msg = row.get('eventMessage', '')
        process = Path(row.get('processImagePath') or '').name
        if process == 'loginwindow':
            pid = re.search(r'handleAppleEvent:.*\|\s+pid:\s*(\d+)\s*$', msg)
            if pid:
                audit = (int(pid[1]), at, row.get('processID'))
            dialog = re.search(r'Received a kAEShow(Restart|Shutdown)Dialog\b', msg)
            logout = re.search(r'logoutType:\s*(\d+)\s*-\s*(Restart|Shutdown)\b', msg, re.I)
            if dialog:
                start_request(dialog[1].lower(), at,
                              audit[0] if audit and at-audit[1] <= 2 and audit[2] == row.get('processID') else None)
                receiver, logout_type = row.get('processID'), None
                audit = None
            elif logout:
                # A type row immediately following a dialog enriches that flow;
                # a later type-only request starts with its own attribution.
                if not (request['operation'] == logout[2].lower() and logout_type is None
                        and receiver == row.get('processID') and request['requestedAt']
                        and at-epoch(request['requestedAt']) <= 2):
                    start_request(logout[2].lower(), at)
                receiver, logout_type = row.get('processID'), logout[1]
                audit = None
            cancelled = re.search(r'ShutdownLogoutUIManager _showAlert.*\blogoutType\s+(\d+),.*\bresult\s+1001\b', msg)
            if cancelled and receiver == row.get('processID') and logout_type in (None, cancelled[1]):
                start_request(None, at)
                request['requestedAt'] = None
                audit = receiver = logout_type = None
            confirmed = re.search(r'ShutdownLogoutUIManager (restart|shutdown):\]\s*\|\s*enter', msg, re.I)
            if confirmed and confirmed[1].lower() == request['operation'] and receiver == row.get('processID'):
                request['confirmedAt'] = iso(at)
            if 'appDictionary:' in msg:
                pid = re.search(r'\bpid\s*=\s*(\d+)\s*;', msg)
                if pid:
                    def field(name):
                        match = re.search(r'\b'+name+r'\s*=\s*"?([^;"\n]+)"?\s*;', msg)
                        return match[1].strip() if match else None
                    apps[int(pid[1])] = dict(senderBundle=field('BundleIdentifierLowerCase'),
                                             senderName=field('LSDisplayName'),
                                             senderForeground=field('ApplicationType') == 'Foreground')
        if process == 'launchd':
            chain = re.search(r'System shutdown initiated by: (.+)$', msg)
            if chain:
                request.update(callerChain=chain[1], initiatedAt=iso(at))
        if row.get('subsystem') == 'com.apple.sessionlogoutd' and 'Restart is not a software update' in msg:
            request['softwareUpdate'] = False
        # PMU wdog tokens and ordinary watchdog monitoring are not timeout evidence.
        if process in ('kernel', 'watchdogd') and re.search(
                r'userspace watchdog timeout|watchdog timeout:.*(?:check.?in|checkins)|no successful checkins from', msg, re.I):
            forced = True
    request.update(apps.get(request['senderPid'], {}))
    return dict(shutdownRequest=request, forcedWatchdogTimeout=forced), dict(
        read='unified shutdown context', droppedRows=dropped,
        error=None, verdict='established' if forced else 'not established')


def shutdown_context(boot, run):
    from logwindow import read_window
    start, end = (dt.datetime.fromtimestamp(at, dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S+0000')
                  for at in (int(boot)-179, int(boot)))
    text, stats = read_window(int(boot)-179, int(boot),
                             'process == "loginwindow" OR process == "launchd" OR process == "sessionlogoutd" '
                             'OR subsystem == "com.apple.sessionlogoutd" OR process == "kernel" OR process == "watchdogd"',
                             run=run, timeout=15, info=True, debug=True)
    props, source = parse_shutdown(text, boot)
    source['droppedRows'] += stats['rowsOutside']+stats['unparsed']
    source['error'] = stats['error']
    source.update(windowStart=start, windowEnd=end)
    return props, source


def kernel_reasons(boot, run):
    from boot import command
    from logwindow import parse_boottime
    text = command(['/usr/sbin/sysctl', 'kern.boottime', 'kern.shutdownreason', 'kern.bootreason'], run)
    fields = dict(line.split(': ', 1) for line in text.splitlines() if ': ' in line)
    if abs(parse_boottime(fields.get('kern.boottime', ''))-boot) > 0.000001:
        raise ValueError('kernel reasons belong to another boot')
    return dict(shutdownReason=fields.get('kern.shutdownreason'), bootReason=fields.get('kern.bootreason'))


def sample_interval(text):
    from boot import epoch, iso
    fields = {}
    for label, key in [('Date/Time', 'sampleStart'), ('End time', 'sampleEnd')]:
        match = re.search(r'^'+label+r':[ \t]*(.+)$', text, re.M)
        if not match:
            raise ValueError('missing stackshot interval')
        fields[key] = iso(epoch(match[1]))
    if epoch(fields['sampleEnd']) < epoch(fields['sampleStart']):
        raise ValueError('reversed stackshot interval')
    return fields


def stall_interval(path, run):
    from boot import command
    from collector import unified_command
    # Decode the existing report only; spindump is never invoked to sample a PID.
    with tempfile.TemporaryDirectory(prefix='mac-boot-stall-') as scratch:
        # spindump -i appends analysis metadata to its input. Never pass the
        # diagnostic itself, even though this operation only asks for decoding.
        copied = Path(scratch)/'stall.binary'
        shutil.copyfile(path, copied)
        output = Path(scratch)/'stall.txt'
        command(['/usr/sbin/spindump', '-i', str(copied), '-o', str(output)],
                unified_command if run is subprocess.run else run, timeout=15)
        with output.open() as stream:
            return sample_interval(stream.read(16384))
