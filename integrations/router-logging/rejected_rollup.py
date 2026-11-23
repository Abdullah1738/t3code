"""Pre-upstream credential rejections, separate from upstream failures."""
from collections import Counter
import datetime as dt
import math


EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
INTERVALS = (('lt1', 1), ('1to5', 5), ('5to15', 15), ('15to30', 30),
             ('30to60', 60), ('60to90', 90), ('90to120', 120),
             ('120to300', 300), ('gte300', math.inf))


def timestamp(value):
    try:
        at = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if at.tzinfo is not None:
            delta = at.astimezone(dt.timezone.utc) - EPOCH
            return (delta.days * 86400 + delta.seconds) * 1000000 + delta.microseconds
    except (ValueError, TypeError, AttributeError, OverflowError):
        pass


def stamp(value):
    return (EPOCH + dt.timedelta(microseconds=value)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def cadence(times, count):
    gaps = sorted((b - a) / 1000000 for a, b in zip(times, times[1:]))
    histogram = dict.fromkeys((label for label, _ in INTERVALS), 0)
    for gap in gaps:
        for label, limit in INTERVALS:
            if gap < limit:
                histogram[label] += 1
                break
    return dict(intervalCount=len(gaps), missingTimestampCount=count - len(times),
                intervalSeconds=dict(min=gaps[0], p50=gaps[math.ceil(len(gaps) * .50) - 1],
                                     p95=gaps[math.ceil(len(gaps) * .95) - 1], max=gaps[-1],
                                     mean=round(sum(gaps) / len(gaps), 6)) if gaps else None,
                intervalHistogramSeconds=histogram)


class RejectedNoCredentials:
    def __init__(self):
        self.groups = {}
        self.outcomes = Counter()

    def add(self, row, key_id, model, client):
        props = row['props']
        if (props.get('phase') != 'pre_upstream' or props.get('status') != 404
                or type(props.get('attempts')) is not int or props['attempts'] != 0
                or row.get('error', {}).get('tag') != 'http_404_no_credentials'):
            return
        self.outcomes['count'] += 1
        self.outcomes['errors'] += row['kind'] == 'error'
        self.outcomes['ok'] += row.get('ok') is True
        self.outcomes['failed'] += row.get('ok') is False
        group = self.groups.setdefault((key_id, model, client), dict(count=0, times=[]))
        group['count'] += 1
        at = timestamp(row.get('ts'))
        if at is not None:
            group['times'].append(at)

    def result(self):
        groups = []
        for (key_id, model, client), group in sorted(self.groups.items()):
            # Worker rows can arrive out of order, including across cache appends.
            times = sorted(group['times'])
            groups.append(dict(keyId=key_id, model=model, client=client, count=group['count'],
                               firstTs=stamp(times[0]) if times else None,
                               lastTs=stamp(times[-1]) if times else None,
                               cadence=cadence(times, group['count'])))
        return dict(count=self.outcomes['count'], byCaller=groups)

    def rates(self, total, errors, measured, failed):
        remaining = total - self.outcomes['count']
        rated = measured - self.outcomes['ok'] - self.outcomes['failed']
        # Match each legacy field's denominator, removing only rejected rows.
        return dict(errorRateExcludingNoCredentials=(errors - self.outcomes['errors']) / remaining if remaining else None,
                    failedRateExcludingNoCredentials=(failed - self.outcomes['failed']) / rated if rated else None)
