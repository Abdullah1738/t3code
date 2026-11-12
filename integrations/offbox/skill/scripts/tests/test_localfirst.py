"""Offline tests: which offbox runs go local-first, how a local run is sandboxed and how it reports back."""
import contextlib
import io
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, fallback, localfirst, runs  # noqa: E402
from offbox_lib.common import OffboxError  # noqa: E402
from test_capacity import Isolated  # noqa: E402

REAL_CPU_BUSY = localfirst._cpu_busy  # setUps patch it; one test reads the real meter

LOCAL = [
    "go test ./internal/domain/settlement -run TestSettle -count=1 -v",
    "go test -count=1 -run '^TestR3Manifest$' -v ./pkg",
    "go vet ./internal/domain/cache/accountstate/ ./internal/app/",
    "go vet ./tests/domain/fdbgc/ && go test ./tests/domain/fdbgc/ -run X",
    "bash -c 'go vet ./pkg 2>&1 | grep -v ^# | head -20'",
    "sh -c 'go test ./tests/domain/taskscan/ -run FUND007 -count=1 -v 2>&1 | tail -40'",
    "bash -o pipefail -c 'go test ./pkg -run X -count=1 | sed -n 1,40p'",
    "bash -c 'go test ./pkg -run X 2>&1 | tail -5; exit ${PIPESTATUS[0]}'",
    "set -o pipefail; go test ./pkg -run X | tail -3",
    "gofmt -l internal/app tests/domain",
    "go build -o /dev/null ./cmd/server",
    "go build -o /dev/null ./cmd/server/a.go",
    "go test ./pkg -run X -count=1 2>&1 | tee /tmp/out.log | tail -5",
    "go test ./pkg -run X > /tmp/o.log 2>&1; grep -c PASS /tmp/o.log",
    "GOFLAGS=-mod=readonly go test ./pkg -run TestX",
    "GOTOOLCHAIN=go1.26.9 go test ./pkg -run TestX -timeout 120s",
    "go test ./pkg -run X -tags integration -race -shuffle on",
    "go version && go env GOPATH",
    "go list -m all | head",
    "time go vet ./pkg",
]

REMOTE = [
    "go test ./...",
    "go test ./internal/services/trading",  # no -run: whole package
    "go vet ./internal/... ./tests/...",
    "go vet ./a ./b ./c ./d",
    "go test -race -count=20 -run X ./pkg",
    "go test -run X -test.count=50 ./pkg",
    "go build ./cmd/server",  # leaves a binary in the repo
    "go build ./cmd/server/a.go ./cmd/server/b.go",
    "gofmt -w internal/app",
    "go test ./pkg -run X > results.txt",
    "go test ./pkg -run X 2> err.txt",
    "go test ./pkg -run X & wait",
    "grep FAIL /tmp/shard2.log",  # reads a file an earlier box run wrote
    "cat < /tmp/shard2.log",
    'go version; cat /tmp/"previous-log"',
    "go version; cat /tmp/out; echo x > /tmp/out",  # read before the write
    "echo $(cat /tmp/p) && go vet ./pkg",
    "go test ./pkg -run X; cat /proc/meminfo",
    "docker run --rm postgres:16 && go test ./pkg -run X",
    "python3 -c 'print(1)'",
    "uv run pytest tests/test_a.py",
    "node --test scripts/test-x.mjs",
    "make check",
    "bash .gate.sh",
    "./scripts/check.sh && go test ./pkg -run X",
    "python3 - <<'PY'\nimport subprocess\nPY",
    "go test ./pkg -run X -exec sudo",
    "go test ./pkg -run X --exec=/bin/sh",
    "go test ./pkg -run X -toolexec=/tmp/x",
    "go test ./pkg -run X -coverprofile=c.out",
    "go test ./pkg -run X -o bin.test",
    "go test ./pkg -run X -timeout 0",
    "go test ./pkg -run X -gcflags='-asmhdr=generated.h'",
    "go test ./pkg -run X -ldflags='-linkmode=external -extld=/usr/bin/true'",
    "go test ./pkg -run X -tags linux",
    "go test ./pkg -run X -vet=-printf",
    "go vet -vettool=/tmp/v ./pkg",
    "go mod download && go test ./pkg -run X",
    "go test ./pkg -run X $(cat /tmp/pkgs)",
    "GOFLAGS=-toolexec=/tmp/x go test ./pkg -run X",
    "GOFLAGS=$'-exec=/usr/bin/true' go test ./pkg -run X",
    "X=-exec=/usr/bin/true; GOFLAGS=$X go test ./pkg -run X",
    "env GOFLAGS=-exec=sh go test ./pkg -run X",
    "export GOFLAGS=-exec=sh; go test ./pkg -run X",
    "go version; printf -v GOFLAGS '%s' '-exec=/usr/bin/true'; export GOFLAGS",
    "GOWORK=/tmp/go.work go vet ./pkg",
    "GOTOOLCHAIN=path go vet ./pkg",
    "CC=/tmp/evil go test ./pkg -run X",
    "PATH=/tmp:$PATH go test ./pkg -run X",
    "KAFKA_BROKERS=localhost:9092 go test ./pkg -run X",
    "set -a; go test ./pkg -run X",
    "set -o allexport; DATABASE_URL=postgres://prod; go test ./pkg -run X",
    "bash -lc 'go version'",
    'go version; echo "${x:-$(/usr/bin/printf RAN)}"',
    'go version; echo PROOF > "/tmp/."/../Users/someone/target',
    "go test ./pkg -run X > /tmp/../etc/x",
    "(cd pkg); go vet ../outside",
    "cd / && go test ./pkg -run X",
    "cd pkg && go test . -run X",
    "go test ../../other/pkg -run X",
    "go test /abs/pkg -run X",
    "go test github.com/x/y -run X",
    "go test ./pkg -run X | sed -i s/a/b/ f.go",
    "go test ./pkg -run X | sed 's/a/b/w out.txt'",
    "go test ./pkg -run X | sed 's/\\s//'",
    "go test ./pkg -run X | awk '{print > \"f\"}'",
    "go version; awk -v x=1 'BEGIN {system(\"id\")}'",
    "go test ./pkg -run X | sort -o out.txt",
    "go version; sort -ro owned",
    "go test ./pkg -run X | uniq - out.txt",
    "go test ./pkg -run X | tee out.txt",
    "go test ./pkg -run X | head -n -1",
    "go test ./pkg -run X | cat -A",
    "tail -f /tmp/x.log",
    "for p in a b; do go test ./$p -run X; done",
    "go test ./a ./b ./c -run X && go vet ./d ./e ./f && go vet ./g",
    "echo \"$(go test ./pkg -run X > out)\"",
    "go test ./pkg -run X | xargs rm",
    "git diff --ext-diff && go vet ./pkg",
    "git checkout main && go vet ./pkg",
]


def make_repo(d):
    Path(d, "go.mod").write_text("module example.com/x\n\ngo 1.24\n")
    for p in ("pkg", "cmd/server", "internal/app"):
        Path(d, p).mkdir(parents=True, exist_ok=True)
        Path(d, p, "a.go").write_text("package x\n")


def ctx_for(d, includes=()):
    root = os.path.realpath(d)
    return {"root": root, "cwd": root, "start": root, "includes": list(includes),
            "n": {"pkgs": 0, "go": 0, "checks": 0}, "written": set()}


class EligibleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        make_repo(self.d)

    def why(self, cmd, **kw):
        return localfirst.eligible(cmd, ctx_for(self.d, **kw))

    def test_light_go_checks_go_local(self):
        for cmd in LOCAL:
            self.assertIsNone(self.why(cmd), cmd)

    def test_everything_else_stays_remote(self):
        for cmd in REMOTE:
            self.assertIsNotNone(self.why(cmd), cmd)

    def test_write_calls_are_noticed_whatever_the_spelling(self):
        cases = {
            'import "os"\nfunc init() { _ = os.WriteFile("f", nil, 0o600) }': 1,
            'import "os"\nfunc init() { _ = os.WriteFile ("f", nil, 0o600) }': 1,
            'import fs "os"\nfunc init() { _ = fs.WriteFile("f", nil, 0o600) }': 1,
            'import "os"\nvar w = os.Create': 1,
            'import "os"\nfunc init() { _, _ = os.ReadFile("f") }': 0,
        }
        for body, writes in cases.items():
            Path(self.d, "pkg", "w_test.go").write_text("package x\n\n" + body + "\n")
            ctx = ctx_for(self.d)
            self.assertIsNone(localfirst.eligible("go test ./pkg -run X", ctx), body)
            self.assertEqual(ctx["n"].get("writes", 0), writes, body)

    def test_testcontainers_package_stays_remote(self):
        Path(self.d, "go.mod").write_text("module x\n\nrequire github.com/testcontainers/testcontainers-go v0.30.0\n")
        Path(self.d, "pkg", "x_test.go").write_text('package pkg\nimport _ "github.com/testcontainers/testcontainers-go"\n')
        self.assertIsNotNone(self.why("go test ./pkg -run TestX"))
        self.assertIsNone(self.why("go test ./internal/app -run TestX"))

    def test_os_or_arch_specific_code_stays_remote(self):
        Path(self.d, "pkg", "clock_linux.go").write_text("package pkg\n")
        self.assertIn("OS- or arch-specific", self.why("go vet ./pkg"))
        # ... also when only an imported module package has it
        Path(self.d, "internal/app/a.go").write_text('package app\n\nimport _ "example.com/x/pkg"\n')
        self.assertIn("OS- or arch-specific", self.why("go vet ./internal/app"))
        Path(self.d, "pkg", "clock_linux.go").unlink()
        Path(self.d, "pkg", "os_darwin.go").write_text("package pkg\n")
        self.assertIn("OS- or arch-specific", self.why("go vet ./internal/app"))
        Path(self.d, "pkg", "os_darwin.go").unlink()
        Path(self.d, "pkg", "b_test.go").write_text("//go:build linux && integration\n\npackage pkg\n")
        self.assertIn("build tag", self.why("go test ./pkg -run X"))
        self.assertIsNone(self.why("go vet ./internal/app"))  # an imported package's tests don't matter

    def test_dotenv_reader_needs_an_env_include(self):
        Path(self.d, "pkg", "env_test.go").write_text('package pkg\nvar p = "../../configs/.env"\n')
        self.assertIn(".env", self.why("go test ./pkg -run X"))
        self.assertIn(".env", self.why("go test ./pkg -run X", includes=["testdata/server.key"]))
        self.assertIsNone(self.why("go test ./pkg -run X", includes=["configs/.env"]))
        Path(self.d, "pkg", "env_test.go").write_text("package pkg\nfunc init() { godotenv.Load() }\n")
        self.assertIn(".env", self.why("go test ./pkg -run X"))

    def test_symlink_out_of_the_repo_stays_remote(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        Path(outside.name, "a.go").write_text("package o\n")
        os.symlink(outside.name, os.path.join(self.d, "link"))
        self.assertIn("outside", self.why("go test ./link -run X"))

    def test_gnu_grep_needed_for_grep_p(self):
        with patch.object(localfirst.os.path, "isdir", return_value=False):
            self.assertIsNotNone(self.why("go version | grep -P 'go[0-9]'"))

    def test_local_replace_and_nested_module_stay_remote(self):
        gomod = Path(self.d, "go.mod")
        gomod.write_text(gomod.read_text() + "replace example.com/dep => ../dep\n")
        self.assertIn("local path", self.why("go vet ./pkg"))
        gomod.write_text("module example.com/x\n\ngo 1.24\n")
        Path(self.d, "tools").mkdir()
        Path(self.d, "tools", "go.mod").write_text("module example.com/tools\n")
        Path(self.d, "tools", "t.go").write_text("package tools\n")
        self.assertIn("nested module", self.why("go vet ./tools"))
        self.assertIsNone(self.why("go vet ./pkg"))

    def test_tmp_path_only_as_a_file_argument(self):
        ok = "go vet ./pkg > /tmp/v.log 2>&1; grep -c x /tmp/v.log; head -5 /tmp/v.log; test -s /tmp/v.log"
        self.assertIsNone(self.why(ok))
        for cmd in ("go vet ./pkg > /tmp/v.log; grep -q /tmp/v.log /tmp/v.log",
                    "go vet ./pkg > /tmp/v.log; echo see /tmp/v.log",
                    "go vet ./pkg > /tmp/v.log; sed -n 1p /tmp/v.log/x",
                    "go vet ./pkg > /tmp/a/v.log"):
            self.assertIsNotNone(self.why(cmd), cmd)


class DecideTests(Isolated):
    def setUp(self):
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        make_repo(tmp.name)
        self.cwd = os.path.realpath(tmp.name)
        self.me = dict(self.me, repo_root=self.cwd)
        for p in (patch.object(localfirst.os, "getloadavg", return_value=(1.0, 1.0, 1.0)),
                  patch.object(localfirst, "_cpu_busy", return_value=0.1)):
            p.start()
            self.addCleanup(p.stop)

    def args(self, argv):
        a = cli.build_parser().parse_args(["run"] + argv)
        a.steps = list(a.step)
        if a.cmd and a.cmd[0] == "--":
            a.cmd = a.cmd[1:]
        return a

    def test_go_work_above_the_repo_is_ignored(self):
        outer = tempfile.TemporaryDirectory()
        self.addCleanup(outer.cleanup)
        repo = os.path.join(os.path.realpath(outer.name), "repo")
        os.makedirs(repo)
        make_repo(repo)
        Path(outer.name, "go.work").write_text("go 1.24\nuse ./repo\nuse ./sibling\n")
        a = cli.build_parser().parse_args(["run", "--", "go", "version"])
        old = os.getcwd()
        self.addCleanup(os.chdir, old)
        os.chdir(os.path.join(repo, "pkg"))
        self.assertEqual(localfirst.local_env(a, "run-x", "/nonexistent", repo).get("GOWORK"), "off")
        Path(repo, "go.work").write_text("go 1.24\nuse .\n")  # the repo's own workspace is synced: keep it
        self.assertNotIn("GOWORK", localfirst.local_env(a, "run-x", "/nonexistent", repo))

    def test_flags_and_overrides_force_remote(self):
        self.assertIsNone(localfirst.decide(self.args(["--", "go", "vet", "./pkg"]), self.me, self.cwd))
        self.assertIsNone(localfirst.decide(self.args(["--size", "large", "--git", "--", "go", "vet", "./pkg"]),
                                            self.me, self.cwd))
        for flags in (["--remote"], ["--bg"], ["--no-sync"], ["--fresh"], ["--pull", "x"], ["--base", "b"],
                      ["--env", "AWS_PROFILE"], ["--env", "DATABASE_URL=x"], ["--env", "GOFLAGS=-exec=/usr/bin/true"],
                      ["--env", "GOWORK=/tmp/w"]):
            self.assertIsNotNone(localfirst.decide(self.args(flags + ["--", "go", "vet", "./pkg"]), self.me, self.cwd),
                                 flags)
        with patch.dict(os.environ, {"OFFBOX_LOCAL_FIRST": "0"}):
            self.assertEqual(localfirst.decide(self.args(["--", "go", "vet", "./pkg"]), self.me, self.cwd),
                             "forced remote")

    def test_inherited_goflags_are_checked(self):
        a = self.args(["--", "go", "test", "./pkg", "-run", "X"])
        with patch.dict(os.environ, {"GOFLAGS": "-exec=/usr/bin/true"}):
            self.assertIn("GOFLAGS", localfirst.decide(a, self.me, self.cwd))
        with patch.dict(os.environ, {"GOFLAGS": "-mod=readonly"}):
            self.assertIsNone(localfirst.decide(a, self.me, self.cwd))

    def test_needs_a_go_check_inside_the_repo(self):
        self.assertEqual(localfirst.decide(self.args(["--", "echo", "ok"]), self.me, self.cwd),
                         "nothing to check locally")
        self.assertIn("outside", localfirst.decide(self.args(["--", "go", "vet", "./pkg"]), self.me, "/"))

    def test_every_step_must_qualify(self):
        ok = self.args(["--step", "gofmt -l .", "--step", "go test ./pkg -run X"])
        self.assertIsNone(localfirst.decide(ok, self.me, self.cwd))
        mixed = self.args(["--step", "go vet ./pkg", "--step", "uv run pytest tests/test_a.py"])
        self.assertIsNotNone(localfirst.decide(mixed, self.me, self.cwd))
        many = self.args(["--step", "go vet ./a ./b ./c", "--step", "go vet ./d ./e ./f", "--step", "go vet ./g"])
        self.assertIn("too many", localfirst.decide(many, self.me, self.cwd))
        # a /tmp file written by an earlier step may be read by a later one
        chained = self.args(["--step", "go vet ./pkg 2> /tmp/v.log", "--step", "grep -c x /tmp/v.log"])
        self.assertIsNone(localfirst.decide(chained, self.me, self.cwd))

    def test_busy_mac_or_recent_docker_stays_remote(self):
        a = self.args(["--", "go", "vet", "./pkg"])
        cpus = os.cpu_count() or 8
        with patch.object(localfirst.os, "getloadavg", return_value=(999.0, 1.0, 1.0)):
            self.assertIsNone(localfirst.decide(a, self.me, self.cwd))  # a one-minute spike is fine
        # macOS load counts blocked threads: high load with idle CPUs still runs here, busy CPUs don't
        with patch.object(localfirst.os, "getloadavg", return_value=(30.0, 2.0 * cpus, 30.0)):
            self.assertIsNone(localfirst.decide(a, self.me, self.cwd))
            with patch.object(localfirst, "_cpu_busy", return_value=0.95):
                self.assertIn("cpu", localfirst.decide(a, self.me, self.cwd))
            with patch.object(localfirst, "_cpu_busy", return_value=None):  # can't read CPU: old load rule
                self.assertIn("load", localfirst.decide(a, self.me, self.cwd))
        with patch.object(localfirst.os, "getloadavg", return_value=(5.0, 4.0 * cpus, 1.0)):
            self.assertIn("load", localfirst.decide(a, self.me, self.cwd))
        busy = REAL_CPU_BUSY(0.05)
        self.assertTrue(busy is None or 0.0 <= busy <= 1.0)
        # a long Docker run that started 3 h ago but ended a minute ago still counts (docker=1: it started a
        # container; runs.finish clears the flag for runs that didn't)
        self.con.execute("""INSERT INTO runs(run_id,repo_root,mode,status,start_at,end_at,cmd,docker)
            VALUES ('d',?,'fg','done',strftime('%s','now')-10800,strftime('%s','now')-60,'docker run -d pg',1)""",
                         (self.cwd,))
        self.con.commit()
        self.assertIn("docker", localfirst.decide(a, self.me, self.cwd))

    def test_docker_column_counts_without_docker_in_the_command(self):
        a = self.args(["--", "go", "vet", "./pkg"])
        self.con.execute("""INSERT INTO runs(run_id,repo_root,mode,status,start_at,cmd,docker)
            VALUES ('d',?,'fg','running',strftime('%s','now')-60,'go test ./integration/...',1)""", (self.cwd,))
        self.con.commit()
        self.assertIn("docker", localfirst.decide(a, self.me, self.cwd))

    def test_decide_crash_goes_remote(self):
        a = cli.build_parser().parse_args(["run", "--", "go", "vet", "./pkg"])
        with patch.object(localfirst, "decide", side_effect=RuntimeError("boom")), \
                patch.object(runs, "run_remote", return_value=0) as remote:
            self.assertEqual(cli.cmd_run(a, self.me), 0)
        remote.assert_called_once()


class RunTests(Isolated):
    def setUp(self):
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        make_repo(tmp.name)
        self.cwd = os.path.realpath(tmp.name)
        self.me = dict(self.me, repo_root=self.cwd)
        old = os.getcwd()
        os.chdir(self.cwd)
        self.addCleanup(os.chdir, old)
        # The sandbox can't create Go's cache dirs; a used Mac already has them, a fresh HOME doesn't.
        for d in localfirst._go_paths().values():
            os.makedirs(d, exist_ok=True)
        for p in (patch.object(localfirst.os, "getloadavg", return_value=(1.0, 1.0, 1.0)),
                  patch.object(localfirst, "_cpu_busy", return_value=0.1),
                  patch.object(localfirst, "_nice", lambda: None)):
            p.start()
            self.addCleanup(p.stop)

    def run_cli(self, argv):
        a = cli.build_parser().parse_args(["run"] + argv)
        err = io.StringIO()
        with patch.object(runs, "run_remote", side_effect=AssertionError("went remote")), \
                contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, err.getvalue().strip().splitlines()

    def run_raw(self, cmd, include=()):
        """localfirst.run without the eligibility check: what the sandbox alone allows. rc is "rerun" when the
        sandbox blocked the command (the CLI would rerun it on the box)."""
        a = cli.build_parser().parse_args(["run"] + [f"--include={i}" for i in include] + ["--", cmd])
        a.cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
        out = io.StringIO()
        with contextlib.redirect_stderr(out):
            try:
                rc = localfirst.run(a, self.me, [])
            except localfirst.Rerun:
                rc = "rerun"
        return rc, out.getvalue()

    def last_log(self):
        row = self.con.execute("SELECT log_path FROM runs WHERE mode='local' ORDER BY start_at DESC, rowid DESC")\
            .fetchone()
        return Path(row[0]).read_text()

    def test_local_run_returns_real_exit_and_records_row(self):
        rc, lines = self.run_cli(["--", "bash -c 'go version >/dev/null && exit 3'"])
        self.assertEqual(rc, 3)
        self.assertIn("running on this Mac", lines[0])
        self.assertEqual(lines[-1], "offbox: local exit 3")
        row = self.con.execute("SELECT mode,status,exit_code FROM runs WHERE mode='local'").fetchone()
        self.assertEqual(tuple(row), ("local", "failed", 3))

    def test_local_steps_summary(self):
        rc, lines = self.run_cli(["--step", "go version", "--step", "go env GOOS && false"])
        self.assertEqual(rc, 1)
        self.assertEqual(lines[-2], "offbox: offbox steps: 1 ok, 1 failed (step 2 rc=1)")
        self.assertEqual(lines[-1], "offbox: local exit 1")

    def test_local_pipeline_failure_reaches_cli_and_run_record(self):
        Path(self.cwd, "pkg", "a.go").write_text("package x\n\nthis is invalid Go\n")
        rc, lines = self.run_cli(["--", "go vet ./pkg 2>&1 | tee /tmp/vet.log | tail -5"])
        self.assertEqual(rc, 1)
        self.assertEqual(lines[-1], "offbox: local exit 1")
        row = self.con.execute("SELECT status,exit_code FROM runs WHERE mode='local'").fetchone()
        self.assertEqual(tuple(row), ("failed", 1))

    def test_local_sigpipe_and_grep_statuses(self):
        for cmd, expected in (("false | tail -1", 1), ("yes | head -1", 0),
                              ("(exit 7) | (exit 141) | cat", 7), ("true | (exit 141)", 141),
                              ("yes | head -1 && false", 141), ("readonly rc=0; false", 1)):
            with self.subTest(cmd=cmd):
                rc, _ = self.run_raw(cmd)
                self.assertEqual(rc, expected)
        rc, lines = self.run_cli(["--", "go version | grep no-such-version"])
        self.assertEqual(rc, 1)
        self.assertIn("trailing grep (no match)", lines[-2])
        self.assertEqual(lines[-1], "offbox: local exit 1")

    def test_environment_is_an_allowlist(self):
        with patch.dict(os.environ, {"AWS_PROFILE": "prod", "GITHUB_TOKEN": "x", "DATABASE_URL": "pg://prod",
                                     "KAFKA_BROKERS": "b:9092"}):
            rc, _ = self.run_cli(["--", "bash -c 'go version >/dev/null; "
                                        "test -z \"$AWS_PROFILE$GITHUB_TOKEN$DATABASE_URL$KAFKA_BROKERS\"'"])
        self.assertEqual(rc, 0)
        a = cli.build_parser().parse_args(["run", "--", "go", "version"])
        env = localfirst.local_env(a, "run-x", "/nonexistent")
        self.assertEqual(env["OFFBOX_LOCAL_RUN"], "run-x")
        self.assertEqual(env["GOENV"], "off")
        self.assertIn("-buildvcs=false", env["GOFLAGS"])
        self.assertIn("nonexistent", env["DOCKER_HOST"])
        self.assertIn("nonexistent", env["FDB_CLUSTER_FILE_PATH"])
        self.assertEqual(env["AWS_SHARED_CREDENTIALS_FILE"], "/dev/null")

    def test_sandbox_blocks_repo_writes_and_secret_reads(self):
        Path(self.cwd, ".env").write_text("DATABASE_URL=pg://prod\n")
        rc, _ = self.run_raw("echo x > mutated.txt")
        self.assertEqual(rc, "rerun")
        self.assertFalse(Path(self.cwd, "mutated.txt").exists())
        rc, _ = self.run_raw("cat .env")
        self.assertEqual(rc, "rerun")
        rc, _ = self.run_raw("cat .env >/dev/null", include=[".env"])
        self.assertEqual(rc, 0)
        rc, _ = self.run_raw("cat ~/.gitconfig >/dev/null")
        self.assertNotEqual(rc, 0)

    def test_tmp_paths_are_private_to_the_run(self):
        name = f"offbox-lf-{os.getpid()}"
        Path("/tmp", name).write_text("stale\n")
        self.addCleanup(lambda: os.path.exists(f"/tmp/{name}") and os.unlink(f"/tmp/{name}"))
        # The command's /tmp/<name> is a fresh file in the run's own dir: the real one is neither read nor written.
        rc, _ = self.run_raw(f"echo fresh >> /tmp/{name}; grep -q stale /tmp/{name}")
        self.assertEqual(rc, 1)
        self.assertEqual(Path("/tmp", name).read_text(), "stale\n")
        rc, _ = self.run_raw(f"echo fresh > /tmp/{name} && grep -q fresh /tmp/{name}")
        self.assertEqual(rc, 0)
        self.assertEqual(Path("/tmp", name).read_text(), "stale\n")

    def test_checkout_under_tmp_stays_read_only(self):
        repo = os.path.realpath(tempfile.mkdtemp(dir="/private/tmp"))
        self.addCleanup(shutil.rmtree, repo, True)
        make_repo(repo)
        os.chdir(repo)
        self.me = dict(self.me, repo_root=repo)
        rc, _ = self.run_raw("echo x > pkg/a.go")
        self.assertEqual(rc, "rerun")
        self.assertEqual(Path(repo, "pkg/a.go").read_text(), "package x\n")
        rc, _ = self.run_raw("cat pkg/a.go >/dev/null")
        self.assertEqual(rc, 0)

    def test_no_unix_sockets_or_local_udp(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        srv.bind(("127.0.0.1", 0))
        srv.settimeout(1.5)
        self.addCleanup(srv.close)
        port = srv.getsockname()[1]
        py = localfirst.PYTHON
        rc, _ = self.run_raw(f"{py} -I -S -c \"import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); "
                             f"s.sendto(b'x', ('127.0.0.1', {port}))\"")
        self.assertNotEqual(rc, 0)
        with self.assertRaises(socket.timeout):
            srv.recvfrom(10)
        sock = os.path.join(self.cwd, "s.sock")
        u = socket.socket(socket.AF_UNIX)
        u.bind(sock)
        u.listen(1)
        self.addCleanup(u.close)
        rc, _ = self.run_raw(f"{py} -I -S -c \"import socket; socket.socket(socket.AF_UNIX).connect('{sock}')\"")
        self.assertNotEqual(rc, 0)

    def test_signal_exit_maps_to_128_plus_signal(self):
        rc, _ = self.run_raw("kill -TERM $$")
        self.assertEqual(rc, 143)

    def assert_gone(self, pid):
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                pass
            time.sleep(0.1)
        self.fail(f"pid {pid} still alive")

    def test_leftover_and_detached_children_are_killed(self):
        py = localfirst.PYTHON
        t = time.monotonic()
        rc, _ = self.run_raw("(trap '' TERM; exec sleep 60) & echo PID=$!; "
                             f"{py} -I -S -c \"import os,subprocess; "
                             "p=subprocess.Popen(['sleep','60'], start_new_session=True); print('PID=%d' % p.pid)\"; "
                             "exit 0")
        self.assertEqual(rc, 0)
        self.assertLess(time.monotonic() - t, 20)
        pids = [int(x) for x in re.findall(r"PID=(\d+)", self.last_log())]
        self.assertEqual(len(pids), 2)
        for pid in pids:
            self.assert_gone(pid)

    def test_reaper_forwards_a_signal_and_cleans_up(self):
        prof = localfirst.profile(self.cwd, self.cwd + "/x", {"GOPATH": "/nonexistent", "GOCACHE": "/nonexistent",
                                                                "GOMODCACHE": "/nonexistent"}, [], ports=[])
        p = subprocess.Popen([localfirst.SANDBOX, "-p", prof, localfirst.PYTHON, "-I", "-S", "-c", localfirst.REAPER,
                              "/bin/sh", "-c", "sleep 30 & echo $!; wait"], stdout=subprocess.PIPE, text=True)
        child = int(p.stdout.readline())
        k = localfirst._Killer()
        k.p = p
        k.handle(signal.SIGTERM, None)
        self.assertEqual(p.wait(timeout=10), 143)
        p.stdout.close()
        self.assert_gone(child)

    def test_signal_before_the_spawn_runs_nothing(self):
        def enter(k):
            k.sig = signal.SIGTERM
            return k

        with patch.object(localfirst._Killer, "__enter__", enter), \
                patch.object(localfirst.subprocess, "Popen", wraps=subprocess.Popen) as spawn:
            rc, _ = self.run_raw("go version")
        self.assertEqual(rc, 143)
        self.assertEqual([c for c in spawn.call_args_list if localfirst.BASH in c.args[0]], [])

    def test_error_after_the_spawn_still_stops_the_run(self):
        made, real = [], subprocess.Popen

        def popen(*args, **kw):
            p = real(*args, **kw)
            made.append(p)
            return p

        t = time.monotonic()
        with patch.object(localfirst.subprocess, "Popen", side_effect=popen), \
                patch.object(localfirst, "say", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.run_raw("sleep 30")
        self.assertLess(time.monotonic() - t, 15)
        reaper = [p for p in made if localfirst.BASH in p.args]
        self.assertEqual(len(reaper), 1)
        self.assertIsNotNone(reaper[0].poll())

    def test_blocked_eligible_check_reruns_on_the_box(self):
        Path(self.cwd, "pkg", "w_test.go").write_text(
            'package x\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestW(t *testing.T) {\n'
            '\tif err := os.WriteFile("generated.txt", []byte("x"), 0o600); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n')
        a = cli.build_parser().parse_args(["run", "--", "go", "test", "./pkg", "-run", "TestW", "-count=1"])
        err = io.StringIO()
        with patch.object(runs, "run_remote", return_value=0) as remote, \
                patch.object(fallback, "run_local") as local, contextlib.redirect_stderr(err):
            self.assertEqual(cli.cmd_run(a, self.me), 0)
        remote.assert_called_once()
        self.assertTrue(remote.call_args.args[0].remote)
        local.assert_not_called()
        self.assertIn("rerunning it on the box", err.getvalue())
        self.assertFalse(Path(self.cwd, "pkg", "generated.txt").exists())

    def test_hidden_fixture_write_failure_reruns_but_plain_failure_does_not(self):
        # The test swallows the "operation not permitted" text; the package's write calls still send it to the box.
        Path(self.cwd, "pkg", "w_test.go").write_text(
            'package x\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestW(t *testing.T) {\n'
            '\tif os.WriteFile("fixture.json", []byte("x"), 0o600) != nil {\n\t\tt.Fatal("could not create fixture")\n'
            '\t}\n}\n')
        Path(self.cwd, "internal", "app", "f_test.go").write_text(
            'package x\n\nimport "testing"\n\nfunc TestF(t *testing.T) { t.Fatal("real failure") }\n')
        for argv, remote_calls in ((["go", "test", "./pkg", "-run", "TestW", "-count=1"], 1),
                                   (["go", "test", "./internal/app", "-run", "TestF", "-count=1"], 0)):
            a = cli.build_parser().parse_args(["run", "--"] + argv)
            err = io.StringIO()
            with patch.object(runs, "run_remote", return_value=0) as remote, \
                    patch.object(fallback, "run_local") as local, contextlib.redirect_stderr(err):
                rc = cli.cmd_run(a, self.me)
            self.assertEqual(remote.call_count, remote_calls, err.getvalue())
            local.assert_not_called()
            if remote_calls:
                self.assertEqual(rc, 0)
                self.assertIn("writes files", err.getvalue())
            else:
                self.assertEqual(rc, 1)
                self.assertIn("offbox: local exit 1", err.getvalue())
        self.assertFalse(Path(self.cwd, "pkg", "fixture.json").exists())

    def test_one_cancel_kills_a_child_that_ignores_it(self):
        prof = localfirst.profile(self.cwd, self.cwd + "/x", {"GOPATH": "/nonexistent", "GOCACHE": "/nonexistent",
                                                                "GOMODCACHE": "/nonexistent"}, [], ports=[])
        p = subprocess.Popen([localfirst.SANDBOX, "-p", prof, localfirst.PYTHON, "-I", "-S", "-c", localfirst.REAPER,
                              "/bin/sh", "-c", "trap '' TERM; echo $$; while :; do sleep 1; done"],
                             stdout=subprocess.PIPE, text=True)
        child = int(p.stdout.readline())
        t = time.monotonic()
        k = localfirst._Killer()
        k.p = p
        k.handle(signal.SIGTERM, None)  # once only
        self.assertEqual(p.wait(timeout=20), 143)
        self.assertLess(time.monotonic() - t, 12)
        p.stdout.close()
        self.assert_gone(child)

    def test_cancel_reports_the_signal_even_when_the_child_exits_cleanly(self):
        prof = localfirst.profile(self.cwd, self.cwd + "/x", {"GOPATH": "/nonexistent", "GOCACHE": "/nonexistent",
                                                                "GOMODCACHE": "/nonexistent"}, [], ports=[])
        for handler in ("exit 0", "exit 7"):
            p = subprocess.Popen([localfirst.SANDBOX, "-p", prof, localfirst.PYTHON, "-I", "-S", "-c",
                                  localfirst.REAPER, "/bin/sh", "-c",
                                  f"trap '{handler}' TERM; echo ready; while :; do sleep 1; done"],
                                 stdout=subprocess.PIPE, text=True)
            p.stdout.readline()
            k = localfirst._Killer()
            k.p = p
            k.handle(signal.SIGTERM, None)
            self.assertEqual(p.wait(timeout=20), 143, handler)
            p.stdout.close()

    def test_cancelled_local_run_never_reports_success(self):
        a = cli.build_parser().parse_args(["run", "--", "go", "version"])
        real = subprocess.Popen

        def popen(args, *rest, **kw):
            p = real(args, *rest, **kw)
            if localfirst.BASH in args:
                # The run is cancelled while its handler exits 0.
                localfirst._Killer.active.sig = signal.SIGTERM
            return p

        enter = localfirst._Killer.__enter__

        def remember(k):
            localfirst._Killer.active = k
            return enter(k)

        with patch.object(localfirst._Killer, "__enter__", remember), \
                patch.object(localfirst.subprocess, "Popen", side_effect=popen), \
                patch.object(runs, "run_remote") as remote:
            rc = localfirst.run(a, self.me, [])
        self.assertEqual(rc, 143)
        remote.assert_not_called()
        con = sqlite3.connect(common.DB_PATH)
        self.assertEqual(con.execute("SELECT status, exit_code FROM runs WHERE mode='local' ORDER BY start_at DESC "
                                     "LIMIT 1").fetchone(), ("killed", 143))
        con.close()

    def test_setup_failure_goes_remote_before_anything_runs(self):
        a = cli.build_parser().parse_args(["run", "--", "go", "version"])

        def shells(spawn):
            return [c for c in spawn.call_args_list if localfirst.BASH in c.args[0]]

        for target, err in (("profile", RuntimeError("boom")), ("db", RuntimeError("db locked"))):
            with patch.object(localfirst, target, side_effect=err), \
                    patch.object(localfirst.subprocess, "Popen", wraps=subprocess.Popen) as spawn:
                self.assertIsNone(localfirst.run(a, self.me, []))
            self.assertEqual(shells(spawn), [], target)

    def test_no_local_start_goes_remote(self):
        a = cli.build_parser().parse_args(["run", "--", "go", "vet", "./pkg"])
        with patch.object(localfirst, "run", return_value=None), \
                patch.object(runs, "run_remote", return_value=0) as remote:
            self.assertEqual(cli.cmd_run(a, self.me), 0)
        remote.assert_called_once()

    def test_remote_flag_never_falls_back_locally(self):
        a = cli.build_parser().parse_args(["run", "--remote", "--", "echo", "ok"])
        with patch.object(runs, "run_remote", side_effect=OffboxError("boat API unreachable")), \
                patch.object(fallback, "run_local") as local, patch.object(fallback, "note_infra_failure"), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_run(a, self.me), 90)
        local.assert_not_called()


class CmdStartRejectedTests(Isolated):
    def start_with(self, err):
        rn = runs.Runner(cli.build_parser().parse_args(["run", "--", "go", "test", "./..."]), self.me)
        rn.a.steps = []
        row = {"box_id": "bx", "remote_dir": "w/r", "size": "large"}
        with patch.object(runs.pool, "acquire", return_value=row), patch.object(runs, '_ttl_keeper'), \
                patch.object(runs.ssh_sync, "put_file"), patch.object(runs.ssh_sync, "push", return_value={}), \
                patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]), \
                patch.object(runs.ssh_sync, "probe_home", return_value=(None, None)), \
                patch.object(api, "cmd_start", side_effect=err), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                rn.start()
        return rn, cm.exception

    def test_4xx_from_cmd_start_is_not_started(self):
        rn, e = self.start_with(api.ApiError(400, "sandbox_direct_failed", "E2BIG"))
        self.assertFalse(rn.started)
        self.assertIn("too long", str(e))
        self.assertEqual(e.code, 2)
        rn, _ = self.start_with(api.ApiError(409, "sandbox_not_ready", "not ready"))
        self.assertFalse(rn.started)

    def test_ambiguous_errors_count_as_started(self):
        rn, _ = self.start_with(OffboxError("boat API unreachable"))
        self.assertTrue(rn.started)
        rn, _ = self.start_with(api.ApiError(502, "sandbox_direct_failed", "Socket is closed"))
        self.assertTrue(rn.started)


if __name__ == "__main__":
    unittest.main()
