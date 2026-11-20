import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import boot
import boot_identity
import jobs
import toollog
from rollup import rollup
BOOT = 1794817327
FIX = Path(__file__).parent/'fixtures/boot'


class BootTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.reports = self.root/'reports'
        self.reports.mkdir()
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root/'logs'), TZ='Asia/Dubai', BUN_INSPECT='private')
        env.start()
        time.tzset()
        self.addCleanup(time.tzset)
        self.addCleanup(env.stop)

    def runner(self, argv, **kwargs):
        self.assertNotIn('BUN_INSPECT', kwargs['env'])
        if argv[0] == '/usr/bin/last':
            return SimpleNamespace(returncode=0, stdout=(FIX/'last.txt').read_text())
        self.assertEqual(argv[:5], ['/usr/bin/log', 'show', '--style', 'ndjson', '--timezone'])
        self.assertEqual(kwargs['timeout'], 15)
        start, end = (argv[argv.index(flag)+1] for flag in ('--start', '--end'))
        window = (dt.datetime.fromisoformat(end)-dt.datetime.fromisoformat(start)).total_seconds()
        self.assertGreaterEqual(window, 179)
        self.assertLessEqual(window, 180)
        return SimpleNamespace(returncode=0, stdout='')

    def reset(self):
        path = self.reports/'ResetCounter-2026-11-16-122339.diag'
        path.write_text((FIX/'reset-button.diag').read_text())
        os.utime(path, (BOOT+92, BOOT+92))
        return path

    def collect(self, at=BOOT, **kwargs):
        return boot.collect(at, roots=[self.reports], run=self.runner, root=self.root/'logs', **kwargs)

    def rows(self):
        return [json.loads(line) for path in (self.root/'logs').glob('*.ndjson') for line in path.read_text().splitlines()]

    def test_16_nov_and_clean_boot(self):
        self.assertFalse(boot.parse_last((FIX/'last.txt').read_text(), BOOT)[0])
        clean = boot.epoch('2026-11-17T12:30:28.673004Z')
        self.assertTrue(boot.parse_last((FIX/'last.txt').read_text(), clean)[0])
        self.reset()
        props = self.collect()
        self.assertFalse(props['clean'])
        self.assertIn('btn_seq_reset', props['bootFaults']['raw'])
        self.assertEqual(props['bootFaults']['bootFailureCount'], 1)
        self.assertIsNone(props['shutdownCause'])
        self.assertFalse(props['panic']['present'])
        self.assertTrue(self.collect(clean)['clean'])

    def test_panic_and_jetsam_window(self):
        p = self.reports/'Kernel.panic'
        p.write_text('panic')
        os.utime(p, (BOOT+60, BOOT+60))
        for name, at in [('near', BOOT-30), ('old', BOOT-7201), ('after', BOOT+30)]:
            p = self.reports/('JetsamEvent-2026-11-16-'+name+'.ips')
            p.write_text(json.dumps(dict(timestamp=boot.iso(at), bug_type='298'))+'\n{}')
            os.utime(p, (at, at))
        props = self.collect()
        self.assertFalse(props['clean'])
        self.assertTrue(props['panic']['present'])
        self.assertEqual(props['jetsamReportsLast2h']['count'], 1)
        self.assertIn('near', props['jetsamReportsLast2h']['newestPath'])

    def test_missing_and_unreadable_reset_emit(self):
        real = boot.diagnostics
        for unreadable in (False, True):
            with self.subTest(unreadable=unreadable):
                if unreadable:
                    self.reset()
                def diagnostics(at, roots):
                    return real(at, roots, read=lambda p: (_ for _ in ()).throw(PermissionError()))
                with patch.object(boot, 'diagnostics', side_effect=diagnostics) if unreadable else patch.object(boot, 'diagnostics', wraps=real):
                    props = self.collect()
                self.assertIsNone(props['bootFaults'])
                self.assertIn(props['source']['bootFaults']['error'], ('missing', 'reset_unreadable'))
                props['bootTime'] = boot.iso(BOOT+int(unreadable))
                with patch.object(boot, 'collect', return_value=props):
                    boot.observe(boot=BOOT+int(unreadable), now=BOOT+700, notify=lambda *a, **kw: True)
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 2)

    def test_source_timeouts_do_not_suppress(self):
        def fail(*a, **kw):
            raise subprocess.TimeoutExpired('probe', 5)
        props = boot.collect(BOOT, roots=[self.reports], root=self.root/'logs', run=fail)
        self.assertFalse(props['clean'])
        self.assertEqual(props['source']['shutdownCause']['error'], 'unavailable')

    def test_restart_does_not_reemit_or_alert(self):
        self.reset()
        sent = []
        def notify(*args, **kw):
            sent.append(args)
            return True
        with patch.object(boot, 'collect', return_value=self.collect()) as collect:
            for _ in range(3):
                boot.observe(boot=BOOT, now=BOOT+700, notify=notify)
        self.assertEqual(collect.call_count, 1)
        self.assertEqual(len(sent), 1)
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 1)
        self.assertEqual(jobs.read_state('boot')['bootEpoch'], BOOT)

    def test_alert_timeout_reuses_key_and_message(self):
        sends = []
        def notify(*args, **kw):
            sends.append(args[:2])
            if len(sends) == 1:
                raise subprocess.TimeoutExpired('notify', 10)
            return True
        with patch.object(boot, 'collect', return_value=self.collect()):
            for offset in (700, 800, 900):
                boot.observe(boot=BOOT, now=BOOT+offset, notify=notify)
        self.assertEqual(sends, [sends[0], sends[0]])
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 1)

    def test_append_checkpoint_recovery_across_midnight(self):
        props = self.collect()
        at = boot.epoch('2026-11-16T23:59:59Z')
        toollog.emit('boot', 'event', 'boot.observed', props=props, now=dt.datetime.fromtimestamp(at, boot.UTC))
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=True, eventAt=at))
        boot.observe(boot=BOOT, now=at+10)
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 1)

    def test_failed_append_does_not_advance(self):
        with patch.object(boot, 'collect', return_value=self.collect()), patch.object(boot, 'emit', return_value=False):
            boot.observe(boot=BOOT, now=BOOT+700)
        self.assertFalse(jobs.read_state('boot')['emitted'])

    def test_grace_period(self):
        with patch.object(boot, 'collect') as collect:
            for offset in (0, 179, 200, 599.999):
                boot.observe(boot=BOOT, now=BOOT+offset)
        collect.assert_not_called()
        self.assertEqual(self.rows(), [])
        self.assertFalse((self.root/'logs/state/boot.json').exists())

    def test_prior_sample_gap_and_legacy_memory_epoch(self):
        root = self.root/'logs'
        root.mkdir()
        rows = [dict(ts=boot.iso(BOOT-120), name='memory.sample', tool='mac', props=dict(boot=BOOT-86400)),
                dict(ts=boot.iso(BOOT-100), name='cpu.sample', tool='mac'),
                dict(ts=boot.iso(BOOT-80), name='crash.source', tool='mac'),
                dict(ts=boot.iso(BOOT+1), name='cpu.sample', tool='mac')]
        (root/'2026-11-16.ndjson').write_text('\n'.join(map(json.dumps, rows)))
        props, sources = boot.previous_samples(BOOT, root)
        self.assertEqual(props['lastSampleGapS'], 80)
        self.assertEqual(props['uptimeAtPreviousSample'], 86300)
        self.assertEqual(props['previousBootTime'], boot.iso(BOOT-86400))
        self.assertIn('lastRow', sources)

    def test_unified_filter_and_unmapped_code(self):
        rows = [dict(timestamp=boot.iso(at), eventMessage=msg) for at, msg in
                [(BOOT-1, 'Previous shutdown cause: 5'), (BOOT+10, 'Previous shutdown cause: -128'),
                 (BOOT+20, 'no paniclog data'), (BOOT+181, 'Previous shutdown cause: 5')]]
        cause, source = boot.unified(BOOT, lambda *a, **kw: SimpleNamespace(returncode=0, stdout='\n'.join(map(json.dumps, rows))))
        self.assertEqual(cause, dict(code=-128, meaning='unmapped'))
        self.assertEqual(source['droppedRows'], 2)
        self.assertEqual(source['dumpPanic'], 'no_paniclog_data')

    def test_clean_boot_never_alerts(self):
        props = self.collect()
        props['clean'] = True
        with patch.object(boot, 'collect', return_value=props), patch.object(boot, 'alert_text') as alert:
            boot.observe(boot=BOOT, now=BOOT+700)
        alert.assert_not_called()

    def test_row_identity_microseconds(self):
        value = boot_identity.parse('{ sec = 1794817327, usec = 673004 }')
        self.assertAlmostEqual(value['bootEpoch'], BOOT+.673004)
        with patch.object(toollog, 'identity', return_value=value):
            toollog.emit('cpu', 'event', 'cpu.sample', props={})
        self.assertEqual(self.rows()[0]['bootEpoch'], value['bootEpoch'])

    def test_rollup_and_cap_preserve_boot(self):
        props = self.collect()
        at = dt.datetime.fromtimestamp(BOOT+700, boot.UTC)
        with patch.object(toollog, 'CAP_BYTES', 0):
            for _ in range(2):
                self.assertTrue(toollog.emit('boot', 'event', 'boot.observed', props=props, now=at))
            props['bootTime'] = boot.iso(BOOT-100)
            props['clean'] = True
            self.assertTrue(toollog.emit('boot', 'event', 'boot.observed', props=props, now=at))
        result = rollup('2026-11-16', self.root/'logs')
        self.assertEqual((result['boots'], result['uncleanBoots']), (2, 1))

    def test_schema_excludes_contents(self):
        props = self.collect()
        props.update(contents='password=private')
        props['source']['clean']['raw'] = 'password=private'
        clean = toollog.safe_fields(props, 'boot.observed')
        self.assertNotIn('private', json.dumps(clean))
        self.assertEqual(set(clean), set(props)-{'contents'})

    def test_timestamp_input_forms(self):
        for suffix in ('Z', '+0000', '+00:00', ' +0000'):
            for fraction in ('', '.0', '.00', '.28', '.123', '.123456', '.123456789'):
                with self.subTest(suffix=suffix, fraction=fraction):
                    value = boot.epoch('2026-11-16 08:22:07'+fraction+suffix)
                    self.assertAlmostEqual(value, BOOT+float('0'+fraction[:7]), places=5)

    def test_diagnostic_path_date_is_metadata(self):
        path = '/Library/Logs/DiagnosticReports/ResetCounter-2026-11-16-122339.diag'
        props = self.collect()
        props['source']['bootFaults']['path'] = path
        self.assertEqual(toollog.safe_fields(props, 'boot.observed')['source']['bootFaults']['path'], path)

    def test_boot_at_midnight_counts_on_boot_day(self):
        at = boot.epoch('2026-11-16T23:59:59Z')
        props = self.collect()
        props['bootTime'] = boot.iso(at)
        with patch.object(boot, 'collect', return_value=props):
            boot.observe(boot=at, now=at+700, notify=lambda *a, **kw: True)
        self.assertTrue((self.root/'logs/2026-11-16.ndjson').exists())
        self.assertEqual(rollup('2026-11-16', self.root/'logs')['boots'], 1)
        self.assertEqual(rollup('2026-11-17', self.root/'logs')['boots'], 0)

    def test_reset_field_forms_preserve_failure_count(self):
        forms = [
            ('normal', 'Boot faults: rst btn_rst,btn_seq_reset target_off_restart', '\n', 'rst btn_rst,btn_seq_reset target_off_restart'),
            ('empty', 'Boot faults:', '\n', ''),
            ('spaces', 'Boot faults:   ', '\n', ''),
            ('tabs', 'Boot faults:\t\t', '\n', ''),
            ('crlf', 'Boot faults:', '\r\n', ''),
            ('indent', '\tBoot faults:\t rst btn_rst \t', '\n', 'rst btn_rst'),
            ('missing', '', '\n', None),
            ('invalid', 'Boot faults: <invalid>', '\n', None),
        ]
        for label, faults, newline, raw in forms:
            with self.subTest(label=label):
                text = newline.join(['Boot failure count:\t1', faults, 'Boot stage: 0x40', ''])
                parsed = boot.parse_reset(text)
                self.assertEqual(parsed, dict(raw=raw, bootFailureCount=1))
                path = self.reset()
                path.write_text(json.dumps(dict(timestamp=boot.iso(BOOT+92)))+'\n'+text)
                with patch.object(boot, 'parse_last', return_value=(True, BOOT-86400)):
                    props = self.collect()
                self.assertFalse(props['clean'])
                self.assertEqual(props['bootFaults']['bootFailureCount'], 1)
                if raw is None:
                    self.assertIn('reset_faults_unavailable', props['source']['bootFaults']['error'])

    def test_recovery_timeout_keeps_event_and_alert_pending(self):
        props = self.collect()
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=False, eventAt=BOOT))
        with patch.object(boot, 'recovered', side_effect=boot.SourceFailure('timeout', 'fixture')):
            with self.assertRaises(boot.SourceFailure):
                boot.observe(boot=BOOT, now=BOOT+700)
        self.assertFalse(jobs.read_state('boot')['emitted'])
        self.assertFalse(jobs.read_state('boot')['alerted'])
        self.assertFalse(any(r['name'] == 'boot.observed' for r in self.rows()))
        boot.observe(boot=BOOT, now=BOOT+800, notify=lambda *a, **kw: True)
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 1)

    def test_first_append_ignores_oversized_log_prefix(self):
        root = self.root/'logs'
        root.mkdir()
        path = root/'2026-11-16.ndjson'
        # Sparse fixture represents a day file above the former 51MiB ceiling.
        with path.open('wb') as stream:
            stream.seek(52*1024*1024)
            stream.write(b'\n')
        with patch.object(boot, 'collect', return_value=self.collect()), patch.object(boot, 'recovered') as recovery:
            boot.observe(boot=BOOT, now=BOOT+700, notify=lambda *a, **kw: True)
        recovery.assert_not_called()
        self.assertTrue(jobs.read_state('boot')['emitted'])
        with path.open('rb') as stream:
            stream.seek(52*1024*1024+1)
            rows = [json.loads(line) for line in stream]
        self.assertEqual([r['name'] for r in rows], ['log.cap', 'boot.observed'])

    def test_recovery_progress_reaches_marker_beyond_budget(self):
        props = self.collect()
        root = self.root/'logs'
        root.mkdir()
        path = root/'2026-11-16.ndjson'
        prefix = '{}\n'*100
        marker = json.dumps(dict(tool='mac', name='boot.observed', props=props))+'\n'
        path.write_text(prefix+marker)
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=False, eventAt=BOOT))
        sent = []
        with patch.object(boot, 'RECOVERY_BYTES', 30):
            for index in range(12):
                boot.observe(boot=BOOT, now=BOOT+700+index, notify=lambda *a, **kw: sent.append(a) or True)
                if index < 9:
                    state = jobs.read_state('boot')
                    self.assertEqual(state['recoveryOffset'], (index+1)*30)
                    self.assertFalse(state['emitted'])
        self.assertEqual(len(sent), 1)
        self.assertTrue(jobs.read_state('boot')['emitted'])
        self.assertEqual(path.read_text().count('boot.observed'), 1)

    def test_recovery_progress_reaches_eof_without_marker(self):
        props = self.collect()
        root = self.root/'logs'
        root.mkdir()
        path = root/'2026-11-16.ndjson'
        path.write_text('{}\n'*100)
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=False, eventAt=BOOT))
        sent = []
        with patch.object(boot, 'RECOVERY_BYTES', 30):
            for index in range(12):
                boot.observe(boot=BOOT, now=BOOT+700+index, notify=lambda *a, **kw: sent.append(a) or True)
        self.assertEqual(len(sent), 1)
        self.assertEqual(path.read_text().count('boot.observed'), 1)
        self.assertTrue(jobs.read_state('boot')['emitted'])

    def test_recovery_deadline_covers_the_read(self):
        def expire(*a, **kw):
            # Exercise the active alarm handler without a timing-sensitive sleep.
            import signal
            signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
        props = self.collect()
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=False, eventAt=BOOT))
        with patch.object(boot, 'recovered', side_effect=expire):
            with self.assertRaises(boot.SourceFailure):
                boot.observe(boot=BOOT, now=BOOT+700)
        self.assertFalse(jobs.read_state('boot')['emitted'])

    def test_stop_after_recovery_checkpoint_cannot_skip_marker(self):
        props = self.collect()
        toollog.emit('boot', 'event', 'boot.observed', props=props,
                     now=dt.datetime.fromtimestamp(BOOT, boot.UTC))
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=False,
                                    eventAt=BOOT, appendAttempted=True, recoveryOffset=0))
        save = boot.save_state
        def stop_after_commit(name, state):
            save(name, state)
            raise RuntimeError('collector stopped after atomic checkpoint')
        with patch.object(boot, 'save_state', side_effect=stop_after_commit):
            with self.assertRaises(RuntimeError):
                boot.observe(boot=BOOT, now=BOOT+700)
        self.assertTrue(jobs.read_state('boot')['emitted'])
        sent = []
        boot.observe(boot=BOOT, now=BOOT+800, notify=lambda *a, **kw: sent.append(a) or True)
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 1)
        self.assertEqual(len(sent), 1)

    def test_delayed_panic_before_window_close(self):
        # Cover both panic report forms and each side of the inclusive window.
        real_collect = boot.collect
        forms = [('panic', '.panic', 300, True), ('ips', '.ips', 300, True),
                 ('window_end', '.panic', 600, True), ('outside', '.panic', 601, False)]
        for label, suffix, offset, present in forms:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                with patch.dict(os.environ, TOOLLOG_DIR=tmp), \
                     patch.object(boot, 'parse_last', return_value=(True, BOOT-86400)), \
                     patch.object(boot, 'collect', side_effect=lambda at, **kw: real_collect(at, roots=[self.reports], run=self.runner, root=Path(tmp))) as collect:
                    sent = []
                    notify = lambda *args, **kw: sent.append(args[:2]) or True
                    boot.observe(boot=BOOT, now=BOOT+200, notify=notify)
                    collect.assert_not_called()
                    self.assertEqual(list(Path(tmp).glob('*.ndjson')), [])
                    path = self.reports/(label+suffix)
                    path.write_text(json.dumps(dict(timestamp=boot.iso(BOOT+offset), bug_type='210'))
                                    if suffix == '.ips' else 'panic')
                    os.utime(path, (BOOT+offset, BOOT+offset))
                    for now in (BOOT+660, BOOT+720):
                        boot.observe(boot=BOOT, now=now, notify=notify)
                    rows = [json.loads(line) for p in Path(tmp).glob('*.ndjson') for line in p.read_text().splitlines()]
                    observed = [r for r in rows if r['name'] == 'boot.observed']
                    self.assertEqual(len(observed), 1)
                    self.assertEqual(observed[0]['props']['panic']['present'], present)
                    self.assertEqual(observed[0]['props']['clean'], not present)
                    self.assertEqual(len(sent), int(present))
                    self.assertEqual(collect.call_count, 1)
                    self.assertEqual(jobs.read_state('boot')['props']['panic']['present'], present)
                    path.unlink()

    def test_failed_alert_survives_new_boots(self):
        for failure in ('false', 'timeout'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                with patch.dict(os.environ, TOOLLOG_DIR=tmp):
                    attempts, successes = [], []
                    available = False
                    def notify(text, key, *args, **kwargs):
                        attempts.append((text, key))
                        if not available:
                            if failure == 'timeout':
                                raise subprocess.TimeoutExpired('notify', 10)
                            return False
                        successes.append((text, key))
                        return True
                    def collect(at, **kwargs):
                        props = self.collect(at)
                        props['lastSampleGapS'] = at-BOOT+10
                        return props
                    boot.observe(boot=BOOT, now=BOOT+700, collect_fn=collect, notify=notify)
                    # Simulate a pending state from the previous release/schema.
                    state = jobs.read_state('boot')
                    state.pop('pending')
                    jobs.save_state('boot', state)
                    next_boot = BOOT+3600
                    boot.observe(boot=next_boot, now=next_boot+700, collect_fn=collect, notify=notify)
                    state = jobs.read_state('boot')
                    self.assertEqual([s['bootEpoch'] for s in state['pending']], [BOOT])
                    self.assertFalse(state['alerted'])
                    available = True
                    third_boot = next_boot+3600
                    boot.observe(boot=third_boot, now=third_boot+700, collect_fn=collect, notify=notify)
                    state = jobs.read_state('boot')
                    self.assertEqual([s['bootEpoch'] for s in state['pending']], [next_boot])
                    for _ in range(2):
                        boot.observe(boot=third_boot, now=third_boot+760, collect_fn=collect, notify=notify)
                    self.assertEqual(len(successes), 3)
                    self.assertEqual({key for _, key in successes},
                                     {'mac-boot:%.6f' % at for at in (BOOT, next_boot, third_boot)})
                    self.assertEqual(successes[0], attempts[0])
                    self.assertEqual(successes[-1], attempts[2])
                    self.assertEqual(jobs.read_state('boot')['pending'], [])
                    rows = [json.loads(line) for p in Path(tmp).glob('*.ndjson') for line in p.read_text().splitlines()]
                    self.assertEqual(len([r for r in rows if r['name'] == 'boot.observed']), 3)

    def test_pending_alert_retries_during_next_boot_grace(self):
        with patch.object(boot, 'collect', return_value=self.collect()) as collect:
            boot.observe(boot=BOOT, now=BOOT+700, notify=lambda *a, **kw: False)
            sent = []
            boot.observe(boot=BOOT+3600, now=BOOT+3800, notify=lambda *a, **kw: sent.append(a) or True)
        self.assertEqual(collect.call_count, 1)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1], 'mac-boot:%.6f' % BOOT)
        self.assertTrue(jobs.read_state('boot')['alerted'])

    def test_pending_append_survives_next_boot(self):
        def collect(at, **kwargs):
            return self.collect(at)
        with patch.object(boot, 'emit', return_value=False):
            boot.observe(boot=BOOT, now=BOOT+700, collect_fn=collect)
        sent = []
        for _ in range(2):
            boot.observe(boot=BOOT+3600, now=BOOT+4300, collect_fn=collect,
                         notify=lambda *a, **kw: sent.append(a) or True)
        self.assertEqual(len(sent), 2)
        self.assertEqual(jobs.read_state('boot')['pending'], [])
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 2)

    def test_failed_queued_alert_does_not_block_current_boot(self):
        for clean in (False, True):
            with self.subTest(clean=clean), tempfile.TemporaryDirectory() as tmp:
                with patch.dict(os.environ, TOOLLOG_DIR=tmp):
                    def collect(at, **kwargs):
                        props = self.collect(at)
                        props['clean'] = clean if at != BOOT else False
                        return props
                    boot.observe(boot=BOOT, now=BOOT+700, collect_fn=collect, notify=lambda *a, **kw: False)
                    sent = []
                    def notify(text, key, *args, **kw):
                        sent.append(key)
                        return key != 'mac-boot:%.6f' % BOOT
                    boot.observe(boot=BOOT+3600, now=BOOT+4300, collect_fn=collect, notify=notify)
                    state = jobs.read_state('boot')
                    self.assertTrue(state['alerted'])
                    self.assertFalse(state['pending'][0]['alerted'])
                    self.assertEqual(len(sent), 1 if clean else 2)
                    boot.observe(boot=BOOT+3600, now=BOOT+4360, collect_fn=collect,
                                 notify=lambda *a, **kw: sent.append(a[1]) or True)
                    self.assertEqual(jobs.read_state('boot')['pending'], [])
                    self.assertEqual(sent.count('mac-boot:%.6f' % (BOOT+3600)), int(not clean))

    def test_queued_recovery_timeout_does_not_block_current_boot(self):
        props = self.collect()
        jobs.save_state('boot', dict(bootEpoch=BOOT, props=props, emitted=False, alerted=False,
                                    eventAt=BOOT, appendAttempted=True))
        with patch.object(boot, 'recovered', side_effect=boot.SourceFailure('timeout', 'fixture')):
            boot.observe(boot=BOOT+3600, now=BOOT+4300, collect_fn=lambda at, **kw: self.collect(at),
                         notify=lambda *a, **kw: True)
        state = jobs.read_state('boot')
        self.assertTrue(state['emitted'])
        self.assertTrue(state['alerted'])
        self.assertFalse(state['pending'][0]['emitted'])
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 1)

    def test_queued_append_keeps_original_boot_identity(self):
        first = BOOT+.673004
        second = first+86400
        def collect(at, **kwargs):
            return self.collect(at)
        with patch.object(boot, 'emit', return_value=False):
            boot.observe(boot=first, now=first+700, collect_fn=collect)
        with patch.object(toollog, 'identity', return_value=dict(bootEpoch=second, bootTime=boot.iso(second))):
            boot.observe(boot=second, now=second+700, collect_fn=collect, notify=lambda *a, **kw: True)
        rows = [r for r in self.rows() if r['name'] == 'boot.observed']
        self.assertEqual(len(rows), 2)
        for row, at in zip(rows, (first, second)):
            self.assertEqual(row['bootEpoch'], at)
            self.assertEqual(row['bootTime'], boot.iso(at))
            self.assertEqual(row['bootTime'], row['props']['bootTime'])

    def test_after_midnight_boot_repairs_completed_rollup(self):
        import collector
        at = boot.epoch('2026-11-16T23:59:00Z')
        def collect(value, **kwargs):
            return self.collect(value)
        boot.observe(boot=at, now=at+420, collect_fn=collect)
        self.assertTrue(collector.collect(now=at+420, roots=[], log_reader=lambda *a: {}))
        path = self.root/'logs/rollup-2026-11-16.json'
        self.assertEqual(json.loads(path.read_text())['boots'], 0)
        self.assertEqual(jobs.read_state('crashes')['rollupDay'], '2026-11-16')
        for _ in range(2):
            boot.observe(boot=at, now=at+660, collect_fn=collect, notify=lambda *a, **kw: True)
        daily = json.loads(path.read_text())
        self.assertEqual((daily['boots'], daily['uncleanBoots']), (1, 1))
        rows = [r for r in self.rows() if r['name'] == 'log.rollup' and r.get('ok')]
        self.assertEqual([r['props']['boots'] for r in rows], [0, 1])
        self.assertEqual(rows[-1]['props']['day'], '2026-11-16')
        self.assertTrue(jobs.read_state('boot')['rollupDone'])

    def test_queued_append_repairs_older_rollup(self):
        with patch.object(boot, 'emit', return_value=False):
            boot.observe(boot=BOOT, now=BOOT+700, collect_fn=lambda at, **kw: self.collect(at))
        rollup('2026-11-16', self.root/'logs')
        jobs.save_state('crashes', dict(rollupDay='2026-11-17'))
        at = BOOT+2*86400
        boot.observe(boot=at, now=at+700, collect_fn=lambda value, **kw: self.collect(value),
                     notify=lambda *a, **kw: True)
        daily = json.loads((self.root/'logs/rollup-2026-11-16.json').read_text())
        self.assertEqual((daily['boots'], daily['uncleanBoots']), (1, 1))
        self.assertEqual(jobs.read_state('crashes')['rollupDay'], '2026-11-17')
        self.assertEqual(jobs.read_state('boot')['pending'], [])
        published = [r['props'] for r in self.rows() if r['name'] == 'log.rollup' and r.get('ok')]
        self.assertEqual([(r['day'], r['boots']) for r in published], [('2026-11-16', 1)])

    def test_rollup_lock_and_publication_failure_remain_retryable(self):
        import rollup as daily
        at = boot.epoch('2026-11-16T23:59:00Z')
        self.root.joinpath('logs/state').mkdir(parents=True)
        sent = []
        notify = lambda *a, **kw: sent.append(a) or True
        def collect(value, **kwargs):
            return self.collect(value)
        lock_path = self.root/'logs/state/rollup-2026-11-16.lock'
        with lock_path.open('a') as lock, patch.object(daily, 'aggregate', wraps=daily.aggregate) as aggregate:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Neither the normal collector nor a late-boot repair may read an
            # older snapshot and publish it over another writer's newer counts.
            with self.assertRaises(BlockingIOError):
                rollup('2026-11-16', self.root/'logs', publish=True)
            boot.observe(boot=at, now=at+660, collect_fn=collect, notify=notify)
            aggregate.assert_not_called()
        state = jobs.read_state('boot')
        self.assertFalse(state.get('rollupDone', False))
        self.assertTrue(state['alerted'])
        with patch.object(daily, 'emit', return_value=False):
            boot.observe(boot=at, now=at+720, collect_fn=collect, notify=notify)
        self.assertFalse(jobs.read_state('boot').get('rollupDone', False))
        next_boot = at+86400
        # The incomplete repair also survives a second reboot.
        for _ in range(2):
            boot.observe(boot=next_boot, now=next_boot+700, collect_fn=collect, notify=notify)
        self.assertEqual(len(sent), 2)
        self.assertEqual(jobs.read_state('boot')['pending'], [])
        self.assertEqual(json.loads((self.root/'logs/rollup-2026-11-16.json').read_text())['boots'], 1)
        self.assertEqual(len([r for r in self.rows() if r['name'] == 'boot.observed']), 2)
