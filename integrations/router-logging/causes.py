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


def positive(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def evidence(cause, field, value):
    return dict(cause=cause, causeEvidenceField=field, causeEvidenceValue=value)


def unknown(reason):
    return dict(cause='unknown_no_data', missingEvidence=reason)


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
            explanation = evidence('child_wait' if name == 'child_wait' else 'tick_blocked:' + name, PHASES[name], duration)
        return dict(detail, **explanation)
    if detail.get('unmeasuredMs', 0) > 0:
        return dict(detail, **unknown('unmeasured_tick_time'))
    recorded = props.get('cause', '')
    has_label = (isinstance(phase, str) and phase in PHASES or
                 isinstance(recorded, str) and recorded.startswith('tick_blocked:'))
    return dict(detail, **unknown('tick_phase_durations' if detail or has_label
                                  else 'inter_tick_phase_or_scheduler_state'))
