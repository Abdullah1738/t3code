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
import shutdown_evidence
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
        if argv[0] == '/usr/sbin/sysctl':
            return SimpleNamespace(returncode=0, stdout=(FIX/'boot-state-21nov.txt').read_text())
        if argv[0] == '/usr/sbin/spindump':
            Path(argv[argv.index('-o')+1]).write_text((FIX/'stall-21nov.txt').read_text())
            return SimpleNamespace(returncode=0, stdout='')
        self.assertEqual(argv[:5], ['/usr/bin/log', 'show', '--style', 'ndjson', '--timezone'])
        self.assertEqual(kwargs['timeout'], 15)
        start, end = (argv[argv.index(flag)+1] for flag in ('--start', '--end'))
        window = (dt.datetime.fromisoformat(end)-dt.datetime.fromisoformat(start)).total_seconds()
        self.assertGreaterEqual(window, 179)
        self.assertLessEqual(window, 180)
        return SimpleNamespace(returncode=0, stdout=(FIX/'shutdown-21nov.ndjson').read_text() if '--debug' in argv else '')

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
        state = jobs.read_state('boot')
        self.assertEqual(state['bootEpoch'], BOOT)
        self.assertNotIn('props', state)
        self.assertFalse(state['emitted'])

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
        state = jobs.read_state('boot')
        self.assertEqual(state['bootEpoch'], BOOT+3600)
        self.assertEqual(state['pending'], [])
        self.assertFalse(state['emitted'])

    def test_short_lived_boot_keeps_full_panic_window(self):
        second = BOOT+300
        sent = []
        def collect(at, **kwargs):
            return self.collect(at, previous=kwargs['previous'])
        def observe(at, now):
            return boot.observe(boot=at, now=now, run=self.runner, collect_fn=collect,
                                notify=lambda *a, **kw: sent.append(a[1]) or True)
        with patch.object(boot, 'parse_last', return_value=(True, None)):
            for offset in (60, 120, 180, 240):
                observe(BOOT, BOOT+offset)
                state = jobs.read_state('boot')
                self.assertEqual(state['bootEpoch'], BOOT)
                self.assertNotIn('props', state)
            observe(second, second+60)
            state = jobs.read_state('boot')
            self.assertEqual([p['bootEpoch'] for p in state['pending']], [BOOT])
            path = self.reports/'late.panic'
            path.write_text('panic')
            os.utime(path, (BOOT+590, BOOT+590))
            observe(second, BOOT+599)
            self.assertEqual(self.rows(), [])
            self.assertEqual(sent, [])
            observe(second, BOOT+600)
            rows = [r for r in self.rows() if r['name'] == 'boot.observed']
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['bootEpoch'], BOOT)
            self.assertTrue(rows[0]['props']['panic']['present'])
            self.assertFalse(rows[0]['props']['clean'])
            for offset in (600, 660, 720):
                observe(second, second+offset)
        rows = [r for r in self.rows() if r['name'] == 'boot.observed']
        self.assertEqual([r['bootEpoch'] for r in rows], [BOOT, second])
        self.assertEqual(rows[1]['props']['previousBootTime'], boot.iso(BOOT))
        self.assertEqual(sent, ['mac-boot:%.6f' % at for at in (BOOT, second)])
        daily = rollup('2026-11-16', self.root/'logs')
        self.assertEqual((daily['boots'], daily['uncleanBoots']), (2, 2))
        self.assertEqual(jobs.read_state('boot')['pending'], [])

    def test_multiple_short_lived_boots_survive_collector_restarts(self):
        boots = [BOOT+offset for offset in (0, 60, 120, 180)]
        sent, collected = [], []
        def collect(at, **kwargs):
            collected.append((at, kwargs['previous']))
            return self.collect(at, previous=kwargs['previous'])
        for at in boots:
            boot.observe(boot=at, now=at+30, run=self.runner, collect_fn=collect)
        state = jobs.read_state('boot')
        self.assertEqual([p['bootEpoch'] for p in state['pending']], boots[:-1])
        self.assertEqual(collected, [])
        for _ in range(5):
            boot.observe(boot=boots[-1], now=boots[-1]+700, run=self.runner,
                         collect_fn=collect, notify=lambda *a, **kw: sent.append(a[1]) or True)
        rows = [r for r in self.rows() if r['name'] == 'boot.observed']
        self.assertCountEqual([r['bootEpoch'] for r in rows], boots)
        by_boot = {r['bootEpoch']: r['props']['previousBootTime'] for r in rows}
        self.assertEqual([by_boot[at] for at in boots], [None]+[boot.iso(at) for at in boots[:-1]])
        self.assertCountEqual(sent, ['mac-boot:%.6f' % at for at in boots])
        self.assertCountEqual(collected, list(zip(boots, [None]+boots[:-1])))
        self.assertEqual(jobs.read_state('boot')['pending'], [])
        self.assertEqual(rollup('2026-11-16', self.root/'logs')['boots'], 4)

    def test_queued_predecessor_and_sample_boot_are_independent(self):
        root = self.root/'logs'
        root.mkdir()
        rows = [dict(ts=boot.iso(BOOT+40), name='cpu.sample', tool='mac', bootEpoch=BOOT),
                dict(ts=boot.iso(BOOT), name='boot.observed', tool='mac', bootEpoch=BOOT)]
        (root/'2026-11-16.ndjson').write_text('\n'.join(map(json.dumps, rows)))
        target = BOOT+180
        forms = [('unknown', None, BOOT), ('older_state', BOOT-60, BOOT),
                 ('same_boot', BOOT, BOOT), ('queued_predecessor', BOOT+120, BOOT+120),
                 ('future_state', target+60, BOOT)]
        for label, previous, expected in forms:
            with self.subTest(label=label):
                props, _ = boot.previous_samples(target, root, previous)
                self.assertEqual(props['previousBootTime'], boot.iso(expected))
                self.assertEqual(props['uptimeAtPreviousSample'], 40)
                self.assertEqual(props['lastSampleGapS'], 140)

    def test_early_boot_persists_before_evidence_failure(self):
        def unavailable(at, *args, **kwargs):
            self.assertEqual(jobs.read_state('boot')['bootEpoch'], at)
            raise OSError('evidence unavailable')
        with patch.object(shutdown_evidence, 'kernel_reasons', side_effect=unavailable):
            boot.observe(boot=BOOT, now=BOOT+60)
        with self.assertRaises(OSError):
            boot.observe(boot=BOOT, now=BOOT+600, collect_fn=unavailable)
        state = jobs.read_state('boot')
        self.assertNotIn('props', state)
        second = BOOT+300
        boot.observe(boot=second, now=second+700,
                     collect_fn=lambda at, **kw: self.collect(at), notify=lambda *a, **kw: True)
        rows = [r for r in self.rows() if r['name'] == 'boot.observed']
        self.assertEqual([r['bootEpoch'] for r in rows], [BOOT, second])

    def test_queued_boot_keeps_its_own_kernel_reasons(self):
        second = BOOT+300
        def reasons(at, run):
            if at == BOOT and current != BOOT:
                raise ValueError('different boot')
            return dict(shutdownReason=' raw shutdown %s' % at, bootReason=' raw boot %s' % at)
        current = BOOT
        with patch.object(shutdown_evidence, 'kernel_reasons', side_effect=reasons):
            boot.observe(boot=BOOT, now=BOOT+60, run=self.runner)
            current = second
            boot.observe(boot=second, now=second+60, run=self.runner)
            boot.observe(boot=second, now=second+700, run=self.runner,
                         collect_fn=lambda at, **kw: self.collect(at), notify=lambda *a, **kw: True)
        rows = [r for r in self.rows() if r['name'] == 'boot.observed']
        self.assertEqual(len(rows), 2)
        for row, at in zip(rows, (BOOT, second)):
            self.assertEqual(row['props']['shutdownReason'], ' raw shutdown %s' % at)
            self.assertEqual(row['props']['bootReason'], ' raw boot %s' % at)
            self.assertIsNone(row['props']['source']['shutdownReason']['error'])

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

    def test_orderly_21_nov_boot_with_shutdown_stall(self):
        at = boot.epoch('2026-11-21T10:12:28.443847Z')
        self.assertTrue(boot.parse_last((FIX/'last.txt').read_text(), at)[0])
        path = self.reports/'shutdown_stall_2026-11-21-141211_Abdullahs-MacBook-Pro.shutdownStall'
        path.write_bytes(b'not a JSON report')
        os.utime(path, (at-17, at-17))
        props = self.collect(at)
        self.assertTrue(props['clean'])
        self.assertTrue(props['source']['clean']['shutdownRecord'])
        self.assertFalse(props['source']['clean']['abnormalEvidence'])
        self.assertIsNone(props['bootFaults'])
        self.assertFalse(props['panic']['present'])
        self.assertEqual(props['shutdownStall'], dict(present=True, path=str(path),
            sampleStart='2026-11-21T10:11:56.760000Z', sampleEnd='2026-11-21T10:11:57.763000Z'))
        request = props['shutdownRequest']
        self.assertEqual(request, dict(operation='restart', requestedAt='2026-11-21T10:11:22.954332Z',
            confirmedAt='2026-11-21T10:11:31.124134Z', senderPid=19937, senderBundle='com.ardud.robob',
            senderName='Robob', senderForeground=True, humanActor='not established', softwareUpdate=False,
            callerChain='shutdown[6066]<-sessionlogoutd[6062]', initiatedAt='2026-11-21T10:11:54.751218Z'))
        self.assertTrue(props['shutdownRecord'])
        self.assertIsNone(props['forcedWatchdogTimeout'])
        for key, sysctl in [('shutdownReason', 'kern.shutdownreason'), ('bootReason', 'kern.bootreason')]:
            expected = next(line.split(': ', 1)[1] for line in (FIX/'boot-state-21nov.txt').read_text().splitlines() if line.startswith(sysctl+':'))
            self.assertEqual(props[key], expected)
        sent = []
        with patch.object(boot, 'collect', return_value=props):
            for now in (at+660, at+720):
                boot.observe(boot=at, now=now, notify=lambda *a, **kw: sent.append(a) or True)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], 'restart requested by Robob at 2026-11-21T10:11:22.954332Z, shutdown stalled.')
        row = next(r for r in self.rows() if r['name'] == 'boot.observed')
        self.assertEqual(row['props']['shutdownStall'], props['shutdownStall'])
        self.assertEqual(row['props']['source']['shutdownStall'], props['source']['shutdownStall'])
        for field in ('shutdownRequest', 'shutdownRecord', 'shutdownReason', 'bootReason', 'forcedWatchdogTimeout'):
            self.assertEqual(row['props'][field], props[field])

    def test_shutdown_stall_time_window(self):
        for offset, present in [(-601, False), (-600, True), (-17, True), (600, True), (601, False)]:
            with self.subTest(offset=offset):
                path = self.reports/'shutdown_stall_fixture.shutdownStall'
                path.write_bytes(b'binary')
                os.utime(path, (BOOT+offset, BOOT+offset))
                with patch.object(boot, 'parse_last', return_value=(True, BOOT-86400)):
                    props = self.collect()
                self.assertEqual(props['shutdownStall']['present'], present)
                self.assertTrue(props['clean'])

    def test_watchdog_tokens_do_not_establish_a_timeout(self):
        path = self.reset()
        for raw in ('wdog,reset_in_1', 'wdog,reset_in_1 rst_in,reset_in_1_deassert wdog,reset_in_1 ap_restart'):
            for failure_count in (0, 1):
                with self.subTest(raw=raw, failure_count=failure_count):
                    text = (FIX/'reset-button.diag').read_text().replace('rst btn_rst,btn_seq_reset target_off_restart', raw)
                    path.write_text(text.replace('Boot failure count: 1', 'Boot failure count: '+str(failure_count)))
                    with patch.object(boot, 'parse_last', return_value=(True, None)):
                        props = self.collect()
                    self.assertEqual(props['clean'], failure_count == 0)
                    self.assertIsNone(props['forcedWatchdogTimeout'])
        self.assertIsNone(self.collect()['shutdownReason'])  # Today's sysctl cannot describe 16 Nov.

    def test_request_forms_and_sender_correlation(self):
        at = boot.epoch('2026-11-21T10:12:28.443847Z')
        original = (FIX/'shutdown-21nov.ndjson').read_text()
        for title in ('Restart', 'Shutdown'):
            for mode in ('exact', 'no_audit', 'old_audit', 'other_receiver', 'type_only'):
                with self.subTest(title=title, mode=mode):
                    rows = [json.loads(line) for line in original.replace('Restart', title).replace('restart:', title.lower()+':').splitlines()]
                    for row in rows:
                        if 'pid: 19937' in row['eventMessage']:
                            if mode == 'no_audit': row['eventMessage'] = 'audit token missing'
                            if mode == 'old_audit': row['timestamp'] = boot.iso(at-100)
                            if mode == 'other_receiver': row['processID'] = 999
                        if mode == 'type_only' and 'Received a kAEShow' in row['eventMessage']:
                            row['eventMessage'] = 'unavailable'
                    props, _ = shutdown_evidence.parse_shutdown('\n'.join(map(json.dumps, rows)), at)
                    req = props['shutdownRequest']
                    self.assertEqual(req['operation'], title.lower())
                    self.assertEqual(req['senderPid'], 19937 if mode == 'exact' else None)
                    self.assertEqual(req['senderBundle'], 'com.ardud.robob' if mode == 'exact' else None)
                    self.assertEqual(req['humanActor'], 'not established')

    def test_shutdown_query_filters_overruns_and_watchdog_evidence(self):
        at = boot.epoch('2026-11-21T10:12:28Z')
        for process, msg, established in [
                ('watchdogd', 'watchdog monitoring services', None),
                ('launchd', 'Sending SIGTERM to watchdogd', None),
                ('kernel', 'wdog,reset_in_1', None),
                ('kernel', 'userspace watchdog timeout: no successful checkins from logd', True),
                ('watchdogd', 'no successful checkins from logd in 120 seconds', True),
                ('log', 'query userspace watchdog timeout', None)]:
            for offset, inside in [(-181, False), (-180, True), (-1, True), (0, False), (1, False)]:
                with self.subTest(process=process, msg=msg, offset=offset):
                    row = dict(timestamp=boot.iso(at+offset), processImagePath='/sbin/'+process, eventMessage=msg)
                    props, source = shutdown_evidence.parse_shutdown(json.dumps(row), at)
                    self.assertEqual(props['forcedWatchdogTimeout'], established if inside else None)
                    self.assertEqual(source['droppedRows'], int(not inside))

    def test_cancelled_request_then_every_request_form(self):
        at = boot.epoch('2026-11-21T10:12:28Z')
        def row(message, offset, receiver=182):
            return dict(timestamp=boot.iso(at+offset), processID=receiver,
                        processImagePath='/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow',
                        eventMessage=message)
        def dialog(title):
            return '-[SessionLogoutManager handleAppleEvent:reply:refCon:] | Received a kAEShow'+title+'Dialog'
        def logout(title, code):
            return '-[SessionLogoutManager startLogout:logoutSubType:showConfirmationUI:countDownTime:useTALOption:logoutOptions:] | logoutType:'+code+' - '+title+', subLogoutType:0 - NoSubType'
        audit = '-[SessionLogoutManager handleAppleEvent:reply:refCon:] | pid: '
        dictionary = '-[GUIApplicationLogout loadProccessesToQuitArray] | appDictionary:{\n pid = 19937;\n LSDisplayName = Robob;\n BundleIdentifierLowerCase = "com.ardud.robob";\n ApplicationType = Foreground;\n}'
        for previous in ('Restart', 'Shutdown'):
            cancelled = [row(audit+'19937', -66), row(dialog(previous), -65),
                         row(logout(previous, '2'), -65), row(dictionary, -64),
                         row('-[ShutdownLogoutUIManager _showAlert]_block_invoke | logoutType 2, sublogoutType 0, result 1001 received', -60)]
            # A cancelled dialog without a later request must not reach the alert.
            props, _ = shutdown_evidence.parse_shutdown('\n'.join(map(json.dumps, cancelled)), at)
            self.assertIsNone(props['shutdownRequest']['operation'])
            self.assertIsNone(props['shutdownRequest']['senderPid'])
            for title in ('Restart', 'Shutdown'):
                for form in ('dialog', 'type_only'):
                    for fresh_sender in (False, True):
                        with self.subTest(previous=previous, title=title, form=form, fresh_sender=fresh_sender):
                            rows = list(cancelled)
                            if fresh_sender:
                                rows.append(row(audit+'20000', -46))
                            if form == 'dialog':
                                rows.append(row(dialog(title), -45))
                            rows.extend([row(logout(title, '3'), -45),
                                         row('-[ShutdownLogoutUIManager '+title.lower()+':] | enter', -44)])
                            props, _ = shutdown_evidence.parse_shutdown('\n'.join(map(json.dumps, rows)), at)
                            request = props['shutdownRequest']
                            self.assertEqual(request['operation'], title.lower())
                            self.assertEqual(request['requestedAt'], boot.iso(at-45))
                            self.assertEqual(request['confirmedAt'], boot.iso(at-44))
                            self.assertEqual(request['senderPid'], 20000 if form == 'dialog' and fresh_sender else None)
                            self.assertIsNone(request['senderBundle'])
                            alert = boot.alert_text(dict(clean=True, shutdownStall=dict(present=True), shutdownRequest=request))
                            self.assertTrue(alert.startswith(title.lower()+' requested by unknown process at '+boot.iso(at-45)))

    def test_unmatched_cancel_does_not_clear_active_request(self):
        at = boot.epoch('2026-11-21T10:12:28.443847Z')
        original = [json.loads(line) for line in (FIX/'shutdown-21nov.ndjson').read_text().splitlines()]
        for receiver, code in ((999, '2'), (182, '9')):
            with self.subTest(receiver=receiver, code=code):
                cancel = dict(timestamp=boot.iso(at-60), processID=receiver,
                    processImagePath='/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow',
                    eventMessage='-[ShutdownLogoutUIManager _showAlert]_block_invoke | logoutType '+code+', sublogoutType 0, result 1001 received')
                props, _ = shutdown_evidence.parse_shutdown('\n'.join(map(json.dumps, original+[cancel])), at)
                self.assertEqual(props['shutdownRequest']['senderPid'], 19937)
                self.assertEqual(props['shutdownRequest']['operation'], 'restart')

    def test_stall_decode_failure_still_observes_and_alerts_once(self):
        at = boot.epoch('2026-11-21T10:12:28.443847Z')
        path = self.reports/'shutdown_stall_fixture.shutdownStall'
        path.write_bytes(b'binary')
        os.utime(path, (at-17, at-17))
        for failure in (PermissionError(), subprocess.TimeoutExpired('spindump', 15), ValueError()):
            with self.subTest(failure=type(failure).__name__), patch.object(shutdown_evidence, 'stall_interval', side_effect=failure):
                props = self.collect(at)
            self.assertTrue(props['clean'])
            self.assertTrue(props['shutdownStall']['present'])
            self.assertIsNone(props['shutdownStall']['sampleStart'])
            self.assertEqual(props['source']['shutdownStall']['sampleError'], 'unavailable')
        sent = []
        with patch.object(boot, 'collect', return_value=props):
            boot.observe(boot=at, now=at+660, notify=lambda *a, **kw: False)
            boot.observe(boot=at+3600, now=at+3700, notify=lambda *a, **kw: sent.append(a) or True)
            boot.observe(boot=at+3600, now=at+3800, notify=lambda *a, **kw: sent.append(a) or True)
        self.assertEqual(len(sent), 1)
        self.assertIn('shutdown stalled', sent[0][0])

    def test_sample_interval_input_forms(self):
        for zone in ('+0400', '+04:00'):
            with self.subTest(zone=zone):
                text = (FIX/'stall-21nov.txt').read_text().replace('+0400', zone)
                result = shutdown_evidence.sample_interval(text)
                self.assertEqual(result['sampleStart'], '2026-11-21T10:11:56.760000Z')
                self.assertEqual(result['sampleEnd'], '2026-11-21T10:11:57.763000Z')
        for text in ('', 'Date/Time: invalid', 'Date/Time: 2026-11-21 14:11:57 +0400\nEnd time: 2026-11-21 14:11:56 +0400'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                shutdown_evidence.sample_interval(text)

    def test_stall_filename_survives_changed_mtime(self):
        at = boot.epoch('2026-11-21T10:12:28.443847Z')
        path = self.reports/'shutdown_stall_2026-11-21-141211_host.shutdownStall'
        path.write_bytes(b'original diagnostic')
        for mtime in (at-17, at+7200):
            with self.subTest(mtime=mtime):
                os.utime(path, (mtime, mtime))
                props = self.collect(at)
                self.assertTrue(props['shutdownStall']['present'])
                self.assertEqual(props['shutdownStall']['sampleStart'], '2026-11-21T10:11:56.760000Z')
                self.assertEqual(path.read_bytes(), b'original diagnostic')
                self.assertEqual(path.stat().st_mtime, mtime)

    def test_native_decoder_can_modify_only_its_private_copy(self):
        path = self.reports/'stall.shutdownStall'
        path.write_bytes(b'original')
        before = path.stat().st_mtime_ns
        def decoder(argv, **kwargs):
            self.assertEqual(kwargs['timeout'], 15)
            copied = Path(argv[argv.index('-i')+1])
            self.assertNotEqual(copied, path)
            self.assertEqual(copied.read_bytes(), b'original')
            copied.write_bytes(b'changed by native decoder')
            Path(argv[argv.index('-o')+1]).write_text((FIX/'stall-21nov.txt').read_text())
            return SimpleNamespace(returncode=0, stdout='')
        result = shutdown_evidence.stall_interval(str(path), decoder)
        self.assertEqual(result['sampleEnd'], '2026-11-21T10:11:57.763000Z')
        self.assertEqual(path.read_bytes(), b'original')
        self.assertEqual(path.stat().st_mtime_ns, before)
