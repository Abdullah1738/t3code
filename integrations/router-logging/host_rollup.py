"""Hourly sampled host load and request latency; no interpolation across gaps."""
from collections import Counter
import datetime as dt
import math
from host import clean_host


def timestamp(value):
    try:
        if type(value) in (int, float) and math.isfinite(value):
            return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
        at = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return at.astimezone(dt.timezone.utc) if at.tzinfo is not None else None
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        return None


class HostLoad:
    def __init__(self, day, generated):
        self.day, self.generated = day, generated
        self.hours, self.seen, self.failures = {}, set(), Counter()
        self.polls = self.missing = 0

    def hour(self, at):
        if at is None or at.date().isoformat() != self.day or at > self.generated:
            return None
        key = at.replace(minute=0, second=0, microsecond=0).isoformat().replace('+00:00', 'Z')
        return self.hours.setdefault(key, dict(hour=key, loads=[], pressure=[], overloaded=0, samples=0, failed=0, durations=[]))

    def sample(self, at, value):
        host = clean_host(value)
        group = self.hour(at)
        if group is None or not host:
            return
        at = at.replace(microsecond=at.microsecond // 1000 * 1000)
        # Poll rows may trim optional metadata to fit their byte budget.
        identity = (at, host.get('l1'), host.get('c'), host.get('p'), host.get('e'))
        if identity in self.seen:
            return
        self.seen.add(identity)
        group['samples'] += 1
        if 'e' in host:
            self.failures[host['e']] += 1
            group['failed'] += 1
        if 'l1' in host:
            group['loads'].append(host['l1'])
            group['overloaded'] += host.get('c', 0) > 0 and host['l1'] > 2 * host['c']
        if 'p' in host:
            group['pressure'].append(host['p'])

    def observe(self, row):
        at = timestamp(row.get('ts'))
        if at is None or at > self.generated:
            return
        props = row.get('props')
        if not isinstance(props, dict):
            props = {}
        if row['name'] == 'proxy.request':
            group = self.hour(at)
            duration = row.get('durationMs')
            if group is not None and type(duration) in (int, float) and math.isfinite(duration) and duration >= 0:
                group['durations'].append(duration)
        if row['name'] == 'poll.complete':
            at = timestamp(props.get('hostAtMs')) or at
            if self.hour(at) is not None:
                self.polls += 1
                self.missing += not bool(clean_host(props.get('host')))
            self.sample(at, props.get('host'))
            return
        # Cached host samples retain their observation time independently of the
        # gap clocks. Older rows only carry the boundary or emission time.
        boundaries = False
        for key, fields in (('hostStart', ('hostStartAtMs', 'start', 'startedAtMs', 'unknownSince', 'downSince')),
                            ('hostEnd', ('hostEndAtMs', 'end', 'finishedAtMs', 'hostAtMs'))):
            boundary = next((parsed for field in fields if (parsed := timestamp(props.get(field))) is not None), None)
            if boundary is None and key == 'hostEnd':
                boundary = at
            if boundary is not None and clean_host(props.get(key)):
                self.sample(boundary, props[key])
                boundaries = True
        if not boundaries:
            self.sample(timestamp(props.get('hostAtMs')) or at, props.get('host'))

    def summary(self):
        hourly, requests = [], []
        for hour, group in sorted(self.hours.items()):
            loads = group['loads']
            load = dict(avg=round(sum(loads) / len(loads), 2), max=max(loads)) if loads else None
            hourly.append(dict(hour=hour, samples=group['samples'], failedSnapshots=group['failed'],
                               load1=load, maxPressureLevel=max(group['pressure'], default=None),
                               overloadSamples=group['overloaded']))
            durations = sorted(group['durations'])
            requests.append(dict(hour=hour, count=len(durations),
                                 p95DurationMs=durations[math.ceil(len(durations) * .95) - 1] if durations else None,
                                 load1=load))
        return dict(hourly=hourly, hoursWithLoadAbove2xCpu=[r['hour'] for r in hourly if r['overloadSamples']],
                    failedSnapshots=dict(sorted(self.failures.items())), pollRows=self.polls,
                    pollRowsWithoutHost=self.missing), requests
