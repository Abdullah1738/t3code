"""install.zsh against a throwaway HOME and a fake launchctl. Run: /usr/bin/python3 -m unittest discover -s tests"""
import os
import shlex
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL_HOME = "/Users/ardud"  # the plists name the real home; the fixture copy points them at the temp one


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="local-helpers-test-")
        # The installer runs from a throwaway git copy of this package: no test touches this tree or the real home.
        self.repo = os.path.join(self.home, "repo")
        self.pkg = os.path.join(self.repo, "local-helpers")
        shutil.copytree(HERE, self.pkg, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.bak*"))
        launchd = os.path.join(self.pkg, "launchd")
        for name in os.listdir(launchd):
            with open(os.path.join(launchd, name)) as fh:
                text = fh.read()
            with open(os.path.join(launchd, name), "w") as fh:
                fh.write(text.replace(REAL_HOME, self.home))
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("*.log\n")
        self.git("init", "-q", "-b", "main")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.install = os.path.join(self.pkg, "install.zsh")
        self.calls = os.path.join(self.home, "launchctl.log")
        self.lctl = os.path.join(self.home, "fake-launchctl")
        self.loaded = os.path.join(self.home, "loaded")
        os.makedirs(self.loaded)
        # Remembers what is loaded; FAKE_FAIL=<label> makes bootstrap of that label fail, FAKE_KICK_FAIL kickstart,
        # FAKE_FAIL_IF=<label>:<text> fails it only for a plist containing text. FAKE_BYTES=<dir> keeps the plist
        # each label was loaded from (read when bootstrap starts, like launchd). FAKE_PAUSE=<path> holds otp-watch's
        # bootstrap after touching <path>.reached until <path>.go exists.
        # Like launchd, bootstrap fails when a log file's directory is missing.
        with open(self.lctl, "w") as fh:
            fh.write("""#!/bin/sh
echo "$@" >> "$FAKE_CALLS"
case "$1" in
  print) [ -e "$FAKE_STATE/${2##*/}" ] || exit 113 ;;
  bootstrap)
    l=$(basename "$3" .plist); [ "$l" = "$FAKE_FAIL" ] && exit 5
    case "$FAKE_FAIL_IF" in "$l:"*) grep -qF -- "${FAKE_FAIL_IF#*:}" "$3" && exit 5 ;; esac
    [ -n "$FAKE_BYTES" ] && cp "$3" "$FAKE_BYTES/$l.reading"
    if [ -n "$FAKE_PAUSE" ] && [ "$l" = local.ardud.otp-watch ] && [ ! -e "$FAKE_PAUSE.go" ]; then
      touch "$FAKE_PAUSE.reached"; i=0
      while [ ! -e "$FAKE_PAUSE.go" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done
    fi
    for k in StandardOutPath StandardErrorPath; do
      p=$(plutil -extract $k raw "$3" 2>/dev/null) || continue
      [ -d "$(dirname "$p")" ] || { echo "no log dir for $p" >&2; exit 78; }
    done
    touch "$FAKE_STATE/$l"; [ -n "$FAKE_BYTES" ] && mv "$FAKE_BYTES/$l.reading" "$FAKE_BYTES/$l.plist" ;;
  bootout) rm -f "$FAKE_STATE/${2##*/}" ;;
  kickstart) [ -n "$FAKE_KICK_FAIL" ] && exit 1; [ -e "$FAKE_STATE/${3##*/}" ] || exit 113 ;;
esac
exit 0
""")
        os.chmod(self.lctl, 0o755)
        self.fake_bin = os.path.join(self.home, "fake-bin")
        os.makedirs(self.fake_bin)
        os.symlink(shutil.which("node"), os.path.join(self.fake_bin, "node"))
        # Keep the macOS installer unchanged while exercising its checks on Linux.
        if sys.platform != "darwin" or shutil.which("plutil", path="/usr/bin:/bin:/usr/sbin") is None:
            self.fake_tool("plutil", '''import plistlib, sys
args = sys.argv[1:]
if not (len(args) == 2 and args[0] == '-lint' or
        len(args) == 4 and args[0] == '-extract' and args[2] == 'raw'):
    sys.exit(2)
try:
    with open(args[-1], 'rb') as source:
        value = plistlib.load(source)
    if args[0] == '-extract':
        print(value[args[1]])
except (OSError, ValueError, KeyError, plistlib.InvalidFileException) as error:
    print(error, file=sys.stderr)
    sys.exit(1)
''')
        if sys.platform != "darwin":
            self.fake_tool("stat", '''import os, stat, sys
if len(sys.argv) != 4 or sys.argv[1:3] != ['-f', '%Lp']:
    sys.exit(2)
print(format(stat.S_IMODE(os.stat(sys.argv[3]).st_mode), 'o'))
''')

    def fake_tool(self, name, body):
        path = os.path.join(self.fake_bin, name)
        with open(path, "w") as out:
            out.write(f"#!{sys.executable}\n" + body)
        os.chmod(path, 0o755)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def git(self, *args):
        subprocess.run(["git", "-C", self.repo, "-c", "user.name=test", "-c", "user.email=test@example.com",
                        *args], check=True, capture_output=True)

    def argv_env(self, args, allow=True, lock_wait=None, stamp=None, **fake):
        env = {"HOME": self.home, "PATH": f"{self.fake_bin}:/usr/bin:/bin:/usr/sbin", "LANG": "en_US.UTF-8",
               "LOCAL_HELPERS_LAUNCHCTL": self.lctl, "FAKE_CALLS": self.calls, "FAKE_STATE": self.loaded}
        if stamp:  # a date that always answers this stamp, as if every run started in the same second
            with open(os.path.join(self.fake_bin, "date"), "w") as fh:
                fh.write(f"#!/bin/sh\necho {stamp}\n")
            os.chmod(os.path.join(self.fake_bin, "date"), 0o755)
        if lock_wait is not None:
            env["LOCAL_HELPERS_LOCK_WAIT"] = str(lock_wait)
        env.update({f"FAKE_{k.upper()}": v for k, v in fake.items()})
        flags = ["--allow-unpushed"] if allow else []
        return ["/bin/zsh", self.install, *flags, *args], env

    def run_install(self, *args, **opts):
        argv, env = self.argv_env(args, **opts)
        r = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120)
        return r.returncode, r.stdout, r.stderr

    def test_dry_run_with_node_hook_and_no_uber_or_lock(self):
        helper = os.path.join(self.pkg, "libexec/repo-node-pin")
        with open(os.path.join(self.home, ".zshenv"), "w") as fh:
            fh.write('. "$ROBOB_REPO_NODE_HELPER/init.sh"\n')
        argv, env = self.argv_env(["--dry-run"])
        env["ROBOB_REPO_NODE_HELPER"] = helper
        result = subprocess.run(argv, cwd=self.home, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("update ", result.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".local/bin/qcard")))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".local/state/local-helpers")))

    def start_install(self, *args, **opts):
        argv, env = self.argv_env(args, **opts)
        return subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def live(self, rel):
        return os.path.join(self.home, rel)

    def unload(self, label):
        os.remove(os.path.join(self.loaded, label))

    def nvm_uber(self, version, node_ok=True):
        root = self.live(f".nvm/versions/node/{version}")
        os.makedirs(os.path.join(root, "bin"))
        js = os.path.join(root, "lib/node_modules/@crafter/uber-cli/bin/uber.js")
        os.makedirs(os.path.dirname(js))
        with open(js, "w") as fh:
            fh.write("// cli\n")
        node = os.path.join(root, "bin/node")
        with open(node, "w") as fh:  # stands in for node: prints the script it was given
            fh.write('#!/bin/sh\necho "node $*"\n')
        os.chmod(node, 0o755 if node_ok else 0o644)
        return node, js

    def calls_log(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as fh:
            return fh.read().splitlines()

    def test_fresh_install_copies_everything_loads_agents_and_smoke_passes(self):
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        for rel in (".local/libexec/mail/mail_oauth.py", ".local/libexec/mail/kc-read",
                    ".local/bin/opencode", ".local/bin/opencode-web", ".local/libexec/opencode/service-bin.zsh",
                    ".local/libexec/card-preview/cardpreview.py", ".local/libexec/qcard/render.py",
                    ".local/bin/toollog", ".local/libexec/toollog/toollog.py",
                    ".local/bin/vp", ".local/libexec/vp/launcher.mjs",
                    ".local/libexec/vp/child.mjs", ".local/libexec/vp/events.mjs", ".local/libexec/vp/worktree.mjs",
                    ".local/libexec/vp/config-snapshot.mjs",
                    ".local/libexec/vp/toolchain-state.mjs", ".local/libexec/vp/toolchain",
                    ".local/libexec/repo-node-pin/shared-deps.sh",
                    ".local/libexec/repo-node-pin/pnpm-bin/pnpm",
                    ".local/bin/qcard", ".local/bin/quint", ".local/bin/himalaya-heal", ".local/bin/mailsearch",
                    ".local/bin/timeout",
                    "Library/LaunchAgents/local.ardud.otp-idle.plist",
                    "Library/LaunchAgents/com.ardud.9router-log-poll.plist",
                    ".local/bin/robob-read-watchdog",
                    "Library/LaunchAgents/com.ardud.robob-read-watchdog.plist",
                    ".local/bin/mirage-beacon-keepalive", ".local/libexec/mirage/clients.py",
                    ".local/libexec/mirage/restart.sh",
                    "Library/LaunchAgents/com.ardud.mirage-beacon-keepalive.plist"):
            self.assertTrue(os.path.isfile(self.live(rel)), rel)
        self.assertTrue(os.access(self.live(".local/bin/qcard"), os.X_OK))
        self.assertTrue(os.access(self.live(".local/bin/opencode"), os.X_OK))
        self.assertEqual(stat.S_IMODE(os.stat(self.live(".local/libexec/opencode/service-bin.zsh")).st_mode), 0o644)
        self.assertTrue(os.access(self.live(".local/bin/quint"), os.X_OK))
        self.assertTrue(os.access(self.live(".local/libexec/vp/toolchain"), os.X_OK))
        self.assertTrue(os.access(self.live(".local/bin/timeout"), os.X_OK))
        loads = [c for c in self.calls_log() if c.startswith("bootstrap")]
        self.assertEqual(len(loads), 15, self.calls_log())
        self.assertTrue(os.access(self.live(".local/bin/mirage-beacon-keepalive"), os.X_OK))
        self.assertFalse(os.path.exists(self.live(".local/state/mirage-beacon-keepalive")))
        self.assertTrue(os.access(self.live(".local/bin/robob-read-watchdog"), os.X_OK))
        self.assertTrue(os.path.isdir(self.live(".local/state/robob-read-watchdog")))
        for rel in (".local/share/juno-proxy/juno_proxy.py", ".local/bin/power-unplug-telegram.sh",
                    ".local/bin/battery-low-telegram.sh", ".local/share/lydia-ticks/server.ts",
                    ".local/share/lydia-ticks/tunnel.sh"):
            self.assertTrue(os.path.isfile(self.live(rel)), rel)
        self.assertTrue(os.access(self.live(".local/bin/power-unplug-telegram.sh"), os.X_OK))
        self.assertEqual(stat.S_IMODE(os.stat(self.live(".local/share/lydia-ticks/server.ts")).st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(os.stat(self.live(".local/share/lydia-ticks/tunnel.sh")).st_mode), 0o700)
        self.assertIn("no Uber CLI under ~/.nvm", err)
        self.assertIn("installed", out)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)  # the wa/mailsend targets and the Uber CLI aren't there yet
        self.assertIn("deploy that integration first", err)
        self.assertNotIn("differs", err)
        self.assertNotIn("not loaded", err)

    def test_vnc_hold_install_and_code_restart(self):
        self.ready()
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        binary = self.live(".local/bin/vnc-hold")
        self.assertTrue(os.access(binary, os.X_OK))
        self.assertTrue(os.path.isdir(self.live("Library/Logs")))
        with open(self.live("Library/LaunchAgents/com.ardud.vnc-hold.plist"), "rb") as source:
            plist = plistlib.load(source)
        self.assertEqual(plist["ProgramArguments"], ["/usr/bin/python3", "-I", binary, "run"])
        self.assertTrue(plist["KeepAlive"])
        self.assertTrue(plist["RunAtLoad"])
        self.assertEqual(plist["ThrottleInterval"], 15)
        # Offline smoke must never connect to Screen Sharing or read Keychain.
        self.assertFalse(os.path.exists(self.live(".local/state/vnc-hold")))
        with open(binary, "a") as out:
            out.write("\n# drift\n")
        os.remove(self.calls)
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        changes = [c for c in self.calls_log() if c.startswith(("kickstart", "bootstrap", "bootout"))]
        self.assertEqual(changes, [f"kickstart -k gui/{os.getuid()}/com.ardud.vnc-hold"])
        self.assertEqual(self.run_install("--check")[0], 0)

    def test_installed_read_watchdog_starts_with_granted_shell(self):
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        with open(self.live("Library/LaunchAgents/com.ardud.robob-read-watchdog.plist"), "rb") as source:
            plist = plistlib.load(source)
        # TCC attributes launchd reads to the entrypoint, even for shell scripts.
        self.assertEqual(plist["ProgramArguments"], [
            "/bin/zsh", "-f", self.live(".local/bin/robob-read-watchdog"),
        ])
        self.assertEqual(plist["StartInterval"], 30)
        self.assertTrue(plist["RunAtLoad"])

    def test_invalid_plist_fails_smoke(self):
        plist = os.path.join(self.pkg, "launchd/com.ardud.opencode-web.plist")
        with open(plist, "w") as out:
            out.write("not a plist\n")
        rc, _, err = self.run_install()
        self.assertEqual(rc, 1, err)
        self.assertIn("smoke failed: plutil -lint", err)
        self.assertIn("com.ardud.opencode-web.plist", err)

    def test_plutil_extract_rejects_missing_key(self):
        _, env = self.argv_env([])
        plist = os.path.join(self.pkg, "launchd/com.ardud.opencode-web.plist")
        result = subprocess.run(["plutil", "-extract", "MissingKey", "raw", plist],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def ready(self):
        """Everything --check wants beyond the payload: deployed helpers and an nvm Uber CLI."""
        helpers = self.live(".local/share/robob-watch/helpers")
        os.makedirs(helpers)
        for name in ("wa", "mailsend"):
            with open(os.path.join(helpers, name), "w") as fh:
                fh.write("#!/bin/sh\n")
            os.chmod(os.path.join(helpers, name), 0o755)
        return self.nvm_uber("v26.2.0")

    def test_image_helper_link_preserves_previous_script_and_dry_run_is_readonly(self):
        script = self.live(".config/opencode/skills/image-generation/scripts/genimg.py")
        os.makedirs(os.path.dirname(script))
        with open(script, "w") as out:
            out.write("old image helper\n")
        rc, _, err = self.run_install("--dry-run")
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.islink(script))
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertEqual(os.readlink(script), self.live(".local/libexec/image-generation/genimg.py"))
        backups = [x for x in os.listdir(os.path.dirname(script)) if x.startswith("genimg.py.bak-")]
        self.assertEqual(len(backups), 1)
        with open(os.path.join(os.path.dirname(script), backups[0])) as old:
            self.assertEqual(old.read(), "old image helper\n")
        for name in ("9router-log-poll", "9router-log-rollup", "rclaude-key-helper"):
            self.assertTrue(os.access(self.live(".local/bin/" + name), os.X_OK))
        self.assertIn("com.ardud.9router-log-poll", os.listdir(self.loaded))

    def test_second_run_changes_nothing_and_check_passes(self):
        self.ready()
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.run_install("--check")[:2], (0, f"local-helpers: live copy matches {self.head()}\n"))
        os.remove(self.calls)
        rc, out, _ = self.run_install()
        self.assertEqual(rc, 0)
        self.assertNotIn("update ", out)
        self.assertIn("(0 files changed)", out)
        self.assertFalse([c for c in self.calls_log() if not c.startswith("print")])

    def head(self):
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "--short", "HEAD"], capture_output=True,
                              text=True).stdout.strip()

    def test_replaced_file_keeps_a_backup_and_its_mode(self):
        self.ready()
        self.run_install()
        kc = self.live(".local/libexec/mail/kc-read")
        with open(kc, "w") as fh:
            fh.write("#!/bin/sh\necho old\n")
        os.chmod(kc, 0o700)
        rc, out, _ = self.run_install("--check")
        self.assertEqual(rc, 1)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn(f"update {kc}", out)
        self.assertEqual(stat.S_IMODE(os.stat(kc).st_mode), 0o700)
        baks = [f for f in os.listdir(os.path.dirname(kc)) if f.startswith("kc-read.bak-")]
        self.assertEqual(len(baks), 1)
        with open(os.path.join(os.path.dirname(kc), baks[0])) as fh:
            self.assertEqual(fh.read(), "#!/bin/sh\necho old\n")
        with open(kc) as fh, open(os.path.join(self.pkg, "libexec/mail/kc-read")) as src:
            self.assertEqual(fh.read(), src.read())
        self.assertEqual(self.run_install("--check")[0], 0)

    def test_new_mail_code_restarts_the_idle_watcher_only(self):
        self.run_install()
        os.remove(self.calls)
        with open(self.live(".local/libexec/mail/mail_oauth.py"), "a") as fh:
            fh.write("\n# drift\n")
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        uid = os.getuid()
        self.assertIn(f"kickstart -k gui/{uid}/local.ardud.otp-idle", self.calls_log())
        self.assertFalse([c for c in self.calls_log() if c.startswith("bootstrap")])

    def test_new_juno_proxy_code_restarts_the_proxy_only(self):
        self.ready()
        self.run_install()
        os.remove(self.calls)
        with open(self.live(".local/share/juno-proxy/juno_proxy.py"), "a") as fh:
            fh.write("\n# drift\n")
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        uid = os.getuid()
        self.assertEqual([c for c in self.calls_log() if c.startswith(("kickstart", "bootstrap", "bootout"))],
                         [f"kickstart -k gui/{uid}/com.abdullah.juno-proxy"])
        self.assertIn("restarted com.abdullah.juno-proxy", out)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 0, err)

    def test_new_lydia_server_code_restarts_the_server_only(self):
        self.ready()
        self.run_install()
        os.remove(self.calls)
        with open(self.live(".local/share/lydia-ticks/server.ts"), "a") as fh:
            fh.write("\n// drift\n")
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        uid = os.getuid()
        self.assertEqual([c for c in self.calls_log() if c.startswith(("kickstart", "bootstrap", "bootout"))],
                         [f"kickstart -k gui/{uid}/com.ardud.lydia-ticks-server"])
        self.assertIn("restarted com.ardud.lydia-ticks-server", out)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 0, err)

    def test_lydia_live_state_is_never_touched(self):
        self.ready()
        state = {"ticks.db": b"SQLite format 3\x00 ticks", "history-token": b"secret-token\n",
                 "tunnel.json": b'{"TunnelID": "abc"}\n'}
        live_dir = self.live(".local/share/lydia-ticks")
        os.makedirs(live_dir)
        for name, data in state.items():
            with open(os.path.join(live_dir, name), "wb") as fh:
                fh.write(data)
            os.chmod(os.path.join(live_dir, name), 0o600)
        before = {n: (open(os.path.join(live_dir, n), "rb").read(),
                      stat.S_IMODE(os.stat(os.path.join(live_dir, n)).st_mode)) for n in state}
        for _ in range(2):
            rc, _, err = self.run_install()
            self.assertEqual(rc, 0, err)
        for name, (data, mode) in before.items():
            path = os.path.join(live_dir, name)
            self.assertEqual(open(path, "rb").read(), data, name)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), mode, name)
        self.assertFalse([f for f in os.listdir(live_dir) if ".bak-" in f])

    def test_failed_proxy_restart_is_reported_by_check_and_redone(self):
        self.run_install()
        with open(self.live(".local/share/juno-proxy/juno_proxy.py"), "a") as fh:
            fh.write("\n# drift\n")
        rc, _, err = self.run_install(kick_fail="1")
        self.assertEqual(rc, 1)
        self.assertIn("com.abdullah.juno-proxy restart failed", err)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("com.abdullah.juno-proxy still runs older code (restart pending)", err)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn("restarted com.abdullah.juno-proxy", out)
        self.assertNotIn("otp-idle", out)

    def test_failed_idle_restart_stays_pending_until_a_later_run_does_it(self):
        self.run_install()
        with open(self.live(".local/libexec/mail/otp-idle.py"), "a") as fh:
            fh.write("\n# drift\n")
        rc, _, err = self.run_install(kick_fail="1")
        self.assertEqual(rc, 1)
        self.assertIn("stays pending", err)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("restart pending", err)
        os.remove(self.calls)
        rc, out, err = self.run_install()  # files already match now
        self.assertEqual(rc, 0, err)
        self.assertIn("restarted local.ardud.otp-idle", out)
        os.remove(self.calls)
        self.run_install()
        self.assertFalse([c for c in self.calls_log() if c.startswith("kickstart")])

    def test_changed_plist_is_reloaded(self):
        self.run_install()
        os.remove(self.calls)
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist, "a") as fh:
            fh.write("<!-- drift -->\n")
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        uid = os.getuid()
        self.assertEqual([c for c in self.calls_log() if not c.startswith("print")],
                         [f"bootout gui/{uid}/local.ardud.otp-watch", f"bootstrap gui/{uid} {plist}"])
        self.assertIn("reloaded local.ardud.otp-watch", out)

    def test_plist_that_wont_load_puts_the_old_one_back_and_a_rerun_recovers(self):
        self.run_install()
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist, "a") as fh:
            fh.write("<!-- old -->\n")
        with open(plist) as fh:
            old = fh.read()
        rc, _, err = self.run_install(fail="local.ardud.otp-watch")
        self.assertEqual(rc, 1)
        self.assertIn("local.ardud.otp-watch failed to load", err)
        with open(plist) as fh:
            self.assertEqual(fh.read(), old)  # the known-good plist is back
        self.assertEqual(self.run_install("--check")[0], 1)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn("reloaded local.ardud.otp-watch", out)
        self.assertTrue(os.path.exists(os.path.join(self.loaded, "local.ardud.otp-watch")))

    def test_an_agent_unloaded_by_hand_is_loaded_again(self):
        self.run_install()
        self.unload("local.ardud.otp-idle")
        rc, err = self.run_install("--check")[0], self.run_install("--check")[2]
        self.assertEqual(rc, 1)
        self.assertIn("local.ardud.otp-idle is not loaded", err)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn("loaded local.ardud.otp-idle", out)

    def test_log_dirs_exist_before_agents_load(self):
        plist_dir = os.path.join(self.pkg, "launchd")
        _, env = self.argv_env([])
        logs = set()
        for f in os.listdir(plist_dir):
            for key in ("StandardOutPath", "StandardErrorPath"):
                r = subprocess.run(["plutil", "-extract", key, "raw", os.path.join(plist_dir, f)],
                                   env=env, capture_output=True, text=True)
                if r.returncode == 0 and r.stdout.strip() != "/dev/null":
                    logs.add(os.path.dirname(r.stdout.strip()))
        self.assertTrue(logs)
        for d in logs:
            self.assertTrue(d.startswith(self.home + "/"), d)
            self.assertFalse(os.path.exists(d), d)
        rc, _, err = self.run_install()  # the fake launchctl refuses a plist whose log dir is missing
        self.assertEqual(rc, 0, err)
        for d in logs:
            self.assertTrue(os.path.isdir(d), d)
        self.assertEqual(sorted(os.listdir(self.loaded)),
                         ["com.abdullah.juno-proxy", "com.ardud.9router-log-poll",
                          "com.ardud.battery-low-telegram", "com.ardud.cards-health",
                          "com.ardud.cards-tunnel", "com.ardud.lydia-ticks-server",
                          "com.ardud.lydia-ticks-tunnel", "com.ardud.mirage-beacon-keepalive", "com.ardud.opencode-web",
                          "com.ardud.power-unplug-telegram", "com.ardud.robob-read-watchdog", "com.ardud.vnc-hold",
                          "local.ardud.mail-token-refresh", "local.ardud.otp-idle", "local.ardud.otp-watch"])

    def test_modes_are_checked_and_repaired_on_their_own(self):
        self.run_install()
        kc = self.live(".local/libexec/mail/kc-read")
        os.chmod(kc, 0o600)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("mode 600, want 700", err)
        rc, out, _ = self.run_install()
        self.assertIn(f"chmod 700 {kc}", out)
        self.assertEqual(stat.S_IMODE(os.stat(kc).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.live(".local/libexec/qcard/render.py")).st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(os.stat(self.live(".local/bin/qcard")).st_mode), 0o755)

    def test_symlinked_destination_becomes_a_real_file_with_the_right_mode(self):
        self.run_install()
        kc = self.live(".local/libexec/mail/kc-read")
        other = self.live("elsewhere")
        shutil.copy(os.path.join(self.pkg, "libexec/mail/kc-read"), other)
        os.chmod(other, 0o755)
        os.remove(kc)
        os.symlink(other, kc)
        self.assertEqual(self.run_install("--check")[0], 1)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.islink(kc))
        self.assertEqual(stat.S_IMODE(os.stat(kc).st_mode), 0o700)
        baks = [f for f in os.listdir(os.path.dirname(kc)) if f.startswith("kc-read.bak-")]
        self.assertTrue(os.path.islink(os.path.join(os.path.dirname(kc), baks[0])))

    def test_ignored_files_in_the_tree_are_not_installed(self):
        with open(os.path.join(self.pkg, "libexec/mail/cached-token.log"), "w") as fh:
            fh.write("secret\n")
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertFalse(os.path.exists(self.live(".local/libexec/mail/cached-token.log")))

    def test_dry_run_writes_nothing(self):
        rc, out, _ = self.run_install("--dry-run")
        self.assertEqual(rc, 0)
        self.assertIn("update ", out)
        self.assertFalse(os.path.exists(self.live(".local/bin")))
        self.assertEqual(self.calls_log(), [])

    def test_uber_wrapper_pins_the_newest_nvm_node_and_runs_with_a_bare_path(self):
        self.nvm_uber("v9.1.0")
        node, js = self.nvm_uber("v26.2.0")
        self.nvm_uber("v24.0.0")
        os.makedirs(self.live(".local/bin"))
        uber = self.live(".local/bin/uber")
        os.symlink(self.live(".nvm/versions/node/v1.0.0/bin/uber"), uber)  # broken link, like 22 Oct
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn(f"wrap {uber}", out)
        self.assertFalse(os.path.islink(uber))
        r = subprocess.run([uber, "--version"], env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
        self.assertEqual(r.stdout.strip(), f"node {js} --version")
        self.assertNotIn("uber", self.run_install("--check")[2])

    def test_uber_wrapper_refuses_ride_requests_while_ordering_is_paused(self):
        self.nvm_uber("v26.2.0")
        os.makedirs(self.live(".local/bin"))
        uber = self.live(".local/bin/uber")
        self.run_install()
        pause = self.live(".local/state/ordering-paused")
        os.makedirs(os.path.dirname(pause), exist_ok=True)
        with open(pause, "w") as fh:
            fh.write("card cancelled by owner 29 Oct\n")
        env = {"PATH": "/usr/bin:/bin", "HOME": self.home}
        r = subprocess.run([uber, "rides", "request"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 4, r.stderr)
        self.assertIn("ORDERING_PAUSED: card cancelled by owner 29 Oct", r.stderr)
        self.assertNotIn("node", r.stdout)
        r = subprocess.run([uber, "rides", "estimate"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("rides estimate", r.stdout)
        os.remove(pause)
        r = subprocess.run([uber, "rides", "request"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("rides request", r.stdout)

    def test_uber_wrapper_never_replaces_someone_elses_file(self):
        self.nvm_uber("v26.2.0")
        os.makedirs(self.live(".local/bin"))
        uber = self.live(".local/bin/uber")
        with open(uber, "w") as fh:
            fh.write("#!/bin/sh\necho mine\n")
        rc, _, err = self.run_install()
        self.assertIn("someone else's file", err)
        with open(uber) as fh:
            self.assertEqual(fh.read(), "#!/bin/sh\necho mine\n")

    def test_pnpm_guard_payload_is_copied_and_checked_for_drift(self):
        self.ready()
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.run_install("--check")[0], 0)
        for name in ("shared-deps.sh", "pnpm-bin/pnpm"):
            with self.subTest(name=name):
                target = self.live(".local/libexec/repo-node-pin/" + name)
                with open(target, "a") as fh:
                    fh.write("\n# drift\n")
                rc, _, err = self.run_install("--check")
                self.assertEqual(rc, 1)
                self.assertIn(target + " differs", err)
                self.assertEqual(self.run_install()[0], 0)

    def test_quint_guard_link_is_idempotent_and_check_reports_drift(self):
        self.ready()
        guard = self.live(".local/share/quint-guard/bin/quint")
        target = self.live(".local/bin/quint")
        self.assertEqual(self.run_install("--dry-run")[0], 0)
        self.assertFalse(os.path.lexists(guard))
        rc, _, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertEqual(os.readlink(guard), target)
        self.assertEqual(os.listdir(os.path.dirname(guard)), ["quint"])
        self.assertEqual(self.run_install("--check")[0], 0)
        self.assertEqual(self.run_install()[0], 0)
        os.unlink(guard)
        os.symlink("/missing/quint", guard)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("is not a link to " + target, err)
        self.assertEqual(self.run_install()[0], 0)
        self.assertEqual(os.readlink(guard), target)

    def test_links_point_at_deployed_helpers_but_never_replace_a_real_file(self):
        helpers = self.live(".local/share/robob-watch/helpers")
        os.makedirs(helpers)
        for name in ("wa", "mailsend"):
            with open(os.path.join(helpers, name), "w") as fh:
                fh.write("#!/bin/sh\n")
            os.chmod(os.path.join(helpers, name), 0o755)
        os.makedirs(self.live(".local/bin"))
        with open(self.live(".local/bin/wa"), "w") as fh:
            fh.write("real file\n")
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertEqual(os.readlink(self.live(".local/bin/mailsend")), os.path.join(helpers, "mailsend"))
        self.assertFalse(os.path.islink(self.live(".local/bin/wa")))
        self.assertIn("not replacing it with a link", err)
        self.assertEqual(self.run_install("--check")[0], 1)

    def test_a_run_that_dies_after_a_plist_landed_still_reloads_it_next_time(self):
        self.ready()
        self.run_install()
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist) as fh:
            text = fh.read()
        self.assertIn("<integer>30</integer>", text)
        with open(plist, "w") as fh:  # the loaded job still runs this older plist
            fh.write(text.replace("<integer>30</integer>", "<integer>60</integer>"))
        qcard = self.live(".local/libexec/qcard")
        with open(os.path.join(qcard, "render.py"), "a") as fh:
            fh.write("\n# drift\n")
        os.chmod(qcard, 0o555)  # render.py is copied after the plists, and that copy fails
        os.remove(self.calls)
        try:
            rc, _, _ = self.run_install()
        finally:
            os.chmod(qcard, 0o755)
        self.assertNotEqual(rc, 0)
        with open(plist) as fh:
            self.assertIn("<integer>30</integer>", fh.read())  # new plist on disk, never reloaded
        self.assertFalse([c for c in self.calls_log() if c.startswith(("bootout", "bootstrap"))])
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("local.ardud.otp-watch still runs an older plist", err)
        os.remove(self.calls)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn("reloaded local.ardud.otp-watch", out)
        uid = os.getuid()
        self.assertIn(f"bootstrap gui/{uid} {plist}", self.calls_log())
        self.assertEqual(self.run_install("--check")[0], 0)

    def wait_for(self, path, seconds=30):
        end = time.time() + seconds
        while not os.path.exists(path):
            self.assertLess(time.time(), end, f"timed out waiting for {path}")
            time.sleep(0.05)

    def test_a_second_install_waits_for_the_one_that_is_running(self):
        self.ready()
        self.run_install()
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist) as fh:
            text = fh.read()
        with open(plist, "w") as fh:  # disk and the loaded job hold an older plist
            fh.write(text.replace("<integer>30</integer>", "<integer>60</integer>"))
        loaded_bytes = os.path.join(self.home, "loaded-bytes")
        os.makedirs(loaded_bytes)
        pause = os.path.join(self.home, "pause")
        a = self.start_install(pause=pause, bytes=loaded_bytes)
        try:
            self.wait_for(pause + ".reached")  # A copied the new plist and is in the middle of reloading it
            other_calls = os.path.join(self.home, "launchctl-b.log")
            rc, _, err = self.run_install(lock_wait=1, calls=other_calls)
            self.assertEqual(rc, 1)
            self.assertIn("another install.zsh is still running", err)
            self.assertFalse(os.path.exists(other_calls))  # it didn't touch launchd
            c = self.start_install(bytes=loaded_bytes)
            time.sleep(1)
            self.assertIsNone(c.poll())  # waits instead of copying or reloading next to A
        finally:
            with open(pause + ".go", "w"):
                pass
        _, a_err = a.communicate(timeout=120)
        _, c_err = c.communicate(timeout=120)
        self.assertEqual(a.returncode, 0, a_err)
        self.assertEqual(c.returncode, 0, c_err)
        self.assertIn("waiting for another install.zsh to finish", c_err)
        with open(plist) as fh, open(os.path.join(loaded_bytes, "local.ardud.otp-watch.plist")) as lf:
            self.assertEqual(lf.read(), fh.read())  # what launchd loaded last is what is on disk
        self.assertEqual(self.run_install("--check")[0], 0)

    def test_a_resumed_reload_that_fails_falls_back_to_the_plist_launchd_ran_before(self):
        self.ready()
        self.run_install()
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist) as fh:
            text = fh.read()
        old = text.replace("<integer>30</integer>", "<integer>60</integer>")
        with open(plist, "w") as fh:  # the loaded job runs this older plist
            fh.write(old)
        qcard = self.live(".local/libexec/qcard")
        with open(os.path.join(qcard, "render.py"), "a") as fh:
            fh.write("\n# drift\n")
        os.chmod(qcard, 0o555)  # the first run copies the new plist, then dies copying render.py
        try:
            rc, _, _ = self.run_install()
        finally:
            os.chmod(qcard, 0o755)
        self.assertNotEqual(rc, 0)
        time.sleep(1.1)  # the retry gets its own backup stamp
        loaded_bytes = os.path.join(self.home, "loaded-bytes")
        os.makedirs(loaded_bytes)
        # The retry finds the new plist already on disk; launchd refuses it but still takes the old one.
        rc, _, err = self.run_install(fail_if="local.ardud.otp-watch:<integer>30</integer>", bytes=loaded_bytes)
        self.assertEqual(rc, 1)
        self.assertIn("the previous one is back", err)
        self.assertTrue(os.path.exists(os.path.join(self.loaded, "local.ardud.otp-watch")))
        with open(plist) as fh:
            self.assertEqual(fh.read(), old)
        with open(os.path.join(loaded_bytes, "local.ardud.otp-watch.plist")) as fh:
            self.assertEqual(fh.read(), old)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("otp-watch.plist differs", err)
        rc, out, err = self.run_install(bytes=loaded_bytes)
        self.assertEqual(rc, 0, err)
        self.assertIn("reloaded local.ardud.otp-watch", out)
        with open(os.path.join(loaded_bytes, "local.ardud.otp-watch.plist")) as fh:
            self.assertIn("<integer>30</integer>", fh.read())
        self.assertEqual(self.run_install("--check")[0], 0)

    def test_a_marker_that_doesnt_name_a_backup_leaves_the_running_job_alone(self):
        self.ready()
        self.run_install()
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist) as fh:
            text = fh.read()
        with open(plist + ".bak-20261001-000000", "w") as fh:  # what launchd runs, but nothing says so
            fh.write(text.replace("<integer>30</integer>", "<integer>60</integer>"))
        mark = self.live(".local/state/local-helpers/reload-local.ardud.otp-watch")
        with open(mark, "w"):  # an empty marker, as an earlier installer wrote them
            pass
        os.remove(self.calls)
        rc, _, err = self.run_install(fail_if="local.ardud.otp-watch:<integer>30</integer>")
        self.assertEqual(rc, 1)
        self.assertIn("doesn't say which plist launchd runs, so the job is left running", err)
        self.assertFalse([c for c in self.calls_log() if c.startswith(("bootout", "bootstrap"))])
        self.assertTrue(os.path.exists(os.path.join(self.loaded, "local.ardud.otp-watch")))
        self.assertTrue(os.path.exists(mark))
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn("local.ardud.otp-watch still runs an older plist", err)

    def test_two_runs_in_the_same_second_keep_the_backup_a_pending_reload_needs(self):
        self.ready()
        self.run_install()
        plist = self.live("Library/LaunchAgents/local.ardud.otp-watch.plist")
        with open(plist) as fh:
            text = fh.read()
        old = text.replace("<integer>30</integer>", "<integer>60</integer>")
        with open(plist, "w") as fh:  # the loaded job runs this older plist
            fh.write(old)
        qcard = self.live(".local/libexec/qcard")
        with open(os.path.join(qcard, "render.py"), "a") as fh:
            fh.write("\n# drift\n")
        os.chmod(qcard, 0o555)  # the first run copies the 30s plist, then dies copying render.py
        try:
            rc, _, _ = self.run_install(stamp="20261023-120000")
        finally:
            os.chmod(qcard, 0o755)
        self.assertNotEqual(rc, 0)
        src = os.path.join(self.pkg, "launchd/local.ardud.otp-watch.plist")
        with open(src) as fh:
            src_text = fh.read()
        with open(src, "w") as fh:  # the next run brings a 15s plist, and launchd refuses it
            fh.write(src_text.replace("<integer>30</integer>", "<integer>15</integer>"))
        loaded_bytes = os.path.join(self.home, "loaded-bytes")
        os.makedirs(loaded_bytes)
        rc, _, err = self.run_install(stamp="20261023-120000", bytes=loaded_bytes,
                                      fail_if="local.ardud.otp-watch:<integer>15</integer>")
        self.assertEqual(rc, 1)
        self.assertIn("the previous one is back", err)
        with open(plist) as fh:
            self.assertEqual(fh.read(), old)  # the plist launchd ran before either run
        with open(os.path.join(loaded_bytes, "local.ardud.otp-watch.plist")) as fh:
            self.assertEqual(fh.read(), old)
        with open(plist + ".bak-20261023-120000") as fh:
            self.assertEqual(fh.read(), old)  # the first run's backup is untouched

    def test_install_refuses_uncommitted_or_unpushed_payload(self):
        bare = os.path.join(self.home, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", bare], check=True, capture_output=True)
        self.git("remote", "add", "origin", bare)
        self.git("push", "-q", "origin", "HEAD:main")
        cache = os.path.join(self.pkg, "libexec/qcard/__pycache__")
        os.makedirs(cache)
        with open(os.path.join(cache, "render.cpython-39.pyc"), "w") as fh:
            fh.write("cache\n")
        rc, _, err = self.run_install("--dry-run", allow=False)  # an ignored cache doesn't count
        self.assertEqual(rc, 0, err)
        sneaky = os.path.join(self.pkg, "bin/clean__pycache__")
        with open(sneaky, "w") as fh:
            fh.write("#!/bin/sh\necho hi\n")
        os.chmod(sneaky, 0o755)
        rc, _, err = self.run_install(allow=False)
        self.assertEqual(rc, 1)
        self.assertIn("uncommitted changes", err)
        self.assertFalse(os.path.exists(self.live(".local/bin/clean__pycache__")))
        self.git("add", "local-helpers/bin/clean__pycache__")
        self.git("commit", "-qm", "unpushed")
        rc, _, err = self.run_install(allow=False)
        self.assertEqual(rc, 1)
        self.assertIn("is not on origin/main", err)
        self.assertFalse(os.path.exists(self.live(".local/bin/clean__pycache__")))

    def test_uber_wrapper_mode_drift_is_reported_and_repaired(self):
        self.ready()
        self.assertEqual(self.run_install()[0], 0)
        uber = self.live(".local/bin/uber")
        os.chmod(uber, 0o644)
        rc, _, err = self.run_install("--check")
        self.assertEqual(rc, 1)
        self.assertIn(f"{uber} mode 644, want 755", err)
        rc, out, err = self.run_install()
        self.assertEqual(rc, 0, err)
        self.assertIn(f"chmod 755 {uber}", out)
        self.assertEqual(stat.S_IMODE(os.stat(uber).st_mode), 0o755)
        self.assertEqual(self.run_install("--check")[0], 0)

    def test_uber_wrapper_that_cannot_run_fails_the_smoke_test(self):
        node, _ = self.ready()
        self.assertEqual(self.run_install()[0], 0)
        os.remove(node)  # no nvm Uber CLI left, so nothing rewrites or repairs the wrapper
        os.chmod(self.live(".local/bin/uber"), 0o644)
        rc, _, err = self.run_install()
        self.assertEqual(rc, 1)
        self.assertIn("smoke failed", err)
        self.assertIn(self.live(".local/bin/uber"), err)


class OpenCodeWebTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="opencode-web-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = self.temp.name
        self.served = os.path.join(self.home, "served")
        self.service = self.fake_bin("service binary", "opencode v2.0.22")
        os.makedirs(os.path.join(self.home, "bin"))
        config_dir = os.path.join(self.home, "libexec/opencode")
        os.makedirs(config_dir)
        self.launcher = os.path.join(self.home, "bin/opencode-web")
        self.shim = os.path.join(self.home, "bin/opencode")
        shutil.copy2(os.path.join(HERE, "bin/opencode-web"), self.launcher)
        shutil.copy2(os.path.join(HERE, "bin/opencode"), self.shim)
        self.config = os.path.join(config_dir, "service-bin.zsh")
        with open(os.path.join(HERE, "libexec/opencode/service-bin.zsh")) as fh:
            source = fh.read()
        # Substitute the fixed reference in this copy only; neither launcher has a reference override.
        self.assertEqual(source.count("/Volumes/ExternalSSD/opencode2/current/bin/opencode"), 1)
        source = source.replace("/Volumes/ExternalSSD/opencode2/current/bin/opencode", self.service)
        with open(self.config, "w") as fh:
            fh.write(source)
        self.lsof = os.path.join(self.home, "lsof")
        with open(self.lsof, "w") as fh:
            fh.write("#!/bin/sh\nexit 1\n")
        os.chmod(self.lsof, 0o755)
        self.env = {"HOME": self.home, "PATH": "/usr/bin:/bin:/usr/sbin", "LANG": "en_US.UTF-8",
                    "OPENCODE_WEB_LSOF": self.lsof, "BUN_INSPECT": "must-not-leak"}

    def fake_bin(self, name, version, version_exit=0):
        path = os.path.join(self.home, name)
        with open(path, "w") as fh:
            fh.write(f'''#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\\n' {shlex.quote(version)}
  exit {version_exit}
fi
printf '%s\\n' "$0" "$@" "BUN_INSPECT=${{BUN_INSPECT-unset}}" >> {shlex.quote(self.served)}
exit 42
''')
        os.chmod(path, 0o755)
        return path

    def run_web(self, binary=None):
        env = dict(self.env)
        if binary is not None:
            env["OPENCODE_WEB_BIN"] = binary
        return subprocess.run(["/bin/zsh", "-f", self.launcher], env=env,
                              capture_output=True, text=True, timeout=10)

    def assert_refused(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(os.path.exists(self.served), result.stdout + result.stderr)
        lines = (result.stdout + result.stderr).splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("refusing", lines[0])

    def test_mismatched_override_never_serves(self):
        binary = self.fake_bin("old binary", "1.19.5")
        r = self.run_web(binary)
        self.assert_refused(r)
        self.assertIn("1.19.5", r.stderr)
        self.assertIn("2.0.22", r.stderr)

    def test_matching_versions_exec_with_arguments_and_status(self):
        for version in ("2.0.22", "opencode v2.0.22", "v2.0.23", "2.0.99-beta.1+build.2"):
            with self.subTest(version=version):
                binary = self.fake_bin("override with spaces; dollar$", version)
                r = self.run_web(binary)
                self.assertEqual(r.returncode, 42, r.stdout + r.stderr)
                with open(self.served) as fh:
                    self.assertEqual(fh.read().splitlines(), [binary, "serve", "--hostname", "127.0.0.1",
                                                           "--port", "4096", "BUN_INSPECT=unset"])
                os.remove(self.served)

    def test_default_uses_service_binary_without_a_running_service(self):
        # Fail before running if the fixture did not replace the reference; never invoke a real binary.
        with open(self.config) as fh:
            self.assertIn(self.service, fh.read())
        r = self.run_web()
        self.assertEqual(r.returncode, 42, r.stdout + r.stderr)
        with open(self.served) as fh:
            self.assertEqual(fh.readline().strip(), self.service)

    def test_invalid_or_unavailable_versions_refuse(self):
        cases = [("", 0), ("garbage", 0), ("2.0", 0), ("2.0.22\n1.19.5", 0),
                 ("warning: 2.0.22", 0), ("2.0.22", 1), ("2.1.0", 0), ("12.0.22", 0)]
        for version, code in cases:
            for reference in (False, True):
                with self.subTest(version=version, code=code, reference=reference):
                    self.fake_bin("service binary", version if reference else "opencode v2.0.22", code if reference else 0)
                    binary = self.fake_bin("override", "2.0.22" if reference else version, 0 if reference else code)
                    self.assert_refused(self.run_web(binary))
        self.assert_refused(self.run_web(os.path.join(self.home, "missing")))
        os.remove(self.service)
        self.assert_refused(self.run_web(binary))

    def test_login_environment_cannot_bypass_the_guard_or_leak_inspector(self):
        binary = self.fake_bin("override", "2.0.22")
        with open(os.path.join(self.home, ".zshrc"), "w") as fh:
            fh.write("export BUN_INSPECT=from-login\n")
        r = self.run_web(binary)
        self.assertEqual(r.returncode, 42, r.stdout + r.stderr)
        with open(self.served) as fh:
            self.assertIn("BUN_INSPECT=unset", fh.read())
        os.remove(self.served)
        old = self.fake_bin("old binary", "1.19.5")
        with open(os.path.join(self.home, ".zshrc"), "w") as fh:
            fh.write(f"export OPENCODE_WEB_BIN={shlex.quote(old)}\n")
        self.assert_refused(self.run_web(binary))

    def test_waits_for_a_hand_started_server_to_exit(self):
        held = os.path.join(self.home, "held")
        with open(self.lsof, "w") as fh:
            fh.write(f"#!/bin/sh\n[ -e {shlex.quote(held)} ] && exit 1\ntouch {shlex.quote(held)}\nexit 0\n")
        r = self.run_web(self.service)
        self.assertEqual(r.returncode, 42, r.stdout + r.stderr)
        self.assertIn("waiting for it to exit", r.stdout)
        self.assertTrue(os.path.exists(self.served))

    def test_cli_shim_uses_shared_binary_and_forwards_arguments_and_status(self):
        args = ["session", "arg with spaces; dollar$", "--port", "4096"]
        r = subprocess.run([self.shim, *args], env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 42, r.stderr)
        with open(self.served) as fh:
            self.assertEqual(fh.read().splitlines(), [self.service, *args, "BUN_INSPECT=must-not-leak"])

    def test_both_launchers_fail_when_shared_config_is_missing(self):
        os.remove(self.config)
        for launcher in (self.shim, self.launcher):
            with self.subTest(launcher=launcher):
                r = subprocess.run(["/bin/zsh", "-f", launcher], env=self.env,
                                   capture_output=True, text=True, timeout=10)
                self.assertNotEqual(r.returncode, 0)
                self.assertFalse(os.path.exists(self.served))


if __name__ == "__main__":
    unittest.main()
