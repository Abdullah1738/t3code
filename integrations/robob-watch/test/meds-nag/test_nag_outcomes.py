"""Reminder outcomes from real commands with synthetic state only."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2]
SOURCE = PACKAGE / 'watchers/meds-nag'


class NagOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='meds-outcome-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        runtime = self.root / 'runtime'
        self.watch = runtime / 'watchers/meds-nag'
        self.watch.mkdir(parents=True)
        for name in ('check.py', 'took.py'):
            shutil.copy2(SOURCE / name, self.watch / name)
        shutil.copy2(PACKAGE / 'toollog.py', runtime / 'toollog.py')
        self.logs = self.root / 'logs'
        self.env = dict(os.environ, WATCH_DIR=str(self.watch), HOME=str(self.root),
                        HEALTH_TOOLLOG_DIR=str(self.logs), PYTHONDONTWRITEBYTECODE='1')
        self.now = '2026-11-13T09:00:00+04:00'
        # All carry-forward doses before this fixture day have already been taken.
        self.write('taken', {'2026-11-12': ['reta', 'arimidex', 'test']})
        for name in ('nagstate', 'snooze', 'moved', 'sites', 'doses'):
            self.write(name, {})
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        ioreg = bin_dir / 'ioreg'
        ioreg.write_text('#!/bin/sh\nprintf \'"HIDIdleTime" = 99999999999999999\\n\'\n')
        ioreg.chmod(0o700)
        self.env['PATH'] = str(bin_dir) + ':' + self.env.get('PATH', '')

    def write(self, name, value):
        (self.watch / (name + '.json')).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((self.watch / (name + '.json')).read_text())

    def run_script(self, script, *args):
        result = subprocess.run([sys.executable, str(self.watch / script), *args],
                                env=dict(self.env, MEDS_NOW=self.now), capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def check(self, *args):
        return self.run_script('check.py', *args)

    def took(self, *args):
        return self.run_script('took.py', *args)

    def rows(self, event=None):
        rows = [json.loads(line) for p in sorted(self.logs.glob('*.ndjson'))
                for line in p.read_text().splitlines()]
        return [r for r in rows if event is None or r['name'] == event]

    def test_zero_nags_has_no_resolution(self):
        self.took('dutasteride')
        self.assertEqual(self.rows('nag.resolved'), [])
        self.assertIn('dutasteride', self.read('taken')['2026-11-13'])

    def test_one_nag_resolves_once_and_links_confirmation_run(self):
        self.check()
        self.now = '2026-11-13T09:12:34+04:00'
        self.took('dutasteride')
        event, = self.rows('nag.resolved')
        self.assertEqual(event['props'], {'slotKind': 'morning', 'nagCount': 1,
            'firstNagToTookSeconds': 754, 'snoozeCount': 0, 'lateMinutes': 12})
        self.assertEqual(set(event['ids']), {'run'})
        self.assertEqual(event['ids'], self.rows('cli.run')[-1]['ids'])
        self.took('dutasteride=0.5mg')
        self.assertEqual(len(self.rows('nag.resolved')), 1)

    def test_three_nags_include_fold_and_exclude_gap_checks(self):
        self.check()
        self.now = '2026-11-13T09:30:00+04:00'
        self.check('--fold')
        self.assertEqual(self.check(), '')
        self.now = '2026-11-13T10:30:00+04:00'
        self.check()
        self.now = '2026-11-13T11:00:00+04:00'
        self.took('dutasteride', 'dutasteride')
        props, = [r['props'] for r in self.rows('nag.resolved')]
        self.assertEqual((props['nagCount'], props['firstNagToTookSeconds']), (3, 7200))

    def test_snooze_before_and_after_first_nag(self):
        self.took('snooze', 'dutasteride', '--until', '10:00')
        self.check()
        self.now = '2026-11-13T10:00:00+04:00'
        self.check()
        self.took('snooze', 'all', '--until', '11:00')
        self.now = '2026-11-13T10:20:00+04:00'
        self.assertEqual(self.check(), '')
        self.took('unsnooze', 'dutasteride')
        self.took('dutasteride')
        props, = [r['props'] for r in self.rows('nag.resolved')]
        self.assertEqual((props['nagCount'], props['snoozeCount'], props['firstNagToTookSeconds']), (1, 2, 1200))

    def test_carried_slot_keeps_first_nag_and_original_scheduled_time(self):
        self.check()
        self.now = '2026-11-14T09:00:00+04:00'
        self.check()
        self.now = '2026-11-14T09:05:00+04:00'
        self.took('test')
        event, = self.rows('nag.resolved')
        self.assertEqual(event['props'], {'slotKind': 'weekly', 'nagCount': 2,
            'firstNagToTookSeconds': 86700, 'snoozeCount': 0, 'lateMinutes': 1445})
        self.took('test')
        self.assertEqual(len(self.rows('nag.resolved')), 1)

    def test_next_scheduled_slot_does_not_inherit_a_missed_slot(self):
        self.check()
        self.now = '2026-11-16T09:00:00+04:00'
        self.check()
        self.took('test')
        self.assertEqual(self.rows('nag.resolved')[0]['props']['nagCount'], 1)

    def test_early_hours_and_explicit_day_close_the_correct_slot(self):
        self.check()
        self.now = '2026-11-14T01:00:00+04:00'
        self.took('dutasteride')
        self.assertEqual(self.rows('nag.resolved')[0]['props']['firstNagToTookSeconds'], 57600)
        self.now = '2026-11-14T10:00:00+04:00'
        self.took('2026-11-13', 'test')
        self.assertEqual(len(self.rows('nag.resolved')), 2)
        self.took('2026-11-12', 'tadalafil')
        self.assertEqual(len(self.rows('nag.resolved')), 2)

    def test_day_end_unacted_slots_once_while_asleep(self):
        self.check()
        self.took('dutasteride')
        self.now = '2026-11-13T10:00:00+04:00'
        self.check()
        self.now = '2026-11-14T00:00:00+04:00'
        self.assertEqual(self.check(), '')
        row, = self.rows('nag.day_end')
        self.assertEqual(row['props'], {'slotsDue': 3, 'slotsTaken': 1, 'slotsOpen': 2, 'nagsSent': 2})
        self.assertEqual(row['ids'], self.rows('watcher.run')[-1]['ids'])
        self.now = '2026-11-14T07:00:00+04:00'
        self.assertEqual(self.check(), '')
        self.assertEqual(len(self.rows('nag.day_end')), 1)

    def test_day_end_invalid_confirmation_snapshot_retries_without_finalizing(self):
        self.check()
        self.now = '2026-11-14T07:00:00+04:00'
        path = self.watch / 'taken.json'
        valid = {'2026-11-12': ['reta', 'arimidex', 'test'],
                 '2026-11-13': ['dutasteride']}
        # Entire snapshot class: partial JSON, wrong maps/lists/members, missing/unreadable.
        rows = ['{partial', '']
        rows += [json.dumps(value) for value in [None, [], 'text', 7, 1.5, True]]
        rows += [json.dumps({'2026-11-13': value})
                 for value in [None, {}, 'text', 7, 1.5, True]]
        rows += [json.dumps({'2026-11-13': [value]})
                 for value in [None, {}, [], 7, 1.5, True]]
        rows += ['missing', 'directory']
        initial = self.read('nagstate')
        for value in rows:
            with self.subTest(value=value):
                if path.is_dir(): path.rmdir()
                if path.exists(): path.unlink()
                self.write('nagstate', initial)
                if value == 'directory': path.mkdir()
                elif value != 'missing': path.write_text(value)
                before = len(self.rows('nag.day_end'))
                self.assertEqual(self.check(), '')
                self.assertEqual(len(self.rows('nag.day_end')), before)
                self.assertNotIn('ended', self.read('nagstate')['outcomes'])
                if path.is_dir(): path.rmdir()
                self.write('taken', valid)
                self.check()
                self.assertEqual(len(self.rows('nag.day_end')), before + 1)
                self.assertEqual(self.rows('nag.day_end')[-1]['props'],
                    {'slotsDue': 3, 'slotsTaken': 1, 'slotsOpen': 2, 'nagsSent': 1})

    def test_day_end_without_nags_and_after_skips(self):
        self.took('all')
        self.check()
        self.now = '2026-11-14T07:00:00+04:00'
        self.check()
        self.assertEqual(self.rows('nag.day_end')[0]['props'],
                         {'slotsDue': 3, 'slotsTaken': 3, 'slotsOpen': 0, 'nagsSent': 0})
        self.now = '2026-11-14T09:00:00+04:00'
        self.took('skip', 'dutasteride')
        self.check()
        self.now = '2026-11-15T07:00:00+04:00'
        self.check()
        self.assertEqual(self.rows('nag.day_end')[-1]['props']['slotsDue'], 1)

    def test_day_end_includes_a_carried_slot_closed_on_that_day(self):
        self.check()
        self.now = '2026-11-14T09:00:00+04:00'
        self.check()
        self.took('test')
        self.now = '2026-11-15T07:00:00+04:00'
        self.check()
        self.assertEqual(self.rows('nag.day_end')[-1]['props'],
                         {'slotsDue': 3, 'slotsTaken': 1, 'slotsOpen': 2, 'nagsSent': 1})

    def test_logs_do_not_include_med_names_amounts_sites_or_slot_ids(self):
        self.check()
        self.took('snooze', 'test')
        self.took('test=123.456mg:R-SQ')
        self.now = '2026-11-14T07:00:00+04:00'
        self.check()
        raw = '\n'.join(json.dumps(r) for r in self.rows())
        for banned in ('dutasteride', 'tadalafil', 'arimidex', 'reta', 'Test E',
                       'test=', '123.456', 'R-SQ', '0.4ml', 'upper-outer'):
            self.assertNotIn(banned, raw)
        self.assertTrue(self.rows('nag.resolved'))
        self.assertTrue(self.rows('nag.day_end'))
        for row in self.rows('nag.resolved') + self.rows('nag.day_end'):
            self.assertEqual(set(row['ids']), {'run'})
        destination = os.environ.get('HEALTH_TOOLLOG_SAMPLES')
        if destination:
            with open(destination, 'a') as fh:
                for row in self.rows(): fh.write(json.dumps(row) + '\n')

    def test_unwritable_log_does_not_change_reminder_or_confirmation(self):
        self.logs.touch()
        self.assertIn('Meds check:', self.check())
        self.took('dutasteride')
        self.assertIn('dutasteride', self.read('taken')['2026-11-13'])
        self.now = '2026-11-14T07:00:00+04:00'
        self.assertEqual(self.check(), '')

    def test_missing_logger_and_contended_bookkeeping_keep_actions_working(self):
        import fcntl
        self.check()
        with (self.watch / 'nagstate.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.took('dutasteride')
        self.assertIn('dutasteride', self.read('taken')['2026-11-13'])
        (self.watch.parents[1] / 'toollog.py').unlink()
        self.now = '2026-11-13T10:00:00+04:00'
        self.assertIn('Meds check:', self.check())
        self.took('tadalafil')
        self.assertIn('tadalafil', self.read('taken')['2026-11-13'])

    def test_legacy_explicit_date_on_snooze_does_not_make_logging_raise(self):
        self.took('20-invalid-date', 'snooze', 'dutasteride')
        self.assertIn('dutasteride', self.read('snooze'))

    def test_broken_emitter_or_outcome_state_never_raises(self):
        spec = importlib.util.spec_from_file_location('outcome_check', self.watch / 'check.py')
        check = importlib.util.module_from_spec(spec)
        with mock.patch.dict(os.environ, self.env | {'MEDS_NOW': self.now}):
            spec.loader.exec_module(check)
            with mock.patch.object(check._tl, 'emit', side_effect=RuntimeError('private')):
                check.outcome_emit('took', 'nag.resolved', {}, 'a' * 32)
            self.write('nagstate', {'outcomes': {'slots': None}})
            check.outcome_action('resolve', dt.date(2026, 11, 13), ['test'], {})
        self.assertIn('Meds check:', self.check())
        self.took('test')


if __name__ == '__main__':
    unittest.main()
