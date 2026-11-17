import contextlib
import importlib.util
import io
import json
import os
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch


_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ph.py")
_spec = importlib.util.spec_from_file_location("ph_wake_under_test", _PATH)
ph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ph)  # module import only; no phone is contacted


class FakePhone:
    def __init__(self, wakefulness="Dozing", keyguard="showing", wake_after=1,
                 secure=False, missing_keyguard=False):
        self.wakefulness = wakefulness
        self.keyguard = keyguard
        self.wake_after = wake_after
        self.secure = secure
        self.missing_keyguard = missing_keyguard
        self.commands = []
        self.keyevents = 0
        self.now = 0.0
        self.delayed_unlock = None
        self.hung = False
        self.timeouts = []

    def sleep(self, seconds):
        self.now += seconds
        if self.delayed_unlock is not None and self.now >= self.delayed_unlock:
            self.keyguard = "hidden"

    def adb(self, *args):
        args = tuple(args)
        self.commands.append(args)
        if args[:3] == ("shell", "input", "keyevent"):
            if args[3] not in ("KEYCODE_WAKEUP", "224"):
                raise AssertionError("Only the non-toggling wake key is allowed")
            self.keyevents += 1
            if self.wake_after is not None and self.keyevents >= self.wake_after:
                self.wakefulness = "Awake"
        elif args == ("shell", "wm", "dismiss-keyguard"):
            if self.wakefulness == "Awake" and not self.secure:
                self.keyguard = "hidden"
        elif args[0] == "shell" and "dumpsys power" in " ".join(args):
            return "" if self.wakefulness is None else f"  mWakefulness={self.wakefulness}\n"
        elif args[0] == "shell" and "dumpsys window" in " ".join(args):
            value = "true" if self.keyguard == "showing" else "false"
            line = "" if self.missing_keyguard else f"    isKeyguardShowing={value}\n"
            return line + "    mShowingDream=false mDreamingLockscreen=false\n"
        elif args == ("shell", "echo ok"):
            return "ok\n"
        else:
            raise AssertionError(f"Unexpected phone command: {args}")
        return ""

    def run(self, args, t=5, strict=False):
        self.timeouts.append(t)
        if self.hung:
            self.now += t
            return ""
        if args == ["adb", "devices", "-l"]:
            return f"List of devices attached\n{ph.SERIAL}\tdevice product:test\n"
        if args[:3] != ["adb", "-s", ph.SERIAL]:
            raise AssertionError(f"Unexpected subprocess: {args}")
        return self.adb(*args[3:])

    def device(self):
        # u2's screen_on() does nothing for Dozing, just as in the TorSSH report.
        return type("Device", (), {"screen_on": lambda self: None})()

    def actions(self):
        return [c for c in self.commands
                if c[:3] == ("shell", "input", "keyevent")
                or c == ("shell", "wm", "dismiss-keyguard")]


class WakeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [('LOCK_DIR', Path(tmp.name)), ('HOLD', Path(tmp.name)/'priority-hold'),
                            ('LEASE', Path(tmp.name)/'lease.json')]:
            p = patch.object(ph.phonelock, name, value)
            p.start(); self.addCleanup(p.stop)
        self.phone = FakePhone()
        for target, replacement in [
            ("lock_event", lambda *a, **kw: None),
            ("adb", self.phone.adb), ("_run", self.phone.run),
            ("d", self.phone.device), ("time.monotonic", lambda: self.phone.now),
            ("time.sleep", self.phone.sleep),
        ]:
            owner, _, name = target.rpartition(".")
            obj = ph.time if owner == "time" else ph
            mock = patch.object(obj, name or target, replacement)
            mock.start()
            self.addCleanup(mock.stop)
        guard = patch.object(ph.subprocess, "run", side_effect=AssertionError("No real phone calls"))
        guard.start()
        self.addCleanup(guard.stop)

    def tearDown(self):
        for command in self.phone.actions():
            if command[:3] == ("shell", "input", "keyevent"):
                self.assertIn(command[3], ("KEYCODE_WAKEUP", "224"))
                self.assertNotIn(command[3], ("KEYCODE_POWER", "26"))

    def cli(self, *args):
        out = io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out):
            try:
                ph.main(list(args))
            except SystemExit as error:
                code = error.code
        return code, out.getvalue()

    def test_torssh_dozing_cli_really_wakes_before_success(self):
        code, out = self.cli("wake")
        self.assertEqual((code, out), (0, "awake\n"))
        self.assertEqual((self.phone.wakefulness, self.phone.keyguard), ("Awake", "hidden"))
        self.assertEqual(self.phone.actions(), [
            ("shell", "input", "keyevent", "KEYCODE_WAKEUP"),
            ("shell", "wm", "dismiss-keyguard"),
        ])

    def test_all_non_awake_states_get_wake_key(self):
        for state in ("Dozing", "Asleep", "Dreaming", None):
            with self.subTest(state=state):
                self.phone.wakefulness = state
                self.phone.commands.clear()
                ok, result = ph.wake()
                self.assertTrue(ok)
                self.assertEqual(result["wakefulness"], "Awake")
                self.assertEqual(result["keyguard"], "hidden")
                self.assertEqual(self.phone.actions()[0],
                                 ("shell", "input", "keyevent", "KEYCODE_WAKEUP"))

    def test_already_awake_hidden_sends_no_keyevent(self):
        self.phone.wakefulness, self.phone.keyguard = "Awake", "hidden"
        ok, state = ph.wake()
        self.assertTrue(ok)
        self.assertEqual(state["actions"], ["dismiss-keyguard"])
        self.assertEqual(self.phone.actions(), [("shell", "wm", "dismiss-keyguard")])

    def test_stays_dozing_returns_false(self):
        self.phone.wake_after = None
        ok, state = ph.wake()
        self.assertFalse(ok)
        self.assertEqual((state["wakefulness"], state["keyguard"]), ("Dozing", "showing"))
        self.assertEqual(state["actions"].count("KEYCODE_WAKEUP"), 2)
        self.assertLessEqual(self.phone.now, 6.0)

    def test_stays_dozing_cli_fails_without_success_line(self):
        self.phone.wake_after = None
        code, out = self.cli("wake")
        self.assertEqual(code, 1)
        self.assertEqual(out, "not awake: wakefulness=Dozing keyguard=showing\n")
        self.assertNotIn("awake", out.splitlines())

    def test_secure_keyguard_cli_fails(self):
        self.phone.wakefulness, self.phone.secure = "Awake", True
        code, out = self.cli("wake")
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("locked:"))
        self.assertIn("keyguard=showing", out)
        self.assertNotIn("awake", out.splitlines())
        self.assertEqual(self.phone.keyevents, 0)

    def test_missing_keyguard_is_unknown_not_success(self):
        self.phone.missing_keyguard = True
        ok, state = ph.wake()
        self.assertFalse(ok)
        self.assertEqual((state["wakefulness"], state["keyguard"]), ("Awake", "unknown"))

    def test_missing_power_is_unknown_not_success(self):
        self.phone.wakefulness, self.phone.wake_after = None, None
        ok, state = ph.wake()
        self.assertFalse(ok)
        self.assertIsNone(state["wakefulness"])

    def test_uiautomator_unreachable_does_not_block_adb(self):
        with patch.object(ph, "d", side_effect=RuntimeError("uiautomator2 unavailable")):
            self.assertEqual(self.cli("wake"), (0, "awake\n"))
        self.assertEqual(self.phone.wakefulness, "Awake")

    def test_retry_wakes_and_dismisses_again(self):
        self.phone.wake_after = 2
        ok, state = ph.wake()
        self.assertTrue(ok)
        self.assertGreaterEqual(self.phone.now, 3.0)
        self.assertLess(self.phone.now, 6.0)
        self.assertEqual(state["actions"], ["KEYCODE_WAKEUP", "dismiss-keyguard",
                                            "KEYCODE_WAKEUP", "dismiss-keyguard"])
        self.assertEqual(state["keyguard"], "hidden")

    def test_waits_for_keyguard_to_disappear(self):
        self.phone.secure, self.phone.delayed_unlock = True, 0.9
        ok, _ = ph.wake()
        self.assertTrue(ok)
        self.assertGreaterEqual(self.phone.now, 0.9)

    def test_hung_adb_respects_wake_deadline(self):
        self.phone.hung = True
        ok, state = ph.wake(timeout=0.7)
        self.assertFalse(ok)
        self.assertEqual(self.phone.now, 0.7)
        self.assertEqual(state["keyguard"], "unknown")
        self.assertTrue(all(0 < t <= 0.7 for t in self.phone.timeouts))

    def test_json_success_shape(self):
        code, out = self.cli("wake", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {
            "ok": True, "wakefulness": "Awake", "keyguard": "hidden",
            "actions": ["KEYCODE_WAKEUP", "dismiss-keyguard"],
        })

    def test_json_failure_shape_and_exit(self):
        self.phone.wake_after = None
        code, out = self.cli("wake", "--json")
        self.assertEqual(code, 1)
        state = json.loads(out)
        self.assertIs(state["ok"], False)
        self.assertEqual((state["wakefulness"], state["keyguard"]), ("Dozing", "showing"))
        self.assertEqual(state["actions"].count("KEYCODE_WAKEUP"), 2)

    def test_doctor_non_awake_hint_preserves_ok_exit(self):
        for wakefulness in ("Dozing", "Asleep", "Dreaming", None):
            with self.subTest(wakefulness=wakefulness):
                self.phone.wakefulness = wakefulness
                code, out = self.cli("doctor", "--json")
                self.assertEqual(code, 0)
                state = json.loads(out)
                self.assertEqual(state["status"], "ok")
                self.assertIn("not awake", state["detail"])
                self.assertIn("ph wake", state["detail"])
                self.assertEqual(self.phone.actions(), [])

    def test_doctor_awake_detail_unchanged(self):
        self.phone.wakefulness = "Awake"
        code, out = self.cli("doctor")
        self.assertEqual((code, out), (0, "ok: adb reachable; mWakefulness=Awake\n"))


if __name__ == "__main__":
    unittest.main()
