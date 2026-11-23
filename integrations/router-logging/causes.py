"""Bounded observer causes derived from recorded fields, including legacy rows."""
import math
import re

PHASES = {'history_scan_parse': 'historyScanParseMs', 'rollup_write': 'rollupWriteMs',
          'state_save': 'stateSaveMs', 'lock_wait': 'lockWaitMs',
          'listener_history': 'listenerHistoryMs', 'pool_history': 'poolHistoryMs',
          'history_refresh': 'historyRefreshMs', 'launchctl': 'launchctlMs',
          'tcp': 'tcpMs', 'providers_fetch': 'providersFetchMs',
          'usage_fetch': 'usageFetchMs', 'stats_fetch': 'statsFetchMs',
          'snapshot': 'snapshotMs', 'log_write': 'logWriteMs',
          'observer_snapshot_start': 'observerSnapshotStartMs',
          'post_end_diag': 'postEndDiagMs', 'child_wait': 'childWaitMs', 'pool_fetch': 'poolFetchMs'}
RESOURCE_FIELDS = {'InblockN': 'ru_inblock', 'MajfltN': 'ru_majflt',
                   'NivcswN': 'ru_nivcsw', 'NvcswN': 'ru_nvcsw'}
BYTE_PHASES = ('history_scan_parse', 'listener_history')
BYTE_FIELDS = ('BytesHashed', 'BytesParsed')
SUBSTEPS = ('LoadState', 'ValidateCursor', 'ParseLines', 'BuildReport', 'SaveState')
WAIT_FIELDS = {field[:-2] + suffix for field in PHASES.values() for suffix in RESOURCE_FIELDS}
WAIT_FIELDS.update(PHASES[name][:-2] + suffix for name in BYTE_PHASES for suffix in BYTE_FIELDS)
SUBSTEP_FIELDS = {PHASES[name][:-2] + step + suffix
                  for name in BYTE_PHASES for step in SUBSTEPS for suffix in ('Ms', 'CpuMs')}
TIMEOUT_FIELDS = {'activePhaseMs', 'activePhaseCpuMs'} | {
    prefix + suffix for prefix in ('activePhase', 'child') for suffix in RESOURCE_FIELDS}


def positive(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def evidence(cause, field, value):
    return dict(cause=cause, causeEvidenceField=field, causeEvidenceValue=value)


def unknown(reason):
    return dict(cause='unknown_no_data', missingEvidence=reason)


def phase_cause(name, wall_ms, cpu_ms, props=None):
    try:
        waiting = (positive(wall_ms) and wall_ms > 30000 and type(cpu_ms) in (int, float)
                   and math.isfinite(cpu_ms) and 0 <= cpu_ms < wall_ms * .1)
    except OverflowError:
        waiting = False
    cause = 'tick_blocked:'
    if waiting:
        props = props if isinstance(props, dict) else {}
        counters = [props.get(PHASES[name][:-2] + suffix) for suffix in RESOURCE_FIELDS]
        if all(type(value) is int and value >= 0 for value in counters):
            inblock, majflt, involuntary, voluntary = counters
            # Match the 30 s diagnostic gate, with <10% CPU. Require >=16 input
            # operations or major faults AND >=16 voluntary switches, at least
            # 4x involuntary switches, for I/O. >=16 dominant involuntary
            # switches signal preemption. Mixed/quiet counters stay blocked:
            # rusage counts suggest a wait class, not its exact elapsed time.
            if max(inblock, majflt) >= 16 and voluntary >= 16 and voluntary >= 4 * max(1, involuntary):
                cause = 'tick_io:'
            elif involuntary >= 16 and involuntary > voluntary:
                cause = 'tick_starved:'
        elif not any(value is not None for value in counters) and wall_ms > 120000:
            # Preserve #100's low-CPU classification for legacy rows only.
            cause = 'tick_starved:'
    return cause + name


def launchctl_info(props, legacy=False):
    props = props if isinstance(props, dict) else {}
    value = props.get('launchctlExit')
    field = 'launchctlExit'
    recorded = props.get('cause')
    if value is None and isinstance(recorded, str):
        match = re.fullmatch(r'launchctl_(?:unknown:|exit:)(-?\d{1,6}|timeout|oserror)', recorded)
        if match:
            value = match[1]
            value = int(value) if re.fullmatch(r'-?\d{1,6}', value) else value
            field = 'cause'
        elif recorded == 'launchctl_timeout':
            value, field = 'timeout', 'cause'
    if value == 'timeout':
        return evidence('launchctl_timeout', field, props.get(field))
    if type(value) is int and -32768 <= value <= 32767:
        return evidence('launchctl_exit:' + str(value), field, props.get(field))
    if value == 'oserror':
        return unknown('launchctl_exit_code')
    missing = props.get('missingEvidence')
    if value is None and recorded == 'unknown_no_data' and missing in (
            'launchctl_exit_code', 'launchctl_outcome', 'legacy_launchctl_outcome_not_recorded'):
        return unknown(missing)
    if legacy and value is None and recorded in (None, 'other'):
        return unknown('legacy_launchctl_outcome_not_recorded')
    return unknown('launchctl_outcome')


def gap_info(props, phase=None, duration_ms=None):
    props = props if isinstance(props, dict) else {}
    active = props.get('phase')
    if 'activePhaseMs' in props:
        wall = props['activePhaseMs']
        if isinstance(active, str) and active in PHASES and (positive(wall) or type(wall) in (int, float) and wall == 0):
            counters = {PHASES[active][:-2] + suffix: props.get('activePhase' + suffix) for suffix in RESOURCE_FIELDS}
            cause = phase_cause(active, wall, props.get('activePhaseCpuMs'), counters)
            return dict(phase=active, phaseMs=wall, **evidence(cause, 'activePhaseMs', wall))
        # Completed phases cannot name the active remainder of a killed child.
        return dict(phase=active if active in ('other', 'none') else 'other', **unknown('active_phase_name_or_duration'))
    values = [(name, props.get(field)) for name, field in PHASES.items() if positive(props.get(field))]
    detail = {}
    if values:
        name, duration = max(values, key=lambda item: item[1])
        detail.update(phase=name, phaseMs=duration)
    totals = [value for value in (duration_ms, props.get('wallGapMs'), props.get('monotonicGapMs')) if positive(value)]
    if any(field in props for field in PHASES.values()):
        measured = sum(value for _, value in values)
        detail['measuredMs'] = round(measured, 3)
        if totals:
            detail['unmeasuredMs'] = round(max(0, max(totals) - measured), 3)
    if positive(props.get('sleepGapMs')) and props['sleepGapMs'] > 120000:
        return dict(detail, **evidence('guard_not_scheduled', 'sleepGapMs', props['sleepGapMs']))
    previous, current = props.get('previousPid'), props.get('pid')
    if type(previous) is int and type(current) is int and previous > 0 and current > 0 and previous != current:
        return dict(detail, **evidence('guard_not_scheduled', 'previousPid', previous))
    if values:
        # Uninstrumented time competes with the measured phases; a small phase
        # cannot establish the cause of a larger unexplained stall.
        if not totals:
            explanation = unknown('tick_duration')
        elif detail['unmeasuredMs'] > duration:
            explanation = unknown('unmeasured_tick_time')
        else:
            cpu_ms = props.get(PHASES[name][:-2] + 'CpuMs')
            explanation = evidence('child_wait' if name == 'child_wait' else phase_cause(name, duration, cpu_ms, props),
                                   PHASES[name], duration)
        return dict(detail, **explanation)
    if detail.get('unmeasuredMs', 0) > 0:
        return dict(detail, **unknown('unmeasured_tick_time'))
    recorded = props.get('cause', '')
    has_label = (isinstance(phase, str) and phase in PHASES or
                 isinstance(recorded, str) and recorded.startswith(('tick_blocked:', 'tick_starved:', 'tick_io:')))
    return dict(detail, **unknown('tick_phase_durations' if detail or has_label
                                  else 'inter_tick_phase_or_scheduler_state'))
