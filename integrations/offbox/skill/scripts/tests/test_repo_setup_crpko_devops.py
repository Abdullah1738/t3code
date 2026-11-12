"""Exercise real recipes and runner preamble with filesystem-backed fake Linux tools."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import bases, identity, runs

TEMPLATES = runs.REPO_RECIPES_DIR.parent
KEY = 'crpko-devops'

FAKE = r'''
import hashlib, json, os, pathlib, shutil, sys
p = pathlib.Path
home = p(os.environ['HOME'])
state = json.loads((home/'state').read_text())
name = p(sys.argv[0]).name
args = sys.argv[1:]
def save(): (home/'state').write_text(json.dumps(state))
def binary(tool, version):
    state[tool] = version
    save()
    shutil.copy(home/'fake', home/'bin'/tool)
    (home/'bin'/tool).chmod(0o755)
def record():
    with (home/'calls').open('a') as f: f.write(name+' '+ ' '.join(args)+'\n')
if name in ('vector','aws','terraform','ruby'):
    version = state[name]
    if name == 'vector': print('vector '+version+' (linux)')
    if name == 'aws': print('aws-cli/'+version+' Python/3 Linux')
    if name == 'terraform': print(json.dumps({'terraform_version':version}))
    if name == 'ruby': print('ruby '+version)
elif name == 'uname': print(state.get('arch','x86_64'))
elif name == 'readlink': print(p(args[-1]).resolve())
elif name == 'dpkg-query':
    record()
    print('ruby3.3: '+args[-1])
elif name == 'curl':
    record()
    url = next(a for a in args if a.startswith('https:'))
    out = p(args[args.index('-o')+1])
    if url.endswith('SHA256SUMS'):
        archive = next(out.parent.glob('terraform_*.zip'))
        digest = '0'*64 if state.get('bad_sha') else hashlib.sha256(archive.read_bytes()).hexdigest()
        out.write_text(digest+'  '+archive.name+'\n')
    else: out.write_text('official archive fixture')
elif name == 'tar':
    record()
    dest=p(args[args.index('-C')+1])/('vector-'+state.get('arch','x86_64')+'-unknown-linux-gnu/bin')
    dest.mkdir(parents=True)
    (dest/'vector').write_text('downloaded-vector')
elif name == 'unzip':
    record()
    dest=p(args[args.index('-d')+1])
    if 'aws.zip' in args[1]:
        (dest/'aws').mkdir()
        (dest/'aws/install').write_text('aws installer')
        (dest/'aws/dist').mkdir()
        (dest/'aws/dist/aws').write_text('#!/bin/sh\necho aws-cli/2.99.0 Python/3 Linux\n')
        (dest/'aws/dist/aws').chmod(0o755)
    else: (dest/'terraform').write_text('downloaded-terraform')
elif name == 'sudo':
    record()
    if args[0] == 'install':
        tool=p(args[-1]).name
        if state.get('broken_tool') != tool:
            binary(tool, '0.50.0' if tool == 'vector' else state.get('pin','1.16.1'))
    elif args[0] == './aws/install':
        assert args[1:] == ['--update','--bin-dir',str(home/'bin')], args
        if not state.get('aws_cached') and state.get('broken_tool') != 'aws':
            release=home/'aws-cli/v2/2.99.0'
            (release/'dist').mkdir(parents=True,exist_ok=True)
            shutil.copy(p.cwd()/'aws/dist/aws',release/'dist/aws')
    elif args[0] == 'mkdir':
        p(args[-1]).mkdir(parents=True,exist_ok=True)
    elif args[0] == 'cp':
        shutil.copytree(args[-2],args[-1],dirs_exist_ok=True)
    elif args[0] == 'ln':
        if state.get('broken_tool') != 'aws':
            dest=p(args[-1])
            dest.unlink(missing_ok=True)
            dest.symlink_to(args[-2])
            if dest == home/'bin/aws' and dest.exists():
                state['aws']='2.99.0'
                save()
    elif args[0] == 'apt-get':
        assert args[1:4] == ['install','-y','-qq'], args
        if args[-1] == 'ruby' and state.get('ruby_target_missing'):
            (home/'bin/ruby').unlink(missing_ok=True)
            (home/'bin/ruby').symlink_to(home/'bin/ruby3.3')
        elif args[-1] in ('ruby','ruby3.3') and (not state.get('ruby_cached') or '--reinstall' in args): binary('ruby','3.3.0')
        if args[-1] == 'unzip': binary('unzip','installed')
    else: raise Exception(args)
else: raise Exception(name)
'''


class CrpkoSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home/'bin'
        self.bin.mkdir()
        self.root = self.home/'w/repo'
        self.workflow = self.root/'.github/workflows/terraform-dev.yml'
        self.workflow.parent.mkdir(parents=True)
        self.pin('1.16.1')
        self.fake = self.home/'fake'
        self.fake.write_text('#!'+sys.executable+'\n'+FAKE)
        self.fake.chmod(0o755)
        self.state = dict(vector='0.50.0', aws='2.99.0', terraform='1.16.1', ruby='3.3.0')
        for tool in ('curl','sudo','tar','unzip','uname','readlink','dpkg-query',*self.state):
            shutil.copy(self.fake, self.bin/tool)
        (self.bin/'python3').symlink_to(sys.executable)
        flock = self.bin/'flock'
        flock.write_text('#!'+sys.executable+'\nimport fcntl,sys\nfcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX)\n')
        flock.chmod(0o755)
        self.recipes = self.home/'templates/repos'
        self.recipes.mkdir(parents=True)
        (self.recipes.parent/'tools').mkdir()
        for source in (TEMPLATES/'tools/crpko.sh', TEMPLATES/'repos/crpko-devops.sh'):
            target = self.recipes.parent/source.relative_to(TEMPLATES)
            # Keep all fake installs in a temporary tree, including the absolute Ruby check.
            target.write_text(source.read_text().replace('/usr/bin/ruby',str(self.bin/'ruby'))
                              .replace('/usr/local/bin',str(self.bin))
                              .replace('/usr/local/aws-cli',str(self.home/'aws-cli')))
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin',
                        OFFBOX_REPO_ROOT=str(self.root))
        self.env.pop('BASH_ENV',None)

    def pin(self, version):
        self.workflow.write_text('steps:\n  - uses: hashicorp/setup-terraform@v3\n    with:\n'
                                 f'      terraform_version: "{version}"\n')

    def run_setup(self, node='', command='echo USER_COMMAND; command -v terraform aws ruby vector'):
        (self.home/'state').write_text(json.dumps(self.state))
        with patch.object(runs,'REPO_RECIPES_DIR',self.recipes), \
             patch.object(runs,'DOCKER_REPAIR',':'), patch.object(runs,'LDCACHE_REPAIR',':'), \
             patch.object(runs,'GO_REPAIR',':'):
            script = runs.remote_script('w/repo','.',[command],None,'run-test',repo_key=KEY,node=node)
        result = subprocess.run(['bash','-c',script],env=self.env,capture_output=True,text=True,timeout=15)
        self.state = json.loads((self.home/'state').read_text())
        return result

    def calls(self):
        path = self.home/'calls'
        return path.read_text() if path.exists() else ''

    def missing(self, tool):
        (self.bin/tool).unlink(missing_ok=True)
        self.state.pop(tool,None)

    def assert_ok(self, result):
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('USER_COMMAND',result.stdout)

    def test_ready_tools_and_second_run_install_nothing(self):
        self.assert_ok(self.run_setup())
        result = self.run_setup()
        self.assert_ok(result)
        self.assertNotIn('setting up', result.stderr)
        self.assertEqual(self.calls(),'')

    def test_missing_and_wrong_versions_install_then_skip(self):
        for tool, versions in [('vector',(None,'0.49.0')),('aws',(None,'1.45.0')),
                               ('terraform',(None,'1.15.0')),('ruby',(None,))]:
            for version in versions:
                with self.subTest(tool=tool,version=version):
                    if version is None: self.missing(tool)
                    else:
                        self.state[tool] = version
                        if tool == 'aws':
                            (self.bin/tool).unlink()
                            shutil.copy(self.fake,self.bin/tool)
                    previous=self.calls()
                    self.assert_ok(self.run_setup())
                    calls=self.calls()[len(previous):]
                    expected = {'vector':'install -m 0755','terraform':'install -m 0755',
                                'aws':'./aws/install --update','ruby':'apt-get install -y -qq ruby'}[tool]
                    self.assertIn(expected,calls)
                    previous=self.calls()
                    self.assert_ok(self.run_setup())
                    self.assertEqual(previous,self.calls())

    def test_architecture_selects_official_archives(self):
        for arch, tf in [('x86_64','amd64'),('aarch64','arm64')]:
            with self.subTest(arch=arch):
                self.state['arch']=arch
                for tool in ('vector','aws','terraform'): self.missing(tool)
                before=self.calls()
                self.assert_ok(self.run_setup())
                calls=self.calls()[len(before):]
                self.assertIn('vector-0.50.0-'+arch+'-unknown-linux-gnu.tar.gz',calls)
                self.assertIn('awscli-exe-linux-'+arch+'.zip',calls)
                self.assertIn('terraform_1.16.1_linux_'+tf+'.zip',calls)

    def test_unsupported_arch_fails_before_download(self):
        self.state['arch']='riscv64'
        self.missing('aws')
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertNotIn('curl ',self.calls())
        self.assertNotIn('USER_COMMAND',result.stdout)

    def test_missing_unzip_is_installed(self):
        self.env['PATH']=str(self.bin)
        for tool in ('bash','cat','mkdir','mv','rm','mktemp'):
            (self.bin/tool).symlink_to(shutil.which(tool))
        self.missing('unzip')
        self.missing('aws')
        self.assert_ok(self.run_setup())
        self.assertIn('apt-get install -y -qq unzip',self.calls())

    def test_sha_mismatch_stops_before_terraform_install(self):
        self.missing('terraform')
        self.state['bad_sha']=True
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('terraform SHA256 mismatch',result.stderr)
        self.assertNotIn('sudo install',self.calls())
        self.assertFalse((self.bin/'terraform').exists())
        self.assertNotIn('USER_COMMAND',result.stdout)

    def test_workflow_pin_change_invalidates_ready_stamp(self):
        self.assert_ok(self.run_setup())
        self.pin('1.17.2')
        self.state['pin']='1.17.2'
        self.assert_ok(self.run_setup())
        self.assertEqual(self.state['terraform'],'1.17.2')
        self.assertIn('terraform_1.17.2_linux_amd64.zip',self.calls())

    def test_ci_pin_forms_and_conflicts(self):
        for value in ['1.16.1',"'1.16.1'",'"1.16.1" # current']:
            with self.subTest(value=value):
                self.workflow.write_text('  terraform_version: '+value+'\n')
                self.assert_ok(self.run_setup())
        for value in ['', 'terraform_version: latest\n', 'terraform_version: '+chr(34)+'1.16.1'+chr(39)+'\n',
                      'terraform_version: 1.16.1\nterraform_version: 1.17.0\n']:
            with self.subTest(value=value):
                self.workflow.write_text(value)
                result=self.run_setup()
                self.assertEqual(result.returncode,98,result.stderr)
                self.assertIn('unambiguous literal CI pin',result.stderr)
                self.assertNotIn('USER_COMMAND',result.stdout)

    def test_broken_installer_names_missing_tool(self):
        self.missing('aws')
        self.state['broken_tool']='aws'
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('required tool missing on command PATH: aws',result.stderr)
        self.assertNotIn('USER_COMMAND',result.stdout)

    def test_final_user_path_is_checked_after_node_selection(self):
        for tool in ('terraform','aws','ruby','vector'):
            with self.subTest(tool=tool):
                result=self.run_setup(node=f'rm -f "{self.bin}/{tool}"; export PATH="{self.bin}"')
                self.assertEqual(result.returncode,98,result.stderr)
                self.assertIn('required tool missing on command PATH: '+tool,result.stderr)
                self.assertNotIn('USER_COMMAND',result.stdout)

    def test_cached_aws_repairs_every_link_and_missing_payload(self):
        self.state['aws_cached']=True
        release=self.home/'aws-cli/v2/2.99.0'
        for missing in ('global','v1-command','current','version-command','bin-directory','payload'):
            with self.subTest(missing=missing):
                # Model the installer's early return with a real cached release and link chain.
                (release/'dist').mkdir(parents=True,exist_ok=True)
                (release/'bin').mkdir(parents=True,exist_ok=True)
                payload=release/'dist/aws'
                payload.write_text('#!/bin/sh\necho aws-cli/2.99.0 Python/3 Linux\n')
                payload.chmod(0o755)
                for link,target in [(release/'bin/aws','../dist/aws'),
                                    (release.parent/'current',str(release)),
                                    (self.bin/'aws',str(release.parent/'current/bin/aws'))]:
                    link.unlink(missing_ok=True)
                    link.symlink_to(target)
                if missing in ('global','v1-command'):
                    (self.bin/'aws').unlink()
                    if missing == 'v1-command':
                        shutil.copy(self.fake,self.bin/'aws')
                        self.state['aws']='1.45.0'
                elif missing == 'current': (release.parent/'current').unlink()
                elif missing == 'version-command': (release/'bin/aws').unlink()
                elif missing == 'bin-directory': shutil.rmtree(release/'bin')
                else: payload.unlink()
                self.assert_ok(self.run_setup())
                self.assertEqual((self.bin/'aws').resolve(),payload.resolve())
                version=subprocess.check_output([str(self.bin/'aws'),'--version'],env=self.env,text=True)
                self.assertIn('aws-cli/2.99.0',version)

    def test_cached_ruby_package_reinstalls_missing_file(self):
        self.state['ruby_cached']=True
        self.missing('ruby')
        self.assert_ok(self.run_setup())
        self.assertIn('apt-get install -y -qq --reinstall ruby',self.calls())

    def test_broken_ruby_symlink_reinstalls_target_owner(self):
        self.state['ruby_target_missing']=True
        self.missing('ruby')
        (self.bin/'ruby').symlink_to(self.bin/'ruby3.3')
        self.assert_ok(self.run_setup())
        self.assertIn('dpkg-query -S '+str((self.bin/'ruby3.3').resolve()),self.calls())
        self.assertIn('apt-get install -y -qq --reinstall ruby3.3',self.calls())

    def test_ruby_absolute_path_is_checked_even_with_another_on_path(self):
        shared=self.recipes.parent/'tools/crpko.sh'
        shared.write_text(shared.read_text().replace(str(self.bin/'ruby'),str(self.home/'absent/ruby')))
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('apt-get install -y -qq ruby',self.calls())
        self.assertNotIn('USER_COMMAND',result.stdout)

    def test_template_and_runtime_share_tool_pins(self):
        with patch.object(bases,'TEMPLATES_DIR',TEMPLATES):
            body,_=bases.recipe('crpko-go')
        self.assertIn((TEMPLATES/'tools/crpko.sh').read_text(),body)
        self.assertEqual(body.count('OFFBOX_VECTOR_VERSION=0.50.0'),1)
        self.assertIn('offbox_crpko_tools\n',body)


class RepoKeyTests(unittest.TestCase):
    def test_origin_defines_key_for_main_ovnfs_and_tmp_clones(self):
        urls=['https://github.com/Equicom-Crypto/crpko-devops.git',
              'git@github.com:Equicom-Crypto/crpko-devops.git',
              'ssh://git@github.com/Equicom-Crypto/crpko-devops.git',
              '/Volumes/ExternalSSD/crpko-devops']
        roots=['/Volumes/ExternalSSD/crpko-devops','/Users/ardud/checkouts/carry-1055',
               '/tmp/carry-1055-test-source']
        for root in roots:
            for url in urls:
                with self.subTest(root=root,url=url), patch.object(identity.subprocess,'run',
                       return_value=subprocess.CompletedProcess([],0,stdout=url+'\n')):
                    self.assertEqual(identity.repo_key(Path(root)),KEY)
