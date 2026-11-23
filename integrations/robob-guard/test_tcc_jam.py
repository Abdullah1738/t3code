"""TCC decisions and recovery with synthetic process/launchd inventories only."""
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import guard
import tcc_jam as tcc


def proc(pid=739, path="/opt/homebrew/bin/ollama", ppid=1, uid=501, args=None):
    return dict(pid=pid, comm=path, args=args or path, ppid=ppid, uid=uid,
                lstart="Tue Nov 17 06:30:34 2026")


def candidate(process=None, label="sh.brew.ollama", plist="/Users/ardud/Library/LaunchAgents/sh.brew.ollama.plist"):
    process = process or proc()
    return dict(process=process, chain=[process], owner=process if label else None,
                label=label, plist=plist)


def diagnosis(candidates=None, flood=None, prompting=False):
    return dict(candidates=candidates or [], flood=flood, plists={}, prompting=prompting,
                tccd_identity=proc(432, tcc.TCCD), tccd_pid=432, sample=None,
                prompts=[dict(path="/fixture/asker", pids={})] if prompting else [],
                top_subjects=[], request_rate=200, rate_basis="fixture", log_exit_code=0, logs={})


class LogTests(unittest.TestCase):
    def test_retained_excerpt_unmatched_prompt_subject_and_delta_rate(self):
        text = (Path(__file__).parent / "fixtures/tccd-prompt.txt").read_text()
        result = tcc.parse_log(text, 174)
        self.assertEqual([r["msgID"] for r in result["prompts"]], ["174.226"])
        self.assertEqual(result["prompts"][0]["pids"]["responsible"]["pid"], 25862)
        self.assertEqual(result["prompts"][0]["pids"]["accessing"]["pid"], 27090)
        self.assertEqual(result["top_subjects"][0]["count"], 2)
        self.assertEqual(result["top_subjects"][0]["path"], "/Volumes/ExternalSSD/migrated/hermes/node/bin/node")
        self.assertAlmostEqual(result["request_rate"], 36 / (98 - .434534), places=5)

    def test_dropped_lines_rate_and_other_service_or_pid_excluded(self):
        def row(at, sequence, service="kTCCServiceSystemPolicyRemovableVolumes", pid=174):
            prefix = "2026-11-18 11:10:%s tccd[432] " % at
            key = "%s.%s" % (pid, sequence)
            return (prefix + "AUTHREQ_CTX: msgID=%s, service=%s,\n" % (key, service)
                    + prefix + "AUTHREQ_SUBJECT: msgID=%s, subject=/opt/homebrew/bin/ollama,\n" % key)
        result = tcc.parse_log(row("00", 100) + row("10", 2400)
                               + row("20", 9000, "kTCCServiceCamera") + row("30", 9900, pid=999), 174)
        self.assertEqual(result["request_rate"], 230)
        self.assertEqual(result["top_subjects"][0]["rate"], 230)
        self.assertEqual(result["top_subjects"][0]["count"], 2)
        self.assertEqual(result["top_subjects"][0]["observed_rate"], 2 / 60)

    def test_timestamp_input_class(self):
        cases = [("2026-11-18 11:10:00+0400", True), ("2026-11-18 11:10:00+04:00", True),
                 ("2026-11-18 07:10:00Z", True), ("2026-11-18 11:10:00.123456+0400", True),
                 ("2026-11-18 11:10:00", True), ("2026-99-18 11:10:00", False), ("no timestamp", False)]
        for timestamp, valid in cases:
            line = timestamp + " tccd[432] AUTHREQ_PROMPTING: msgID=174.226, service=kTCCServiceSystemPolicyRemovableVolumes, subject=Sub:{/opt/node},"
            with self.subTest(timestamp=timestamp):
                prompts = tcc.parse_log(line, 174)["prompts"]
                self.assertEqual("time" in prompts[0], valid)

    def test_result_clears_prompt_even_when_log_order_reversed(self):
        text = (Path(__file__).parent / "fixtures/tccd-prompt.txt").read_text()
        text = "AUTHREQ_RESULT: msgID=174.226, authValue=2,\n" + text
        self.assertEqual(tcc.parse_log(text, 174)["prompts"], [])


class TickTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.state = {}
        self.save = Mock()
        self.notify = Mock(return_value=True)

    def tick(self, count, now, diag=None):
        with patch.object(tcc, "inventory", return_value=(174, count)), \
                patch.object(tcc, "diagnose", return_value=diag or diagnosis()) as diagnose:
            tcc.tick(self.home, self.state, now, self.save, self.notify)
        return diagnose

    def rows(self):
        return [json.loads(line) for line in (self.home / ".local/state/robob-guard/tcc-jam.ndjson").read_text().splitlines()]

    def test_two_high_ticks_and_hysteresis_and_all_clear_notify_once(self):
        self.tick(84, 10000).assert_not_called()
        self.tick(84, 10030).assert_called_once()
        self.assertEqual(self.state["tcc_jam"]["mode"], "jammed")
        self.tick(65, 10060).assert_called_once()
        self.tick(84, 10090)
        self.assertEqual(self.notify.call_count, 1)
        self.tick(5, 10120)
        self.tick(5, 10150)
        self.assertEqual(self.notify.call_count, 2)
        self.assertIn("all-clear", self.notify.call_args.args[2]["text"])
        self.assertTrue(all("text" in r and "exit_code" in r for r in self.rows() if r.get("event") == "notify"))

    def test_unknown_inventory_captures_evidence_without_any_recovery(self):
        with patch.object(tcc, "unknown_evidence", return_value={"logs": "captured"}) as evidence, \
                patch.object(tcc, "safe_action") as action, patch.object(tcc, "recover") as recover:
            self.tick(None, 10000).assert_not_called()
            self.tick(None, 10030).assert_not_called()
            self.tick(None, 10060).assert_not_called()
            self.assertEqual(evidence.call_count, 2)
            self.assertEqual(self.notify.call_count, 1)
            self.assertTrue(self.notify.call_args.args[1].startswith("ssd-stall:"))
            action.assert_not_called()
            recover.assert_not_called()
        self.assertEqual(self.rows()[-1]["state"], "unknown_stall")
        self.assertEqual(self.rows()[-1]["action"], [])

    def test_gap_breaks_streak(self):
        self.tick(84, 10000)
        self.tick(84, 10200).assert_not_called()
        self.tick(84, 10230).assert_called_once()

    def test_missing_tick_breaks_known_high_streak(self):
        self.tick(84, 10000)
        self.tick(None, 10030)
        self.tick(84, 10060).assert_not_called()

    def test_two_null_counts_even_if_pgrep_only_succeeds_once(self):
        with patch.object(tcc, "inventory", side_effect=[(None, None), (174, None)]), \
                patch.object(tcc, "unknown_evidence", return_value={}):
            for now in (10000, 10030):
                tcc.tick(self.home, self.state, now, self.save, self.notify)
        self.assertEqual(self.state["tcc_jam"]["mode"], "unknown_stall")

    def test_healthy_path_only_pgrep_and_thread_count(self):
        threads = (Path(__file__).parent / "fixtures/sandboxd-threads.txt").read_text()
        outputs = [dict(exit_code=0, stdout="174\n"), dict(exit_code=0, stdout=threads)]
        with patch.object(tcc, "run", side_effect=outputs) as run:
            tcc.tick(self.home, {}, 10000, self.save, self.notify)
        self.assertEqual([c.args[0] for c in run.call_args_list], [
            ["/usr/bin/pgrep", "-x", "sandboxd"], ["/bin/ps", "-M", "-p", "174"]])
        self.notify.assert_not_called()
        self.assertEqual(self.state, {})

    def test_unknown_evidence_commands_bounded_and_u_filtered(self):
        root = self.home / ".local/state/mac-upkeep"
        root.mkdir(parents=True)
        (root / "ssd-read-probe.json").write_text(json.dumps(dict(child=dict(pid=999))))
        def run(command, timeout):
            self.assertLessEqual(timeout, 20)
            return dict(exit_code=0, stdout=" 10 1 U 01:00 /usr/bin/foo\n 11 1 S 01:00 /usr/bin/bar", argv=command)
        with patch.object(tcc, "run", side_effect=run) as calls:
            result = tcc.unknown_evidence(self.home, 174)
        self.assertEqual(len(calls.call_args_list), 4)
        self.assertIn("probe_sample", result)
        self.assertIn("10 1 U", result["u_processes"]["stdout"])
        self.assertNotIn("11 1 S", result["u_processes"]["stdout"])

    def test_stop_lease_resumes_after_clear(self):
        self.state["tcc_jam"] = dict(stopped=dict(candidate(), deadline=10000), start="incident")
        with patch.object(tcc, "safe_action", return_value=dict(ok=True)) as action, patch.object(tcc, "identity", return_value=proc()):
            self.tick(5, 10030)
        self.assertEqual(action.call_args.args[2], "SIGCONT")
        self.assertNotIn("stopped", self.state["tcc_jam"])

    def test_stop_lease_retained_when_identity_read_unavailable(self):
        self.state["tcc_jam"] = dict(stopped=dict(candidate(), deadline=10000), start="incident")
        with patch.object(tcc, "safe_action", return_value=dict(ok=False)), \
                patch.object(tcc, "identity", return_value=None), patch.object(tcc, "run", return_value=dict(exit_code=None)):
            self.tick(5, 10030)
        self.assertIn("stopped", self.state["tcc_jam"])

    def test_failed_resume_preserves_reparented_lease_but_discards_reused_identity(self):
        expected = proc(ppid=39010)
        cases = [(dict(expected, ppid=1), True), (dict(expected, lstart="another birth"), False),
                 (dict(expected, args="different argv"), False), (dict(expected, uid=0), False)]
        for current, retained in cases:
            with self.subTest(current=current), patch.object(tcc, "safe_action", return_value=dict(ok=False)), \
                    patch.object(tcc, "identity", return_value=current):
                self.state["tcc_jam"] = dict(stopped=dict(candidate(expected), label_removed=True, deadline=10000), start="incident")
                self.tick(5, 10030)
                self.assertEqual("stopped" in self.state["tcc_jam"], retained)

    def test_replayed_flood_records_do_not_satisfy_consecutive_progress(self):
        flood = candidate()
        diag = diagnosis([flood], flood=flood)
        with patch.object(tcc, "safe_action", return_value=dict(ok=True, action="SIGSTOP")) as action:
            self.tick(84, 10000, diag)
            for sequence, now in ((100, 10030), (100, 10060), (101, 10090)):
                diag["flood_sequence"] = sequence
                self.tick(84, now, diag)
                action.assert_not_called()
            diag["flood_sequence"] = 102
            self.tick(84, 10120, diag)
            self.assertEqual(action.call_args.args[2], "SIGSTOP")

    def test_unconfirmed_stop_intent_not_resumed_and_notifies_once(self):
        self.state["tcc_jam"] = dict(stopped=dict(candidate(), phase="pending", deadline=10000), start="incident")
        with patch.object(tcc, "safe_action") as action:
            self.tick(5, 10030)
            self.tick(5, 10060)
            action.assert_not_called()
        self.assertEqual(self.notify.call_count, 1)
        self.assertIn("unconfirmed STOP", self.notify.call_args.args[2]["text"])


class SafetyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        jobs = patch.object(tcc, "jobs", return_value={739: "sh.brew.ollama"})
        jobs.start()
        self.addCleanup(jobs.stop)

    def test_every_mutation_refuses_protected_targets(self):
        rows = [proc(174, "/usr/libexec/sandboxd", uid=0), proc(179, tcc.TCCD, uid=0),
                proc(77, "/Applications/Robob.app/Contents/MacOS/Robob"),
                proc(78, "/Volumes/ExternalSSD/opencode2/current/bin/opencode"),
                proc(79, "/Applications/Dia.app/Contents/MacOS/Dia"),
                proc(80, "/usr/bin/node", args="node apps/server/dist/bin.mjs"),
                proc(81, "/usr/bin/node", args="node /opt/service/opencode/server.mjs"),
                proc(82, "/usr/bin/codex"), proc(83, "/usr/libexec/userdaemon")]
        for process in rows:
            for action in ("SIGSTOP", "SIGKILL", "SIGCONT", "remove", "bootout"):
                with self.subTest(process=process, action=action), patch.object(tcc, "identity", return_value=process), \
                        patch.object(tcc, "ancestry", return_value=[process]), \
                        patch.object(tcc.os, "kill") as kill, patch.object(tcc, "run") as run:
                    result = tcc.safe_action(self.home, candidate(process), action, 10000, "test")
                    self.assertFalse(result["ok"])
                    kill.assert_not_called()
                    run.assert_not_called()

    def test_provider_child_protected_by_ancestry_and_unknown_ancestry(self):
        child = proc(ppid=77)
        parent = proc(77, "/Applications/Robob.app/Contents/MacOS/Robob")
        for chain in ([child, parent], None):
            with patch.object(tcc, "identity", return_value=child), patch.object(tcc, "ancestry", return_value=chain), patch.object(tcc.os, "kill") as kill:
                self.assertFalse(tcc.safe_action(self.home, candidate(child), "SIGKILL", 10000, "test")["ok"])
                kill.assert_not_called()

    def test_protected_launchd_label_refused_even_for_generic_interpreter(self):
        for label in tcc.DENIED_LABELS:
            with self.subTest(label=label), patch.object(tcc.os, "kill") as kill:
                result = tcc.safe_action(self.home, candidate(proc(path="/bin/zsh"), label), "remove", 10000, "test")
                self.assertFalse(result["ok"])
                kill.assert_not_called()

    def test_system_interpreter_job_scope_distinct_from_os_services(self):
        rows = [("/bin/zsh", "/bin/zsh /Users/ardud/.robob/board-artifacts/relaunch.zsh", 501, True),
                ("/bin/bash", "/bin/bash /var/folders/xx/long/T/tmp.abc/probe", 501, True),
                ("/usr/bin/python3", "/usr/bin/python3 /var/folders/xx/long/T/tmp.abc/probe", 501, True),
                ("/usr/bin/python3", "/usr/bin/python3 /var/folders/xx/long/T/tmp.abc/probe", 0, False),
                ("/usr/libexec/sandboxd", "/usr/libexec/sandboxd", 501, False),
                ("/System/Library/CoreServices/service", "/System/Library/CoreServices/service", 501, False)]
        for path, argv, uid, eligible in rows:
            process = proc(path=path, args=argv, uid=uid)
            with self.subTest(path=path, uid=uid):
                self.assertEqual(tcc.denied([process]) is None and tcc.leftover(candidate(process), {}), eligible)

    def test_recycled_pid_or_changed_argv_refused_including_after_journal(self):
        expected = proc()
        for changed in (dict(expected, lstart="different"), dict(expected, args="other program")):
            for identities in ([changed], [expected, expected, changed]):
                with self.subTest(identities=identities), patch.object(tcc, "identity", side_effect=identities), \
                        patch.object(tcc, "ancestry", return_value=[expected]), patch.object(tcc.os, "kill") as kill:
                    self.assertFalse(tcc.safe_action(self.home, candidate(expected), "SIGKILL", 10000, "test")["ok"])
                    kill.assert_not_called()

    def test_launchd_mapping_rechecked_for_remove_and_bootout(self):
        expected = proc()
        for action in ("remove", "bootout"):
            with patch.object(tcc, "identity", return_value=expected), patch.object(tcc, "ancestry", return_value=[expected]), \
                    patch.object(tcc, "jobs", side_effect=[{739: "sh.brew.ollama"}, {739: "other"}]), patch.object(tcc, "run") as run:
                self.assertFalse(tcc.safe_action(self.home, candidate(), action, 10000, "test")["ok"])
                run.assert_not_called()

    def test_all_signals_refresh_launchd_ownership_before_and_after_journal(self):
        expected = proc()
        cases = [(None, "unavailable"), ({739: "other"}, "changed"),
                 ({739: "com.ardud.opencode-service"}, "protected")]
        for action in ("SIGSTOP", "SIGKILL", "SIGCONT"):
            for mapping, name in cases:
                for after_journal in (False, True):
                    with self.subTest(action=action, case=name, after_journal=after_journal), \
                            patch.object(tcc, "identity", return_value=expected), \
                            patch.object(tcc, "ancestry", return_value=[expected]), \
                            patch.object(tcc, "jobs", side_effect=([{739: "sh.brew.ollama"}, mapping] if after_journal else [mapping])), \
                            patch.object(tcc.os, "kill") as kill:
                        self.assertFalse(tcc.safe_action(self.home, candidate(), action, 10000, "test")["ok"])
                        kill.assert_not_called()

    def test_stale_attribution_rejects_same_interpreter_pid_reuse(self):
        process = proc(path="/opt/homebrew/bin/node")
        birth = time.mktime(time.strptime(process["lstart"], "%a %b %d %H:%M:%S %Y"))
        for request_time, allowed in [(birth - 60, False), (None, False), ("invalid", False), (birth + 10, True)]:
            with self.subTest(time=request_time), patch.object(tcc, "identity", return_value=process), \
                    patch.object(tcc, "ancestry", return_value=[process]):
                selected = tcc.target(process["pid"], process["comm"], {739: "job"}, {}, request_time)
                self.assertEqual(selected is not None, allowed)

    def test_label_removed_allows_only_same_survivor_and_no_new_owner(self):
        process = proc()
        removed = dict(candidate(process), label_removed=True)
        for mapping, allowed in [({}, True), ({739: "replacement"}, False), ({999: "sh.brew.ollama"}, False)]:
            with self.subTest(mapping=mapping), patch.object(tcc, "identity", return_value=process), \
                    patch.object(tcc, "ancestry", return_value=[process]), patch.object(tcc, "jobs", return_value=mapping):
                self.assertEqual(tcc.action_refusal(removed, "SIGKILL", False) is None, allowed)

    def test_signal_audits_identity_and_stop_undo_before_signal(self):
        expected = proc()
        def kill(pid, sig):
            rows = [json.loads(r) for r in (self.home / tcc.ARTIFACT).read_text().splitlines()]
            self.assertEqual(rows[0]["identity"], expected)
            self.assertEqual(rows[0]["deadline"], 10060)
            self.assertIn("kill -CONT", rows[0]["undo"])
        with patch.object(tcc, "identity", return_value=expected), patch.object(tcc, "ancestry", return_value=[expected]), \
                patch.object(tcc.os, "kill", side_effect=kill), patch.object(tcc, "run", return_value=dict(exit_code=0, stdout="T")):
            self.assertTrue(tcc.safe_action(self.home, candidate(), "SIGSTOP", 10000, "test")["ok"])
        rows = [json.loads(r) for r in (self.home / tcc.ARTIFACT).read_text().splitlines()]
        self.assertTrue(rows[-1]["result"]["stopped"])


class LadderTests(unittest.TestCase):
    def setUp(self):
        self.state = dict(flood_ticks=2, prompt_ticks=2)
        self.home = Path("/synthetic")
        self.save = Mock()
        self.action_patch = patch.object(tcc, "safe_action", side_effect=lambda h, c, a, *args, **kw: dict(action=a, ok=True))
        self.action = self.action_patch.start()
        self.addCleanup(self.action_patch.stop)

    def recover(self, diag, now=10000):
        return tcc.recover(self.home, self.state, diag, now, self.save)

    def test_leftover_before_flood_or_tccd_remove_then_kill(self):
        leftover = candidate(proc(39010, "/bin/zsh", args="/bin/zsh /Users/ardud/.robob/board-artifacts/relaunch.zsh"), label="com.ardud.relaunch", plist=None)
        actions, why = self.recover(diagnosis([leftover], flood=leftover, prompting=True))
        self.assertEqual([a["action"] for a in actions], ["remove", "SIGKILL"])

    def test_leftover_forms(self):
        rows = [(candidate(proc(path="/bin/zsh"), "com.ardud.probe", None), {}, True),
                (candidate(proc(path="/bin/zsh"), "mac.ssdprobe.123", None), {}, True),
                (candidate(proc(path="/bin/zsh"), "com.ardud.installed"), {"com.ardud.installed": "plist"}, False),
                (candidate(proc(path="/bin/zsh", args="/bin/zsh /var/folders/xx/long/T/tmp.abc/probe")), {}, True),
                (candidate(proc(path="/Users/ardud/.nvm/versions/node/v24/bin/node")), {}, True),
                (candidate(proc(path="/bin/zsh")), {}, False),
                (candidate(proc(path="/bin/zsh"), "com.ardud.probe"), None, False)]
        for item, plists, expected in rows:
            with self.subTest(item=item, plists=plists):
                self.assertEqual(tcc.leftover(item, plists), expected)

    def test_flood_two_ticks_stop_then_unload_kill_and_no_tccd(self):
        flood = candidate()
        self.state["flood_ticks"] = 1
        self.assertEqual(self.recover(diagnosis([flood], flood=flood))[0], [])
        self.state["flood_ticks"] = 2
        self.assertEqual([a["action"] for a in self.recover(diagnosis([flood], flood=flood))[0]], ["SIGSTOP"])
        self.save.assert_called()
        self.assertEqual([a["action"] for a in self.recover(diagnosis([flood], flood=flood), 10030)[0]], ["bootout", "SIGKILL"])

    def test_refused_stop_cancels_intent_and_cannot_authorize_cont(self):
        def refused(home, item, action, *args, **kwargs):
            self.assertEqual(self.state["stopped"]["phase"], "pending")
            return dict(action=action, ok=False, why="ownership unavailable")
        self.action.side_effect = refused
        flood = candidate()
        self.recover(diagnosis([flood], flood=flood))
        self.assertNotIn("stopped", self.state)
        with tempfile.TemporaryDirectory() as directory, patch.object(tcc, "inventory", return_value=(174, 5)):
            tcc.tick(Path(directory), dict(tcc_jam=self.state), 10100, Mock(), Mock())
        self.assertEqual(self.action.call_count, 1)

    def test_incomplete_log_inventory_prevents_recovery(self):
        flood = candidate()
        diag = diagnosis([flood], flood=flood, prompting=True)
        diag["log_exit_code"] = None
        self.assertEqual(self.recover(diag)[0], [])
        self.action.assert_not_called()

    def test_second_flooder_cannot_overwrite_a_suspension_lease(self):
        self.state["stopped"] = dict(candidate(proc(900)), deadline=10060)
        flood = candidate()
        self.assertEqual(self.recover(diagnosis([flood], flood=flood))[0], [])
        self.assertEqual(self.state["stopped"]["process"]["pid"], 900)

    def test_leftover_parent_program_and_launchd_owner_identification(self):
        child = proc(27090, "/opt/node/bin/node", ppid=39010)
        parent = proc(39010, "/bin/zsh", args="/bin/zsh /var/folders/xx/long/T/tmp.abc/relaunch.zsh")
        with patch.object(tcc, "identity", return_value=child), patch.object(tcc, "ancestry", return_value=[child, parent]):
            item = tcc.target(child["pid"], child["comm"], {39010: "com.ardud.relaunch"}, {}, time.time())
        self.assertEqual(item["label"], "com.ardud.relaunch")
        self.assertEqual(item["owner"], parent)
        self.assertTrue(tcc.leftover(item, {}))

    def test_tccd_off_by_default_and_hourly_limit_persisted_before_signal(self):
        diag = diagnosis(prompting=True)
        with patch.dict(os.environ, {}, clear=True):
            actions, why = self.recover(diag)
            self.assertEqual(actions, [])
            self.assertIn("off", why)
        with patch.dict(os.environ, {"TCC_AUTO_RESTART": "1"}):
            self.assertEqual(self.recover(diag)[0][0]["action"], "SIGKILL")
            self.assertEqual(self.state["last_tccd_restart"], 10000)
            self.assertEqual(self.recover(diag, 13599)[0], [])
            self.assertEqual(self.recover(diag, 13600)[0][0]["action"], "SIGKILL")

    def test_tccd_requires_two_samples_and_exact_user_identity_and_asker_removed(self):
        with patch.dict(os.environ, {"TCC_AUTO_RESTART": "1"}):
            self.state["prompt_ticks"] = 1
            self.assertEqual(self.recover(diagnosis(prompting=True))[0], [])
            self.state["prompt_ticks"] = 2
            for process in (proc(179, tcc.TCCD, uid=0), proc(432, "/usr/bin/tccd"), None):
                diag = diagnosis(prompting=True)
                diag["tccd_identity"] = process
                self.assertEqual(self.recover(diag)[0], [])
            self.assertEqual(self.recover(diagnosis([candidate()], prompting=True))[0], [])
            diag = diagnosis(prompting=True)
            diag["asker_unverified"] = True
            self.assertEqual(self.recover(diag)[0], [])


class CaptureTests(unittest.TestCase):
    end = datetime.datetime.fromisoformat("2026-11-18T12:00:00+00:00").timestamp()

    def log(self, count=3500, stride=1, drop=None, mixed=None, span=59, age=0, offsets=None):
        base = (Path(__file__).parent / "fixtures/tccd-prompt.txt").read_text().splitlines()[:4]
        lines = []
        for index, sequence in enumerate(range(0, count, stride)):
            moment = self.end + offsets[index] if offsets is not None else self.end - age - span + sequence * span / count
            timestamp = datetime.datetime.fromtimestamp(moment,
                                                       datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f%z")
            for line in base:
                if drop and index % 5 == 0 and drop in line:
                    continue
                line = line.split(" ", 2)[2].replace("174.190", "174.%s" % sequence)
                line = line.replace("/Volumes/ExternalSSD/migrated/hermes/node/bin/node", "/opt/homebrew/bin/ollama")
                line = line.replace("pid=13183", "pid=739")
                if mixed and index % 2:
                    if mixed == "service":
                        line = line.replace("kTCCServiceSystemPolicyRemovableVolumes", "kTCCServiceCamera")
                    elif mixed == "subject":
                        line = line.replace("/opt/homebrew/bin/ollama", "/opt/another")
                    elif mixed == "tccd":
                        line = line.replace("tccd[432]", "tccd[999]")
                    else:
                        line = line.replace("pid=739", "pid=740")
                lines.append(timestamp + " " + line + "\n")
        return "".join(lines).encode()

    def diagnose(self, raw, code=0):
        class Child:
            def __init__(self, argv, **kwargs):
                kwargs["stdout"].write(raw if argv == tcc.LOG_COMMAND else b"432" if "pgrep" in argv[0] else b"")

            def wait(self, timeout):
                if code is None:
                    raise subprocess.TimeoutExpired("fixture", timeout)
                return code

            def kill(self):
                pass

        with patch.object(tcc.subprocess, "Popen", Child), \
                patch.object(tcc, "identity", side_effect=lambda pid: proc(432, tcc.TCCD) if pid == 432 else proc(pid)), \
                patch.object(tcc, "ancestry", side_effect=lambda p: [p]), \
                patch.object(tcc, "jobs", return_value={739: "sh.brew.ollama"}), \
                patch.object(tcc, "installed", return_value={"sh.brew.ollama": "/fixture/ollama.plist"}):
            return tcc.diagnose(Path("/synthetic"), 174, now=self.end)

    def test_complete_floods_beyond_raw_excerpt_select_stop_through_real_capture(self):
        for count in (3500, 13800):
            with self.subTest(requests=count):
                raw = self.log(count=count)
                self.assertGreater(len(raw), tcc.LOG_EXCERPT_BYTES)
                diag = self.diagnose(raw)
                self.assertTrue(diag["logs"]["stdout_truncated"])
                self.assertEqual(diag["logs"]["analysis_bytes"], len(raw))
                self.assertTrue(diag["logs"]["analysis_complete"])
                self.assertLessEqual(len(diag["logs"]["stdout"].encode()), tcc.LOG_EXCERPT_BYTES)
                self.assertEqual(diag["log_exit_code"], 0)
                self.assertEqual(diag["top_subjects"][0]["count"], count)
                self.assertEqual(diag["flood"]["process"]["pid"], 739)
                state = dict(flood_ticks=2, prompt_ticks=0)
                with patch.object(tcc, "safe_action", return_value={"ok": True}) as action:
                    tcc.recover(Path("/synthetic"), state, diag, self.end, Mock())
                self.assertEqual(action.call_args.args[2], "SIGSTOP")

    def test_dropped_request_and_line_input_class(self):
        # Whole-request drops and missing individual event forms must not turn
        # sustained, unambiguous counter progress into a low observed rate.
        for missing in (None, "AUTHREQ_CTX", "AUTHREQ_SUBJECT", "AUTHREQ_ATTRIBUTION", "AUTHREQ_RESULT"):
            with self.subTest(missing=missing):
                diag = self.diagnose(self.log(count=13800, stride=10, drop=missing))
                top = diag["top_subjects"][0]
                self.assertLess(top["observed_rate"], 50)
                self.assertGreater(top["recovery_rate"], 50)
                self.assertGreaterEqual(top["sequence_coverage_seconds"], 30)
                self.assertEqual(diag["flood"]["process"]["pid"], 739)

    def test_mixed_service_subject_and_pid_break_inferred_flood_attribution(self):
        for mixed in ("service", "subject", "pid", "tccd"):
            with self.subTest(mixed=mixed):
                diag = self.diagnose(self.log(count=13800, stride=10, mixed=mixed))
                self.assertIsNone(diag["flood"])
                self.assertLess(diag["top_subjects"][0]["recovery_rate"], 50)

    def test_sparse_counter_endpoints_and_short_or_aged_bursts_do_not_infer_a_flood(self):
        forms = (dict(count=13800, stride=13799), dict(count=13800, stride=10, span=.01),
                 dict(count=13800, stride=10, age=40))
        for form in forms:
            with self.subTest(form=form):
                diag = self.diagnose(self.log(**form))
                self.assertIsNone(diag["flood"])
                self.assertLess(diag["top_subjects"][0]["recovery_rate"], 50)

    def test_unknown_attribution_records_break_counter_intervals(self):
        raw = self.log(count=13800, stride=10).decode()
        lines = []
        for line in raw.splitlines():
            lines.append(line)
            if "AUTHREQ_RESULT" in line:
                sequence = int(line.split("msgID=174.", 1)[1].split(",", 1)[0]) + 1
                lines.append(line.split(" tccd[", 1)[0] + " tccd[432] REQUEST: msgID=174.%s" % sequence)
        diag = self.diagnose("\n".join(lines).encode())
        self.assertIsNone(diag["flood"])
        self.assertEqual(diag["top_subjects"][0]["sequence_rate"], 0)

    def test_timestamp_interval_input_class_counts_wall_time_once(self):
        cases = (("repeated", [-20, -16] * 8 + [-20], 4, False),
                 ("nested", [-20, -16, -19, -17] * 8 + [-20], 4, False),
                 ("overlapping", [t for i in range(9) for t in (-40 + 2 * i, -36 + 2 * i)], 20, False),
                 ("touching", list(range(-40, -7, 4)), 32, True))
        for name, offsets, coverage, flood in cases:
            for extra_request in (False, True):
                times = offsets + [offsets[-1]] if extra_request else offsets
                with self.subTest(form=name, new_progress=extra_request):
                    diag = self.diagnose(self.log(count=len(times) * 1000, stride=1000, offsets=times))
                    top = diag["top_subjects"][0]
                    self.assertEqual(top["sequence_coverage_seconds"], coverage)
                    self.assertEqual(diag["flood"] is not None, flood)
                    if not flood:
                        with patch.object(tcc, "safe_action") as action:
                            self.assertEqual(tcc.recover(Path("/synthetic"), dict(flood_ticks=2, prompt_ticks=0),
                                                         diag, self.end, Mock())[0], [])
                        action.assert_not_called()

    def test_partial_analysis_or_failed_capture_cannot_authorize_recovery(self):
        raw = self.log()
        for limit, value in (("LOG_ANALYSIS_BYTES", 1024), ("LOG_REQUEST_LIMIT", 3), ("LOG_LINE_BYTES", 80)):
            with self.subTest(limit=limit), patch.object(tcc, limit, value):
                diag = self.diagnose(raw)
                self.assertFalse(diag["logs"]["analysis_complete"])
                self.assertIsNone(diag["log_exit_code"])
                with patch.object(tcc, "safe_action") as action:
                    self.assertEqual(tcc.recover(Path("/synthetic"), dict(flood_ticks=2), diag, self.end, Mock())[0], [])
                action.assert_not_called()
        for code in (None, 1):
            with self.subTest(exit_code=code):
                diag = self.diagnose(raw, code=code)
                with patch.object(tcc, "safe_action") as action:
                    self.assertEqual(tcc.recover(Path("/synthetic"), dict(flood_ticks=2), diag, self.end, Mock())[0], [])
                action.assert_not_called()

    def test_analysis_deadline_is_separate_from_subprocess_timeout(self):
        raw = self.log(count=3)
        with patch.object(tcc.time, "monotonic", side_effect=[0, 6]):
            diag = self.diagnose(raw)
        self.assertFalse(diag["logs"]["analysis_complete"])
        self.assertIsNone(diag["log_exit_code"])


class ProcessTests(unittest.TestCase):
    def test_partial_prompt_records_keep_cached_accessing_and_responsible_roles(self):
        text = (Path(__file__).parent / "fixtures/tccd-prompt.txt").read_text()
        pending = tcc.parse_log(text, 174)["prompts"]
        forms = {"prompt-only": "AUTHREQ_PROMPTING", "attribution-only": "AUTHREQ_ATTRIBUTION",
                 "subject-only": "AUTHREQ_SUBJECT", "full": "", "empty": "not-present"}
        for name, marker in forms.items():
            partial = "\n".join(line for line in text.splitlines() if "174.226" in line and marker in line)
            def identity(pid):
                return proc(432, tcc.TCCD) if pid == 432 else None if pid == 25862 else proc(pid, pending[0]["path"])
            def run(argv, timeout, **kwargs):
                stdout = partial if argv[0] == "/usr/bin/log" else "432" if "pgrep" in argv[0] else "CFUserNotificationReceiveResponse" if "sample" in argv[0] else ""
                return dict(exit_code=1 if argv[:2] == ["/bin/ps", "-p"] else 0, stdout=stdout, stderr="")
            with self.subTest(form=name), patch.object(tcc, "run", side_effect=run), \
                    patch.object(tcc, "identity", side_effect=identity), patch.object(tcc, "ancestry", side_effect=lambda p: [p]), \
                    patch.object(tcc, "jobs", return_value={}), patch.object(tcc, "installed", return_value={}):
                diag = tcc.diagnose(Path("/synthetic"), 174, pending)
                self.assertEqual(set(diag["prompts"][0]["pids"]), {"accessing", "responsible"})
                self.assertEqual([c["process"]["pid"] for c in diag["candidates"]], [27090])

    def test_later_attribution_only_record_adds_missing_accessing_role(self):
        text = (Path(__file__).parent / "fixtures/tccd-prompt.txt").read_text()
        prompt_line = next(line for line in text.splitlines() if "AUTHREQ_PROMPTING" in line)
        attribution = next(line for line in text.splitlines() if "AUTHREQ_ATTRIBUTION" in line and "174.226" in line)
        pending = tcc.parse_log(prompt_line, 174)["prompts"]
        self.assertEqual(set(pending[0]["pids"]), {"responsible"})
        def run(argv, timeout, **kwargs):
            stdout = attribution if argv[0] == "/usr/bin/log" else "432" if "pgrep" in argv[0] else ""
            return dict(exit_code=0, stdout=stdout, stderr="")
        with patch.object(tcc, "run", side_effect=run), patch.object(tcc, "identity", return_value=None), \
                patch.object(tcc, "jobs", return_value={}), patch.object(tcc, "installed", return_value={}):
            diag = tcc.diagnose(Path("/synthetic"), 174, pending)
        self.assertEqual(set(diag["prompts"][0]["pids"]), {"accessing", "responsible"})

    def test_historical_millisecond_burst_has_low_rate_over_full_window(self):
        text = ""
        for fraction, sequence in (("000000", 100), ("010000", 101)):
            prefix = "2026-11-18 07:10:00.%sZ tccd[432] " % fraction
            text += (prefix + "AUTHREQ_CTX: msgID=174.%s, service=kTCCServiceSystemPolicyRemovableVolumes,\n" % sequence
                     + prefix + "AUTHREQ_SUBJECT: msgID=174.%s, subject=/opt/ollama,\n" % sequence)
        end = datetime.datetime.fromisoformat("2026-11-18T07:10:50+00:00").timestamp()
        for window_end in (end, end + 30):
            with self.subTest(window_end=window_end):
                top = tcc.parse_log(text, 174, window_end=window_end)["top_subjects"][0]
                self.assertLess(top["observed_rate"], 50)

    def test_sustained_observed_subject_rate_selects_verified_flooder(self):
        end = datetime.datetime.fromisoformat("2026-11-18T07:10:50+00:00").timestamp()
        lines = []
        for index in range(3010):
            timestamp = datetime.datetime.fromtimestamp(end - 58 + index * .019, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f%z")
            prefix = timestamp + " tccd[432] "
            lines += [prefix + "AUTHREQ_CTX: msgID=174.%s, service=kTCCServiceSystemPolicyRemovableVolumes," % index,
                      prefix + "AUTHREQ_SUBJECT: msgID=174.%s, subject=/opt/homebrew/bin/ollama," % index]
        lines.append(prefix + "AUTHREQ_ATTRIBUTION: msgID=174.3009, attribution={accessing={pid=739, binary_path=/opt/homebrew/bin/ollama},},")
        text = "\n".join(lines)
        def run(argv, timeout, **kwargs):
            stdout = text if argv[0] == "/usr/bin/log" else "432" if "pgrep" in argv[0] else ""
            return dict(exit_code=0, stdout=stdout, stderr="", stdout_truncated=False)
        with patch.object(tcc, "run", side_effect=run), \
                patch.object(tcc, "identity", side_effect=lambda pid: proc(432, tcc.TCCD) if pid == 432 else proc(pid)), \
                patch.object(tcc, "ancestry", side_effect=lambda p: [p]), patch.object(tcc, "jobs", return_value={739: "sh.brew.ollama"}), \
                patch.object(tcc, "installed", return_value={"sh.brew.ollama": "/fixture/ollama.plist"}):
            diag = tcc.diagnose(Path("/synthetic"), 174, now=end)
        self.assertGreater(diag["top_subjects"][0]["observed_rate"], 50)
        self.assertEqual(diag["flood"]["process"]["pid"], 739)
        self.assertEqual(diag["flood_sequence"], 3009)

    def test_corrupt_backend_state_preserves_tcc_cooldown_and_stop_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            journal = dict(last_tccd_restart=10000, stopped=dict(candidate(), deadline=10060))
            for corruption in (dict(down_count="bad"), dict(history=["bad"]), dict(pending_alerts=[])):
                with self.subTest(corruption=corruption):
                    guard.atomic_json(path, dict(guard.initial_state(), tcc_jam=journal, **corruption))
                    self.assertEqual(guard.read_state(path)["tcc_jam"], journal)

    def test_malformed_lease_and_attribution_fail_closed_without_crashing(self):
        rows = [dict(stopped={"deadline": 10000}), dict(stopped="bad"),
                dict(stopped=dict(candidate(), deadline="bad")),
                dict(pending_prompts=[{"pids": {"accessing": 12}}]),
                dict(last_tccd_restart="bad")]
        for state in rows:
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory, \
                    patch.object(tcc, "inventory", return_value=(174, 5)), patch.object(tcc, "safe_action") as action:
                raw = dict(tcc_jam=state)
                tcc.tick(Path(directory), raw, 10000, Mock(), Mock())
                self.assertIn("restart_disabled", raw["tcc_jam"])
                action.assert_not_called()

    def test_aged_out_prompt_attribution_kept_and_fresh_empty_log_cannot_restart(self):
        text = (Path(__file__).parent / "fixtures/tccd-prompt.txt").read_text()
        pending = tcc.parse_log(text, 174)["prompts"]
        def identity(pid):
            if pid == 432:
                return proc(432, tcc.TCCD)
            return proc(pid, "/opt/homebrew/Cellar/node/26.13.0_2/bin/node")
        def run(argv, timeout, **kwargs):
            stdout = "432" if "pgrep" in argv[0] else "CFUserNotificationReceiveResponse" if "sample" in argv[0] else ""
            return dict(exit_code=0, stdout=stdout, stderr="", stdout_truncated=False)
        with patch.object(tcc, "run", side_effect=run), patch.object(tcc, "identity", side_effect=identity), \
                patch.object(tcc, "ancestry", side_effect=lambda p: [p]), patch.object(tcc, "jobs", return_value={}), \
                patch.object(tcc, "installed", return_value={}):
            diag = tcc.diagnose(Path("/synthetic"), 174, pending)
            self.assertEqual(diag["prompts"], pending)
            self.assertEqual(len(diag["candidates"]), 2)
            empty = tcc.diagnose(Path("/synthetic"), 174)
            self.assertEqual(empty["prompts"], [])
            with patch.dict(os.environ, {"TCC_AUTO_RESTART": "1"}), patch.object(tcc, "safe_action") as action:
                actions, why = tcc.recover(Path("/synthetic"), dict(prompt_ticks=2, flood_ticks=0), empty, 10000, Mock())
                self.assertEqual(actions, [])
                self.assertIn("missing prompt history", why)
                action.assert_not_called()

    def test_raw_log_receipt_kept_and_sparse_subject_not_a_flood(self):
        text = ""
        for second, sequence in (("00", 100), ("10", 2400)):
            text += ("2026-11-18 11:10:%s+0400 tccd[432] AUTHREQ_CTX: msgID=174.%s, service=kTCCServiceSystemPolicyRemovableVolumes,\n" % (second, sequence)
                     + "2026-11-18 11:10:%s+0400 tccd[432] AUTHREQ_SUBJECT: msgID=174.%s, subject=/opt/homebrew/bin/ollama,\n" % (second, sequence))
        def run(argv, timeout, **kwargs):
            stdout = text if argv[0] == "/usr/bin/log" else "432" if "pgrep" in argv[0] else ""
            return dict(exit_code=0, stdout=stdout, stderr="receipt", stdout_truncated=False)
        with patch.object(tcc, "run", side_effect=run), patch.object(tcc, "identity", return_value=None), \
                patch.object(tcc, "jobs", return_value={}), patch.object(tcc, "installed", return_value={}):
            diag = tcc.diagnose(Path("/synthetic"), 174)
        self.assertEqual(diag["request_rate"], 230)
        self.assertIsNone(diag["flood"])
        self.assertEqual(diag["logs"]["stdout"], text)
        self.assertEqual(diag["logs"]["stderr"], "receipt")

    def test_timeout_never_waits_again_for_kernel_stuck_child(self):
        with patch.object(tcc.subprocess, "Popen") as spawn:
            spawn.return_value.wait.side_effect = subprocess.TimeoutExpired("ps", 2)
            result = tcc.run(["/bin/ps"], 2)
        self.assertIsNone(result["exit_code"])
        spawn.return_value.wait.assert_called_once_with(timeout=2)
        spawn.return_value.kill.assert_called_once()

    def test_inventory_null_on_failure_no_log_or_sample(self):
        for results in ([dict(exit_code=None, stdout="")], [dict(exit_code=0, stdout="174"), dict(exit_code=None, stdout="")],
                        [dict(exit_code=0, stdout="174"), dict(exit_code=0, stdout="PID\n999 TID")]):
            with patch.object(tcc, "run", side_effect=results):
                self.assertIsNone(tcc.inventory()[1])

    def test_guard_runs_tcc_tick_despite_backend_error_and_preserves_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            def tick(h, state, now, save, notify):
                state["tcc_jam"] = dict(null_ticks=2, mode="unknown_stall")
                save()
            with patch.object(guard, "tcc_jam_tick", side_effect=tick) as called, \
                    patch.object(guard, "protected_tier_tick"), patch.object(guard, "backend_ready", side_effect=ValueError("fixture")), \
                    patch.object(guard, "backend_ownership", return_value=(None, None, [])), \
                    patch.object(guard, "process_diagnostics", return_value="fixture"):
                guard.check(home)
            called.assert_called_once()
            state = guard.read_state(home / ".local/state/robob-guard/state.json")
            self.assertEqual(state["tcc_jam"]["mode"], "unknown_stall")


if __name__ == "__main__":
    unittest.main()
