"""Synthetic backup entrypoints: no credentials, real repos or network access."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import test_shell_jobs as shell_jobs

HERE, REPO, FAKE = shell_jobs.HERE, shell_jobs.REPO, shell_jobs.FAKE

sys.path.insert(0, str(HERE))
import jobs
import toollog


EXTRA = r'''
point=os.environ.get('FAIL_POINT','')
if name=='restic':
 with open(os.environ['RESTIC_CALLS'],'a') as f: f.write(json.dumps(args)+'\n')
 if 'snapshots' in args:
  assert '--no-lock' in args and '--tag' in args and '--host' in args
  assert not os.environ.get('RESTIC_PASSWORD_COMMAND')
  assert not os.environ.get('RESTIC_PASSWORD_FILE')
  assert sys.stdin.read()==''
  if point=='slow_probe': time.sleep(20)
  print(json.dumps([dict(time=os.environ['SNAPSHOT_TIME'],path='private-file-name')]))
  sys.exit(0)
 if point in ('password','repo_access','restic','timeout'):
  print('password command failed: private-password private-repo-path private-file-name' if point=='password' else 'private-repo-path private-file-name')
  sys.exit({'password':1,'repo_access':10,'restic':3,'timeout':124}[point])
 if point=='no_summary': print('private-file-name');sys.exit(0)
 if point=='check' and args[0]=='check': sys.exit(1)
if name=='python3' and args:
 script=Path(args[0]).name
 if args[0]=='-c' and 'unlink' in args[1] and point=='catchup': sys.exit(1)
 if script=='backup_control.py':
  if args[1]=='guard': os.execv(sys.executable,[sys.executable]+args)
  sys.exit({'admission_defer':10,'admission_error':1}.get(point,0))
 if script=='robob_readonly.py' and point=='source_missing':
  print(os.environ['FIXTURE_REPLICA']+'-missing');sys.exit(0)
 if script=='robob_readonly.py' and point=='real_source_missing':
  os.execv(sys.executable,[sys.executable]+args)
 if script=='robob_readonly.py' and point=='replica': sys.exit(1)
 if script=='robob_readonly.py' and '--generation' in args:
  counter=Path(os.environ['FIXTURE_TEMP']+'-generation')
  n=int(counter.read_text())+1 if counter.exists() else 1;counter.write_text(str(n))
  if point=='generation' or (point=='generation_after' and n==2): sys.exit(1)
  if point=='generation_changed': print(n);sys.exit(0)
 if script=='backup_replica.py': sys.exit(1 if point=='replica_step' else 0)
 if script=='snapshot_extra.py' and point=='snapshot': sys.exit(1)
 if script=='snapshot_extra.py' and point=='snapshot_empty': print('0');sys.exit(0)
 if script=='dropbox_mirror.py' and point=='dropbox': sys.exit(1)
 if script=='transcript_backup_manifest.py' and point=='manifest': sys.exit(1)
 if script=='transcript_backup_manifest.py' and point=='manifest_'+args[1]: sys.exit(1)
if name=='rsync' and point in ('files','source_missing'): sys.exit(1)
if name=='rsync':
 if point=='files_code' and any(a.endswith('/src') for a in args): sys.exit(1)
 if point=='files_muse' and args[-1].endswith('/muse-sessions/'): sys.exit(1)
 if point=='files_harness' and any('/transcripts/' in a for a in args): sys.exit(1)
if name=='sqlite3':
 if point=='health_snapshot' and any(a.startswith('.backup ') for a in args): sys.exit(1)
 if point=='health_journal' and any('journal_mode' in a for a in args): sys.exit(1)
 if point=='health_verify' and any('quick_check' in a for a in args): print('bad');sys.exit(0)
 if any('SELECT coalesce(max' in a for a in args):
  print('bad' if point=='hwm' else '0' if point=='behind' and '/stage/' in args[1] else '10');sys.exit(0)
 if any('sqlite_master' in a for a in args): print('0' if point=='verify' else '1');sys.exit(0)
 output=next((a for a in args if a.startswith('.output ')),None)
 if output and point=='dump_exit': sys.exit(1)
 if output and point=='dump_output': print('private-file-name');sys.exit(0)
 if output and point=='dump_empty': Path(output[len('.output '):].strip("'")).write_text('');sys.exit(0)
if name=='ps': print('health_backup.sh');sys.exit(0)
if name=='mkdir' and point=='lock_recovery' and args[-1].endswith('backup.lock'): sys.exit(1)
if name=='date' and args==['+%d']: print('01');sys.exit(0)
'''


class BackupSkipTests(unittest.TestCase):
    fixture = shell_jobs.ShellJobsTests.fixture
    rows = shell_jobs.ShellJobsTests.rows

    def setup_run(self, target, point=''):
        root, home, fake, logs, env = self.fixture()
        for name in ('python3', 'restic', 'rsync', 'df', 'stat', 'nice', 'bun', 'sqlite3', 'ps', 'mkdir', 'date'):
            text = FAKE.replace("if name=='python3':", EXTRA + "\nif name=='python3':", 1)
            if name == 'mkdir':
                text += "\nif name=='mkdir': os.execv('/bin/mkdir',['/bin/mkdir']+args)\n"
            if name == 'date':
                text += "\nif name=='date': os.execv('/bin/date',['/bin/date']+args)\n"
            (fake/name).write_text(text.replace('PYTHON', sys.executable))
            (fake/name).chmod(0o755)
        vault = home/'health-data/abdullah'
        vault.mkdir(parents=True)
        pets=home/'Documents/assistant/pets'
        pets.mkdir(parents=True)
        (pets/'pets.db').touch()
        stage = root/'stage'
        stage.mkdir()
        replica = root/'replica.sqlite'
        replica.touch()
        repo = root/'repo/live'
        repo.mkdir(parents=True)
        (repo/'config').touch()
        health = home/'.local/share/health-backup'
        (health/'restic').mkdir(parents=True)
        (health/'restic/config').touch()
        memory = home/'.local/share/memory-system'
        for directory in ('logs','data','src'):
            (memory/directory).mkdir(parents=True)
        for name in ('backup_control.py', 'run_limited.py', 'redact_lock.py', 'robob_readonly.py'):
            (memory/'src'/name).write_text((REPO/'integrations/memory-system/src'/name).read_text())
        calls = root/'restic-calls'
        env.update(HEALTH_VAULT=str(vault), MEMORY_BACKUP_STAGE=str(stage),
                   MEMORY_BACKUP_REPO_ROOT=str(repo.parent), FIXTURE_REPLICA=str(replica),
                   FAIL_POINT=point, RESTIC_CALLS=str(calls), MAC_LOG_RESTIC=str(fake/'restic'),
                   SNAPSHOT_TIME=dt.datetime.fromtimestamp(time.time()-3600, dt.timezone.utc).isoformat())
        env.pop('RESTIC_PASSWORD', None)
        env.pop('RESTIC_PASSWORD_FILE', None)
        script = REPO/('integrations/health-backup/health_backup.sh' if target=='health'
                       else 'integrations/memory-system/scripts/memory_backup.sh')
        text = script.read_text()
        for path in ('/opt/homebrew/bin/python3','/opt/homebrew/bin/rsync','/opt/homebrew/bin/restic',
                     '/opt/homebrew/opt/sqlite/bin/sqlite3'):
            text = text.replace(path,str(fake/Path(path).name))
        text = text.replace('$HOME/.bun/bin/bun', str(fake/'bun'))
        run = root/'run.sh'
        run.write_text(text)
        return root, home, logs, env, run, calls

    def execute(self, fixture, code):
        root, home, logs, env, run, calls = fixture
        result = subprocess.run(['/bin/bash',str(run)], env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode,code,result.stdout+result.stderr)
        rows = self.rows(logs)
        self.assertEqual(len(rows),1,rows)
        encoded = json.dumps(rows)
        for secret in ('private-password','private-repo-path','private-file-name',str(root),str(home)):
            self.assertNotIn(secret,encoded)
        return rows[0], calls.read_text() if calls.exists() else ''

    def test_full_success_and_restic_failures(self):
        for target in ('health','memory'):
            for point, reason, rc in [('',None,0), ('password','password_unavailable',1),
                                      ('repo_access','no_repo_access',10), ('restic','other',3),
                                      ('timeout','other',124), ('no_summary','other',0), ('dropbox',None,0)]:
                with self.subTest(target=target,point=point):
                    row, calls = self.execute(self.setup_run(target,point), 0 if not point else 1)
                    self.assertEqual(row['props']['resticExitCode'],rc)
                    self.assertIn('backup',calls)
                    self.assertEqual(row['props'].get('skipReason'),reason)
                    self.assertEqual(row['ok'],not point)
                    if reason:
                        self.assertEqual(row['error']['tag'],'backup.skipped_'+reason)
                    elif point:
                        self.assertEqual(row['error']['tag'],'backup.failed')
                    else:
                        self.assertLess(row['props']['snapshotAgeS'],5)

    def test_pre_restic_exits_keep_their_exit_codes(self):
        cases = [('health','vault','source_missing',1), ('health','snapshot','other',1),
                 ('health','files','other',1), ('health','lock_recovery','other',0),
                 ('memory','repo','no_repo_access',1), ('memory','source_missing','source_missing',1),
                 ('memory','replica','other',1), ('memory','manifest','other',1),
                 ('memory','files','other',1), ('memory','admission_defer','other',0),
                 ('memory','admission_error','other',1), ('memory','stage','other',1),
                 ('health','stage','other',1)]
        for target, point, reason, code in cases:
            with self.subTest(target=target,point=point):
                fixture = self.setup_run(target,point)
                root, home, logs, env, run, calls = fixture
                if point=='vault':
                    env['HEALTH_VAULT']=str(root/'absent')
                if point=='repo':
                    (root/'repo/live/config').unlink()
                if point=='stage':
                    if target=='memory':
                        env['MEMORY_BACKUP_STAGE']=str(root/'replica.sqlite'/'invalid')
                    else:
                        text=run.read_text().replace('STAGE="$ROOT/stage"','STAGE="$ROOT/restic/config/invalid"')
                        run.write_text(text)
                row, calls = self.execute(fixture,code)
                self.assertEqual(calls,'')
                self.assertNotIn('resticExitCode',row['props'])
                self.assertEqual(row['props']['skipReason'],reason)
                self.assertEqual(row['error']['tag'],'backup.skipped_'+reason)
                self.assertFalse(row['ok'])

    def test_health_init_failure_records_actual_restic_exit(self):
        for point, reason in [('password','password_unavailable'),('repo_access','no_repo_access')]:
            fixture=self.setup_run('health',point)
            (fixture[1]/'.local/share/health-backup/restic/config').unlink()
            row,calls=self.execute(fixture,1)
            self.assertIn('init',calls)
            self.assertEqual(row['props']['skipReason'],reason)
            self.assertIn('resticExitCode',row['props'])

    def test_required_source_missing_is_distinct_from_copy_failure(self):
        for target in ('health','memory'):
            fixture=self.setup_run(target,'snapshot' if target=='health' else 'files')
            root,home,logs,env,run,calls=fixture
            if target=='health': (home/'Documents/assistant/pets/pets.db').unlink()
            (home/('Documents/assistant/pets' if target=='health' else '.local/share/memory-system/data')).rmdir()
            row,calls=self.execute(fixture,1)
            self.assertEqual(row['props']['skipReason'],'source_missing')
            self.assertEqual(calls,'')
            self.assertNotIn('resticExitCode',row['props'])

    def test_missing_source_forms_from_real_helpers(self):
        # Resolver failure vs returned absent path; missing dir vs required DB.
        for target,point in [('memory','source_missing'),('memory','real_source_missing'),
                             ('health','snapshot')]:
            fixture=self.setup_run(target,point)
            root,home,logs,env,run,calls=fixture
            if target=='memory': env['ROBOB_READONLY_DB']=str(root/'absent-export.sqlite')
            else: (home/'Documents/assistant/pets/pets.db').unlink()
            row,calls=self.execute(fixture,1)
            self.assertEqual(row['props']['skipReason'],'source_missing')
            self.assertEqual(row['error']['tag'],'backup.skipped_source_missing')
            self.assertEqual(calls,'')

    def test_memory_redaction_wrapper_success_and_open_failure(self):
        for failure in (False,True):
            fixture=self.setup_run('memory')
            root,home,logs,env,run,calls=fixture
            env.pop('MEMORY_BACKUP_GUARDED')
            env.pop('RECALL_FENCED')
            if failure:
                (home/'.local/share/memory-system/logs/state/redaction.flock').mkdir(parents=True)
            row,calls=self.execute(fixture,1 if failure else 0)
            self.assertEqual(row['ok'],not failure)
            self.assertEqual(row['props'].get('skipReason'),'other' if failure else None)
            if failure:
                self.assertNotIn('resticExitCode',row['props'])
                self.assertEqual(calls,'')

    def test_remaining_preparation_and_post_snapshot_exit_paths(self):
        cases=[('memory',p) for p in ('disk','hwm','replica_step','behind','catchup','generation',
               'generation_after','generation_changed','dump_exit','dump_output','dump_empty','verify',
               'files_code','files_muse','files_harness','manifest_prepare','manifest_build',
               'manifest_verify','manifest_publish')]
        cases += [('health',p) for p in ('health_snapshot','health_journal','health_verify','snapshot_empty','check')]
        for target,point in cases:
            with self.subTest(target=target,point=point):
                fixture=self.setup_run(target,point)
                root,home,logs,env,run,calls=fixture
                memory=home/'.local/share/memory-system'
                if point in ('hwm','replica_step','behind'):
                    (memory/'data/memory.db').touch()
                if point=='disk': env['MEMORY_BACKUP_MIN_FREE_GB']='999999999'
                if point=='verify': (root/'stage/memory.db').touch()
                if point=='files_muse': (home/'.local/share/muse/sessions').mkdir(parents=True)
                if point=='files_harness': (home/'.robob/harness-homes/claude/projects').mkdir(parents=True)
                if point.startswith('health_'): (home/'health-data/abdullah/fixture.db').touch()
                row,calls=self.execute(fixture,1)
                self.assertFalse(row['ok'])
                after_snapshot=point in ('manifest_publish','check')
                self.assertEqual('resticExitCode' in row['props'],after_snapshot)
                self.assertEqual(row['props'].get('skipReason'),None if after_snapshot else 'other')
                self.assertEqual(row['error']['tag'],'backup.failed' if after_snapshot else 'backup.skipped_other')

    def test_memory_guard_legacy_holder_and_guard_error(self):
        for point in ('legacy','guard_error'):
            fixture=self.setup_run('memory')
            root,home,logs,env,run,calls=fixture
            env.pop('MEMORY_BACKUP_GUARDED')
            lock=home/'.local/share/memory-system/logs/backup.lock'
            if point=='guard_error':
                Path(str(lock)+'.flock').mkdir()
                row,calls=self.execute(fixture,1)
                self.assertEqual(row['props']['skipReason'],'other')
                self.assertNotIn('resticExitCode',row['props'])
            else:
                child=subprocess.Popen(['/bin/bash','-c','exec -a memory_backup.sh /bin/sleep 30'])
                try:
                    lock.mkdir()
                    (lock/'pid').write_text(str(child.pid))
                    row,calls=self.execute(fixture,0)
                    self.assertEqual(row['props']['lockPid'],child.pid)
                    self.assertTrue(row['ok'])
                    self.assertEqual(row['props']['skipReason'],'lock_held')
                    self.assertEqual(calls,'')
                    self.assertIsNone(child.poll())
                finally:
                    child.terminate()
                    child.wait()

    def test_fresh_and_stale_locks_do_not_run_restic_or_remove_lock(self):
        for target in ('health','memory'):
            for age in (60,7200,10800):
                with self.subTest(target=target,age=age):
                    fixture=self.setup_run(target)
                    root,home,logs,env,run,calls=fixture
                    lock=home/('.local/share/health-backup/backup.lock' if target=='health'
                               else '.local/share/memory-system/logs/backup.lock')
                    lock.mkdir()
                    (lock/'pid').write_text(str(os.getpid()))
                    os.utime(lock,(time.time()-age,time.time()-age))
                    if target=='memory':
                        env.pop('MEMORY_BACKUP_GUARDED')
                        with Path(str(lock)+'.flock').open('w') as fence:
                            fcntl.flock(fence,fcntl.LOCK_EX)
                            row,calls=self.execute(fixture,0)
                    else:
                        row,calls=self.execute(fixture,0)
                    self.assertTrue(lock.exists())
                    self.assertEqual(calls,'')
                    self.assertEqual(row['ok'],age<7200)
                    self.assertEqual(row['props']['skipReason'],'lock_held')
                    self.assertEqual(row['props']['lockPid'],os.getpid())
                    self.assertIsInstance(row['props']['lockAgeS'],int)
                    self.assertGreaterEqual(row['props']['lockAgeS'],age)
                    self.assertNotIn('resticExitCode',row['props'])
                    if age>=7200:
                        self.assertEqual(row['error']['tag'],'backup.skip_stale_lock')

    def test_snapshot_probe_is_bounded_and_uses_no_password_command(self):
        for target in ('health','memory'):
            for point in ('repo_access','slow_probe'):
                fixture=self.setup_run(target,point)
                root,home,logs,env,run,calls=fixture
                env['RESTIC_PASSWORD']='private-password'
                # Admission skips before restic, with optional repository metadata only.
                if target=='health': env['HEALTH_VAULT']=str(root/'absent')
                else:
                    (root/'repo/live/config').unlink()
                started=time.monotonic()
                row,calls=self.execute(fixture,1)
                self.assertLess(time.monotonic()-started,8)
                self.assertNotIn('resticExitCode',row['props'])
                self.assertIn('snapshots',calls)
                if point=='slow_probe': self.assertNotIn('snapshotAgeS',row['props'])
                else: self.assertAlmostEqual(row['props']['snapshotAgeS'],3600,delta=5)

    def test_fixed_reason_set_and_bad_metadata_never_leak(self):
        root,home,fake,logs,env=self.fixture()
        with patch.dict(os.environ,env,clear=True):
            for reason in sorted(toollog.SKIP_REASONS | {'private-file-name'}):
                jobs.backup_run('memory',time.time(),'',0,0,'private-password',reason,'private-repo-path')
            toollog.emit('backup','error','backup.run',props={'skipReason':'private-password',
                         'lockPid':'private-file-name','lockAgeS':'private-repo-path'})
        rows=self.rows(logs)
        for row in rows[:-1]:
            self.assertIn(row['props']['skipReason'],toollog.SKIP_REASONS)
            self.assertFalse(row['ok'])
        self.assertNotIn('private-',json.dumps(rows))

    def test_missing_logger_preserves_success_and_failure(self):
        for target in ('health','memory'):
            for point,code in (('',0),('restic',1)):
                fixture=self.setup_run(target,point)
                fixture[3]['MAC_LOG_HOME']=str(fixture[0]/'absent')
                result=subprocess.run(['/bin/bash',str(fixture[4])],env=fixture[3],capture_output=True,timeout=15)
                self.assertEqual(result.returncode,code,result.stderr)
                self.assertEqual(self.rows(fixture[2]),[])


if __name__=='__main__':
    unittest.main()
