"""Guest SSH can disappear without taking the home management route with it."""
import contextlib
import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import subprocess
import shlex
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import api, bases, common, lease, pool, prepare, prune, runs, ssh_sync
from test_capacity import Isolated

_spec = importlib.util.spec_from_file_location("management_ssh_server_fixtures", SCRIPTS.parents[1] / "tests/test_boatd.py")
server_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server_tests)
boatd = server_tests.boatd
ASSETS = SCRIPTS.parent / "templates/home"


def result(rc=0, stderr=b""):
    return subprocess.CompletedProcess([], rc, b"", stderr)


class HomeClient(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, value in (("SSH_DIR", root), ("CM_DIR", root / "cm"), ("KEY_PATH", root / "key"),
                            ("_HOME_PORTS", {})):
            self.stack.enter_context(patch.object(ssh_sync, name, value))
        self.stack.enter_context(patch.object(ssh_sync, "ensure_dirs"))
        self.stack.enter_context(patch.object(ssh_sync, "log"))
        self.stack.enter_context(patch.object(ssh_sync, "pubkey", return_value="ssh-ed25519 public"))
        self.stack.enter_context(patch.object(api, "left", return_value=None))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.endpoint = {"sshEndpoint": "home:22000", "managementSshEndpoint": "home:22001",
                         "hostKey": "ssh-ed25519 pinned", "sshUser": "user"}
        self.key = self.stack.enter_context(patch.object(api, "sshkey", return_value=self.endpoint))
        self.run = self.stack.enter_context(patch.object(ssh_sync.subprocess, "run", return_value=result()))

    def setup_box(self):
        return ssh_sync.setup("bx_fixture")

    def test_management_is_tried_first_and_all_consumers_share_the_cached_port(self):
        self.setup_box()
        self.assertEqual(ssh_sync.ssh_base("bx_fixture")[-2:], ["-p", "22001"])
        self.assertIn("ConnectTimeout=3", self.run.call_args.args[0])
        self.assertIn("ControlPath=none", self.run.call_args.args[0])
        self.assertEqual(self.run.call_count, 1)
        ssh_sync.ssh("bx_fixture", "echo still-here")
        self.assertEqual(self.run.call_count, 2)
        self.assertEqual(self.run.call_args.args[0][-4:], ["-p", "22001", "bx_fixture", "echo still-here"])
        self.setup_box()  # repeated readiness/setup in the same run must not probe again
        self.assertEqual(ssh_sync.ssh_base("bx_fixture")[-2:], ["-p", "22001"])
        self.assertEqual(self.run.call_count, 2)

    def test_old_image_falls_back_once_without_replaying_the_actual_command(self):
        self.setup_box()
        self.run.side_effect = [result(255, b"Connection refused"), result(), result()]
        ssh_sync.ssh("bx_fixture", "do-work")
        commands = [c.args[0] for c in self.run.call_args_list]
        self.assertEqual([c[c.index("-p") + 1] for c in commands], ["22001", "22000", "22000"])
        self.assertEqual([c[-1] for c in commands], ["true", "true", "do-work"])
        self.assertEqual(ssh_sync.ssh_base("bx_fixture")[-2:], ["-p", "22000"])
        self.assertEqual(self.run.call_count, 3)

    def test_short_management_connect_timeout_can_fall_back(self):
        self.setup_box()
        self.run.side_effect = [subprocess.TimeoutExpired("ssh", 5), result()]
        self.assertEqual(ssh_sync.ssh_base("bx_fixture")[-2:], ["-p", "22000"])
        self.assertEqual([c.kwargs["timeout"] for c in self.run.call_args_list], [5, 5])

    def test_host_key_error_never_repins_or_attempts_a_guest_command(self):
        for error in (b"Host key verification failed.", b"WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
                      b"Offending ED25519 key", b"host key has changed"):
            for legacy in (False, True):
                with self.subTest(error=error, legacy=legacy):
                    self.setup_box()
                    self.run.reset_mock()
                    self.run.side_effect = ([result(255, b"Connection refused")] if legacy else []) + [result(255, error)]
                    before = (ssh_sync.SSH_DIR / "known_hosts_bx_fixture").read_bytes()
                    with self.assertRaisesRegex(common.OffboxError, "host key mismatch.*offbox exec"):
                        ssh_sync.ssh("bx_fixture", "never-execute")
                    self.assertEqual(self.run.call_count, 2 if legacy else 1)
                    self.assertTrue(all(c.args[0][-1] == "true" for c in self.run.call_args_list))
                    self.assertEqual((ssh_sync.SSH_DIR / "known_hosts_bx_fixture").read_bytes(), before)
                    self.assertNotIn("bx_fixture", ssh_sync._HOME_PORTS)

    def test_unreachable_both_ports_is_not_cached(self):
        self.setup_box()
        self.run.return_value = result(255, b"Connection refused")
        with self.assertRaisesRegex(common.OffboxError, "management and legacy endpoints"):
            ssh_sync.ssh_base("bx_fixture")
        self.assertEqual(self.run.call_count, 2)
        self.assertFalse(ssh_sync._HOME_PORTS)

    def test_cached_connection_host_key_change_stops_ssh_and_rsync_without_refresh(self):
        self.setup_box()
        ssh_sync.ssh_base("bx_fixture")
        self.run.return_value = result(255, b"Host key verification failed.")
        with self.assertRaisesRegex(common.OffboxError, "host key mismatch"):
            ssh_sync.ssh("bx_fixture", "echo hello")
        for rc in (12, 23, 255):
            with self.subTest(rc=rc), patch.object(ssh_sync, "_progress_args", return_value=()), \
                    patch.object(ssh_sync, "_watch_rsync", return_value=subprocess.CompletedProcess([], rc, "", "Host key verification failed.")) as watch, \
                    patch.object(ssh_sync, "_refresh_master") as refresh:
                with self.assertRaisesRegex(common.OffboxError, "host key mismatch"):
                    ssh_sync._run_rsync("bx_fixture", ["rsync", "source", "dest"], 10)
                watch.assert_called_once()
                refresh.assert_not_called()

    def test_endpoint_change_invalidates_selection(self):
        self.setup_box()
        ssh_sync.ssh_base("bx_fixture")
        self.endpoint["managementSshEndpoint"] = "home:22005"
        self.setup_box()
        self.assertEqual(ssh_sync.ssh_base("bx_fixture")[-2:], ["-p", "22005"])
        self.assertEqual(self.run.call_count, 2)

    def test_rsync_retry_uses_the_refreshed_management_proxy(self):
        self.setup_box()
        commands = []
        def watch(cmd, *args, **kwargs):
            commands.append(list(cmd))
            return subprocess.CompletedProcess(cmd, 255 if len(commands) == 1 else 0, "", "Connection reset")
        def refresh(box):
            self.endpoint["managementSshEndpoint"] = "home:22007"
            ssh_sync.setup(box)
        with patch.object(ssh_sync, "_progress_args", return_value=()), \
                patch.object(ssh_sync, "_watch_rsync", side_effect=watch), \
                patch.object(ssh_sync, "_refresh_master", side_effect=refresh), \
                patch.object(api, "get", return_value={"state": "ready"}), \
                patch.object(ssh_sync, "RETRY_PAUSES", (0,)), patch.object(ssh_sync.time, "sleep"):
            p = ssh_sync._run_rsync("bx_fixture", ["rsync", "-e", "old", "src", "dest"], 10)
        self.assertEqual(p.returncode, 0)
        self.assertEqual([shlex.split(c[c.index("-e") + 1])[-2:] for c in commands],
                         [["-p", "22001"], ["-p", "22007"]])

    def test_old_daemon_and_boat_commands_are_unchanged(self):
        del self.endpoint["managementSshEndpoint"]
        for backend in ("server", "boat"):
            with self.subTest(backend=backend), patch.object(api, "BACKEND", backend):
                cfg = self.setup_box()
                self.assertEqual(ssh_sync.ssh_base("bx_fixture"), ["ssh", "-F", str(cfg)])
                self.assertIn("  Port 22000\n", cfg.read_text())
        self.run.assert_not_called()

    def test_old_daemon_host_key_error_stops_readiness_without_key_refresh(self):
        del self.endpoint["managementSshEndpoint"]
        self.setup_box()
        self.run.return_value = result(255, b"Host key verification failed.")
        with self.assertRaisesRegex(common.OffboxError, "host key mismatch"), patch.object(ssh_sync, "setup") as setup:
            ssh_sync.wait_ssh("bx_fixture")
        setup.assert_not_called()

    def test_closing_an_unselected_master_does_not_probe_ports(self):
        self.setup_box()
        self.assertEqual(ssh_sync.ssh_base("bx_fixture", probe=False),
                         ["ssh", "-F", str(ssh_sync.cfg_path("bx_fixture"))])
        self.run.assert_not_called()

    def test_cached_stall_probe_captures_and_classifies_actual_stderr(self):
        self.setup_box()
        ssh_sync.ssh_base("bx_fixture")
        bounded = ssh_sync._bounded_command
        def probe(cmd, timeout, **kw):
            self.assertTrue(kw["capture_stderr"])
            return bounded([sys.executable, "-I", "-c",
                            "import sys; sys.stderr.write('Host key verification failed.'); sys.exit(255)"], timeout, **kw)
        with patch.object(ssh_sync, "_bounded_command", side_effect=probe), \
                patch.object(ssh_sync, "_refresh_master") as refresh:
            with self.assertRaises(common.SshHostKeyMismatch):
                ssh_sync._remote_stall("bx_fixture", 5)
        refresh.assert_not_called()

    def test_bounded_probe_retains_an_identity_error_when_wait_hits_its_deadline(self):
        def spawn(cmd, *, stdout, stderr, **kw):
            stderr.write(b"Host key verification failed.")
            stderr.flush()
            def wait(timeout):
                raise subprocess.TimeoutExpired(cmd, timeout)
            return SimpleNamespace(wait=wait, poll=lambda: 0, returncode=255)
        with patch.object(ssh_sync.subprocess, "Popen", side_effect=spawn):
            p = ssh_sync._bounded_command(["ssh"], 1, capture_stderr=True)
        self.assertEqual(p.returncode, 255)
        self.assertIn(b"Host key verification failed", p.stderr)

    def test_pull_host_key_error_uses_the_control_route_message(self):
        self.setup_box()
        ssh_sync.ssh_base("bx_fixture")
        self.run.return_value = subprocess.CompletedProcess([], 255, "", "Host key verification failed.")
        with self.assertRaisesRegex(common.OffboxError, "host key mismatch.*offbox exec"):
            ssh_sync.pull("bx_fixture", "w/repo", ".", "out", ssh_sync.SSH_DIR)


class HomeLease(Isolated):
    def test_prune_probes_and_allocation_keep_mismatch_terminal_and_hold_intact(self):
        self.box("bx_fixture", member=True)
        self.con.execute("INSERT INTO prune_holds VALUES (?,?,?)", ("bx_fixture", "fixture", common.now() - 600))
        self.con.commit()
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        probes = (
            lambda: prune._quiesced("bx_fixture", "fixture", 2),
            lambda: prune.worker_gone("bx_fixture", "fixture", 600),
            lambda: prune.recheck(self.con, "bx_fixture", "fixture", 2),
            lambda: pool._recheck_prune_holds(self.con, "repo"),
            lambda: prune.run(self.con, "bx_fixture", "w/current"),
        )
        for probe in probes:
            with self.subTest(probe=probe), patch.object(ssh_sync, "ssh", side_effect=error), \
                    patch.object(prune, "_stale_with_times", return_value=[("w/stale", 1)]):
                with self.assertRaises(common.SshHostKeyMismatch) as caught:
                    probe()
                self.assertIs(caught.exception, error)
                self.assertIsNotNone(self.con.execute("SELECT 1 FROM prune_holds WHERE box_id='bx_fixture'").fetchone())

    def test_optional_warm_peer_does_not_hide_a_mismatch(self):
        self.box("bx_fixture", member=True)
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        with patch.object(lease, "ensure_ttl", return_value=True), \
                patch.object(api, "get", return_value={"state": "ready", "type": "large"}), \
                patch.object(ssh_sync, "ssh", side_effect=error):
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                pool.try_warm(self.me, "large", "template:crpko-go", set(), "run-fixture")
        self.assertIs(caught.exception, error)

    def runner(self):
        args = SimpleNamespace(no_sync=False, git=False, include=None, pull=[])
        rn = runs.Runner(args, self.me)
        rn.box = "bx_fixture"
        rn.lease_row = {"box_id": rn.box, "size": "large"}
        return rn

    def test_push_resume_preserves_terminal_error_without_another_transfer(self):
        rn = self.runner()
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        with patch.object(rn, "_check_box", return_value=None), \
                patch.object(rn, "_sync_box", side_effect=ssh_sync.BoxStoppedDuringPush(rn.box)) as sync, \
                patch.object(lease, "_reuse", side_effect=error):
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                rn._prepare_box(self.con, rn.a, "w/current", "env", b"fixture")
        self.assertIs(caught.exception, error)
        self.assertEqual(caught.exception.code, 2)
        sync.assert_called_once()

    def test_home_transfer_mismatch_precedes_retry_and_dead_mount_replacement(self):
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        dead = common.OffboxError("Transport endpoint is not connected")
        ordinary = common.OffboxError("Connection reset")
        cases = (
            (False, None, [error], 1),
            (True, None, [error], 1),
            (False, error, [None], 1),
            (False, dead, [error], 1),
            (False, error, [dead], 1),
            (False, error, [error], 1),
            (False, None, [ordinary, error], 2),
        )
        for no_sync, push_error, uploads, count in cases:
            with self.subTest(no_sync=no_sync, push=push_error, uploads=uploads):
                rn = self.runner()
                rn.a.no_sync = no_sync
                with patch.object(api, "BACKEND", "server"), patch.object(rn, "record"), patch.object(runs, "say"), \
                        patch.object(runs, "_seed_candidates", return_value=[]), \
                        patch.object(ssh_sync, "put_file", side_effect=uploads) as upload, \
                        patch.object(ssh_sync, "push", side_effect=push_error, return_value={}) as push:
                    with self.assertRaises(common.SshHostKeyMismatch) as caught:
                        rn._sync_box(self.con, rn.a, "w/current", "env", b"fixture")
                self.assertIs(caught.exception, error)
                self.assertEqual(upload.call_count, count)
                self.assertEqual(push.call_count, 0 if no_sync or uploads[0] is error else 1)

    def test_home_upload_mismatch_preempts_sibling_push_and_deadline(self):
        rn = self.runner()
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        with patch.object(api, "BACKEND", "server"), patch.object(ssh_sync, "put_file", side_effect=error), \
                patch.object(ssh_sync, "push", side_effect=prepare._Expired) as push:
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                rn._sync_box(self.con, rn.a, "w/current", "env", b"fixture")
        self.assertIs(caught.exception, error)
        push.assert_not_called()

    def test_identity_error_keeps_its_type_after_the_prepare_deadline(self):
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        now = [1000]
        clock = SimpleNamespace(monotonic=lambda: now[0])
        with patch.object(prepare, "time", clock), patch.object(prepare.threading, "current_thread", return_value=object()):
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                with prepare.guard("bx_fixture", seconds=1):
                    now[0] += 2
                    raise error
        self.assertIs(caught.exception, error)

    def test_boat_keeps_parallel_environment_upload(self):
        rn = self.runner()
        pushed = threading.Event()
        finished = threading.Event()
        threads = []
        def upload(*args):
            threads.append(threading.current_thread())
            self.assertTrue(pushed.wait(2), "Boat push must start while upload is pending")
            finished.set()
        def push(*args, **kw):
            pushed.set()
            self.assertTrue(finished.wait(2))
            return {}
        with patch.object(api, "BACKEND", "boat"), patch.object(rn, "record"), patch.object(runs, "say"), \
                patch.object(runs, "_seed_candidates", return_value=[]), \
                patch.object(ssh_sync, "put_file", side_effect=upload), patch.object(ssh_sync, "push", side_effect=push):
            rn._sync_box(self.con, rn.a, "w/current", "env", b"fixture")
        self.assertTrue(finished.is_set())
        self.assertTrue(all(t is not threading.current_thread() for t in threads))

    def test_bringup_and_resume_preserve_terminal_mismatch(self):
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        with patch.object(api, "wait_state", return_value={"state": "ready"}), \
                patch.object(ssh_sync, "setup") as setup, patch.object(ssh_sync, "wait_ssh", side_effect=error):
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                lease._bring_up("bx_fixture")
        self.assertIs(caught.exception, error)
        self.assertEqual(error.code, 2)
        setup.assert_called_once()
        with patch.object(lease, "_bring_up", side_effect=error):
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                lease._bring_up_resumed(self.con, "bx_fixture", {"state": "ready"}, False)
        self.assertIs(caught.exception, error)

    def test_pool_stops_on_mismatch_without_trying_a_peer_or_allocating(self):
        self.box("bx_A", member=True)
        self.box("bx_B", member=True)
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        with patch.object(pool, "_reuse_prepared", side_effect=error) as reuse, \
                patch.object(lease, "acquire_private") as create:
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                pool.acquire(self.me)
        self.assertIs(caught.exception, error)
        reuse.assert_called_once()
        create.assert_not_called()

    def test_recipe_upload_mismatch_never_retires_or_deletes_the_box(self):
        error = common.SshHostKeyMismatch("fixture identity mismatch")
        with patch.object(bases, "recipe", return_value=("echo recipe", "sha")), \
                patch.object(ssh_sync, "put_file", side_effect=error), patch.object(lease, "_retire_recipe_box") as retire:
            with self.assertRaises(common.SshHostKeyMismatch) as caught:
                lease.run_recipe("bx_fixture", "generic", box_held=True)
        self.assertIs(caught.exception, error)
        retire.assert_not_called()

    def test_cached_legacy_host_key_mismatch_cannot_trigger_endpoint_or_key_refresh(self):
        self.box("bx_fixture")
        row = self.con.execute("SELECT * FROM leases WHERE box_id='bx_fixture'").fetchone()
        with patch.object(api, "BACKEND", "server"), patch.object(ssh_sync, "cfg_path", return_value=Path(__file__)), \
                patch.object(ssh_sync, "ssh_base", return_value=["ssh"]), \
                patch.object(subprocess, "run", return_value=result(255, b"Host key verification failed.")), \
                patch.object(ssh_sync, "setup") as setup, patch.object(api, "readiness_get") as get:
            with self.assertRaisesRegex(common.OffboxError, "host key mismatch.*offbox exec"):
                lease._reuse(self.con, row, None)
        setup.assert_not_called()
        get.assert_not_called()


class HomeHost(server_tests.Base):
    def test_sshkey_api_returns_both_endpoints_with_the_same_pinned_key(self):
        box = self.box()
        handler = boatd.Handler.__new__(boatd.Handler)
        host_key = subprocess.CompletedProcess([], 0, b"ssh-ed25519 pinned comment\n", b"")
        with patch.object(boatd, "ct_exec", side_effect=[result(), host_key]):
            response = handler._sshkey(self.con, box, {"key": "ssh-ed25519 cHVibGlj"})
        self.assertEqual(response["sshEndpoint"], "127.0.0.1:22000")
        self.assertEqual(response["managementSshEndpoint"], "127.0.0.1:22001")
        self.assertEqual(response["hostKey"], "ssh-ed25519 pinned")
        self.assertEqual(response["sshUser"], "user")

    def test_old_box_gets_a_separate_stable_proxy_without_changing_legacy(self):
        box = self.box()
        port = boatd._ensure_mgmt_proxy(self.con, box)
        self.assertEqual(port, 22001)
        self.assertEqual(boatd._ensure_mgmt_proxy(self.con, box), port)
        self.assertEqual(self.state(box)["ssh_port"], 22000)
        self.assertEqual(boatd.next_ssh_port(self.con), 22002)
        additions = [c for c in self.f.calls if c[:3] == ("config", "device", "add")]
        self.assertTrue(all(c[4:6] == ("offbox-mgmt-ssh", "proxy") for c in additions))
        self.assertTrue(all(f"connect=tcp:127.0.0.1:{common.MGMT_PORT}" in c for c in additions))

    def test_inherited_proxy_is_retargeted_before_a_copied_box_starts(self):
        box = self.box()
        incus = self.f.incus
        def devices(*args, **kw):
            if args[:3] == ("config", "device", "list"):
                return subprocess.CompletedProcess(args, 0, b"ssh\noffbox-mgmt-ssh\n", b"")
            return incus(*args, **kw)
        with patch.object(boatd, "incus", side_effect=devices), patch.object(boatd, "_fresh_identity"):
            boatd.provision(box, ("box", "bx_source"), "default")
        calls = self.f.calls
        retarget = next(i for i, c in enumerate(calls) if c[:3] == ("config", "device", "set") and c[4] == "offbox-mgmt-ssh")
        start = next(i for i, c in enumerate(calls) if c[0] == "start")
        self.assertLess(retarget, start)
        self.assertIn("listen=tcp:127.0.0.1:22001", calls[retarget])
        self.assertIn(f"connect=tcp:127.0.0.1:{common.MGMT_PORT}", calls[retarget])

    def test_image_and_old_box_boot_readiness_use_their_own_listener(self):
        for legacy, expected in ((True, 22), (False, common.MGMT_PORT)):
            with self.subTest(legacy=legacy):
                observed = self.tmp / "listener"
                stubs = ('systemctl() { echo degraded; }; '
                         f'test() {{ return {0 if legacy else 1}; }}; '
                         f'ss() {{ printf "%s" "$2" > {shlex.quote(str(observed))}; echo LISTEN; }}; ')
                def execute(box, script, **kw):
                    return subprocess.run(["bash", "-c", stubs + script], capture_output=True, check=True)
                with patch.object(boatd, "ct_exec", side_effect=execute):
                    self.saved["_wait_boot"]("bx_fixture")
                self.assertEqual(observed.read_text(), f"sport = :{expected}")

    def test_session_accounting_includes_management_tunnels(self):
        content = "header\n0: 0100007F:08AE 0100007F:FF00 01\n1: 0100007F:0016 0100007F:FF01 01\n2: 0100007F:08AE 00000000:0000 0A\n"
        with patch.object(boatd, "ct_state", return_value={"pid": 42}), patch.object(Path, "read_text", return_value=content):
            self.assertEqual(boatd.ssh_sessions("bx_fixture"), 4)  # same fixture for tcp and tcp6


class ImageIsolation(unittest.TestCase):
    def test_service_and_config_do_not_inherit_guest_ssh_state(self):
        unit = (ASSETS / "offbox-mgmt-ssh.service").read_text()
        self.assertNotIn("Alias=", unit)
        for line in unit.splitlines():
            if line.split("=", 1)[0] in ("PartOf", "BindsTo", "Requires", "After", "Conflicts"):
                self.assertNotRegex(line, r"\b(?:ssh|sshd)\.(?:service|socket)\b")
        self.assertIn("RuntimeDirectory=sshd\n", unit)
        self.assertIn("RuntimeDirectoryPreserve=yes\n", unit)
        stock_dropin = (ASSETS / "offbox-ssh-runtime.conf").read_text()
        self.assertIn("[Service]\n", stock_dropin)
        self.assertIn("RuntimeDirectoryPreserve=yes\n", stock_dropin)
        config = (ASSETS / "offbox_mgmt_sshd_config").read_text()
        self.assertIn(f"Port {common.MGMT_PORT}\n", config)
        self.assertEqual(boatd.MGMT_PORT, common.MGMT_PORT)
        self.assertIn("ListenAddress 127.0.0.1\n", config)
        self.assertIn("PidFile /run/offbox-mgmt-sshd.pid\n", config)
        self.assertIn("PasswordAuthentication no\n", config)
        self.assertIn("KbdInteractiveAuthentication no\n", config)
        self.assertIn("PermitRootLogin no\n", config)
        self.assertIn("AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2\n", config)
        self.assertNotIn("Include", config)

    def test_vm_installer_stages_every_management_asset(self):
        server = SCRIPTS.parents[1] / "server"
        tree = ast.parse((server / "home/vmtest/run.py").read_text())
        files = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign)
                                     and any(isinstance(t, ast.Name) and t.id == "HOST_FILES" for t in node.targets)))
        names = {Path(f).name for f in files}
        self.assertTrue({"offbox-mgmt-ssh.service", "offbox_mgmt_sshd_config", "offbox-ssh-runtime.conf"} <= names)
        self.assertTrue(all((server / f).is_file() for f in files))


if __name__ == "__main__":
    unittest.main()
