import base64
import contextlib
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from http.client import RemoteDisconnected


_spec = importlib.util.spec_from_file_location("ph_retry_under_test", Path(__file__).with_name("ph.py"))
ph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ph)
try:
    from uiautomator2.exceptions import RPCUnknownError
except ImportError:
    # The library exception has no custom formatting; retain its tuple/params repr offbox.
    class RPCUnknownError(Exception): pass

TREE = '<hierarchy><node text="Copy" bounds="[0,0][20,20]" package="dev.test" /></hierarchy>'


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.device = Mock()
        self.device.dump_hierarchy.return_value = TREE
        self.calls = []
        for name, value in [("STATE", Path(self.tmp.name)), ("d", Mock(return_value=self.device)),
                            ("_run", self.adb), ("_d", None), ("caller_chain", lambda: [])]:
            p = patch.object(ph, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(ph.time, "sleep")
        p.start()
        self.addCleanup(p.stop)
        self.guard = patch.object(ph.subprocess, "run", side_effect=AssertionError("No real phone calls"))
        self.guard.start()
        self.addCleanup(self.guard.stop)

    def adb(self, args, t=5, strict=False):
        self.calls.append((args, t))
        if "default_input_method" in args:
            return 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME\n'
        if any("dumpsys window" in arg for arg in args):
            return 'mCurrentFocus=Window{ab12 u0 com.android.systemui/.biometrics.AuthContainerView}\n'
        if "logcat" in args:
            return 'noise\nInputMethod: CVV 123\nAndroidRuntime: ' + getattr(self, "secret", "safe") + '\n'
        return ""

    def cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ph.run(list(args))
        return code, out.getvalue()

    def events(self):
        p = ph.STATE / "events.jsonl"
        return [row for line in p.read_text().splitlines() if (row := json.loads(line))["event"] not in ("action", "unleased_action")] if p.exists() else []

    def test_read_phase_drop_retries_once_with_evidence_before_reset(self):
        self.device.dump_hierarchy.side_effect = [RemoteDisconnected("lost reply"), TREE]
        code, out = self.cli("ui")
        self.assertEqual(code, 0)
        self.assertIn("Copy", out)
        self.assertNotIn("MAYBE_SENT", out)
        self.assertEqual(self.device.dump_hierarchy.call_count, 2)
        row, = self.events()
        self.assertEqual((row["event"], row["phase"], row["attempt"]), ("reconnect", "read", 1))
        self.assertIn("LatinIME", row["ime"])
        self.assertIn("AuthContainerView", row["focused_window"])
        self.assertNotIn("123", Path(row["drop_log"]).read_text())
        commands = [a for a, _ in self.calls]
        self.assertLess(next(i for i, a in enumerate(commands) if "logcat" in a),
                        next(i for i, a in enumerate(commands) if any("pkill" in v for v in a)))
        self.assertTrue(all(0 < t <= 5 for _, t in self.calls))

    def test_connection_failure_before_action_can_retry(self):
        ph.d.side_effect = [RemoteDisconnected("connecting"), self.device]
        self.assertEqual(self.cli("key", "back")[0], 0)
        self.device.press.assert_called_once_with("back")
        self.assertEqual([e["event"] for e in self.events()], ["reconnect"])

    def test_type_drop_is_single_send_and_secret_absent_everywhere(self):
        self.secret = "very-private-input"
        self.device.send_keys.side_effect = RemoteDisconnected("text=" + self.secret)
        code, out = self.cli("type", self.secret, "--clear")
        self.assertEqual(code, 4)
        self.assertIn("MAYBE_SENT: type", out)
        self.device.send_keys.assert_called_once_with(self.secret, clear=True)
        row, = self.events()
        self.assertEqual((row["event"], row["phase"], row["target_kind"]), ("maybe_sent", "action", "text"))
        evidence = out + (ph.STATE / "events.jsonl").read_text() + Path(row["drop_log"]).read_text()
        self.assertNotIn(self.secret, evidence)
        self.assertNotIn(base64.b64encode(self.secret.encode()).decode(), evidence)

    def test_typed_input_forms_are_redacted(self):
        cases = ["private-input", "--private-input", "-private-input", "--clear-extra",
                 "private-line-one\nprivate-line-two", "رمز-خاص"]
        for text in cases:
            with self.subTest(text=text):
                self.secret = text
                self.device.send_keys.reset_mock()
                self.device.send_keys.side_effect = RemoteDisconnected(text)
                code, out = self.cli("type", text, "--clear")
                self.assertEqual(code, 4)
                self.device.send_keys.assert_called_once_with(text, clear=True)
                row = self.events()[-1]
                evidence = out + json.dumps(row, ensure_ascii=False) + Path(row["drop_log"]).read_text()
                for fragment in text.splitlines():
                    self.assertNotIn(fragment, evidence)
                self.assertNotIn(base64.b64encode(text.encode()).decode(), evidence)

    def test_serialized_typed_input_never_leaves_fragments(self):
        inputs = [
            "dummyPRIVATE_SUFFIX",
            "dummy'PRIVATE_SUFFIX",
            'dummy"PRIVATE_SUFFIX',
            "dummy'quoted\"PRIVATE_SUFFIX",
            'dummy"quoted\'PRIVATE_SUFFIX',
            "dummy\\'quoted\"PRIVATE_SUFFIX",
            "dummy\\\\'quoted\"PRIVATE_SUFFIX",
            "dummy\nquoted'\"PRIVATE_SUFFIX",
            "dummy\tquoted'\"PRIVATE_SUFFIX",
            "dummyرمز'\"PRIVATE_SUFFIX",
            'dummy"PRIVATE_SUFFIX\n"',
            "dummy'PRIVATE_SUFFIX\n'",
            'dummy"PRIVATE_SUFFIX\n\\',
            'dummy"PRIVATE_SUFFIX\r\n"',
        ]
        formats = [
            ("python-repr", repr),
            ("json", json.dumps),
            ("json-unicode", lambda value: json.dumps(value, ensure_ascii=False)),
            ("json-nested", lambda value: json.dumps(json.dumps(value))),
            ("json-deep", lambda value: json.dumps(json.dumps(json.dumps(value)))),
            ("json-truncated", lambda value: json.dumps(value)[:-1]),
            ("json-content", lambda value: json.dumps(value)[1:-1]),
        ]
        for text in inputs:
            for name, encode in formats:
                with self.subTest(input=text, format=name):
                    self.device.send_keys.reset_mock()
                    self.device.send_keys.side_effect = RPCUnknownError("RPC failed", [text], "stack")
                    log = "InputMethod: payload=" + encode(text)
                    def adb(args, t=5, strict=False):
                        return log if "logcat" in args else self.adb(args, t, strict)
                    with patch.object(ph, "_run", adb):
                        code, out = self.cli("type", text)
                    self.assertEqual(code, 4)
                    self.device.send_keys.assert_called_once_with(text, clear=False)
                    row = self.events()[-1]
                    self.assertEqual((row["event"], row["exc_type"], row["phase"]),
                                     ("maybe_sent", "RPCUnknownError", "action"))
                    outputs = {"stdout": out, "exception": row["exc_message"],
                               "logcat": Path(row["drop_log"]).read_text(),
                               "events": (ph.STATE / "events.jsonl").read_text()}
                    for name, output in outputs.items():
                        with self.subTest(output=name):
                            self.assertNotIn("PRIVATE_SUFFIX", output)
                            self.assertNotIn(base64.b64encode(text.encode()).decode(), output)

    def test_note_drop_serialized_values_without_private_input_context(self):
        text = "dummy'quoted\"PRIVATE_SUFFIX"
        exc = RPCUnknownError("RPC failed", [text], "stack")
        formats = [repr(text), json.dumps({"params": [text]}),
                   json.dumps(json.dumps({"params": [text]})),
                   json.dumps(text)[:-1]]
        for encoded in formats:
            with self.subTest(encoded=encoded):
                def adb(args, t=5, strict=False):
                    return "InputMethod: " + encoded if "logcat" in args else self.adb(args, t, strict)
                with patch.object(ph, "_run", adb):
                    code, _ = self.cli("note-drop", "--source", "torssh", "--cmd", "type",
                                       "--exc", "RPCUnknownError", "--msg", str(exc))
                self.assertEqual(code, 0)
                row = self.events()[-1]
                self.assertNotIn("PRIVATE_SUFFIX", row["exc_message"])
                self.assertNotIn("PRIVATE_SUFFIX", Path(row["drop_log"]).read_text())
        ph.d.assert_not_called()

    def test_unquoted_diagnostics_keep_failure_context(self):
        with patch.object(ph, "_private_values", ()):
            self.assertEqual(ph.diagnostic("Remote end closed connection without response"),
                             "Remote end closed connection without response")
            self.assertEqual(ph.diagnostic("InputMethod: switching to com.example/.AdbKeyboard"),
                             "InputMethod: switching to com.example/.AdbKeyboard")
            self.assertEqual(ph.diagnostic("InputMethod: text=private-input"),
                             "InputMethod: text=[redacted]")

    def test_every_action_drop_is_single_send(self):
        cases = [(('tap', '10', '20'), 'click', 'coords'),
                 (('tap', 'Copy'), 'click', 'text'),
                 (('tap', 'id=button'), 'click', 'id'),
                 (('key', 'enter'), 'press', 'selector'),
                 (('key', 'back'), 'press', 'selector'),
                 (('swipe', 'up'), 'swipe_ext', 'selector'),
                 (('open', 'dev.test'), 'app_start', 'selector'),
                 (('stop', 'dev.test'), 'app_stop', 'selector')]
        for args, method, kind in cases:
            with self.subTest(args=args):
                self.device.reset_mock()
                self.device.dump_hierarchy.side_effect = None
                self.device.dump_hierarchy.return_value = TREE.replace('text="Copy"', 'text="Copy" resource-id="dev.test:id/button"')
                getattr(self.device, method).side_effect = RemoteDisconnected("lost reply")
                code, out = self.cli(*args)
                self.assertEqual(code, 4)
                self.assertIn("MAYBE_SENT", out)
                self.assertEqual(getattr(self.device, method).call_count, 1)
                self.assertEqual(self.events()[-1]["target_kind"], kind)

    def test_adb_actions_are_not_repeated(self):
        for args in (("url", "https://example.org"), ("sh", "input", "tap", "10", "20")):
            with self.subTest(args=args), patch.object(ph, "adb", side_effect=RemoteDisconnected("lost reply")) as adb:
                self.assertEqual(self.cli(*args)[0], 4)
                adb.assert_called_once()

    def test_adb_nonzero_status_is_maybe_sent(self):
        def failed(args, **kwargs):
            result = subprocess.CompletedProcess(args, 1, "", "error: closed")
            if kwargs.get("check"):
                raise subprocess.CalledProcessError(result.returncode, args, result.stdout, result.stderr)
            return result
        for args in (("url", "https://example.org"), ("sh", "input", "tap", "10", "20")):
            with self.subTest(args=args), patch.object(ph.subprocess, "run", side_effect=failed) as run:
                self.assertEqual(self.cli(*args)[0], 4)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(self.events()[-1]["exc_type"], "CalledProcessError")

    def test_wake_action_timeout_is_maybe_sent(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args[-2:] == ["wm", "dismiss-keyguard"]:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            if "dumpsys power" in " ".join(args):
                return subprocess.CompletedProcess(args, 0, "mWakefulness=Awake", "")
            return subprocess.CompletedProcess(args, 0, "isKeyguardShowing=false", "")
        with patch.object(ph, "_run", self.real_run), patch.object(ph.subprocess, "run", side_effect=run):
            code, out = self.cli("wake")
        self.assertEqual(code, 4)
        self.assertIn("MAYBE_SENT: wake", out)
        self.assertNotIn("awake", out.splitlines())
        self.assertEqual(sum(a[-2:] == ["wm", "dismiss-keyguard"] for a in calls), 1)
        self.assertEqual(self.events()[-1]["exc_type"], "TimeoutExpired")

    def test_cur_transport_drops_have_no_nested_retries(self):
        with patch.object(ph, "adb", side_effect=RemoteDisconnected("closed")) as adb:
            self.assertEqual(self.cli("cur")[0], 3)
        self.assertEqual(adb.call_count, 2)
        ph.d.assert_not_called()
        self.assertEqual([e["event"] for e in self.events()], ["reconnect", "failed"])

    def test_cur_empty_read_uses_central_retry(self):
        with patch.object(ph, "adb", return_value="") as adb:
            self.assertEqual(self.cli("cur")[0], 3)
        self.assertEqual(adb.call_count, 2)
        ph.d.assert_not_called()

    def test_cur_transient_drop_recovers_once(self):
        for field in ("topResumedActivity", "mResumedActivity"):
            with self.subTest(field=field):
                line = field + "=ActivityRecord{123 u0 dev.test/.Main t1}"
                with patch.object(ph, "adb", side_effect=[RemoteDisconnected(), line]) as adb:
                    code, out = self.cli("cur")
                self.assertEqual((code, out), (0, line + "\n"))
                self.assertEqual(adb.call_count, 2)
        ph.d.assert_not_called()

    def test_two_read_failures_exit_three(self):
        self.device.dump_hierarchy.side_effect = RemoteDisconnected("lost reply")
        code, out = self.cli("ui")
        self.assertEqual(code, 3)
        self.assertIn("ERROR: RemoteDisconnected", out)
        self.assertEqual(self.device.dump_hierarchy.call_count, 2)
        self.assertEqual([e["event"] for e in self.events()], ["reconnect", "failed"])
        self.assertEqual(self.events()[-1]["attempt"], 2)

    def test_library_read_errors_make_only_two_total_rpcs(self):
        low = Mock(side_effect=RemoteDisconnected("lost reply"))
        class Device:
            def __init__(self, serial):
                self._dev, self._device_server_port = "fake", 9008
            def jsonrpc_call(self, *args): raise AssertionError("library retry bypassed")
            def dump_hierarchy(self, **kwargs): return self.jsonrpc_call("dumpWindowHierarchy")
        dev = ph.single_send_device(types.SimpleNamespace(Device=Device))
        ph.d.return_value = dev
        with patch.dict(sys.modules, {"uiautomator2.core": types.SimpleNamespace(_jsonrpc_call=low)}):
            self.assertEqual(self.cli("ui")[0], 3)
        self.assertEqual(low.call_count, 2)
        self.assertEqual([e["event"] for e in self.events()], ["reconnect", "failed"])

    def test_action_after_read_retry_is_still_single_send(self):
        self.device.dump_hierarchy.side_effect = [RemoteDisconnected(), TREE]
        self.device.click.side_effect = RemoteDisconnected()
        self.assertEqual(self.cli("tap", "Copy")[0], 4)
        self.device.click.assert_called_once_with(10, 10)
        self.assertEqual([e["event"] for e in self.events()], ["reconnect", "maybe_sent"])

    def test_alarm_after_action_is_maybe_sent(self):
        self.device.send_keys.side_effect = lambda *args, **kwargs: ph._alarm()
        self.assertEqual(self.cli("type", "secret")[0], 4)
        self.device.send_keys.assert_called_once()
        self.assertEqual(self.events()[0]["exc_type"], "TimeoutError")

    def test_alarm_on_read_retries_and_logs_timeout(self):
        self.device.dump_hierarchy.side_effect = [TimeoutError("step timed out"), TREE]
        self.assertEqual(self.cli("ui")[0], 0)
        self.assertEqual([e["event"] for e in self.events()], ["timeout", "reconnect"])

    def test_logging_path_unwritable_does_not_change_results(self):
        blocked = ph.STATE / "file"
        blocked.write_text("not a directory")
        with patch.object(ph, "STATE", blocked):
            self.device.send_keys.side_effect = RemoteDisconnected()
            self.assertEqual(self.cli("type", "secret")[0], 4)
            self.device.dump_hierarchy.side_effect = RemoteDisconnected()
            self.assertEqual(self.cli("ui")[0], 3)
            self.assertEqual(self.cli("note-drop", "--source", "test", "--cmd", "probe", "--exc", "ConnectionError")[0], 0)

    def test_not_found_and_wait_timeout_logged(self):
        self.assertEqual(self.cli("tap", "absent")[0], 1)
        self.assertEqual(self.cli("wait", "absent", "0")[0], 1)
        self.device.click.assert_not_called()
        self.assertEqual([e["event"] for e in self.events()], ["not_found", "timeout"])

    def test_note_drop_never_connects_or_resets(self):
        code, _ = self.cli("note-drop", "--source", "torssh", "--cmd", "click", "--exc", "RemoteDisconnected", "--msg", "CVV 123", "--phase", "action")
        self.assertEqual(code, 0)
        ph.d.assert_not_called()
        row, = self.events()
        self.assertEqual((row["event"], row["source"], row["cmd"], row["exc_type"], row["phase"]),
                         ("external_drop", "torssh", "click", "RemoteDisconnected", "action"))
        self.assertNotIn("123", row["exc_message"])
        self.assertTrue(Path(row["drop_log"]).exists())
        self.assertFalse(any("pkill" in str(a) for a, _ in self.calls))

    def test_note_drop_missing_adb_still_records_event(self):
        with patch.object(ph, "_run", self.real_run), patch.object(ph.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(self.cli("note-drop", "--source", "test", "--cmd", "probe", "--exc", "ConnectionError")[0], 0)
        ph.d.assert_not_called()
        row, = self.events()
        self.assertIsNone(row["ime"])
        self.assertIsNone(row["focused_window"])

    def test_note_drop_slow_adb_is_bounded(self):
        self.guard.stop()
        exe = ph.STATE / "adb"
        exe.write_text("#!/bin/sh\nexec /bin/sleep 30\n")
        exe.chmod(0o700)
        real = self.real_run
        timeouts = []
        def fast_run(args, t=5):
            timeouts.append(t)
            return real(args, t=min(t, 0.05))
        with patch.dict(os.environ, {"PATH": str(ph.STATE)}), patch.object(ph, "_run", fast_run):
            self.assertEqual(self.cli("note-drop", "--source", "test", "--cmd", "probe", "--exc", "ConnectionError")[0], 0)
        self.assertEqual(timeouts, [3, 3, 5])
        ph.d.assert_not_called()
        self.assertEqual(self.events()[0]["event"], "external_drop")

    def test_component_names_include_system_windows_and_reject_titles(self):
        cases = [("android/.AppErrorDialog", True),
                 ("com.android.systemui/.biometrics.AuthContainerView", True),
                 ("com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME", True),
                 ("com.example/.Outer$Inner", True),
                 ("TorSSH", False), ("Unlock TorSSH", False),
                 ("com.example/.Activity private text", False),
                 ("com.example/", False)]
        for value, valid in cases:
            with self.subTest(value=value):
                self.assertEqual(ph.component(value), value if valid else None)

    def test_context_only_accepts_components(self):
        with patch.object(ph, "_run", return_value="private window title or input"):
            self.cli("note-drop", "--source", "test", "--cmd", "probe", "--exc", "ConnectionError")
        row, = self.events()
        self.assertIsNone(row["ime"])
        self.assertIsNone(row["focused_window"])

    def test_rotation_and_drop_retention(self):
        log = ph.STATE / "events.jsonl"
        log.write_text("x" * (5 * 1024 * 1024 + 1))
        drops = ph.STATE / "drops"
        drops.mkdir()
        for i in range(203):
            p = drops / f"{i}.log"
            p.touch()
            os.utime(p, (i, i))
        ph.maintain_logs()
        self.assertFalse(log.exists())
        self.assertTrue((ph.STATE / "events.jsonl.1").exists())
        self.assertEqual(len(list(drops.glob("*.log"))), 200)
        self.assertFalse((drops / "0.log").exists())

    def test_log_counts_last_seven_days_and_sources(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        rows = [dict(ts=(now-datetime.timedelta(days=days)).isoformat(), event=event, source=source)
                for days, event, source in [(8, "failed", "old"), (2, "reconnect", "ph"), (1, "external_drop", "torssh"), (0, "reconnect", "ph")]]
        (ph.STATE / "events.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\ninvalid\n")
        code, out = self.cli("log", "2")
        self.assertEqual(code, 0)
        self.assertIn("by event: external_drop=1, reconnect=2", out)
        self.assertIn("by source: ph=2, torssh=1", out)
        self.assertNotIn("failed", out)
        self.assertEqual(len(out.splitlines()), 6)
        ph.d.assert_not_called()

    real_run = staticmethod(ph._run)


class LibraryReplayTests(unittest.TestCase):
    def test_library_rpc_replay_is_bypassed_for_reads_and_actions(self):
        low = Mock(return_value="read-result")
        class Device:
            def __init__(self, serial):
                self._dev, self._device_server_port = "fake", 9008
            def jsonrpc_call(self, *args): raise AssertionError("u2 internal retry must be bypassed")
        u = types.SimpleNamespace(Device=Device)
        with patch.dict(sys.modules, {"uiautomator2.core": types.SimpleNamespace(_jsonrpc_call=low)}):
            dev = ph.single_send_device(u)
            with patch.object(ph, "_action_sent", False):
                self.assertEqual(dev.jsonrpc_call("objInfo"), "read-result")
            low.side_effect = RemoteDisconnected()
            with patch.object(ph, "_action_sent", True):
                with self.assertRaises(RemoteDisconnected): dev.jsonrpc_call("click", [1, 2])
        self.assertEqual(low.call_count, 2)
        self.assertEqual(low.call_args.args, ("fake", 9008, "click", [1, 2], 10, False))

    def test_input_broadcast_failure_has_no_retry_or_fallback(self):
        class BroadcastError(Exception): pass
        class Device:
            def __init__(self, serial): pass
            def is_input_ime_installed(self): return True
            def set_input_ime(self): pass
            def _broadcast(self, *args): return types.SimpleNamespace(code=0)
        dev = ph.single_send_device(types.SimpleNamespace(Device=Device))
        dev._broadcast = Mock(return_value=types.SimpleNamespace(code=0))
        with patch.dict(sys.modules, {"uiautomator2.exceptions": types.SimpleNamespace(AdbBroadcastError=BroadcastError)}):
            with self.assertRaises(BroadcastError): dev.send_keys("secret")
        self.assertEqual(dev._broadcast.call_count, 1)

    def test_clipboard_failure_has_no_ime_fallback(self):
        class Device:
            def __init__(self, serial): pass
            def is_input_ime_installed(self): return False
        raw = types.SimpleNamespace(send_keys=Mock(side_effect=RemoteDisconnected()), clear_text=Mock())
        dev = ph.single_send_device(types.SimpleNamespace(Device=Device, _Device=raw))
        with self.assertRaises(RemoteDisconnected): dev.send_keys("secret", clear=True)
        raw.send_keys.assert_called_once_with(dev, "secret")
        raw.clear_text.assert_called_once_with(dev)


if __name__ == "__main__":
    unittest.main()
