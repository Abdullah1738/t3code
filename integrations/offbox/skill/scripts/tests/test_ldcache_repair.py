"""Run the real LDCACHE_REPAIR bash against a fake lib dir, ldconfig and sudo (no root, no Linux needed)."""
import os
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs
from offbox_lib.runs import LDCACHE_REPAIR, remote_script

FAKE_LDCONFIG = '''#!/bin/bash
# -p prints a header then the cache; with no args, rebuild the cache from soname links.
if [ "$1" = -p ]; then echo "N libs found in cache"; cat "$FIX/cache"; exit 0; fi
echo run >> "$FIX/calls"
: > "$FIX/cache"
for f in "$FIX"/usr/lib/x86_64-linux-gnu/lib*.so.*; do
  n=${f##*/}
  grep -qx "$n" "$FIX/uncacheable" 2>/dev/null && continue
  printf '\\t%s (libc6,x86-64) => /lib/x86_64-linux-gnu/%s\\n' "$n" "$n" >> "$FIX/cache"
done
'''


class Fixture:
    def __init__(self, tmp, sudo_ok=True, ldconfig=True):
        self.fix = Path(tmp)
        self.lib = self.fix / 'usr/lib/x86_64-linux-gnu'
        self.lib.mkdir(parents=True)
        bins, sbin, home = self.fix / 'bin', self.fix / 'sbin', self.fix / 'home'
        for d in (bins, sbin, home):
            d.mkdir()
        self.home = home
        (self.fix / 'cache').write_text('')
        if ldconfig:
            (sbin / 'ldconfig').write_text(FAKE_LDCONFIG)
            (sbin / 'ldconfig').chmod(0o755)
        sudo = bins / 'sudo'
        sudo.write_text('#!/bin/bash\n[ "$1" = -n ] && shift\nexec "$@"\n' if sudo_ok else '#!/bin/bash\nexit 1\n')
        sudo.chmod(0o755)
        self.script = (LDCACHE_REPAIR.replace('/sbin/ldconfig', str(sbin / 'ldconfig'))
                       .replace('/usr/lib/', str(self.fix / 'usr/lib') + '/')
                       .replace('/tmp/offbox-ldcache.lock', str(self.fix / 'ldcache.lock'))
                       + '\necho USER_COMMAND\nexit 3\n')
        self.env = dict(os.environ, HOME=str(home), FIX=str(self.fix), PATH=f'{bins}:/usr/bin:/bin')

    def soname(self, name, target=True):
        if target:
            (self.lib / (name + '.16')).write_text('')
        os.symlink(name + '.16', self.lib / name)

    def cached(self, *names):
        with open(self.fix / 'cache', 'a') as f:
            for n in names:
                f.write(f'\t{n} (libc6,x86-64) => /lib/x86_64-linux-gnu/{n}\n')

    def run(self):
        return subprocess.run(['bash', '-c', self.script], env=self.env, capture_output=True, text=True, timeout=30)

    def calls(self):
        p = self.fix / 'calls'
        return len(p.read_text().splitlines()) if p.exists() else 0


class LdcacheRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_missing_soname_runs_ldconfig_once_then_stays_quiet(self):
        fx = Fixture(self.tmp.name)
        fx.soname('libz.so.1'); fx.cached('libz.so.1')
        fx.soname('libpq.so.5')
        r = fx.run()
        self.assertEqual(r.returncode, 3)
        self.assertIn('USER_COMMAND', r.stdout)
        self.assertIn('linker cache lacked libpq.so.5', r.stderr)
        self.assertEqual(fx.calls(), 1)
        r = fx.run()
        self.assertEqual((r.returncode, r.stderr, fx.calls()), (3, '', 1))

    def test_healthy_cache_does_nothing(self):
        fx = Fixture(self.tmp.name)
        fx.soname('libpq.so.5'); fx.cached('libpq.so.5')
        r = fx.run()
        self.assertEqual((r.returncode, r.stderr, fx.calls()), (3, '', 0))

    def test_link_ldconfig_never_caches_is_remembered(self):
        fx = Fixture(self.tmp.name)
        fx.soname('libodd.so.2')
        (fx.fix / 'uncacheable').write_text('libodd.so.2\n')
        r = fx.run()
        self.assertEqual((r.returncode, r.stderr, fx.calls()), (3, '', 1))
        self.assertIn('libodd.so.2', (fx.home / '.offbox/ldcache-uncached').read_text())
        r = fx.run()
        self.assertEqual((r.returncode, r.stderr, fx.calls()), (3, '', 1))

    def test_dangling_and_unversioned_links_are_ignored(self):
        fx = Fixture(self.tmp.name)
        fx.soname('libgone.so.9', target=False)
        os.symlink('libpq.so.5.16', fx.lib / 'libpq.so')
        (fx.lib / 'libpq.so.5.16').write_text('')
        r = fx.run()
        self.assertEqual((r.returncode, r.stderr, fx.calls()), (3, '', 0))

    def test_sudo_failure_warns_and_still_runs_the_command(self):
        fx = Fixture(self.tmp.name, sudo_ok=False)
        fx.soname('libpq.so.5')
        r = fx.run()
        self.assertEqual(r.returncode, 3)
        self.assertIn('USER_COMMAND', r.stdout)
        self.assertIn("put 'sudo ldconfig;' before your command", r.stderr)

    def test_no_ldconfig_is_a_silent_no_op(self):
        fx = Fixture(self.tmp.name, ldconfig=False)
        fx.soname('libpq.so.5')
        r = fx.run()
        self.assertEqual((r.returncode, r.stderr), (3, ''))
        self.assertIn('USER_COMMAND', r.stdout)


if __name__ == '__main__':
    unittest.main()
