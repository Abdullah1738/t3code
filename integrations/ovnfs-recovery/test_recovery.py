import json
import os
import socket
import sys
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import recovery as r


READY = {"pid": 123, "proto": "nfs", "port": 0, "state": r.STATE, "mount": r.MOUNT}


class Decisions(unittest.TestCase):
    def test_incident_error_forms(self):
        rows = [
            (1, "", "creating state /Volumes/ExternalSSD/.ovnfs: permission denied", "unreadable", "wait"),
            (1, "", "can't read state: x: input/output error", "unreadable", "wait"),
            (1, "", "daemon exited before accepting connections, state directory is already open", "held", "check-old-owner"),
            (1, "", "listen: cannot bind persisted nfs port 53885: address already in use", "port", "check-old-owner"),
            (1, "", "daemon or process 123 holds saved port for x but admin.sock is not answering", "port", "check-old-owner"),
            (1, "", "ovnfs starting or unresponsive (pid 123, state lock held)", "held", "check-old-owner"),
            (1, "", "not running", "absent", "start"),
            (1, '{"status":"loading","pid":124}', "", "loading", "wait"),
            (-1, "", "timeout", "unknown", "wait"),
            (1, "[]", "", "unknown", "wait"),
            (1, "", "fatal: error reading checkout/.git", "unknown", "wait"),
        ]
        for code, out, err, kind, action in rows:
            with self.subTest(err=err, out=out):
                actual, _ = r.classify(code, out, err)
                self.assertEqual(actual, kind)
                self.assertEqual(r.decide(True, actual, False), action)
                self.assertEqual(r.decide(False, actual, False), "observe")

    def test_status_does_not_prove_mount_health(self):
        self.assertEqual(r.decide(True, "ready", False), "wait")
        self.assertEqual(r.decide(True, "ready", True), "recovered")

    def test_mount_inventory_exact_paths(self):
        out = "/dev/disk5s1 on /Volumes/ExternalSSD (apfs, local)\n<x/nfs.sock>:/ on /Users/ardud/checkouts (nfs)"
        self.assertEqual(r.mount_source(out, r.VOLUME), "/dev/disk5s1")
        self.assertIsNone(r.mount_source(out, r.VOLUME + "2"))


    def test_transport_and_port_corpus(self):
        sock="<"+r.STATE+"/nfs.sock>:/"
        rows=[(0,sock,"ticotsord",r.STATE+"/nfs.sock",True),
              (53885,"127.0.0.1:/","tcp","53885",True),
              (53885,sock,"ticotsord",r.STATE+"/nfs.sock",False),
              (0,"127.0.0.1:/","tcp","53885",False),
              (53885,"127.0.0.1:/","tcp","53886",False),
              (53885,"127.0.0.1:/","udp","53885",False),
              (-1,"127.0.0.1:/","tcp","53885",False),
              (None,sock,"ticotsord",r.STATE+"/nfs.sock",False)]
        for port,source,transport,address,expected in rows:
            with self.subTest(port=port,source=source,transport=transport,address=address):
                data=dict(READY,port=port)
                entry={"Mount Point":r.MOUNT,"Current mount parameters":
                       {"NFS parameters":[transport,"port="+address,"mountport="+address]}}
                self.assertEqual(r.mount_matches(data,source,{source:entry}),expected)
                for malformed in [{},[],{source:[]},{source:dict(entry,**{"Mount Point":"/wrong"})}]:
                    self.assertFalse(r.mount_matches(data,source,malformed))


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.w = r.Recovery(self.tmp.name)
        self.w.data["old"] = {"pid":987654321,"birth":"gone","port":0}
        self.w.log = Mock()
        self.w.status = Mock(return_value=("absent", {}))
        self.w.mounts = Mock(return_value=("/dev/disk5s1", "<" + r.STATE + "/nfs.sock>:/"))
        self.w.recover = Mock()
        self.w.mount_ready = Mock(side_effect=lambda data, source: source == "<" + r.STATE + "/nfs.sock>:/" and data.get("port") == 0)
        self.pause_patch = patch.object(r, "PAUSE", Path(self.tmp.name)/"pause")
        self.pause_patch.start()
        self.addCleanup(self.pause_patch.stop)

    def ready(self):
        self.w.status.return_value = ("ready", READY)
        self.w.identity = Mock(return_value={"pid":123,"birth":"before","port":53885})
        self.w.tick()

    def drop_return(self):
        self.w.mounts.return_value = (None, None)
        self.w.tick()
        self.w.mounts.return_value = ("/dev/disk5s1", None)
        for _ in range(5):
            self.w.tick()

    def test_no_start_on_initial_absence_or_initial_unhealthy_mount(self):
        self.w.mounts.return_value = (None, None)
        self.w.tick()
        self.w.mounts.return_value = ("/dev/disk5s1", None)
        self.w.tick()
        self.w.recover.assert_not_called()

    def test_git_read_error_during_drop_keeps_identity_and_recovers_once(self):
        self.ready()
        self.w.status.return_value = ("absent", {})
        self.drop_return()
        self.w.recover.assert_called_once_with("start")
        self.assertEqual(self.w.data["old"]["birth"], "before")
        self.w.tick()
        self.w.recover.assert_called_once()

    def test_permission_denied_after_return_waits_without_clearing_state(self):
        self.ready()
        self.w.status.return_value = ("unreadable", {})
        self.drop_return()
        self.w.recover.assert_not_called()
        self.assertTrue(self.w.data["pending"])

    def test_loading_peer_is_never_signalled(self):
        self.ready()
        self.w.status.return_value = ("loading", {"pid":124})
        self.drop_return()
        self.w.recover.assert_not_called()

    def test_existing_peer_recovery_is_accepted(self):
        self.ready()
        self.drop_return()
        self.w.mounts.return_value = ("/dev/disk5s1", "<" + r.STATE + "/nfs.sock>:/")
        self.w.status.return_value = ("ready", dict(READY, pid=124))
        self.w.tick()
        self.assertFalse(self.w.data["pending"])

    def test_other_mount_sources_do_not_complete_recovery(self):
        self.ready()
        self.drop_return()
        for source in ["127.0.0.1:/", "</another/nfs.sock>:/", "/dev/disk5s2", None]:
            with self.subTest(source=source):
                self.w.mounts.return_value = ("/dev/disk5s1", source)
                self.w.tick()
                self.assertTrue(self.w.data["pending"])

    def test_pending_survives_watcher_restart(self):
        self.ready()
        self.w.mounts.return_value = (None, None)
        self.w.tick()
        another = r.Recovery(self.tmp.name)
        self.assertTrue(another.data["pending"])
        self.assertEqual(another.data["old"]["pid"],123)

    def test_start_rechecks_status_and_mount(self):
        self.w.start = r.Recovery.start.__get__(self.w)
        with patch.object(r, "STATE", self.tmp.name), patch.object(r,"recorded_exit",return_value=True), patch.object(r.subprocess, "Popen") as spawn:
            self.w.status.return_value = ("ready", READY)
            self.w.start()
            spawn.assert_not_called()
            self.w.status.return_value = ("absent", {})
            self.w.mounts.return_value = (None, None)
            self.w.start()
            spawn.assert_not_called()

    def test_all_unmount_receipt_forms(self):
        # Unknown phases, invalid JSON and incomplete unmounts must never reach
        # the CLI's automatic forced-unmount path, even if their PID is gone.
        rows = [(None, True), ({"phase":"done"}, True)] + [
            ({"phase":p,"pid":pid,"mount":r.MOUNT},False)
            for p in ["starting","running","failed","unknown",None,0]
            for pid in [0,123,os.getpid()]] + [
            ([],False),("broken",False)]
        path=Path(self.tmp.name)/"unmount.json"
        self.w.start = r.Recovery.start.__get__(self.w)
        self.w.mounts.return_value = ("/dev/disk5s1", None)
        with patch.object(r,"STATE",self.tmp.name), patch.object(r,"recorded_exit",return_value=True), patch.object(r.subprocess,"Popen") as spawn, patch.object(r.threading,"Thread"):
            for receipt, allowed in rows:
                with self.subTest(receipt=receipt):
                    if path.exists(): path.unlink()
                    if receipt is not None:
                        path.write_text(receipt if receipt == "broken" else json.dumps(receipt))
                    spawn.reset_mock()
                    self.w.start()
                    self.assertEqual(spawn.called, allowed)
                    if allowed:
                        args=spawn.call_args.args[0]
                        self.assertIn("serve",args)
                        self.assertNotIn("start",args)
                        self.assertIn("--starter-fd",args)
                        self.assertEqual(len(spawn.call_args.kwargs["pass_fds"]),1)

    def test_absent_status_does_not_replace_live_or_unknown_pre_drop_owner(self):
        self.w.start = r.Recovery.start.__get__(self.w)
        self.w.mounts.return_value = ("/dev/disk5s1",None)
        for old in [None, {"pid":123,"birth":"before","port":0}]:
            self.w.data["old"]=old
            with self.subTest(old=old), patch.object(r,"STATE",self.tmp.name), patch.object(r,"birth",return_value="before"), patch.object(r.subprocess,"Popen") as spawn:
                self.w.start()
                spawn.assert_not_called()

    def test_unreadable_receipt_never_spawns(self):
        self.w.start = r.Recovery.start.__get__(self.w)
        with patch.object(r,"STATE",self.tmp.name), patch.object(Path,"read_text",side_effect=PermissionError), patch.object(r.subprocess,"Popen") as spawn:
            self.w.start()
            spawn.assert_not_called()

    def test_active_memguard_prevents_recovery(self):
        self.w.memguard_running = Mock(return_value=True)
        with self.w.pause_memguard() as claimed:
            self.assertFalse(claimed)

    def test_real_child_inherits_start_lock(self):
        fake=Path(self.tmp.name)/"fake-ovnfs"
        fake.write_text("#!/usr/bin/python3\nimport fcntl,os,sys\nfrom pathlib import Path\nfd=int(sys.argv[sys.argv.index('--starter-fd')+1])\nfcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nassert os.fstat(fd).st_ino == os.stat(Path(__file__).parent/'start.lock').st_ino\nPath(__file__).with_suffix('.proof').write_text('ok')\n")
        fake.chmod(0o755)
        real_spawn=subprocess.Popen
        children=[]
        def capture(*args, **kwargs):
            child=real_spawn(*args,**kwargs)
            children.append(child)
            return child
        self.w.start = r.Recovery.start.__get__(self.w)
        self.w.mounts.return_value = ("/dev/disk5s1",None)
        with patch.object(r,"STATE",self.tmp.name), patch.object(r,"BINARY",str(fake)), patch.object(r,"birth",return_value=""), patch.object(r.subprocess,"Popen",side_effect=capture):
            self.w.start()
        self.assertEqual(len(children),1)
        self.assertEqual(children[0].wait(timeout=5),0)
        self.assertEqual(fake.with_suffix('.proof').read_text(),'ok')

    @unittest.skipUnless(sys.platform == "darwin", "macOS process birth formatting")
    def test_timezone_change_does_not_change_birth_or_prove_exit(self):
        pid=os.getpid()
        with patch.dict(os.environ,{"TZ":"UTC","LC_ALL":"C"}):
            before=r.birth(pid)
        self.assertTrue(before)
        with patch.dict(os.environ,{"TZ":"Asia/Dubai","LC_ALL":"C"}):
            self.assertEqual(r.birth(pid),before)
            self.assertFalse(r.recorded_exit({"pid":pid,"birth":before}))

    def test_exit_proof_distinguishes_gone_reused_and_uninspectable_pid(self):
        old={"pid":123,"birth":r.BIRTH_PREFIX+"10"}
        with patch.object(r,"birth",return_value=r.BIRTH_PREFIX+"11"):
            self.assertTrue(r.recorded_exit(old))
        with patch.object(r,"birth",return_value=r.BIRTH_PREFIX+"10"):
            self.assertFalse(r.recorded_exit(old))
        with patch.object(r,"birth",return_value=""), patch.object(r.os,"kill",side_effect=ProcessLookupError):
            self.assertTrue(r.recorded_exit(old))
        for result in [None,PermissionError()]:
            with self.subTest(result=result), patch.object(r,"birth",return_value=""), patch.object(r.os,"kill",side_effect=result):
                self.assertFalse(r.recorded_exit(old))

    def test_legacy_and_malformed_births_cannot_prove_replacement(self):
        rows=["Thu Nov 12 10:11:46 2026", "ps-utc-v2:10", "ps-utc-v1:bad", "ps-utc-v1:-10", "ps-utc-v1:١٠", "", None, 10, [10]]
        for token in rows:
            with self.subTest(token=token), patch.object(r,"birth",return_value=r.BIRTH_PREFIX+"20"), patch.object(r.os,"kill",return_value=None):
                self.assertFalse(r.recorded_exit({"pid":123,"birth":token}))
        with patch.object(r,"birth",return_value=r.BIRTH_PREFIX+"20"), patch.object(r.os,"kill",side_effect=ProcessLookupError):
            self.assertTrue(r.recorded_exit({"pid":123,"birth":"legacy local display"}))

    def test_peer_start_lease_prevents_spawn(self):
        self.w.start = r.Recovery.start.__get__(self.w)
        with patch.object(r,"STATE",self.tmp.name), patch.object(r.subprocess,"Popen") as spawn:
            with r.lease(Path(self.tmp.name)/"start.lock"):
                self.w.start()
            spawn.assert_not_called()

    def test_exact_pre_drop_owner_term_under_start_lock_once(self):
        self.w.recover = r.Recovery.recover.__get__(self.w)
        self.w.memguard_running = Mock(return_value=False)
        self.w.owner_matches = Mock(return_value=True)
        self.w.data["old"] = {"pid":123,"birth":"before","port":53885}
        self.w.status.return_value = ("held", {})
        with patch.object(r, "STATE", self.tmp.name), patch.object(r,"PAUSE",Path(self.tmp.name)/"pause"), patch.object(r,"run",return_value=(0,r.SUPPORTED_BUILD,"")), patch.object(r.os,"kill") as kill:
            self.w.recover("check-old-owner")
            self.w.recover("check-old-owner")
            kill.assert_called_once_with(123, r.signal.SIGTERM)

    def test_pause_survives_startup_and_release_only_after_ready(self):
        self.w.memguard_running = Mock(return_value=False)
        with self.w.pause_memguard() as claimed:
            self.assertTrue(claimed)
        self.assertTrue(r.PAUSE.exists())
        self.assertTrue(os.path.samefile(r.PAUSE, self.w.runtime/"memguard-pause"))
        another = r.Recovery(self.tmp.name)
        another.memguard_running = Mock(return_value=False)
        with another.pause_memguard() as claimed:
            self.assertTrue(claimed)
        another.release_pause()
        self.assertFalse(r.PAUSE.exists())

    def test_expired_foreign_pause_is_not_overwritten(self):
        r.PAUSE.write_text("1\n")
        with self.w.pause_memguard() as claimed:
            self.assertFalse(claimed)
        self.assertEqual(r.PAUSE.read_text(), "1\n")

    def test_pause_crash_after_publication_resumes(self):
        self.w.memguard_running = Mock(return_value=False)
        real_link=os.link
        def link_then_crash(*args):
            real_link(*args)
            raise RuntimeError("crash after publication")
        with patch.object(r.os,"link",side_effect=link_then_crash):
            with self.assertRaises(RuntimeError):
                with self.w.pause_memguard(): pass
        another = r.Recovery(self.tmp.name)
        another.memguard_running = Mock(return_value=False)
        with another.pause_memguard() as claimed:
            self.assertTrue(claimed)

    def test_pause_crash_before_publication_resumes(self):
        self.w.memguard_running = Mock(return_value=False)
        with patch.object(r.os,"link",side_effect=RuntimeError("before link")):
            with self.assertRaises(RuntimeError):
                with self.w.pause_memguard(): pass
        self.assertFalse(r.PAUSE.exists())
        another = r.Recovery(self.tmp.name)
        another.memguard_running = Mock(return_value=False)
        with another.pause_memguard() as claimed:
            self.assertTrue(claimed)

    def test_expired_published_pause_is_never_rewritten(self):
        self.w.memguard_running = Mock(return_value=False)
        with patch.object(r.time,"time",return_value=1000):
            with self.w.pause_memguard() as claimed:
                self.assertTrue(claimed)
        for _ in range(2):
            another=r.Recovery(self.tmp.name)
            another.memguard_running=Mock(return_value=False)
            another.log=Mock()
            with patch.object(r.time,"time",return_value=3000), patch.object(Path,"write_text",side_effect=AssertionError("renewal must never truncate a published file")):
                with another.pause_memguard() as claimed:
                    self.assertFalse(claimed)
            another.log.assert_called()
        self.assertEqual(r.PAUSE.read_text(),"2800\n")

    def test_incomplete_own_pause_is_reported_without_rewriting(self):
        self.w.memguard_running = Mock(return_value=False)
        with self.w.pause_memguard(): pass
        own=self.w.runtime/"memguard-pause"
        for token in ["", "4x", "48", "9999999999\n"]:
            own.write_text(token)
            another=r.Recovery(self.tmp.name)
            another.memguard_running=Mock(return_value=False)
            another.log=Mock()
            with self.subTest(token=token), patch.object(Path,"write_text",side_effect=AssertionError("preserve published pause")):
                with another.pause_memguard() as claimed:
                    self.assertFalse(claimed)
                another.log.assert_called()
            self.assertEqual(r.PAUSE.read_text(),token)

    def test_unknown_or_new_owner_is_not_signalled(self):
        self.w.recover = r.Recovery.recover.__get__(self.w)
        self.w.memguard_running = Mock(return_value=False)
        self.w.owner_matches = Mock(return_value=False)
        self.w.status.return_value = ("port", {})
        with patch.object(r, "STATE", self.tmp.name), patch.object(r,"PAUSE",Path(self.tmp.name)/"pause"), patch.object(r,"run",return_value=(0,r.SUPPORTED_BUILD,"")), patch.object(r.os,"kill") as kill:
            self.w.recover("check-old-owner")
            kill.assert_not_called()

    def test_pid_reuse_fails_even_if_listener_matches(self):
        with patch.object(r,"birth",return_value="new"), patch.object(r,"run") as command:
            self.assertFalse(self.w.owner_matches({"pid":123,"birth":"old","port":53885}))
            command.assert_not_called()

    @unittest.skipUnless(sys.platform == "darwin", "macOS descriptor identity")
    def test_lsof_exact_state_descriptor_on_real_process(self):
        old = {"pid": os.getpid(), "birth": r.birth(os.getpid()), "port": 0}
        with open(Path(self.tmp.name)/"state.lock", "w"):
            with patch.object(r, "STATE", self.tmp.name):
                self.assertTrue(self.w.owner_matches(old))
        with patch.object(r, "STATE", self.tmp.name):
            self.assertFalse(self.w.owner_matches(old))

    @unittest.skipUnless(sys.platform == "darwin", "macOS TCP listener identity")
    def test_lsof_exact_tcp_listener_on_real_process(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            old = {"pid": os.getpid(), "birth": r.birth(os.getpid()), "port": listener.getsockname()[1]}
            with patch.object(r, "STATE", self.tmp.name):
                self.assertTrue(self.w.owner_matches(old))
        with patch.object(r, "STATE", self.tmp.name):
            self.assertFalse(self.w.owner_matches(old))

    def test_foreign_memguard_pause_is_preserved(self):
        pause=Path(self.tmp.name)/"pause"
        pause.write_text("9999999999\n")
        with patch.object(r,"PAUSE",pause):
            with self.w.pause_memguard() as claimed:
                self.assertFalse(claimed)
        self.assertEqual(pause.read_text(),"9999999999\n")

    def test_lock_is_not_removed_and_second_watcher_is_excluded(self):
        path=Path(self.tmp.name)/"lock"
        with r.lease(path) as first:
            with r.lease(path) as second:
                self.assertTrue(first)
                self.assertFalse(second)
        self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
