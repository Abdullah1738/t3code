import json
import os
import socket
import sys
import subprocess
import shutil
from pathlib import Path
import tempfile
import unittest
from contextlib import contextmanager
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
        self.w.remember_generation = Mock()
        self.w.observe_generation = Mock()
        self.w.peer_recovery_safe = Mock(return_value=True)
        @contextmanager
        def fence():
            with r.lease(Path(self.tmp.name)/"start.lock") as lock:
                yield (lock,[{"quiet":True,"holders":set()}]) if lock else None
        self.w.start_fence = fence
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
        @contextmanager
        def fence():yield (None,[{"quiet":False,"holders":{123}}])
        self.w.start_fence=fence
        with patch.object(r, "STATE", self.tmp.name), patch.object(r,"PAUSE",Path(self.tmp.name)/"pause"), patch.object(r,"run",return_value=(0,r.SUPPORTED_BUILD,"")), patch.object(r,"process_args",return_value=("ovnfs",[])), patch.object(r.os,"kill") as kill:
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


class SurvivorProofTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=="darwin","Darwin POSIX/flock domains")
    def test_kernel_lock_domain_identity_and_busy_marker(self):
        with tempfile.TemporaryDirectory() as root:
            a=Path(root)/"a";a.touch()
            b=Path(root)/"b";b.touch()
            with open(a,"r+") as left,open(a,"r+") as same,open(b,"r+") as different:
                self.assertTrue(r.same_lock_domain(left.fileno(),same.fileno()))
                self.assertFalse(r.same_lock_domain(left.fileno(),different.fileno()))
                with r.lease(a):
                    self.assertIsNone(r.same_lock_domain(left.fileno(),same.fileno()))

    def test_argument_corpus(self):
        rows=[
            (["ovnfs","serve","-state",r.STATE],True),
            (["ovnfs","serve","--state="+r.STATE],True),
            (["ovnfs","--state",r.STATE,"--mount",r.MOUNT,"serve"],True),
            (["ovnfs","-state="+r.STATE,"--json","serve"],True),
            (["ovnfs","serve","--state",r.STATE+"/./"],True),
            (["ovnfs","serve"],False),
            (["ovnfs","start","--state",r.STATE],False),
            (["ovnfs","restart","--state",r.STATE],False),
            (["ovnfs","new","--state",r.STATE],False),
            (["ovnfs","serve","--state",r.STATE+"-other"],False),
            (["ovnfs","serve","--state","relative"],False),
            (["ovnfs","serve","--state"],False),
            (["ovnfs","--unknown","serve","--state",r.STATE],False),
        ]
        for args,expected in rows:
            with self.subTest(args=args):
                process=("/exec/ovnfs",args)
                self.assertEqual(r.serves_state(process),expected)

    def test_kernel_argv_decoder_stops_before_environment(self):
        args=["ovnfs","serve","--state="+r.STATE,""]
        raw=len(args).to_bytes(4,"little",signed=True)+b"/exec/ovnfs\0\0"+b"\0".join(a.encode() for a in args)+b"\0PRIVATE_TEST=fixture\0"
        self.assertEqual(r.decode_args(raw),("/exec/ovnfs",args))
        for bad in [b"",b"\0"*4,(-1).to_bytes(4,"little",signed=True),b"\1\0\0\0unterminated"]:
            with self.subTest(raw=bad),self.assertRaises(ValueError):r.decode_args(bad)

@unittest.skipUnless(sys.platform=="darwin","macOS kernel argv and pinned CLI fixture")
class NamespaceLossTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.state=self.root/"state"
        self.state.mkdir()
        self.mount=self.root/"mount"
        self.mount.mkdir()
        for attr,value in [("STATE",str(self.state)),("MOUNT",str(self.mount)),("PAUSE",self.root/"pause")]:
            p=patch.object(r,attr,value);p.start();self.addCleanup(p.stop)
        self.w=r.Recovery(self.root/"runtime")
        self.w.runtime.mkdir()
        self.w.log=Mock()
        self.w.memguard_running=Mock(return_value=False)
        self.w.mounts=Mock(return_value=("fixture-volume",None))
        self.w.spawn=Mock()
        (self.state/"start.lock").touch()
        (self.state/"state.lock").touch()
        self.w.remember_generation()
        self.addCleanup(self.w.close_generations)
        (self.root/"serve").write_text("import fcntl,socket,sys\nfrom pathlib import Path\ns=Path(sys.argv[sys.argv.index('--state')+1])\nf=open(s/'state.lock','w');fcntl.flock(f,fcntl.LOCK_EX)\na=socket.socket(socket.AF_UNIX);a.bind(str(s/'admin.sock'));a.listen()\nn=socket.socket(socket.AF_UNIX);n.bind(str(s/'nfs.sock'));n.listen()\nprint('ready',flush=True)\nsys.stdin.read()\n")

    def fixture(self, renamed=False, phase="ready"):
        if renamed:
            executable=self.root/"peer-build"
            if not executable.exists():
                shutil.copyfile("/usr/bin/perl",executable)
                executable.chmod(0o755)
            script=self.root/"serve"
            script.write_text('''use strict; use warnings;
use Fcntl qw(:flock); use Socket qw(SOCK_STREAM); use IO::Socket::UNIX;
my ($state,$phase); for(my $i=0;$i<@ARGV;$i++) {
 if($ARGV[$i] eq '--state') {$state=$ARGV[++$i];}
 if($ARGV[$i] eq '--phase') {$phase=$ARGV[++$i];}}
my ($lock,$admin,$nfs);
if($phase eq 'starting' || $phase eq 'ready') {
 my $name=$phase eq 'starting' ? 'start.lock' : 'state.lock';
 open($lock,'>',"$state/$name") or die $!; flock($lock,LOCK_EX) or die $!;}
if($phase ne 'starting' && $phase ne 'nfs-only') {
 $admin=IO::Socket::UNIX->new(Type=>SOCK_STREAM,Local=>"$state/admin.sock",Listen=>1) or die $!;}
if($phase eq 'ready' || $phase eq 'nfs-only') {
 $nfs=IO::Socket::UNIX->new(Type=>SOCK_STREAM,Local=>"$state/nfs.sock",Listen=>1) or die $!;}
$|=1; print "ready\\n"; my $line=<STDIN>;
''')
            argv=[str(executable),"serve","--state",str(self.state),"--phase",phase]
        else:
            executable=sys.executable
            argv=[r.BINARY,"serve","--state",str(self.state),"--mount",str(self.mount)]
        child=subprocess.Popen(argv,executable=str(executable),cwd=self.root,stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        def close():
            if child.poll() is None:
                child.stdin.close();child.wait(timeout=5)
            for f in [child.stdin,child.stdout,child.stderr]:
                if f and not f.closed:f.close()
        self.addCleanup(close)
        self.assertEqual(child.stdout.readline(),"ready\n")
        return child

    def identity(self,child):
        data=dict(READY,pid=child.pid,state=str(self.state),mount=str(self.mount))
        result=self.w.identity(data)
        self.assertIn("args_digest",result)
        self.assertTrue(r.serves_state(r.process_args(child.pid)))
        return result

    def lose_namespace(self):
        self.state.rename(self.root/("old-state-"+str(len(list(self.root.glob("old-state-*"))))))
        self.state.mkdir()
        (self.state/"state.json").write_text('{"proto":"nfs","port":0}')
        (self.state/"start.lock").touch()
        (self.state/"state.lock").touch()
        kind,_=self.w.status()  # actual pinned CLI, explicit disposable state
        self.assertEqual(kind,"absent")

    def test_peer_restart_between_polls_then_drop_blocks_replacement(self):
        a=self.fixture()
        with patch.object(r.time,"monotonic",return_value=100):
            self.w.status=Mock(return_value=("ready",dict(READY,pid=a.pid)))
            self.w.mount_ready=Mock(return_value=True)
            self.w.tick()
        old=self.w.data["owner"]
        a.stdin.close();a.wait(timeout=5)
        for name in ["admin.sock","nfs.sock"]:(self.state/name).unlink()
        b=self.fixture()
        self.w.status.return_value=("ready",dict(READY,pid=b.pid))
        with patch.object(r.time,"monotonic",return_value=101):self.w.tick()
        self.assertEqual(self.w.data["owner"]["pid"],a.pid)
        self.w.mounts.return_value=(None,None)
        self.w.tick()
        self.assertEqual(self.w.data["old"],old)
        self.w.status=r.Recovery.status.__get__(self.w)
        self.lose_namespace()
        self.w.mounts.return_value=("fixture-volume",None)
        with patch.object(r.os,"kill",wraps=os.kill) as signals:
            self.w.recover("start")
            self.w.spawn.assert_not_called()
            self.assertFalse(any(call.args[1]==r.signal.SIGTERM for call in signals.call_args_list))
        self.assertIsNone(b.poll())

    def test_absent_known_unix_owner_term_exit_then_exactly_one_start(self):
        b=self.fixture()
        self.w.data["old"]=self.identity(b)
        self.lose_namespace()
        real_kill=os.kill
        terms=[]
        def stop_fixture(pid,sig):
            if sig==r.signal.SIGTERM:
                self.assertEqual(pid,b.pid)
                terms.append(pid)
                b.stdin.close();b.wait(timeout=5)
            else:return real_kill(pid,sig)
        with patch.object(r.os,"kill",side_effect=stop_fixture):
            self.w.recover("start")
        self.assertEqual(terms,[b.pid])
        self.w.spawn.assert_not_called()
        self.assertIsNotNone(b.poll())
        self.w.spawn.side_effect=lambda lock:setattr(self.w,"status",Mock(return_value=("loading",{})))
        self.w.recover("start")
        self.w.recover("start")
        self.w.spawn.assert_called_once()

    def test_concurrent_start_lease_also_excludes_term(self):
        b=self.fixture()
        self.w.data["old"]=self.identity(b)
        self.lose_namespace()
        with r.lease(self.state/"start.lock"),patch.object(r.os,"kill") as signals:
            self.w.recover("start")
            signals.assert_not_called()
            self.w.spawn.assert_not_called()
        self.assertIsNone(b.poll())

    def test_mismatched_proof_or_concurrent_peer_cannot_receive_term(self):
        b=self.fixture()
        self.w.data["old"]=self.identity(b)
        self.lose_namespace()
        baseline=self.w.data["old"].copy()
        for corrupt,extra in [(True,False),(False,True)]:
            with self.subTest(corrupt=corrupt,extra=extra):
                old=baseline.copy()
                if corrupt:old["args_digest"]="different"
                self.w.data["old"]=old
                real_probe=r.directory_probe
                def probe(fd):
                    result=real_probe(fd)
                    if extra:result["holders"].append(987654321)
                    return result
                with patch.object(r,"directory_probe",side_effect=probe),patch.object(r.os,"kill") as signals:
                    self.w.recover("start")
                    signals.assert_not_called()
                    self.w.spawn.assert_not_called()
        self.assertIsNone(b.poll())

    def test_renamed_peer_is_excluded_at_every_startup_phase(self):
        a=self.fixture()
        self.w.data["old"]=self.identity(a)
        a.stdin.close();a.wait(timeout=5)
        for name in ("admin.sock","nfs.sock"):(self.state/name).unlink()
        for phase in ("starting","listening","ready","nfs-only"):
            with self.subTest(phase=phase):
                b=self.fixture(renamed=True,phase=phase)
                self.lose_namespace()
                with patch.object(r.os,"kill",wraps=os.kill) as signals:
                    self.w.recover("start")
                self.w.spawn.assert_not_called()
                self.assertFalse(any(call.args[1]==r.signal.SIGTERM for call in signals.call_args_list))
                self.assertIsNone(b.poll())
                b.stdin.close();b.wait(timeout=5)

    def test_second_drop_retains_intermediate_peer_generation(self):
        a=self.fixture()
        self.w.data["old"]=self.identity(a)
        a.stdin.close();a.wait(timeout=5)
        self.lose_namespace()
        self.w.data.update(pending=True,stable=0)
        self.w.tick()  # observe the first return before the five stable ticks
        b=self.fixture(renamed=True)
        self.lose_namespace()
        with patch.object(r.os,"kill",wraps=os.kill) as signals:
            self.w.recover("start")
        self.assertEqual(len(self.w.generations),3)
        self.w.spawn.assert_not_called()
        self.assertFalse(any(call.args[1]==r.signal.SIGTERM for call in signals.call_args_list))
        self.assertIsNone(b.poll())

    def test_watcher_restart_cannot_reconstruct_lost_generation_fence(self):
        b=self.fixture()
        self.w.data.update(old=self.identity(b),pending=True)
        self.w.save()
        self.lose_namespace()
        restarted=r.Recovery(self.w.runtime)
        self.addCleanup(restarted.close_generations)
        restarted.log=Mock()
        restarted.memguard_running=Mock(return_value=False)
        restarted.mounts=self.w.mounts
        restarted.spawn=Mock()
        with patch.object(r.os,"kill",wraps=os.kill) as signals:
            restarted.recover("start")
        restarted.spawn.assert_not_called()
        self.assertFalse(any(call.args[1]==r.signal.SIGTERM for call in signals.call_args_list))

    def test_healthy_journal_restart_before_sample_cannot_adopt_returned_generation(self):
        a=self.fixture()
        self.w.status=Mock(return_value=("ready",dict(READY,pid=a.pid)))
        self.w.mount_ready=Mock(return_value=True)
        self.w.tick()
        old=self.w.data["owner"]
        self.assertFalse(self.w.data.get("pending",False))
        a.stdin.close();a.wait(timeout=5)
        for name in ("admin.sock","nfs.sock"):(self.state/name).unlink()
        b=self.fixture(renamed=True)
        self.w.close_generations()
        restarted=r.Recovery(self.w.runtime)
        self.addCleanup(restarted.close_generations)
        restarted.log=Mock()
        restarted.memguard_running=Mock(return_value=False)
        restarted.mounts=Mock(return_value=(None,None))
        restarted.spawn=Mock()
        self.assertTrue(restarted.unwitnessed)
        restarted.tick()
        self.w.status=r.Recovery.status.__get__(self.w)
        self.lose_namespace()
        restarted.mounts.return_value=("fixture-volume",None)
        with patch.object(r.os,"kill",wraps=os.kill) as signals:
            for _ in range(5):restarted.tick()
        self.assertTrue(restarted.data["pending"])
        self.assertTrue(restarted.unwitnessed)
        self.assertEqual(restarted.data["old"],old)
        self.assertEqual(len(restarted.generations),1)
        self.assertTrue(r.recorded_exit(old))
        self.assertEqual(restarted.status()[0],"absent")
        restarted.spawn.assert_not_called()
        self.assertFalse(any(call.args[1]==r.signal.SIGTERM for call in signals.call_args_list))
        self.assertIsNone(b.poll())

    def test_fresh_healthy_sample_rearms_a_restarted_healthy_journal(self):
        b=self.fixture()
        self.w.status=Mock(return_value=("ready",dict(READY,pid=b.pid)))
        self.w.mount_ready=Mock(return_value=True)
        self.w.tick()
        self.w.close_generations()
        restarted=r.Recovery(self.w.runtime)
        self.addCleanup(restarted.close_generations)
        restarted.log=Mock()
        restarted.mounts=self.w.mounts
        restarted.status=self.w.status
        restarted.mount_ready=self.w.mount_ready
        self.assertTrue(restarted.unwitnessed)
        restarted.tick()
        self.assertFalse(restarted.unwitnessed)
        self.assertEqual(len(restarted.generations),1)
        self.assertEqual(restarted.data["owner"]["pid"],b.pid)

    def test_pending_journal_restart_cannot_arm_from_a_ready_peer(self):
        b=self.fixture()
        self.w.data.update(seen=True,old=self.identity(b),pending=True,stable=4)
        self.w.save()
        self.w.close_generations()
        restarted=r.Recovery(self.w.runtime)
        self.addCleanup(restarted.close_generations)
        restarted.log=Mock()
        restarted.mounts=self.w.mounts
        restarted.status=Mock(return_value=("ready",dict(READY,pid=b.pid)))
        restarted.mount_ready=Mock(return_value=True)
        restarted.tick()
        self.assertTrue(restarted.unwitnessed)
        self.assertTrue(restarted.data["pending"])

    def test_closed_revoked_or_unreadable_witness_never_authorizes_start(self):
        a=self.fixture()
        self.w.data["old"]=self.identity(a)
        a.stdin.close();a.wait(timeout=5)
        self.lose_namespace()
        for error in (OSError(r.errno.EBADF,"revoked"),PermissionError("unreadable"),RuntimeError("malformed probe")):
            with self.subTest(error=error),patch.object(r,"directory_probe",side_effect=error):
                with self.assertRaises(type(error)):self.w.recover("start")
                self.w.spawn.assert_not_called()
        self.w.generations[0].close()
        with self.assertRaises(RuntimeError):self.w.recover("start")
        self.w.spawn.assert_not_called()

    def test_replaced_lock_inode_is_not_adopted(self):
        a=self.fixture()
        self.w.data["old"]=self.identity(a)
        a.stdin.close();a.wait(timeout=5)
        (self.state/"start.lock").rename(self.state/"original-start.lock")
        (self.state/"start.lock").touch()
        self.lose_namespace()
        with self.assertRaises(RuntimeError):self.w.recover("start")
        self.w.spawn.assert_not_called()

    def test_current_peer_excludes_term_of_known_old_owner(self):
        b=self.fixture()
        self.w.data["old"]=self.identity(b)
        self.lose_namespace()
        self.w.status=Mock(return_value=("absent",{}))
        for phase in ("ready","listening"):
            with self.subTest(phase=phase):
                c=self.fixture(renamed=True,phase=phase)
                with patch.object(r.os,"kill",wraps=os.kill) as signals:
                    self.w.recover("start")
                self.w.spawn.assert_not_called()
                self.assertFalse(any(call.args[1]==r.signal.SIGTERM for call in signals.call_args_list))
                self.assertIsNone(b.poll());self.assertIsNone(c.poll())
                c.stdin.close();c.wait(timeout=5)
                for name in ("admin.sock","nfs.sock"):
                    if (self.state/name).exists():(self.state/name).unlink()

    def test_ready_current_peer_does_not_hide_surviving_old_generation(self):
        b=self.fixture()
        self.w.data["old"]=self.identity(b)
        self.lose_namespace()
        c=self.fixture(renamed=True)
        self.w.data.update(pending=True,stable=4)
        self.w.status=Mock(return_value=("ready",dict(READY,pid=c.pid)))
        self.w.mount_ready=Mock(return_value=True)
        self.w.tick()
        self.assertTrue(self.w.data["pending"])
        self.w.spawn.assert_not_called()

    def test_missing_intermediate_witness_is_permanent_for_this_incident(self):
        self.w.data.update(pending=True,stable=0)
        (self.state/"state.lock").rename(self.state/"missing-state.lock")
        self.lose_namespace()
        (self.state/"state.lock").rename(self.state/"not-yet-created")
        with self.assertRaises(OSError):self.w.tick()
        (self.state/"not-yet-created").rename(self.state/"state.lock")
        self.w.recover("start")
        self.assertTrue(self.w.unwitnessed)
        self.w.spawn.assert_not_called()

    def test_equal_dev_inode_does_not_merge_distinct_lock_domains(self):
        a=self.fixture()
        self.w.data["old"]=self.identity(a)
        a.stdin.close();a.wait(timeout=5)
        for name in ("admin.sock","nfs.sock"):(self.state/name).unlink()
        b=self.fixture(renamed=True)
        self.lose_namespace()
        self.w.generations[0].key=r.file_identity(os.stat(self.state))
        self.w.returning=True
        self.w.observe_generation()
        self.assertEqual(self.w.generations[0].key,self.w.generations[1].key)
        self.w.recover("start")
        self.w.spawn.assert_not_called()
        self.assertIsNone(b.poll())

    def test_return_to_same_lock_domain_does_not_self_block(self):
        a=self.fixture()
        old=self.identity(a)
        self.w.data.update(seen=True,owner=old)
        a.stdin.close();a.wait(timeout=5)
        self.w.mounts.return_value=(None,None)
        self.w.tick()
        self.w.mounts.return_value=("fixture-volume",None)
        self.w.tick()
        self.assertEqual(len(self.w.generations),2)
        self.w.recover("start")
        self.w.spawn.assert_called_once()

    def test_ready_peer_on_same_domain_can_complete_recovery(self):
        b=self.fixture()
        old=self.identity(b)
        self.w.data.update(seen=True,owner=old)
        self.w.mounts.return_value=(None,None)
        self.w.tick()
        self.w.mounts.return_value=("fixture-volume",None)
        self.w.tick()
        self.w.data["stable"]=4
        self.w.status=Mock(return_value=("ready",dict(READY,pid=b.pid)))
        self.w.mount_ready=Mock(return_value=True)
        self.w.tick()
        self.assertFalse(self.w.data["pending"])
        self.assertEqual(len(self.w.generations),1)


if __name__ == "__main__":
    unittest.main()
