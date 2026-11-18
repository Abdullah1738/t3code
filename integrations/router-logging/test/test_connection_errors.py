import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import toollog
import rollup


class ConnectionErrors(unittest.TestCase):
    def test_endpoint_and_metadata_forms(self):
        now = dt.datetime(2026, 11, 18, tzinfo=dt.timezone.utc)
        cases = [
            ('http://user:private@127.0.0.1:20128/path?token=private#private', 'http://127.0.0.1:20128'),
            ('https://user:private@EXAMPLE.com:443/?key=private', 'https://example.com:443'),
            ('wss://user:private@[::1]:3773/ws?token=private', 'wss://[::1]:3773'),
            ('ws://localhost/ws', 'ws://localhost:80'),
            ('http://localhost:0/', 'http://localhost:0'),
            *[(v, None) for v in ('file:///private', 'http:private', '//host:80', 'http://bad:99999',
                                 'https://good\\@private', 'https://good/\nprivate', 'not a URL')],
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                row = toollog.clean(dict(component='test', name='connection', kind='error', props={'target': value}), now)
                self.assertEqual(row.get('props', {}).get('target'), expected)
        props = dict(target=cases[0][0], step='activeSessions', errno='ECONNREFUSED', syscall='connect',
                     attemptNo=2, count=3, firstTs='2026-11-18T06:00:00.000Z', lastTs='2026-11-18T06:00:01.000Z')
        row = toollog.clean(dict(component='test', name='connection', kind='error', props=props), now)
        self.assertEqual(row['props'], dict(props, target=cases[0][1]))
        for key, values in {'errno': ['private', 123], 'syscall': ['private', 123],
                            'attemptNo': [True, 0, -1, 1.5, 9007199254740992],
                            'firstTs': ['private', '2026-99-99T00:00:00.000Z']}.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    row = toollog.clean(dict(component='test', name='connection', kind='error', props={key: value}), now)
                    self.assertNotIn(key, row.get('props', {}))

    def test_line_bound_and_rollup_weighted_targets(self):
        with tempfile.TemporaryDirectory() as root, patch.dict('os.environ', ROUTER_LOG_DIR=root):
            toollog.emit('test', 'connection', kind='error', props=dict(target='http://user:private@127.0.0.1:20128/path?token=private',
                         step='connect', errno='ECONNREFUSED', syscall='connect', attemptNo=1, count=3), error={'tag': 'ECONNREFUSED'})
            for path in Path(root).glob('*.ndjson'):
                for line in path.read_text().splitlines():
                    self.assertLessEqual(len((line + '\n').encode()), 4096)
                    self.assertNotIn('private', line)
            day = '2026-11-17'
            rows = [
                dict(tool='9router', name='stall.scan', kind='error', error={'tag': 'ECONNREFUSED'}, props=props)
                for props in [dict(target='http://u:private@127.0.0.1:3773/path?token=private', count=3),
                              dict(target='http://127.0.0.1:3773', count=2),
                              dict(target='http://127.0.0.1:20128', count=1), {},
                              dict(target='file:///private', count=-10), dict(target='control', count=True)]
            ]
            rows.append(dict(tool='9router', name='other', kind='error', error={'tag':'other'}, props={'count':100}))
            (Path(root) / f'{day}.ndjson').write_text(''.join(json.dumps(row) + '\n' for row in rows))
            report = rollup.rollup(day, root)
            error = next(item for item in report['topErrors'] if item['tag'] == 'ECONNREFUSED')
            self.assertEqual(error['count'], 9)
            self.assertEqual(error['byTarget'], [dict(component='unknown', target='http://127.0.0.1:3773', count=5),
                                               dict(component='unknown', target='unknown', count=3),
                                               dict(component='unknown', target='http://127.0.0.1:20128', count=1)])
            self.assertEqual(report['connectionTargetsByComponent'], [dict(component='unknown', count=9,
                unknownTargetCount=3, unknownTargetShare=1 / 3)])
            self.assertEqual(next(item['count'] for item in report['topErrors'] if item['tag'] == 'other'), 1)
            self.assertEqual(report['total'], 7)
            self.assertNotIn('private', json.dumps(report))

    def test_inbound_sockets_are_separate_from_outbound_target_coverage(self):
        day = '2026-11-18'
        def socket(code, props=None, **fields):
            return dict(tool='9router', component='proxy', name='client.socket_closed', kind='error',
                        props=dict(code=code, **(props or {})), **fields)
        rows = [
            socket('ECONNRESET', dict(direction='inbound', localAddress='127.0.0.1', localPort=20128,
                                     peerAddress='127.0.0.1', peerPort=40000, syscall='read')),
            socket('ECONNRESET', dict(localAddress='127.0.0.1', localPort=20128, peerPort=40001, syscall='read', count=500),
                   error={'tag': 'ECONNRESET'}),
            socket('EPIPE'),  # Historical props.code-only row without endpoint metadata.
            socket('ETIMEDOUT', dict(localAddress='::1', localPort=20128, syscall=None)),
            socket('ECONNRESET', dict(localAddress='private', localPort=True, syscall='private')),
            socket('EPIPE', dict(localAddress='127.0.0.1', localPort=65536)),
            socket('socket_error'),
            dict(tool='9router', component='proxy', name='client.socket_closed', kind='event', props={'code':'EPIPE'}),
            dict(tool='9router', component='image', name='img.request', kind='error', props={'code':'EPIPE'}),
            *[dict(tool='9router', component=component, name='stall.scan', kind='error',
                   error={'tag':tag}, props=props) for component, tag, props in [
                ('stream-recovery', 'ECONNRESET', dict(target='http://u:private@127.0.0.1:3773/path?secret=x', count=3)),
                ('catalog-guard', 'ECONNRESET', dict(target='http://127.0.0.1:3773')),
                ('stream-recovery', 'ECONNRESET', {}),
                ('catalog-guard', 'EPIPE', {}),
            ]],
        ]
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / f'{day}.ndjson').write_text(''.join(json.dumps(row) + '\n' for row in rows))
            report = rollup.rollup(day, root)
        self.assertEqual(report['malformed'], 0)
        self.assertEqual(report['inboundSockets']['count'], 6)
        self.assertEqual(report['inboundSockets']['byComponent'], [dict(component='proxy', count=6,
            unknownEndpointCount=3, unknownEndpointShare=.5)])
        self.assertIn(dict(component='proxy', code='ECONNRESET', localAddress='127.0.0.1', localPort=20128,
                           syscall='read', count=2), report['inboundSockets']['byListener'])
        self.assertIn(dict(component='proxy', code='EPIPE', localAddress=None, localPort=None,
                           syscall=None, count=1), report['inboundSockets']['byListener'])
        self.assertIn(dict(component='proxy', code='ETIMEDOUT', localAddress='::1', localPort=20128,
                           syscall=None, count=1), report['inboundSockets']['byListener'])
        reset = next(error for error in report['topErrors'] if error['tag'] == 'ECONNRESET')
        self.assertEqual(reset['count'], 5)
        self.assertEqual(reset['byTarget'], [
            dict(component='stream-recovery', target='http://127.0.0.1:3773', count=3),
            dict(component='catalog-guard', target='http://127.0.0.1:3773', count=1),
            dict(component='stream-recovery', target='unknown', count=1),
        ])
        self.assertEqual(report['connectionTargetsByComponent'], [
            dict(component='catalog-guard', count=2, unknownTargetCount=1, unknownTargetShare=.5),
            dict(component='stream-recovery', count=4, unknownTargetCount=1, unknownTargetShare=.25),
        ])
        self.assertNotIn('private', json.dumps(report))
        self.assertNotIn('peerPort', json.dumps(report['inboundSockets']))

    def test_unknown_target_share_uses_normalized_occurrence_counts(self):
        cases = [
            ({'count': 100}, 100, True),
            ({'target': 'file:///private', 'count': 7}, 7, True),
            ({'target': 'control', 'count': 3}, 3, True),
            ({'target': None, 'count': 4}, 4, True),
            ({'target': '', 'count': 2}, 2, True),
            ({'target': 'http://127.0.0.1:3773', 'count': 100}, 100, False),
            ({'target': 'http://u:private@127.0.0.1:3773/path?secret=x', 'count': 5}, 5, False),
            ({}, 1, True),
            *[({'target': 'file:///private', 'count': value}, 1, True)
              for value in (0, -1, True, 1.5, '100', 9007199254740992)],
        ]
        day = '2026-11-18'
        for props, count, unknown in cases:
            with self.subTest(props=props), tempfile.TemporaryDirectory() as root:
                rows = [dict(tool='9router', component='stream-recovery', name='stall.scan', kind='error',
                             error={'tag': 'ECONNRESET'}, props=props),
                        dict(tool='9router', component='stream-recovery', name='stall.scan', kind='error',
                             error={'tag': 'ECONNRESET'}, props={'target': 'http://127.0.0.1:3773'})]
                (Path(root) / f'{day}.ndjson').write_text(''.join(json.dumps(row) + '\n' for row in rows))
                report = rollup.rollup(day, root)
                missing = count if unknown else 0
                self.assertEqual(report['connectionTargetsByComponent'], [dict(component='stream-recovery',
                    count=count + 1, unknownTargetCount=missing, unknownTargetShare=missing / (count + 1))])
                targets = report['topErrors'][0]['byTarget']
                self.assertEqual(sum(row['count'] for row in targets if row['target'] == 'unknown'), missing)


if __name__ == '__main__':
    unittest.main()
