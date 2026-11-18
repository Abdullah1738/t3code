import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch, Mock

from quit_reason import main, write_reason, desktop_pid, EXECUTABLE
from hold import Holds


class QuitReasonTests(unittest.TestCase):
    def test_targeted_reason_is_private_and_timestamped(self):
        with tempfile.TemporaryDirectory() as directory, patch("quit_reason.time.time", return_value=1000):
            home = Path(directory)
            write_reason(home, "installer", "release .13", 12, 42)
            path = home / ".robob/userdata/logs/desktop-quit-request.json"
            self.assertEqual(json.loads(path.read_text()), dict(at=1000000, targetPid=42,
                requesterPid=12, initiator="installer", reason="release .13"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_cli_process_corpus(self):
        rows = [
            ("desktop only", {42: EXECUTABLE}, 'pid = 42', 42, False),
            ("desktop plus backend and workers", {42: EXECUTABLE, 43: EXECUTABLE,
                44: EXECUTABLE, 45: EXECUTABLE + " Helper"}, '"pid"=42', 42, False),
            ("no app", {}, "", None, False),
            ("orphaned backend only", {43: EXECUTABLE}, "", None, False),
            ("stale registration", {}, "pid = 42", None, False),
            ("wrong executable", {42: "/bin/other"}, "pid = 42", None, True),
            ("multiple registrations", {42: EXECUTABLE, 43: EXECUTABLE},
                "pid = 42\npid = 43", None, True),
        ]
        for name, processes, info, target, invalid in rows:
            def run(command, **kwargs):
                if command[0] == "/usr/bin/lsappinfo":
                    return Mock(stdout=info)
                self.assertEqual(command[:2], ["/bin/ps", "-p"])
                value = processes.get(int(command[2]), "")
                return subprocess.CompletedProcess(command, 0 if value else 1, stdout=value)
            with self.subTest(name=name), patch("sys.argv", ["quit_reason", "--initiator", "installer", "--reason", "release .13"]), \
                    patch("quit_reason.subprocess.run", side_effect=run), patch("quit_reason.write_reason") as write:
                if invalid:
                    with self.assertRaises(ValueError):
                        main()
                    write.assert_not_called()
                    continue
                main()
                if target is None:
                    write.assert_not_called()
                else:
                    self.assertEqual(write.call_args.args[-1], target)

    def test_discovery_failure_does_not_write_a_reason(self):
        with patch("quit_reason.subprocess.run", side_effect=subprocess.TimeoutExpired("lsappinfo", 5)), \
                patch("quit_reason.write_reason") as write:
            with self.assertRaises(subprocess.TimeoutExpired):
                desktop_pid()
            write.assert_not_called()

    def test_ps_failure_corpus(self):
        for code, output, expected in [(1, "", None), (0, EXECUTABLE, 42),
                                       (0, "/bin/other", ValueError), (0, "", ValueError),
                                       (2, "", subprocess.CalledProcessError),
                                       (1, EXECUTABLE, subprocess.CalledProcessError)]:
            with self.subTest(code=code, output=output), patch("quit_reason.registered_desktop_pids", return_value={42}), \
                    patch("quit_reason.subprocess.run", return_value=subprocess.CompletedProcess("ps", code, stdout=output)):
                if isinstance(expected, type):
                    with self.assertRaises(expected):
                        desktop_pid()
                else:
                    self.assertEqual(desktop_pid(), expected)

    def test_stale_pid_cli_is_clean_and_reports_no_desktop(self):
        output = io.StringIO()
        with patch("sys.argv", ["quit_reason", "--initiator", "installer", "--reason", "test"]), \
                patch("quit_reason.subprocess.run", side_effect=[
                    subprocess.CompletedProcess("lsappinfo", 0, stdout="pid = 42"),
                    subprocess.CompletedProcess("ps", 1, stdout="")]), \
                patch("quit_reason.write_reason") as write, redirect_stdout(output):
            self.assertIsNone(main())
        self.assertEqual(output.getvalue(), "no desktop\n")
        write.assert_not_called()

    def test_watchdog_hold_without_desktop_keeps_hold_without_quit_reason(self):
        with tempfile.TemporaryDirectory() as directory, patch("hold.pid_alive", side_effect=lambda pid: pid in (12, 12345)), \
                patch("hold.subprocess.Popen", return_value=Mock(pid=12345)), \
                patch("hold.desktop_pid", return_value=None), patch("hold.write_reason") as write:
            holds = Holds(Path(directory))
            self.assertEqual(holds.start("overload-restart", 12), 12345)
            self.assertTrue(holds.path.exists())
            write.assert_not_called()

    def test_watchdog_hold_hands_off_before_returning(self):
        with tempfile.TemporaryDirectory() as directory, patch("hold.pid_alive", side_effect=lambda pid: pid in (12, 12345)), \
                patch("hold.subprocess.Popen", return_value=Mock(pid=12345)), \
                patch("hold.desktop_pid", return_value=42), \
                patch("hold.write_reason") as write:
            home = Path(directory)
            self.assertEqual(Holds(home).start("overload-restart", 12), 12345)
            write.assert_called_once_with(home, "watchdog", "overload-restart", 12, 42)

    def test_preflight_install_hold_is_not_quit_evidence(self):
        with tempfile.TemporaryDirectory() as directory, patch("hold.pid_alive", side_effect=lambda pid: pid in (12, 12345)), \
                patch("hold.subprocess.Popen", return_value=Mock(pid=12345)), patch("hold.write_reason") as write:
            Holds(Path(directory)).start("install-robob", 12)
            write.assert_not_called()

    def test_reused_watchdog_hold_refreshes_the_reason(self):
        with tempfile.TemporaryDirectory() as directory, patch("hold.pid_alive", side_effect=lambda pid: pid in (12, 12345)), \
                patch("hold.subprocess.Popen", return_value=Mock(pid=12345)), \
                patch("hold.desktop_pid", return_value=42), patch("hold.write_reason") as write:
            holds = Holds(Path(directory))
            holds.start("overload-restart", 12)
            with patch.object(holds, "beater_is_ours", return_value=True):
                holds.start("overload-restart", 12)
            self.assertEqual(write.call_count, 2)

    def test_captured_target_is_not_replaced_by_a_new_registered_desktop(self):
        with tempfile.TemporaryDirectory() as directory, patch("sys.argv", [
                "quit_reason", "--initiator", "guard", "--reason", "backend-unready", "--target-pid", "42"]), \
                patch("quit_reason.Path.home", return_value=Path(directory)), \
                patch("quit_reason.desktop_pid") as lookup, patch("quit_reason.write_reason") as write:
            main()
            lookup.assert_not_called()
            self.assertEqual(write.call_args.args[-1], 42)

    def test_shell_helper_locates_its_script_when_sourced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "scripts/install-hold.zsh"
            script.parent.mkdir()
            script.write_text(Path("scripts/install-hold.zsh").read_text())
            (root / "quit_reason.py").write_text(
                "import sys; print('isolated-helper', *sys.argv[1:])\n")
            result = subprocess.run([
                "/bin/zsh", "-f", "-c", 'source "$1"; robob_quit_reason test',
                "test", str(script)], cwd=root.parent,
                check=True, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.stdout.strip(),
                             "isolated-helper --initiator installer --reason test")
