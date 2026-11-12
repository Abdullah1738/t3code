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
from contextlib import closing, redirect_stdout
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


def passing_codex_home(models: list[str], version: str = "0.166.0") -> dict:
    window = hc.CODEX_OBSERVATION_SECONDS
    return {"memoryCanaryChecked": True, "memoryPipelineRan": False, "memorySentinelSeen": False,
            "memoryPipelineEvidence": [], "memoryPipelineRequests": 0,
            "positiveControlEvidence": ["memories_1.sqlite:stage1_outputs:content"],
            "memoryPromptSeen": False, "positiveControlFired": True, "readControlFired": True,
            "positiveElapsedSeconds": window / 2, "observationComplete": True,
            "memoryAudit": passing_audit(version), "positiveControlAudit": passing_audit(version, positive=True),
            "observationWindowSeconds": window, "observedSeconds": [window] * len(models),
            "requests": len(models) + 1, "recorderViolations": 0,
            "models": {model: {"ok": True, "requests": 1, "memoryPipelineRequests": 0,
                                "memorySentinelInRequest": False, "memorySentinelInPrimaryRequest": False,
                                "memorySectionInRequest": False} for model in models}}


def passing_audit(version: str = "0.166.0", *, positive=False) -> dict:
    spec = hc.CODEX_MEMORY_VERIFIED[version]
    return {"method": "sqlite-triggers-v1", "sourceCommit": spec["sourceCommit"], "identityVerified": True,
            "stores": {name: {"rowCounts": {"jobs": int(positive), "stage1_outputs": int(positive)},
                               "activity": {"jobs": 1, "stage1_outputs": 1} if positive else {},
                               "consolidationProgress": [[1, 0]]} for name in spec["databases"]}}


def passing_codex_result(version: str = "0.166.0") -> dict:
    return {**passing_codex_home(hc.MODEL_CANARIES["codex"], version),
            "cu": passing_codex_home(hc.CODEX_CU_MODELS, version)}


def passing_claude_result() -> dict:
    return {"memoryCanaryChecked": True, "memoryCanaryLeaked": False, "thinkingCheckChecked": True,
            "thinkingSettingsChecked": True, "thinkingInconclusive": False,
            "thinkingAttempts": [{"status": "passed", "settingsChecked": True, "turn1ThinkingBlocks": 1}],
            "thinkingReplayed": True, "inputTransformationsEmpty": True, "requests": 3,
            "recorderViolations": 0, **{model: {"ok": True} for model in hc.MODEL_CANARIES["claude"]}}


COMPANION_BYTES = {"codex-code-mode-host": b"#!/bin/sh\n# code-mode-host\nexit 0\n",
                   "rg": b"#!/bin/sh\n# rg\nexit 0\n"}


def ensure_codex_companions(version: str) -> dict:
    """Give a hand-built codex tree its companions at the package layout plus a stage record,
    the way stage() leaves it. A tree that already has a record is left as it is."""
    if hc.recorded_companions("codex", version) is None:
        target = hc.version_dir("codex", version)
        hashes = {}
        for spec in hc.companion_specs("codex"):
            path = target / spec["dest"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(COMPANION_BYTES[spec["name"]])
            path.chmod(0o555)
            hashes[spec["name"]] = hc.sha256_file(path)
        hc.write_record("stage", "codex", version, "staged",
                        binarySha256=hc.sha256_file(target / "bin" / "codex"), companions=hashes)
    return hc.verify_companions("codex", version)


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
            "HARNESS_CLI_PYTHON": sys.executable,
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
        # Fake scripts use an interpreter; real-binary containment is tested separately.
        def fake_run_cli(binary, args, *, env, timeout=300, cwd=None, hold_complete=None, **_):
            hc.require_isolated_home(env)
            result = subprocess.run([str(binary), *args], env=env, cwd=cwd, capture_output=True,
                                    text=True, timeout=timeout)
            if hold_complete is not None and not hold_complete():
                raise hc.HarnessError("Codex exited before its memory observation window completed")
            return result
        self.run_patch = mock.patch.object(hc, "run_cli", side_effect=fake_run_cli)
        self.run_patch.start()
        self.write_fake_npm()
        self.write_notify_stub()
        self.write_plist()

    def tearDown(self) -> None:
        self.run_patch.stop()
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
messages[0]["content"] = sys.argv[sys.argv.index("-p") + 1]
body = {"messages": messages, "thinking": {"type": "adaptive"}, "output_config": {"effort": "max"}, "context_management": {"edits": [{"type": "clear_thinking_20251015"}]}}
req = urllib.request.Request(base + "/v1/messages", data=json.dumps(body).encode(),
                             headers={"content-type": "application/json", "anthropic-beta": "context-management-test"})
response = json.loads(urllib.request.urlopen(req, timeout=10).read())
if "--session-id" in sys.argv:
    session.write_text(json.dumps(response["content"][0]))
print("ROBOB-THINK-4417" if "--resume" in sys.argv else "OK 11440 407")
'''
        return (script.replace("/opt/homebrew/bin/python3", sys.executable)
                .replace("VERSION", version).replace("LEAK", str("ROBOB-MEMCANARY" in body_extra)).encode())

    def fake_codex_binary(self, version: str, body_extra: str = "", *, leak_read: bool = False) -> bytes:
        script = r'''#!/opt/homebrew/bin/python3
import json, os, sys, tomllib, urllib.request, sqlite3
from pathlib import Path
if "--version" in sys.argv:
    print("codex-cli VERSION"); sys.exit(0)
home = Path(os.environ["CODEX_HOME"])
config = tomllib.loads((home / "config.toml").read_text())
assert "--ephemeral" not in sys.argv
if "gpt-6.1-terra" in sys.argv:
    assert config.get("model") == "gpt-6.1-terra"
    assert config.get("features", {}).get("computer_use") is True
    assert config.get("model_context_window") == 1050000
    assert (home / "models.json").is_file() and (home / "AGENTS.md").is_file()
if (config.get("features", {}).get("memories") and (home / "fixture-id").exists()) or LEAK:
    (home / "memories" / "phase2-output").write_text("pipeline ran")
    conn = sqlite3.connect(home / "memories_1.sqlite")
    conn.execute("CREATE TABLE IF NOT EXISTS stage1_outputs (thread_id TEXT, raw_memory TEXT, rollout_summary TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS jobs (status TEXT)")
    conn.execute("INSERT OR REPLACE INTO stage1_outputs (thread_id,source_updated_at,raw_memory,rollout_summary,generated_at) VALUES (?,0,'extracted preference','',0)", ((home / "fixture-id").read_text() if (home / "fixture-id").exists() else "fake",))
    conn.execute("INSERT OR REPLACE INTO jobs (kind,job_key,status,retry_remaining) VALUES ('memory_stage1','fixture','done',0)")
    conn.commit(); conn.close()
enabled = config.get("features", {}).get("memories")
input_text = (home / "memories" / "MEMORY.md").read_text() if enabled else "hello"
if LEAK_READ:
    input_text = "<memory>loaded prior memory</memory>"
body = {"input": [{"role": "developer", "content": [{"type": "input_text", "text": input_text}]},
                  {"role": "user", "content": [{"type": "input_text", "text": sys.argv[-1]}]}]}
if enabled and (home / "fixture-id").exists():
    pipeline = {"text":{"format":{"schema":{"properties":{"raw_memory":{}}}}}}
    urllib.request.urlopen(urllib.request.Request(os.environ["NINEROUTER_BASE"] + "/v1/responses", data=json.dumps(pipeline).encode()), timeout=10).read()
req = urllib.request.Request(os.environ["NINEROUTER_BASE"] + "/v1/responses", data=json.dumps(body).encode(), method="POST")
urllib.request.urlopen(req, timeout=10).read()
print("OK")
'''
        return (script.replace("/opt/homebrew/bin/python3", sys.executable)
                .replace("VERSION", version).replace("LEAK_READ", str(leak_read))
                .replace("LEAK", str(bool(body_extra))).encode())

    def package_tgz(self, name: str, tool: str, version: str, binary: bytes, *,
                    omit: tuple[str, ...] = ()) -> Path:
        path = self.tmp / f"{name}.tgz"
        rel = hc.TOOLS[tool]["binary_in_native"]
        members = {rel: binary}
        modes = {rel: 0o755}
        for spec in hc.companion_specs(tool):
            if spec["name"] in omit:
                continue
            member = os.path.normpath(os.path.join(os.path.dirname(rel), spec["source"]))
            members[member] = COMPANION_BYTES[spec["name"]]
            modes[member] = 0o755
        make_tgz(path, members, modes=modes)
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

    def test_codex_stage_copies_companions_in_the_package_layout(self) -> None:
        self.publish("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        result = hc.stage("codex", "0.166.0")
        target = self.root / "codex" / "0.166.0"
        # Same three paths CodexInstallation.ts checks: bin/codex, bin/codex-code-mode-host, codex-path/rg.
        for rel in ("bin/codex", "bin/codex-code-mode-host", "codex-path/rg"):
            self.assertTrue((target / rel).is_file(), rel)
            self.assertTrue(os.stat(target / rel).st_mode & stat.S_IXUSR, rel)
            self.assertFalse(os.stat(target / rel).st_mode & stat.S_IWUSR, rel)
        self.assertFalse((target / "bin" / "rg").exists())
        self.assertFalse(os.stat(target / "codex-path").st_mode & stat.S_IWUSR)
        self.assertEqual(result["companions"], {
            "codex-code-mode-host": hc.sha256_file(target / "bin" / "codex-code-mode-host"),
            "rg": hc.sha256_file(target / "codex-path" / "rg")})
        self.assertEqual(hc.recorded_companions("codex", "0.166.0"), result["companions"])
        self.assertEqual(hc.verify_companions("codex", "0.166.0"), result["companions"])

    def test_codex_stage_without_rg_warns_and_records_null(self) -> None:
        pkg = hc.pack_spec("codex", "0.166.0")
        tgz = self.package_tgz("codex-no-rg", "codex", "0.166.0", self.fake_codex_binary("0.166.0"), omit=("rg",))
        self.set_npm(latest={pkg: "0.166.0"}, tarballs={pkg: tgz}, integrity={pkg: sri(tgz.read_bytes())})
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            result = hc.stage("codex", "0.166.0")
        target = self.root / "codex" / "0.166.0"
        self.assertIn("optional companion rg", err.getvalue())
        self.assertIsNone(result["companions"]["rg"])
        self.assertTrue((target / "bin" / "codex-code-mode-host").is_file())
        self.assertFalse((target / "codex-path").exists())
        stage_record = [r for r in hc.tool_records("codex", "0.166.0") if r["action"] == "stage"][-1]
        self.assertIsNone(stage_record["companions"]["rg"])
        self.assertTrue(stage_record["warnings"])
        # Null is accepted by verification; a required companion still has to be there.
        self.assertIsNone(hc.verify_companions("codex", "0.166.0")["rg"])

    def test_codex_stage_refuses_a_package_without_its_code_mode_host(self) -> None:
        pkg = hc.pack_spec("codex", "0.166.0")
        tgz = self.tmp / "codex-missing.tgz"
        rel = hc.TOOLS["codex"]["binary_in_native"]
        make_tgz(tgz, {rel: self.fake_codex_binary("0.166.0")}, modes={rel: 0o755})
        self.set_npm(latest={pkg: "0.166.0"}, tarballs={pkg: tgz}, integrity={pkg: sri(tgz.read_bytes())})
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.stage("codex", "0.166.0")
        self.assertIn("companion", str(ctx.exception))
        self.assertFalse((self.root / "codex" / "0.166.0").exists())

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
        canary = ({**passing_claude_result(), "memoryCanaryLeaked": not memory_ok}
                  if tool == "claude" else {**passing_codex_result(), "memoryPipelineRan": not memory_ok})
        binary = self.root / tool / version / "bin" / tool
        hc.write_record("canary", tool, version, "passed" if passed else "failed",
                        binarySha256=hc.sha256_file(binary), canary=canary, canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)

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

    def test_legacy_pass_record_cannot_promote(self) -> None:
        self.install_version("claude", "2.1.316")
        binary = self.root / "claude" / "2.1.316" / "bin" / "claude"
        hc.write_record("canary", "claude", "2.1.316", "passed", binarySha256=hc.sha256_file(binary),
                        canary={"memoryCanaryChecked": True, "thinkingCheckChecked": True,
                                "thinkingReplayed": True, "inputTransformationsEmpty": True})
        self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("claude", "2.1.316")

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
        ensure_codex_companions(version)

    def record_codex_canary(self, version: str) -> None:
        hc.write_record("canary", "codex", version, "passed",
                        binarySha256=hc.sha256_file(self.root / "codex" / version / "bin" / "codex"),
                        canarySchemaVersion=hc.CANARY_SCHEMA_VERSION,
                        companions=ensure_codex_companions(version),
                        canary=passing_codex_result(version))

    def test_incomplete_or_corrupt_codex_proof_cannot_promote(self) -> None:
        self.install_codex("0.166.0")
        for target in ("plain", "cu"):
            for field in ("memorySentinelSeen", "memoryPipelineRan", "memoryPromptSeen", "models",
                          "observedSeconds", "positiveElapsedSeconds", "recorderViolations",
                          "memoryAudit", "positiveControlAudit"):
                with self.subTest(target=target, field=field):
                    proof = passing_codex_result()
                    home = proof if target == "plain" else proof["cu"]
                    del home[field]
                    hc.write_record("canary", "codex", "0.166.0", "passed", canary=proof,
                                    companions=ensure_codex_companions("0.166.0"),
                                    binarySha256=hc.sha256_file(self.root / "codex" / "0.166.0" / "bin" / "codex"),
                                    canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)
                    self.assertFalse(hc.latest_canary("codex", "0.166.0")["passed"])
                    with self.assertRaises(hc.HarnessError):
                        hc.promote("codex", "0.166.0")

        for target in ("plain", "cu"):
            for field, value in (("memoryPipelineRequests", 1),
                                 ("memoryPipelineEvidence", ["recorded-pipeline-request"]),
                                 ("positiveControlEvidence", [])):
                with self.subTest(target=target, field=field):
                    proof = passing_codex_result()
                    (proof if target == "plain" else proof["cu"])[field] = value
                    self.assertFalse(hc.valid_codex_canary_home(
                        proof if target == "plain" else proof["cu"],
                        hc.MODEL_CANARIES["codex"] if target == "plain" else hc.CODEX_CU_MODELS, "0.166.0"))

    def test_codex_record_with_another_versions_source_commit_cannot_promote(self) -> None:
        for version, other in (("0.167.1", "0.166.0"), ("0.166.0", "0.167.1")):
            with self.subTest(version=version, audit=other):
                if not (self.root / "codex" / version).exists():
                    self.install_codex(version)
                for target in ("plain", "cu"):
                    proof = passing_codex_result(version)
                    home = proof if target == "plain" else proof["cu"]
                    home["memoryAudit"] = passing_audit(other)
                    hc.write_record("canary", "codex", version, "passed", canary=proof,
                                    companions=ensure_codex_companions(version),
                                    binarySha256=hc.sha256_file(self.root / "codex" / version / "bin" / "codex"),
                                    canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)
                    self.assertFalse(hc.latest_canary("codex", version)["passed"])
                    with self.assertRaises(hc.HarnessError):
                        hc.promote("codex", version)
                self.record_codex_canary(version)
                self.assertTrue(hc.latest_canary("codex", version)["passed"])

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
                        canarySchemaVersion=hc.CANARY_SCHEMA_VERSION,
                        canary=passing_claude_result())


class CanaryTests(FakeCliTestCase):
    """The canary runs the real generator on throwaway homes and drives a fake CLI through the proxy."""

    def setUp(self) -> None:
        super().setUp()
        self.gen = self.homes_pkg / "generate_homes.py"
        shutil.copy(PKG.parent / "harness-homes" / "generate_homes.py", self.gen)
        shutil.copytree(PKG.parent / "harness-homes" / "vendor", self.homes_pkg / "vendor")
        shutil.copy(PKG.parent / "harness-homes" / "manifest.json", self.homes_pkg / "manifest.json")
        shutil.copytree(PKG.parent / "harness-homes" / "overlays", self.homes_pkg / "overlays")
        manifest = json.loads((self.homes_pkg / "manifest.json").read_text(encoding="utf-8"))
        for sources in manifest.get("paritySources", {}).values():
            for source in sources:
                relative = source if isinstance(source, str) else source["source"]
                destination = self.homes_pkg / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(PKG.parent / "harness-homes" / relative, destination)
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
        def fake_seed(chome, work, version):
            (chome / "fixture-id").write_text("fixture")
            return "fixture"
        self.seed_patch = mock.patch.object(hc, "seed_codex_rollout", side_effect=fake_seed)
        self.seed_mock = self.seed_patch.start()
        self.addCleanup(self.seed_patch.stop)
        self.observation_patch = mock.patch.object(hc, "CODEX_OBSERVATION_SECONDS", 0.10)
        self.observation_patch.start()
        self.addCleanup(self.observation_patch.stop)

    def install_binary(self, tool: str, version: str, body: bytes) -> Path:
        bin_dir = self.root / tool / version / "bin"
        bin_dir.mkdir(parents=True)
        name = "claude" if tool == "claude" else "codex"
        path = bin_dir / name
        path.write_bytes(body)
        path.chmod(0o755)
        if tool == "codex":
            ensure_codex_companions(version)
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

    def test_no_thinking_retries_once_but_cannot_turn_inconclusive_into_pass(self) -> None:
        body = self.fake_claude_binary("2.1.316").replace(
            b'if "--session-id" in sys.argv:\n    session.write_text',
            b'if "--session-id" in sys.argv and response["content"]:\n    session.write_text')
        self.install_binary("claude", "2.1.316", body)
        capture = hc.Recorder.capture_response
        seen = []
        def no_first_thinking(recorder, payload, record):
            capture(recorder, payload, record)
            seen.append(record)
            if len(seen) == 1:
                record["response_thinking"] = []
        with mock.patch.object(hc.Recorder, "capture_response", no_first_thinking):
            verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"], verdict)
        result = verdict["result"]
        self.assertTrue(result["thinkingInconclusive"])
        self.assertEqual([a["status"] for a in result["thinkingAttempts"]], ["inconclusive", "passed"])
        self.assertTrue(result["thinkingReplayed"])
        self.assertEqual(json.loads(hc.records_path().read_text().splitlines()[-1])["result"], "inconclusive")
        with self.assertRaises(hc.HarnessError):
            hc.promote("claude", "2.1.316")

    def test_thinking_replay_failure_is_not_retried(self) -> None:
        body = self.fake_claude_binary("2.1.316").replace(
            b'if "--resume" in sys.argv and session.exists():', b'if False:')
        self.install_binary("claude", "2.1.316", body)
        verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"])
        self.assertFalse(verdict["result"]["thinkingInconclusive"])
        self.assertEqual(len(verdict["result"]["thinkingAttempts"]), 1)
        self.assertEqual(verdict["result"]["requests"], 3)

    def test_missing_thinking_exhausts_bounded_retry(self) -> None:
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        capture = hc.Recorder.capture_response
        def no_thinking(recorder, payload, record):
            capture(recorder, payload, record)
            record["response_thinking"] = []
        with mock.patch.object(hc.Recorder, "capture_response", no_thinking):
            verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"])
        self.assertEqual([a["status"] for a in verdict["result"]["thinkingAttempts"]],
                         ["inconclusive", "inconclusive"])
        self.assertEqual(verdict["result"]["requests"], 4)

    def test_claude_ignored_thinking_effort_flags_block_promotion(self) -> None:
        body = self.fake_claude_binary("2.1.316").replace(b'"effort": "max"', b'"effort": "high"')
        self.install_binary("claude", "2.1.316", body)
        verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"])
        self.assertFalse(verdict["result"]["thinkingSettingsChecked"])

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

    def test_signed_empty_thinking_replay_is_detected(self) -> None:
        payload = b'{"content":[{"type":"thinking","thinking":"","signature":"signature"}]}'
        record = {}
        hc.Recorder("http://127.0.0.1:20128", "dummy").capture_response(payload, record)
        req = {"body": {"messages": [{"role": "assistant", "content": [{"type": "thinking",
                "thinking": "", "signature": "signature"}]}]}, "response_transformations": [[]]}
        result = hc.thinking_replay_check([record], [req])
        self.assertTrue(result["thinkingReplayed"])
        self.assertEqual(result["turn1SignedBlocks"], 1)
        self.assertTrue(result["inputTransformationsEmpty"])

    def test_all_thinking_blocks_must_replay_in_order(self) -> None:
        first = [{"response_thinking": [{"type": "thinking", "thinking": "a", "signature": "one"},
                                       {"type": "redacted_thinking", "data": "opaque"}]}]
        def request(blocks):
            return {"body": {"messages": [{"role": "assistant", "content": blocks}]}, "response_transformations": [[]]}
        a = {"type": "thinking", "thinking": "a", "signature": "one"}
        b = {"type": "redacted_thinking", "data": "opaque"}
        self.assertFalse(hc.thinking_replay_check(first, [request([a])])["thinkingReplayed"])
        self.assertFalse(hc.thinking_replay_check(first, [request([b, a])])["thinkingReplayed"])
        self.assertTrue(hc.thinking_replay_check(first, [request([a, b])])["thinkingReplayed"])
        dropped = {**request([]), "response_transformations": [[{"type": "dropped_thinking"}]]}
        self.assertFalse(hc.thinking_replay_check(first, [request([a, b]), dropped])["inputTransformationsEmpty"])
        self.assertFalse(hc.thinking_replay_check([{"response_thinking": [b]}], [request([b])])["thinkingReplayed"])

    def test_nested_tool_input_is_not_transformation_evidence(self) -> None:
        record = {}
        hc.Recorder("http://127.0.0.1:20128", "dummy").capture_response(
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
            self.assertTrue(result["memoryCanaryChecked"])
            self.assertTrue(hc.valid_codex_memory_audit(result["memoryAudit"], version="0.166.0", clean=True))
            self.assertTrue(result["readControlFired"])
            self.assertFalse(result["memorySentinelSeen"])
            self.assertFalse(result["memoryPromptSeen"])
            self.assertIn("memories/MEMORY.md", result["memoryBaseline"])
        hc.promote("codex", "0.166.0")

    def test_codex_0_167_1_canary_passes_with_its_own_audit_and_promotes(self) -> None:
        self.install_binary("codex", "0.167.1", self.fake_codex_binary("0.167.1"))
        verdict = self.run_canary("codex", "0.167.1")
        self.assertTrue(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertTrue(result["memoryCanaryChecked"])
            self.assertEqual(result["memoryAudit"]["sourceCommit"], hc.CODEX_MEMORY_VERIFIED["0.167.1"]["sourceCommit"])
            self.assertTrue(hc.valid_codex_memory_audit(result["memoryAudit"], version="0.167.1", clean=True))
            self.assertFalse(hc.valid_codex_memory_audit(result["memoryAudit"], version="0.166.0", clean=True))
        hc.promote("codex", "0.167.1")

    def test_unverified_codex_version_canary_fails_closed(self) -> None:
        self.install_binary("codex", "0.168.0", self.fake_codex_binary("0.168.0"))
        verdict = self.run_canary("codex", "0.168.0")
        self.assertFalse(verdict["passed"], verdict)
        self.assertIn("Codex memory audit schema has not been verified for this version", verdict["reasons"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.168.0")

    def test_clean_codex_record_without_audit_cannot_promote(self) -> None:
        self.install_binary("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        passing_canary("codex", "0.166.0")
        record = json.loads(hc.records_path().read_text().splitlines()[-1])
        del record["canary"]["memoryAudit"]
        hc.append_record(record)
        self.assertFalse(hc.latest_canary("codex", "0.166.0")["passed"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

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

    def test_codex_bootstrap_only_read_leak_blocks_both_homes(self) -> None:
        body = self.fake_codex_binary("0.166.0").replace(
            b'input_text = (home / "memories" / "MEMORY.md").read_text() if enabled else "hello"',
            b'input_text = (home / "memories" / "MEMORY.md").read_text() if enabled or not (home / "fixture-id").exists() else "hello"')
        self.install_binary("codex", "0.166.0", body)
        verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertTrue(result["memorySentinelSeen"])
            self.assertTrue(all(not m["memorySentinelInRequest"] for m in result["models"].values()))
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_each_home_independently_blocks_promotion_on_bootstrap_leak(self) -> None:
        for target in ("plain", "cu"):
            with self.subTest(target=target):
                condition = (b'config.get("features", {}).get("computer_use")' if target == "cu"
                             else b'not config.get("features", {}).get("computer_use")')
                body = self.fake_codex_binary("0.166.0").replace(
                    b'input_text = (home / "memories" / "MEMORY.md").read_text() if enabled else "hello"',
                    b'input_text = (home / "memories" / "MEMORY.md").read_text() if enabled or '
                    b'(not (home / "fixture-id").exists() and ' + condition + b') else "hello"')
                binary = self.root / "codex" / "0.166.0" / "bin" / "codex"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(body)
                binary.chmod(0o755)
                ensure_codex_companions("0.166.0")
                verdict = self.run_canary("codex", "0.166.0")
                self.assertFalse(verdict["passed"], verdict)
                self.assertEqual(verdict["result"]["memorySentinelSeen"], target == "plain")
                self.assertEqual(verdict["result"]["cu"]["memorySentinelSeen"], target == "cu")
                with self.assertRaises(hc.HarnessError):
                    hc.promote("codex", "0.166.0")

    def test_delayed_disabled_extraction_blocks_both_homes(self) -> None:
        body = self.fake_codex_binary("0.166.0")
        body = body.replace(b'import json, os, sys, tomllib, urllib.request, sqlite3',
                            b'import json, os, sys, tomllib, urllib.request, sqlite3, threading, time')
        body = body.replace(b'if (config.get("features", {}).get("memories") and (home / "fixture-id").exists()) or False:',
                            b'if (home / "fixture-id").exists():')
        start = body.index(b'    (home / "memories" / "phase2-output").write_text')
        end = body.index(b'enabled = config.get', start)
        block = body[start:end]
        delayed = b'    def extract():\n' + b''.join(b'    ' + line for line in block.splitlines(keepends=True))
        delayed += (b'    if not config.get("features", {}).get("memories"):\n'
                    b'        timer = threading.Timer(0.20, extract); timer.daemon = True; timer.start()\n'
                    b'    else: extract()\n')
        body = body[:start] + delayed + body[end:]
        # The daemon is killed with its process if the primary response is not held.
        # Keep the scaled delay comfortably inside the hold even on a busy machine.
        self.install_binary("codex", "0.166.0", body)
        with mock.patch.object(hc, "CODEX_OBSERVATION_SECONDS", 1.0):
            verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertTrue(result["positiveControlFired"])
            self.assertTrue(result["memoryPipelineRan"], result)
            self.assertTrue(result["observationComplete"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_each_home_independently_blocks_promotion_on_delayed_pipeline(self) -> None:
        for target in ("plain", "cu"):
            with self.subTest(target=target):
                condition = (b'config.get("features", {}).get("computer_use")' if target == "cu"
                             else b'not config.get("features", {}).get("computer_use")')
                body = self.fake_codex_binary("0.166.0").replace(
                    b'import json, os, sys, tomllib, urllib.request, sqlite3',
                    b'import json, os, sys, tomllib, urllib.request, sqlite3, threading')
                body = body.replace(b'body = {"input":',
                    b'if not enabled and (home / "fixture-id").exists() and ' + condition + b':\n'
                    b'    timer = threading.Timer(0.20, lambda: (home / "memories" / "phase2-output").write_text("pipeline")); timer.daemon = True; timer.start()\n'
                    b'body = {"input":')
                binary = self.root / "codex" / "0.166.0" / "bin" / "codex"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(body)
                binary.chmod(0o755)
                ensure_codex_companions("0.166.0")
                with mock.patch.object(hc, "CODEX_OBSERVATION_SECONDS", 1.0):
                    verdict = self.run_canary("codex", "0.166.0")
                self.assertFalse(verdict["passed"], verdict)
                self.assertEqual(verdict["result"]["memoryPipelineRan"], target == "plain")
                self.assertEqual(verdict["result"]["cu"]["memoryPipelineRan"], target == "cu")
                with self.assertRaises(hc.HarnessError):
                    hc.promote("codex", "0.166.0")

    def test_control_must_validate_pipeline_detector_and_primary_read(self) -> None:
        for change in ("unrecognized-pipeline", "bootstrap-only-read", "no-during-hold-output"):
            with self.subTest(change=change):
                body = self.fake_codex_binary("0.166.0")
                if change == "unrecognized-pipeline":
                    body = body.replace(b'"raw_memory":{}', b'"unrecognized":{}')
                elif change == "bootstrap-only-read":
                    body = body.replace(
                        b'input_text = (home / "memories" / "MEMORY.md").read_text() if enabled else "hello"',
                        b'input_text = (home / "memories" / "MEMORY.md").read_text() if not (home / "fixture-id").exists() else "hello"')
                binary = self.root / "codex" / "0.166.0" / "bin" / "codex"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(body)
                binary.chmod(0o755)
                ensure_codex_companions("0.166.0")
                if change == "no-during-hold-output":
                    with mock.patch.object(hc, "wait_for_codex_fixture", return_value=False):
                        verdict = self.run_canary("codex", "0.166.0")
                else:
                    verdict = self.run_canary("codex", "0.166.0")
                self.assertFalse(verdict["passed"], verdict)
                for result in (verdict["result"], verdict["result"]["cu"]):
                    self.assertFalse(result["memoryCanaryChecked"])
                    if change == "bootstrap-only-read":
                        self.assertFalse(result["readControlFired"])
                    else:
                        self.assertFalse(result["positiveControlFired"])
                with self.assertRaises(hc.HarnessError):
                    hc.promote("codex", "0.166.0")

    def test_bad_pipeline_schema_supersedes_a_passing_record(self) -> None:
        for target in ("plain", "cu"):
            with self.subTest(target=target):
                binary = self.root / "codex" / "0.166.0" / "bin" / "codex"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(self.fake_codex_binary("0.166.0").replace(
                    b'body = {"input":',
                    b'if (home / "fixture-id").exists() and '
                    + (b'config.get("features", {}).get("computer_use")' if target == "cu"
                       else b'not config.get("features", {}).get("computer_use")')
                    + b':\n    urllib.request.urlopen(urllib.request.Request(os.environ["NINEROUTER_BASE"] + "/v1/responses", data=b\'{"text":{"format":"plain"}}\'), timeout=10).read()\n'
                    b'body = {"input":'))
                binary.chmod(0o755)
                ensure_codex_companions("0.166.0")
                passing_canary("codex", "0.166.0")
                verdict = self.run_canary("codex", "0.166.0")
                self.assertFalse(verdict["passed"], verdict)
                self.assertTrue(any("cannot inspect Codex request format" in r for r in verdict["reasons"]))
                self.assertFalse(hc.latest_canary("codex", "0.166.0")["passed"])
                with self.assertRaises(hc.HarnessError):
                    hc.promote("codex", "0.166.0")

    def test_pipeline_request_without_artifact_blocks_both_homes(self) -> None:
        body = self.fake_codex_binary("0.166.0").replace(
            b'body = {"input":',
            b'if not enabled and (home / "fixture-id").exists():\n'
            b'    pipeline = {"text":{"format":{"schema":{"properties":{"raw_memory":{}}}}}}\n'
            b'    urllib.request.urlopen(urllib.request.Request(os.environ["NINEROUTER_BASE"] + "/v1/responses", data=json.dumps(pipeline).encode()), timeout=10).read()\n'
            b'body = {"input":')
        self.install_binary("codex", "0.166.0", body)
        verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertIn("recorded-pipeline-request", result["memoryPipelineEvidence"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_unknown_pipeline_request_blocks_both_homes(self) -> None:
        body = self.fake_codex_binary("0.166.0").replace(
            b'body = {"input":',
            b'if not enabled and (home / "fixture-id").exists():\n'
            b'    pipeline = {"text":{"format":{"schema":{"properties":{"memory_text":{}}}}}}\n'
            b'    urllib.request.urlopen(urllib.request.Request(os.environ["NINEROUTER_BASE"] + "/v1/responses", data=json.dumps(pipeline).encode()), timeout=10).read()\n'
            b'body = {"input":')
        self.install_binary("codex", "0.166.0", body)
        verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertIn("unaccounted-request", result["memoryPipelineEvidence"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_recorder_stop_drains_partially_received_pipeline_request(self) -> None:
        import http.client
        import socket
        import threading
        recorder = hc.Recorder(hc.nine_router_url(), "dummy")
        port = int(recorder.start().rsplit(":", 1)[1])
        handler_entered = threading.Event()
        original_get_request = recorder.server.get_request
        def get_request():
            result = original_get_request()
            handler_entered.set()
            return result
        recorder.server.get_request = get_request
        client = socket.create_connection(("127.0.0.1", port))
        self.addCleanup(client.close)
        payload = json.dumps({"text": {"format": {"schema": {"properties": {"raw_memory": {}}}}}}).encode()
        client.sendall(b"POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: "
                       + str(len(payload)).encode() + b"\r\nConnection: close\r\n\r\n" + payload[:1])
        self.assertTrue(handler_entered.wait(3))
        accepted = threading.Event()
        finished = threading.Event()
        original_shutdown = recorder.server.shutdown
        def shutdown():
            original_shutdown()
            accepted.set()
        recorder.server.shutdown = shutdown
        def stop():
            recorder.stop()
            finished.set()
        worker = threading.Thread(target=stop)
        worker.start()
        self.assertTrue(accepted.wait(3))
        self.assertFalse(finished.is_set())
        client.sendall(payload[1:])
        response = http.client.HTTPResponse(client)
        response.begin(); response.read()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(finished.is_set())
        self.assertTrue(any(hc.codex_pipeline_request(r["body"]) for r in recorder.requests))

    def test_delayed_memory_job_without_artifact_blocks_both_homes(self) -> None:
        body = self.fake_codex_binary("0.166.0")
        body = body.replace(b'import json, os, sys, tomllib, urllib.request, sqlite3',
                            b'import json, os, sys, tomllib, urllib.request, sqlite3, threading')
        body = body.replace(b'body = {"input":',
            b'if not enabled and (home / "fixture-id").exists():\n'
            b'    def queue_job():\n'
            b'        conn = sqlite3.connect(home / "memories_1.sqlite"); conn.execute("CREATE TABLE IF NOT EXISTS stage1_outputs (thread_id TEXT, raw_memory TEXT, rollout_summary TEXT)")\n'
            b'        conn.execute("INSERT INTO jobs (kind,job_key,status,retry_remaining) VALUES (\'memory_stage1\',\'fixture\',\'queued\',0)"); conn.commit(); conn.close()\n'
            b'    timer = threading.Timer(0.20, queue_job); timer.daemon = True; timer.start()\n'
            b'body = {"input":')
        self.install_binary("codex", "0.166.0", body)
        with mock.patch.object(hc, "CODEX_OBSERVATION_SECONDS", 1.0):
            verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertIn("memories_1.sqlite:jobs", result["memoryPipelineEvidence"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_job_created_and_deleted_in_one_transaction_blocks_both_homes(self) -> None:
        body = self.fake_codex_binary("0.166.0").replace(
            b'body = {"input":',
            b'if not enabled and (home / "fixture-id").exists():\n'
            b'    conn = sqlite3.connect(home / "memories_1.sqlite")\n'
            b'    conn.execute("INSERT INTO jobs (kind,job_key,status,retry_remaining) VALUES (\'memory_stage1\',\'fixture\',\'queued\',0)")\n'
            b'    conn.execute("DELETE FROM jobs"); conn.commit(); conn.close()\n'
            b'body = {"input":')
        self.install_binary("codex", "0.166.0", body)
        verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        for result in (verdict["result"], verdict["result"]["cu"]):
            self.assertTrue(result["memoryPipelineRan"])
            self.assertIn("memories_1.sqlite:audit:jobs", result["memoryPipelineEvidence"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_disabled_memory_probe_seeds_indexed_rollout(self) -> None:
        self.install_binary("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        verdict = self.run_canary("codex", "0.166.0")
        self.assertTrue(verdict["passed"], verdict)
        self.assertEqual(self.seed_mock.call_count, 4)

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

    def test_memory_snapshot_does_not_hash_rotating_sqlite_files(self) -> None:
        home = self.tmp / "rotating-sqlite"
        home.mkdir()
        for name in hc.CODEX_MEMORY_DATABASES:
            for suffix in ("", "-wal", "-shm"):
                (home / (name + suffix)).touch()
        with mock.patch.object(hc, "sha256_file", side_effect=FileNotFoundError("WAL rotated")):
            snapshot = hc.codex_memory_snapshot(home)
        self.assertEqual(len(snapshot), 6)
        self.assertEqual(set(snapshot.values()), {"sqlite-store"})

    def test_empty_codex_database_does_not_count_as_pipeline_work(self) -> None:
        body = self.fake_codex_binary("0.166.0")
        start = body.index(b'    (home / "memories" / "phase2-output").write_text')
        end = body.index(b'enabled = config.get', start)
        body = body[:start] + b'    (home / "memories_1.sqlite").touch()\n' + body[end:]
        self.install_binary("codex", "0.166.0", body)
        verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        self.assertFalse(verdict["result"]["positiveControlFired"])
        self.assertFalse(verdict["result"]["cu"]["positiveControlFired"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def test_initialized_codex_database_is_not_memory_pipeline_work(self) -> None:
        import sqlite3
        home = self.tmp / "codex-memory-init"
        home.mkdir()
        before = hc.codex_memory_snapshot(home)
        from contextlib import closing
        with closing(sqlite3.connect(home / "memories_1.sqlite")) as conn:
            conn.execute("CREATE TABLE stage1_outputs (raw_memory TEXT)")
            conn.execute("CREATE TABLE jobs (status TEXT)")
            conn.execute("CREATE TABLE consolidation_progress (singleton INTEGER)")
            conn.execute("INSERT INTO consolidation_progress VALUES (1)")
            conn.commit()
        after = hc.codex_memory_snapshot(home)
        self.assertEqual(hc.codex_memory_pipeline_evidence(home, before, after), [])
        with closing(sqlite3.connect(home / "memories_1.sqlite")) as conn:
            conn.execute("INSERT INTO stage1_outputs VALUES ('content')")
            conn.commit()
        after = hc.codex_memory_snapshot(home)
        self.assertIn("memories_1.sqlite:stage1_outputs", hc.codex_memory_pipeline_evidence(home, before, after))

    def test_memory_audit_accepts_only_empty_untouched_stores(self) -> None:
        import sqlite3
        home = self.tmp / "audited"
        home.mkdir()
        audit = hc.CodexMemoryAudit(home, "0.166.0")
        self.assertTrue(hc.valid_codex_memory_audit(audit.read(), version="0.166.0", clean=True))
        for name in hc.CODEX_MEMORY_DATABASES:
            with self.subTest(store=name):
                with closing(sqlite3.connect(home / name)) as conn:
                    conn.execute("INSERT INTO stage1_outputs (thread_id,source_updated_at,raw_memory,rollout_summary,generated_at) VALUES ('fixture',0,'content','',0)")
                    conn.execute("DELETE FROM stage1_outputs")
                    conn.commit()
                result = audit.read()
                self.assertFalse(hc.valid_codex_memory_audit(result, version="0.166.0", clean=True))
                self.assertEqual(result["stores"][name]["rowCounts"]["stage1_outputs"], 0)
                self.assertEqual(result["stores"][name]["activity"]["stage1_outputs"], 2)

    def test_memory_audit_fails_closed_on_tampering(self) -> None:
        import sqlite3
        for change in ("trigger", "identity", "migration", "replaced", "missing"):
            with self.subTest(change=change):
                home = self.tmp / f"tampered-{change}"
                home.mkdir()
                audit = hc.CodexMemoryAudit(home, "0.166.0")
                db = home / "memories_1.sqlite"
                if change in ("replaced", "missing"):
                    db.rename(db.with_suffix(".backup"))
                    if change == "replaced":
                        shutil.copy2(db.with_suffix(".backup"), db)
                else:
                    with closing(sqlite3.connect(db)) as conn:
                        conn.execute({"trigger": "DROP TRIGGER robob_canary_jobs_insert",
                                      "identity": "DELETE FROM robob_canary_identity",
                                      "migration": "UPDATE _sqlx_migrations SET checksum=x'00' WHERE version=1"}[change])
                        conn.commit()
                with self.assertRaises(hc.HarnessError):
                    audit.read()

    def test_memory_audit_rejects_unknown_cli_version(self) -> None:
        for version in ("0.167.0", "0.168.0", "0.165.0", "0.167.1-alpha.1", "v0.167.1", " 0.167.1", ""):
            with self.subTest(version=version):
                home = self.tmp / f"unknown-{len(version)}-{version.strip() or 'empty'}"
                home.mkdir()
                with self.assertRaisesRegex(hc.HarnessError, "^Codex memory audit schema has not been verified for this version$"):
                    hc.CodexMemoryAudit(home, version)
                self.assertEqual(list(home.iterdir()), [])
                self.assertFalse(hc.valid_codex_memory_audit(passing_audit(), version=version, clean=True))

    def test_memory_audit_accepts_each_verified_version_with_its_vendored_schema(self) -> None:
        self.assertIn("0.167.1", hc.CODEX_MEMORY_VERIFIED)
        vendor = Path(hc.__file__).resolve().parent / "vendor"
        for version, spec in hc.CODEX_MEMORY_VERIFIED.items():
            with self.subTest(version=version):
                self.assertEqual(sorted(p.name for p in (vendor / spec["vendor"]).glob("*.sql")),
                                 [name for name, _ in spec["migrations"]])
                for name, checksum in spec["migrations"]:
                    self.assertEqual(hashlib.sha384((vendor / spec["vendor"] / name).read_bytes()).hexdigest(), checksum)
                home = self.tmp / f"verified-{version}"
                home.mkdir()
                result = hc.CodexMemoryAudit(home, version).read()
                self.assertEqual(result["sourceCommit"], spec["sourceCommit"])
                self.assertEqual(set(result["stores"]), set(spec["databases"]))
                self.assertTrue(hc.valid_codex_memory_audit(result, version=version, clean=True))

    def test_memory_audit_source_commit_must_match_the_canaried_version(self) -> None:
        commits = {v: spec["sourceCommit"] for v, spec in hc.CODEX_MEMORY_VERIFIED.items()}
        self.assertEqual(len(set(commits.values())), len(commits))
        for version in commits:
            for other in commits:
                with self.subTest(audit=other, version=version):
                    self.assertEqual(hc.valid_codex_memory_audit(passing_audit(other), version=version, clean=True),
                                     other == version)
                    self.assertEqual(hc.valid_codex_canary_home(passing_codex_home(hc.MODEL_CANARIES["codex"], other),
                                                                hc.MODEL_CANARIES["codex"], version), other == version)
        audit = passing_audit("0.167.1")
        audit["sourceCommit"] = "0" * 40
        self.assertFalse(hc.valid_codex_memory_audit(audit, version="0.167.1", clean=True))

    def test_memory_audit_refuses_a_vendored_migration_with_a_wrong_checksum(self) -> None:
        vendor = Path(hc.__file__).resolve().parent / "vendor"
        for version, spec in hc.CODEX_MEMORY_VERIFIED.items():
            for index, (name, _) in enumerate(spec["migrations"]):
                with self.subTest(version=version, migration=name):
                    copy = self.tmp / f"vendor-{version}-{index}"
                    shutil.copytree(vendor / spec["vendor"], copy)
                    (copy / name).write_bytes((copy / name).read_bytes() + b"\n-- tampered\n")
                    home = self.tmp / f"bad-checksum-{version}-{index}"
                    home.mkdir()
                    tampered = {**spec, "vendor": str(copy)}
                    with mock.patch.dict(hc.CODEX_MEMORY_VERIFIED, {version: tampered}), \
                            self.assertRaisesRegex(hc.HarnessError, "checksum mismatch"):
                        hc.CodexMemoryAudit(home, version)
                    self.assertEqual(list(home.iterdir()), [])

    def test_positive_control_needs_audited_jobs_and_outputs(self) -> None:
        proof = passing_codex_home(hc.MODEL_CANARIES["codex"])
        for store in proof["positiveControlAudit"]["stores"].values():
            store["activity"] = {}
        self.assertFalse(hc.valid_codex_canary_home(proof, hc.MODEL_CANARIES["codex"], "0.166.0"))

    def test_jobs_or_consolidation_initialization_is_not_positive_extraction(self) -> None:
        import sqlite3
        from contextlib import closing
        home = self.tmp / "codex-no-extraction"
        home.mkdir()
        with closing(sqlite3.connect(home / "memories_1.sqlite")) as conn:
            conn.execute("CREATE TABLE stage1_outputs (thread_id TEXT, raw_memory TEXT, rollout_summary TEXT)")
            conn.execute("CREATE TABLE jobs (status TEXT)")
            conn.execute("INSERT INTO jobs VALUES ('pending')")
            conn.commit()
        self.assertEqual(hc.codex_memory_positive_evidence(home, "fixture"), [])

    def test_codex_memory_fixture_is_indexed_and_old_enough(self) -> None:
        import sqlite3
        from contextlib import closing
        home = self.tmp / "indexed"
        home.mkdir()
        with closing(sqlite3.connect(home / "state_5.sqlite")) as conn:
            conn.execute('''CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
                source TEXT, model_provider TEXT, cwd TEXT, title TEXT, sandbox_policy TEXT, approval_mode TEXT,
                preview TEXT, memory_mode TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at INTEGER,
                recency_at_ms INTEGER, first_user_message TEXT, cli_version TEXT)''')
            conn.commit()
        self.seed_patch.stop()
        fixture = hc.seed_codex_rollout(home, self.tmp, "0.166.0")
        with closing(sqlite3.connect(home / "state_5.sqlite")) as conn:
            row = conn.execute("SELECT rollout_path, source, preview, memory_mode, updated_at FROM threads WHERE id=?", (fixture,)).fetchone()
        self.assertTrue(Path(row[0]).is_file())
        self.assertEqual((row[1], row[3]), ("cli", "enabled"))
        self.assertTrue(row[2])
        self.assertGreaterEqual(__import__("time").time() - row[4], 7200)

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

    def test_escaped_claude_sentinel_blocks_promotion(self) -> None:
        body = self.fake_claude_binary("2.1.316", body_extra="ROBOB-MEMCANARY")
        body = body.replace(b'data=json.dumps(body).encode(),',
                            b'data=json.dumps(body).replace("ROBOB-MEMCANARY", "ROBOB-\\\\u004dEMCANARY").encode(),')
        self.install_binary("claude", "2.1.316", body)
        verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"], verdict)
        self.assertTrue(verdict["result"]["memoryCanaryLeaked"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("claude", "2.1.316")

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

    def test_recorder_blocks_other_methods_and_paths(self) -> None:
        import urllib.error
        import urllib.request
        recorder = hc.Recorder(f"http://127.0.0.1:{self.upstream.server_address[1]}", "k")
        base = recorder.start()
        self.addCleanup(recorder.stop)
        for method, path in (("POST", "/api/admin"), ("POST", "/v1/responses/../admin"),
                             ("POST", "/v1/messages?beta=true&other=1"), ("GET", "/v1/messages")):
            req = urllib.request.Request(base + path, data=b'{}' if method == 'POST' else None, method=method)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
        self.assertEqual(len(recorder.violations), 4)
        self.assertEqual(len(recorder.requests), 0)

    def test_recorder_records_unsupported_and_malformed_http(self) -> None:
        import socket
        import urllib.error
        import urllib.request
        recorder = hc.Recorder(hc.nine_router_url(), "dummy")
        base = recorder.start()
        with self.assertRaises(urllib.error.HTTPError) as trace:
            urllib.request.urlopen(urllib.request.Request(base + "/v1/responses", method="TRACE"))
        trace.exception.close()
        with self.assertRaises(urllib.error.HTTPError) as malformed:
            urllib.request.urlopen(urllib.request.Request(base + "/v1/messages", data=b'{"messages":null}'))
        malformed.exception.close()
        port = int(base.rsplit(":", 1)[1])
        with socket.create_connection(("127.0.0.1", port)) as client:
            client.sendall(b"BAD HTTP REQUEST EXTRA\r\n\r\n")
            client.recv(4096)
        recorder.stop()
        self.assertGreaterEqual(len(recorder.errors), 3)

    def test_handler_exception_is_recorded(self) -> None:
        import socket
        recorder = hc.Recorder(hc.nine_router_url(), "dummy")
        port = int(recorder.start().rsplit(":", 1)[1])
        with socket.create_connection(("127.0.0.1", port)) as client:
            client.sendall(b"POST /vv HTTP/1.1\r\nHost: localhost\r\n\r\n")
            client.recv(4096)
        with socket.create_connection(("127.0.0.1", port)) as client:
            client.sendall(b"POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999999999999999999999999999999999999\r\n\r\n")
            client.recv(4096)
        recorder.stop()
        self.assertIn("uncaught HTTP handler error", recorder.errors)

    def test_incomplete_canary_must_not_report_success(self) -> None:
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        result = passing_claude_result()
        result["requests"] = 2
        with mock.patch.object(hc, "canary_claude", return_value=result):
            verdict = hc.canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"], verdict)
        self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])

    def test_canary_preemptively_supersedes_previous_pass(self) -> None:
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        passing_canary("claude", "2.1.316")
        def interrupted(*args, **kwargs):
            self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])
            raise KeyboardInterrupt()
        with mock.patch.object(hc, "canary_claude", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                hc.canary("claude", "2.1.316")
        self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])

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

    def test_unexpected_exception_supersedes_claude_pass(self) -> None:
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        passing_canary("claude", "2.1.316")
        with mock.patch.object(hc, "canary_claude", side_effect=TypeError("bad shape")):
            verdict = hc.canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"])
        self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("claude", "2.1.316")

    def test_incomplete_claude_pass_cannot_promote(self) -> None:
        binary = self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        for field in ("memoryCanaryLeaked", "recorderViolations", "requests", "claude-haiku-5-5",
                      "thinkingSettingsChecked", "thinkingInconclusive", "thinkingAttempts"):
            with self.subTest(field=field):
                proof = passing_claude_result()
                del proof[field]
                hc.write_record("canary", "claude", "2.1.316", "passed", canary=proof,
                                binarySha256=hc.sha256_file(binary), canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)
                self.assertFalse(hc.latest_canary("claude", "2.1.316")["passed"])
                with self.assertRaises(hc.HarnessError):
                    hc.promote("claude", "2.1.316")

    def test_claude_verdict_includes_late_drained_memory_request(self) -> None:
        self.install_binary("claude", "2.1.316", self.fake_claude_binary("2.1.316"))
        original = hc.Recorder.stop
        def stop_with_late_leak(recorder):
            recorder.bodies.append(hc.CLAUDE_MEMORY_CANARY.encode())
            original(recorder)
        with mock.patch.object(hc.Recorder, "stop", stop_with_late_leak):
            verdict = self.run_canary("claude", "2.1.316")
        self.assertFalse(verdict["passed"], verdict)
        self.assertTrue(verdict["result"]["memoryCanaryLeaked"])

    def test_codex_exiting_before_hold_blocks_promotion(self) -> None:
        body = self.fake_codex_binary("0.166.0").replace(
            b'import json, os, sys, tomllib, urllib.request, sqlite3',
            b'import json, os, sys, tomllib, urllib.request, sqlite3, socket, time')
        body = body.replace(b'if enabled and (home / "fixture-id").exists():\n    pipeline',
            b'if not enabled and (home / "fixture-id").exists():\n'
            b'    payload = json.dumps(body).encode(); port = int(os.environ["NINEROUTER_BASE"].rsplit(":",1)[1]); s = socket.create_connection(("127.0.0.1",port))\n'
            b'    s.sendall(b"POST /v1/responses HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: " + str(len(payload)).encode() + b"\\r\\n\\r\\n" + payload)\n'
            b'    time.sleep(0.1); print("OK", flush=True); os._exit(0)\n'
            b'if enabled and (home / "fixture-id").exists():\n    pipeline')
        self.install_binary("codex", "0.166.0", body)
        passing_canary("codex", "0.166.0")
        with mock.patch.object(hc, "CODEX_OBSERVATION_SECONDS", 1.0):
            verdict = self.run_canary("codex", "0.166.0")
        self.assertFalse(verdict["passed"], verdict)
        self.assertIn("Codex exited before its memory observation window completed", verdict["reasons"])
        with self.assertRaises(hc.HarnessError):
            hc.promote("codex", "0.166.0")

    def run_canary(self, tool: str, version: str, fake_proxy_body=None) -> dict:
        """Run the real canary: the real generator (with the real manifest) builds the homes from
        copies of the live instruction sources, and only the CLI binaries are fake."""
        with mock.patch.dict(os.environ, {"HARNESS_CLI_SOURCE_HOME": str(self.tmp / "home"),
                                          "HARNESS_HOMES_PKG": str(self.homes_pkg)}):
            return hc.canary(tool, version)


def passing_canary(tool: str, version: str) -> dict:
    """Stands in for canary(): writes the same durable record the real canary writes, so promote()
    checks what it would check in production (a passing record with the memory-off result)."""
    body = (passing_claude_result() if tool == "claude"
            else passing_codex_result(version))
    binary = hc.version_dir(tool, version) / "bin" / tool
    companions = ensure_codex_companions(version) if tool == "codex" else {}
    hc.write_record("canary", tool, version, "passed", binarySha256=hc.sha256_file(binary), canary=body,
                    companions=companions, canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)
    return {"passed": True, "reasons": [], "result": body}


class CompanionVerificationTests(FakeCliTestCase):
    """promote, rollback and canary check every recorded companion next to the binary hash."""

    def install_codex(self, version: str) -> Path:
        bin_dir = self.root / "codex" / version / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text(f"#!/bin/sh\necho {version}\n", encoding="utf-8")
        (bin_dir / "codex").chmod(0o555)
        ensure_codex_companions(version)
        return self.root / "codex" / version

    def tamper(self, path: Path, data: bytes | None) -> None:
        os.chmod(path.parent, stat.S_IRWXU)
        if data is None:
            path.unlink()
        else:
            os.chmod(path, stat.S_IRWXU)
            path.write_bytes(data)

    def test_promote_refuses_changed_or_missing_companion(self) -> None:
        for companion, data in (("bin/codex-code-mode-host", b"changed"), ("bin/codex-code-mode-host", None),
                                ("codex-path/rg", b"changed"), ("codex-path/rg", None)):
            with self.subTest(companion=companion, missing=data is None):
                hc.remove_tree(self.root)
                target = self.install_codex("0.166.0")
                passing_canary("codex", "0.166.0")
                self.tamper(target / companion, data)
                with self.assertRaises(hc.HarnessError) as ctx:
                    hc.promote("codex", "0.166.0")
                self.assertIn(companion if data is not None else "missing", str(ctx.exception))
                self.assertFalse((self.root / "codex" / "current").is_symlink())

    def test_promote_refuses_a_canary_that_predates_the_companions(self) -> None:
        self.install_codex("0.166.0")
        # The 0.166.0 situation: a passing canary recorded before companions existed.
        hc.write_record("canary", "codex", "0.166.0", "passed",
                        binarySha256=hc.sha256_file(self.root / "codex" / "0.166.0" / "bin" / "codex"),
                        canary=passing_codex_result(), canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.promote("codex", "0.166.0")
        self.assertIn("companions differ from the canary record", str(ctx.exception))

    def test_promote_refuses_when_no_companions_were_recorded(self) -> None:
        bin_dir = self.root / "codex" / "0.166.0" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text("#!/bin/sh\n", encoding="utf-8")
        hc.write_record("canary", "codex", "0.166.0", "passed",
                        binarySha256=hc.sha256_file(bin_dir / "codex"), companions={},
                        canary=passing_codex_result(), canarySchemaVersion=hc.CANARY_SCHEMA_VERSION)
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.promote("codex", "0.166.0")
        self.assertIn("no companion hashes recorded", str(ctx.exception))

    def test_promote_records_verified_companions(self) -> None:
        self.install_codex("0.166.0")
        passing_canary("codex", "0.166.0")
        hc.promote("codex", "0.166.0")
        promote_record = [r for r in hc.tool_records("codex", "0.166.0") if r["action"] == "promote"][-1]
        self.assertEqual(promote_record["companions"], hc.verify_companions("codex", "0.166.0"))

    def test_rollback_refuses_a_last_known_good_with_a_changed_companion(self) -> None:
        old = self.install_codex("0.166.0")
        self.install_codex("0.167.1")
        passing_canary("codex", "0.166.0")
        passing_canary("codex", "0.167.1")
        hc.promote("codex", "0.166.0")
        hc.promote("codex", "0.167.1")
        self.tamper(old / "bin" / "codex-code-mode-host", b"changed")
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.rollback("codex")
        self.assertIn("codex-code-mode-host", str(ctx.exception))
        self.assertEqual(hc.current_version_from_link("codex"), "0.167.1")

    def test_rollback_refuses_a_last_known_good_with_a_changed_binary(self) -> None:
        old = self.install_codex("0.166.0")
        self.install_codex("0.167.1")
        passing_canary("codex", "0.166.0")
        passing_canary("codex", "0.167.1")
        hc.promote("codex", "0.166.0")
        hc.promote("codex", "0.167.1")
        self.tamper(old / "bin" / "codex", b"#!/bin/sh\necho swapped\n")
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.rollback("codex")
        self.assertIn("binary differs", str(ctx.exception))
        self.assertEqual(hc.current_version_from_link("codex"), "0.167.1")

    def test_rollback_with_intact_companions_still_works(self) -> None:
        self.install_codex("0.166.0")
        self.install_codex("0.167.1")
        passing_canary("codex", "0.166.0")
        passing_canary("codex", "0.167.1")
        hc.promote("codex", "0.166.0")
        hc.promote("codex", "0.167.1")
        hc.rollback("codex")
        self.assertEqual(hc.current_version_from_link("codex"), "0.166.0")

    def test_canary_fails_closed_on_a_changed_companion_without_running_the_cli(self) -> None:
        target = self.install_codex("0.166.0")
        passing_canary("codex", "0.166.0")
        self.tamper(target / "codex-path" / "rg", b"changed")
        with mock.patch.object(hc, "canary_codex") as run:
            verdict = hc.canary("codex", "0.166.0")
        run.assert_not_called()
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("codex-path/rg" in r for r in verdict["reasons"]), verdict)
        self.assertFalse(hc.latest_canary("codex", "0.166.0")["passed"])

    def test_canary_records_companions_and_catches_a_change_during_the_run(self) -> None:
        target = self.install_codex("0.166.0")
        fake = {**passing_codex_home(hc.MODEL_CANARIES["codex"])}
        cu = passing_codex_home(hc.CODEX_CU_MODELS)
        homes = mock.patch.multiple(hc, make_throwaway_homes=mock.Mock(return_value=(None, self.tmp)),
                                    make_codex_cu_home=mock.Mock(return_value=self.tmp))
        (self.tmp / "config.toml").write_text('model = "gpt-6.1-terra"\n[features]\ncomputer_use = true\n')
        (self.tmp / "models.json").write_text("{}")
        (self.tmp / "AGENTS.md").write_text("")
        with homes, mock.patch.object(hc, "binary_version", return_value="0.166.0"), \
                mock.patch.object(hc, "canary_codex", side_effect=[fake, cu]):
            verdict = hc.canary("codex", "0.166.0")
        self.assertTrue(verdict["passed"], verdict)
        record = [r for r in hc.tool_records("codex", "0.166.0") if r["action"] == "canary"][-1]
        self.assertEqual(record["companions"], hc.verify_companions("codex", "0.166.0"))

        calls = []

        def swap_during_run(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                self.tamper(target / "bin" / "codex-code-mode-host", b"swapped mid-run")
                return fake
            return cu
        with homes, mock.patch.object(hc, "binary_version", return_value="0.166.0"), \
                mock.patch.object(hc, "canary_codex", side_effect=swap_during_run):
            verdict = hc.canary("codex", "0.166.0")
        self.assertEqual(len(calls), 2)
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("codex-code-mode-host" in r or "changed during" in r for r in verdict["reasons"]), verdict)
        self.assertFalse(hc.latest_canary("codex", "0.166.0")["passed"])


class RepairCompanionsTests(FakeCliTestCase):
    """Trees staged by the old flat layout (bin/rg) get rg moved to codex-path/rg."""

    def legacy_tree(self, version: str = "0.166.0") -> Path:
        target = self.root / "codex" / version
        bin_dir = target / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text("#!/bin/sh\necho codex\n", encoding="utf-8")
        hashes = {}
        for name in ("codex-code-mode-host", "rg"):
            (bin_dir / name).write_bytes(COMPANION_BYTES[name])
            hashes[name] = hc.sha256_file(bin_dir / name)
        digest = hc.sha256_file(bin_dir / "codex")
        # The real history: a stage record without companions, then a hand-written companions-added one.
        hc.write_record("stage", "codex", version, "staged", binarySha256=digest)
        hc.write_record("stage", "codex", version, "companions-added", binarySha256=digest, companions=hashes)
        for path in bin_dir.iterdir():
            path.chmod(0o555)
        bin_dir.chmod(0o555)
        target.chmod(0o555)
        return target

    def test_repair_moves_rg_to_codex_path_and_records_it(self) -> None:
        target = self.legacy_tree()
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.verify_companions("codex", "0.166.0")
        self.assertIn("repair-companions", str(ctx.exception))
        out = hc.repair_companions("codex", "0.166.0")
        self.assertEqual(out["status"], "repaired")
        self.assertEqual(out["moved"], ["codex-path/rg"])
        self.assertTrue((target / "codex-path" / "rg").is_file())
        self.assertFalse((target / "bin" / "rg").exists())
        self.assertEqual((target / "codex-path" / "rg").read_bytes(), COMPANION_BYTES["rg"])
        for rel in ("bin/codex", "bin/codex-code-mode-host", "codex-path/rg"):
            mode = os.stat(target / rel).st_mode
            self.assertTrue(mode & stat.S_IXUSR and not mode & stat.S_IWUSR, rel)
        for rel in (".", "bin", "codex-path"):
            self.assertFalse(os.stat(target / rel).st_mode & stat.S_IWUSR, rel)
        record = hc.tool_records("codex", "0.166.0")[-1]
        self.assertEqual(record["action"], "repair-companions")
        self.assertEqual(record["companions"]["rg"], hc.sha256_file(target / "codex-path" / "rg"))
        self.assertEqual(hc.verify_companions("codex", "0.166.0"), record["companions"])

    def test_repair_is_idempotent(self) -> None:
        self.legacy_tree()
        hc.repair_companions("codex", "0.166.0")
        count = len(hc.tool_records("codex", "0.166.0"))
        out = hc.repair_companions("codex", "0.166.0")
        self.assertEqual(out["status"], "already-ok")
        self.assertEqual(len(hc.tool_records("codex", "0.166.0")), count)

    def test_repair_refuses_when_binary_differs_from_its_record(self) -> None:
        target = self.legacy_tree()
        os.chmod(target / "bin", stat.S_IRWXU)
        os.chmod(target / "bin" / "codex", stat.S_IRWXU)
        (target / "bin" / "codex").write_text("#!/bin/sh\necho swapped\n", encoding="utf-8")
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.repair_companions("codex", "0.166.0")
        self.assertIn("binary differs", str(ctx.exception))
        self.assertTrue((target / "bin" / "rg").is_file())
        self.assertFalse((target / "codex-path").exists())

    def test_repair_refuses_when_legacy_rg_differs_from_its_record(self) -> None:
        target = self.legacy_tree()
        os.chmod(target / "bin", stat.S_IRWXU)
        os.chmod(target / "bin" / "rg", stat.S_IRWXU)
        (target / "bin" / "rg").write_bytes(b"not the recorded rg")
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.repair_companions("codex", "0.166.0")
        self.assertIn("bin/rg differs", str(ctx.exception))
        self.assertFalse((target / "codex-path").exists())

    def test_repair_refuses_without_recorded_companions(self) -> None:
        bin_dir = self.root / "codex" / "0.166.0" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text("#!/bin/sh\n", encoding="utf-8")
        hc.write_record("stage", "codex", "0.166.0", "staged", binarySha256=hc.sha256_file(bin_dir / "codex"))
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.repair_companions("codex", "0.166.0")
        self.assertIn("no companion hashes recorded", str(ctx.exception))

    def test_repaired_tree_promotes_after_a_fresh_canary(self) -> None:
        self.legacy_tree()
        hc.repair_companions("codex", "0.166.0")
        passing_canary("codex", "0.166.0")
        self.assertEqual(hc.promote("codex", "0.166.0")["status"], "promoted, rotation pending")

    def test_repair_cli_takes_the_lock_and_prints_json(self) -> None:
        self.legacy_tree()
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(hc.main(["repair-companions", "codex", "0.166.0"]), 0)
        self.assertEqual(json.loads(out.getvalue())["status"], "repaired")
        self.assertTrue((self.root / "lock").exists())


class RepoHygieneTests(unittest.TestCase):
    def test_bytecode_is_ignored_and_not_tracked(self) -> None:
        ignore = (PKG / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("__pycache__/", ignore)
        tracked = subprocess.run(["git", "ls-files", "--", "."], cwd=PKG, capture_output=True, text=True)
        if tracked.returncode == 0:
            self.assertFalse([p for p in tracked.stdout.splitlines() if p.endswith(".pyc")])


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


    def failing_canary(self, tool, version, **_):
        return {"passed": False, "reasons": ["model rejected"]}

    def backdate_candidates(self, hours: int) -> None:
        state = hc.load_state()
        since = (hc.dt.datetime.now(hc.dt.timezone.utc) - hc.dt.timedelta(hours=hours)).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
        for tool in hc.TOOLS:
            state[tool]["candidateSince"] = since
        hc.save_state(state)

    def notice_keys(self) -> list[str]:
        if not self.notify_log.exists():
            return []
        return [line.split("--key ")[-1] for line in self.notify_log.read_text(encoding="utf-8").splitlines()
                if line.strip()]

    def test_candidate_unpromoted_for_a_day_alerts_once(self) -> None:
        self.publish_both("2.1.316", "0.166.0")
        hc.discover()
        self.backdate_candidates(25)
        with mock.patch.object(hc, "canary", side_effect=self.failing_canary), \
             mock.patch.object(hc, "harness_home_hashes", return_value={}):
            hc.auto()
            hc.auto()
        keys = self.notice_keys()
        self.assertEqual(keys.count("harness-cli:codex:0.166.0:stale"), 1, keys)
        self.assertEqual(keys.count("harness-cli:claude:2.1.316:stale"), 1, keys)
        line = next(l for l in self.notify_log.read_text(encoding="utf-8").splitlines()
                    if "codex:0.166.0:stale" in l)
        self.assertIn("--severity attention", line)
        self.assertIn("model rejected", line)

    def test_fresh_candidate_does_not_alert_stale(self) -> None:
        self.publish_both("2.1.316", "0.166.0")
        with mock.patch.object(hc, "canary", side_effect=self.failing_canary), \
             mock.patch.object(hc, "harness_home_hashes", return_value={}):
            hc.auto()
        self.assertFalse([k for k in self.notice_keys() if k.endswith(":stale")])
        self.assertIsNotNone(hc.load_state()["codex"]["candidateSince"])

    def test_newer_release_keeps_first_seen_time(self) -> None:
        self.publish_both("2.1.316", "0.166.0")
        hc.discover()
        self.backdate_candidates(30)
        since = hc.load_state()["codex"]["candidateSince"]
        self.publish_both("2.1.316", "0.167.0")
        hc.discover()
        state = hc.load_state()
        self.assertEqual(state["codex"]["candidate"], "0.167.0")
        self.assertEqual(state["codex"]["candidateSince"], since)

    def test_promotion_resets_the_stale_clock(self) -> None:
        self.publish_both("2.1.316", "0.166.0")
        hc.discover()
        self.backdate_candidates(30)
        with mock.patch.object(hc, "canary", side_effect=passing_canary), \
             mock.patch.object(hc, "harness_home_hashes", return_value={}):
            hc.auto()
        state = hc.load_state()
        self.assertIsNone(state["codex"]["candidateSince"])
        self.assertFalse([k for k in self.notice_keys() if k.endswith(":stale")])
        self.publish_both("2.1.317", "0.167.0")
        hc.discover()
        since = hc.load_state()["codex"]["candidateSince"]
        age = hc.dt.datetime.now(hc.dt.timezone.utc) - hc.dt.datetime.strptime(
            since, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=hc.dt.timezone.utc)
        self.assertLess(age, hc.dt.timedelta(minutes=5))



@unittest.skipUnless(sys.platform == "darwin" and Path("/opt/homebrew/bin/python3").exists()
                     and shutil.which("rsync"), "install.zsh targets this Mac")
class InstallScriptTests(unittest.TestCase):
    """install.zsh in a throwaway HOME with a fake launchctl: the daily agent is part of every deploy."""

    LABEL = "com.ardud.harness-cli"

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-cli-install-"))
        self.pkg = self.tmp / "pkg"
        self.pkg.mkdir()
        for name in ("harness_cli.py", "model-manifest.json", "install.zsh"):
            shutil.copy2(PKG / name, self.pkg / name)
        for name in ("launchd", "vendor"):
            if (PKG / name).is_dir():
                shutil.copytree(PKG / name, self.pkg / name, ignore=shutil.ignore_patterns("__pycache__"))
        (self.pkg / "tests").mkdir()
        # The installer refuses a package whose own tests fail; this stands in for the real suite.
        (self.pkg / "tests" / "test_ok.py").write_text(
            "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): pass\n", encoding="utf-8")
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.log = self.tmp / "launchctl.log"
        self.mark = self.tmp / "loaded"
        fake = self.tmp / "launchctl"
        fake.write_text(
            "#!/bin/sh\n"
            f'echo "$*" >> "{self.log}"\n'
            'case "$1" in\n'
            f'  print) [ -f "{self.mark}" ] ;;\n'
            f'  bootstrap) touch "{self.mark}" ;;\n'
            f'  bootout) rm -f "{self.mark}" ;;\n'
            "esac\n", encoding="utf-8")
        fake.chmod(0o755)
        self.plist = self.home / "Library" / "LaunchAgents" / f"{self.LABEL}.plist"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_install(self, *args: str) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
               "HARNESS_CLI_LAUNCHCTL": str(self.tmp / "launchctl")}
        return subprocess.run(["/bin/zsh", "-f", str(self.pkg / "install.zsh"), *args], env=env,
                              capture_output=True, text=True, timeout=120)

    def calls(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def test_default_install_loads_the_daily_agent(self) -> None:
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.plist.read_bytes(), (PKG / "launchd" / f"{self.LABEL}.plist").read_bytes())
        self.assertTrue(any(c.startswith("bootstrap gui/") and c.endswith(str(self.plist)) for c in self.calls()),
                        self.calls())
        check = self.run_install("--check")
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_reinstall_leaves_a_current_loaded_agent_alone(self) -> None:
        self.assertEqual(self.run_install().returncode, 0)
        self.log.unlink()
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse([c for c in self.calls() if c.split()[0] in ("bootout", "bootstrap")], self.calls())

    def test_changed_plist_is_reloaded(self) -> None:
        self.assertEqual(self.run_install().returncode, 0)
        self.plist.write_text("stale", encoding="utf-8")
        self.assertEqual(self.run_install("--check").returncode, 1)
        self.log.unlink()
        self.assertEqual(self.run_install().returncode, 0)
        self.assertEqual([c.split()[0] for c in self.calls() if c.split()[0] != "print"],
                         ["bootout", "bootstrap"])
        self.assertEqual(self.run_install("--check").returncode, 0)

    def test_check_reports_missing_agent(self) -> None:
        self.assertEqual(self.run_install("--no-agent").returncode, 0)
        self.assertFalse(self.plist.exists())
        check = self.run_install("--check")
        self.assertEqual(check.returncode, 1)
        self.assertIn("agent missing", check.stderr)
        self.assertIn("not loaded", check.stderr)

    def test_check_reports_unloaded_agent(self) -> None:
        self.assertEqual(self.run_install().returncode, 0)
        self.mark.unlink()
        check = self.run_install("--check")
        self.assertEqual(check.returncode, 1)
        self.assertIn("not loaded", check.stderr)
        self.assertNotIn("agent missing", check.stderr)

    def test_with_agent_flag_still_accepted(self) -> None:
        result = self.run_install("--with-agent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.mark.exists())


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
        ensure_codex_companions(version)

    def pend(self, version: str = "0.166.0") -> None:
        self.install_codex(version)
        hc.write_record("canary", "codex", version, "passed",
                        binarySha256=hc.sha256_file(self.root / "codex" / version / "bin" / "codex"),
                        canarySchemaVersion=hc.CANARY_SCHEMA_VERSION,
                        companions=ensure_codex_companions(version),
                        canary=passing_codex_result(version))
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

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS sandbox")
    def test_cli_fences_second_loopback_subprocess_and_outside_writes(self) -> None:
        self.run_patch.stop()
        import http.server
        import threading
        class Sink(http.server.BaseHTTPRequestHandler):
            hits = 0
            def log_message(self, *args): pass
            def do_POST(self):
                type(self).hits += 1
                self.send_response(200)
                self.send_header("content-length", "0")
                self.end_headers()
        allowed = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)
        other = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)
        self.addCleanup(allowed.server_close)
        self.addCleanup(other.server_close)
        self.addCleanup(allowed.shutdown)
        self.addCleanup(other.shutdown)
        for server in (allowed, other):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        work = self.tmp / "sandbox"
        home = work / "home"
        hc.prepare_isolated_home(home)
        outside = self.tmp / "outside"
        code = '''import os,sys,urllib.request,subprocess,socket,signal
def post(url):
 try: urllib.request.urlopen(urllib.request.Request(url,data=b'x'),timeout=3).read(); return 'allowed'
 except Exception: return 'denied'
print('recorder',post(sys.argv[1]))
print('bypass',post(sys.argv[2]))
try: open(sys.argv[3],'w').write('bad'); print('write allowed')
except OSError: print('write denied')
try: subprocess.run(['/bin/echo','bad'],check=True); print('exec allowed')
except (OSError,subprocess.SubprocessError): print('exec denied')
try: socket.socket(socket.AF_UNIX).connect(sys.argv[4]); print('unix allowed')
except OSError: print('unix denied')
try: open(sys.argv[5]).read(); print('read allowed')
except OSError: print('read denied')
try: os.kill(int(sys.argv[6]),signal.SIGCONT); print('signal allowed')
except OSError: print('signal denied')
'''
        base = f"http://127.0.0.1:{allowed.server_port}"
        env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "ANTHROPIC_BASE_URL": base}
        py = Path(sys.executable).resolve().parent.parent / "Resources/Python.app/Contents/MacOS/Python"
        python_root = Path(sys.executable).resolve().parent.parent
        sockpath = str(self.tmp / 'local-sock')
        listener = __import__('socket').socket(__import__('socket').AF_UNIX)
        listener.bind(sockpath); listener.listen()
        self.addCleanup(listener.close)
        protected = self.tmp / "personal-secret"
        protected.write_text("not accessible")
        with mock.patch.object(hc, "SANDBOX_SYSTEM_READ_ROOTS", hc.SANDBOX_SYSTEM_READ_ROOTS + (str(python_root),)):
            result = hc.run_cli(py, ["-c", code, base, f"http://127.0.0.1:{other.server_port}", str(outside), sockpath,
                                     str(protected), str(os.getpid())],
                                env=env, cwd=work, sandbox_root=work, recorder_url=base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recorder allowed", result.stdout)
        self.assertIn("bypass denied", result.stdout)
        self.assertIn("write denied", result.stdout)
        self.assertIn("exec denied", result.stdout)
        self.assertIn("unix denied", result.stdout)
        self.assertIn("read denied", result.stdout)
        self.assertIn("signal denied", result.stdout)
        self.assertEqual(Sink.hits, 1)
        self.assertFalse(outside.exists())

    def test_cli_rejects_missing_or_untrusted_recorder(self) -> None:
        self.run_patch.stop()
        work = self.tmp / "isolated"
        home = work / "home"
        hc.prepare_isolated_home(home)
        env = {"HOME": str(home), "PATH": "/usr/bin:/bin"}
        for url in ("http://127.0.0.1:22/other", "http://localhost:22", "http://example.com:22", "http://127.0.0.1:22@evil.com"):
            with self.subTest(url=url), self.assertRaises(hc.HarnessError):
                hc.run_cli(Path("/bin/echo"), [], env=env, cwd=work, sandbox_root=work, recorder_url=url)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS sandbox")
    def test_version_probe_is_offline(self) -> None:
        self.run_patch.stop()
        home = self.tmp / "version" / "home"
        hc.prepare_isolated_home(home)
        work = home.parent
        py = Path(sys.executable).resolve().parent.parent / "Resources/Python.app/Contents/MacOS/Python"
        python_root = Path(sys.executable).resolve().parent.parent
        code = "import socket; s=socket.socket(); print(s.connect_ex(('127.0.0.1',20128)))"
        with mock.patch.object(hc, "SANDBOX_SYSTEM_READ_ROOTS", hc.SANDBOX_SYSTEM_READ_ROOTS + (str(python_root),)):
            proc = hc.run_cli(py, ["-c", code], env={"HOME": str(home)}, cwd=work, sandbox_root=work)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "1")

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
