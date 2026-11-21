import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'libexec/toollog'))
import toollog

DAY = '2026-11-20'
BASE = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
UUID = '50196b48-7f83-4b91-9b20-b3366aaf2b15'
ROBOB = f'thread:project:ardud-opencode-import%3Aproject%3A%2FVolumes%2FExternalSSD%2Fcrpko-devops:{UUID}'
RULES = ('live-database-script', 'live-database-script-unresolved', 'rootwide-search')
SHAPES = ('python3 <path.py>', 'sqlite3 <path.sqlite> <q>', 'cd <qvar> && node <path.js>', 'rg <w> <path>')


def refusal(rule, shape, thread, seconds, *, decision='denied', rate=None, harness='codex', **props):
    row_props = {'harness': harness, 'guard': 'statev2', 'rule': rule, 'decision': decision, **props}
    if shape is not None:
        row_props['cmdShape'] = shape
    if rate:
        row_props['sampleRate'] = rate
    return {'ts': (BASE + timedelta(seconds=seconds)).isoformat().replace('+00:00', 'Z'),
            'tool': 'agent-tools', 'component': 'hooks', 'name': 'hook.decision',
            'kind': 'error' if decision == 'denied' else 'perf', 'ok': decision != 'denied',
            'ids': {'threadId': thread}, 'props': row_props}


class RefusalShapeRollupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {'TOOLLOG_ROOT': self.tmp.name})
        env.start()
        self.addCleanup(env.stop)
        self.directory = toollog.board_dir('agent-tools')
        self.directory.mkdir(parents=True)

    def write(self, rows, day=DAY):
        with (self.directory / (day + '.ndjson')).open('a') as dest:
            dest.write(''.join(json.dumps(row) + '\n' for row in rows))

    def fixture(self):
        # 3 rules x 4 shapes: rule i, shape j fires (i + 1) * (j + 1) times, one thread per fire,
        # 10 minutes apart so none of them is a retry.
        rows = []
        for i, rule in enumerate(RULES):
            for j, shape in enumerate(SHAPES):
                for n in range((i + 1) * (j + 1)):
                    rows.append(refusal(rule, shape, f'native:codex:{rule}-{j}-{n}', n * 600))
        return rows

    def by_key(self, result):
        return {(entry['rule'], entry['shape']): entry for entry in result['shapes']}

    def test_counts_and_distinct_threads_per_rule_and_shape(self):
        rows = self.fixture()
        # One thread refuses twice on the same shape: count 2, one distinct thread.
        rows += [refusal(RULES[0], SHAPES[0], 'native:codex:repeat', 0),
                 refusal(RULES[0], SHAPES[0], 'native:codex:repeat', 3600)]
        self.write(rows)
        result = toollog.refusal_shapes('agent-tools', DAY)
        entries = self.by_key(result)
        self.assertEqual(len(entries), 12)
        self.assertEqual(result['shapeCount'], 12)
        for i, rule in enumerate(RULES):
            for j, shape in enumerate(SHAPES):
                extra = 2 if (i, j) == (0, 0) else 0
                entry = entries[(rule, shape)]
                self.assertEqual(entry['count'], (i + 1) * (j + 1) + extra)
                self.assertEqual(entry['denied'], entry['count'])
                self.assertEqual(entry['distinctThreads'], (i + 1) * (j + 1) + (1 if extra else 0))
                self.assertEqual(entry['retryWithin5m'], 0)
                self.assertEqual(entry['shapeSource'], 'command')
                self.assertEqual(entry['harness'], {'codex': entry['count']})
        self.assertEqual(result['rows'], sum((i + 1) * (j + 1) for i in range(3) for j in range(4)) + 2)
        self.assertEqual(result['shapes'][0]['count'], 12)  # rootwide-search x shape 4 ranks first
        self.assertIsNone(result['other'])

    def test_retry_within_five_minutes(self):
        cases = [
            # label, [(thread, shape, seconds)], expected retries on SHAPES[0]
            ('same thread 60s apart', [('native:codex:a', 0, 0), ('native:codex:a', 0, 60)], 1),
            ('exactly 300s', [('native:codex:a', 0, 0), ('native:codex:a', 0, 300)], 1),
            ('301s is not a retry', [('native:codex:a', 0, 0), ('native:codex:a', 0, 301)], 0),
            ('chain of three', [('native:codex:a', 0, 0), ('native:codex:a', 0, 200), ('native:codex:a', 0, 400)], 2),
            ('other thread', [('native:codex:a', 0, 0), ('native:codex:b', 0, 10)], 0),
            ('other shape', [('native:codex:a', 0, 0), ('native:codex:a', 1, 10)], 0),
            ('unknown bucket mixes agents', [('unknown:codex', 0, 0), ('unknown:codex', 0, 10)], 0),
            ('out of order rows', [('native:codex:a', 0, 120), ('native:codex:a', 0, 0)], 1),
        ]
        for label, fires, expected in cases:
            with self.subTest(case=label):
                (self.directory / (DAY + '.ndjson')).unlink(missing_ok=True)
                self.write([refusal(RULES[0], SHAPES[shape], thread, seconds) for thread, shape, seconds in fires])
                entry = self.by_key(toollog.refusal_shapes('agent-tools', DAY))[(RULES[0], SHAPES[0])]
                self.assertEqual(entry['retryWithin5m'], expected)

    def test_retry_window_crosses_utc_midnight_without_counting_yesterday(self):
        midnight = datetime(2026, 11, 20, tzinfo=timezone.utc)
        def at(seconds, thread='native:codex:a'):
            row = refusal(RULES[0], SHAPES[0], thread, 0)
            row['ts'] = (midnight + timedelta(seconds=seconds)).isoformat()
            return row
        self.write([at(-100), at(-400, 'native:codex:b')], day='2026-11-19')
        self.write([at(50), at(10, 'native:codex:b')])
        entry = toollog.refusal_shapes('agent-tools', DAY)['shapes'][0]
        self.assertEqual(entry['count'], 2)
        self.assertEqual(entry['retryWithin5m'], 1)  # thread a: 150 s; thread b: 410 s
        self.assertEqual(toollog.rollup('agent-tools', DAY)['refusalShapes']['shapes'][0]['retryWithin5m'], 1)

    def test_cap_folds_the_rest_into_other(self):
        self.write(self.fixture())
        result = toollog.refusal_shapes('agent-tools', DAY, cap=5)
        self.assertEqual(len(result['shapes']), 5)
        other = result['other']
        self.assertEqual(other['shapes'], 7)
        self.assertEqual(sum(entry['count'] for entry in result['shapes']) + other['count'], result['rows'])
        self.assertEqual(sum(entry['distinctThreads'] for entry in result['shapes']) + other['distinctThreads'],
                         result['rows'])
        self.assertEqual(other['denied'], other['count'])
        self.assertEqual([entry['count'] for entry in result['shapes']], [12, 9, 8, 6, 6])
        self.assertEqual(toollog.REFUSAL_SHAPE_CAP, 100)
        self.assertEqual(toollog.rollup('agent-tools', DAY)['refusalShapes']['cap'], 100)

    def test_test_run_rows_and_allowed_rows_are_excluded(self):
        rows = self.fixture()
        rows += [refusal(RULES[0], SHAPES[0], 'native:codex:test', n, source='test') for n in range(5)]
        rows.append(refusal(RULES[0], SHAPES[0], 'native:codex:allowed', 0, decision='allowed'))
        rows.append({'name': 'other.event', 'ids': {'threadId': 'native:codex:x'}, 'props': {'rule': RULES[0]}})
        self.write(rows)
        result = toollog.refusal_shapes('agent-tools', DAY)
        self.assertEqual(result['excludedTestRows'], 5)
        self.assertEqual(self.by_key(result)[(RULES[0], SHAPES[0])]['count'], 1)
        self.assertNotIn('native:codex:test', json.dumps(result))

    def test_rule_filter_projects_harness_and_rewrites(self):
        self.write([
            refusal(RULES[1], SHAPES[0], ROBOB, 0),
            refusal(RULES[1], SHAPES[0], 'native:claude:s', 10, harness='claude', project='t3code-fork'),
            refusal(RULES[1], SHAPES[0], 'unknown:claude', 20, harness='claude'),
            refusal(RULES[1], SHAPES[0], 'native:codex:s', 30, decision='rewritten', rate=128),
            refusal(RULES[2], SHAPES[3], 'native:codex:r', 0),
        ])
        result = toollog.refusal_shapes('agent-tools', DAY, rule=RULES[1])
        self.assertEqual([entry['rule'] for entry in result['shapes']], [RULES[1]])
        entry = result['shapes'][0]
        self.assertEqual((entry['count'], entry['denied'], entry['rewritten']), (131, 3, 128))
        self.assertTrue(entry['sampled'])
        self.assertEqual(entry['unattributed'], 1)
        self.assertEqual(entry['distinctThreads'], 3)
        self.assertEqual(entry['harness'], {'claude': 2, 'codex': 129})
        self.assertEqual(entry['topProjects'], [{'project': 'native', 'count': 128},
                                                {'project': 'crpko-devops', 'count': 1},
                                                {'project': 't3code-fork', 'count': 1},
                                                {'project': 'unattributed', 'count': 1}])
        with self.assertRaises(ValueError):
            toollog.refusal_shapes('agent-tools', DAY, rule='bad rule/..')

    def test_sampled_unattributed_rows_are_marked_as_estimates(self):
        self.write([refusal(RULES[1], SHAPES[0], 'unknown:codex', 0, decision='rewritten', rate=128)]
                   + self.fixture())
        result = toollog.refusal_shapes('agent-tools', DAY)
        entry = self.by_key(result)[(RULES[1], SHAPES[0])]
        self.assertEqual((entry['count'], entry['unattributed'], entry['distinctThreads']), (130, 128, 2))
        self.assertTrue(entry['sampled'])
        (self.directory / (DAY + '.ndjson')).unlink()
        self.write([refusal(RULES[2], 'git status', 'unknown:codex', 0, decision='rewritten', rate=128)])
        alone = toollog.refusal_shapes('agent-tools', DAY)['shapes'][0]
        self.assertEqual((alone['count'], alone['sampled'], alone['distinctThreads']), (128, True, 0))
        self.assertIn('128~', toollog.refusals_table(toollog.refusal_shapes('agent-tools', DAY)))
        # Folded into other: the denied fixture outranks the sampled rewrite, which lands past the cap.
        self.write(self.fixture())
        folded = toollog.refusal_shapes('agent-tools', DAY, cap=12)
        self.assertNotIn('git status', [entry['shape'] for entry in folded['shapes']])
        self.assertTrue(folded['other']['sampled'])
        self.assertEqual(folded['other']['count'], 128)

    def test_rows_without_cmd_shape_group_by_coarse_shape(self):
        self.write([refusal(RULES[1], None, 'native:codex:a', 0, firstWord='git', cwdClass='worktree'),
                    refusal(RULES[1], None, 'native:codex:b', 0, firstWord='git', cwdClass='worktree'),
                    refusal(RULES[1], None, 'native:codex:c', 0),
                    refusal(RULES[1], 'bad/shape "raw"', 'native:codex:d', 0, firstWord='rg')])
        result = toollog.refusal_shapes('agent-tools', DAY)
        entries = self.by_key(result)
        self.assertEqual(entries[(RULES[1], 'coarse:git cwd:worktree')]['count'], 2)
        self.assertEqual(entries[(RULES[1], 'coarse:none')]['shapeSource'], 'coarse')
        self.assertIn((RULES[1], 'coarse:rg'), entries)
        self.assertEqual(result['coarseRows'], 4)
        self.assertNotIn('bad/shape', json.dumps(result))

    def test_only_agent_tools_rollups_carry_refusal_shapes(self):
        self.write(self.fixture())
        self.assertIn('refusalShapes', toollog.rollup('agent-tools', DAY))
        (toollog.board_dir('orders')).mkdir()
        self.assertNotIn('refusalShapes', toollog.rollup('orders', DAY))

    def test_cli_table_and_json(self):
        self.write(self.fixture())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(toollog.main(['refusals', '--day', DAY, '--top', '3']), 0)
        lines = out.getvalue().splitlines()
        self.assertIn('60 refusals in 12 shapes', lines[0])
        self.assertTrue(lines[1].startswith('count'))
        self.assertIn('rg <w> <path>', lines[2])
        self.assertIn('other (9 shapes)', lines[-1])
        self.assertEqual(len(lines), 6)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(toollog.main(['refusals', '--day', DAY, '--rule', RULES[0], '--json']), 0)
        data = json.loads(out.getvalue())
        self.assertEqual({entry['rule'] for entry in data['shapes']}, {RULES[0]})
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(toollog.main(['refusals', '--day', 'yesterday']), 1)


class CommandShapeTests(unittest.TestCase):
    SECRETS = ('hunter2', 'Hunter2', 'sk-ab12cd34ef56', 'PRIVATE_FIXTURE', 'private-fixture', '4242',
               'Volumes', 'userdata', 'Bearer', 'xyz789', 'supersecret')

    def test_shapes_by_input_class(self):
        db = '~/.cache/fixture/app.sqlite'
        cases = [
            ('bare program and subcommand', 'git status', 'git status'),
            ('global flag then vocabulary subcommand', 'git -C /Volumes/x status --short', 'git -C <path> status --short'),
            ('word after a flag is hidden', 'grep -r private-fixture .', 'grep -r <w> <path>'),
            ('third bare word is hidden', 'git stash list please', 'git stash list <w>'),
            ('argument is not a subcommand', 'echo hunter2 now', 'echo <w>+'),
            ('absolute program path keeps the name', '/opt/homebrew/bin/python3 -I x.py', 'python3 -I <path.py>'),
            ('relative script', './scripts/run.sh --fast', '<path.sh> --<opt>'),
            ('quoted single', "sqlite3 " + db + " 'select 4242'", 'sqlite3 <path.sqlite> <q>'),
            ('quoted with variable', 'cd "$WT" && python3 rel.py', 'cd <qvar> && python3 <path.py>'),
            ('bare variable', 'cat $HOME/secret', 'cat <var>'),
            ('numbers', 'sleep 4242 && tail -5 f.log', 'sleep <n> && tail <n> <path.log>'),
            ('flag value', 'curl --token=xyz789 https://x.example/a', 'curl --<opt>=<v> <path>'),
            ('attached short-flag value', 'mysql -pHunter2 -u root', 'mysql <flag> -u <w>'),
            ('env assignments', 'PRIVATE_FIXTURE=hunter2 lower=x bun test a.test.ts',
             'PRIVATE_FIXTURE=<v> <assign> bun test <path.ts>'),
            ('export value', 'export TOKEN=supersecret && ls', 'export <w> && ls'),
            ('key-like first word', 'sk-ab12cd34ef56 run', '<cmd> run'),
            ('uppercase first word', 'PRIVATE run', '<cmd> run'),
            ('glob', "find . -name '*.py' -exec rm {} +", 'find <path> -name <q> -exec <w>+'),
            ('unquoted glob', 'ls *.py', 'ls <glob>'),
            ('heredoc body dropped', "cat > /tmp/x.py <<'EOF'\nprint('hunter2')\nEOF\npython3 /tmp/x.py 2>&1 | tail -5",
             'cat > <path.py> << <delim> ; python3 <path.py> >& | tail <n>'),
            ('herestring', "python3 - <<< 'hunter2'", 'python3 <w> <<< <q>'),
            ('command substitution', 'echo $(date +%s) >> log.txt; ls', 'echo $( date <w> ) > <path.txt> ; ls'),
            ('backticks', 'echo `whoami`', 'echo ` whoami `'),
            ('double dash starts a command', 'offbox run -- vp test run apps/a.test.ts', 'offbox run -- vp test run <path.ts>'),
            ('wrapper starts a command', 'timeout 30 env FOO=1 bun test', 'timeout <n> env FOO=<v> bun test'),
            ('double dash after a runner wrapper', 'env -- node x.js', 'env -- node <path.js>'),
            ('double dash only ends options elsewhere', 'git checkout -- hunter', 'git checkout -- <w>'),
            ('repeated placeholders collapse', 'rm -rf /a /b /c', 'rm -rf <path>+'),
            ('tilde path', 'ls ~/private-fixture', 'ls <path>'),
            ('trailing separators trimmed', 'ls ; ', 'ls'),
            ('only whitespace', '   ', None),
            ('not a string', None, None),
        ]
        for label, command, expected in cases:
            with self.subTest(case=label):
                self.assertEqual(toollog.command_shape(command), expected)

    def assertShapes(self, cases):
        for label, command, expected in cases:
            with self.subTest(case=label):
                shape = toollog.command_shape(command)
                self.assertEqual(shape, expected)
                self.assertNotIn('supersecret', (shape or '').lower())

    def test_flag_forms_keep_only_known_names(self):
        self.assertShapes([
            ('attached lowercase value', 'mysql -psupersecret -u root', 'mysql <flag> -u <w>'),
            ('attached mixed-case value', 'mysql -pSuperSecret db', 'mysql <flag> <w>'),
            ('attached user value', 'curl -usupersecret https://x', 'curl <flag> <path>'),
            ('attached header value', 'curl -Hsupersecret x', 'curl <flag> <w>'),
            ('short flag with separate value', 'curl -u user:supersecret x', 'curl -u <w>+'),
            ('two-letter cluster', 'rm -rf a', 'rm -rf <w>'),
            ('three-letter cluster is not a known name', 'tar -xvf a.tar', 'tar <flag> <path.tar>'),
            ('short flag with equals', 'x -k=supersecret', '<cmd> <flag>'),
            ('known long single-dash option', "find . -name '*.py' -print0", 'find <path> -name <q> -print0'),
            ('long single-dash lookalike', 'find . -namesupersecret', 'find <path> <flag>'),
            ('long double-dash value', 'gh api --token=supersecret', 'gh api --<opt>=<v>'),
            ('uppercase double-dash name', 'x --SuperSecret', '<cmd> --<opt>'),
            ('unknown long option', 'x --supersecret', '<cmd> --<opt>'),
            ('unknown long option with value', 'x --supersecret=1', '<cmd> --<opt>=<v>'),
            ('extra dash before an attached value', 'mysql --psupersecret', 'mysql --<opt>'),
            ('known long option', 'bun test --test-name-pattern x', 'bun test --test-name-pattern <w>'),
            ('lone dash', 'cat -', 'cat <w>'),
            ('negative number', 'tail -20 f.log', 'tail <n> <path.log>'),
        ])

    def test_escapes_never_split_an_argument(self):
        self.assertShapes([
            ('escaped semicolon', 'echo super\\;secret', 'echo <w>'),
            ('escaped pipe', 'echo super\\|secret', 'echo <w>'),
            ('escaped ampersands', 'echo super\\&\\&secret', 'echo <w>'),
            ('escaped space', 'echo super\\ secret', 'echo <w>'),
            ('escaped quote', "echo it\\'s supersecret", 'echo <w>+'),
            ('escaped program', '\\supersecret run', '<w> run'),
            ('escaped redirect', 'echo a\\>supersecret', 'echo <w>'),
            ('trailing backslash', 'ls \\', 'ls'),
            ('line continuation joins lines', 'git \\\ngit status', 'git <w> status'),
            ('continuation then flag', 'rg supersecret \\\n  --files', 'rg <w> --files'),
        ])

    def test_heredoc_bodies_never_survive(self):
        self.assertShapes([
            ('dashed quoted delimiter', "cat <<'END-OF-DATA'\nsupersecret\nEND-OF-DATA\nls",
             'cat << <delim> ; ls'),
            ('dashed bare delimiter', 'cat <<END-OF-DATA\nsupersecret\nEND-OF-DATA\nls', 'cat << <delim> ; ls'),
            ('double-quoted delimiter with space', 'cat <<"END OF"\nsupersecret\nEND OF\nls', 'cat << <delim> ; ls'),
            ('escaped delimiter', 'cat <<\\EOF\nsupersecret\nEOF\nls', 'cat << <delim> ; ls'),
            ('tab-stripped terminator', 'cat <<-EOF\n\tsupersecret\n\tEOF\nls', 'cat << <delim> ; ls'),
            ('space-indented terminator does not close', 'cat <<EOF\nsupersecret\n  EOF\nsupersecret',
             'cat << <delim> ...'),
            ('terminator with trailing space does not close', 'cat <<EOF\nsupersecret\nEOF \nsupersecret',
             'cat << <delim> ...'),
            ('unterminated', 'cat <<EOF\nsupersecret', 'cat << <delim> ...'),
            ('no delimiter', 'cat <<\nsupersecret', 'cat << ...'),
            ('mixed quoting is unreadable', 'cat <<E"O"F\nsupersecret\nEOF\nsupersecret', 'cat << <delim> <q> <w> ...'),
            ('two heredocs on a line', 'cat <<A <<B\nsupersecret\nA\nsupersecret\nB\nls',
             'cat << <delim> << <delim> ; ls'),
            ('herestring is not a heredoc', "cat <<< 'supersecret'\nls", 'cat <<< <q> ; ls'),
            ('heredoc marker inside quotes drops the rest', "echo '<<X'\nsupersecret", 'echo <q> ...'),
        ])

    def test_unknown_program_names_are_placeholders_everywhere(self):
        self.assertShapes([
            ('first word', 'supersecret', '<cmd>'),
            ('after pipe', 'echo x | supersecret', 'echo <w> | <cmd>'),
            ('after semicolon', 'ls; supersecret', 'ls ; <cmd>'),
            ('after and', 'ls && supersecret', 'ls && <cmd>'),
            ('in command substitution', 'echo $(supersecret)', 'echo $( <cmd> )'),
            ('in backticks', 'echo `supersecret`', 'echo ` <cmd> `'),
            ('in a subshell', '(supersecret)', '( <cmd> )'),
            ('after a wrapper', 'sudo supersecret', 'sudo <cmd>'),
            ('after a runner and --', 'offbox run -- supersecret', 'offbox run -- <cmd>'),
            ('path to an unknown program', '/opt/x/bin/supersecret', '<path>'),
            ('known program with a version', 'python3.15 -V', 'python3.15 -V'),
            ('known program through a path', '/opt/homebrew/bin/t3ctl status', 't3ctl status'),
        ])

    def test_extensions_come_from_a_fixed_list(self):
        self.assertShapes([
            ('known extension', 'python3 a/b.py', 'python3 <path.py>'),
            ('known extension, upper case', 'cat A.JSON', 'cat <path.json>'),
            ('unknown extension', 'cat notes.hunter', 'cat <path>'),
            ('unknown extension on a path', 'cat /x/y.hunter2', 'cat <path>'),
            ('unknown extension as program', './run.supersecr', '<path>'),
        ])
        self.assertNotIn('hunter2', toollog.command_shape('cat /x/y.hunter2'))

    def test_fuzzed_shell_syntax_never_leaks_a_marker(self):
        import random
        marker = 'zqxmark'
        # Upper-case env var NAMES are kept by design; the marker is lower case.
        fragments = [
            marker, '-p' + marker, '-' + marker, '\\' + marker, marker + '\\', '$' + marker, './' + marker,
            '/x/' + marker, '~/' + marker, "'" + marker, '"' + marker, marker + '"', marker + "'", 'X=' + marker,
            marker + '=1', 'a.' + marker, marker + '.py', '--k=' + marker, '-k=' + marker, '\\;', '\\|', '\\ ',
            ';', '|', '||', '&&', '&', '(', ')', '$(', '`', '>', '>>', '2>&1', '<', '<<<', '<<EOF', "<<'A-B'",
            '<<-X', '<<', '\n', '\nEOF\n', '\nA-B\n', '\n\tX\n', '\\\n', '--', '-- ', ' ', ' ', ' ', 'cat', 'offbox run',
            'sudo', 'env', 'find', '-name', 'git', 'status', '-u', '-rf', 'E"O"F', '{', '}', '*', '=', ':', ',',
        ]
        rng = random.Random(245)
        for _ in range(4000):
            command = ''.join(rng.choice(fragments) + rng.choice(['', ' ', ' ']) for _ in range(rng.randint(1, 14)))
            shape = toollog.command_shape(command)
            with self.subTest(command=command):
                self.assertNotIn(marker, shape or '')
                if shape is not None:
                    self.assertRegex(shape, toollog._SHAPE_TEXT)

    def test_no_secret_or_path_text_survives_and_alphabet_holds(self):
        commands = [
            'mysql -pHunter2 -u root db', 'curl -H "Authorization: Bearer xyz789" https://api.example.com/v1',
            'MYVAR=hunter2 node -e "require(\'fs\')"', 'PRIVATE_FIXTURE', 'deploy private-fixture', 'export TOKEN=supersecret',
            'sk-ab12cd34ef56 --key sk-ab12cd34ef56', 'cat /Volumes/ExternalSSD/userdata/private-fixture.txt',
            "python3 <<'EOF'\nprint('hunter2 4242')\nEOF", 'echo hunter2 | sudo -S -p "" ls',
            'x' * 5000, ' && '.join(['ls /Volumes/a'] * 200),
        ]
        for command in commands:
            with self.subTest(command=command[:40]):
                shape = toollog.command_shape(command)
                self.assertIsNotNone(shape)
                self.assertRegex(shape, toollog._SHAPE_TEXT)
                self.assertLessEqual(len(shape), 240)
                self.assertNotIn('/', shape)
                for secret in self.SECRETS:
                    self.assertNotIn(secret, shape)

    def test_hook_writes_shape_and_project_for_refusals_only(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT': temp + '/logs',
                'ROBOB_THREAD_ID': '', 'ROBOB_CARD_NUMBER': ''}), \
                patch.object(toollog.random, 'random', return_value=0):
            repo = Path(temp) / 'fixture-repo'
            (repo / '.git/worktrees/task').mkdir(parents=True)
            worktree = Path(temp) / 'task-branch'
            worktree.mkdir()
            (worktree / '.git').write_text(f'gitdir: {repo}/.git/worktrees/task\n')
            command = "sqlite3 /private-fixture/db.sqlite 'select hunter2'"
            toollog.hook('codex', 'statev2', 'denied', 'live-database-script', 0, command,
                         ids={'sessionId': 'shape-fixture'}, cwd=str(worktree))
            toollog.hook('codex', 'statev2', 'allowed', 'no-policy', 0, command,
                         ids={'sessionId': 'shape-fixture'}, cwd=str(repo))
            rows = list(toollog.read('agent-tools', datetime.now(timezone.utc).strftime('%Y-%m-%d')))
            self.assertEqual(rows[0]['props']['cmdShape'], 'sqlite3 <path.sqlite> <q>')
            self.assertEqual(rows[0]['props']['project'], 'fixture-repo')
            # Every row a test process writes is marked, so refusalShapes can drop it.
            self.assertEqual(rows[0]['props']['source'], 'test')
            self.assertNotIn('cmdShape', rows[1]['props'])
            self.assertNotIn('project', rows[1]['props'])
            for leaky in ('mysql -psupersecret -u root', "cat <<'END-OF-DATA'\nsupersecret\nEND-OF-DATA",
                          'echo super\\;secret', 'supersecret --x'):
                toollog.hook('codex', 'statev2', 'denied', 'live-database-script', 0, leaky,
                             ids={'sessionId': 'shape-fixture'}, cwd=str(worktree))
            day_file = Path(temp) / 'logs/agent-tools' / (datetime.now(timezone.utc).strftime('%Y-%m-%d') + '.ndjson')
            self.assertNotIn('secret', day_file.read_text())
            text = json.dumps(rows)
            self.assertNotIn('hunter2', text)
            self.assertNotIn('private-fixture', text)
            self.assertEqual(toollog.cwd_project(str(repo / 'sub')), 'fixture-repo')
            self.assertIsNone(toollog.cwd_project(temp))
            self.assertIsNone(toollog.cwd_project(None))

    def test_metadata_boundary_rejects_unsafe_shapes(self):
        for value, kept in [('git status', True), ('cat /etc/passwd', False), ("echo 'x'", False),
                            ('a' * 241, False), (42, False), ('', False)]:
            with self.subTest(value=str(value)[:20]):
                self.assertEqual('cmdShape' in toollog._metadata({'cmdShape': value}, toollog._FIELDS), kept)


if __name__ == '__main__':
    unittest.main()
