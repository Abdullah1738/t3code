"""The Mac installer runs only against a fake HOME, local origin and service stubs."""
import contextlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest


REPO = Path(__file__).resolve().parents[3]
OFFBOX = REPO / "integrations/offbox"
HELPERS = REPO / "integrations/local-helpers"
ZSH = shutil.which("zsh")
RSYNC = shutil.which("rsync")
GIT = shutil.which("git")


@unittest.skipUnless(ZSH and RSYNC and GIT, "installer requires zsh, rsync and git")
class InstallTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="offbox-install-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.repo = self.root / "repo"
        self.package = self.repo / "integrations/offbox"
        for relative in ("install.zsh", "lib/toollog.ts", "plugin/offbox-gate.ts", "bin/boat",
                         "launchd/com.ardud.offbox-monitor.plist", "launchd/com.ardud.offbox-home-monitor.plist",
                         "skill/SKILL.md", "skill/scripts/offbox.py", "home-repair/delete-idle-boxes.sh",
                         "home-repair/idle-boxes-list.py"):
            target = self.package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(OFFBOX / relative, target)
        helper_root = self.repo / "integrations/local-helpers"
        for directory in ("opencode-reload", "toollog"):
            shutil.copytree(HELPERS / "libexec" / directory, helper_root / "libexec" / directory,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (helper_root / "bin").mkdir()
        shutil.copy2(HELPERS / "bin/quint", helper_root / "bin/quint")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.root / "loaded").mkdir()
        self.script("git", '''for arg do
  if [ "$arg" = ls-remote ]; then
    echo remote >> "$FIXTURE_GIT_CALLS"
    [ "$FIXTURE_FORBID_REMOTE" != 1 ] || exit 82
  fi
done
exec "$FIXTURE_GIT" "$@"
''')
        self.script("rsync", '''echo rsync >> "$FIXTURE_RSYNC_CALLS"
exec "$FIXTURE_RSYNC" "$@"
''')
        self.script("launchctl", '''echo "$@" >> "$FIXTURE_LAUNCHCTL_CALLS"
case "$1" in
  print) [ -f "$FIXTURE_LOADED/${2##*/}" ] || exit 113 ;;
  bootstrap) touch "$FIXTURE_LOADED/$(basename "$3" .plist)" ;;
  bootout) rm -f "$FIXTURE_LOADED/${2##*/}" ;;
esac
''')
        self.env = {
            **os.environ, "HOME": str(self.home), "ZDOTDIR": str(self.home), "BUN_INSPECT": "",
            "XDG_CONFIG_HOME": str(self.home / ".config"), "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "FIXTURE_GIT": GIT,
            "FIXTURE_GIT_CALLS": str(self.root / "git-calls"), "FIXTURE_FORBID_REMOTE": "",
            "FIXTURE_RSYNC": RSYNC, "FIXTURE_RSYNC_CALLS": str(self.root / "rsync-calls"),
            "FIXTURE_LAUNCHCTL_CALLS": str(self.root / "launchctl-calls"), "FIXTURE_LOADED": str(self.root / "loaded"),
            "TOOLLOG_ROOT": str(self.home / "logs"), "OPENCODE_ALLOW_RELOAD": "", "OPENCODE_RELOAD_WAIT": "0",
            "OPENCODE_RELOAD_INSTANCES": '[{"name":"HOME","url":"http://127.0.0.1:1"},{"name":"BTSE","url":"http://127.0.0.1:1"}]',
        }
        for args in (("init", "-b", "main"), ("config", "user.name", "Test"),
                     ("config", "user.email", "test@example.invalid"), ("config", "commit.gpgsign", "false"),
                     ("add", "."), ("commit", "-m", "fixture"),
                     ("init", "--bare", str(self.root / "origin.git")),
                     ("remote", "add", "origin", str(self.root / "origin.git")), ("push", "origin", "main")):
            self.git(*args)
        self.watched = [self.home / ".config/opencode" / relative
                        for relative in ("lib/toollog.ts", "plugin/offbox-gate.ts")]

    def script(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repo), *args], env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def install(self, *args, env=None):
        return subprocess.run([ZSH, str(self.package / "install.zsh"), *args],
                              env={**self.env, **(env or {})}, capture_output=True, text=True, timeout=15)

    def events(self):
        return [json.loads(line) for log in (self.home / "logs/agent-tools").glob("*.ndjson")
                for line in log.read_text().splitlines()]

    def snapshot(self, paths):
        return [(path, path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns) for path in paths]

    @contextlib.contextmanager
    def busy_service(self):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":{"ses_busy":{"type":"running"}}}')

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
        worker.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}"
            yield {"OPENCODE_RELOAD_INSTANCES": json.dumps([{"name": name, "url": url}
                                                           for name in ("HOME", "BTSE")])}, requests
        finally:
            server.shutdown()
            worker.join()
            server.server_close()

    def test_check_and_dry_run_never_probe_services_or_write_even_with_unpushed_changes(self):
        (self.package / "bin/boat").write_text("unpushed wrapper")
        with self.busy_service() as (env, requests):
            env["FIXTURE_FORBID_REMOTE"] = "1"
            checked = self.install("--check", env=env)
            self.assertEqual(checked.returncode, 1, checked.stderr)
            self.assertIn("skill not installed", checked.stderr)
            preview = self.install("--dry-run", env=env)
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.assertIn("would write", preview.stdout)
            self.assertNotIn("opencode-reload:", preview.stdout)
            self.assertEqual(requests, [])
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertFalse((self.root / "git-calls").exists())
        self.assertFalse((self.root / "launchctl-calls").exists())

    def selective_fixture(self):
        """An installed skill with two files; then one commit that changes both and a second that changes one."""
        lib = self.package / "skill/scripts/lib"
        lib.mkdir()
        (lib / "a.py").write_text("a = 1\n")
        (lib / "b.py").write_text("b = 1\n")
        self.git("add", ".")
        self.git("commit", "-m", "two files")
        self.git("push", "origin", "main")
        self.assertEqual(self.install().returncode, 0)
        base = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], env=self.env,
                              capture_output=True, text=True).stdout.strip()
        (lib / "b.py").write_text("b = 2  # held\n")
        self.git("commit", "-am", "held change")
        held = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], env=self.env,
                              capture_output=True, text=True).stdout.strip()
        (lib / "a.py").write_text("a = 2  # wanted\n")
        self.git("commit", "-am", "wanted change")
        self.git("push", "origin", "main")
        live = self.home / ".config/opencode/skills/remote-compute/scripts/lib"
        return base, held, live

    def test_selective_install_moves_only_named_files_that_are_exactly_at_the_base(self):
        base, held, live = self.selective_fixture()
        dry = self.install(f"--since={held}", "--only=scripts/lib/a.py", "--dry-run")
        self.assertEqual((dry.returncode, (live / "a.py").read_text()), (0, "a = 1\n"), dry.stderr)
        self.assertIn("1 other installed skill file(s) still differ", dry.stdout)
        self.assertFalse((self.home / ".local/share/offbox/backups").exists(), "a dry run keeps no copies")
        done = self.install(f"--since={held}", "--only=scripts/lib/a.py")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(((live / "a.py").read_text(), (live / "b.py").read_text()), ("a = 2  # wanted\n", "b = 1\n"))
        self.assertIn("wanted change", done.stdout)
        self.assertNotIn("held change", done.stdout)
        self.assertIn("1 other installed skill file(s) still differ", done.stdout)
        saved = list((self.home / ".local/share/offbox/backups").glob("only-*/scripts/lib/a.py"))
        self.assertEqual([path.read_text() for path in saved], ["a = 1\n"])
        # The same command again (or after a write that failed halfway) finds the file done.
        again = self.install(f"--since={held}", "--only=scripts/lib/a.py")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("same scripts/lib/a.py", again.stdout)
        self.assertNotIn("previous copies", again.stdout)
        self.assertEqual(len(list((self.home / ".local/share/offbox/backups").glob("only-*"))), 1)
        self.assertEqual([path.name for path in live.iterdir() if path.name not in ("a.py", "b.py")], [])

    def test_selective_install_refuses_a_file_that_would_carry_held_changes_and_writes_nothing(self):
        base, held, live = self.selective_fixture()
        for args, said in (((f"--since={held}", "--only=scripts/lib/a.py", "--only=scripts/lib/b.py"), "is not the"),
                           (("--only=scripts/lib/a.py",), "needs --since"),
                           ((f"--since={held}", "--only=../../outside"), "not a skill file"),
                           ((f"--since={held}", "--only=scripts/lib/a.py", "--allow-unpushed"), "needs --since"),
                           (("--since=nonsense", "--only=scripts/lib/a.py"), "is not a commit")):
            with self.subTest(args=args):
                result = self.install(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(said, result.stderr)
                self.assertEqual(((live / "a.py").read_text(), (live / "b.py").read_text()), ("a = 1\n", "b = 1\n"))
        (live / "a.py").write_bytes(b"a = 1\r\n")
        other_bytes = self.install(f"--since={held}", "--only=scripts/lib/a.py")
        self.assertIn("is not the", other_bytes.stderr, "byte-exact, whatever the repo's line-ending rules")
        (live / "a.py").write_text("a = 1\n")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "a.py").write_text("a = 1\n")
        live.rename(live.with_name("lib.real"))
        live.symlink_to(outside)
        linked = self.install(f"--since={held}", "--only=scripts/lib/a.py")
        self.assertIn("not a skill file", linked.stderr)
        self.assertEqual((outside / "a.py").read_text(), "a = 1\n")
        live.unlink()
        live.with_name("lib.real").rename(live)
        (self.package / "skill/scripts/lib/a.py").write_text("a = 3  # not pushed\n")
        unpushed = self.install(f"--since={held}", "--only=scripts/lib/a.py")
        self.assertNotEqual(unpushed.returncode, 0)
        self.assertEqual((live / "a.py").read_text(), "a = 1\n")

    def test_busy_timeout_precedes_rsync_and_every_package_write(self):
        with self.busy_service() as (env, requests):
            result = self.install(env=env)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("OpenCode sessions busy", result.stderr)
            self.assertEqual(len(requests), 2)
        self.assertFalse((self.home / ".config").exists())
        self.assertFalse((self.home / ".local/bin").exists())
        self.assertFalse((self.home / "Library").exists())
        self.assertFalse((self.root / "rsync-calls").exists())
        self.assertFalse((self.root / "launchctl-calls").exists())
        self.assertEqual(self.events(), [])

    def test_late_source_failure_does_not_write_the_watched_batch(self):
        (self.repo / "integrations/local-helpers/bin/quint").unlink()
        result = self.install("--allow-unpushed")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("missing or unreadable source", result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertFalse((self.root / "rsync-calls").exists())

    def test_changed_batch_logs_once_and_keeps_backups_outside_plugin(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(first.stdout.count("opencode-reload:"), 1)
        self.assertNotIn("needs an OpenCode restart", first.stdout)
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(len(self.events()[0]["props"]["files"]), 2)
        for path, old in zip(self.watched, (b"old lib", b"old gate")):
            path.write_bytes(old)
        updated = self.install()
        self.assertEqual(updated.returncode, 0, updated.stdout + updated.stderr)
        self.assertEqual(updated.stdout.count("opencode-reload:"), 1)
        events = self.events()
        self.assertEqual(len(events), 2)
        self.assertEqual(events[-1]["props"]["installer"], "offbox")
        self.assertEqual(len(events[-1]["props"]["files"]), 2)
        backups = [path for path in (self.home / ".config/opencode/backups/offbox").rglob("*") if path.is_file()]
        self.assertEqual(sorted(path.read_bytes() for path in backups), [b"old gate", b"old lib"])
        self.assertEqual([path.name for path in (self.home / ".config/opencode/plugin").iterdir()], ["offbox-gate.ts"])
        origin_checks = (self.root / "git-calls").read_text().splitlines()
        checked = self.install("--check")
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(len((self.root / "git-calls").read_text().splitlines()), len(origin_checks) + 1)
        before = self.snapshot(self.watched)
        (self.repo / "unrelated.txt").write_text("unpushed head")
        self.git("add", ".")
        self.git("commit", "-m", "unpushed fixture")
        checked = self.install("--check")
        self.assertEqual(checked.returncode, 1, checked.stdout + checked.stderr)
        self.assertIn("not on origin/main", checked.stderr)
        self.assertEqual(self.snapshot(self.watched), before)
        self.assertEqual(len(self.events()), 2)

    def test_unchanged_watched_files_preserve_inode_and_mtime_without_probes(self):
        with self.busy_service() as (env, requests):
            first = self.install("--allow-reload", env=env)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertTrue(self.events()[0]["props"]["allow_reload"])
            for path in self.watched:
                os.utime(path, (1_700_000_000, 1_700_000_000))
            before = self.snapshot(self.watched)
            second = self.install(env=env)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertNotIn("opencode-reload:", second.stdout)
            self.assertEqual(self.snapshot(self.watched), before)
            self.assertEqual(len(requests), 2)
        self.assertEqual(len(self.events()), 1)
        self.assertFalse((self.home / ".config/opencode/backups").exists())

    def test_environment_override_allows_one_busy_batch(self):
        with self.busy_service() as (env, requests):
            result = self.install(env={**env, "OPENCODE_ALLOW_RELOAD": "1"})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(requests), 2)
        self.assertEqual(result.stdout.count("opencode-reload:"), 1)
        self.assertEqual(len(self.events()), 1)
        self.assertTrue(self.events()[0]["props"]["allow_reload"])


if __name__ == "__main__":
    unittest.main()
