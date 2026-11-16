cat > integrations/memory-system/tests/test_backup_partial.py <<'PY'
"""Run the complete backup shell against synthetic sources and command stubs."""
import json
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
SQLITE = '/opt/homebrew/opt/sqlite/bin/sqlite3' if sys.platform == 'darwin' else shutil.which('sqlite3')
LSOF = '/usr/sbin/lsof' if sys.platform == 'darwin' else shutil.which('lsof')
RSYNC = shutil.which('rsync')


@unittest.skipUnless(SQLITE and LSOF and RSYNC, 'SQLite, lsof and rsync required')
class PartialBackup(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='backup-partial-')
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.root = self.home / '.local/share/memory-system'
        self.stage = self.home / 'stage'
        self.repo = self.home / 'repo/live'
        self.logger = self.home / 'logger'
        for path in (self.root / 'src', self.root / 'scripts', self.root / 'data',
                     self.root / 'logs', self.root / 'bin', self.stage, self.repo, self.logger):
            path.mkdir(parents=True)
        for path in (PACKAGE / 'src').glob('*.py'):
            content = path.read_text().replace('/usr/sbin/lsof', LSOF)
            (self.root / 'src' / path.name).write_text(content)
        (self.repo / 'config').touch()
        (self.root / 'HANDOFF.md').touch()
        self.status = self.root / 'logs/backup_last.json'
        self.last_ok = int(time.time()) - 3600
        self.status.write_text(json.dumps(dict(ok=True, last_success_ts=self.last_ok,
                                               last_snapshot='11111111')))
        self.source('memory.db', 'episodic_events', 2)
        self.source('opencode_raw.db', 'raw_messages', 3)
        self.database(self.stage / 'memory.db', 'episodic_events', 1)
        self.database(self.home / 'robob.sqlite', 'scheduled_tasks', 1)
        self.program(self.root / 'src/run_limited.py',
                     'import subprocess,sys\nsys.exit(subprocess.call(sys.argv[sys.argv.index("--")+1:]))\n')
        self.program(self.root / 'src/robob_readonly.py',
                     'import os,sys\nprint("fixture" if "--generation" in sys.argv else os.path.join(os.environ["HOME"],"robob.sqlite"))\n')
        self.program(self.root / 'src/dropbox_mirror.py',
                     'import os,pathlib\npathlib.Path(os.environ["HOME"],"mirrored").touch()\nprint("{}")\n')
        self.program(self.root / 'bin/sqlite3_rsync', '''import os,pathlib,sqlite3,sys
src,dst=map(pathlib.Path,sys.argv[-2:])
with pathlib.Path(os.environ['HOME'],'replicated').open('a') as f: f.write(src.name+'\\n')
if src.name == 'memory.db':
    mode=os.environ.get('CAP_MODE','cap')
    if mode == 'wal': pathlib.Path(str(dst)+'-wal').write_bytes(b'dirty')
    if mode == 'missing': dst.unlink()
    if mode == 'unreadable': dst.write_bytes(b'invalid database')
    if mode == 'next': pathlib.Path(str(dst)+'.next').write_bytes(b'partial reseed')
    if mode != 'success': sys.exit(125 if mode == 'survivor' else 1 if mode == 'error' else 124)
with sqlite3.connect(src) as source, sqlite3.connect(dst) as target: source.backup(target)
''')
        self.program(self.home / 'restic', '''import json,os,pathlib,sys
with pathlib.Path(os.environ['HOME'],'restic-calls').open('a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
if sys.argv[1] == 'backup':
    if os.environ.get('FAIL_RESTIC'): sys.exit(1)
    print(json.dumps(dict(message_type='summary',snapshot_id='abcdef123456',data_added_packed=42,total_bytes_processed=123)))
''')
        self.program(self.home / 'notify', '''import json,os,pathlib,sys
with pathlib.Path(os.environ['HOME'],'notices').open('a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
sys.exit(int(os.environ.get('FAIL_NOTICE','0')))
''')
        (self.logger / 'toollog.py').write_text('''import json,os,pathlib
NUMBERS=set()
def emit(component,kind,name,**kw):
    props=kw['props']
    assert 'partial_dbs_count' not in props or 'partial_dbs_count' in NUMBERS
    with pathlib.Path(os.environ['HOME'],'tool-log').open('a') as f:
        f.write(json.dumps(dict(component=component,kind=kind,name=name,**kw))+'\\n')
''')
        (self.logger / 'jobs.py').write_text('from toollog import emit\ndef backup_run(*args): pass\n')
        (self.logger / 'toollog.sh').write_text('mac_log() { [ "$1" != backup-restic-exit ] || echo "$3"; }\n')
        content = (PACKAGE / 'scripts/memory_backup.sh').read_text()
        for old, new in {
            '/opt/homebrew/bin/python3': shlex.quote(sys.executable),
            '/opt/homebrew/opt/sqlite/bin/sqlite3': SQLITE,
            '/opt/homebrew/bin/restic': str(self.home / 'restic'),
            '/opt/homebrew/bin/rsync': RSYNC,
            'df -g ': 'df -B 1073741824 ' if sys.platform != 'darwin' else 'df -g ',
            'stat -f %m ': 'stat -c %Y ' if sys.platform != 'darwin' else 'stat -f %m ',
        }.items():
            content = content.replace(old, new)
        self.script = self.root / 'scripts/memory_backup.sh'
        self.script.write_text(content)

    def program(self, path, content):
        path.write_text('#!' + sys.executable + '\n' + content)
        path.chmod(0o755)

    def database(self, path, table, value):
        with sqlite3.connect(path) as con:
            con.execute(f'create table {table}(id integer primary key)')
            con.execute(f'insert into {table} values (?)', (value,))

    def source(self, name, table, value):
        self.database(self.root / 'data' / name, table, value)

    def run_backup(self, mode='cap', **extra):
        env = {**os.environ, 'HOME': str(self.home), 'MAC_LOG_HOME': str(self.logger),
               'RECALL_FENCED': '1', 'MEMORY_BACKUP_GUARDED': '1',
               'MEMORY_BACKUP_STAGE': str(self.stage), 'MEMORY_BACKUP_REPO_ROOT': str(self.repo.parent),
               'MEMORY_BACKUP_MIN_FREE_GB': '0', 'MEMORY_BACKUP_LOAD_OVERRIDE': '0.1',
               'MEMORY_BACKUP_UPTIME_OVERRIDE': '86400', 'CAP_MODE': mode,
               'MEMORY_BACKUP_NOTIFY_CMD': shlex.quote(str(self.home / 'notify')), **extra}
        env.pop('BASH_ENV', None)
        result = subprocess.run(['/bin/bash', str(self.script)], env=env, capture_output=True,
                                text=True, timeout=30)
        return result, json.loads(self.status.read_text())

    def rows(self, name):
        path = self.home / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_cap_finishes_partial_snapshot_mirror_manifest_and_failure_notice(self):
        result, status = self.run_backup('next')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(status['ok'])
        self.assertEqual(status['stage'], 'replica')
        self.assertEqual(status['message'], 'partial: memory.db capped')
        self.assertEqual(status['last_success_ts'], self.last_ok)
        self.assertEqual(status['last_snapshot'], '11111111')
        self.assertEqual(status['last_partial_snapshot'], 'abcdef12')
        self.assertGreater(status['last_partial_ts'], self.last_ok)
        self.assertEqual(status['partial_dbs'], ['memory.db'])
        self.assertTrue(status['failure_notice_sent'])
        calls = self.rows('restic-calls')
        self.assertEqual([c[0] for c in calls], ['backup', 'forget'])
        for call in calls:
            self.assertIn('memory-partial', call)
            self.assertNotIn('memory-live', call)
        self.assertIn('stale:memory.db', calls[0])
        self.assertIn(str(self.stage / '*.next*'), calls[0])
        self.assertEqual(calls[1][calls[1].index('--keep-last')+1], '2')
        self.assertIn('--prune', calls[1])
        self.assertEqual((self.home / 'replicated').read_text().splitlines(), ['memory.db', 'opencode_raw.db'])
        self.assertTrue((self.stage / 'robob-state.sql').exists())
        self.assertTrue((self.home / 'mirrored').exists())
        manifests = list((self.root / 'data/backup-manifests').glob('*.json'))
        self.assertEqual(len(manifests), 1)
        self.assertEqual(json.loads(manifests[0].read_text())['snapshot_id'], 'abcdef12')
        notice = self.rows('notices')[0]
        text = notice[notice.index('--text')+1]
        self.assertIn('partial', text)
        self.assertIn('memory.db', text)
        row, = self.rows('tool-log')
        self.assertFalse(row['ok'])
        self.assertEqual(row['name'], 'backup.run')
        self.assertEqual(row['props']['failureStage'], 'replica')
        self.assertIs(row['props']['partial'], True)
        self.assertEqual(row['props']['partial_dbs_count'], 1)
        self.assertEqual(row['props']['skipped'], 0)
        self.assertNotIn(str(self.home), json.dumps(row))
        log = next((self.root / 'logs').glob('backup-*.log')).read_text()
        self.assertRegex(log, r'PARTIAL \[replica\] memory.db: rc=124 elapsed_s=\d+\n')

    def test_dirty_wal_missing_unreadable_and_survivor_fail_before_restic(self):
        for mode in ('wal', 'missing', 'unreadable', 'survivor', 'error'):
            with self.subTest(mode=mode):
                (self.stage / 'memory.db').unlink(missing_ok=True)
                Path(str(self.stage / 'memory.db')+'-wal').unlink(missing_ok=True)
                self.database(self.stage / 'memory.db', 'episodic_events', 1)
                result, status = self.run_backup(mode)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(status['stage'], 'replica')
                self.assertEqual(status['partial_dbs'], [])
                self.assertFalse(self.rows('restic-calls'))
                self.assertFalse((self.home / 'mirrored').exists())

    def test_full_success_then_partial_then_recovery(self):
        result, status = self.run_backup('success')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(status['ok'])
        self.assertGreater(status['last_success_ts'], self.last_ok)
        self.assertEqual(status['last_snapshot'], 'abcdef12')
        self.assertEqual(status['partial_dbs'], [])
        calls = self.rows('restic-calls')
        self.assertIn('memory-live', calls[0])
        self.assertIn('memory-live', calls[1])
        self.assertIn('memory-partial', calls[2])
        self.assertNotIn('stale:memory.db', calls[0])
        result, partial = self.run_backup()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(partial['ok'])
        self.assertEqual(partial['last_success_ts'], status['last_success_ts'])
        result, status = self.run_backup('success')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(status['ok'])
        self.assertEqual(status['partial_dbs'], [])
        self.assertEqual(status['last_partial_snapshot'], partial['last_partial_snapshot'])
        self.assertEqual(status['last_partial_ts'], partial['last_partial_ts'])
        self.assertIsNone(status['failure_incident'])
        self.assertIn('recovered', self.rows('notices')[-1][-1])

    def test_partial_keeps_recovery_marker(self):
        marker = self.stage / '.catchup-needed'
        marker.write_text('{"memory.db":"partial"}')
        result, status = self.run_backup()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(status['last_partial_snapshot'], 'abcdef12')
        self.assertEqual(json.loads(marker.read_text()), {'memory.db': 'partial'})

    def test_later_failure_is_hard_failure_without_publishing_partial(self):
        result, status = self.run_backup(FAIL_RESTIC='1')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(status['stage'], 'restic')
        self.assertIsNone(status['last_partial_snapshot'])
        self.assertIsNone(status['last_partial_ts'])
        self.assertEqual(status['last_success_ts'], self.last_ok)
        self.assertFalse((self.home / 'mirrored').exists())
        self.assertFalse((self.root / 'data/backup-manifests').exists())


if __name__ == '__main__':
    unittest.main()
PY
python3 -I - <<'PY'
from pathlib import Path
p=Path('integrations/memory-system/tests/test_backup_replica.sh');s=p.read_text();s=s.replace("grep -q 'sqlite3_rsync timed out after 3 s' \"$R/logs/backup_last.json\"", "grep -q 'capped replica missing' \"$R/logs/backup_last.json\"")
s=s.replace("with open(current[0], 'rb') as f: assert contents == f.read()", "with open(current[0], 'rb') as f: published_manifest = json.load(f)\nassert len(published_manifest.pop('snapshot_id')) == 8\nassert json.loads(contents) == published_manifest")
s=s.replace("with open(os.path.join(published, os.path.basename(snapshots[0])), 'rb') as f: assert f.read() == contents", "with open(os.path.join(published, os.path.basename(snapshots[0])), 'rb') as f: published_manifest = json.load(f)\nassert len(published_manifest.pop('snapshot_id')) == 8\nassert json.loads(contents) == published_manifest")
s=s.replace('exit $FAIL', '# Cap, dirty WAL, survivor, full success, recovery and tool-log regressions.\n(cd "$HERE/tests" && "$PYTHON" -m unittest test_backup_partial) || FAIL=1\nexit $FAIL')
p.write_text(s)
PY
/Users/ardud/.local/share/memory-system/.venv/bin/python3 -m unittest discover -s integrations/memory-system/tests -p test_backup_partial.py
