"""Keep one pooled lease while running fresh, explicitly assigned benchmark processes."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, signal, socket, sqlite3, subprocess, time

DATA_ROOT = Path('/dev/shm/robob-overload-1352')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.new')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temporary, path)

def identity():
    hostname = socket.gethostname()
    box = 'bx_' + hostname[3:] if hostname.startswith('bx-') and len(hostname) == 11 else None
    return {'offboxBoxId': box, 'hostname': hostname, 'incusContainerId': next((os.environ[k] for k in ('INCUS_INSTANCE_ID', 'container_uuid', 'LXC_NAME') if os.environ.get(k)), None),
            'incusContainerIdAvailability': 'known process environment keys; hostname is also observed',
            'parentOffboxRunId': os.environ.get('OFFBOX_RUN_ID')}

def inventory():
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            stat = (path / 'stat').read_text()
            fields = stat[stat.rfind(') ') + 2:].split()
            rows.append({'pid': int(path.name), 'ppid': int(fields[1]),
                         'comm': (path / 'comm').read_text().strip(),
                         'state': fields[0], 'cgroup': (path / 'cgroup').read_text().strip()})
        except (OSError, ValueError, IndexError):
            continue
    return rows

def data_directory(batch, arm):
    if not isinstance(batch, int) or not 3 <= batch <= 8 or arm not in ('A', 'B', 'C'):
        raise ValueError('Invalid owned batch directory')
    return DATA_ROOT / f'{batch}-{arm}'

def reset_directory(batch, arm, previous):
    target = data_directory(batch, arm)
    if DATA_ROOT.is_symlink():
        raise RuntimeError('Owned data root is a symlink')
    old = {'path': None, 'gone': True, 'initial': True}
    if previous is not None:
        previous = Path(previous)
        # Only our exact generated names are eligible for this sanctioned cleanup.
        name = previous.name.split('-')
        if len(name) != 2 or previous != data_directory(int(name[0]), name[1]):
            raise ValueError('Refusing cleanup outside the owned batch directory')
        if previous.is_symlink():
            raise ValueError('Refusing a symlink as a prior data directory')
        existed = previous.exists()
        if existed:
            shutil.rmtree(previous)
        old = {'path': str(previous), 'gone': not previous.exists(), 'existedBefore': existed}
        if not old['gone']:
            raise RuntimeError('Previous data directory survived cleanup')
    if DATA_ROOT.is_symlink() or target.exists() or target.is_symlink():
        raise RuntimeError('Fresh data directory already exists or root is a symlink')
    target.mkdir(parents=True, mode=0o700)
    return {'path': str(target), 'existedBefore': False, 'created': True}, old

def launch_links(result):
    home = Path(result['home'])
    if not home.resolve().is_relative_to(DATA_ROOT.resolve()):
        raise ValueError('Synthetic database escaped the owned tmpfs root')
    path = home / 'userdata/boards.sqlite'
    connection = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
    rows = []
    try:
        query = "SELECT t.thread_id,t.json,c.id,c.json,b.json FROM ardud_kanban_threads t JOIN ardud_kanban_cards c ON c.id=t.card_id JOIN ardud_kanban_boards b ON b.id=t.board_id WHERE t.thread_id GLOB 'load-launched-*' ORDER BY t.thread_id"
        for tid, thread_json, cid, card_json, board_json in connection.execute(query):
            thread, card, board = map(json.loads, (thread_json, card_json, board_json))
            chain_name = card.get('reviewChain') or board.get('defaultReviewChain')
            chain = next((x for x in board.get('reviewChains', []) if x.get('name') == chain_name), None)
            rows.append({'threadId': tid, 'cardId': cid, 'role': thread.get('role'),
                         'startedAt': thread.get('startedAt'), 'reviewStep': card.get('reviewStep'),
                         'chainLength': len(chain['steps']) if chain else 0})
    finally:
        connection.close()
    return {'home': str(home), 'readOnly': True, 'rows': rows}

def finish_artifacts(run_output, exit_code):
    error = None
    try:
        result_path = run_output / 'run/result.json'
        if result_path.exists():
            result = json.loads(result_path.read_text())
            write_json(run_output / 'launch-links.json', launch_links(result))
    except Exception as failure:
        error = {'type': type(failure).__name__, 'message': str(failure)}
        write_json(run_output / 'artifact-error.json', error)
    finally:
        write_json(run_output / 'COMPLETE.json', {'exitCode': exit_code,
                   'artifactReadyAtMs': time.time() * 1000, 'artifactError': error})

def managed_run(command, cwd, should_stop, output=None):
    if should_stop():
        raise InterruptedError('Suite setup cancelled')
    process = subprocess.Popen(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                               start_new_session=True)
    try:
        while process.poll() is None:
            if should_stop():
                raise InterruptedError('Suite setup cancelled')
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()

def prepare(root, output, sources, should_stop):
    repositories = {}
    for arm, source in sources.items():
        revision = source['productRevision']
        subprocess.run(['git', 'cat-file', '-e', revision + '^{commit}'], cwd=root, check=True)
        destination = output / 'repos' / arm
        destination.parent.mkdir(parents=True, exist_ok=True)
        managed_run(['git', 'worktree', 'add', '--detach', str(destination), revision], root, should_stop)
        for name, expected in source['files'].items():
            original = root / name
            if digest(original) != expected:
                raise RuntimeError('Overlay source hash differs: ' + name)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
        if digest(destination / 'packages/shared/src/nodeSqliteClient.ts') != source['productSqliteSourceHash']:
            raise RuntimeError('Product SQLite source differs')
        with (output / f'install-{arm}.log').open('w') as log:
            managed_run(['pnpm', 'install', '--frozen-lockfile'], destination, should_stop, log)
        changed = subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], cwd=destination, text=True).splitlines()
        if set(changed) - set(source['files']):
            raise RuntimeError('Product files changed outside the frozen overlay')
        repositories[arm] = destination
    return repositories

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', type=int, choices=range(3), required=True)
    parser.add_argument('--sources', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--smoke-base', action='store_true', help='base-only two-second setup verification; never a gate run')
    args = parser.parse_args()
    root = Path.cwd()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=False)
    sources = json.loads(Path(args.sources).read_text())
    actual = identity()
    if actual['offboxBoxId'] is None or not actual['parentOffboxRunId']:
        raise RuntimeError('A retained suite needs a proven Incus box and real offbox parent id')
    child = None
    lease_started = time.time() * 1000
    abort = False
    def stopped(_signal, _frame):
        nonlocal abort
        abort = True
    signal.signal(signal.SIGTERM, stopped)
    signal.signal(signal.SIGINT, stopped)
    previous = None
    reason = 'abort'
    try:
        try:
            repositories = prepare(root, output, sources, lambda: abort or (output / 'STOP.json').exists())
        except InterruptedError:
            reason = 'setup cancelled'
            return
        if args.smoke_base:
            fresh, removed = reset_directory(3, 'A', None)
            previous = fresh['path']
            env = dict(os.environ, TMPDIR=fresh['path'], OVERLOAD_BATCH='3', OVERLOAD_ARM='A')
            with (output / 'smoke.log').open('w') as log:
                subprocess.run(['node', 'scripts/overload-harness/paired-run.mjs', '--revision=' + sources['A']['productRevision'], '--warmup=0', '--seconds=2', '--out=' + str(output / 'smoke')], cwd=repositories['A'], env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            shutil.rmtree(previous)
            write_json(output / 'smoke-cleanup.json', {'path': previous, 'gone': not Path(previous).exists()})
            reason = 'base-only setup smoke complete'
            return
        write_json(output / 'suite-ready.json' , {'identity': actual, 'worker': args.worker,
                   'leaseStartedAtMs': lease_started, 'sources': sources,
                   'node': subprocess.check_output(['node', '--version'], text=True).strip()})
        for batch in range(3, 9):
            plan_path = output / f'plan-{batch}.json'
            while not plan_path.exists():
                if abort or (output / 'STOP.json').exists():
                    reason = 'controller stop' if not abort else 'signal'
                    return
                time.sleep(1)
            plan = json.loads(plan_path.read_text())
            arm = next((a for a, b in plan['assignment'].items() if b == actual['offboxBoxId']), None)
            if plan['batch'] != batch or arm not in repositories or set(plan['assignment']) != {'A', 'B', 'C'} or len(set(plan['assignment'].values())) != 3 or plan.get('rotation') not in (0, 1, 2):
                raise RuntimeError('Plan does not assign this box exactly one arm')
            run_output = output / f'attempt-{batch}'
            run_output.mkdir(exist_ok=False)
            write_json(run_output / 'plan.json', plan)
            source = sources[arm]
            source_files = {name: digest(repositories[arm] / name) for name in source['files']}
            if source_files != source['files']:
                raise RuntimeError('Runtime overlay drifted')
            write_json(run_output / 'SOURCE.json', source)
            write_json(run_output / 'input-sha256.json', source_files)
            fresh, removed = reset_directory(batch, arm, previous)
            previous = fresh['path']
            launch_identity = identity()
            if launch_identity['offboxBoxId'] != actual['offboxBoxId']:
                raise RuntimeError('Suite box identity changed before launch')
            processes = inventory()
            env = dict(os.environ, TMPDIR=fresh['path'], OVERLOAD_BATCH=str(batch), OVERLOAD_ARM=arm)
            ready, release = run_output / 'node-ready.json', run_output / 'release.json'
            write_json(release, {'epochMs': plan['releaseEpochMs']})
            command = ['node', 'scripts/overload-harness/paired-run.mjs', '--revision=' + source['productRevision'],
                       '--ready=' + str(ready), '--release=' + str(release), '--out=' + str(run_output / 'run')]
            with (run_output / 'run.log').open('w') as log:
                child = subprocess.Popen(command, cwd=repositories[arm], env=env, stdout=log, stderr=subprocess.STDOUT)
                launched = time.time() * 1000
                while child.poll() is None:
                    if abort or (output / 'STOP.json').exists():
                        child.terminate()
                        try:
                            child.wait(timeout=30)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()
                        reason = 'controller abort'
                        return
                    try:
                        child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        pass
                exit_code, node_pid = child.returncode, child.pid
                child = None
            execution = {'parentOffboxRunId': actual['parentOffboxRunId'], 'batch': batch, 'arm': arm,
                         'expectedBoxId': plan['assignment'][arm], 'nodePid': node_pid,
                         'planHash': plan['hash'], 'launchedAtMs': launched, 'launchIdentity': launch_identity,
                         'processesAtLaunch': processes, 'freshDirectory': fresh, 'previousDirectory': removed}
            write_json(run_output / 'execution.json', execution)
            write_json(run_output / 'completion.json', {'exitCode': exit_code, 'completedAtMs': time.time() * 1000,
                       'identity': identity(), 'execution': execution})
            finish_artifacts(run_output, exit_code)
        reason = 'six attempts reached'
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        write_json(output / 'lease-end.json', {'startedAtMs': lease_started, 'endedAtMs': time.time() * 1000,
                   'reason': reason, 'identity': identity()})

if __name__ == '__main__':
    main()
