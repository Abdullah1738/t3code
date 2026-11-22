import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import append_cursor
import causes
import observer
import rollup
import toollog
from toollog import clean

DAY = '2026-11-22'
NOW = dt.datetime(2026, 11, 22, 16, tzinfo=dt.timezone.utc)


class PhaseWaitTests(unittest.TestCase):
    def test_populated_phase_rows_reach_real_writer_with_bounded_size(self):
        for component, name in toollog.PHASE_ROWS:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.dict(os.environ, ROUTER_LOG_DIR=directory), patch('observer.job_snapshot', return_value=dict(jobState='running', jobPid=12345, jobExit=0)), patch('toollog.report_volume'):
                    with observer.Timings(component, name, threshold_ms=-1,
                                          sampler=lambda: dict(l1=118.5, l5=90.5, l15=70.5, c=16, f=100000000, a=200000000, p=4)) as timing:
                        timing.values['history_scan_parse'] = 70000
                        timing.cpu['history_scan_parse'] = 3000
                        for counters in timing.resources.values():
                            counters.update(dict.fromkeys(causes.RESOURCE_FIELDS, 12345))
                        for counters in timing.bytes.values():
                            counters.update(dict.fromkeys(causes.BYTE_FIELDS, 110000000))
                        for steps in timing.substeps.values():
                            for values in steps.values():
                                values[:] = [12345.123, 123.123]
                    paths = list(root.glob('*.ndjson'))
                    self.assertEqual(len(paths), 1)
                    lines = paths[0].read_bytes().splitlines(keepends=True)
                    self.assertEqual(len(lines), 1)
                    self.assertGreater(len(lines[0]), 4096)
                    self.assertLessEqual(len(lines[0]), 8192)
                    row = json.loads(lines[0])
                    self.assertEqual(row['name'], name)
                    expected = causes.WAIT_FIELDS - {key for key in causes.WAIT_FIELDS if key.startswith('poolFetch')}
                    self.assertTrue((expected | causes.SUBSTEP_FIELDS) <= row['props'].keys())
                    # Identical metadata does not expand the ordinary row limit.
                    toollog.emit('poller', 'fixture.oversize', props=row['props'])
                    # Even the sparse diagnostics retain a hard upper bound.
                    oversized = dict.fromkeys(toollog.PROPS, 'a' * 100)
                    toollog.emit(component, name, props=oversized)
                    self.assertEqual(paths[0].read_bytes().splitlines(keepends=True), lines)

    def test_history_substeps_survive_logging_and_fit_exclusive_phase_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = json.dumps(dict(tool='9router', component='proxy', name='proxy.request',
                                      ts=DAY + 'T12:00:00Z', kind='perf', durationMs=123, ok=True)) + '\n'
            (root / (DAY + '.ndjson')).write_text(payload * 20)
            # Force checkpoint saves inside ParseLines as well as the final save.
            with patch('rollup.CHECKPOINT_BYTES', 1), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
                with observer.Timings(threshold_ms=-1, sampler=lambda: {}):
                    rollup.rollup(DAY, root, NOW)
                emit.assert_called_once()
                event = clean(dict(component='poller', name='poll.phases', **emit.call_args.kwargs), NOW)
            for phase in causes.BYTE_PHASES:
                prefix = observer.FIELDS[phase][:-2]
                for suffix in ('Ms', 'CpuMs'):
                    values = [event['props'][prefix + step + suffix] for step in causes.SUBSTEPS]
                    self.assertTrue(all(value >= 0 for value in values))
                    self.assertLessEqual(sum(values), event['props'][prefix + suffix])

    def test_every_phase_emits_nonnegative_counts_without_extra_rows(self):
        with patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
            with observer.Timings(threshold_ms=-1, sampler=lambda: {'e': 'unsupported'}) as timing:
                for name in observer.FIELDS:
                    with observer.phase(name):
                        pass
            emit.assert_called_once()
            event = clean(dict(component='poller', name='poll.phases', **emit.call_args.kwargs), NOW)
        for name, field in observer.FIELDS.items():
            for suffix in causes.RESOURCE_FIELDS:
                value = event['props'][field[:-2] + suffix]
                self.assertIs(type(value), int)
                self.assertGreaterEqual(value, 0)
                self.assertEqual(value, timing.resources[name][suffix])
        for name in causes.BYTE_PHASES:
            for suffix in causes.BYTE_FIELDS:
                self.assertEqual(event['props'][observer.FIELDS[name][:-2] + suffix], 0)

    def test_nested_and_repeated_phases_exclude_children_even_on_failure(self):
        counts = dict.fromkeys(causes.RESOURCE_FIELDS.values(), 0)
        usage = lambda _: SimpleNamespace(**counts)
        with patch('observer.resource.getrusage', side_effect=usage), patch('observer.job_snapshot', return_value={}):
            with observer.Timings(threshold_ms=float('inf'), sampler=lambda: {}) as timing:
                with observer.phase('history_scan_parse'):
                    for key in counts:
                        counts[key] += 3
                    for _ in range(2):
                        with self.assertRaises(ValueError), observer.phase('state_save'):
                            for key in counts:
                                counts[key] += 7
                            raise ValueError('fixture')
                self.assertEqual(timing.stack, [])
        self.assertEqual(set(timing.resources['history_scan_parse'].values()), {3})
        self.assertEqual(set(timing.resources['state_save'].values()), {14})

    def test_io_starved_blocked_matrix_and_boundaries(self):
        # inblock, major faults, involuntary, voluntary; all fields are required
        # on new rows. Legacy rows retain the old CPU-only inference.
        cases = [
            ('input_io', (16, 0, 4, 16), 30001, 0, 'tick_io:'),
            ('fault_io', (0, 16, 4, 16), 70000, 3000, 'tick_io:'),
            ('both_io', (16, 16, 0, 16), 70000, 3000, 'tick_io:'),
            ('below_inputs', (15, 15, 0, 16), 70000, 3000, 'tick_blocked:'),
            ('below_voluntary', (16, 0, 0, 15), 70000, 3000, 'tick_blocked:'),
            ('below_ratio', (16, 0, 5, 19), 70000, 3000, 'tick_blocked:'),
            ('preempted', (100, 100, 17, 16), 70000, 3000, 'tick_starved:'),
            ('preempt_boundary', (0, 0, 16, 15), 70000, 3000, 'tick_starved:'),
            ('few_switches', (0, 0, 15, 0), 70000, 3000, 'tick_blocked:'),
            ('tie', (16, 16, 16, 16), 70000, 3000, 'tick_blocked:'),
            ('quiet', (0, 0, 0, 0), 70000, 3000, 'tick_blocked:'),
            ('duration_boundary', (16, 0, 0, 16), 30000, 0, 'tick_blocked:'),
            ('cpu_boundary', (16, 0, 0, 16), 70000, 7000, 'tick_blocked:'),
            ('legacy_short', None, 70000, 3000, 'tick_blocked:'),
            ('legacy_long', None, 180000, 3000, 'tick_starved:'),
        ]
        for name, field in causes.PHASES.items():
            prefix = field[:-2]
            for label, counts, wall, cpu, tag in cases:
                props = {field: wall, prefix + 'CpuMs': cpu, 'monotonicGapMs': wall}
                if counts is not None:
                    props.update({prefix + suffix: value for suffix, value in zip(causes.RESOURCE_FIELDS, counts)})
                with self.subTest(phase=name, case=label):
                    result = causes.gap_info(props)
                    self.assertEqual(result['cause'], 'child_wait' if name == 'child_wait' else tag + name)
                    self.assertEqual(causes.gap_info(dict(props, sleepGapMs=180000))['cause'], 'guard_not_scheduled')
            for invalid in (None, True, -1, 1.5, '16', float('nan'), float('inf'), {}, []):
                props = {field: 70000, prefix + 'CpuMs': 0, 'monotonicGapMs': 70000,
                         **{prefix + suffix: 16 for suffix in causes.RESOURCE_FIELDS}}
                props[prefix + 'InblockN'] = invalid
                with self.subTest(phase=name, invalid=invalid):
                    self.assertEqual(causes.gap_info(props)['cause'], 'child_wait' if name == 'child_wait' else 'tick_blocked:' + name)
        self.assertEqual(causes.gap_info(dict(cause='tick_io:tcp'))['missingEvidence'], 'tick_phase_durations')

    def test_cursor_bytes_count_hash_validation_and_append_for_both_consumers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            payload = (json.dumps(dict(tool='9router', component='proxy', name='proxy.request',
                                      ts=DAY + 'T12:00:00Z', kind='perf', durationMs=123, ok=True)) + '\n').encode()
            source.write_bytes(payload * 10)
            rollup.rollup(DAY, root, NOW)
            with source.open('ab') as out:
                out.write(payload)
            with patch('observer.job_snapshot', return_value={}):
                with observer.Timings(threshold_ms=float('inf'), sampler=lambda: {}) as timing:
                    rollup.rollup(DAY, root, NOW)
            for name in causes.BYTE_PHASES:
                self.assertEqual(timing.bytes[name], dict(BytesHashed=len(payload) * 11, BytesParsed=len(payload)))

    def test_partial_tail_counts_only_committed_hash_bytes(self):
        with tempfile.TemporaryFile() as source, patch('observer.job_snapshot', return_value={}):
            source.write(b'first\npartial')
            source.flush()
            with observer.Timings(threshold_ms=float('inf'), sampler=lambda: {}) as timing:
                with observer.phase('history_scan_parse'):
                    cursor, _ = append_cursor.cursor_for(source, {})
                    self.assertEqual(list(append_cursor.lines(source, cursor)), [(b'first\n', True), (b'partial', False)])
            self.assertEqual(timing.bytes['history_scan_parse'], dict(BytesHashed=6, BytesParsed=13))

    def test_io_evidence_survives_logging_incremental_full_rollup(self):
        start = dt.datetime(2026, 11, 22, 12, tzinfo=dt.timezone.utc).timestamp() * 1000
        props = dict(startedAtMs=start, finishedAtMs=start + 180000, monotonicGapMs=180000,
                     historyScanParseMs=180000, historyScanParseCpuMs=3000,
                     historyScanParseInblockN=16, historyScanParseMajfltN=0,
                     historyScanParseNivcswN=4, historyScanParseNvcswN=16,
                     historyScanParseBytesHashed=110000000, historyScanParseBytesParsed=1234,
                     historyScanParseLoadStateMs=10.5, historyScanParseLoadStateCpuMs=2.5)
        event = clean(dict(component='poller', name='poll.phases', kind='perf', durationMs=180000, props=props), NOW)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (DAY + '.ndjson')
            for _ in range(2):
                with source.open('a') as out:
                    out.write(json.dumps(event) + '\n')
                report = rollup.rollup(DAY, root, NOW)
                self.assertEqual(json.dumps(report), json.dumps(rollup.rollup(DAY, root, NOW, incremental=False)))
                gap = report['pollGaps'][0]
                self.assertEqual(gap['cause'], 'tick_io:history_scan_parse')
                for key, value in props.items():
                    if key in causes.WAIT_FIELDS | causes.SUBSTEP_FIELDS:
                        self.assertEqual(gap[key], value)


if __name__ == '__main__':
    unittest.main()
