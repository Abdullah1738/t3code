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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import bases, identity, runs
from test_capacity import Isolated

TEMPLATES = runs.REPO_RECIPES_DIR.parent
KEY = 'crpko-devops'

REAL_DEV_LOCK = '''# This file is maintained automatically by "terraform init".
# Manual edits may be lost in future updates.

provider "registry.terraform.io/hashicorp/archive" {
  version     = "2.7.1"
  constraints = ">= 2.4.0, ~> 2.4, < 3.0.0"
  hashes = [
    "h1:62VrkalDPMKB9zerCBS4iKTbvxejwnAWn/XXYZZQWD4=",
    "h1:A7EnRBVm4h9ryO9LwxYnKr4fy7ExPMwD5a1DsY7m1Y0=",
    "zh:19881bb356a4a656a865f48aee70c0b8a03c35951b7799b6113883f67f196e8e",
    "zh:2fcfbf6318dd514863268b09bbe19bfc958339c636bcbcc3664b45f2b8bf5cc6",
    "zh:3323ab9a504ce0a115c28e64d0739369fe85151291a2ce480d51ccbb0c381ac5",
    "zh:362674746fb3da3ab9bd4e70c75a3cdd9801a6cf258991102e2c46669cf68e19",
    "zh:7140a46d748fdd12212161445c46bbbf30a3f4586c6ac97dd497f0c2565fe949",
    "zh:78d5eefdd9e494defcb3c68d282b8f96630502cac21d1ea161f53cfe9bb483b3",
    "zh:875e6ce78b10f73b1efc849bfcc7af3a28c83a52f878f503bb22776f71d79521",
    "zh:b872c6ed24e38428d817ebfb214da69ea7eefc2c38e5a774db2ccd58e54d3a22",
    "zh:cd6a44f731c1633ae5d37662af86e7b01ae4c96eb8b04144255824c3f350392d",
    "zh:e0600f5e8da12710b0c52d6df0ba147a5486427c1a2cc78f31eea37a47ee1b07",
    "zh:f21b2e2563bbb1e44e73557bcd6cdbc1ceb369d471049c40eb56cb84b6317a60",
    "zh:f752829eba1cc04a479cf7ae7271526b402e206d5bcf1fcce9f535de5ff9e4e6",
  ]
}

provider "registry.terraform.io/hashicorp/aws" {
  version     = "5.100.0"
  constraints = ">= 5.0.0, ~> 5.0, ~> 5.100, < 6.0.0"
  hashes = [
    "h1:Ijt7pOlB7Tr7maGQIqtsLFbl7pSMIj06TVdkoSBcYOw=",
    "h1:edXOJWE4ORX8Fm+dpVpICzMZJat4AX0VRCAy/xkcOc0=",
    "zh:054b8dd49f0549c9a7cc27d159e45327b7b65cf404da5e5a20da154b90b8a644",
    "zh:0b97bf8d5e03d15d83cc40b0530a1f84b459354939ba6f135a0086c20ebbe6b2",
    "zh:1589a2266af699cbd5d80737a0fe02e54ec9cf2ca54e7e00ac51c7359056f274",
    "zh:6330766f1d85f01ae6ea90d1b214b8b74cc8c1badc4696b165b36ddd4cc15f7b",
    "zh:7c8c2e30d8e55291b86fcb64bdf6c25489d538688545eb48fd74ad622e5d3862",
    "zh:99b1003bd9bd32ee323544da897148f46a527f622dc3971af63ea3e251596342",
    "zh:9b12af85486a96aedd8d7984b0ff811a4b42e3d88dad1a3fb4c0b580d04fa425",
    "zh:9f8b909d3ec50ade83c8062290378b1ec553edef6a447c56dadc01a99f4eaa93",
    "zh:aaef921ff9aabaf8b1869a86d692ebd24fbd4e12c21205034bb679b9caf883a2",
    "zh:ac882313207aba00dd5a76dbd572a0ddc818bb9cbf5c9d61b28fe30efaec951e",
    "zh:bb64e8aff37becab373a1a0cc1080990785304141af42ed6aa3dd4913b000421",
    "zh:dfe495f6621df5540d9c92ad40b8067376350b005c637ea6efac5dc15028add4",
    "zh:f0ddf0eaf052766cfe09dea8200a946519f653c384ab4336e2a4a64fdd6310e9",
    "zh:f1b7e684f4c7ae1eed272b6de7d2049bb87a0275cb04dbb7cda6636f600699c9",
    "zh:ff461571e3f233699bf690db319dfe46aec75e58726636a0d97dd9ac6e32fb70",
  ]
}

provider "registry.terraform.io/hashicorp/external" {
  version     = "2.4.2"
  constraints = ">= 2.3.0, < 3.0.0"
  hashes = [
    "h1:4UInMFuK4GNw4uf2vkUwwDtc0CajvJ88BkAE6xLKOa4=",
    "h1:QP724n6VWM/iitpILCwO079UOlzx6I0Ylh7g8Gwv1Y0=",
    "zh:0b51793be4f66934a3666339e44c01fd56e1c6a56256dfc66d1cb391584b4c2f",
    "zh:31cdd9b30e4ec63d130befc89471757ef3937b99a8f6cc006769d215365c5ba8",
    "zh:61f86de4a3166cfa5da6800eeba8e6a2e4ab6403fc3d7b396508260b45d3de7d",
    "zh:78d5eefdd9e494defcb3c68d282b8f96630502cac21d1ea161f53cfe9bb483b3",
    "zh:817e8d5946aed6ca692e0bb2f6463c28774ef8fb2fdd3922543a495a249229ea",
    "zh:b35f1bd1be09ed1a1620b43ab8cb43fe93407cf419586d53fe965691cc1b4a8e",
    "zh:bcb170063ec8b5728bc2a4568bc48f539a1991cdaaf31667aa35568aebc34725",
    "zh:c0d2c824cc7c047f26ce793bb0cbb6746f9745d1fc6e630d34a0afb5b92850d1",
    "zh:cde68f51089b02db50e2c5a17f6e132dc1ead2fc08d3dd267b8dd54ec58133fa",
    "zh:d1f3c497aa41f17e8d61067122f6d94e51ef942ab08be5465489864d900854ab",
    "zh:e62568bfc0934b63e14f3547c823b01ed60d7475ff16bf12c0e55d5ac8d98ba7",
    "zh:ed8890c29dba2b0ac27afcefa75e7395e27253b7025aaaa4258345fc59dad23e",
    "zh:f220c56c7e487f01fd158126066f6525178bbd82805b27205354bc523cc7c413",
  ]
}

provider "registry.terraform.io/hashicorp/random" {
  version     = "3.8.1"
  constraints = ">= 3.6.0, ~> 3.6, < 4.0.0"
  hashes = [
    "h1:Eexl06+6J+s75uD46+WnZtpJZYRVUMB0AiuPBifK6Jc=",
    "h1:u8AKlWVDTH5r9YLSeswoVEjiY72Rt4/ch7U+61ZDkiQ=",
    "zh:08dd03b918c7b55713026037c5400c48af5b9f468f483463321bd18e17b907b4",
    "zh:0eee654a5542dc1d41920bbf2419032d6f0d5625b03bd81339e5b33394a3e0ae",
    "zh:229665ddf060aa0ed315597908483eee5b818a17d09b6417a0f52fd9405c4f57",
    "zh:2469d2e48f28076254a2a3fc327f184914566d9e40c5780b8d96ebf7205f8bc0",
    "zh:37d7eb334d9561f335e748280f5535a384a88675af9a9eac439d4cfd663bcb66",
    "zh:741101426a2f2c52dee37122f0f4a2f2d6af6d852cb1db634480a86398fa3511",
    "zh:78d5eefdd9e494defcb3c68d282b8f96630502cac21d1ea161f53cfe9bb483b3",
    "zh:a902473f08ef8df62cfe6116bd6c157070a93f66622384300de235a533e9d4a9",
    "zh:b85c511a23e57a2147355932b3b6dce2a11e856b941165793a0c3d7578d94d05",
    "zh:c5172226d18eaac95b1daac80172287b69d4ce32750c82ad77fa0768be4ea4b8",
    "zh:dab4434dba34aad569b0bc243c2d3f3ff86dd7740def373f2a49816bd2ff819b",
    "zh:f49fd62aa8c5525a5c17abd51e27ca5e213881d58882fd42fec4a545b53c9699",
  ]
}

provider "registry.terraform.io/hashicorp/tls" {
  version     = "4.2.1"
  constraints = ">= 4.0.0, < 5.0.0"
  hashes = [
    "h1:F5d6bQY8UlBo0D71Sv7CsV+3aZOFz0yeNF+vufog7h4=",
    "h1:akFNuHwvrtnYMBofieoeXhPJDhYZzJVu/Q/BgZK2fgg=",
    "zh:0d1e7d07ac973b97fa228f46596c800de830820506ee145626f079dd6bbf8d8a",
    "zh:5c7e3d4348cb4861ab812973ef493814a4b224bdd3e9d534a7c8a7c992382b86",
    "zh:7c6d4a86cd7a4e9c1025c6b3a3a6a45dea202af85d870cddbab455fb1bd568ad",
    "zh:7d0864755ba093664c4b2c07c045d3f5e3d7c799dda1a3ef33d17ed1ac563191",
    "zh:83734f57950ab67c0d6a87babdb3f13c908cbe0a48949333f489698532e1391b",
    "zh:951e3c285218ebca0cf20eaa4265020b4ef042fea9c6ade115ad1558cfe459e5",
    "zh:b9543955b4297e1d93b85900854891c0e645d936d8285a190030475379c5c635",
    "zh:bb1bd9e86c003d08c30c1b00d44118ed5bbbf6b1d2d6f7eaac4fa5c6ebea5933",
    "zh:c9477bfe00653629cd77ddac3968475f7ad93ac3ca8bc45b56d1d9efb25e4a6e",
    "zh:d4cfda8687f736d0cba664c22ec49dae1188289e214ef57f5afe6a7217854fed",
    "zh:dc77ee066cf96532a48f0578c35b1eaf6dc4d8ddd0e3ae8e029a3b10676dd5d3",
    "zh:f569b65999264a9416862bca5cd2a6177d94ccb0424f3a4ef424428912b9cb3c",
  ]
}
'''


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
if name == 'time': sys.exit(0)
elif name == 'timeout':
    if args[0] != '900': sys.exit(0)
    record()
    assert args[0] == '900', args
    if state.get('mirror_timeout') or (p.cwd().name.startswith('fixture-') and state.get('fixture_timeout')):
        sys.exit(124)
    os.execvp(args[1], args[1:])
elif name == 'sleep': pass
elif name == 'terraform' and args[:2] == ['providers','mirror']:
    record()
    dest=p(args[-1])
    dest.mkdir(parents=True,exist_ok=True)
    (dest/'.partial').write_text('unfinished download')
    if state.get('mirror_fails') or (p.cwd().name.startswith('fixture-') and state.get('fixture_fails')):
        sys.exit(1)
    config=json.loads((p.cwd()/'main.tf.json').read_text())
    for provider in config['terraform']['required_providers'].values():
        source=provider['source']
        version=provider.get('version','')
        if not version.replace('.','').isdigit():
            version=state.get('resolved',{}).get(source,'6.67.0')
        target=dest/source
        target.mkdir(parents=True,exist_ok=True)
        platform=next(a.split('=',1)[1] for a in args if a.startswith('-platform='))
        (target/f'terraform-provider-{source.split("/")[-1]}_{version}_{platform}.zip').write_text('authenticated zip '+version)
        (target/'index.json').write_text('{"stale":true}')
        (target/(version+'.json')).write_text('{"stale":true}')
elif name in ('vector','aws','terraform','ruby','gh'):
    version = state[name]
    if name == 'vector': print('vector '+version+' (linux)')
    if name == 'aws': print('aws-cli/'+version+' Python/3 Linux')
    if name == 'terraform': print(json.dumps({'terraform_version':version}))
    if name == 'ruby': print('ruby '+version)
    if name == 'gh': print('gh version '+version)
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
        if args[1:] == ['update','-qq']:
            if state.get('update_fails'): sys.exit(100)
            state['apt_lists']=True
            save()
            sys.exit(0)
        assert args[1:4] == ['install','-y','-qq'], args
        if (state.get('apt_lists') is False or args[-1] == state.get('apt_fails')
                or args[-1] in state.get('apt_fail_packages', [])):
            print('E: Unable to locate package '+args[-1],file=sys.stderr)
            sys.exit(100)
        if args[-1] == 'ruby' and state.get('ruby_target_missing'):
            (home/'bin/ruby').unlink(missing_ok=True)
            (home/'bin/ruby').symlink_to(home/'bin/ruby3.3')
        elif args[-1] in ('ruby','ruby3.3') and (not state.get('ruby_cached') or '--reinstall' in args): binary('ruby','3.3.0')
        if args[-1] == 'unzip': binary('unzip','installed')
        if args[-1] == 'time' and state.get('broken_tool') != 'time': binary('time','GNU')
        if args[-1] == 'gh' and state.get('broken_tool') != 'gh': binary('gh','2.45.0')
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
        self.state = dict(vector='0.50.0', aws='2.99.0', terraform='1.16.1', ruby='3.3.0', time='GNU', gh='2.45.0')
        for tool in ('curl','sudo','tar','unzip','uname','readlink','dpkg-query','timeout','sleep',*self.state):
            shutil.copy(self.fake, self.bin/tool)
        (self.bin/'python3').symlink_to(sys.executable)
        flock = self.bin/'flock'
        flock.write_text('#!'+sys.executable+'\nimport fcntl,sys\nfcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX)\n')
        flock.chmod(0o755)
        self.recipes = self.home/'templates/repos'
        self.recipes.mkdir(parents=True)
        (self.recipes.parent/'tools').mkdir()
        for source in (TEMPLATES/'tools/fetch.sh', TEMPLATES/'tools/crpko.sh', TEMPLATES/'repos/crpko-devops.sh'):
            target = self.recipes.parent/source.relative_to(TEMPLATES)
            # Keep all fake installs in a temporary tree, including the absolute Ruby check.
            target.write_text(source.read_text().replace('/usr/bin/ruby',str(self.bin/'ruby'))
                              .replace('/usr/local/bin',str(self.bin))
                              .replace('/usr/local/aws-cli',str(self.home/'aws-cli')))
        # Hide any host gh while preserving real command lookup on the fixture PATH.
        shared=self.recipes.parent/'tools/crpko.sh'
        shared.write_text('command() {\n'
            '  if [ "$1" = -v ] && [ "$2" = gh ]; then\n'
            f'    PATH="{self.bin}" builtin command "$@"\n'
            '  else builtin command "$@"; fi\n}\n'+shared.read_text())
        # An enclosing offbox run exports shell functions and toolchain state as well as BASH_ENV.
        self.env = dict(HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin',
                        OFFBOX_REPO_ROOT=str(self.root), OFFBOX_GNU_TIME=str(self.bin/'time'))

    def pin(self, version):
        self.workflow.write_text('steps:\n  - uses: hashicorp/setup-terraform@v3\n    with:\n'
                                 f'      terraform_version: "{version}"\n')

    def run_setup(self, node='', command='echo USER_COMMAND; command -v terraform aws ruby vector gh', repo='w/repo'):
        (self.home/'state').write_text(json.dumps(self.state))
        with patch.object(runs,'REPO_RECIPES_DIR',self.recipes), \
             patch.object(runs,'DOCKER_REPAIR',':'), patch.object(runs,'LDCACHE_REPAIR',':'), \
             patch.object(runs,'GO_REPAIR',':'), patch.object(runs.userns,'setup',return_value=':'):
            script = runs.remote_script(repo,'.',[command],None,'run-test',repo_key=KEY,node=node)
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

    def run_check(self, repo_root=None):
        (self.home/'state').write_text(json.dumps(self.state))
        body=(self.recipes.parent/'tools/crpko.sh').read_text()+'\n'+(self.recipes/f'{KEY}.sh').read_text()
        env=self.env if repo_root is None else dict(self.env,OFFBOX_REPO_ROOT=str(repo_root))
        return subprocess.run(['bash','-c',body,'recipe','--check'],env=env,
                              capture_output=True,text=True,timeout=15)

    def test_empty_apt_lists_refresh_once_and_retry_install(self):
        self.state['apt_lists']=False
        self.state['ruby_target_missing']=True
        self.missing('ruby')
        (self.bin/'ruby').symlink_to(self.bin/'ruby3.3')
        self.missing('time')
        self.assert_ok(self.run_setup())
        calls=self.calls()
        self.assertEqual(calls.count('apt-get update -qq'),1)
        self.assertEqual(calls.count('apt-get install -y -qq ruby\n'),2)
        self.assertIn('apt-get install -y -qq --reinstall ruby\n',calls)
        self.assertIn('apt-get install -y -qq --reinstall ruby3.3\n',calls)
        self.assertIn('apt-get install -y -qq time\n',calls)

    def test_each_ruby_install_form_refreshes_empty_lists(self):
        # All apt argument forms must survive the retry, including the dpkg owner.
        for args in ('ruby','--reinstall ruby','--reinstall ruby3.3','unzip','gh'):
            with self.subTest(args=args):
                self.state['apt_lists']=False
                (self.home/'state').write_text(json.dumps(self.state))
                before=self.calls()
                body=(self.recipes.parent/'tools/crpko.sh').read_text()
                result=subprocess.run(['bash','-c',body+'\noffbox_apt_install '+args],
                                      env=self.env,capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode,0,result.stderr)
                calls=self.calls()[len(before):]
                self.assertEqual(calls.count('apt-get update -qq'),1)
                self.assertEqual(calls.count('apt-get install -y -qq '+args+'\n'),2)

    def test_warm_apt_lists_need_no_update(self):
        self.missing('ruby')
        self.assert_ok(self.run_setup())
        self.assertIn('apt-get install -y -qq ruby',self.calls())
        self.assertNotIn('apt-get update',self.calls())

    def test_failed_ruby_install_forms_share_one_update_in_the_shell(self):
        self.state.update(apt_lists=False,apt_fail_packages=['ruby','ruby3.3'])
        (self.home/'state').write_text(json.dumps(self.state))
        body=(self.recipes.parent/'tools/crpko.sh').read_text()
        body+='\noffbox_apt_install ruby || :\noffbox_apt_install --reinstall ruby || :\n'
        body+='offbox_apt_install --reinstall ruby3.3 || exit 98\n'
        result=subprocess.run(['bash','-c',body],env=self.env,capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertEqual(self.calls().count('apt-get update -qq'),1)

    def test_failed_update_leaves_no_stamp_and_next_setup_refreshes_again(self):
        self.state.update(apt_lists=False,update_fails=True)
        self.missing('ruby')
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertNotIn('USER_COMMAND',result.stdout)
        self.assertFalse((self.home/f'.offbox/repo-setup-{KEY}.stamp').exists())
        self.assertEqual(self.calls().count('apt-get update -qq'),1)
        self.state['update_fails']=False
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls().count('apt-get update -qq'),2)

    def test_later_install_failure_does_not_refresh_twice(self):
        self.state.update(apt_lists=False,apt_fails='time')
        self.missing('ruby')
        self.missing('time')
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('GNU time install failed',result.stderr)
        self.assertEqual(self.calls().count('apt-get update -qq'),1)
        self.assertNotIn('USER_COMMAND',result.stdout)
        self.assertFalse((self.home/f'.offbox/repo-setup-{KEY}.stamp').exists())

    def test_missing_gnu_time_fails_check_then_installs_and_passes_check(self):
        self.missing('time')
        self.assertNotEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup())
        self.assertIn('apt-get install -y -qq time',self.calls())
        self.assertEqual(self.run_check().returncode,0)

    def test_present_gnu_time_is_not_installed(self):
        self.assert_ok(self.run_setup())
        self.assertEqual(self.run_check().returncode,0)
        self.assertNotIn('apt-get install -y -qq time',self.calls())

    def test_missing_gh_repairs_box_with_matching_stamp(self):
        self.assert_ok(self.run_setup())
        stamp=self.home/f'.offbox/repo-setup-{KEY}.stamp'
        before_stamp=stamp.read_text()
        self.missing('gh')
        self.assertNotEqual(self.run_check().returncode,0)
        before=self.calls()
        result=self.run_setup()
        self.assert_ok(result)
        self.assertIn('setting up crpko-devops toolchain',result.stderr)
        self.assertIn('apt-get install -y -qq gh',self.calls()[len(before):])
        self.assertNotIn('apt-get update',self.calls()[len(before):])
        self.assertEqual(stamp.read_text(),before_stamp)
        self.assertEqual(self.run_check().returncode,0)
        before=self.calls()
        result=self.run_setup()
        self.assert_ok(result)
        self.assertNotIn('setting up',result.stderr)
        self.assertEqual(self.calls(),before)

    def test_gh_install_without_executable_fails_setup(self):
        self.missing('gh')
        self.state['broken_tool']='gh'
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('offbox: gh install failed',result.stderr)
        self.assertNotIn('USER_COMMAND',result.stdout)
        self.assertNotIn('toolchain ready',result.stderr)
        self.assertFalse((self.home/f'.offbox/repo-setup-{KEY}.stamp').exists())

    def test_failed_gh_apt_install_stops_setup(self):
        self.missing('gh')
        self.state['apt_fails']='gh'
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('Unable to locate package gh',result.stderr)
        self.assertNotIn('USER_COMMAND',result.stdout)
        self.assertFalse((self.home/f'.offbox/repo-setup-{KEY}.stamp').exists())

    def test_recipe_final_gate_requires_gh_after_shared_setup(self):
        shared=self.recipes.parent/'tools/crpko.sh'
        shared.write_text(shared.read_text()+
            f'\noffbox_crpko_download_tools() {{ rm -f "{self.bin}/gh"; }}\n')
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('required tool missing on command PATH: gh',result.stderr)
        self.assertNotIn('USER_COMMAND',result.stdout)
        self.assertFalse((self.home/f'.offbox/repo-setup-{KEY}.stamp').exists())

    def test_time_install_without_executable_fails_setup(self):
        self.missing('time')
        self.state['broken_tool']='time'
        result=self.run_setup()
        self.assertEqual(result.returncode,98,result.stderr)
        self.assertIn('offbox: GNU time install failed',result.stderr)
        self.assertNotIn('USER_COMMAND',result.stdout)

    def test_ready_tools_and_second_run_install_nothing(self):
        self.assert_ok(self.run_setup())
        result = self.run_setup()
        self.assert_ok(result)
        self.assertNotIn('setting up', result.stderr)
        self.assertEqual(self.calls(),'')

    def lock(self, name, providers):
        path=self.root/'terraform/roots'/name/'.terraform.lock.hcl'
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text('\n'.join(f'provider "registry.terraform.io/hashicorp/{tool}" {{\n'
                                 f'  version     = "{version}"\n  constraints = ">= 1.0"\n'
                                 '  hashes = [\n    "h1:fixture",\n    "zh:fixture",\n  ]\n}\n'
                                 for tool,version in providers.items()))
        return path

    def mirror_package(self, tool, version, platform='linux_amd64'):
        return self.home/f'.offbox/tf-provider-mirror/registry.terraform.io/hashicorp/{tool}/terraform-provider-{tool}_{version}_{platform}.zip'

    def test_mirror_fills_locks_and_unpinned_fixture_then_warm_run_skips(self):
        self.lock('dev',{'aws':'5.100.0','random':'3.8.1'})
        self.lock('prod',{'aws':'5.100.0','tls':'4.2.1'})
        fixture=self.root/'terraform/modules/unpinned/versions.tf'
        fixture.parent.mkdir(parents=True)
        fixture.write_text('terraform { required_providers { aws = { source = "hashicorp/aws" } } }')
        self.assertNotEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup(command='echo USER_COMMAND; echo "$TERRAFORM_PROVIDER_MIRROR"; test -z "${TF_CLI_CONFIG_FILE:-}"'))
        for tool,version in [('aws','5.100.0'),('random','3.8.1'),('tls','4.2.1'),('aws','6.67.0')]:
            self.assertTrue(self.mirror_package(tool,version).is_file())
        env=(self.home/'.offbox/repo-env/crpko-devops.sh').read_text()
        self.assertIn('export TERRAFORM_PROVIDER_MIRROR=',env)
        self.assertNotIn('TF_CLI_CONFIG_FILE',env)
        rc=(self.home/'.terraformrc').read_text()
        self.assertIn('filesystem_mirror {',rc)
        self.assertIn('direct {}',rc)
        self.assertIn(str(self.home/'.offbox/tf-provider-mirror'),rc)
        self.assertEqual(self.run_check().returncode,0)
        calls=self.calls()
        self.assertIn('timeout 900 terraform providers mirror -platform=linux_amd64',calls)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),calls)

    def test_mirror_preserves_existing_package_and_regenerates_indexes(self):
        self.lock('dev',{'aws':'5.100.0','random':'3.8.1'})
        module=self.root/'terraform/modules/streaming-plane/.terraform.lock.hcl'
        module.parent.mkdir(parents=True)
        module.write_text('provider "registry.terraform.io/hashicorp/aws" {\n  version = "6.62.0"\n}\n')
        existing=self.mirror_package('aws','5.100.0')
        existing.parent.mkdir(parents=True)
        existing.write_text('never replace this package')
        marker=existing.parent/'marker'
        marker.write_text('untouched')
        inode=existing.stat().st_ino
        (existing.parent/'index.json').write_text('{}')
        self.assert_ok(self.run_setup())
        self.assertEqual(existing.read_text(),'never replace this package')
        self.assertEqual(existing.stat().st_ino,inode)
        self.assertEqual(marker.read_text(),'untouched')
        self.assertTrue(self.mirror_package('random','3.8.1').is_file())
        versions=json.loads((existing.parent/'index.json').read_text())['versions']
        self.assertEqual(versions,{'5.100.0':{},'6.62.0':{}})
        self.assertIn('linux_amd64',json.loads((existing.parent/'5.100.0.json').read_text())['archives'])

    def test_mirror_fill_failure_and_timeout_are_nonfatal_and_retry_next_run(self):
        self.lock('dev',{'aws':'5.100.0'})
        for flag in ('mirror_fails','mirror_timeout'):
            with self.subTest(flag=flag):
                self.state[flag]=True
                before=self.calls()
                self.assert_ok(self.run_setup(command='echo USER_COMMAND; cat "$HOME/.offbox/repo-setup-crpko-devops.log"'))
                log=(self.home/'.offbox/repo-setup-crpko-devops.log').read_text()
                self.assertIn('offbox: terraform provider mirror fill failed (',log)
                self.assertIn('; tests will download providers',log)
                self.assertTrue((self.home/'.offbox/repo-env/crpko-devops.sh').is_file())
                self.assertNotEqual(self.run_check().returncode,0)
                self.assertEqual(list((self.home/'.offbox').glob('tf-provider-mirror-stage.*')),[])
                self.assertEqual(self.calls()[len(before):].count('timeout 900 terraform providers mirror'),3)
                del self.state[flag]
        self.assert_ok(self.run_setup())
        self.assertEqual(self.run_check().returncode,0)

    def test_existing_terraformrc_is_untouched(self):
        self.lock('dev',{'aws':'5.100.0'})
        rc=self.home/'.terraformrc'
        rc.write_text('# owner config\ndisable_checkpoint = true\n')
        self.assert_ok(self.run_setup())
        self.assertEqual(rc.read_text(),'# owner config\ndisable_checkpoint = true\n')

    def assert_fixture_failure_retries(self, flag, previously_complete=False):
        self.lock('dev',{}).write_text(REAL_DEV_LOCK)
        if previously_complete:
            self.assert_ok(self.run_setup())
            self.assertEqual(self.run_check().returncode,0)
            # A new pin must invalidate the old completion state before fixture filling starts.
            self.lock('prod',{'aws':'6.62.0'})
        scripts=self.root/'scripts'
        scripts.mkdir()
        (scripts/'fixture.mjs').write_text('const text = `terraform { required_providers { '
                                         'external = { source = "hashicorp/external", version = "2.3.5" } } }`;')
        self.state[flag]=True
        self.env['TERRAFORM_PROVIDER_MIRROR']=str(self.home/'.offbox/tf-provider-mirror')
        before=self.calls()
        self.assert_ok(self.run_setup(command='echo USER_COMMAND; test -z "${TERRAFORM_PROVIDER_MIRROR:-}"'))
        self.assertEqual(self.calls()[len(before):].count('timeout 900 terraform providers mirror'),4)
        for tool,version in [('archive','2.7.1'),('aws','5.100.0'),('external','2.4.2'),('random','3.8.1'),('tls','4.2.1')]:
            self.assertTrue(self.mirror_package(tool,version).is_file())
        self.assertFalse(self.mirror_package('external','2.3.5').exists())
        self.assertNotEqual(self.run_check().returncode,0)
        env=(self.home/'.offbox/repo-env/crpko-devops.sh').read_text()
        self.assertNotIn('export TERRAFORM_PROVIDER_MIRROR=',env)
        self.assertIn('unset TERRAFORM_PROVIDER_MIRROR',env)
        self.assertIn('fixture registry.terraform.io/hashicorp/external 2.3.5',
                      (self.home/'.offbox/repo-setup-crpko-devops.log').read_text())
        self.assertEqual(list((self.home/'.offbox').glob('tf-provider-mirror-stage.*')),[])
        pinned=self.mirror_package('external','2.4.2')
        pinned_stat=pinned.stat()
        before=self.calls()
        del self.state[flag]
        self.assert_ok(self.run_setup(command='echo USER_COMMAND; test -n "$TERRAFORM_PROVIDER_MIRROR"'))
        self.assertEqual(self.calls()[len(before):].count('timeout 900 terraform providers mirror'),1)
        self.assertTrue(self.mirror_package('external','2.3.5').is_file())
        self.assertEqual(self.run_check().returncode,0)
        self.assertEqual((pinned.stat().st_ino,pinned.stat().st_mtime_ns),
                         (pinned_stat.st_ino,pinned_stat.st_mtime_ns))
        before=self.calls()
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),before)

    def test_fixture_failure_after_locked_fill_disables_hook_and_retries(self):
        self.assert_fixture_failure_retries('fixture_fails')

    def test_fixture_timeout_after_locked_fill_disables_hook_and_retries(self):
        self.assert_fixture_failure_retries('fixture_timeout')

    def test_refill_failure_invalidates_previous_completion(self):
        self.assert_fixture_failure_retries('fixture_fails',previously_complete=True)

    def test_existing_pins_without_completion_still_fill_fixtures(self):
        self.lock('dev',{'aws':'5.100.0'})
        pinned=self.mirror_package('aws','5.100.0')
        pinned.parent.mkdir(parents=True)
        pinned.write_text('existing locked package')
        inode=pinned.stat().st_ino
        scripts=self.root/'scripts'
        scripts.mkdir()
        (scripts/'fixture.mjs').write_text('const text = `terraform { required_providers { '
                                         'external = { source = "hashicorp/external", version = "2.3.5" } } }`;')
        self.assertNotEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls().count('timeout 900 terraform providers mirror'),1)
        self.assertTrue(self.mirror_package('external','2.3.5').is_file())
        self.assertEqual(pinned.stat().st_ino,inode)
        self.assertEqual(pinned.read_text(),'existing locked package')
        self.assertEqual(self.run_check().returncode,0)

    def test_changed_fixture_requirements_refill_with_unchanged_locks(self):
        lock=self.lock('dev',{})
        lock.write_text(REAL_DEV_LOCK)
        self.assert_ok(self.run_setup())
        original_calls=self.calls()
        scripts=self.root/'scripts'
        scripts.mkdir()
        fixture=scripts/'fixture.mjs'
        fixture.write_text('const text = `terraform { required_providers { '
                           'external = { source = "hashicorp/external", version = "2.3.5" } } }`;')
        self.assertNotEqual(self.run_check().returncode,0)
        self.assertEqual(self.calls(),original_calls)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls()[len(original_calls):].count('timeout 900 terraform providers mirror'),1)
        self.assertTrue(self.mirror_package('external','2.3.5').is_file())
        self.assertEqual(self.run_check().returncode,0)
        self.state['resolved']={'registry.terraform.io/hashicorp/external':'2.4.2'}
        fixture.write_text(fixture.read_text().replace('"2.3.5"','"~> 2.3"'))
        self.assertNotEqual(self.run_check().returncode,0)
        before=self.calls()
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls()[len(before):].count('timeout 900 terraform providers mirror'),1)
        self.assertEqual(self.run_check().returncode,0)
        before=self.calls()
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),before)
        # Switching back to an input set already filled on this box needs no network.
        fixture.write_text(fixture.read_text().replace('"~> 2.3"','"2.3.5"'))
        self.assertEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),before)
        fixture.unlink()
        self.assertEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),before)
        self.assertEqual(lock.read_text(),REAL_DEV_LOCK)

    def test_fixture_signature_ignores_order_duplicates_and_formatting(self):
        self.lock('dev',{}).write_text(REAL_DEV_LOCK)
        self.state['resolved']={'registry.terraform.io/hashicorp/external':'2.4.2'}
        scripts=self.root/'scripts'
        scripts.mkdir()
        (scripts/'one.mjs').write_text('const text = `terraform { required_providers { '
            'external = { source = "hashicorp/external", version = "= 2.3.5" } } }`;')
        (scripts/'two.mjs').write_text('const text = `terraform { required_providers { '
            'external = { source = "hashicorp/external", version = ">= 2.3.0, < 3.0.0" } '
            'tls = { source = "hashicorp/tls", version = "4.2.1" } } }`;')
        self.assert_ok(self.run_setup())
        before=self.calls()
        (scripts/'one.mjs').rename(scripts/'renamed.mjs')
        (scripts/'renamed.mjs').write_text('const text = `terraform { required_providers { '
            'renamed = { version = "2.3.5", source = "registry.terraform.io/hashicorp/external" } } }`;')
        (scripts/'two.mjs').write_text('const text = `terraform { required_providers { '
            'tls = { version = "=4.2.1", source = "hashicorp/tls" } '
            'external = { version = "<3.0.0, >=2.3.0", source = "hashicorp/external" } } }`;')
        shutil.copyfile(scripts/'renamed.mjs',scripts/'duplicate.mjs')
        self.assertEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),before)

    def test_reused_box_fills_another_checkout_fixture_with_same_pins(self):
        self.lock('dev',{}).write_text(REAL_DEV_LOCK)
        self.assert_ok(self.run_setup())
        other=self.home/'w/other'
        shutil.copytree(self.root,other)
        (other/'scripts').mkdir()
        (other/'scripts/fixture.mjs').write_text('const text = `terraform { required_providers { '
            'external = { source = "hashicorp/external", version = "2.3.5" } } }`;')
        self.assertNotEqual(self.run_check(repo_root=other).returncode,0)
        before=self.calls()
        self.assert_ok(self.run_setup(repo='w/other'))
        self.assertEqual(self.calls()[len(before):].count('timeout 900 terraform providers mirror'),1)
        self.assertTrue(self.mirror_package('external','2.3.5').is_file())
        self.assertEqual(self.run_check(repo_root=other).returncode,0)
        before=self.calls()
        self.assert_ok(self.run_setup(repo='w/other'))
        self.assertEqual(self.calls(),before)
        self.assertEqual(self.run_check().returncode,0)
        self.assert_ok(self.run_setup())
        self.assertEqual(self.calls(),before)

    def test_generated_fixture_requirement_forms(self):
        self.lock('dev',{'aws':'5.100.0'})
        scripts=self.root/'scripts'
        scripts.mkdir()
        forms=[
            'terraform { required_providers { p = { source = "hashicorp/aws", version = ">= 5.0" } } }',
            'terraform { required_providers { p = { version = "6.62.0"\n source = "hashicorp/aws" } } }',
            'terraform {\\n required_providers {\\n p = { source = "registry.terraform.io/hashicorp/aws" }\\n }\\n}',
        ]
        for i,form in enumerate(forms):
            (scripts/f'fixture-{i}.mjs').write_text('const text = `'+form+'`;')
        self.assert_ok(self.run_setup())
        self.assertTrue(self.mirror_package('aws','6.67.0').exists())
        self.assertTrue(self.mirror_package('aws','6.62.0').exists())

    def test_two_setups_share_one_publisher(self):
        self.lock('dev',{'aws':'5.100.0'})
        (self.home/'state').write_text(json.dumps(self.state))
        script=(self.recipes.parent/'tools/crpko.sh').read_text()+'\n'+(self.recipes/f'{KEY}.sh').read_text()
        children=[subprocess.Popen(['bash','-c',script],env=self.env,stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE,text=True) for _ in range(2)]
        for child in children:
            stdout,stderr=child.communicate(timeout=15)
            self.assertEqual(child.returncode,0,stdout+stderr)
        self.assertEqual(self.calls().count('terraform providers mirror -platform='),2)  # timeout + terraform
        self.assertTrue(self.mirror_package('aws','5.100.0').exists())
        self.assertEqual(list((self.home/'.offbox').glob('tf-provider-mirror-stage.*')),[])

    def test_real_dev_lock_shape(self):
        path=self.lock('dev',{})
        path.write_text(REAL_DEV_LOCK)
        self.assert_ok(self.run_setup())
        for tool,version in [('archive','2.7.1'),('aws','5.100.0'),('external','2.4.2'),('random','3.8.1'),('tls','4.2.1')]:
            self.assertTrue(self.mirror_package(tool,version).exists())
        self.assertEqual(self.run_check().returncode,0)
        self.assertEqual(path.read_text(),REAL_DEV_LOCK)

    def test_mirror_uses_platform_from_box_architecture(self):
        self.state['arch']='aarch64'
        self.lock('dev',{'aws':'5.100.0'})
        self.assert_ok(self.run_setup())
        self.assertTrue(self.mirror_package('aws','5.100.0','linux_arm64').exists())
        self.assertEqual(self.run_check().returncode,0)

    def test_missing_and_wrong_versions_install_then_skip(self):
        for tool, versions in [('vector',(None,'0.49.0')),('aws',(None,'1.45.0')),
                               ('terraform',(None,'1.15.0')),('ruby',(None,)),('gh',(None,))]:
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
                                'aws':'./aws/install --update','ruby':'apt-get install -y -qq ruby',
                                'gh':'apt-get install -y -qq gh'}[tool]
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

    def test_repo_environment_does_not_prepend_a_box_node_path(self):
        result = self.run_setup(command='echo USER_COMMAND; printf "PATH=%s\\n" "$PATH"')
        self.assert_ok(result)
        self.assertIn('PATH=' + self.env['PATH'], result.stdout.splitlines())

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
        for tool in ('terraform','aws','ruby','vector','gh'):
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


class RecipeFixtureEnvironmentTests(unittest.TestCase):
    def test_enclosing_run_cannot_change_recipe_environment(self):
        with tempfile.TemporaryDirectory() as outer:
            startup = Path(outer) / 'bash-env'
            startup.write_text('export PATH="$__offbox_toolchain_bin:$PATH"\n')
            shim = str(Path(outer) / 'toolchain-commands')
            inputs = {
                'startup file': {'BASH_ENV': str(startup)},
                'exported cd': {'BASH_FUNC_cd%%':
                    '() { builtin cd "$@" && export PATH="$__offbox_toolchain_bin:$PATH"; }'},
                'run state': {'OFFBOX_FIXTURE_AMBIENT': 'outer-run'},
            }
            for name, ambient in inputs.items():
                with self.subTest(name=name), patch.dict(os.environ,
                        dict(ambient, HOME=outer, __offbox_toolchain_bin=shim)):
                    fixture = CrpkoSetupTests('test_repo_environment_does_not_prepend_a_box_node_path')
                    try:
                        fixture.setUp()
                        fixture.test_repo_environment_does_not_prepend_a_box_node_path()
                        result = fixture.run_setup(command='echo USER_COMMAND; '
                            'printf "HOME=%s\\nAMBIENT=%s\\n" "$HOME" "${OFFBOX_FIXTURE_AMBIENT-}"')
                        fixture.assert_ok(result)
                        self.assertIn('HOME=' + str(fixture.home), result.stdout.splitlines())
                        self.assertIn('AMBIENT=', result.stdout.splitlines())
                    finally:
                        fixture.doCleanups()


class RepoKeyTests(Isolated):
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
