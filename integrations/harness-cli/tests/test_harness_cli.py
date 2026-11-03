"""Tests for harness_cli.py. Everything lives in temp dirs; no live path, npm cache or network is touched.

A fake `npm` on PATH answers `view` and `pack`; fake CLI binaries print their version and "OK".
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

PKG = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG))
import harness_cli as hc  # noqa: E402

FAKE_NPM = r'''#!/bin/sh
# Fake npm: `view <spec> [field]` answers from FAKE_NPM_DB; `pack <spec> --pack-destination D` writes a tgz.
set -eu
db="$FAKE_NPM_DB"
cmd="$1"; shift
if [ "$cmd" = "view" ]; then
  spec="$1"; shift
  field="${1:-}"
  case "$field" in
    version) echo "$(python3 -c "import json,sys;print(json.load(open('$db'))['latest'][sys.argv[1]])" "$spec")" ;;
    dist.integrity) python3 -c "import json,sys;print(json.load(open('$db'))['integrity'][sys.argv[1]])" "$spec" ;;
    *) echo "unsupported field" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$cmd" = "pack" ]; then
  spec="$1"; shift
  dest=""
  while [ $# -gt 0 ]; do
    case "$1" in --pack-destination) dest="$2"; shift 2 ;; *) shift ;; esac
  done
  python3 -c "import json,sys;d=json.load(open('$db'));src=d['tarball'][sys.argv[1]];import shutil;shutil.copy(src, sys.argv[2])" "$spec" "$dest/fake-$(date +%s%N).tgz"
  exit 0
fi
echo "unsupported $cmd" >&2
exit 1
'''


def sri(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")


def make_tgz(path: Path, members: dict[str, bytes], modes: dict[str, int] | None = None) -> None:
    with tarfile.open(path, "w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = (modes or {}).get(name, 0o644)
            tar.addfile(info, io.BytesIO(data))


class FakeCliTestCase(unittest.TestCase):
    """Sets up a sandbox: fake npm, fake tarballs, a throwaway ROOT and environment."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-cli-test-"))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.root = self.tmp / "harness-cli"
        self.homes_pkg = self.tmp / "harness-homes"
        self.homes_pkg.mkdir()
        self.notify_log = self.tmp / "notify.log"
        self.npm_db = self.tmp / "npm-db.json"
        self.manifest = self.tmp / "model-manifest.json"
        self.write_manifest()
        self.env_patch = mock.patch.dict(os.environ, {
            "HARNESS_CLI_HOME": str(self.root),
            "HARNESS_CLI_NPM": str(self.bin / "npm"),
            "HARNESS_CLI_MODEL_MANIFEST": str(self.manifest),
            "HARNESS_CLI_HOMES": str(self.tmp / "live-homes"),
            "FAKE_NPM_DB": str(self.npm_db),
            "HARNESS_CLI_NOTIFY": f"{self.bin / 'notify'}",
            "HARNESS_CLI_ROBOB_PLIST": str(self.tmp / "Info.plist"),
            "HARNESS_HOMES_PKG": str(self.homes_pkg),
            "HOME": str(self.tmp / "home"),
        })
        self.env_patch.start()
        (self.tmp / "home").mkdir()
        # Fake CLIs do not use Keychain; never mutate the host Keychain during tests.
        def fake_home(home):
            keychain = home / "Library" / "Keychains" / "login.keychain-db"
            keychain.parent.mkdir(parents=True, exist_ok=True)
            keychain.touch()
        self.home_patch = mock.patch.object(hc, "prepare_isolated_home", side_effect=fake_home)
        self.home_patch.start()
        self.write_fake_npm()
        self.write_notify_stub()
        self.write_plist()

    def tearDown(self) -> None:
        self.home_patch.stop()
        self.env_patch.stop()
        # Staged version trees are read-only; restore write bits so the sandbox always goes.
        for dirpath, dirs, files in os.walk(self.tmp):
            for name in dirs + files:
                full = os.path.join(dirpath, name)
                if not os.path.islink(full):
                    os.chmod(full, stat.S_IRWXU)
            os.chmod(dirpath, stat.S_IRWXU)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_manifest(self, claude_min: str = "2.1.280", haiku_min: str = "2.1.293",
                       codex_min: str = "0.156.0", astra_min: str = "0.153.0") -> None:
        data = {
            "version": 1,
            "compatibility": [
                {"driver": "claudeAgent", "recommendedRange": f">={claude_min}", "ranges": []},
                {"driver": "codex", "recommendedRange": f">={codex_min}", "ranges": []},
            ],
            "providers": {
                "claudeAgent": {"models": [
                    {"slug": "claude-opus-5-5", "adapter": {"claudeCode": {"minVersion": "2.1.280"}}},
                    {"slug": "claude-haiku-5-5", "adapter": {"claudeCode": {"minVersion": haiku_min}}},
                ]},
                "codex": {"models": [
                    {"slug": "gpt-6-astra", "adapter": {"codex": {"minVersion": astra_min}}},
                    {"slug": "gpt-6.1-sol", "adapter": {"codex": {"minVersion": astra_min}}},
                ]},
            },
        }
        self.manifest.write_text(json.dumps(data), encoding="utf-8")

    def write_fake_npm(self) -> None:
        npm = self.bin / "npm"
        npm.write_text(FAKE_NPM, encoding="utf-8")
        npm.chmod(0o755)

    def write_notify_stub(self) -> None:
        stub = self.bin / "notify"
        stub.write_text(f'#!/bin/sh\necho "$@" >> "{self.notify_log}"\n', encoding="utf-8")
        stub.chmod(0o755)

    def write_plist(self) -> None:
        import plistlib
        with open(self.tmp / "Info.plist", "wb") as handle:
            plistlib.dump({"CFBundleShortVersionString": "0.1.0-preview.20261029.2"}, handle)

    def set_npm(self, *, latest: dict[str, str], tarballs: dict[str, Path], integrity: dict[str, str]) -> None:
        self.npm_db.write_text(json.dumps({
            "latest": latest,
            "tarball": {k: str(v) for k, v in tarballs.items()},
            "integrity": integrity,
        }), encoding="utf-8")

    def fake_claude_binary(self, version: str, body_extra: str = "") -> bytes:
        script = r'''#!/opt/homebrew/bin/python3
import json, os, sys, urllib.request
from pathlib import Path
if "--version" in sys.argv:
    print("VERSION (Claude Code)"); sys.exit(0)
settings = json.loads((Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json").read_text())
base = settings["env"]["ANTHROPIC_BASE_URL"]
session = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "fake-session.json"
messages = [{"role": "user", "content": "hello"}]
if "--resume" in sys.argv and session.exists():
    messages.append({"role": "assistant", "content": [json.loads(session.read_text())]})
if LEAK:
    messages.append({"role": "user", "content": "ROBOB-MEMCANARY-7f3a91"})
body = {"messages": messages, "context_management": {"edits": [{"type": "clear_thinking_20251015"}]}}
req = urllib.request.Request(base + "/v1/messages", data=json.dumps(body).encode(),
                             headers={"content-type": "application/json", "anthropic-beta": "context-management-test"})
response = json.loads(urllib.request.urlopen(req, timeout=10).read())
if "--session-id" in sys.argv:
    session.write_text(json.dumps(response["content"][0]))
print("ROBOB-THINK-4417" if "--resume" in sys.argv else "OK")
'''
        return script.replace("VERSION", version).replace("LEAK", str("ROBOB-MEMCANARY" in body_extra)).encode()

    def fake_codex_binary(self, version: str, body_extra: str = "", *, leak_read: bool = False) -> bytes:
        script = r'''#!/opt/homebrew/bin/python3
import json, os, sys, tomllib, urllib.request
from pathlib import Path
if "--version" in sys.argv:
    print("codex-cli VERSION"); sys.exit(0)
home = Path(os.environ["CODEX_HOME"])
config = tomllib.loads((home / "config.toml").read_text())
assert "--ephemeral" not in sys.argv
assert list((home / "sessions").rglob("rollout-*.jsonl"))
if "gpt-6.1-terra" in sys.argv:
    assert config.get("model") == "gpt-6.1-terra"
    assert config.get("features", {}).get("computer_use") is True
    assert config.get("model_context_window") == 1050000
    assert (home / "models.json").is_file() and (home / "AGENTS.md").is_file()
if config.get("features", {}).get("memories") or LEAK:
    (home / "memories" / "phase2-output").write_text("pipeline ran")
enabled = config.get("features", {}).get("memories")
input_text = (home / "memories" / "MEMORY.md").read_text() if enabled else "hello"
if LEAK_READ:
    input_text = "<memory>loaded prior memory</memory>"
body = {"input": [{"role": "developer", "content": [{"type": "input_text", "text": input_text}]}]}
req = urllib.request.Request(os.environ["NINEROUTER_BASE"] + "/v1/responses", data=json.dumps(body).encode(), method="POST")
urllib.request.urlopen(req, timeout=10).read()
print("OK")
'''
        return (script.replace("VERSION", version).replace("LEAK_READ", str(leak_read))
                .replace("LEAK", str(bool(body_extra))).encode())

    def package_tgz(self, name: str, tool: str, version: str, binary: bytes) -> Path:
        path = self.tmp / f"{name}.tgz"
        rel = hc.TOOLS[tool]["binary_in_native"]
        make_tgz(path, {rel: binary}, modes={rel: 0o755})
        return path


class StageTests(FakeCliTestCase):
    def publish(self, tool: str, version: str, binary: bytes, *, lie: bool = False) -> Path:
        pkg = hc.pack_spec(tool, version)
        tgz = self.package_tgz(f"{tool}-{version}", tool, version, binary)
        real = sri(tgz.read_bytes())
        advertised = sri(b"something else") if lie else real
        self.npm_latest = getattr(self, "npm_latest", {})
        self.npm_latest[pkg] = version
        self.npm_integrity = getattr(self, "npm_integrity", {})
        self.npm_integrity[pkg] = advertised
        self.npm_tarballs = getattr(self, "npm_tarballs", {})
        self.npm_tarballs[pkg] = tgz
        self.set_npm(latest=self.npm_latest, tarballs=self.npm_tarballs, integrity=self.npm_integrity)
        return tgz

    def test_stage_extracts_read_only_and_records_sha256(self) -> None:
        self.publish("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        result = hc.stage("claude", "2.1.316")
        target = self.root / "claude" / "2.1.316"
        self.assertTrue((target / "bin" / "claude").is_file())
        self.assertFalse(os.stat(target / "bin" / "claude").st_mode & stat.S_IWUSR)
        self.assertEqual(result["binarySha256"], hc.sha256_file(target / "bin" / "claude"))

    def test_integrity_mismatch_refuses_stage_and_writes_nothing(self) -> None:
        self.publish("claude", "2.1.316", self.fake_claude_binary("2.1.316"), lie=True)
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.stage("claude", "2.1.316")
        self.assertIn("integrity mismatch", str(ctx.exception))
        self.assertFalse((self.root / "claude" / "2.1.316").exists())

    def test_existing_version_dir_is_never_overwritten(self) -> None:
        self.publish("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        existing = self.root / "codex" / "0.166.0"
        existing.mkdir(parents=True)
        (existing / "keep.txt").write_text("keep", encoding="utf-8")
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.stage("codex", "0.166.0")
        self.assertIn("never overwritten", str(ctx.exception))
        self.assertEqual((existing / "keep.txt").read_text(encoding="utf-8"), "keep")

    def test_below_minimum_version_is_refused_before_download(self) -> None:
        self.publish("claude", "2.1.200", self.fake_claude_binary("2.1.200"))
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.stage("claude", "2.1.200")
        self.assertIn("below the driver minimum", str(ctx.exception))
        self.assertFalse((self.root / "claude" / "2.1.200").exists())

    def test_claude_below_haiku_minimum_is_refused(self) -> None:
        # 2.1.287 is the installed build today: passes the driver floor, fails Haiku 5.5 (2.1.293).
        manifest = hc.load_manifest_minimums()
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.check_minimums("claude", "2.1.287", manifest)
        self.assertIn("claude-haiku-5-5", str(ctx.exception))

    def test_codex_below_astra_minimum_is_refused(self) -> None:
        manifest = hc.load_manifest_minimums()
        with self.assertRaises(hc.HarnessError):
            hc.check_minimums("codex", "0.152.0", manifest)

    def test_binary_reporting_other_version_is_refused(self) -> None:
        self.publish("claude", "2.1.316", self.fake_claude_binary("2.1.999"))
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.stage("claude", "2.1.316")
        self.assertIn("reports 2.1.999", str(ctx.exception))

    def test_unsafe_tarball_member_is_refused(self) -> None:
        tgz = self.tmp / "evil.tgz"
        make_tgz(tgz, {"package/../escape": b"x", "package/vendor/aarch64-apple-darwin/bin/codex": b"y"})
        with self.assertRaises(hc.HarnessError):
            hc.safe_extract(tgz, self.tmp / "dest")


class PromoteRollbackTests(FakeCliTestCase):
    def install_version(self, tool: str, version: str) -> None:
        bin_dir = self.root / tool / version / "bin"
        bin_dir.mkdir(parents=True)
        name = "claude" if tool == "claude" else "codex"
        (bin_dir / name).write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (bin_dir / name).chmod(0o555)

    def record_canary(self, tool: str, version: str, *, passed: bool = True, memory_ok: bool = True) -> None:
        canary = ({"memoryCanaryChecked": True, "memoryCanaryLeaked": not memory_ok,
                   "thinkingCheckChecked": True, "thinkingReplayed": True, "inputTransformationsEmpty": True}
                  if tool == "claude" else {"memoryCanaryChecked": True, "memoryPipelineRan": not memory_ok,
                    "positiveControlFired": True, "readControlFired": True,
                    "cu": {"memoryCanaryChecked": True, "positiveControlFired": True, "readControlFired": True}})
        binary = self.root / tool / version / "bin" / tool
        hc.write_record("canary", tool, version, "passed" if passed else "failed",
                        binarySha256=hc.sha256_file(binary), canary=canary)

    def test_promote_swaps_current_and_records_last_known_good(self) -> None:
        self.install_version("claude", "2.1.316")
        self.install_version("claude", "2.1.320")
        self.record_canary("claude", "2.1.316")
        self.record_canary("claude", "2.1.320")
        hc.promote("claude", "2.1.316")
        self.assertEqual(os.path.realpath(self.root / "claude" / "current"),
                         str((self.root / "claude" / "2.1.316").resolve()))
        hc.promote("claude", "2.1.320")
        state = hc.load_state()
        self.assertEqual(state["claude"]["current"], "2.1.320")
        self.assertEqual(state["claude"]["lastKnownGood"], "2.1.316")

    def test_rollback_points_current_back_at_last_known_good(self) -> None:
        self.install_version("claude", "2.1.316")
        self.install_version("claude", "2.1.320")
        self.record_canary("claude", "2.1.316")
        self.record_canary("claude", "2.1.320")
        hc.promote("claude", "2.1.316")
        hc.promote("claude", "2.1.320")
        hc.rollback("claude")
        self.assertEqual(hc.load_state()["claude"]["current"], "2.1.316")
        self.assertEqual(os.path.realpath(self.root / "claude" / "current"),
                         str((self.root / "claude" / "2.1.316").resolve()))

    def test_promote_refused_without_passing_canary(self) -> None:
        self.install_version("claude", "2.1.316")
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.promote("claude", "2.1.316")
        self.assertIn("no passing canary", str(ctx.exception))
        self.assertFalse((self.root / "claude" / "current").is_symlink())

    def test_promote_refused_when_memory_check_failed(self) -> None:
        self.install_version("claude", "2.1.316")
        self.record_canary("claude", "2.1.316", memory_ok=False)
        with self.assertRaises(hc.HarnessError):
            hc.promote("claude", "2.1.316")
        self.assertFalse((self.root / "claude" / "current").is_symlink())

    def test_symlink_swap_is_atomic_replace(self) -> None:
        self.install_version("claude", "2.1.316")
        self.install_version("claude", "2.1.320")
        (self.root / "claude").mkdir(parents=True, exist_ok=True)
        hc.swap_current("claude", "2.1.316")
        seen = []
        real_replace = os.replace

        def spy(src, dst):
            seen.append((os.path.islink(src), os.path.realpath(dst)))
            return real_replace(src, dst)

        with mock.patch.object(hc.os, "replace", side_effect=spy):
            hc.swap_current("claude", "2.1.320")
        self.assertEqual(seen[0][0], True)  # the temp is a symlink renamed over current
        self.assertEqual(os.path.realpath(self.root / "claude" / "current"),
                         str((self.root / "claude" / "2.1.320").resolve()))

    def test_promote_and_rollback_recover_each_crash_point(self) -> None:
        for op in ("promote", "rollback"):
            for crash in ("before-swap", "after-swap", "after-state-save"):
                with self.subTest(op=op, crash=crash):
                    hc.remove_tree(self.root)
                    for version in ("2.1.316", "2.1.320", "2.1.321"):
                        self.install_version("claude", version)
                        self.record_canary("claude", version)
                    hc.promote("claude", "2.1.316")
                    hc.promote("claude", "2.1.320")
                    old = "2.1.320"
                    new = "2.1.321" if op == "promote" else "2.1.316"
                    old_lkg = "2.1.316"
                    key = "harness-cli:claude:2.1.321:promoted"
                    original_swap, original_save = hc.swap_current, hc.save_state
                    def fail_swap(tool, version):
                        if crash == "before-swap":
                            raise OSError("before swap")
                        original_swap(tool, version)
                        if crash == "after-swap":
                            raise OSError("after swap")
                    def fail_clear(state):
                        if crash == "after-state-save" and "pendingTransition" not in state:
                            raise OSError("before clearing journal")
                        original_save(state)
                    with mock.patch.object(hc, "swap_current", side_effect=fail_swap), \
                         mock.patch.object(hc, "save_state", side_effect=fail_clear), \
                         self.assertRaises(OSError):
                        if op == "promote":
                            hc.promote("claude", new, queue_notice=True)
                        else:
                            hc.rollback("claude")
                    self.assertIn("pendingTransition", hc.load_state())
                    # A separate state-changing CLI command performs reconciliation under the lock.
                    with mock.patch.object(hc, "discover", return_value={}), redirect_stdout(io.StringIO()):
                        self.assertEqual(hc.main(["discover"]), 0)
                    state = hc.load_state()
                    expected = old if crash == "before-swap" else new
                    self.assertEqual(state["claude"]["current"], expected)
                    self.assertEqual(hc.current_version_from_link("claude"), expected)
                    self.assertEqual(state["claude"]["lastKnownGood"], old_lkg if crash == "before-swap" else old)
                    self.assertNotIn("pendingTransition", state)
                    self.assertEqual(key in state.get("pendingNotices", {}), op == "promote" and crash != "before-swap")
                    self.assertIsNotNone(state["claude"]["lastKnownGood"])

    def test_pending_transition_with_unexpected_link_fails_closed(self) -> None:
        for version in ("2.1.316", "2.1.320", "2.1.321"):
            self.install_version("claude", version)
            self.record_canary("claude", version)
        hc.promote("claude", "2.1.316")
        with mock.patch.object(hc, "swap_current", side_effect=OSError("stopped")), self.assertRaises(OSError):
            hc.promote("claude", "2.1.320", queue_notice=True)
        hc.swap_current("claude", "2.1.321")
        with mock.patch.object(hc, "discover") as discover, redirect_stdout(io.StringIO()):
            self.assertEqual(hc.main(["discover"]), 1)
        discover.assert_not_called()
        self.assertIn("pendingTransition", hc.load_state())


class CodexRotationTests(FakeCliTestCase):
    def install_codex(self, version: str) -> None:
        bin_dir = self.root / "codex" / version / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (bin_dir / "codex").chmod(0o555)

    def record_codex_canary(self, version: str) -> None:
        hc.write_record("canary", "codex", version, "passed",
                        binarySha256=hc.sha256_file(self.root / "codex" / version / "bin" / "codex"),
                        canary={"memoryCanaryChecked": True, "memoryPipelineRan": False, "positiveControlFired": True,
                                "readControlFired": True, "cu": {"memoryCanaryChecked": True,
                                "positiveControlFired": True, "readControlFired": True}})

    def test_codex_promote_leaves_rotation_pending(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        out = hc.promote("codex", "0.166.0")
        self.assertEqual(out["status"], "promoted, rotation pending")
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_codex_rotation_refused_without_standing_ok(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        hc.promote("codex", "0.166.0")
        refresh = mock.Mock()
        msg = hc.rotate_codex(when_idle=True, checker=lambda: {"threads": []}, refresher=refresh)
        self.assertIn("autoRotateCodex is off", msg)
        refresh.assert_not_called()

    def test_codex_rotation_unsupported_even_while_busy(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        hc.promote("codex", "0.166.0")
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        busy = {"threads": [{"threadId": "t1", "provider": "codex", "runningRun": {"runId": "r1"},
                             "heldWork": False, "pendingRequest": None}]}
        refresh = mock.Mock()
        now = [0.0]

        def fake_clock():
            return now[0]

        def fake_sleep(seconds):
            now[0] += seconds

        msg = hc.rotate_codex(when_idle=True, quiet_seconds=300, checker=lambda: busy,
                              refresher=refresh, sleep=fake_sleep, clock=fake_clock,
                              max_wait_seconds=900)
        refresh.assert_not_called()
        self.assertIn("unsupported", msg)
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_codex_rotation_unsupported_without_contacting_snapshot(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        hc.promote("codex", "0.166.0")
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)

        def missing():
            raise hc.HarnessError("recovery snapshot route is missing (card E7 not installed); not rotating")

        refresh = mock.Mock()
        msg = hc.rotate_codex(when_idle=True, checker=missing, refresher=refresh, quiet_seconds=0)
        self.assertIn("unsupported", msg)
        refresh.assert_not_called()

    def test_codex_stays_pending_with_standing_ok(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        hc.promote("codex", "0.166.0")
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        refresh = mock.Mock()
        msg = hc.rotate_codex(when_idle=True, checker=lambda: {"threads": []}, refresher=refresh, quiet_seconds=0)
        refresh.assert_not_called()
        self.assertIn("unsupported", msg)
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_claude_promote_never_needs_rotation(self) -> None:
        self.install_version_claude()
        self.record_claude()
        out = hc.promote("claude", "2.1.316")
        self.assertEqual(out["status"], "promoted")
        self.assertFalse(hc.load_state()["claude"]["rotationPending"])

    def install_version_claude(self) -> None:
        bin_dir = self.root / "claude" / "2.1.316" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "claude").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (bin_dir / "claude").chmod(0o555)

    def record_claude(self) -> None:
        hc.write_record("canary", "claude", "2.1.316", "passed",
                        binarySha256=hc.sha256_file(self.root / "claude" / "2.1.316" / "bin" / "claude"),
                        canary={"memoryCanaryChecked": True, "memoryCanaryLeaked": False,
                                "thinkingCheckChecked": True, "thinkingReplayed": True, "inputTransformationsEmpty": True})


class CanaryTests(FakeCliTestCase):
    """The canary runs the real generator on throwaway homes and drives a fake CLI through the proxy."""

    def setUp(self) -> None:
        super().setUp()
        self.gen = self.homes_pkg / "generate_homes.py"
        shutil.copy(PKG.parent / "harness-homes" / "generate_homes.py", self.gen)
        shutil.copytree(PKG.parent / "harness-homes" / "vendor", self.homes_pkg / "vendor")
        shutil.copy(PKG.parent / "harness-homes" / "manifest.json", self.homes_pkg / "manifest.json")
        shutil.copytree(PKG.parent / "harness-homes" / "overlays", self.homes_pkg / "overlays")
        self.canonical = self.tmp / "home" / ".config" / "opencode" / "AGENTS.md"
        self.canonical.parent.mkdir(parents=True, exist_ok=True)
        self.canonical.write_text("# canonical\n", encoding="utf-8")
        self.skills = self.tmp / "home" / ".config" / "opencode" / "skills" / "alpha"
        self.skills.mkdir(parents=True, exist_ok=True)
        (self.skills / "SKILL.md").write_text("---\nname: alpha\ndescription: t\n---\nbody\n", encoding="utf-8")
        self.manifest_home = self.homes_pkg / "manifest.json"
        self.proxy_hits = []
        import http.server
        import threading
        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length", "0")))
                body = json.dumps({"content": [{"type": "thinking", "thinking": "thinking", "signature": "sig"},
                                                {"type": "text", "text": "OK"}], "input_transformations": []}).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        self.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.addCleanup(self.upstream.server_close)
        self.addCleanup(self.upstream.shutdown)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.router_patch = mock.patch.dict(os.environ, {"HARNESS_CLI_9ROUTER": f"http://127.0.0.1:{self.upstream.server_address[1]}"})
        self.router_patch.start()
        self.addCleanup(self.router_patch.stop)

    def install_binary(self, tool: str, version: str, body: bytes) -> Path:
        bin_dir = self.root / tool / version / "bin"
        bin_dir.mkdir(parents=True)
        name = "claude" if tool == "claude" else "codex"
        path = bin_dir / name
        path.write_bytes(body)
        path.chmod(0o755)
        return path

    def test_canary_passes_on_clean_fake_claude(self) -> None:
        body = self.fake_claude_binary("2.1.316")
        self.install_binary("claude", "2.1.316", body)
        verdict = self.run_canary("claude", "2.1.316", fake_proxy_body=None)
        self.assertTrue(verdict["passed"], verdict)
        self.assertEqual(verdict["result"]["diagnostics"]["contextManagement"][0]["edits"][0]["type"],
                         "clear_thinking_20251015")
        self.assertTrue(any("context-management-test" in beta and "thinking-binding-controls-2026-08-01" in beta
                            for beta in verdict["result"]["diagnostics"]["anthropicBeta"]))

    def test_dropped_thinking_blocks_promotion(self) -> None:
        body = self.fake_claude_binary("2.1.316").replace(
            b'if "--resume" in sys.argv and session.exists():', b'if False:')
        self.install_binary("claude", "2.1.316", body)
        verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"], verdict)
        self.assertTrue(any("preserved thinking" in r for r in verdict["reasons"]))
        with self.assertRaises(hc.HarnessError):
            hc.promote("claude", "2.1.316")

    def test_transformed_or_unreported_thinking_response_fails_closed(self) -> None:
        first = [{"response_thinking": [{"thinking": "t", "signature": "s"}]}]
        request = {"body": {"messages": [{"role": "assistant", "content":
                    [{"type": "thinking", "thinking": "t", "signature": "s"}]}]}}
        for reported in ([], [[{"type": "dropped_thinking"}]]):
            result = hc.thinking_replay_check(first, [{**request, "response_transformations": reported}])
            self.assertFalse(result["inputTransformationsEmpty"])
        result = hc.thinking_replay_check(first, [{**request, "response_transformations": [[]]}])
        self.assertTrue(result["thinkingReplayed"] and result["inputTransformationsEmpty"])
        other = {"body": {"messages": []}, "response_transformations": [[]]}
        result = hc.thinking_replay_check(first, [request, other])
        self.assertFalse(result["inputTransformationsEmpty"])
        result = hc.thinking_replay_check(first, [{**request, "response_transformations": [[]]},
                                                  {**request, "response_transformations": [[{"type": "dropped"}]]}])
        self.assertFalse(result["inputTransformationsEmpty"])

    def test_nested_tool_input_is_not_transformation_evidence(self) -> None:
        record = {}
        hc.Recorder("http://127.0.0.1", "dummy").capture_response(
            b'{"content":[{"type":"tool_use","input":{"input_transformations":[]}}]}', record)
        self.assertEqual(record["response_transformations"], [])

    def test_codex_uses_generated_cu_home_and_memory_positive_control(self) -> None:
        self.install_binary("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        verdict = self.run_canary("codex", "0.166.0")
        self.assertTrue(verdict["passed"], verdict)
        self.assertTrue(verdict["result"]["positiveControlFired"])
        self.assertTrue(verdict["result"]["cu"]["positiveControlFired"])
        self.assertTrue(verdict["result"]["cu"]["models"]["gpt-6.1-terra"]["ok"])
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertTrue(result["readControlFired"])
            self.assertFalse(result["memorySentinelSeen"])
            self.assertFalse(result["memoryPromptSeen"])
            self.assertIn("memories/MEMORY.md", result["memoryBaseline"])
            self.assertEqual(result["memoryArtifacts"], [])

    def test_codex_disabled_memory_read_leaks_block_promotion_on_both_homes(self) -> None:
        self.install_binary("codex", "0.166.0", self.fake_codex_binary("0.166.0", leak_read=True))
        verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        plain, cu = verdict["result"], verdict["result"]["cu"]
        for home in (plain, cu):
            self.assertTrue(home["positiveControlFired"])
            self.assertFalse(home["memoryPipelineRan"])
            self.assertTrue(home["memoryPromptSeen"])
            self.assertTrue(all(model["memorySectionInRequest"] for model in home["models"].values()))
        self.assertTrue(any("memory-off canary failed" in r for r in verdict["reasons"]))
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_codex_memory_sentinel_detects_decoded_nested_text(self) -> None:
        sentinel = "ROBOB-CODEX-MEMORY-test"
        body = json.loads('{"input":[{"role":"system","content":[{"text":"ROBOB-CODEX-\\u004dEMORY-test"}]}]}')
        self.assertEqual(hc.codex_memory_in_body(body, sentinel), (True, False))
        self.assertEqual(hc.codex_memory_in_body({"input": [{"role": "developer", "content":
            "<memory>loaded prior memory</memory>"}]}, sentinel), (False, True))
        self.assertEqual(hc.codex_memory_in_body({"input": [{"role": "developer", "content":
            "old memory: the user prefers short replies"}]}, sentinel), (False, True))

    def test_codex_canonical_instructions_do_not_count_as_loaded_memory(self) -> None:
        instructions = "# AGENTS.md instructions\nThe old memory MCP is retired."
        body = {"input": [{"role": "user", "content": [{"type": "input_text",
                "text": instructions}]}]}
        self.assertEqual(hc.codex_memory_in_body(body, "unrelated-sentinel", instructions), (False, False))
        self.assertEqual(hc.codex_memory_in_body(body, "old memory", instructions), (True, False))
        self.assertEqual(hc.codex_memory_in_body({"input": [{"role": "developer", "content":
            instructions + "\nPrior memories include the user's preference for blue."}]},
            "unrelated-sentinel", instructions), (False, True))

    def test_codex_memory_baseline_detects_top_level_phase2_files(self) -> None:
        home = self.tmp / "codex-snapshot"
        home.mkdir()
        before = hc.codex_memory_snapshot(home)
        (home / "phase2-output").write_text("new")
        (home / "raw_memories.md").write_text("new")
        after = hc.codex_memory_snapshot(home)
        self.assertEqual(set(after) - set(before), {"phase2-output", "raw_memories.md"})

    def test_canary_fails_when_claude_request_body_contains_memory_canary(self) -> None:
        # A fake CLI that echoes the memory canary into its outgoing request body, as built-in memory would.
        leaky = self.fake_claude_binary("2.1.316", body_extra=(
            'echo \'{"messages":[{"role":"user","content":"' + hc.CLAUDE_MEMORY_CANARY + '"}]}\' > /dev/null\n'
            'python3 -c "import urllib.request,sys;urllib.request.urlopen(urllib.request.Request(sys.argv[1],data=sys.argv[2].encode(),method=\'POST\'),timeout=5).read()" "$ANTHROPIC_BASE_URL/v1/messages" "{\\"messages\\":[{\\"content\\":\\"' + hc.CLAUDE_MEMORY_CANARY + '\\"}]}" >/dev/null 2>&1 || true\n'
        ))
        self.install_binary("claude", "2.1.316", leaky)
        verdict = self.run_canary("claude", "2.1.316", fake_proxy_body=None)
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("memory-off canary failed" in r for r in verdict["reasons"]), verdict)

    def test_canary_fails_when_codex_run_creates_memories_dir(self) -> None:
        leaky = self.fake_codex_binary("0.166.0", body_extra='mkdir -p "$CODEX_HOME/memories"\n')
        self.install_binary("codex", "0.166.0", leaky)
        verdict = self.run_canary("codex", "0.166.0", fake_proxy_body=None)
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("memory-off canary failed" in r for r in verdict["reasons"]), verdict)

    def test_canary_missing_generator_records_failure_that_blocks_promote(self) -> None:
        self.install_binary("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        (self.homes_pkg / "generate_homes.py").unlink()
        verdict = hc.canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("harness-homes" in r for r in verdict["reasons"]), verdict)
        record = hc.latest_canary("codex", "0.166.0")
        self.assertFalse(record["passed"])

    def test_canary_proxy_refuses_non_loopback_upstream(self) -> None:
        with self.assertRaises(hc.HarnessError):
            hc.Recorder("https://api.example.com", "k")

    def test_stale_pass_cannot_promote_after_a_later_failed_canary(self) -> None:
        # Reviewer's reproduction: a pass is recorded, then the next check fails, and promote must
        # refuse on the newer failure rather than the old pass.
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        first = self.run_canary("claude", "2.1.316")
        self.assertTrue(first["passed"], first)
        self.assertTrue(hc.latest_canary("claude", "2.1.316")["passed"])
        with mock.patch.object(hc, "make_throwaway_homes", side_effect=hc.HarnessError("generator broke")):
            second = hc.canary("claude", "2.1.316")
        self.assertFalse(second["passed"])
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.promote("claude", "2.1.316")
        self.assertIn("no passing canary", str(ctx.exception))
        self.assertFalse((self.root / "claude" / "current").is_symlink())

    def test_canary_exception_is_recorded_as_failure(self) -> None:
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        with mock.patch.object(hc, "run_cli", side_effect=OSError("exec failed")):
            verdict = hc.canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"])
        self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])

    def run_canary(self, tool: str, version: str, fake_proxy_body=None) -> dict:
        """Run the real canary: the real generator (with the real manifest) builds the homes from
        copies of the live instruction sources, and only the CLI binaries are fake."""
        with mock.patch.dict(os.environ, {"HARNESS_CLI_SOURCE_HOME": str(self.tmp / "home"),
                                          "HARNESS_HOMES_PKG": str(self.homes_pkg)}):
            return hc.canary(tool, version)


def passing_canary(tool: str, version: str) -> dict:
    """Stands in for canary(): writes the same durable record the real canary writes, so promote()
    checks what it would check in production (a passing record with the memory-off result)."""
    body = ({"memoryCanaryChecked": True, "memoryCanaryLeaked": False, "thinkingCheckChecked": True,
             "thinkingReplayed": True, "inputTransformationsEmpty": True} if tool == "claude"
            else {"memoryCanaryChecked": True, "memoryPipelineRan": False, "positiveControlFired": True,
                  "readControlFired": True, "cu": {"memoryCanaryChecked": True, "positiveControlFired": True,
                                                      "readControlFired": True}})
    binary = hc.version_dir(tool, version) / "bin" / tool
    hc.write_record("canary", tool, version, "passed", binarySha256=hc.sha256_file(binary), canary=body)
    return {"passed": True, "reasons": [], "result": body}


class AutoTests(FakeCliTestCase):
    def publish_both(self, claude_latest: str, codex_latest: str) -> None:
        """Answer npm the way the registry does: the wrapper package's `version` (what discover asks)
        and the native darwin package's dist.integrity and tarball (what stage fetches)."""
        latest = {
            hc.TOOLS["claude"]["package"]: claude_latest,
            hc.TOOLS["codex"]["package"]: codex_latest,
        }
        tarballs, integrity = {}, {}
        for tool, version in (("claude", claude_latest), ("codex", codex_latest)):
            binary = self.fake_claude_binary(version) if tool == "claude" else self.fake_codex_binary(version)
            tgz = self.package_tgz(f"{tool}-{version}", tool, version, binary)
            pkg = hc.pack_spec(tool, version)
            tarballs[pkg] = tgz
            integrity[pkg] = sri(tgz.read_bytes())
        self.set_npm(latest=latest, tarballs=tarballs, integrity=integrity)

    def test_auto_notifies_once_per_version(self) -> None:
        self.publish_both("2.1.316", "0.166.0")
        with mock.patch.object(hc, "canary", side_effect=passing_canary), \
             mock.patch.object(hc, "harness_home_hashes", return_value={}):
            hc.auto()
            hc.auto()
        lines = [line for line in self.notify_log.read_text(encoding="utf-8").splitlines() if line.strip()]
        keys = [line.split("--key ")[-1] for line in lines]
        # One promotion notice per version, however many runs happen.
        self.assertEqual(keys.count("harness-cli:claude:2.1.316:promoted"), 1, keys)

    def test_auto_stops_codex_at_rotation_pending(self) -> None:
        self.publish_both("2.1.316", "0.166.0")
        with mock.patch.object(hc, "canary", side_effect=passing_canary), \
             mock.patch.object(hc, "harness_home_hashes", return_value={}):
            report = hc.auto()
        self.assertEqual(report["outcome"]["codex"], "promoted, rotation pending")
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])


class DiscoverTests(FakeCliTestCase):
    def test_discover_records_candidates_without_touching_current(self) -> None:
        self.set_npm(latest={"@anthropic-ai/claude-code-darwin-arm64": "2.1.316",
                             "@openai/codex@0.166.0-darwin-arm64": "0.166.0"},
                     tarballs={}, integrity={})
        self.npm_db.write_text(json.dumps({
            "latest": {"@anthropic-ai/claude-code": "2.1.316", "@openai/codex": "0.166.0"},
            "tarball": {}, "integrity": {}}), encoding="utf-8")
        report = hc.discover()
        self.assertEqual(report["claude"]["latest"], "2.1.316")
        self.assertEqual(report["codex"]["latest"], "0.166.0")
        state = hc.load_state()
        self.assertEqual(state["claude"]["candidate"], "2.1.316")
        self.assertIsNone(state["claude"]["current"])


class FakeRobobServer:
    """A loopback WebSocket server that does the real upgrade, answers Ping with Pong, and replies to
    the first Request with an Exit. `exit_tag` picks Success or a failure, so the client's
    fail-closed handling is exercised against the framing it would meet in production."""

    def __init__(self, exit_tag: str = "Success", ping_first: bool = True):
        import socket
        import threading
        self.exit_tag = exit_tag
        self.ping_first = ping_first
        self.requests: list[dict] = []
        self.auth_headers: list[str] = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    @staticmethod
    def _read_frame(conn) -> bytes:
        def take(n):
            data = b""
            while len(data) < n:
                chunk = conn.recv(n - len(data))
                if not chunk:
                    raise OSError("closed")
                data += chunk
            return data
        b1, b2 = take(2)
        n = b2 & 0x7F
        if n == 126:
            n = int.from_bytes(take(2), "big")
        elif n == 127:
            n = int.from_bytes(take(8), "big")
        mask = take(4) if b2 & 0x80 else b"\x00\x00\x00\x00"
        payload = take(n) if n else b""
        return bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

    @staticmethod
    def _send_text(conn, text: str) -> None:
        data = text.encode("utf-8")
        header = bytearray([0x81])
        if len(data) < 126:
            header.append(len(data))
        else:
            header.append(126)
            header += len(data).to_bytes(2, "big")
        conn.sendall(bytes(header) + data)

    def _serve(self) -> None:
        import base64
        import hashlib
        import json as _json
        conn, _ = self.sock.accept()
        with conn:
            head = b""
            while b"\r\n\r\n" not in head:
                head += conn.recv(4096)
            headers = head.decode("ascii", "replace").split("\r\n")
            key = next(h.split(": ", 1)[1] for h in headers if h.lower().startswith("sec-websocket-key"))
            self.auth_headers = [h for h in headers if h.lower().startswith("authorization")]
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            request = _json.loads(self._read_frame(conn).decode("utf-8"))
            self.requests.append(request)
            if self.ping_first:
                self._send_text(conn, _json.dumps({"_tag": "Ping"}))
                # the client must answer with a Pong frame
                self.pong = _json.loads(self._read_frame(conn).decode("utf-8"))
            exit_frame = {"_tag": "Exit", "exit": {"_tag": self.exit_tag, "value": {"providers": []}}}
            self._send_text(conn, _json.dumps(exit_frame))

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.sock.close()


class RefreshTests(FakeCliTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.token_file = self.tmp / "watchers.json"
        self.token_file.write_text(json.dumps({"url": "http://127.0.0.1", "token": "t-secret"}), encoding="utf-8")
        self.token_file.chmod(0o600)

    def test_refresh_sends_request_answers_ping_and_accepts_success(self) -> None:
        server = FakeRobobServer(exit_tag="Success")
        try:
            with mock.patch.dict(os.environ, {"T3_CONTROL_URL": server.url(),
                                              "T3_CONTROL_TOKEN_FILE": str(self.token_file)}):
                hc.refresh_codex_provider("codex")
        finally:
            server.close()
        self.assertEqual(server.requests[0]["tag"], "server.refreshProviders")
        self.assertEqual(server.requests[0]["payload"], {"instanceId": "codex"})
        self.assertEqual(server.pong, {"_tag": "Pong"})
        self.assertTrue(server.auth_headers and "t-secret" in server.auth_headers[0])

    def test_refresh_failure_exit_is_an_error_not_a_rotation(self) -> None:
        server = FakeRobobServer(exit_tag="Failure")
        try:
            with mock.patch.dict(os.environ, {"T3_CONTROL_URL": server.url(),
                                              "T3_CONTROL_TOKEN_FILE": str(self.token_file)}):
                with self.assertRaises(hc.HarnessError) as ctx:
                    hc.refresh_codex_provider("codex")
        finally:
            server.close()
        self.assertIn("refreshProviders failed", str(ctx.exception))

    def test_refresh_refuses_non_codex_instance(self) -> None:
        with self.assertRaises(hc.HarnessError):
            hc.refresh_codex_provider("opencode")

    def test_refresh_refuses_non_loopback_url(self) -> None:
        with mock.patch.dict(os.environ, {"T3_CONTROL_URL": "http://10.0.0.5:3773",
                                          "T3_CONTROL_TOKEN_FILE": str(self.token_file)}):
            with self.assertRaises(hc.HarnessError):
                hc.refresh_codex_provider("codex")


class RotationGateTests(FakeCliTestCase):
    """The standing OK, the snapshot's fail-closed rule, and the rotation path end to end."""

    def install_codex(self, version: str = "0.166.0") -> None:
        bin_dir = self.root / "codex" / version / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (bin_dir / "codex").chmod(0o555)

    def pend(self, version: str = "0.166.0") -> None:
        self.install_codex(version)
        hc.write_record("canary", "codex", version, "passed",
                        binarySha256=hc.sha256_file(self.root / "codex" / version / "bin" / "codex"),
                        canary={"memoryCanaryChecked": True, "memoryPipelineRan": False, "memoryPromptSeen": False,
                                "positiveControlFired": True, "readControlFired": True,
                                "cu": {"memoryCanaryChecked": True, "positiveControlFired": True,
                                       "readControlFired": True}})
        hc.promote("codex", version)

    def test_rotation_refused_without_standing_ok_even_without_when_idle_flag(self) -> None:
        self.pend()
        refresh = mock.Mock()
        msg = hc.rotate_codex(checker=lambda: {"threads": []}, refresher=refresh, quiet_seconds=0)
        self.assertIn("autoRotateCodex is off", msg)
        refresh.assert_not_called()

    def test_unsupported_rotation_does_not_query_snapshot(self) -> None:
        self.pend()
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        refresh = mock.Mock()
        msg = hc.rotate_codex(checker=lambda: {}, refresher=refresh, quiet_seconds=0)
        refresh.assert_not_called()
        self.assertIn("unsupported", msg)
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_thread_missing_fields_fails_closed(self) -> None:
        with self.assertRaises(hc.HarnessError):
            hc.codex_busy({"threads": [{"provider": "codex"}]})

    def test_unknown_provider_or_invalid_work_fields_fail_closed(self) -> None:
        row = {"threadId": "t", "provider": "codex", "runningRun": None,
               "heldWork": False, "pendingRequest": None}
        for changes in ({"provider": None, "runningRun": {"id": "r"}},
                        {"provider": "codex-unknown"}, {"heldWork": "false"},
                        {"threadId": ""}, {"pendingRequest": []}):
            with self.subTest(changes=changes), self.assertRaises(hc.HarnessError):
                hc.codex_busy({"threads": [{**row, **changes}]})

    def test_rotation_does_not_refresh_or_clear_pending(self) -> None:
        self.pend()
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        refresh = mock.Mock()
        msg = hc.rotate_codex(checker=lambda: {"threads": []}, refresher=refresh, quiet_seconds=0)
        refresh.assert_not_called()
        self.assertIn("unsupported", msg)
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_rotation_never_calls_refresher(self) -> None:
        self.pend()
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        refresh = mock.Mock(side_effect=hc.HarnessError("server.refreshProviders failed: Failure"))
        msg = hc.rotate_codex(checker=lambda: {"threads": []}, refresher=refresh, quiet_seconds=0)
        self.assertIn("unsupported", msg)
        refresh.assert_not_called()
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_auto_drives_codex_rotation_when_standing_ok_recorded(self) -> None:
        self.pend()
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        with mock.patch.object(hc, "rotate_codex", return_value="unsupported" ) as rot, \
             mock.patch.object(hc, "discover", return_value={}):
            report = hc.auto()
        rot.assert_called_once()
        self.assertEqual(report["codexRotation"], "unsupported")


class ManifestLocationTests(FakeCliTestCase):
    """The installed job must find its minimums without the fork tree."""

    def test_bundled_manifest_loads_when_fork_tree_is_absent(self) -> None:
        # Simulate the installed layout: this module plus its bundled manifest, nothing else.
        installed = self.tmp / "installed"
        installed.mkdir()
        shutil.copy(PKG / "harness_cli.py", installed / "harness_cli.py")
        shutil.copy(PKG / "model-manifest.json", installed / "model-manifest.json")
        env = {k: v for k, v in os.environ.items() if k != "HARNESS_CLI_MODEL_MANIFEST"}
        code = (
            "import sys, json; sys.path.insert(0, %r); import harness_cli as hc; "
            "print(json.dumps(hc.load_manifest_minimums()))" % str(installed)
        )
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        minimums = json.loads(out.stdout)
        self.assertEqual(minimums["driver"]["claude"], "2.1.280")
        self.assertEqual(minimums["models"]["claude"]["claude-haiku-5-5"], "2.1.293")

    def test_missing_manifest_fails_with_a_clear_error(self) -> None:
        with mock.patch.dict(os.environ, {"HARNESS_CLI_MODEL_MANIFEST": str(self.tmp / "nope.json")}):
            with self.assertRaises(hc.HarnessError) as ctx:
                hc.load_manifest_minimums()
        self.assertIn("model manifest not found", str(ctx.exception))


class BeforeReleaseTests(FakeCliTestCase):
    def test_before_release_stages_and_canaries_both_and_prints_pins(self) -> None:
        self.publish_both_for_release("2.1.316", "0.166.0")
        with mock.patch.object(hc, "canary", side_effect=passing_canary), \
             mock.patch.object(hc, "harness_home_hashes", return_value={}):
            pins = hc.before_release()
        self.assertEqual(pins["claude"]["version"], "2.1.316")
        self.assertEqual(pins["codex"]["version"], "0.166.0")
        self.assertTrue(pins["claude"]["passed"] and pins["codex"]["passed"])
        self.assertTrue((self.root / "claude" / "2.1.316" / "bin" / "claude").is_file())
        self.assertTrue((self.root / "codex" / "0.166.0" / "bin" / "codex").is_file())

    def publish_both_for_release(self, claude_latest: str, codex_latest: str) -> None:
        AutoTests.publish_both(self, claude_latest, codex_latest)


class StatusAndNotifyTests(FakeCliTestCase):
    def test_status_lists_both_tools(self) -> None:
        status = hc.status()
        self.assertIn("claude", status)
        self.assertIn("codex", status)
        self.assertFalse(status["autoRotateCodex"])

    def test_notify_records_key_once(self) -> None:
        hc.notify_once("harness-cli:claude:9.9.9", "info", "hello")
        hc.notify_once("harness-cli:claude:9.9.9", "info", "hello")
        self.assertEqual(self.notify_log.read_text(encoding="utf-8").count("harness-cli:claude:9.9.9"), 1)

    def test_failed_notice_retries_without_candidate_discovery(self) -> None:
        with mock.patch.object(hc, "notify", side_effect=[False, False, True]) as send:
            hc.notify_once("key", "info", "exact text")
            hc.retry_pending_notices()
            self.assertIn("key", hc.load_state()["pendingNotices"])
            with mock.patch.object(hc, "discover", return_value={}):
                hc.auto()
            self.assertNotIn("key", hc.load_state()["pendingNotices"])
            self.assertEqual(send.call_args_list[-1].args, ("key", "info", "exact text"))

    def test_cli_rejects_home_without_keychain(self) -> None:
        with mock.patch.object(hc.sys, "platform", "darwin"):
            with self.assertRaises(hc.HarnessError):
                hc.run_cli(Path("/not/executed"), [], env={"HOME": str(self.tmp / "missing")})

    def test_prepare_home_creates_keychain_before_spawn(self) -> None:
        self.home_patch.stop()
        home = self.tmp / "isolated"
        keychain = home / "Library" / "Keychains" / "login.keychain-db"
        def create(cmd, **kwargs):
            self.assertEqual(kwargs["env"]["HOME"], str(home))
            self.assertEqual(cmd[-1], str(keychain))
            keychain.touch()
            return subprocess.CompletedProcess(cmd, 0)
        try:
            with mock.patch.object(hc.sys, "platform", "darwin"), \
                 mock.patch.object(hc.subprocess, "run", side_effect=create):
                hc.prepare_isolated_home(home)
                hc.require_isolated_home({"HOME": str(home)})
        finally:
            self.home_patch.start()


if __name__ == "__main__":
    unittest.main()
