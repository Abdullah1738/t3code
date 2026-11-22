"""Pure sustained-overload transitions. Times are elapsed UTC seconds."""
from copy import deepcopy
from datetime import datetime, timezone
import math

HOLD = {'swap': 300, 'pressure': 300, 'load': 600}
CLEAR = 600
COOLDOWN = 3600
# Historical memory samples are five minutes apart; replay never interpolates
# across a longer gap. Live samples are complete snapshots every 30 seconds.
MAX_GAP = 360


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def iso(now):
    return datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def snapshot(vitals):
    result = {k: v for k, v in vitals.items() if k in ('swapUsedBytes', 'swapTotalBytes',
              'freePages', 'pressureLevel', 'ncpu') and number(v)}
    load = vitals.get('load')
    if isinstance(load, (list, tuple)) and len(load) == 3 and all(number(v) for v in load):
        result['load'] = list(load)
    families = vitals.get('families', [])
    result['families'] = sorted((dict(name=row['name'], count=row['count']) for row in families
        if isinstance(row, dict) and isinstance(row.get('name'), str) and number(row.get('count'))),
        key=lambda row: (-row['count'], row['name']))[:6]
    return result


def signals(v):
    used, total, free = (v.get(k) for k in ('swapUsedBytes', 'swapTotalBytes', 'freePages'))
    swap = used/total >= .8 and free < 40000 if all(number(x) for x in (used, total, free)) and total > 0 else None
    pressure = v['pressureLevel'] >= 2 if number(v.get('pressureLevel')) else None
    load = v['load'][0] >= 10*v['ncpu'] if 'load' in v and number(v.get('ncpu')) and v['ncpu'] > 0 else None
    return dict(swap=swap, pressure=pressure, load=load)


def peak(previous, current):
    result = deepcopy(previous)
    for key in ('swapUsedBytes', 'swapTotalBytes', 'pressureLevel'):
        if key in current:
            result[key] = max(result.get(key, 0), current[key])
    if 'freePages' in current:
        result['freePages'] = min(result.get('freePages', current['freePages']), current['freePages'])
    if 'load' in current:
        result['load'] = [max(a, b) for a, b in zip(result.get('load', [0, 0, 0]), current['load'])]
    return result


def text_for(phase, onset, v, conditions, duration=None):
    load = str(round(v['load'][0])) if 'load' in v else '?'
    swap = ('%.1f/%.1f GB' % (v['swapUsedBytes']/2**30, v['swapTotalBytes']/2**30)
            if all(k in v for k in ('swapUsedBytes', 'swapTotalBytes')) else '?')
    free = '%dk' % round(v['freePages']/1000) if 'freePages' in v else '?'
    clock = iso(onset)[11:16]+'Z'
    if phase == 'onset':
        text = f'Mac overloaded since {clock}: load {load}, swap {swap}, {free} free pages ({"+".join(conditions)}).'
    else:
        text = f'Mac recovered after {round(duration/60)} min (since {clock}): peak load {load}, swap {swap}, {free} minimum free pages.'
    top = ', '.join('%s %s' % (r['name'], r['count']) for r in v.get('families', []))
    return text+' Top: '+(top or 'unavailable')+'.'


def evaluate(previous, vitals, now):
    state = deepcopy(previous or {})
    if not number(now) or (state.get('lastTick') is not None and now <= state['lastTick']):
        return state, []
    v = snapshot(vitals)
    flags = signals(v)
    last = state.get('lastTick')
    gap = now-last if last is not None else None
    lags = [t for t in state.get('lags', []) if now-t <= 300]
    if gap is not None and gap >= 90:
        lags.append(now)
    state.update(lastTick=now, lags=lags)
    held = state.setdefault('held', {})
    if gap is not None and gap > MAX_GAP:
        held.clear()
        state.pop('clearSince', None)
    for key, flag in flags.items():
        if flag is True:
            held.setdefault(key, now)
        else:
            # Unknown readings cannot establish a hold or prove recovery.
            held.pop(key, None)
    triggers = [key for key in HOLD if key in held and now-held[key] >= HOLD[key]]
    if len(lags) >= 2:
        triggers.append('self-lag')
    episode = state.get('episode')
    actions = []
    if not episode and triggers:
        notify = (now-state.get('lastOnsetAlert', -1e20) >= COOLDOWN and
                  now-state.get('lastEnd', -1e20) >= COOLDOWN)
        episode = dict(onset=now, conditions=triggers, peak=v, lastPeak=now, notified=notify)
        state['episode'] = episode
        if notify:
            state['lastOnsetAlert'] = now
        phase = 'onset'
    elif episode:
        improved = peak(episode['peak'], v)
        changed = any(improved.get(k) != episode['peak'].get(k) for k in
                      ('load', 'swapUsedBytes', 'swapTotalBytes', 'pressureLevel', 'freePages'))
        episode['peakDirty'] = episode.get('peakDirty', False) or changed
        improved['families'] = v['families']
        episode['peak'] = improved
        episode['conditions'] = sorted(set(episode['conditions']+triggers))
        # Raw below-threshold readings must all be known for ten minutes.
        # A short dip must not end an episode while a hold is rebuilding.
        if all(flag is False for flag in flags.values()) and not lags:
            state.setdefault('clearSince', now)
        else:
            state.pop('clearSince', None)
        if now-state.get('clearSince', now) >= CLEAR:
            phase = 'end'
            state.update(lastEnd=now, episode=None)
            state.pop('clearSince', None)
        elif episode.get('peakDirty') and now-episode['lastPeak'] >= 600:
            phase = 'peak'
            episode['lastPeak'] = now
            episode['peakDirty'] = False
        else:
            phase = None
    else:
        phase = None
    if phase:
        event = dict(v, phase=phase, onset=iso(episode['onset']), conditions=episode['conditions'],
                     peak=episode['peak'], durationS=now-episode['onset'], notified=episode['notified'])
        actions.append(dict(event=event))
        if phase in ('onset', 'end') and episode['notified']:
            values = episode['peak'] if phase == 'end' else v
            actions[-1]['notify'] = dict(key='mac-overload:%s:%s' % (iso(episode['onset']), phase),
                text=text_for(phase, episode['onset'], values, episode['conditions'], now-episode['onset']),
                severity='attention' if phase == 'onset' else 'info')
    return state, actions
