"""Content-free command pressure evidence. Every caller treats telemetry as optional."""
from __future__ import annotations

import json
import math
from pathlib import Path
import shlex

PREFIX = 'offbox-resources: '
SUMMARY = 'offbox: box pressure '
CPU = ('usage_usec', 'nr_throttled', 'throttled_usec')
IO = ('rbytes', 'wbytes', 'rios', 'wios', 'dbytes', 'dios')
MEMORY = ('oom', 'high', 'max')
KINDS = ('cpu', 'io', 'memory')


def number(value, *, integer=False):
    try:
        if isinstance(value, bool):
            return None
        result = int(value) if integer else float(value)
        return result if result >= 0 and math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def counters(text, keys):
    values = dict.fromkeys(keys)
    for line in (text or '').splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0] in values:
            values[fields[0]] = number(fields[1], integer=True)
    return values


def io_totals(text):
    values = dict.fromkeys(IO)
    if text is None:
        return values
    # An empty, readable io.stat means no I/O yet; absent per-device fields stay unknown.
    if not text.strip():
        return dict.fromkeys(IO, 0)
    invalid = set()
    for line in text.splitlines():
        for field in line.split()[1:]:
            key, _, value = field.partition('=')
            if key in values:
                parsed = number(value, integer=True)
                if parsed is None:
                    invalid.add(key)
                else:
                    values[key] = (values[key] or 0) + parsed
    return {k: None if k in invalid else v for k, v in values.items()}


def pressure(text):
    values = {k: {'total_usec': None, 'avg10_pct': None} for k in ('some', 'full')}
    for line in (text or '').splitlines():
        fields = line.split()
        if not fields or fields[0] not in values:
            continue
        pairs = dict(f.split('=', 1) for f in fields[1:] if '=' in f)
        values[fields[0]] = {'total_usec': number(pairs.get('total'), integer=True),
                             'avg10_pct': number(pairs.get('avg10'))}
    return values


def snapshot(text):
    sections, key = {}, None
    for line in (text or '').splitlines():
        if line.startswith('@'):
            key = line[1:]
            sections[key] = []
        elif key:
            sections[key].append(line)
    def section(name):
        value = sections.get(name)
        return '\n'.join(value) if value is not None and '!error' not in value else None
    return {'uptime_s': number(section('uptime').split()[0]) if section('uptime') else None,
            'cpu': counters(section('cpu'), CPU), 'io': io_totals(section('io')),
            'memory': counters(section('memory'), MEMORY),
            'psi': {k: pressure(section('psi_' + k)) for k in KINDS},
            'errors': sum(section(name) is None for name in
                          ('uptime', 'cpu', 'io', 'memory', 'psi_cpu', 'psi_io', 'psi_memory'))}


def delta(before, after):
    if before is None or after is None or after < before:
        return None
    return after - before


def record(start, end, peaks):
    wall = delta(start['uptime_s'], end['uptime_s'])
    wall = round(wall, 3) if wall is not None else None
    peak_values = counters(peaks, [f'{k}_{mode}' for k in KINDS for mode in ('some', 'full')]
                           + ['errors', 'samples'])
    def pct(value):
        return round(value / (wall * 10000), 3) if value is not None and wall else None
    cpu = {k: delta(start['cpu'][k], end['cpu'][k]) for k in CPU}
    cpu['usage_avg_pct'] = pct(cpu['usage_usec'])
    cpu['throttled_wall_pct'] = pct(cpu['throttled_usec'])
    psi = {}
    for kind in KINDS:
        psi[kind] = {}
        for mode in ('some', 'full'):
            a, b = start['psi'][kind][mode], end['psi'][kind][mode]
            total = delta(a['total_usec'], b['total_usec'])
            candidates = [a['avg10_pct'], b['avg10_pct']]
            peak = peak_values[kind + '_' + mode]
            if peak is not None:
                candidates.append(peak / 100)
            candidates = [v for v in candidates if v is not None]
            psi[kind][mode] = {'total_usec': total, 'avg_pct': pct(total),
                               'peak_avg10_pct': max(candidates) if candidates else None}
    return {'status': 'available', 'wall_s': wall, 'cpu': cpu,
            'io': {k: delta(start['io'][k], end['io'][k]) for k in IO},
            'memory': {k: delta(start['memory'][k], end['memory'][k]) for k in MEMORY},
            'psi': psi, 'sample_interval_s': 10, 'samples': peak_values['samples'] or 0,
            'errors': start['errors'] + end['errors'] + (peak_values['errors'] or 0)
                      + int(peak_values['samples'] is None),
            'host_boxes': {'start': None, 'end': None}}


def unavailable(reason='unavailable', errors=0):
    return {'status': 'unavailable', 'reason': reason, 'errors': errors,
            'host_boxes': {'start': None, 'end': None}}


def labels(data):
    tags = []
    peak = number(data.get('psi', {}).get('io', {}).get('full', {}).get('peak_avg10_pct'))
    throttled = number(data.get('cpu', {}).get('throttled_wall_pct'))
    if peak is not None and peak >= 20:
        tags.append('io-stalled')
    if throttled is not None and throttled > 10:
        tags.append('cpu-throttled')
    return tags


def summary(data):
    def fmt(value):
        n = number(value)
        return f'{n:.1f}'.removesuffix('.0') if n is not None else '?'
    def pair(kind, mode):
        p = data.get('psi', {}).get(kind, {}).get(mode, {})
        return f"{fmt(p.get('avg_pct'))}%/{fmt(p.get('peak_avg10_pct'))}%"
    host = data.get('host_boxes') or {}
    suffix = f"host boxes {fmt(host.get('start'))}→{fmt(host.get('end'))} running"
    if data.get('status') != 'available':
        return SUMMARY + 'unavailable · ' + suffix
    cpu = data.get('cpu') or {}
    seconds = cpu.get('throttled_usec')
    return (SUMMARY + f"cpu some avg/peak {pair('cpu', 'some')} · io full {pair('io', 'full')} · "
            f"mem some {pair('memory', 'some')} · throttled {fmt(seconds / 1e6 if seconds is not None else None)} s "
            f"(nr {fmt(cpu.get('nr_throttled'))}) · {suffix}" +
            (' · ' + ', '.join(labels(data)) if labels(data) else ''))


# Only kernel pseudo-files are read. The cgroup namespace root is the whole box, including Docker children;
# /proc/self/cgroup would instead point at the command scope and miss box-level quota throttling.
CAPTURE = r'''
for spec in uptime:/proc/uptime cpu:/sys/fs/cgroup/cpu.stat io:/sys/fs/cgroup/io.stat memory:/sys/fs/cgroup/memory.events psi_cpu:/proc/pressure/cpu psi_io:/proc/pressure/io psi_memory:/proc/pressure/memory; do
  printf '@%s\n' "${spec%%:*}"
  cat "${spec#*:}" 2>/dev/null || printf '!error\n'
done
'''

SAMPLER = r'''
declare -A peak
errors=0 samples=0
trap '[ -z "${sleeper:-}" ] || kill "$sleeper" 2>/dev/null; exit' TERM HUP INT
while :; do
  for kind in cpu io memory; do
    value=$(cat /proc/pressure/$kind 2>/dev/null) || { errors=$((errors+1)); continue; }
    while read -r mode fields; do
      [[ $mode = some || $mode = full ]] || continue
      for field in $fields; do
        [[ $field = avg10=* ]] || continue
        n=${field#avg10=}
        [[ $n =~ ^[0-9]+\.[0-9][0-9]$ ]] || { errors=$((errors+1)); continue; }
        n=${n/./}; n=$((10#$n)); key=${kind}_${mode}
        if [[ ! -v peak[$key] || $n -gt ${peak[$key]} ]]; then peak[$key]=$n; fi
      done
    done <<< "$value"
  done
  samples=$((samples+1))
  { for key in "${!peak[@]}"; do printf '%s %s\n' "$key" "${peak[$key]}"; done
    printf 'errors %s\nsamples %s\n' "$errors" "$samples"
  } > "$1/peaks.next"
  mv -f "$1/peaks.next" "$1/peaks" 2>/dev/null || errors=$((errors+1))
  sleep 10 & sleeper=$!; wait "$sleeper"
done
'''


def wrap(command, supervisor):
    # The sampler and its sleep own no command descriptors. A short run never waits for the next tick.
    parser = Path(__file__).read_text().split('# Only kernel pseudo-files')[0]
    emit = parser + '''
import sys
try:
    data = record(snapshot(sys.argv[1]), snapshot(sys.argv[2]), sys.argv[3])
except Exception:
    data = unavailable('telemetry_error', 1)
try:
    print('\\n' + PREFIX + sys.argv[4] + ' ' + json.dumps(data, separators=(',', ':')), file=sys.stderr)
except Exception:
    pass
'''
    setup = '\n'.join([
        '__offbox_res_dir=$(timeout -s KILL 0.25 mktemp -d /dev/shm/offbox-pressure.XXXXXXXX 2>/dev/null) || __offbox_res_dir=',
        '__offbox_res_start=$(timeout -s KILL 0.25 bash -c ' + shlex.quote(CAPTURE) + ' 2>/dev/null) || __offbox_res_start=',
        'if [ -n "$__offbox_res_dir" ]; then',
        '  bash -c ' + shlex.quote(SAMPLER) + ' offbox-pressure "$__offbox_res_dir" </dev/null >/dev/null 2>&1 &',
        '  __offbox_res_pid=$!',
        'fi',
    ])
    finish = '\n'.join([
        '__offbox_res_end=$(timeout -s KILL 0.25 bash -c ' + shlex.quote(CAPTURE) + ' 2>/dev/null) || __offbox_res_end=',
        '[ -z "${__offbox_res_pid:-}" ] || kill "$__offbox_res_pid" 2>/dev/null || :',
        '__offbox_res_peaks=',
        '[ -z "$__offbox_res_dir" ] || __offbox_res_peaks=$(timeout -s KILL 0.25 cat "$__offbox_res_dir/peaks" 2>/dev/null) || :',
        'if command -v python3 >/dev/null 2>&1; then',
        'python3 - "$__offbox_res_start" "$__offbox_res_end" "$__offbox_res_peaks" "$OFFBOX_RUN_ID" <<\'OFFBOX_PRESSURE\'',
        supervisor,
        f"bounded(['python3', '-c', {emit!r}, *sys.argv[1:]], 0.25, relay=True)",
        'OFFBOX_PRESSURE',
        'fi',
        '[ -z "$__offbox_res_dir" ] || timeout -s KILL 0.25 rm -rf -- "$__offbox_res_dir" 2>/dev/null || :',
    ])
    # EXIT catches caller exit and signals without replacing step/trap semantics in the command subshell.
    trap = '__offbox_res_rc=$?\nset +e\nset +u\n' + finish + '\nexit "$__offbox_res_rc"'
    return setup + '\ntrap ' + shlex.quote(trap) + ' EXIT\n(\n' + command + '\n)'


def finalize(row):
    """Reuse received metrics and committed log bytes; never fetch, wait for a log holder or change an exit."""
    try:
        from . import api
        from .runs import LOGS_DIR, log_lock, save_run_state
        from .common import read_json, offsets_path, atomic_write_json
        row = dict(row)
        if row.get('mode') == 'local':
            return
        run_id = row['run_id']
        path = LOGS_DIR / (run_id + '.log')
        with log_lock(run_id, timeout=0):
            saved = read_json(LOGS_DIR / (run_id + '.state.json'), {})
            data = saved.get('resources') or unavailable('boat' if api.BACKEND != 'server' else 'missing', 1)
            if api.BACKEND == 'server' and data.get('reason') == 'pending':
                data = unavailable('missing', 1)
            text = ''
            ck = read_json(offsets_path(path), {})
            if path.exists():
                size = path.stat().st_size
                if ck and size != ck.get('logBytes'):
                    return  # Never checkpoint a chunk whose stream-offset write did not commit.
                with path.open('rb') as f:
                    f.seek(max(0, size - 16384))
                    text = f.read().decode(errors='replace')
            if 'resources' not in saved and PREFIX + run_id + ' ' not in text:
                return  # Legacy runs have no telemetry; leave their delivery/empty-output evidence alone.
            if api.BACKEND == 'server':
                old_host = data.get('host_boxes')
                for line in text.splitlines():
                    if line.startswith('offbox-command-started:') or ('server restarted while this run' in line):
                        data = unavailable('missing', 1)
                    if 'server restarted while this run' in line:
                        old_host = None
                    if line.startswith(PREFIX + run_id + ' '):
                        try:
                            candidate = json.loads(line[len(PREFIX + run_id + ' '):])
                        except ValueError:
                            candidate = {}
                        # Reconstruct the fixed numeric shape, discarding unrecognized fields.
                        template = record(snapshot(''), snapshot(''), '')
                        def clean(value, shape):
                            if isinstance(shape, dict):
                                return {k: clean(value.get(k), v) for k, v in shape.items()} if isinstance(value, dict) else shape
                            if isinstance(shape, str):
                                return shape
                            return number(value, integer=type(value) is int)
                        data = (clean(candidate, template) if isinstance(candidate, dict) and candidate.get('status') == 'available'
                                else unavailable('telemetry_error', 1))
                        if old_host:
                            data['host_boxes'] = old_host
                host = api.command_host_boxes(row.get('box_id'), row.get('process_id'), row.get('command_id'))
                if host is not None:
                    data['host_boxes'] = host
            save_run_state(run_id, resources=data)
            line = summary(data) + '\n'
            if api.BACKEND == 'boat' and row.get('mode') == 'bg':
                code = row.get('exit_code')
                if code is None:
                    code = saved.get('exit_code', saved.get('command_exit_code'))
                if code is not None:
                    line += f"offbox: remote exit {code}\n"
            if not path.exists() or not text.endswith(line):
                if not ck or not (ck.get('stdoutOffset', 0) + ck.get('stderrOffset', 0)):
                    return  # A footer must never turn an empty, recoverable log into uncheckpointed output.
                with path.open('ab') as f:
                    f.write(('\n' + line).encode())
                    size = f.tell()
                atomic_write_json(offsets_path(path), dict(ck, logBytes=size))
    except Exception:
        # A busy log holder or failed local write cannot replace evidence another finisher already saved.
        pass


def failure_suffix(run_id, code):
    try:
        from .runs import LOGS_DIR
        from .common import read_json
        data = read_json(LOGS_DIR / (run_id + '.state.json'), {}).get('resources', {})
        return ' · ' + summary(data) if code not in (0, None) and labels(data) else ''
    except Exception:
        return ''


def display(run_id):
    try:
        from .runs import LOGS_DIR
        from .common import read_json, say
        data = read_json(LOGS_DIR / (run_id + '.state.json'), {}).get('resources')
        if data:
            say(summary(data).removeprefix('offbox: '))
    except Exception:
        pass
