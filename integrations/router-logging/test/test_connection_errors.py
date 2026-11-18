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
            self.assertEqual(error['byTarget'], [dict(target='http://127.0.0.1:3773', count=5),
                                               dict(target='unknown', count=3), dict(target='http://127.0.0.1:20128', count=1)])
            self.assertEqual(next(item['count'] for item in report['topErrors'] if item['tag'] == 'other'), 1)
            self.assertEqual(report['total'], 7)
            self.assertNotIn('private', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
