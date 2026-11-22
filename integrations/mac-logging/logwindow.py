"""Timestamp parsing and bounded, filtered forensic unified-log reads."""
import argparse
from collections import Counter
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


class BootTimes(list):
    def __init__(self, seconds=(), unresolved=()):
        super().__init__(sorted(seconds))
        self.unresolved = sorted(unresolved)


def boot_boundaries(boots):
    return sorted({p for b in boots for p in (b, b+1)} |
                  {p for a, b in getattr(boots, 'unresolved', ()) for p in (a, b)})


def boot_second(start, end, boots):
    return next((b for b in boots if b <= start < end <= b+1), None)


def boot_skip(start, end, boots):
    return any(a <= start < b and end <= b for a, b in getattr(boots, 'unresolved', ()))


def split_window(since, until, boots):
    # log accepts whole seconds only. Isolate the boot second too: starting
    # exactly at its rounded timestamp can still select the preceding epoch.
    points = [since]+sorted({p for p in boot_boundaries(boots) if since < p < until})+[until]
    return list(zip(points, points[1:]))


def reader_slices(start, end, seconds, boots):
    points = [Decimal(str(p)) for p in boot_boundaries(boots)]
    cursor = start
    while True:
        index = (cursor-start)//seconds
        grid_left = start+seconds*index
        grid_right = min(end, grid_left+seconds)
        right = min([grid_right]+[p for p in points if cursor < p < grid_right])
        boot_cut = any(grid_left < p < grid_right for p in points)
        # No commands run in an unresolved minute. Coalesce its skipped slices
        # so tiny --slice values cannot allocate millions of gap summaries.
        for left, stop in getattr(boots, 'unresolved', ()):
            if left <= cursor < stop:
                right = min(end, Decimal(str(stop)))
                boot_cut = True
                break
        yield cursor, right, boot_cut
        if right >= end:
            break
        cursor = right


def remaining_slices(start, end, seconds, boots, cursor):
    points = [Decimal(str(p)) for p in boot_boundaries(boots)]
    def span(left, right):
        if left >= right:
            return 0
        grid = int(((right-start)/seconds).to_integral_value(rounding=ROUND_CEILING))
        grid -= int((left-start)//seconds)
        return grid+sum(left < p < right and (p-start) % seconds != 0 for p in points)
    count = 0
    position = cursor
    for left, right in getattr(boots, 'unresolved', ()):
        left = max(position, Decimal(str(left)))
        right = min(end, Decimal(str(right)))
        if left < right:
            count += span(position, left)+1
            position = right
    return max(1, count+span(position, end))


def wtmp_boots():
    # last renders only minutes, even with -w. Read the same Darwin API in a
    # bounded subprocess to recover seconds, rather than guess a boot boundary.
    import ctypes as c
    class Timeval(c.Structure):
        _fields_ = [('sec', c.c_long), ('usec', c.c_int)]
    class Utmpx(c.Structure):
        _fields_ = [('user', c.c_char*256), ('id', c.c_char*4), ('line', c.c_char*32),
                    ('pid', c.c_int), ('kind', c.c_short), ('tv', Timeval),
                    ('host', c.c_char*256), ('pad', c.c_uint32*16)]
    lib = c.CDLL('/usr/lib/libSystem.B.dylib')
    lib.getutxent_wtmp.restype = c.POINTER(Utmpx)
    lib.setutxent_wtmp(0)
    boots = []
    try:
        while True:
            row = lib.getutxent_wtmp()
            if not row:
                break
            if row.contents.kind == 2:
                boots.append(row.contents.tv.sec)
    finally:
        lib.endutxent()
    return boots


def boot_times(since, until, run=subprocess.run, deadline=None):
    if sys.platform != 'darwin':
        return []
    env = {**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'}
    def read(args):
        remaining = 2 if deadline is None else min(2, deadline-time.monotonic())
        if remaining <= 0:
            raise subprocess.TimeoutExpired(args, 0)
        result = run(args, capture_output=True, text=True, timeout=remaining, env=env)
        if result.returncode:
            raise ValueError('boot discovery failed')
        return result.stdout
    current = re.search(r'\bsec\s*=\s*(\d+)', read(['/usr/sbin/sysctl', '-n', 'kern.boottime']))
    if not current:
        raise ValueError('invalid kern.boottime')
    boots = {int(current[1])}
    minutes = []
    for line in read(['/usr/bin/last', '-y', 'reboot']).splitlines():
        if not line.startswith('reboot time'):
            continue
        match = re.search(r'([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d{4} \d{2}:\d{2})', line)
        if not match:
            raise ValueError('invalid last reboot time')
        at = int(dt.datetime.strptime(match[1], '%a %b %d %Y %H:%M').replace(tzinfo=UTC).timestamp())
        if at <= until and at+60 > since:
            minutes.append(at)
    if minutes:
        try:
            refined = json.loads(read([sys.executable, '-I', os.path.abspath(__file__), '--wtmp-boots']))
            if not isinstance(refined, list) or any(type(b) is not int or b < 0 for b in refined):
                raise ValueError('invalid boot history')
            boots.update(refined)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            pass
    unresolved = [(m, m+60) for m, count in Counter(minutes).items()
                  if sum(m <= b < m+60 for b in boots) < count]
    return BootTimes((b for b in boots if since < b+1 and b <= until), unresolved)


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


def keep_row(line, start, end, include_end, out, outside, stats, final=False):
    try:
        row = json.loads(line)
        if final and isinstance(row, dict) and row.get('finished') == 1 and set(row) <= {'count', 'finished'}:
            return
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
    last_line = None
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
                        if last_line is not None:
                            keep_row(last_line, start, end, include_end, out, outside, result, final=not pending)
                            last_line = None
                        if pending:
                            keep_row(bytes(pending), start, end, include_end, out, outside, result, final=True)
                            pending.clear()
                        continue
                    pending.extend(data)
                    while b'\n' in pending:
                        line, _, tail = pending.partition(b'\n')
                        pending = bytearray(tail)
                        if last_line is not None:
                            keep_row(last_line, start, end, include_end, out, outside, result)
                        last_line = bytes(line)+b'\n'
                    if time.monotonic() >= (terminating or stop):
                        break
        if result['status'] != 'partial':
            result['exitCode'] = child.returncode
            if child.returncode:
                result.update(status='error', reason='log show exited %s' % child.returncode)
    except (OSError, ValueError, KeyboardInterrupt) as exc:
        result.update(status='error', reason=str(exc))
    finally:
        try:
            if last_line is not None:
                keep_row(last_line, start, end, include_end, out, outside, result)
        except (OSError, ValueError) as exc:
            result.update(status='error', reason=str(exc))
        finally:
            if child is not None:
                cleanup_error = None
                try:
                    # Send KILL once, then reap. Darwin can reject a repeated kill
                    # while the first is still taking effect.
                    signal_group(child, signal.SIGKILL)
                except OSError as exc:
                    cleanup_error = exc
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    if result['status'] != 'error':
                        result.update(status='partial', reason='deadline; child did not reap after SIGKILL')
                else:
                    # EPERM can race with exit before poll can reap on Darwin.
                    if isinstance(cleanup_error, PermissionError):
                        cleanup_error = None
                if cleanup_error is not None:
                    result.update(status='error', reason='process-group cleanup failed: '+str(cleanup_error))
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
                   elapsedMs=0, slices=[], boots=[], reason=None, **counters())
    parser = Parser(description=__doc__)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--predicate')
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
        stop = began+args.deadline
        with out_path.open('wb') as out:
            if args.keep_outside:
                outside = Path(str(out_path)+'.outside.ndjson').open('wb')
            boots = boot_times(start, end, deadline=stop)
            summary['boots'] = [stamp(Decimal(str(boot))) for boot in boots]
            summary.update(status='complete', exitCode=0)
            for left, right, boot_cut in reader_slices(start, end, seconds, boots):
                now = time.monotonic()
                if now >= stop:
                    summary.update(status='partial', exitCode=2, reason='deadline; remaining slices not started')
                    break
                if boot_skip(left, right, boots):
                    part = dict(start=stamp(left), end=stamp(right), status='partial',
                                reason='bootUnresolved', exitCode=None, elapsedMs=0, **counters())
                    if boot_cut:
                        part['bootSplit'] = True
                    summary['slices'].append(part)
                    summary.update(status='partial', exitCode=2, reason='bootUnresolved')
                    continue
                command = [os.environ.get('MAC_LOG_WINDOW_LOG_BIN', '/usr/bin/log'), 'show',
                           '--style', 'ndjson', '--timezone', 'UTC',
                           '--start', query_bound(left, ROUND_FLOOR),
                           '--end', query_bound(right, ROUND_CEILING)]
                command += (['--info'] if args.info else [])+(['--debug'] if args.debug else [])
                if args.predicate:
                    command += ['--predicate', args.predicate]
                allowance = (stop-now)/remaining_slices(start, end, seconds, boots, left)
                if boot_second(left, right, boots) is not None:
                    # Leave the reader's three-second TERM grace and one-second
                    # reap inside the ten-second boot-second limit.
                    allowance = min(6, allowance)
                part = read_slice(command, left, right, right == end,
                                  now+allowance, out, outside)
                if boot_cut:
                    part['bootSplit'] = True
                summary['slices'].append(part)
                merge_counts(summary, part)
                if part['status'] == 'error':
                    summary.update(status='error', exitCode=1, reason=part['reason'])
                    break
                if part['status'] == 'partial':
                    summary.update(status='partial', exitCode=2, reason=part['reason'])
    except subprocess.TimeoutExpired as exc:
        summary.update(status='partial', exitCode=2, reason='deadline; boot discovery incomplete')
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


if __name__ == '__main__' and sys.argv[1:] == ['--wtmp-boots']:
    print(json.dumps(wtmp_boots()))
