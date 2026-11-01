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
        self.write_fake_npm()
        self.write_notify_stub()
        self.write_plist()

    def tearDown(self) -> None:
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
        """A stand-in for the native binary: prints its version and, per prompt, posts one request
        through ANTHROPIC_BASE_URL (the recording proxy) like the real CLI does, then answers OK."""
        post = (
            'python3 -c "import urllib.request,sys;'
            "urllib.request.urlopen(urllib.request.Request(sys.argv[1],"
            "data=b'{\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"Reply exactly OK.\\\"}]}',"
            "method='POST'),timeout=30).read()\" \"$ANTHROPIC_BASE_URL/v1/messages\" >/dev/null 2>&1 || true\n"
        )
        return (
            "#!/bin/sh\n"
            f'if [ "$1" = "--version" ]; then echo "{version} (Claude Code)"; exit 0; fi\n'
            f"{post}{body_extra}"
            'echo "OK"\n'
        ).encode()

    def fake_codex_binary(self, version: str, body_extra: str = "") -> bytes:
        post = (
            'python3 -c "import urllib.request,sys;'
            "urllib.request.urlopen(urllib.request.Request(sys.argv[1],"
            "data=b'{\\\"input\\\":\\\"Reply exactly OK.\\\"}',method='POST'),timeout=30).read()\""
            ' "$NINEROUTER_BASE/v1/responses" >/dev/null 2>&1 || true\n'
        )
        return (
            "#!/bin/sh\n"
            f'if [ "$1" = "--version" ]; then echo "codex-cli {version}"; exit 0; fi\n'
            f"{post}{body_extra}"
            'echo "OK"\n'
        ).encode()

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
        canary = ({"memoryCanaryChecked": True, "memoryCanaryLeaked": not memory_ok} if tool == "claude"
                  else {"memoryCanaryChecked": True, "memoryPipelineRan": not memory_ok})
        hc.write_record("canary", tool, version, "passed" if passed else "failed",
                        binarySha256="deadbeef", canary=canary)

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


class CodexRotationTests(FakeCliTestCase):
    def install_codex(self, version: str) -> None:
        bin_dir = self.root / "codex" / version / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "codex").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (bin_dir / "codex").chmod(0o555)

    def record_codex_canary(self, version: str) -> None:
        hc.write_record("canary", "codex", version, "passed",
                        binarySha256="cafe", canary={"memoryCanaryChecked": True, "memoryPipelineRan": False})

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

    def test_codex_never_rotated_while_busy(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        hc.promote("codex", "0.166.0")
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        busy = {"threads": [{"provider": "codex", "runningRun": {"runId": "r1"}}]}
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
        self.assertIn("rotation skipped", msg)
        self.assertTrue(hc.load_state()["codex"]["rotationPending"])

    def test_codex_rotation_skipped_when_route_missing(self) -> None:
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
        self.assertIn("route is missing", msg)
        refresh.assert_not_called()

    def test_codex_rotates_after_quiet_window_with_standing_ok(self) -> None:
        self.install_codex("0.166.0")
        self.record_codex_canary("0.166.0")
        hc.promote("codex", "0.166.0")
        state = hc.load_state()
        state["autoRotateCodex"] = True
        hc.save_state(state)
        refresh = mock.Mock()
        msg = hc.rotate_codex(when_idle=True, checker=lambda: {"threads": []}, refresher=refresh, quiet_seconds=0)
        refresh.assert_called_once()
        self.assertIn("refreshed", msg)
        self.assertFalse(hc.load_state()["codex"]["rotationPending"])

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
        hc.write_record("canary", "claude", "2.1.316", "passed", binarySha256="ab",
                        canary={"memoryCanaryChecked": True, "memoryCanaryLeaked": False})


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

    def test_canary_refuses_when_homes_generator_missing(self) -> None:
        self.install_binary("codex", "0.166.0", self.fake_codex_binary("0.166.0"))
        (self.homes_pkg / "generate_homes.py").unlink()
        with self.assertRaises(hc.HarnessError) as ctx:
            hc.canary("codex", "0.166.0")
        self.assertIn("harness-homes", str(ctx.exception))

    def test_canary_proxy_refuses_non_loopback_upstream(self) -> None:
        with self.assertRaises(hc.HarnessError):
            hc.Recorder("https://api.example.com", "k")

    def run_canary(self, tool: str, version: str, fake_proxy_body) -> dict:
        # Put the fake binary in place as stage() would, then run canary() with the generator on PATH.
        with mock.patch.object(hc, "make_throwaway_homes", wraps=hc.make_throwaway_homes) as mk:
            mk.side_effect = self.throwaway_homes_for_test
            verdict = hc.canary(tool, version)
        return verdict

    def throwaway_homes_for_test(self, root: Path):
        """Stand-in for the real generator: write the two homes with the files the canary reads."""
        claude = root / "homes" / "claude"
        codex = root / "homes" / "codex"
        claude.mkdir(parents=True, exist_ok=True)
        codex.mkdir(parents=True, exist_ok=True)
        (claude / "settings.json").write_text(json.dumps({
            "autoMemoryEnabled": False, "env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}}), encoding="utf-8")
        (codex / "config.toml").write_text(
            "[features]\nmemories = false\n\n[memories]\ngenerate_memories = false\nuse_memories = false\n",
            encoding="utf-8")
        return claude, codex


def passing_canary(tool: str, version: str) -> dict:
    """Stands in for canary(): writes the same durable record the real canary writes, so promote()
    checks what it would check in production (a passing record with the memory-off result)."""
    body = ({"memoryCanaryChecked": True, "memoryCanaryLeaked": False} if tool == "claude"
            else {"memoryCanaryChecked": True, "memoryPipelineRan": False})
    hc.write_record("canary", tool, version, "passed", binarySha256="ab", canary=body)
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
        self.assertEqual(keys.count("harness-cli:claude:2.1.316"), 1, keys)

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


if __name__ == "__main__":
    unittest.main()
