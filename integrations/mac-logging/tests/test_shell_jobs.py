"""Run real shell control flow with fixture executables, never real backups/deletes."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE=Path(__file__).resolve().parents[1]
REPO=HERE.parents[1]
FAKE = r'''#!PYTHON
import json,os,sys,time
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
if name=='python3':
 if args and args[0].endswith('snapshot_extra.py'): print('1')
 elif args and args[0].endswith('dropbox_mirror.py'): print('{"files":1}')
 elif args and args[0].endswith('robob_readonly.py'): print('fixture-generation' if '--generation' in args else os.environ['FIXTURE_REPLICA'])
 elif args and args[0].endswith('backup_control.py'): pass
 elif args and args[0].endswith('run_limited.py'): os.execvp(args[args.index('--')+1],args[args.index('--')+1:])
 elif args and args[0].endswith('transcript_backup_manifest.py'): print('/fixture/manifest')
 else: os.execv(sys.executable,[sys.executable]+args)
elif name=='restic':
 if args[0]=='backup':
  print(json.dumps(dict(message_type='summary',snapshot_id='1234abcd',total_bytes_processed=2048,total_files_processed=5),separators=(',',':')))
  sys.exit(int(os.environ.get('RESTIC_TEST_RC','0')))
elif name=='df': print('Filesystem Blocks Used Available\nfixture 1000000000 1 800000000')
elif name=='stat': print(int(time.time()))
elif name=='getconf': print(os.environ['FIXTURE_TEMP'])
elif name=='nice': os.execvp(args[2],args[2:])
elif name=='bun': sys.exit(int(os.environ.get('NOTIFY_TEST_RC','0')))
elif name=='sqlite3':
 output=next((a for a in args if a.startswith('.output ')),None)
 if output:
  Path(output[len('.output '):].strip("'")).write_text('CREATE TABLE scheduled_tasks (id text);\n')
 else: print('ok')
'''


class ShellJobsTests(unittest.TestCase):
 def fixture(self,home_name='home'):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
  root=Path(temp.name);home=root/home_name;home.mkdir();fake=root/'bin';fake.mkdir()
  for name in ['python3','restic','rsync','df','stat','getconf','nice','bun','rm','sqlite3']:
   p=fake/name;p.write_text(FAKE.replace('PYTHON',sys.executable));p.chmod(0o755)
  logs=root/'logs'
  env={**os.environ,'HOME':str(home),'PATH':str(fake)+':'+os.environ['PATH'],'MAC_LOG_HOME':str(HERE),
       'MAC_LOG_PYTHON':sys.executable,'TOOLLOG_DIR':str(logs),'FIXTURE_TEMP':str(root/'temp'),'MEMORY_BACKUP_GUARDED':'1','RECALL_FENCED':'1'}
  env.pop('BASH_ENV',None)
  env.pop('ENV',None)
  return root,home,fake,logs,env

 def rows(self,logs):
  return [json.loads(line) for p in logs.glob('*.ndjson') for line in p.read_text().splitlines()]

 def job_installer_fixture(self,home_name='home'):
  root,home,fake,logs,env=self.fixture(home_name)
  git=fake/'git'
  git.write_text('#!'+sys.executable+'\nimport sys\na=sys.argv[1:]\nif "rev-parse" in a: print('+repr(str(REPO))+')\nelif "ls-remote" in a: print("fixture refs/heads/main")\nelif "status" in a and any(p.startswith("integrations/memory-system/") for p in a): print(" M integrations/memory-system/src/backup_control.py")\n')
  git.chmod(0o755)
  io_log=root/'installer-io.jsonl'
  env['INSTALL_IO_LOG']=str(io_log)
  for name in ('cmp','cp','install','mkdir'):
   executable=shutil.which(name)
   self.assertIsNotNone(executable)
   wrapper=fake/name
   wrapper.write_text('#!'+sys.executable+'''\nimport json,os,sys
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['INSTALL_IO_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
memory=Path.home()/'.local/share/memory-system'
if any(Path(os.path.abspath(arg)).is_relative_to(memory) for arg in args):
 sys.exit('unexpected memory-system access')
os.execv('''+repr(executable)+''',['''+repr(executable)+''']+args)
''')
   wrapper.chmod(0o755)
  return root,home,env,io_log

 def test_health_and_memory_full_success_and_restic_failure(self):
  for target in ('health','memory'):
   for code in ('0','3'):
    with self.subTest(target=target,exit=code):
     root,home,fake,logs,env=self.fixture()
     vault=home/'health-data/abdullah';vault.mkdir(parents=True)
     stage=root/'stage';stage.mkdir()
     replica=root/'replica.sqlite';replica.touch();env['FIXTURE_REPLICA']=str(replica)
     repo=root/'repo/live';repo.mkdir(parents=True);(repo/'config').touch()
     healthrepo=home/'.local/share/health-backup/restic';healthrepo.mkdir(parents=True);(healthrepo/'config').touch()
     env.update(HEALTH_VAULT=str(vault),MEMORY_BACKUP_STAGE=str(stage),MEMORY_BACKUP_REPO_ROOT=str(repo.parent),
                ROBOB_STATE_REPLICA=str(root/'absent-replica'),ROBOB_STATE_DB=str(root/'absent-db'),RESTIC_TEST_RC=code)
     src=REPO/('integrations/health-backup/health_backup.sh' if target=='health' else 'integrations/memory-system/scripts/memory_backup.sh')
     text=src.read_text()
     for path in ['/opt/homebrew/bin/python3','/opt/homebrew/bin/rsync','/opt/homebrew/bin/restic','/opt/homebrew/opt/sqlite/bin/sqlite3']:
      text=text.replace(path,str(fake/Path(path).name))
     text=text.replace('$HOME/.bun/bin/bun',str(fake/'bun'))
     script=root/'run.sh';script.write_text(text)
     result=subprocess.run(['/bin/bash',str(script)],env=env,capture_output=True,text=True,timeout=20)
     self.assertEqual(result.returncode,0 if code=='0' else 1,result.stderr+result.stdout+"\n"+"\n".join(p.read_text() for p in home.rglob("backup-*.log")))
     row=self.rows(logs)[-1]
     self.assertEqual(row['name'],'backup.run')
     self.assertEqual(row['ok'],code=='0')
     self.assertEqual(row['props']['target'],target)
     self.assertEqual(row['props']['resticExitCode'],int(code))
     self.assertEqual(row['props']['bytes'],2048)
     self.assertEqual(row['props']['files'],5)

 @unittest.skipUnless(shutil.which('zsh'),'disk guard uses zsh')
 def test_disk_real_entrypoint_and_alert_delivery(self):
  for code in ('0','1'):
   root,home,fake,logs,env=self.fixture()
   watch=root/'watch';watch.mkdir();(watch/'tmp_kb').write_text('1')
   # Suppress the existing detached du worker; this test targets the foreground guard.
   env.update(WATCH_DIR=str(watch),FREE_MIN_GB='900',NOTIFY_TEST_RC=code)
   text=(REPO/'integrations/robob-watch/watchers/disk-space-guard/check.sh').read_text()
   for path in ['/bin/df','/usr/bin/getconf','/usr/bin/stat','/Users/ardud/.bun/bin/bun']:
    text=text.replace(path,str(fake/Path(path).name))
   script=root/'run.zsh';script.write_text(text)
   result=subprocess.run(['zsh',str(script)],env=env,capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,int(code),result.stderr)
   names=[r['name'] for r in self.rows(logs)]
   self.assertIn('disk.sample',names)
   self.assertIn('disk.alert',names)
   self.assertEqual(self.rows(logs)[-1]['ok'],code=='0')

 @unittest.skipUnless(shutil.which('zsh'),'installer uses zsh')
 def test_installer_check_verifies_rendered_plist_and_modes(self):
  for home_name in ('home','home with spaces'):
   with self.subTest(home=home_name):
    root,home,fake,logs,env=self.fixture(home_name)
    git=fake/'git'
    git.write_text('#!'+sys.executable+'\nimport sys\na=sys.argv[1:]\nif "rev-parse" in a: print('+repr(str(REPO))+')\nelif "ls-remote" in a: print("fixture refs/heads/main")\n')
    git.chmod(0o755)
    command=['zsh',str(HERE/'install.zsh')]
    dry_run=subprocess.run(command+['--dry-run'],env=env,capture_output=True,text=True,timeout=10)
    self.assertEqual(dry_run.returncode,0,dry_run.stderr)
    self.assertFalse((home/'.local').exists())
    self.assertFalse((home/'Library/LaunchAgents/com.abdullah.mac-log-collector.plist').exists())
    installed=subprocess.run(command,env=env,capture_output=True,text=True,timeout=10)
    self.assertEqual(installed.returncode,0,installed.stderr)
    plist=home/'Library/LaunchAgents/com.abdullah.mac-log-collector.plist'
    original=plist.read_text()
    rendered=plistlib.loads(original.encode())
    collector=home/'.local/lib/mac-logging/collector.py'
    arguments=['/bin/zsh','-c',f'exec /usr/bin/python3 "{collector}"']
    self.assertEqual(rendered,dict(Label='com.abdullah.mac-log-collector',ProgramArguments=arguments,
                                   StartInterval=3600,RunAtLoad=True,ProcessType='Background'))
    self.assertNotIn('__HOME__',original)
    def check():
     return subprocess.run(command+['--check'],env=env,capture_output=True,text=True,timeout=10).returncode
    self.assertEqual(check(),0)
    plist.chmod(0o644);self.assertNotEqual(check(),0);plist.chmod(0o600)
    plist.write_text('stale');self.assertNotEqual(check(),0);plist.write_text(original)
    plist.rename(plist.with_suffix('.saved'));self.assertNotEqual(check(),0)
    collector.write_text('import sys\nprint(sys.argv[0])\n')
    launched=subprocess.run(rendered['ProgramArguments'],env=env,capture_output=True,text=True,timeout=10)
    self.assertEqual(launched.returncode,0,launched.stderr)
    self.assertEqual(launched.stdout.strip(),str(collector))

 @unittest.skipUnless(shutil.which('zsh'),'installers use zsh')
 def test_each_job_installer_rejects_missing_executable_permissions(self):
  root,home,fake,logs,env=self.fixture()
  git=fake/'git'
  git.write_text('#!'+sys.executable+'\nimport sys\na=sys.argv[1:]\nif "rev-parse" in a: print('+repr(str(REPO))+')\nelif "ls-remote" in a: print("fixture refs/heads/main")\n')
  git.chmod(0o755)
  cases=[
   (REPO/'integrations/cve-sweep/install.zsh',['.local/bin/cve-sweep']),
   (REPO/'integrations/health-backup/install.zsh',['health-data/abdullah/backup/health_backup.sh','health-data/abdullah/backup/snapshot_extra.py']),
   (HERE/'install-jobs.zsh',['.local/share/robob-watch/watchers/disk-space-guard/check.sh',
     '.config/opencode/skills/dev-resource-janitor/scripts/dev_janitor.py',
     '.config/opencode/skills/dev-resource-janitor/scripts/janitor_watch.py'])]
  for installer,files in cases:
   command=['zsh',str(installer)]
   result=subprocess.run(command,env=env,capture_output=True,text=True,timeout=15)
   self.assertEqual(result.returncode,0,result.stderr)
   def check():
    return subprocess.run(command+['--check'],env=env,capture_output=True,text=True,timeout=15).returncode
   self.assertEqual(check(),0)
   for relative in files:
    with self.subTest(installer=str(installer),file=relative):
     path=home/relative
     self.assertEqual(path.stat().st_mode & 0o777,0o755)
     path.chmod(0o644);self.assertNotEqual(check(),0)
     path.chmod(0o755);self.assertEqual(check(),0)

 @unittest.skipUnless(shutil.which('zsh'),'installer uses zsh')
 def test_job_installer_leaves_memory_system_untouched_in_every_mode(self):
  for home_name in ('home','home with spaces'):
   for existing in (False,True):
    with self.subTest(home=home_name,existing=existing):
     root,home,env,io_log=self.job_installer_fixture(home_name)
     memory=home/'.local/share/memory-system'
     sentinels={}
     if existing:
      for name in ('scripts/memory_backup.sh','src/backup_control.py','src/redact_lock.py'):
       path=memory/name;path.parent.mkdir(parents=True,exist_ok=True)
       path.write_text('Recall owns this file\n');path.chmod(0o600)
       sentinels[name]=(path.read_bytes(),path.stat().st_mode,path.stat().st_mtime_ns)
     command=['zsh',str(HERE/'install-jobs.zsh')]
     # Reinstall as well, so backup copies are covered by the access trap.
     for args in (['--dry-run'],[],[],['--check']):
      result=subprocess.run(command+args,env=env,capture_output=True,text=True,timeout=15)
      self.assertEqual(result.returncode,0,result.stderr)
      self.assertNotIn(str(memory),result.stdout+result.stderr)
      if args == ['--dry-run']:
       self.assertFalse((home/'.config').exists())
       self.assertFalse(io_log.exists())
      self.assertEqual(memory.exists(),existing)
      if existing:
       self.assertEqual({str(p.relative_to(memory)):(p.read_bytes(),p.stat().st_mode,p.stat().st_mtime_ns)
                         for p in memory.rglob('*') if p.is_file()},sentinels)
     calls=[json.loads(line) for line in io_log.read_text().splitlines()]
     self.assertTrue(calls)
     self.assertFalse(any(str(memory) in arg for args in calls for arg in args))
     for relative in ('.local/share/robob-watch/watchers/disk-space-guard/check.sh',
                      '.config/opencode/skills/dev-resource-janitor/scripts/dev_janitor.py',
                      '.config/opencode/skills/dev-resource-janitor/scripts/janitor_watch.py'):
      self.assertEqual((home/relative).stat().st_mode & 0o777,0o755)

 @unittest.skipUnless(shutil.which('zsh'),'installer uses zsh')
 def test_job_installer_refuses_memory_system_targets_in_every_mode(self):
  for home_name in ('home','home with spaces'):
   root,home,env,io_log=self.job_installer_fixture(home_name)
   (root/'pushed.zsh').write_text((HERE/'pushed.zsh').read_text())
   script=root/'install-jobs.zsh'
   original=(HERE/'install-jobs.zsh').read_text()
   for suffix in ('','/','/.','/scripts/memory_backup.sh','/src/backup_control.py','/src/redact_lock.py'):
    target='$HOME/.local/share/memory-system'+suffix
    pair='  "integrations/robob-watch/watchers/disk-space-guard/check.sh:'+target+'" \\\n'
    script.write_text(original.replace('for pair in \\\n','for pair in \\\n'+pair,1))
    for args in ([],['--dry-run'],['--check']):
     with self.subTest(home=home_name,target=target,args=args):
      result=subprocess.run(['zsh',str(script)]+args,env=env,capture_output=True,text=True,timeout=15)
      self.assertEqual(result.returncode,2,result.stderr)
      self.assertIn('refusing memory-system target',result.stderr)
      self.assertEqual(result.stdout,'')
      self.assertFalse(io_log.exists())
      self.assertFalse((home/'.local').exists())

 def test_shell_bridge_is_silent_even_if_helper_missing(self):
  root,home,fake,logs,env=self.fixture()
  env['MAC_LOG_HOME']=str(root/'missing')
  result=subprocess.run(['/bin/bash','-c','. "$1"; mac_log backup health; echo still-running','test',str(HERE/'toollog.sh')],env=env,capture_output=True,text=True)
  self.assertEqual((result.returncode,result.stdout,result.stderr),(0,'still-running\n',''))


if __name__=='__main__': unittest.main()
