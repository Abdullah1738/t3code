import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import engine
import statev2_guard as guard
import code_mode_fixture

LIVE = "/Users/x/.robob/userdata/statev2.sqlite"
READ = "live-database-read"
SCRIPT = "live-database-script"
UNRESOLVED = "live-database-script-unresolved"


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        realpath, path_stat = os.path.realpath, Path.stat
        # Historical reporter paths must not depend on mounted checkouts.
        # Retained script bodies are checked separately in temporary directories.
        def frozen_path(path):
            return os.path.abspath(os.fspath(path)).startswith("/Users/ardud/checkouts/")
        def fixture_realpath(path, *args, **kwargs):
            return os.path.abspath(path) if frozen_path(path) else realpath(path, *args, **kwargs)
        def fixture_stat(path, *args, **kwargs):
            if frozen_path(path):
                raise FileNotFoundError(path)
            return path_stat(path, *args, **kwargs)
        for mock in (patch.object(os.path, "realpath", side_effect=fixture_realpath), patch.object(Path, "stat", autospec=True, side_effect=fixture_stat)):
            mock.start()
            self.addCleanup(mock.stop)
        (self.root / "tmp").mkdir()
        self.write("tmp/t.py", "print('ok')")
        self.write("tmp/live.py", f"open({LIVE!r}, 'rb').read()")

    def write(self, name, source):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        return path

    def classify(self, command):
        return guard.classify(command, str(self.root))

    def table(self, rows):
        for command, expected in rows:
            with self.subTest(command=command):
                self.assertEqual(self.classify(command), expected)

    def test_heredoc_data_and_execution(self):
        body = "import hashlib, pathlib, subprocess\n# it's a diff check\nprint('ok')\n"
        self.table([
            (f"cat > tmp/x.py <<'EOF'\n{body}EOF\npython3 tmp/x.py", None),
            (f"cat > tmp/x.py <<'EOF'\n{body}EOF", None),
            (f"cat > x.sh <<'EOF'\nsqlite3 {LIVE}\nEOF", None),
            (f"cat > p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\nbash p.sh", SCRIPT),
            (f"cat > p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\noffbox run -- bash p.sh", SCRIPT),
            (f"cat >> p.sh <<'EOF'\nsqlite3 {LIVE}\nEOF\nbash p.sh", SCRIPT),
            (f"tee p.py <<'EOF'\nopen({LIVE!r}).read()\nEOF\npython3 p.py", SCRIPT),
            (f"node - <<'JS'\nrequire('fs').readFileSync({LIVE!r})\nJS", READ),
            ("bash <<'EOF'\npython3 $X\nEOF", UNRESOLVED),
            (f"bash <<EOF\nsqlite3 {LIVE} .tables\nEOF", READ),
            (f"python3 - <<'EOF'\nimport sqlite3; sqlite3.connect({LIVE!r})\nEOF", READ),
            ("cat > p.py <<'EOF'\npython3 $X", UNRESOLVED),
            ("cat <<-EOF\n\tpython3 $X\n\tEOF", None),
            ("cat <<A <<'B'\npython3 $X\nA\nbash $Y\nB", None),
            ("cat <<'A' > tmp/a; cat <<'B' > tmp/b\npython3 $X\nA\nbash $Y\nB", None),
            (f"cat <<A > p.txt; bash <<A\nprint('safe')\nA\nsqlite3 {LIVE}\nA", READ),
            (f"bash <<A; cat <<A > p.txt\nsqlite3 {LIVE}\nA\nprint('safe')\nA", READ),
            (f"cat > p.txt <<EOF\n$(sqlite3 {LIVE} .tables)\nEOF", READ),
            (f"cat > p.txt <<EOF\n`sqlite3 {LIVE} .tables`\nEOF", READ),
            (f"cat > p.txt <<'EOF'\n$(sqlite3 {LIVE} .tables)\nEOF", None),
            ("cat > p.py <<PY-SCRIPT\nprint('safe')\nPY-SCRIPT\npython3 p.py", None),
            ("cat > p.py <<EOF_1.2\nprint('safe')\nEOF_1.2\npython3 p.py", None),
            (f"python3 tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
            (f"python3 -u tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
            (f"python3 -X dev - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -W ignore - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 --check-hash-based-pycs always - <<'PY'\nopen({LIVE!r}).read()\nPY", READ),
            (f"python3 -X dev tmp/t.py <<'TXT'\n{LIVE}\nTXT", None),
        ])
        overwrite = f"cat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\npython3 tmp/live.py"
        self.assertIsNone(self.classify(overwrite))
        self.assertEqual(self.classify(overwrite.replace("> tmp/live.py", ">> tmp/live.py")), SCRIPT)
        self.assertIsNone(self.classify(f"cat > p.py <<'A'\nopen({LIVE!r})\nA\ncat > p.py <<'B'\nprint('safe')\nB\npython3 p.py"))
        for start, end in [("if false; then", "fi"), ("while false; do", "done"), ("for f in a b; do", "done"), ("if false; then bash <<'SH'", "SH\nfi"), ("if false; then {", "}; fi"), ("false && {", "}"), ("true || (", ")")]:
            with self.subTest(start=start):
                self.assertEqual(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 tmp/live.py"), SCRIPT)
        for prefix in ("false && ", "true || "):
            self.assertEqual(self.classify(f"{prefix}cat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\npython3 tmp/live.py"), SCRIPT)
        for start, end in [("{", "} &"), ("(", ") &"), ("{", "} | cat"), ("{", "} >/dev/null &"), ("(", ") 2>/dev/null &"), ("{", "} >/dev/null 2>&1 &"), ("{", "} &>/dev/null &"), ("{", "} >/dev/null | cat")]:
            self.assertEqual(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 tmp/live.py"), SCRIPT)
        for start, end in [("{", "}"), ("(", ")"), ("{", "} >/dev/null"), ("{", "} >/dev/null 2>&1")]:
            self.assertIsNone(self.classify(f"{start}\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n{end}\npython3 tmp/live.py"))
        for target in ("'&'", "'|'", "'&>'", "'&&'", "'&&&'", "'>'", "'&''>'", "\"|\"", "'a&b'", "'__guard_quoted_0__'", "'<<'", "'>>'"):
            for end, expected in [(" &", SCRIPT), (" | cat", SCRIPT), ("", None)]:
                with self.subTest(target=target, end=end):
                    command = f"# it's a quoted target\n{{\ncat > tmp/live.py <<'EOF'\nprint('safe replacement')\nEOF\n}} > {target}{end}\npython3 tmp/live.py"
                    self.assertEqual(self.classify(command), expected)

    def test_python_prose_and_source_edits(self):
        prose = "import subprocess\nt=\"\"\"- node --test --test-name-pattern='x y' scripts/a.mjs\n- python3 $X\n- bash \\\"$Y\\\"\"\"\"\nopen('tmp/n.md','w').write(t)"
        edit = 'from pathlib import Path\np=Path("x.py"); p.write_text(p.read_text().replace("~/.robob/userdata/statev2.sqlite","~/.robob/userdata/replica.sqlite"))'
        self.table([
            ("python3 - <<'PY'\n" + prose + "\nPY", None),
            ("python3 - <<'PY'\n" + edit + "\nPY", None),
            ("python3 -c " + shlex.quote(edit), None),
            ("python3 tmp/edit.py", None),
            ("python3 - <<'PY'\nfrom pathlib import Path\np=Path('tmp/e.py'); p.write_text(p.read_text().replace(\"it's\", 'its'))\nPY\npython3 tmp/e.py", None),
        ])
        self.write("tmp/edit.py", edit)
        self.assertIsNone(self.classify("python3 tmp/edit.py"))
        denied = [
            f'from pathlib import Path; Path({LIVE!r}).read_bytes()',
            f'import shutil; shutil.copy({LIVE!r}, "/tmp/c")',
            f'import os; p=os.environ["P"]; open(p).read(); s={LIVE!r}',
            f'import sqlite3; sqlite3.connect({LIVE!r})',
            f'import sqlite3 as s; s.connect({LIVE!r})',
            f'from shutil import copy as c; c({LIVE!r}, "/tmp/c")',
            f'p={LIVE!r}; open(p).read()',
            f'from pathlib import Path; p=Path({LIVE!r}); p.read_bytes()',
            f'p="tmp/a"; p=input(); open(p); s={LIVE!r}',
            f'open(input()); s={LIVE!r}',
            f'reader=open; reader({LIVE!r}).read()',
            f'import shutil; copy=shutil.copyfile; copy({LIVE!r}, "/tmp/c")',
            f'from pathlib import Path; reader=Path({LIVE!r}).read_bytes; reader()',
            'import os; p=os.path.join(os.environ["HOME"], ".robob", "userdata", "statev2.sqlite"); open(p).read()',
            'import os; os.chdir("/Users/x/.local/share/opencode"); open("opencode.db").read()',
            'from os import chdir; chdir("/Users/x/.robob/userdata"); open("statev2.sqlite-wal").read()',
            f'open({LIVE!r}',
            'from pathlib import Path; p=Path.home()/".robob"/"userdata"/"statev2.sqlite"; p.read_bytes()',
            'import os; p=os.path.join(os.path.expanduser("~"), ".local/share/opencode", "opencode.db"); open(p)',
        ]
        for source in denied:
            with self.subTest(source=source):
                self.assertEqual(self.classify("python3 -c " + shlex.quote(source)), READ)
        for suffix in ("", "-wal", "-shm", "-journal"):
            self.assertEqual(self.classify("python3 -c " + shlex.quote(f"open({(LIVE + suffix)!r}).read()")), READ)

    def test_fixture_db_names_are_not_live_paths(self):
        source = 'from pathlib import Path\nimport tempfile\nwith tempfile.TemporaryDirectory() as tmp:\n p=Path(tmp)/"statev2.sqlite"\n p.write_text("userdata")\n s="opencode"\n q=Path(tmp)/"opencode.db"\n'
        self.assertFalse(guard.source_touches_live(source))
        self.assertIsNone(self.classify("python3 - <<'PY'\n" + source + "\nPY"))
        self.table([
            ("grep -n -E 'userdata|.robob|statev2.sqlite|opencode.db' repo.py", None),
            ("git show abc:path.py | grep -n -E 'userdata|statev2.sqlite|opencode.db'", None),
            (f"cat > mod.py <<'PY'\nimport sqlite3; sqlite3.connect({LIVE!r})\nPY\npython3 -m mod", SCRIPT),
            (f"cat > tests/mod.py <<'PY'\nimport sqlite3; sqlite3.connect({LIVE!r})\nPY\npython3 -m unittest tests.mod", SCRIPT),
            (f"cat > pkg/__main__.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m pkg", SCRIPT),
            (f"cat > pkg/__init__.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m pkg", SCRIPT),
            (f"cat > tests/test_live.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m unittest discover -s tests", SCRIPT),
            (f"cat > tests/test_live.py <<'PY'\nopen({LIVE!r}).read()\nPY\npython3 -m unittest tests/test_live.py", SCRIPT),
        ])
        for name in ("opencode.db", "opencode.db-wal", "opencode.db-shm", "opencode.db-journal"):
            self.assertEqual(guard.classify("python3 -c " + shlex.quote(f"open({name!r}).read()"), "/Users/x/.local/share/opencode"), READ)
        node = "const fs=require('fs'),path=require('path'),os=require('os'); fs.readFileSync(path.join(os.homedir(),'.robob','userdata','statev2.sqlite'));"
        self.assertEqual(self.classify("node -e " + shlex.quote(node)), READ)

    def test_filters(self):
        self.table([(command, None) for command in [
            "diff -u a.txt b.txt; rg --files -g 'watchers.json' -g '!*statev2.sqlite*' -g '!*opencode.db*' ~/.local/share/robob-watch",
            "rg --files -g '*.json' -g '*.md' -g '!*statev2.sqlite*' -g '!*opencode.db*' .",
            "rg --files --glob='!statev2.sqlite*' ~/.robob",
            "rg --files -g '*statev2.sqlite*' ~/.robob",
            "rg foo -g '!statev2.sqlite*' .",
            "grep -rn foo --exclude='statev2.sqlite*' .",
            "find . -name '*.md' -not -name 'statev2.sqlite*'",
            "find . -name 'statev2.sqlite'",
            "fd -E 'opencode.db*' -e json",
            "fd '*opencode.db*' .",
            "git ls-files -x '*statev2.sqlite*'",
            "rg --files --iglob='*statev2.sqlite*' . | cat",
            "rg --files --glob '*opencode.db*' .",
            "find . ! -iname 'statev2.sqlite*' -exec cat {} +",
            "grep foo --exclude-dir='statev2.sqlite*' .",
            "rg foo -g '*statev2.sqlite*' ./fixtures",
        ]] + [(command, READ) for command in [
            "rg foo -g '*statev2.sqlite*' ~/.robob/userdata",
            "grep -r foo --include='*statev2*' ~/.robob",
            "find ~/.robob/userdata -name 'statev2.sqlite' -exec cat {} +",
            "rg --files ~/.robob/userdata/statev2.sqlite",
            "diff a.txt b.txt; sqlite3 ~/.robob/userdata/statev2.sqlite .tables",
            "grep x ~/.robob/userdata/statev2.sqlite",
            "fd -g '*.md' ~/.robob/userdata/statev2.sqlite",
            "rg foo -g statev2.sqlite ~/.robob/userdata",
            "fd -g '*statev2.sqlite*' ~/.robob -x cat",
            "fd '*statev2.sqlite*' ~/.robob --exec cat",
            "fd -g '*opencode.db*' ~/.local/share/opencode -X cat",
        ]])

    def test_live_shell_assignments_still_block_readers(self):
        for reader in ("sqlite3", "cat"):
            for assignment in (f"DB={LIVE};", f"export DB={LIVE};", f"readonly DB={LIVE};", f"env DB={LIVE}"):
                command = f'{assignment} {reader} "$DB"'
                with self.subTest(command=command):
                    self.assertEqual(self.classify(command), READ)
        self.table([
            (f'DB={LIVE}; cat "${{DB}}"', READ),
            (f'DB={LIVE}; COPY=$DB; cat "$COPY"', READ),
            ('ROOT=/Users/x/.robob/userdata; DB=$ROOT/statev2.sqlite; cat "$DB"', READ),
            ('ROOT=/Users/x/.robob/userdata; cat "$ROOT/statev2.sqlite"', READ),
            (f'env DB={LIVE} python3 -c \'import os,sqlite3; sqlite3.connect(os.environ["DB"])\'', READ),
            (f'DB={LIVE}; env DB=/tmp/safe cat "$DB"', READ),
            (f'if false; then DB={LIVE}; fi; cat "$DB"', READ),
            ('ROOT=/Users/x/.robob/userdata; if false; then ROOT=/tmp; fi; cat "$ROOT/statev2.sqlite"', READ),
            ('ROOT=/Users/x/.robob/worktrees; ROOT=/Users/x/.robob/userdata; cat "$ROOT/statev2.sqlite"', READ),
            ('ROOT=/Users/x/.robob/userdata; ROOT=/Users/x/.local/share/opencode; cat "$ROOT/opencode.db"', READ),
            (f'env -S \'DB={LIVE} cat "$DB"\'', READ),
            ('DB=/tmp/isolated.sqlite; cat "$DB"', None),
            (f'DB={LIVE}; echo "$DB"', None),
            (f'cat > note.txt <<\'EOF\'\nDB={LIVE}; cat "$DB"\nEOF', None),
        ])
        for operator in (":-", "-", ":=", "=", ":+", "+", ":?", "?"):
            for default in (LIVE, shlex.quote(LIVE), '"' + LIVE + '"', "${Y:-" + LIVE + "}"):
                command = "DB=${X" + operator + default + '}; cat "$DB"'
                with self.subTest(operator=operator, default=default):
                    self.assertEqual(self.classify(command), READ)
        self.assertIsNone(self.classify('DB=${X:-"}"}; cat tmp/t.py'))
        self.assertIsNone(self.classify('DB=${X:-${Y:-/tmp/safe}}; cat "$DB"'))
        self.assertEqual(self.classify('python3 ${SCRIPT:-tmp/t.py}'), UNRESOLVED)
        for substitution, expected in [
            (f"$(cat {LIVE})", READ),
            (f"`cat {LIVE}`", READ),
            ("$(python3 tmp/live.py)", SCRIPT),
            ("$(python3 $SCRIPT)", UNRESOLVED),
            ("$(git status --short)", None),
        ]:
            for quote in ("", '"'):
                value = "${X:-" + quote + substitution + quote + "}"
                self.table([(f"OUT={value}", expected), (f"jq --arg x {value} . facts.json", expected)])
            value = "${X:-'" + substitution + "'}"
            self.table([(f"OUT={value}", None), (f"jq --arg x {value} . facts.json", None)])
        for command in ("OUT=${X:-$(cat statev2.sqlite)}", "jq --arg x ${X:-$(cat statev2.sqlite)} . facts.json"):
            self.assertEqual(self.classify("cd /Users/x/.robob/userdata && " + command), READ)
        self.write("check.py", f"open({LIVE!r}).read()")
        nested = self.write("sub/check.py", "print('safe')")
        command = "cd sub && OUT=${X:-$(python3 check.py)}"
        self.assertIsNone(self.classify(command))
        self.write("check.py", "print('safe')")
        nested.write_text(f"open({LIVE!r}).read()")
        self.assertEqual(self.classify(command), SCRIPT)

    def test_parameter_substitutions_in_headers(self):
        forms = [
            ("for item in", "; do :; done"),
            ("select item in", "; do break; done"),
            ("case", " in *) :;; esac"),
            ("case item in", ") :;; esac"),
            ("case item in other|", ") :;; esac"),
        ]
        for prefix, suffix in forms:
            with self.subTest(header=prefix):
                command = f"cd /Users/x/.robob/userdata && {prefix} ${{X:-$(cat statev2.sqlite)}}{suffix}"
                self.assertEqual(self.classify(command), READ)
                self.assertIsNone(self.classify(f"{prefix} ${{X:-$(git status --short)}}{suffix}"))
                self.assertIsNone(self.classify(f"{prefix} ${{X:-'$(python3 $SCRIPT)'}}{suffix}"))
                self.assertIsNone(self.classify(f"{prefix} {LIVE}{suffix}"))
        self.assertIsNone(self.classify("for item in ${X:-$(python3 tmp/t.py)}; do cd tmp; done"))
        for pattern in (
            "${X:-$(cat statev2.sqlite)}", "${X:-$(cat statev2.sqlite)}|other",
            "other|${X:-$(cat statev2.sqlite)}", "one|${X:-$(cat statev2.sqlite)}|other",
        ):
            for earlier_arm in ("", "first) cd /tmp;; "):
                command = f"cd /Users/x/.robob/userdata && case item in {earlier_arm}{pattern}) :;; esac"
                with self.subTest(pattern=pattern, earlier_arm=earlier_arm):
                    self.assertEqual(self.classify(command), READ)
                    self.assertIsNone(self.classify(command.replace("$(cat statev2.sqlite)", "$(git status --short)")))
        self.assertIsNone(self.classify("case item in one) cd /tmp;; two) cat tmp/t.py | head -1;; esac"))

    def test_ordinary_substitutions_in_headers(self):
        forms = [("for x in", '; do echo "$x"; done'), ("select x in", "; do break; done"),
                 ("case", " in *) :;; esac"), ("case x in", ") :;; esac"),
                 ("case x in first) cd /tmp;;", "|other) :;; esac")]
        for prefix, suffix in forms:
            for substitution in (f"$(cat {LIVE})", f"`cat {LIVE}`", '$(cat "' + LIVE + '")'):
                for quote in ("", '"'):
                    with self.subTest(form=prefix, substitution=substitution, quote=quote):
                        self.assertEqual(self.classify(f"{prefix} {quote}{substitution}{quote}{suffix}"), READ)
                self.assertIsNone(self.classify(f"{prefix} '{substitution}'{suffix}"))
            for value in ("$(git status --short)", "`git status --short`", r"\$(python3 tmp/live.py)"):
                self.assertIsNone(self.classify(f"{prefix} {value}{suffix}"))
            self.assertEqual(self.classify(f"cd /Users/x/.robob/userdata && {prefix} $(cat statev2.sqlite){suffix}"), READ)
        self.assertIsNone(self.classify("cat > note.md <<'EOF'\nfor x in $(python3 $X); do :; done\nEOF"))
        self.assertEqual(self.classify(f"for x in $(python3 - <<'PY'\nopen({LIVE!r}).read()\nPY\n); do :; done"), READ)
        self.assertIsNone(self.classify(f"for x in $(cat <<'TXT'\n{LIVE}\nTXT\n); do :; done"))
        self.assertEqual(self.classify(f"for x in ${{X:- # $(cat {LIVE})}}; do :; done"), READ)
        self.assertIsNone(self.classify(f"# $(cat {LIVE})\nfor x in $(git status --short); do :; done"))
        for body in ("# )\nprint('safe')", "# it's a ) comment\nprint('safe')"):
            command = 'result="$(python3 - <<\'PY\'\n' + body + '\nPY\n)"'
            self.assertIsNone(self.classify(command))
            self.assertEqual(self.classify(command.replace("print('safe')", f"open({LIVE!r}).read()")), READ)
        for body in (")", "it's $(python3 $X)", "for x in a; do ( : ); done"):
            command = 'result="$(cat <<\'TEXT\'\n' + body + '\nTEXT\n)"'
            self.assertIsNone(self.classify(command))

    def test_isolated_userdata_paths(self):
        paths = ["/var/folders/x/T/sync-smoke-639-ab/fixture/userdata/statev2.sqlite",
                 str(self.root / ".t3/userdata/statev2.sqlite"), "fixture/userdata/statev2.sqlite"]
        for path in paths:
            with self.subTest(path=path):
                self.assertIsNone(self.classify(f"sqlite3 {path} 'SELECT count(*) FROM threads'"))
                self.assertIsNone(self.classify("python3 -c " + shlex.quote(f"import sqlite3; sqlite3.connect({path!r})")))
                self.assertIsNone(self.classify("node -e " + shlex.quote(f"require('fs').readFileSync({path!r})")))
                self.assertIsNone(self.classify("python3 -c " + shlex.quote(f"import os; os.chdir('fixture/userdata'); open('statev2.sqlite').read()")))
        fake_live = self.write("home/.robob/userdata/statev2.sqlite", "fixture")
        alias = self.root / "fixture-alias.sqlite"
        alias.symlink_to(fake_live)
        with patch.object(Path, "open", side_effect=AssertionError("must not read DB symlink")):
            self.assertEqual(self.classify(f"sqlite3 {alias} .tables"), READ)
        self.table([(f"sqlite3 {LIVE} .tables", READ), ("sqlite3 ~/.robob/userdata/statev2.sqlite .tables", READ),
                    ('sqlite3 "$HOME/.robob/userdata/statev2.sqlite" .tables', READ),
                    ('ROOT=$HOME/.robob/userdata; sqlite3 "$ROOT/statev2.sqlite" .tables', READ)])
        for cwd, target in (("/Users/x/.robob", "userdata"), ("/Users/x/.robob/worktrees", "../userdata")):
            for source, interpreter in [
                (f"import os; os.chdir({target!r}); open('statev2.sqlite').read()", "python3 -c "),
                (f"process.chdir({target!r}); require('fs').readFileSync('statev2.sqlite')", "node -e "),
            ]:
                with self.subTest(cwd=cwd, source=source):
                    self.assertEqual(guard.classify(interpreter + shlex.quote(source), cwd), READ)

    def test_dynamic_python_imports_cannot_get_text_only_exemption(self):
        bodies = [
            f'__import__("sqlite3").connect({LIVE!r})',
            f'import builtins; builtins.__import__("sqlite3").connect({LIVE!r})',
            f'import importlib; importlib.import_module("sqlite3").connect({LIVE!r})',
            f'from importlib import import_module as load; load("sqlite3").connect({LIVE!r})',
            f'load=__import__; load("sqlite3").connect({LIVE!r})',
            f'getattr(__builtins__, "__import__")("sqlite3").connect({LIVE!r})',
            f'import builtins; load=getattr(builtins, "__import__"); load("sqlite3").connect({LIVE!r})',
            f'import importlib; loader=importlib; loader.import_module("sqlite3").connect({LIVE!r})',
            f'import builtins; loader=builtins; loader.__import__("sqlite3").connect({LIVE!r})',
            f'from builtins import open as reader; reader({LIVE!r}).read()',
        ]
        for body in bodies:
            self.table([
                ("python3 -c " + shlex.quote(body), READ),
                (f"python3 - <<'PY'\n{body}\nPY", READ),
                (f"cat > dynamic.py <<'PY'\n{body}\nPY\npython3 dynamic.py", SCRIPT),
            ])
        self.assertIsNone(self.classify("python3 -c " + shlex.quote(f'print({LIVE!r}, "__import__(sqlite3)")')))
        self.assertIsNone(self.classify("python3 -c '__import__(\"subprocess\").run([\"git\", \"status\"])'"))

    def test_plain_argv_database_mentions_are_data(self):
        for text in ("statev2.sqlite", "opencode.db", LIVE, f"Use python3 instead of sqlite3 {LIVE}"):
            with self.subTest(text=text):
                self.assertIsNone(self.classify("jq --arg new " + shlex.quote(text) + " '.text=$new' facts.json"))
        self.assertIsNone(self.classify("jq --argjson new " + shlex.quote(json.dumps(LIVE)) + " '.text=$new' facts.json"))
        self.assertEqual(self.classify(f"jq . {LIVE}"), READ)
        self.assertEqual(self.classify(f"jq --rawfile new {LIVE} . facts.json"), READ)
        for flags in ("-n", "-nc", "--null-input", "--indent 2 -n"):
            with self.subTest(flags=flags):
                self.assertIsNone(self.classify(f"jq {flags} " + shlex.quote(json.dumps(LIVE))))
        self.assertIsNone(self.classify(f"jq -n --args '$ARGS.positional' {LIVE}"))
        self.assertIsNone(self.classify("jq -n --jsonargs '$ARGS.positional' " + shlex.quote(json.dumps(LIVE))))
        self.assertIsNone(self.classify("jq --arg x -f -n " + shlex.quote(json.dumps(LIVE))))
        self.assertIsNone(self.classify(f'DB={LIVE}; jq --arg x "$DB" "." facts.json'))
        self.assertEqual(self.classify(f'DB={LIVE}; jq . "$DB"'), READ)
        for flag in ("--args", "--jsonargs"):
            self.table([
                (f"jq . {LIVE} {flag} value", READ),
                (f"jq {flag} . < {LIVE}", READ),
                (f'DB={LIVE}; jq {flag} . < "$DB"', READ),
                (f"jq {flag} . < tmp/t.py", None),
                (f"jq {flag} . {shlex.quote(json.dumps(LIVE))}", None),
            ])
        for command in (
            f"jq -f {LIVE} facts.json", f"jq --from-file={LIVE} facts.json",
            f"jq --slurpfile data {LIVE} .", f"jq -f filter.jq {LIVE}",
            f"jq -ffilter.jq {LIVE}", f"jq --run-tests {LIVE}",
            f"jq -nf {LIVE}", f"jq --arg x --args . {LIVE}",
            f"jq {shlex.quote(json.dumps(LIVE))} {LIVE}",
        ):
            self.assertEqual(self.classify(command), READ)
        self.assertEqual(self.classify(f"cat {LIVE}"), READ)

    def test_wrappers_scripts_and_symlinks(self):
        self.table([
            ("python3 tmp/live.py", SCRIPT),
            ("offbox run -- python3 tmp/live.py", SCRIPT),
            ("offbox run --size large -- bash -lc 'python3 tmp/live.py'", SCRIPT),
            ("env -C tmp python3 live.py", SCRIPT),
            ("uv run python3 tmp/live.py", SCRIPT),
            ("bash -c 'python3 tmp/live.py'", SCRIPT),
            ("offbox run -- bash -lc 'source ~/.nvm/nvm.sh && nvm use 24 && node --test x.test.mjs'", None),
            ("source ~/.robob/userdata/statev2.sqlite", SCRIPT),
            ("python3 $X", UNRESOLVED),
            ("python3 tmp/t.py", None),
        ])
        self.write("__guard_quoted_0__.py", f"open({LIVE!r}).read()")
        self.assertEqual(self.classify("echo '&'; python3 '__guard_'quoted_0__.py"), SCRIPT)
        self.assertEqual(self.classify("echo '&'; python3 __guard_quoted_0__.py"), SCRIPT)
        self.assertEqual(self.classify("python3 '\0guard_quoted_0__'"), UNRESOLVED)
        alias = self.root / "alias.py"
        alias.symlink_to(LIVE)
        with patch.object(Path, "open", side_effect=AssertionError("must not open DB alias")):
            self.assertIn(self.classify("python3 alias.py"), {READ, SCRIPT})
            self.assertEqual(self.classify("cat alias.py"), READ)

    def test_control_flow(self):
        self.table([
            ("if true; then python3 tmp/t.py; fi", None),
            ('for f in a b; do python3 tmp/t.py "$f"; done; python3 tmp/t.py', None),
            ("while false; do python3 tmp/t.py; done; python3 tmp/t.py", None),
            ("until true; do python3 tmp/t.py; done; python3 tmp/t.py", None),
            ("for f in a b; do echo cd; python3 tmp/t.py; done", None),
            ("case x in x) python3 tmp/t.py;; esac", None),
            ("case x in x) cd sub;; y) python3 tmp/t.py;; esac", None),
            ("if a; then cd sub; else python3 tmp/t.py; fi", None),
            ("if c; then cd sub; fi; python3 t.py", UNRESOLVED),
            ("if c; then { cd sub; }; fi; python3 t.py", UNRESOLVED),
            ("if c; then (cd sub); fi; python3 tmp/t.py", None),
            ("for d in a b; do cd $d; python3 t.py; done", UNRESOLVED),
            ("for d in a b; do python3 tmp/t.py; cd sub; done", UNRESOLVED),
            ("for d in a b; do python3 tmp/t.py; command cd sub; done", UNRESOLVED),
            ("for d in a b; do python3 tmp/t.py; eval 'cd sub'; done", UNRESOLVED),
            ("if true; then python3 tmp/live.py; fi", SCRIPT),
        ])
        self.write("sub/t.py", f"open({LIVE!r}).read()")
        self.assertEqual(self.classify("if cd sub && false; then :; else python3 t.py; fi"), SCRIPT)

    def test_reporter_commands(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for filename in manifest:
            if manifest[filename]["kind"] == "codex-code-mode":
                continue
            with self.subTest(fixture=filename):
                command = (fixtures / filename).read_text()
                self.assertIsNone(self.classify(command), guard.classify_detail(command, str(self.root)))

    def test_reporter_workdirs_and_literal_cd(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for filename, info in manifest.items():
            if info["kind"] == "codex-code-mode":
                continue
            if info["card"] in {1061, 2037, 3022, 3186, 3207, 162, 2586, 2697, 540, 3122, 358, 2282, 3041, 2808, 1606, 2996, 3070}:
                with self.subTest(fixture=filename, cwd=info["cwd"]):
                    command = (fixtures / filename).read_text()
                    self.assertIsNone(guard.classify(command, info["cwd"]))
        command = (fixtures / "crpko-3186-leading-cd.sh").read_text()
        cwd = "/Volumes/ExternalSSD/crpko-devops/tmp/card-3186/repo"
        paths = guard.scripts_in(command, "/Volumes/ExternalSSD/crpko-devops")
        for name in ("test-aurora-master-rotation-off.mjs", "test-cutover-command-deny-infra.mjs"):
            self.assertIn(Path(os.path.realpath(Path(cwd) / "scripts" / name)), paths)
        for body, expected in [("console.log('safe')", None), (f"require('fs').readFileSync({LIVE!r})", SCRIPT)]:
            script = self.write("clone/scripts/check.mjs", body)
            command = f"cd {script.parents[1]} && git log > log.json && node --test scripts/check.mjs > test.log 2>&1"
            self.assertEqual(self.classify(command), expected)
        self.write("clone/scripts/first.mjs", "console.log('safe')")
        self.assertEqual(self.classify(f"cd {self.root}/clone && node --test scripts/first.mjs scripts/check.mjs > test.log 2>&1"), SCRIPT)

    def test_markdown_2037_does_not_hide_a_later_script(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "crpko-2037-heredoc-blocker.sh").read_text()
        self.assertEqual(guard.scripts_in(command, str(self.root)), [])
        self.assertEqual(self.classify(command + "\npython3 tmp/live.py"), SCRIPT)

    def test_existing_and_written_script_3022(self):
        fixtures = Path(__file__).with_name("fixtures")
        body = (fixtures / "bodies/crpko-3022-existing-edit.py").read_text()
        script = self.write("tmp/card-3022/edit.py", body)
        self.assertIsNone(self.classify("python3 tmp/card-3022/edit.py"))
        self.assertIsNone(self.classify(f"python3 {script}"))
        script.write_text(f"open({LIVE!r}).read()")
        self.assertEqual(self.classify("python3 tmp/card-3022/edit.py"), SCRIPT)
        self.assertEqual(self.classify(f"python3 {script}"), SCRIPT)
        cwd = "/Users/ardud/checkouts/market-data-registry-3022"
        target = Path(os.path.realpath(Path(cwd) / "tmp/card-3022/edit.py"))
        self.assertEqual(guard.scripts_in("python3 tmp/card-3022/edit.py", cwd), [target])
        command = (fixtures / "crpko-3022-create-run.sh").read_text()
        self.assertIsNone(guard.classify(command, cwd))
        twin = command.replace("\nPY\n", f"\nopen({LIVE!r}).read()\nPY\n", 1)
        self.assertNotEqual(twin, command)
        self.assertEqual(guard.classify(twin, cwd), SCRIPT)

    def test_absolute_script_3207_and_relative_script_162(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for name, target in [
            ("crpko-3207-s75-absolute-resolve.sh", "/Users/ardud/checkouts/rewards-nv1-carry/tmp/carry-3207/resolve.py"),
            ("usdtwallet-162-s76-create-relative-python.sh", "tmp/cards/fix-plain-network-errors/write-red.py"),
        ]:
            info = manifest[name]
            body = (fixtures / info["body_fixture"]).read_text()
            command = (fixtures / name).read_text()
            with self.subTest(fixture=name):
                self.assertIsNone(guard.classify(command, info["cwd"]))
                for extra, expected in [("", None), (f"\nopen({LIVE!r}).read()", SCRIPT)]:
                    wrapper = f"cat > {target} <<'GUARD_BODY'\n{body}{extra}\nGUARD_BODY\npython3 {target}"
                    self.assertEqual(guard.classify(wrapper, info["cwd"]), expected)
                local = self.write("tmp/reporter.py", body)
                self.assertIsNone(self.classify("python3 tmp/reporter.py"))
                local.write_text(body + f"\nopen({LIVE!r}).read()")
                self.assertEqual(self.classify("python3 tmp/reporter.py"), SCRIPT)

    def test_remote_setup_strings_in_python_540(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "robob-540-s78-inline-edit-repo-setup.sh").read_text()
        cwd = "/Users/ardud/checkouts/offbox-repo-setup"
        self.assertIsNone(guard.classify(command, cwd))
        twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
        self.assertNotEqual(twin, command)
        self.assertEqual(guard.classify(twin, cwd), READ)

    def test_reporter_edits_and_markdown_keep_db_reads_checked(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        names = (
            "crpko-3122-terraform-python-edit.sh", "crpko-358-markdown-pytest.sh",
            "crpko-3041-r1-python-edit.sh", "crpko-2808-heredoc-relative-node-test.sh",
            "crpko-2996-python-edit-gofmt-offbox.sh",
            "crpko-3070-python-setup-offbox.sh",
            "crpko-1606-terraform-create-offbox-node.sh", "crpko-1606-append-relative-node-test.sh",
            "crpko-1606-results-markdown-write.sh",
        )
        for name in names:
            command = (fixtures / name).read_text()
            cwd = manifest[name]["cwd"]
            self.assertIsNone(guard.classify(command, cwd))
            written_read = f"\ncat > tmp/read-live.py <<'GUARD_TWIN'\nopen({LIVE!r}).read()\nGUARD_TWIN\npython3 tmp/read-live.py"
            self.assertEqual(guard.classify(command + written_read, cwd), SCRIPT)
            if manifest[name]["card"] in {3122, 3041, 2996}:
                twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
                self.assertNotEqual(twin, command)
                self.assertEqual(guard.classify(twin, cwd), READ)

    def test_pure_cat_source_and_markdown_2697(self):
        fixtures = Path(__file__).with_name("fixtures")
        for name in ("crpko-2697-source-and-test-heredocs.sh", "crpko-2697-facts-heredoc.sh"):
            command = (fixtures / name).read_text()
            self.assertEqual(guard.scripts_in(command, str(self.root)), [])
            self.assertIsNone(self.classify(command))

    def test_ovnfs_and_worktree_cwd_resolve_equally(self):
        for cwd in ("/Users/ardud/checkouts/guard-fixture", "/Users/ardud/.robob/worktrees/project/guard-fixture"):
            for body, expected in [("print('safe')", None), (f"open({LIVE!r}).read()", SCRIPT)]:
                command = f"cat > scripts/proof.py <<'EOF'\n{body}\nEOF\npython3 scripts/proof.py"
                with self.subTest(cwd=cwd, expected=expected):
                    self.assertEqual(guard.classify(command, cwd), expected)

    def test_existing_script_after_python_edit_is_still_checked(self):
        command = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('main.tf'); p.write_text(p.read_text().replace(\"it's\", 'its'))\nPY\nnode --test scripts/t.mjs"
        self.write("scripts/t.mjs", "console.log('ok')")
        self.assertIsNone(self.classify(command))
        self.write("scripts/t.mjs", f"require('fs').readFileSync({LIVE!r})")
        self.assertEqual(self.classify(command), SCRIPT)
        self.write("scripts/t.mjs", "console.log('ok')")
        command = command.replace("\nnode --test", "\n&& node --test")
        self.assertIsNone(self.classify(command))
        command = "python3 - <<'PY' && node --test scripts/t.mjs\nfrom pathlib import Path\np=Path('main.tf'); p.write_text(p.read_text().replace(\"it's\", 'its'))\nPY"
        self.assertIsNone(self.classify(command))

    def test_real_written_and_existing_script_bodies(self):
        fixtures = Path(__file__).with_name("fixtures")
        for name, target, interpreter in [
            ("usdtwallet-142-campaign.py", "tmp/142/campaign.py", "python3"),
            ("usdtwallet-142-loops.sh", "tmp/142/loops.sh", "bash"),
            ("usdtwallet-140-proof.sh", "tmp/card140/proof.sh", "offbox run -- bash"),
            ("crpko-2774-make_cancel_probes.py", str(self.root / "probes/make.py"), "python3"),
        ]:
            body = (fixtures / "bodies" / name).read_text()
            command = f"cat > {target} <<'EOF'\n{body}\nEOF\n{interpreter} {target}"
            with self.subTest(body=name):
                self.assertIsNone(self.classify(command))
        self.write("tmp/escrow-settlement/edit.py", (fixtures / "bodies/crpko-2743-edit.py").read_text())
        self.assertIsNone(self.classify((fixtures / "crpko-2743-edit.sh").read_text()))
        self.assertIsNone(self.classify("cat > testhost/.secrets/check.py <<'EOF'\nprint('safe fixture')\nEOF\npython3 testhost/.secrets/check.py ssh test"))

    def test_node_heredoc_with_shell_prose_2982(self):
        body = "const fs = require('fs');\nconst data = fs.readFileSync('tmp/card-2982/s4-final.json', 'utf8');\nconst report = `Result: ${data}\n- node --test scripts/check.mjs\n- python3 $X\n- bash \\\"$Y\\\"`;\nfs.writeFileSync('tmp/card-2982/s4-evidence.md', report);\n"
        self.assertIsNone(self.classify("node - <<'NODE'\n" + body + "NODE"))
        self.assertEqual(self.classify("node - <<'NODE'\n" + body.replace("tmp/card-2982/s4-final.json", LIVE) + "NODE"), READ)

    def test_compound_python_node_stdin_1245(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "crpko-1245-python-node-stdin.sh").read_text()
        cwd = "/Volumes/ExternalSSD/board-wt/crpko-devops-native-init-floors"
        self.assertIsNone(guard.classify(command, cwd))
        self.assertIn("node --input-type=module - <<'JS'", command)
        self.assertIn("npm run validate:plan", command)
        for flags in ("", "--input-type=module ", "--no-warnings --input-type=module "):
            variant = command.replace("node --input-type=module -", f"node {flags}-")
            with self.subTest(flags=flags, reader=None):
                self.assertIsNone(guard.classify(variant, cwd))
            for delimiter, read in [
                ("PY", 'from pathlib import Path; Path("~/.robob/userdata/statev2.sqlite").expanduser().read_bytes()'),
                ("JS", "const liveDbFs = await import('node:fs'); liveDbFs.readFileSync(process.env.HOME + '/.robob/userdata/statev2.sqlite');"),
            ]:
                twin = variant.replace(f"\n{delimiter}\n", f"\n{read}\n{delimiter}\n", 1)
                self.assertNotEqual(twin, variant)
                with self.subTest(flags=flags, reader=delimiter):
                    self.assertEqual(guard.classify(twin, cwd), READ)

    def test_python_setup_then_offbox_timeout_2154(self):
        fixtures = Path(__file__).with_name("fixtures")
        command = (fixtures / "crpko-2154-python-offbox-timeout.sh").read_text()
        cwd = "/Volumes/ExternalSSD/board-wt/crpko-integration-harness-HC-021d"
        self.assertIsNone(guard.classify(command, cwd))
        script = Path(os.path.realpath(Path(cwd) / "tmp/hc021d/check.sh"))
        self.assertIn(script, guard.scripts_in(command, cwd))
        setup, separator, remote = command.partition("\n offbox run ")
        self.assertIn("python3 - <<'PY'", setup)
        self.assertTrue(separator)
        wrapped = "offbox run " + remote
        self.write("tmp/hc021d/check.sh", "echo safe\n")
        self.assertIsNone(self.classify(wrapped))
        self.write("tmp/hc021d/check.sh", "sqlite3 ~/.robob/userdata/statev2.sqlite .tables\n")
        self.assertEqual(self.classify(wrapped), SCRIPT)

    def test_diagnostics_and_limits(self):
        for command, detail in [
            ("python3 $X", "$X"),
            ('cd "$D" && python3 x.py', "cd to a non-literal"),
            ("python3 'x.py", "unbalanced quote"),
            ("for d in a b; do cd $d; python3 t.py; done", "loop that changes directory"),
            (";".join(f"python3 s{i}.py" for i in range(guard.MAX_SCRIPTS + 1)), "MAX_SCRIPTS"),
        ]:
            with self.subTest(command=command):
                rule, cause = guard.classify_detail(command, str(self.root))
                self.assertEqual(rule, UNRESOLVED)
                self.assertIn(detail, cause)
        nested = "python3 tmp/t.py"
        for _ in range(3):
            nested = "bash -c " + shlex.quote(nested)
        with patch.object(guard, "MAX_SHELL_DEPTH", 2):
            self.assertIn("MAX_SHELL_DEPTH", guard.classify_detail(nested, str(self.root))[1])

    def test_engine_guard_failure_is_closed_and_cause_is_logged(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "exec_command", "tool_input": {"cmd": "python3 $X", "workdir": str(self.root)}}
        with patch.object(engine, "_state", return_value=self.root / "hook-state"):
            result = engine.decide(event, "codex")
            line = json.loads((self.root / "hook-state/decisions.jsonl").read_text().splitlines()[-1])
            self.assertEqual(line["cause"], result["context"]["cause"])
        with patch.object(guard, "classify_detail", side_effect=ValueError("broken")), patch.object(engine, "_log"), patch.object(engine, "resolve_identity", side_effect=AssertionError("must deny before identity")):
            result = engine.decide(event, "codex")
            self.assertEqual(result["decision"], "deny")
            self.assertEqual(result["context"]["rule"], "live-database-unavailable")

    def test_codex_code_mode_reporter_events(self):
        fixtures = Path(__file__).with_name("fixtures")
        manifest = json.loads((fixtures / "manifest.json").read_text())
        for name in ("crpko-3060-code-mode.js", "usdtwallet-165-code-mode.js"):
            source = (fixtures / name).read_text()
            calls = code_mode_fixture.commands(source, "/unrelated/event/cwd")
            self.assertEqual(len(calls), 1)
            command, cwd = calls[0]
            self.assertEqual(cwd, manifest[name]["cwd"])
            self.assertIsNone(guard.classify(command, cwd))
            twin = command.replace("\nPY", f"\nopen({LIVE!r}).read()\nPY", 1)
            self.assertNotEqual(twin, command)
            for cmd, expected in ((command, None), (twin, READ if manifest[name]["card"] == 3060 else SCRIPT)):
                # Codex 0.166 normalizes each nested exec_command this way.
                event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}
                with self.subTest(fixture=name, expected=expected), patch.object(engine, "_log"):
                    result = engine.decide(event, "codex")
                    self.assertEqual(result["decision"], "deny" if expected else "allow")
                    if expected:
                        self.assertEqual(result["context"]["rule"], expected)
            for checkout in ("/Users/ardud/checkouts/devops-timeline-identity", "/Users/ardud/checkouts/race-gate-hold-pairs"):
                self.assertIsNone(guard.classify("python3 - <<'PY'\nfrom pathlib import Path\nPath('plan.json').write_text('{}')\nPY", checkout))

    def test_code_mode_fixture_extraction(self):
        safe, unsafe = self.write("safe/task.py", "print('safe')"), self.write("unsafe/task.py", f"open({LIVE!r}).read()")
        cell = (f"text(await tools.exec_command({{cmd:'python3 task.py', 'workdir':{json.dumps(str(safe.parent))}}}));\n"
                "const status = await tools.mcp__t3_code__task_status({taskId:'other'});\n"
                f"await tools.exec_command({{\"cmd\":'python3 task.py',workdir:{json.dumps(str(unsafe.parent))}}});\n"
                "text(await tools.write_stdin({session_id:123,chars:''}));")
        calls = code_mode_fixture.commands(cell, str(self.root))
        self.assertEqual([guard.classify(cmd, cwd) for cmd, cwd in calls], [None, SCRIPT])
        self.assertEqual(code_mode_fixture.commands("// tools.exec_command({cmd:secret})\nconst s='tools.exec_command({cmd:secret})';", str(self.root)), [])
        self.assertEqual(code_mode_fixture.commands("tools.exec_command({cmd:`python3 tmp/t.py`,cwd:'/tmp'});", str(self.root)), [("python3 tmp/t.py", "/tmp")])
        for source in (
            "tools.exec_command({cmd:command,workdir:'/tmp'})", "tools.exec_command({cmd:'python3 t.py',workdir:directory})",
            "tools.exec_command(args)", "tools.exec_command({cmd:`python3 ${script}`,workdir:'/tmp'})",
            "tools.exec_command({cmd:'safe',...args})", "tools.exec_command({cmd:'safe',['cmd']:command})",
            "tools.exec_command({cmd:'safe',cmd:command})", "tools.exec_command({cmd:'safe'} || args)",
        ):
            with self.subTest(source=source), self.assertRaises(code_mode_fixture.Unresolved):
                code_mode_fixture.commands(source, str(self.root))

    def test_engine_entrypoints_and_cwd(self):
        for harness, tool, field in [("codex", "exec_command", "cmd"), ("codex", "shell_command", "command"), ("claude", "Bash", "command"), ("codex", "mcp__x__bash", "cmd"), ("codex", "shell", "command"), ("claude", "mcp__x__shell", "command")]:
            for explicit in (False, True):
                for command, expected in [("sqlite3 " + LIVE, READ), ("python3 tmp/live.py", SCRIPT), ("python3 tmp/t.py", None), ("cat > tmp/x.py <<'PY'\n# it's safe\nPY", None), ("python3 $X", UNRESOLVED)]:
                    event = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {field: command}, "cwd": str(self.root)}
                    if explicit:
                        event["tool_input"]["workdir"] = str(self.root)
                    with self.subTest(harness=harness, tool=tool, command=command, explicit=explicit), patch.object(engine, "_log"):
                        result = engine.decide(event, harness)
                        self.assertEqual(result["decision"], "deny" if expected else "allow")
                        if expected:
                            self.assertEqual(result["context"]["rule"], expected)
                        if expected == UNRESOLVED:
                            self.assertIn("$X", result["reason"])
                            self.assertIn(str(self.root), result["reason"])
                            self.assertNotIn("explicit workdir", result["reason"])
                            self.assertIn("cause", result["context"])


if __name__ == "__main__":
    unittest.main()
