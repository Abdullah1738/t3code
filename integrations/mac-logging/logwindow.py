"""Timestamp parsing and bounded, filtered forensic unified-log reads."""
import argparse
import datetime as dt
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

UTC = dt.timezone.utc


def row_timestamp(value):
    """Parse log timestamps as exact UTC epoch seconds, through nanoseconds."""
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})?', value)
    if not match:
        return None
    fraction = (match[2] or '').rstrip('0')
    if len(fraction) > 9:
        return None
    try:
        whole = match[1]+(match[3] or '+00:00').replace('Z', '+00:00')
        at = dt.datetime.fromisoformat(re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', whole))
        delta = at.astimezone(UTC)-dt.datetime(1970, 1, 1, tzinfo=UTC)
        return Decimal(delta.days*86400+delta.seconds)+Decimal('0.'+(fraction or '0'))
    except (ValueError, OverflowError):
        return None


def stamp(at):
    whole = int(at.to_integral_value(rounding=ROUND_FLOOR))
    fraction = format(at-whole, 'f')[2:].rstrip('0')
    return dt.datetime.fromtimestamp(whole, UTC).strftime('%Y-%m-%dT%H:%M:%S')+(
        '.'+fraction if fraction else '')+'+00:00'


def query_bound(at, rounding):
    # log show's input parser accepts whole seconds, even though rows have
    # subsecond timestamps. Broaden the read and apply exact bounds ourselves.
    whole = int(at.to_integral_value(rounding=rounding))
    return dt.datetime.fromtimestamp(whole, UTC).strftime('%Y-%m-%d %H:%M:%S+0000')


def counters():
    return dict(rowsIn=0, rowsOutside=0, outsideFirst=None, outsideLast=None,
                unparsed=0, lastInWindowTs=None)


def merge_counts(total, part):
    for key in ('rowsIn', 'rowsOutside', 'unparsed'):
        total[key] += part[key]
    for key, choose in (('outsideFirst', min), ('outsideLast', max), ('lastInWindowTs', max)):
        if part[key] is not None:
            total[key] = part[key] if total[key] is None else choose(total[key], part[key])


def keep_row(line, start, end, include_end, out, outside, stats):
    try:
        row = json.loads(line)
        at = row_timestamp(row.get('timestamp')) if isinstance(row, dict) else None
    except (ValueError, UnicodeError):
        at = None
    if at is None:
        stats['unparsed'] += 1
        return
    if start <= at and (at <= end if include_end else at < end):
        out.write(line)
        stats['rowsIn'] += 1
        value = stamp(at)
        stats['lastInWindowTs'] = max(stats['lastInWindowTs'] or value, value)
    else:
        stats['rowsOutside'] += 1
        value = stamp(at)
        stats['outsideFirst'] = min(stats['outsideFirst'] or value, value)
        stats['outsideLast'] = max(stats['outsideLast'] or value, value)
        if outside is not None:
            outside.write(line)


def signal_group(child, sig):
    try:
        os.killpg(child.pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin can report EPERM for a group containing only the zombie
        # leader. poll reaps that leader; a live child must still report failure.
        if child.poll() is None:
            raise


def read_slice(command, start, end, include_end, stop, out, outside):
    began = time.monotonic()
    result = dict(start=stamp(start), end=stamp(end), status='complete',
                  exitCode=None, reason=None, **counters())
    child = None
    pending = bytearray()
    terminating = None
    try:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 start_new_session=True, env={**os.environ, 'TZ': 'UTC'})
        with selectors.DefaultSelector() as selector:
            os.set_blocking(child.stdout.fileno(), False)
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                now = time.monotonic()
                if terminating is None and now >= stop:
                    result.update(status='partial', reason='deadline')
                    signal_group(child, signal.SIGTERM)
                    terminating = now+3
                if terminating is not None and now >= terminating:
                    signal_group(child, signal.SIGKILL)
                    break
                # EOF alone does not mean log exited; it can close stdout then hang.
                if not selector.get_map() and terminating is None:
                    try:
                        child.wait(timeout=max(0, stop-now))
                        break
                    except subprocess.TimeoutExpired:
                        continue
                # Always finish the grace period: the leader may have exited
                # on TERM while a descendant still owns the pipe.
                events = selector.select(max(0, (terminating or stop)-now))
                for key, _ in events:
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        if pending:
                            keep_row(bytes(pending), start, end, include_end, out, outside, result)
                            pending.clear()
                        continue
                    pending.extend(data)
                    while b'\n' in pending:
                        line, _, tail = pending.partition(b'\n')
                        pending = bytearray(tail)
                        keep_row(bytes(line)+b'\n', start, end, include_end, out, outside, result)
                    if time.monotonic() >= (terminating or stop):
                        break
        if result['status'] != 'partial':
            result['exitCode'] = child.returncode
            if child.returncode:
                result.update(status='error', reason='log show exited %s' % child.returncode)
    except (OSError, ValueError, KeyboardInterrupt) as exc:
        result.update(status='error', reason=str(exc))
    finally:
        if child is not None:
            try:
                signal_group(child, signal.SIGKILL)
            except OSError as exc:
                result.update(status='error', reason='process-group cleanup failed: '+str(exc))
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if result['status'] != 'error':
                    result.update(status='partial', reason='deadline; child did not reap after SIGKILL')
            child.stdout.close()
            result['exitCode'] = child.returncode
        result['elapsedMs'] = round((time.monotonic()-began)*1000)
    return result


class ArgumentError(ValueError):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ArgumentError(message)


def utc_bound(value):
    at = row_timestamp(value)
    if at is None or not re.search(r'(?:Z|[+]00:?00)$', value):
        raise ArgumentError('bounds must be ISO timestamps with an explicit UTC offset')
    return at


def duration(value):
    match = re.fullmatch(r'(\d+(?:\.\d+)?)(s|m|h)?', value)
    if not match:
        raise ArgumentError('--slice must be a positive duration such as 30s or 15m')
    seconds = Decimal(match[1])*{'s': 1, 'm': 60, 'h': 3600, None: 1}[match[2]]
    if not seconds.is_finite() or seconds < Decimal('.000001'):
        raise ArgumentError('--slice must be at least one microsecond')
    return seconds


def main(argv=None):
    began = time.monotonic()
    argv = sys.argv[1:] if argv is None else argv
    summary = dict(args=argv, start=None, end=None, status='error', exitCode=1,
                   elapsedMs=0, slices=[], reason=None, **counters())
    parser = Parser(description=__doc__)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--predicate', required=True)
    parser.add_argument('--info', action='store_true')
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--deadline', type=float, default=90)
    parser.add_argument('--slice')
    parser.add_argument('--out', required=True)
    parser.add_argument('--keep-outside', action='store_true')
    # Even validation errors get a sidecar when the caller supplied an output path.
    output_parser = Parser(add_help=False)
    output_parser.add_argument('--out')
    out_path = None
    outside = None
    try:
        known, _ = output_parser.parse_known_args(argv)
        out_path = Path(known.out) if known.out else None
        args = parser.parse_args(argv)
        start, end = utc_bound(args.start), utc_bound(args.end)
        summary.update(start=stamp(start), end=stamp(end))
        if end < start:
            raise ArgumentError('--end must not precede --start')
        if not math.isfinite(args.deadline) or not 0 < args.deadline <= 600:
            raise ArgumentError('--deadline must be positive and at most 600 seconds')
        seconds = duration(args.slice) if args.slice else max(Decimal('.000001'), end-start)
        count = max(1, math.ceil((end-start)/seconds))
        stop = began+args.deadline
        summary.update(status='complete', exitCode=0)
        with out_path.open('wb') as out:
            if args.keep_outside:
                outside = Path(str(out_path)+'.outside.ndjson').open('wb')
            for index in range(count):
                left = min(end, start+seconds*index)
                right = min(end, start+seconds*(index+1))
                now = time.monotonic()
                if now >= stop:
                    summary.update(status='partial', exitCode=2, reason='deadline; remaining slices not started')
                    break
                command = [os.environ.get('MAC_LOG_WINDOW_LOG_BIN', '/usr/bin/log'), 'show',
                           '--style', 'ndjson', '--timezone', 'UTC',
                           '--start', query_bound(left, ROUND_FLOOR),
                           '--end', query_bound(right, ROUND_CEILING)]
                command += (['--info'] if args.info else [])+(['--debug'] if args.debug else [])
                command += ['--predicate', args.predicate]
                part = read_slice(command, left, right, index == count-1,
                                  now+(stop-now)/(count-index), out, outside)
                summary['slices'].append(part)
                merge_counts(summary, part)
                if part['status'] == 'error':
                    summary.update(status='error', exitCode=1, reason=part['reason'])
                    break
                if part['status'] == 'partial':
                    summary.update(status='partial', exitCode=2, reason=part['reason'])
    except (ArgumentError, OSError, OverflowError, ValueError) as exc:
        summary.update(status='error', exitCode=1, reason=str(exc))
    finally:
        if outside is not None:
            outside.close()
        summary['elapsedMs'] = round((time.monotonic()-began)*1000)
        if out_path is not None:
            try:
                Path(str(out_path)+'.summary.json').write_text(json.dumps(summary, indent=2)+'\n')
            except OSError as exc:
                summary.update(status='error', exitCode=1, reason='cannot write summary: '+str(exc))
        print('mac-log-window: {status} rowsIn={rowsIn} rowsOutside={rowsOutside} unparsed={unparsed}'.format(**summary), file=sys.stderr)
    return summary['exitCode']
