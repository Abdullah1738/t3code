"""Malformed numeric fields must not discard unrelated observations."""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jobs
import toollog
from rollup import rollup


INVALID = (10**309, -10**309, 10**400, -10**400,
           float('nan'), float('inf'), float('-inf'), True, False, None, '123', {}, [])


class NumericBoundaryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.status = self.root/'backup_last.json'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root),
                         MAC_LOG_MEMORY_STATUS=str(self.status))
        env.start()
        self.addCleanup(env.stop)
        self.now = dt.datetime(2026, 11, 14, tzinfo=dt.timezone.utc)

    def emit(self, name, props):
        path = self.root/'2026-11-14.ndjson'
        before = len(path.read_text().splitlines()) if path.exists() else 0
        toollog.emit('disk', 'event', name, now=self.now, ok=True, props=props)
        lines = path.read_text().splitlines() if path.exists() else []
        self.assertEqual(len(lines), before+1)
        return json.loads(lines[-1])['props']

    def test_bad_rollup_duration_preserves_rows_and_valid_duration(self):
        for name in ('disk.sample', 'disk.tooling_probe'):
            for value in INVALID + (-1, -0.5):
                with self.subTest(name=name, value=value):
                    rows = [dict(tool='mac', kind='perf', name=name, ok=True,
                                 props={}, durationMs=duration) for duration in (value, 25)]
                    (self.root/'2026-11-14.ndjson').write_text(
                        ''.join(json.dumps(row)+'\n' for row in rows))
                    result = rollup('2026-11-14', self.root)
                    self.assertEqual(result['total'], 2)
                    self.assertEqual(result['countsByName'], {name: 2})
                    self.assertEqual(result['malformed'], 0)
                    self.assertEqual(result['durationMs'][name], dict(p50=25, p95=25, max=25))
                    if name == 'disk.tooling_probe':
                        self.assertEqual(result['diskTooling']['probes'], 2)
                        self.assertEqual(result['diskTooling']['maxDurationMs'], 25)
                    self.assertEqual(json.loads((self.root/'rollup-2026-11-14.json').read_text()), result)

    def test_bad_process_number_preserves_event_and_valid_sibling(self):
        proc = dict(pid=1, ppid=0, processAgeS=1000, stuckForS=600,
                    cpuTime='0:01.23', samples=['U'], stat='U', comm='git', args='git status')
        busy = dict(pid=2, processAgeS=2000, cpuDeltaS=.5, statSamples=['U', 'R'], comm='msgs')
        clone = dict(pid=3, processAgeS=2000, cpuDeltaS=.5,
                     path='/Volumes/Test/fixture', wchan='vnode', reason='clone')
        cases = [('proc.disk_wait', 'procs', proc, ('pid', 'ppid', 'processAgeS', 'stuckForS')),
                 ('proc.disk_wait', 'busy', busy, ('pid', 'processAgeS', 'cpuDeltaS')),
                 ('disk.clone_wedge', 'procs', clone, ('cpuDeltaS',))]
        for name, field, good, keys in cases:
            for key in keys:
                for value in INVALID + (-1,):
                    with self.subTest(name=name, field=field, key=key, value=value):
                        clean = self.emit(name, {field: [dict(good, **{key: value}), good], 'count': 1})
                        self.assertEqual(clean[field], [good])
                        self.assertEqual(clean['count'], 1)

    def test_bad_memory_number_preserves_other_fields_and_rows(self):
        for value in INVALID + (-1,):
            with self.subTest(value=value):
                good = dict(pid=2, command='git', memMb=10, cmprsMb=.5, cpu=0)
                bad = dict(good, cmprsMb=value)
                props = dict(swap=dict(totalMb=100, usedMb=value), vm=dict(pageSize=value, freePages=10),
                             io=dict(tps=10, mbPerS=value), top=[bad, good], watched=[bad, good],
                             counts=[dict(command='git', count=value, ppid1Count=1)],
                             load=[value, .5, 1], pressure=value, processCount=2)
                clean = self.emit('memory.sample', props)
                if value is None:
                    self.assertIsNone(clean['swap']['usedMb'])
                    self.assertIsNone(clean['vm']['pageSize'])
                    self.assertIsNone(clean['top'][0]['cmprsMb'])
                    self.assertNotIn('cpu', clean['top'][0])
                    self.assertIsNone(clean['pressure'])
                    self.assertEqual(clean['load'], [.5, 1])
                    continue
                self.assertEqual(clean['swap'], dict(totalMb=100))
                self.assertEqual(clean['vm']['freePages'], 10)
                self.assertNotIn('pageSize', clean['vm'])
                self.assertEqual(clean['io'], dict(tps=10))
                for key in ('top', 'watched'):
                    self.assertEqual(len(clean[key]), 2)
                    self.assertNotIn('cmprsMb', clean[key][0])
                    self.assertNotIn('cpu', clean[key][0])
                    self.assertEqual(clean[key][0]['pid'], 2)
                    self.assertEqual(clean[key][1]['cmprsMb'], .5)
                    self.assertNotIn('cpu', clean[key][1])
                self.assertEqual(clean['counts'], [dict(command='git', ppid1Count=1)])
                self.assertEqual(clean['load'], [.5, 1])
                self.assertNotIn('pressure', clean)
                self.assertEqual(clean['processCount'], 2)

    def test_backup_timestamps_are_validated_independently(self):
        valid = dict(ts=self.now.timestamp(), ok=False, stage='replica',
                     last_success_ts=self.now.timestamp()-3600)
        for key in ('ts', 'last_success_ts'):
            for value in INVALID + (0, -1):
                with self.subTest(key=key, value=value):
                    self.status.write_text(json.dumps(dict(valid, **{key: value})))
                    self.assertEqual(jobs.backup_status(), dict(valid, **{key: None}))

    def test_bad_last_success_timestamp_keeps_fresh_failure_stage(self):
        for value in INVALID + (0, -1):
            with self.subTest(value=value):
                self.status.write_text(json.dumps(dict(ts=self.now.timestamp(), ok=False,
                                                      stage='replica', last_success_ts=value)))
                with patch.object(jobs.time, 'time', return_value=self.now.timestamp()), \
                     patch.object(jobs, 'emit', side_effect=lambda *args, **kw: toollog.emit(*args, now=self.now, **kw)), \
                     patch.object(jobs, 'backup_processes', return_value={}), \
                     patch.object(jobs, 'backup_snapshot_age', return_value=(None, 'timeout')):
                    jobs.backup_run('memory', self.now.timestamp()-60, -1, 1, 0, '{}')
                event = json.loads((self.root/'2026-11-14.ndjson').read_text().splitlines()[-1])
                self.assertEqual(event['props']['failedStage'], 'replica')
                self.assertEqual(event['error']['tag'], 'backup.failed_replica')
                self.assertIsNone(event['props']['lastGoodSnapshotAgeS'])


if __name__ == '__main__':
    unittest.main()
