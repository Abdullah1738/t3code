"""Probe source survives an install while the client waits; crashes never own command status."""
import ast
import base64
from contextlib import ExitStack
import importlib.util
import inspect
import itertools
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import offbox_disk_space as disk
from offbox_lib import runs

TRACEBACK = '''Traceback (most recent call last):
  File "<string>", line 1, in <module>
  File "<string>", line 31
    probe()
IndentationError: expected an indented block after 'if' statement on line 29
'''
# The two tracebacks in 49df (also d1d7), without its run id or box details.
OLD_WRAPPER_LOG = 'offbox evidence wrapper pid=158288\n' + TRACEBACK * 2


def load_copy(path):
    spec = importlib.util.spec_from_file_location('isolated_disk_probe', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decode(payload):
    return zlib.decompress(base64.b64decode(payload)).decode()


def python_bodies(script):
    """Unwrap shell literals, heredocs and Python subprocess argv, including bounded()."""
    bodies, visited = [], set()

    def python(source):
        tree = ast.parse(source)
        bodies.append(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.List, ast.Tuple)):
                try:
                    args = []
                    for element in node.elts:
                        try:
                            args.append(ast.literal_eval(element))
                        except (ValueError, TypeError):
                            break
                except (ValueError, TypeError):
                    continue
                if args and isinstance(args[0], str) and Path(args[0]).name.startswith('python') and '-c' in args:
                    python(args[args.index('-c') + 1])

    def shell(source):
        if source in visited:
            return
        visited.add(source)
        # All generated Python heredocs have a literal OFFBOX_* terminator.
        pattern = r"<<[\"']?(OFFBOX_\w+)[\"']?\n(.*?)\n\1"
        for match in re.finditer(pattern, source, re.S):
            python(match[2])
        source = re.sub(pattern, '', source, flags=re.S)
        tokens = shlex.split(source, comments=True)
        for i, token in enumerate(tokens):
            if token.startswith('__obsp='):
                python(decode(token.partition('=')[2]))
            if Path(token).name in ('python', 'python3', 'python3.12'):
                j = i + 1
                while j < len(tokens) and tokens[j] in ('-I', '-u'):
                    j += 1
                if j + 1 < len(tokens) and tokens[j] == '-c':
                    python(tokens[j + 1])
            # exit_recording_command passes the whole inner script as a quoted bash argument.
            if '\n' in token and ('python3' in token or '__obsp=' in token):
                shell(token)
    shell(script)
    return bodies


class DiskProbeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.log = self.root / 'run.log'

    def test_payload_is_byte_identical_and_frozen_across_module_rewrite(self):
        path = self.root / 'offbox_disk_space.py'
        shutil.copyfile(disk.__file__, path)
        module = load_copy(path)
        source = ('import os,json,re,subprocess,sys\nfrom pathlib import Path\n'
                  f'WARN_BYTES={module.WARN_BYTES}\nGATE_BYTES={module.GATE_BYTES}\nMARKER={module.MARKER!r}\n'
                  + '\n'.join(inspect.getsource(f) for f in (module.snapshot, module.warning, module.probe)) + '\nprobe()\n')
        before = module.probe_payload()
        self.assertEqual(before, base64.b64encode(zlib.compress(source.encode())).decode())
        path.write_text('\n' * 10 + path.read_text())
        after = module.probe_payload()
        compile(decode(after), '<probe>', 'exec')
        self.assertEqual(before, after)

    def test_import_source_failure_has_valid_successful_fallback(self):
        for error in (OSError('source unavailable'), SyntaxError('broken source')):
            with self.subTest(error=type(error).__name__):
                path = self.root / 'offbox_disk_space.py'
                shutil.copyfile(disk.__file__, path)
                with patch('inspect.getsource', side_effect=error):
                    module = load_copy(path)
                body = decode(module.probe_payload())
                compile(body, '<fallback>', 'exec')
                result = subprocess.run([sys.executable, '-I', '-c', body], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0)
                self.assertIn('offbox-space-probe-error: ' + type(error).__name__, result.stderr)

    def test_compile_failure_uses_fallback(self):
        path = self.root / 'offbox_disk_space.py'
        shutil.copyfile(disk.__file__, path)
        with patch('inspect.getsource', return_value='if True:\n'):
            module = load_copy(path)
        self.assertIn('IndentationError', module.PROBE_PAYLOAD_ERROR)
        compile(decode(module.probe_payload()), '<fallback>', 'exec')

    def script(self, payload, steps=None):
        with ExitStack() as stack:
            for name in ('GO_REPAIR', 'DOCKER_REPAIR', 'SQLITE_SETUP', 'LDCACHE_REPAIR', 'CACHE_OWNER_REPAIR', 'WATCH_REPAIR'):
                stack.enter_context(patch.object(runs, name, ':'))
            stack.enter_context(patch.object(runs.userns, 'setup', return_value=':'))
            stack.enter_context(patch.object(runs.containers, 'script', return_value=':'))
            stack.enter_context(patch.object(runs.api, 'BACKEND', 'boat'))
            stack.enter_context(patch.object(disk, 'probe_payload', return_value=payload))
            return runs.remote_script('repo', '.', ['echo command-ran; exit 7'], None, 'run-probe',
                                      steps=steps, repo_root=self.root)

    def execute(self, script):
        (self.root / 'repo').mkdir(exist_ok=True)
        env = {'HOME': str(self.root), 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
        return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=30)

    def test_start_gate_and_end_probe_cannot_replace_command_exit(self):
        for start, end in itertools.product((0, 1, 90), (0, 1, 90)):
            with self.subTest(start=start, end=end):
                body = f'import sys\nsys.exit({start} if sys.argv[1] == "start" else {end})\n'
                payload = base64.b64encode(zlib.compress(body.encode())).decode()
                result = self.execute(self.script(payload))
                self.assertEqual(result.returncode, 90 if start == 90 else 7)
                self.assertEqual('command-ran' in result.stdout, start != 90)
                if start == 1:
                    self.assertIn('offbox: disk-space probe failed (exit 1); the command runs without disk evidence', result.stderr)

    def test_old_probe_crash_is_infra_for_known_or_unknown_exit(self):
        self.log.write_text(OLD_WRAPPER_LOG)
        for code in (90, None):
            with self.subTest(code=code):
                record = disk.result(self.log, code)
                self.assertEqual(record['disk_probe_error'], TRACEBACK.splitlines()[-1])
                self.assertEqual(record['infra_failure'], 'disk_probe')
                self.assertEqual(record['infra_reason'], 'probe_crashed')
                self.assertIsNone(record['command_exit_code'])
                self.assertIn('nothing ran. Rerun.', disk.message(record))

    def test_other_probe_exception_lines_are_recorded(self):
        for name in ('SyntaxError', 'TabError', 'NameError', 'RuntimeError', 'Exception'):
            with self.subTest(name=name):
                text = TRACEBACK.replace(TRACEBACK.splitlines()[-1], name + ': bad probe')
                self.log.write_text(text)
                record = disk.result(self.log, 90)
                self.assertEqual(record['disk_probe_error'], name + ': bad probe')
                self.assertEqual(record['infra_failure'], 'disk_probe')

    def test_probe_notice_preserves_actual_command_result_and_gate(self):
        notice = 'offbox: disk-space probe failed (exit 1); the command runs without disk evidence\n'
        for code in (0, 1, 7, 90):
            with self.subTest(code=code):
                self.log.write_text(TRACEBACK + notice + f'offbox-command-started: {self.log.stem}\n')
                record = disk.result(self.log, code)
                self.assertEqual(record['command_exit_code'], code)
                self.assertIsNone(record['infra_failure'])
                self.assertIn('IndentationError', record['disk_probe_error'])
        self.log.write_text(TRACEBACK + disk.MARKER + json.dumps(dict(phase='gate', space={})) + '\n')
        self.assertEqual(disk.result(self.log, 90)['infra_failure'], 'enospc')
        self.log.write_text(f'offbox-command-started: {self.log.stem}\n' + TRACEBACK)
        self.assertNotIn('disk_probe_error', disk.result(self.log, 90))

    def test_saved_unknown_wrapper_probe_failure_survives_missing_log(self):
        previous = dict(disk_space={}, infra_failure='disk_probe', infra_reason='probe_crashed',
                        command_exit_code=None, wrapper_exit_code=None, disk_probe_error='IndentationError: broken')
        (self.root / 'run-test.state.json').write_text(json.dumps(previous))
        with patch.object(runs, 'LOGS_DIR', self.root), patch.object(runs, 'say') as say:
            self.assertEqual(runs.space_result('run-test', 90, report=True), 90)
        say.assert_called_once_with(disk.message(previous))

    def test_clean_retry_clears_saved_probe_error(self):
        (self.root / 'run-test.state.json').write_text(json.dumps(dict(disk_probe_error='NameError: old probe')))
        self.log.write_text(disk.MARKER + json.dumps(dict(phase='start', space={})) + '\n')
        with patch.object(runs, 'LOGS_DIR', self.root), patch.object(runs, 'save_run_state') as save, patch('toollog.emit'):
            self.assertEqual(runs.space_result('run-test', 0, self.log), 0)
        self.assertIsNone(save.call_args.kwargs['disk_probe_error'])
        self.assertIsNone(save.call_args.kwargs['infra_failure'])

    def test_end_failure_does_not_attribute_the_commands_traceback_to_probe(self):
        self.log.write_text(f'offbox-command-started: {self.log.stem}\n' + TRACEBACK + disk.PROBE_BEGIN_MARKER + 'end\n' +
                            disk.PROBE_ERROR_MARKER + 'end probe failed (exit 1)\n')
        record = disk.result(self.log, 90)
        self.assertEqual(record['disk_probe_error'], disk.PROBE_ERROR_MARKER + 'end probe failed (exit 1)')
        self.assertIsNone(record['infra_failure'])
        self.assertEqual(record['command_exit_code'], 90)

    def test_authoritative_probe_diagnostics_preserve_command_exit_90(self):
        for started in (True, False):
            with self.subTest(started=started):
                self.log.write_text(TRACEBACK + (f'offbox-command-started: {self.log.stem}\n' if started else ''))
                record = disk.result(self.log, 90)
                self.log.write_text(disk.MARKER + json.dumps(dict(phase='result', attempt=1, record=record)) + '\n')
                observed = disk.result(self.log, 90)
                self.assertEqual(observed['infra_failure'], None if started else 'disk_probe')
                self.assertEqual(observed['command_exit_code'], 90 if started else None)

    def test_old_step_crash_records_infra_and_message(self):
        self.log.write_text(OLD_WRAPPER_LOG)
        row = dict(run_id='run-test', step_count=4, command_id='command-test')
        for code in (90, None):
            with self.subTest(code=code), ExitStack() as stack:
                stack.enter_context(patch.object(runs, 'LOGS_DIR', self.root))
                save = stack.enter_context(patch.object(runs, 'save_run_state'))
                stack.enter_context(patch.object(runs, 'log'))
                stack.enter_context(patch('toollog.emit'))
                say = stack.enter_context(patch.object(runs, 'say'))
                settled = runs.settled_steps_code(row, code, log_path=self.log, catch_up=False, history_result='complete')
                self.assertEqual(settled, 90)
                self.assertEqual(runs.space_result('run-test', settled, self.log, report=True), 90)
                self.assertEqual(save.call_args.kwargs['infra_failure'], 'disk_probe')
                self.assertIsNone(save.call_args.kwargs['command_exit_code'])
                say.assert_called_once_with(disk.message(dict(infra_failure='disk_probe')))

    def test_diagnostic_logged_once_with_client_start_and_module_mtime(self):
        (self.root / 'run-test.state.json').write_text(json.dumps(dict(client_started_at=123)))
        with patch.object(runs, 'LOGS_DIR', self.root), patch.object(runs, 'log') as log, \
             patch.dict(os.environ, {'OFFBOX_LOG_DIR': str(self.root / 'analytics')}):
            runs.log_probe_error('run-test', 'IndentationError: broken')
            runs.log_probe_error('run-test', 'IndentationError: broken')
        lines = (self.root / 'run-test.client.log').read_text().splitlines()
        self.assertEqual(lines[0], disk.PROBE_INVALID)
        event = json.loads(lines[1])
        self.assertEqual(event['client_started_at'], 123)
        self.assertEqual(event['disk_probe_module_mtime'], Path(disk.__file__).stat().st_mtime)
        log.assert_called_once()
        events = list((self.root / 'analytics').glob('*.ndjson'))
        props = json.loads(events[0].read_text().splitlines()[0])['props']
        self.assertEqual(props['client_started_at'], 123)
        self.assertEqual(props['disk_probe_module_mtime'], Path(disk.__file__).stat().st_mtime)
        self.assertEqual(props['infra_failure'], 'disk_probe')
        self.assertEqual(props['infra_reason'], 'probe_crashed')
        self.assertNotIn('disk_probe_error', props)

    def test_queued_plain_and_steps_survive_temp_reinstall(self):
        install = self.root / 'install'
        shutil.copytree(SCRIPTS.parent, install, ignore=shutil.ignore_patterns('tests', '__pycache__'))
        # install.zsh stages this wrapper outside the scripts tree.
        (install / 'tools').mkdir(exist_ok=True)
        shutil.copyfile(runs.quint_tools.wrapper_path(), install / 'tools/quint')
        child = r'''import base64,json,os,subprocess,sys,zlib
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import offbox_disk_space as disk
from offbox_lib import common, quint_tools, runs
common.SKILL_DIR = Path(sys.argv[1]).parent
assert quint_tools.wrapper_path() == common.SKILL_DIR / 'tools/quint'
before = disk.probe_payload()
print('queue-ready', flush=True)
sys.stdin.readline()
assert disk.probe_payload() == before
compile(zlib.decompress(base64.b64decode(before)), '<frozen probe>', 'exec')
for name in ('GO_REPAIR', 'DOCKER_REPAIR', 'SQLITE_SETUP', 'LDCACHE_REPAIR', 'CACHE_OWNER_REPAIR', 'WATCH_REPAIR'):
    setattr(runs, name, ':')
runs.userns.setup = lambda *a: ':'
runs.containers.script = lambda *a, **kw: ':'
runs.api.BACKEND = 'boat'
root = Path(sys.argv[2])
(root / 'repo').mkdir()
for steps in (None, ['echo step-one', 'echo step-two']):
    script = runs.remote_script('repo', '.', ['echo command-ran; exit 7'], None, 'run-simulation',
                                steps=steps, repo_root=root)
    p = subprocess.run(['bash', '-c', script], env={'HOME': str(root), 'PATH': os.environ['PATH']},
                       capture_output=True, text=True, timeout=30)
    assert p.returncode == (7 if steps is None else 0), p.stderr
    assert '"phase": "start"' in p.stderr and '"phase": "end"' in p.stderr, p.stderr
    assert ('command-ran' if steps is None else 'step-two') in p.stdout, p.stdout
    assert 'probe failed' not in p.stderr
    print(json.dumps(dict(mode='steps' if steps else 'plain', exit=p.returncode,
                          disk_start=True, disk_end=True, payload_unchanged=True)), flush=True)
'''
        process = subprocess.Popen([sys.executable, '-I', '-u', '-c', child, str(install / 'scripts'), str(self.root)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'queue-ready')
            # Reinstall into the private install dir while the already-imported client waits.
            for source in SCRIPTS.glob('*.py'):
                shutil.copyfile(source, install / 'scripts' / source.name)
            path = install / 'scripts/offbox_disk_space.py'
            path.write_text('\n' * 10 + path.read_text())
            stdout, stderr = process.communicate('resume\n', timeout=90)
            self.assertEqual(process.returncode, 0, stderr)
            results = [json.loads(line) for line in stdout.splitlines()]
            self.assertEqual([r['mode'] for r in results], ['plain', 'steps'])
            self.assertTrue(all(r['disk_start'] and r['disk_end'] and r['payload_unchanged'] for r in results))
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_all_generated_python_snippets_compile(self):
        (self.root / 'package.json').write_text(json.dumps({'packageManager': 'pnpm@10.0.0'}))
        node = runs.node_version.block(([(22000000, 23000000)], 'node 22'))
        pnpm = runs.pnpm_version.block(('10.0.0', 'packageManager'))
        count = 0
        for backend, steps, node_pin, pnpm_pin, bg, gate in itertools.product(
                ('boat', 'server'), (None, ['true', 'false']), *[(False, True)] * 4):
            with self.subTest(backend=backend, steps=bool(steps), node_pin=node_pin, pnpm_pin=pnpm_pin, bg=bg, gate=gate), \
                 patch.object(runs.api, 'BACKEND', backend), \
                 patch.object(disk, 'probe_payload', return_value=base64.b64encode(zlib.compress(
                     decode(disk._PROBE_PAYLOAD).replace(f'GATE_BYTES={disk.GATE_BYTES}',
                                                       f'GATE_BYTES={disk.GATE_BYTES if gate else 0}').encode())).decode()):
                script = runs.remote_script('repo', '.', ['true'], None, 'run-compile', steps=steps,
                                            node=(node if node_pin else '') + '\n' + (pnpm if pnpm_pin else ''), repo_root=self.root,
                                            wait_images=True, repo_key='crpko-devops' if node_pin else '')
                if bg:
                    script = runs.exit_recording_command(script, 'run-compile')
                bodies = python_bodies(script)
                self.assertGreater(len(bodies), 3)
                for body in bodies:
                    compile(body, '<embedded python>', 'exec')
                count += 1
        self.assertEqual(count, 64)

    def test_mutated_generated_snippet_is_rejected(self):
        with patch.object(runs.run_evidence, 'WRITER', 'if True:'):
            script = runs.remote_script('repo', '.', [], None, 'run-compile', steps=['true'], repo_root=self.root)
        with self.assertRaises(SyntaxError):
            python_bodies(runs.exit_recording_command(script, 'run-compile'))

    def test_snippet_extractor_rejects_broken_heredoc_inline_and_bounded_body(self):
        for script in ("python3 - <<'OFFBOX_TEST'\nif True:\n\nOFFBOX_TEST",
                       "python3 -I -c 'if True:'",
                       "python3 - <<'OFFBOX_TEST'\nbounded(['python3', '-c', 'if True:'], 2)\nOFFBOX_TEST"):
            with self.subTest(script=script), self.assertRaises(SyntaxError):
                python_bodies(script)


# Existing fixture keeps state DBs, analytics and backend calls isolated.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated


class DiskProbeStateTests(Isolated):
    def test_catch_up_precedes_probe_attribution_for_delayed_command_stderr(self):
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_LOG_DIR': str(Path(self.tmp.name) / 'analytics')}))
        for backend, nested, steps in itertools.product(('boat', 'server'), (False, True), (0, 4)):
            with self.subTest(backend=backend, nested=nested, steps=steps):
                rid = f'run-delayed-{backend}-{nested}-{steps}'
                self.con.execute("INSERT INTO runs(run_id,status,mode,step_count,command_id) VALUES (?,'running','remote',?,'command-test')", (rid, steps))
                self.con.commit()
                path = runs.LOGS_DIR / (rid + '.log')
                path.write_text(TRACEBACK if nested else '  File "<string>", line 1\nSyntaxError: invalid syntax\n')
                def catch_up(*args, **kw):
                    with path.open('a') as output:
                        output.write('offbox-command-started: ' + rid + '\n')
                        output.write(''.join(f'offbox step {n} rc=90: python\n' for n in range(1, steps + 1)))
                    return 'complete'
                with patch.object(runs.api, 'BACKEND', backend), patch('offbox_lib.misc._catch_up_log', side_effect=catch_up) as recover:
                    self.assertEqual(runs.finish(rid, 90, bookkeeping=False), 90)
                # Plain single-frame errors are never candidates; every candidate or step log is recovered.
                if nested or steps:
                    recover.assert_called_once()
                record = json.loads((runs.LOGS_DIR / (rid + '.state.json')).read_text())
                self.assertEqual(record['command_exit_code'], 90)
                self.assertIsNone(record['infra_failure'])

    def test_incomplete_history_cannot_claim_nothing_ran(self):
        for backend, steps, history in itertools.product(('boat', 'server'), (0, 4), ('unavailable', 'partial', None)):
            with self.subTest(backend=backend, steps=steps, history=history):
                rid = f'run-incomplete-{backend}-{steps}-{history}'
                path = runs.LOGS_DIR / (rid + '.log')
                path.write_text(OLD_WRAPPER_LOG)
                self.con.execute("INSERT INTO runs(run_id,status,mode,step_count,command_id) VALUES (?,'running','remote',?,'command-test')", (rid, steps))
                self.con.commit()
                with patch.object(runs.api, 'BACKEND', backend), patch('offbox_lib.misc._catch_up_log', return_value=history):
                    with self.assertRaisesRegex(runs.OffboxError, 'execution is unknown'):
                        runs.finish(rid, 90, bookkeeping=False)
                row = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.assertEqual(tuple(row), ('running', None))
                self.assertFalse((runs.LOGS_DIR / (rid + '.state.json')).exists())

    def test_reaper_recovers_plain_background_probe_crash_before_settlement(self):
        from offbox_lib import reap, misc, lease, pool
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_LOG_DIR': str(Path(self.tmp.name) / 'analytics')}))
        for backend, caller, fail_once in itertools.product(('boat', 'server'), ('reaper', 'pool'), (False, True)):
            with self.subTest(backend=backend, caller=caller, fail_once=fail_once):
                label = caller + '-' + backend + '-' + str(fail_once)
                bid, rid = 'bx_' + label, 'run-' + label
                self.box(bid, member=True)
                path = runs.LOGS_DIR / (rid + '.log')
                self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,step_count,process_id,command_id,log_path) VALUES (?,?,'running','bg',0,123,'command-test',?)", (rid, bid, str(path)))
                self.con.commit()
                history_failed = False
                def history(box, command, which, offset, **kwargs):
                    nonlocal history_failed
                    if fail_once and not history_failed:
                        history_failed = True
                        raise runs.OffboxError('history temporarily unavailable')
                    data = OLD_WRAPPER_LOG if which == 'stderr' else ''
                    return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
                with ExitStack() as stack:
                    stack.enter_context(patch.object(runs.api, 'BACKEND', backend))
                    stack.enter_context(patch.object(reap, 'require_mine'))
                    stack.enter_context(patch.object(runs, 'reconcile_lost'))
                    stack.enter_context(patch.object(runs.api, 'cmd_status', return_value=dict(running=False, status='exited', exitCode=90)))
                    stack.enter_context(patch.object(runs.api, 'history_logs', side_effect=history))
                    stack.enter_context(patch.object(runs.api, 'get', return_value=None))
                    stack.enter_context(patch.object(runs, 'settle_docker'))
                    stack.enter_context(patch.object(lease, 'idle_ttl'))
                    def recover():
                        if caller == 'reaper':
                            reap._check_unlocked(self.con, bid, 'running', False, [])
                        else:
                            pool._refresh_background(self.con, 'repo')
                    if fail_once:
                        try:
                            recover()
                        except runs.OffboxError as error:
                            self.assertIn('execution is unknown', str(error))
                        before = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()
                        self.assertEqual(tuple(before), ('running', None))
                    recover()
                row = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.assertEqual(tuple(row), ('infra', 90))
                record = json.loads((runs.LOGS_DIR / (rid + '.state.json')).read_text())
                self.assertEqual(record['infra_failure'], 'disk_probe')
                self.assertIsNone(record['command_exit_code'])

    def test_finish_records_zero_step_probe_crash_as_infra_exit_90(self):
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_LOG_DIR': str(Path(self.tmp.name) / 'analytics')}))
        for incoming in (None, 90):
            with self.subTest(incoming=incoming):
                rid = 'run-probe-' + str(incoming)
                self.con.execute("INSERT INTO runs(run_id,status,mode,step_count) VALUES (?,'running','remote',4)", (rid,))
                self.con.commit()
                (runs.LOGS_DIR / (rid + '.log')).write_text(OLD_WRAPPER_LOG)
                self.assertEqual(runs.finish(rid, incoming, catch_up=False, bookkeeping=False), 90)
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.assertEqual((row['status'], row['exit_code']), ('infra', 90))
                record = json.loads((runs.LOGS_DIR / (rid + '.state.json')).read_text())
                self.assertEqual(record['infra_failure'], 'disk_probe')
                self.assertIsNone(record['command_exit_code'])
                self.assertEqual(record['wrapper_exit_code'], incoming)


if __name__ == '__main__':
    unittest.main()
