import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("file-sha256.py")

# Keep the CLI protocol under test while detecting a second read of any path.
READ_ONCE = """
import runpy
import sys
module = runpy.run_path(sys.argv[1])
original = module['file_sha256']
seen = set()
def read_once(path):
    if path in seen:
        raise AssertionError('read the same path twice')
    seen.add(path)
    return original(path)
module['main'].__globals__['file_sha256'] = read_once
sys.exit(module['main']())
"""


class FileSha256Tests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.path = self.folder / "candidate.py"
        self.content = b"recognisable private candidate contents\n"
        self.path.write_bytes(self.content)
        self.sha256 = hashlib.sha256(self.content).hexdigest()

    def args(self, **overrides):
        return {"path": str(self.path), "sha256": self.sha256, **overrides}

    def item(self, number=12, args=None):
        args = self.args() if args is None else args
        return {
            "wait": {
                "on": "script", "script": "file-sha256", "args": args,
                "at": "2026-11-13T18:00:00.000Z", "status": None,
            },
            "card": {"number": number, "next": "evaluator"},
            "facts": {"now": "2026-11-13T19:00:00.000Z"},
            "args": args,
        }

    def run_input(self, raw, expected_exit=0, wrapper=None):
        command = [sys.executable, str(SCRIPT)]
        if wrapper is not None:
            command = [sys.executable, "-c", wrapper, str(SCRIPT)]
        run = subprocess.run(command, input=raw, capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, expected_exit, run.stderr)
        answers = []
        for line in run.stdout.splitlines():
            payload = json.loads(line)
            self.assertEqual(set(payload), {"kanban"})
            self.assertEqual(set(payload["kanban"]), {"wait"})
            answers.append(payload["kanban"]["wait"])
        self.assertNotIn(self.content.decode(), run.stdout)
        return run, answers

    def check(self, args):
        run, answers = self.run_input(json.dumps([self.item(args=args)]))
        self.assertEqual(run.stderr, "")
        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0]["card"], 12)
        return answers[0]

    def test_match(self):
        answer = self.check(self.args())
        self.assertEqual(answer, {
            "card": 12, "result": "wake",
            "note": f"candidate.py sha256 is {self.sha256[:12]}… (matches)",
        })
        self.assertNotIn(str(self.path), answer["note"])
        self.assertNotIn("to", answer)

    def test_uppercase_hash(self):
        self.assertEqual(self.check(self.args(sha256=self.sha256.upper()))["result"], "wake")

    def test_second_hash_in_list_matches(self):
        self.assertEqual(self.check(self.args(sha256=["0" * 64, self.sha256.upper()]))["result"], "wake")

    def test_no_hash_in_list_matches(self):
        answer = self.check(self.args(sha256=["0" * 64, "1" * 64]))
        self.assertEqual(answer["result"], "hold")
        self.assertEqual(answer["status"], f"candidate.py sha256 is {self.sha256[:12]}…, waiting for one of 2")

    def test_mismatch_only_prints_basename_and_hashes(self):
        run, answers = self.run_input(json.dumps([self.item(args=self.args(sha256="A" * 64))]))
        self.assertEqual(answers[0], {
            "card": 12, "result": "hold",
            "status": f"candidate.py sha256 is {self.sha256[:12]}…, waiting for {'a' * 12}…",
        })
        self.assertNotIn(str(self.path), run.stdout)
        self.assertNotIn(self.content.decode().strip(), run.stdout)

    def test_missing_file_holds(self):
        answer = self.check(self.args(path=str(self.folder / "missing.py")))
        self.assertEqual(answer, {"card": 12, "result": "hold", "status": "missing.py is missing"})

    def test_directory_fails_without_full_path(self):
        answer = self.check(self.args(path=str(self.folder)))
        self.assertEqual(answer, {
            "card": 12, "result": "fail",
            "reason": f"Couldn't read {self.folder.name}: IsADirectoryError",
        })

    def test_bad_paths(self):
        for path in ("relative.py", "~/x", "", None, 12, [], {}):
            with self.subTest(path=path):
                self.assertEqual(self.check(self.args(path=path)), {
                    "card": 12, "result": "fail", "reason": 'args needs an absolute "path"',
                })
        self.assertEqual(self.check({"sha256": self.sha256})["reason"], 'args needs an absolute "path"')

    def test_bad_hashes(self):
        for wanted in (
            "a" * 63, "a" * 65, "g" * 64, "a" * 64 + "\n", " " + "a" * 64,
            "", None, 12, {}, [], [self.sha256, "bad"], [None], [[self.sha256]],
        ):
            with self.subTest(wanted=wanted):
                self.assertEqual(self.check(self.args(sha256=wanted)), {
                    "card": 12, "result": "fail",
                    "reason": 'args needs "sha256": 64 hex chars (or a list)',
                })
        self.assertEqual(self.check({"path": str(self.path)})["result"], "fail")

    def test_bad_wake_roles(self):
        for role in ("bogus", "", None, [], {}, False, 12):
            with self.subTest(role=role):
                self.assertEqual(self.check(self.args(to=role))["result"], "fail")

    def test_wake_roles_pass_through(self):
        for role in ("work", "review", "evaluator", "none"):
            with self.subTest(role=role):
                answer = self.check(self.args(to=role))
                self.assertEqual(answer["result"], "wake")
                self.assertEqual(answer["to"], role)

    def test_shared_path_read_once_with_each_cards_args(self):
        items = [self.item(), self.item(13, self.args(sha256="0" * 64))]
        run, answers = self.run_input(json.dumps(items), wrapper=READ_ONCE)
        self.assertEqual(run.stderr, "")
        self.assertEqual([(a["card"], a["result"]) for a in answers], [(12, "wake"), (13, "hold")])

    def test_failed_reads_are_cached(self):
        for path, result in ((self.folder / "missing.py", "hold"), (self.folder, "fail")):
            with self.subTest(path=path):
                args = self.args(path=str(path))
                _, answers = self.run_input(json.dumps([self.item(args=args), self.item(13, args)]), wrapper=READ_ONCE)
                self.assertEqual([(a["card"], a["result"]) for a in answers], [(12, result), (13, result)])

    def test_distinct_paths_are_hashed_separately(self):
        other = self.folder / "other.py"
        other.write_bytes(b"different contents")
        _, answers = self.run_input(json.dumps([self.item(), self.item(13, self.args(path=str(other)))]))
        self.assertEqual([a["result"] for a in answers], ["wake", "hold"])

    def test_empty_file_and_multiple_chunks(self):
        for content in (b"", b"x" * (1024 * 1024) + b"last chunk"):
            with self.subTest(size=len(content)):
                self.path.write_bytes(content)
                wanted = hashlib.sha256(content).hexdigest()
                self.assertEqual(self.check(self.args(sha256=wanted))["result"], "wake")

    def test_read_errors_do_not_leak_error_messages(self):
        for error in ("PermissionError", "OSError"):
            with self.subTest(error=error):
                wrapper = """
import runpy
import sys
module = runpy.run_path(sys.argv[1])
def unreadable(path):
    raise ERROR('private contents and /private/full/path')
module['main'].__globals__['file_sha256'] = unreadable
sys.exit(module['main']())
""".replace("ERROR", error)
                run, answers = self.run_input(json.dumps([self.item()]), wrapper=wrapper)
                self.assertEqual(answers, [{"card": 12, "result": "fail", "reason": f"Couldn't read candidate.py: {error}"}])
                self.assertNotIn("private", run.stdout + run.stderr)

    def test_empty_array(self):
        run, answers = self.run_input("[]")
        self.assertEqual((run.stdout, run.stderr, answers), ("", "", []))

    def test_invalid_stdin(self):
        for raw in ("not JSON", "", "{}", "null", "12", '"text"'):
            with self.subTest(raw=raw):
                run, answers = self.run_input(raw, expected_exit=1)
                self.assertEqual(answers, [])
                self.assertTrue(run.stderr.strip())

    def test_bad_items_are_skipped_and_valid_items_answered(self):
        items = [None, [], "private contents", {}, {"card": {}}, {"card": 12}]
        items += [{"card": {"number": value}} for value in (None, "12", True, 0, -1)]
        run, answers = self.run_input(json.dumps(items + [self.item()]))
        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0]["result"], "wake")
        self.assertEqual(len(run.stderr.splitlines()), len(items))
        self.assertNotIn("private contents", run.stderr)

    def test_missing_null_and_non_object_args_fail(self):
        missing = self.item()
        del missing["args"]
        items = [missing] + [{**self.item(), "args": args} for args in (None, "text", [1], 1)]
        _, answers = self.run_input(json.dumps(items))
        self.assertEqual([a["result"] for a in answers], ["fail"] * len(items))

    def test_every_ms_is_ignored(self):
        self.assertEqual(self.check(self.args(everyMs=60000))["result"], "wake")


if __name__ == "__main__":
    unittest.main()
