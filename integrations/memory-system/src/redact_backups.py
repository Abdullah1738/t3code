"""Rewrite encrypted recall snapshots without exposing their plaintext to output."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

from redact import RedactionError, read_needle, redact_db, redact_file, contains, atomic_write
from redact_lock import fence


def restic_env():
    env = dict(os.environ)
    if not any(env.get(k) for k in ('RESTIC_PASSWORD','RESTIC_PASSWORD_FILE','RESTIC_PASSWORD_COMMAND')):
        env['RESTIC_PASSWORD_COMMAND'] = 'security find-generic-password -s restic-memory-backup -w'
    return env


def restic(repo, *args, json_output=False):
    result = subprocess.run(['restic', '--no-cache', '-r', str(repo), *args], capture_output=True, env=restic_env(), stdin=subprocess.DEVNULL)
    if result.returncode:
        # restic errors can quote filenames or command output from a password helper.
        raise RedactionError('restic operation failed; no child output retained')
    return json.loads(result.stdout) if json_output else result.stdout


def nodes(repo, snapshot):
    # ls contains metadata only; dump streams are handled separately.
    return [r for line in restic(repo, 'ls', '--json', snapshot).splitlines()
            if (r := json.loads(line)).get('type') == 'file']


def inspect_dump(repo, snapshot, path, needle):
    proc = subprocess.Popen(['restic','--no-cache','-r',str(repo),'dump',snapshot,path],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, env=restic_env())
    hits, container = 0, False
    try:
        header = proc.stdout.read(16)
        container = header == b'SQLite format 3\0' or header.startswith((b'\x28\xb5\x2f\xfd',b'\x1f\x8b',b'PK\x03\x04'))
        if container:
            # Drain without materializing the file. Killing dump after its header
            # bypasses restic's deferred unlock and can strand a repository lock.
            while proc.stdout.read(1 << 20):
                pass
        else:
            line = header + proc.stdout.readline()
            while line:
                hits += int(contains(line,needle))
                line = proc.stdout.readline()
        if proc.wait():
            raise RedactionError('restic dump failed')
        return hits, container
    finally:
        # Parsing errors must also let the read-only child release its lock.
        while proc.stdout.read(1 << 20):
            pass
        proc.stdout.close()
        proc.wait()


def dump_hits(repo, snapshot, path, needle):
    hits, container = inspect_dump(repo,snapshot,path,needle)
    if container:
        raise RedactionError('compressed container needs semantic verification')
    return hits


def stage_sweep(stage, needle, dry_run):
    stores = {}
    for path in sorted(Path(stage).rglob('*')):
        if path.is_symlink() or not path.is_file() or path.name.endswith(('-wal','-shm','-journal')):
            continue
        with path.open('rb') as f:
            sqlite = f.read(16) == b'SQLite format 3\0'
        if sqlite:
            result, _ = redact_db(path,needle,'[redacted backup]',dry_run=dry_run)
        else:
            result = redact_file(path,needle,'[redacted backup]',dry_run=dry_run)
        stores[str(path)] = result
    return stores


def refresh_manifests(stage):
    import transcript_backup_manifest as manifests
    transcripts = Path(stage)/'files/transcripts'
    if not transcripts.is_dir():
        return None
    directory = Path(stage)/'files/transcript-manifest'
    directory.mkdir(parents=True,exist_ok=True)
    current = manifests.build(str(transcripts))
    # Existing stage manifests must no longer certify the pre-redaction bytes.
    for path in directory.glob('*.json'):
        updated = dict(current,stamp=path.stem)
        atomic_write(path,json.dumps(updated,indent=1).encode())
    path = directory/(current['stamp']+'.json')
    atomic_write(path,json.dumps(current,indent=1).encode())
    if manifests.verify(current,str(transcripts)):
        raise RedactionError('sanitized transcript manifest failed verification')
    return path


def rewrite_repo(repo, stage, needle, paths, *, dry_run):
    before_packs = {str(p.relative_to(repo)) for p in (Path(repo)/'data').rglob('*') if p.is_file()}
    for path in sorted(paths):
        if contains(path,needle):
            raise RedactionError('snapshot path intersects redaction selector')
        restic(repo,'find','--path',path,'*')
    snapshots = restic(repo,'snapshots','--json',json_output=True)
    affected = []
    for snap in snapshots:
        sid = snap['id']
        exclusions = set()
        for node in nodes(repo, sid):
            path = node['path']
            if contains(path,needle):
                raise RedactionError('snapshot path intersects redaction selector')
            # SQLite may contain zlib-compressed payloads; zst may hold compressed
            # transcripts. Exclude these historical files conservatively rather
            # than declaring a byte grep of the container to be proof of absence.
            n, header_container = inspect_dump(repo,sid,path,needle)
            container = header_container or path.endswith(('-wal','-journal','-shm'))
            if container or path in paths or n:
                exclusions.add(path)
        if exclusions:
            affected.append((sid, sorted(exclusions)))
    if not dry_run:
        for sid, exclusions in affected:
            # restic exclude arguments are glob patterns. Refuse ambiguous path
            # syntax instead of accidentally excluding another snapshot member.
            if any(any(c in p for c in '*?[]\\\n\r') for p in exclusions):
                raise RedactionError('snapshot path needs literal restic exclusion support')
            restic(repo,'rewrite','--forget',sid,*[arg for p in exclusions for arg in ('--exclude',p)])
        # Also prune leftovers from interrupted/previous rewrites with no snapshots.
        restic(repo,'prune','--max-unused','0')
        if stage:
            if any(r['remainingAfter'] for r in stage_sweep(stage,needle,False).values()):
                raise RedactionError('replica still contains matches; fresh snapshot refused')
            restic(repo,'backup','--host','ardud-mac','--tag','memory-live',str(stage))
    remaining = 0
    for snap in restic(repo,'snapshots','--json',json_output=True):
        for node in nodes(repo,snap['id']):
            path = node['path']
            if contains(path,needle):
                raise RedactionError('snapshot path intersects redaction selector')
            n, container = inspect_dump(repo,snap['id'],path,needle)
            if stage and path.startswith(str(Path(stage).resolve())+'/') and container:
                # The replacement containers were semantically swept in stage.
                continue
            remaining += int(container or n>0 or path.endswith(('-wal','-journal','-shm')))
    after_packs = {str(p.relative_to(repo)) for p in (Path(repo)/'data').rglob('*') if p.is_file()}
    return {'matchedBefore':len(affected),'replaced':0 if dry_run else len(affected),
            'remainingAfter':remaining,'packsRemoved':len(before_packs-after_packs)}


def download_cold(repo, remote):
    from dropbox_mirror import Api, dbx_hash
    api = Api()
    files = api.list_files(remote)
    if not files:
        raise RedactionError('cold archive missing locally and remotely')
    repo.mkdir(parents=True, exist_ok=True)
    for entry in files.values():
        relative = entry['path'][len(remote.rstrip('/'))+1:]
        target = repo/relative
        if not target.resolve().is_relative_to(repo.resolve()):
            raise RedactionError('unsafe cold archive path')
        target.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request('https://content.dropboxapi.com/2/files/download',
            headers={'Authorization':'Bearer '+api.tok,'Dropbox-API-Arg':json.dumps({'path':entry['path']})})
        with urllib.request.urlopen(req, timeout=120) as src, target.open('wb') as dst:
            shutil.copyfileobj(src,dst)
        if dbx_hash(target) != entry['hash']:
            raise RedactionError('cold archive download failed verification')


def mirror(repo, destination):
    result = subprocess.run([sys.executable,str(Path(__file__).with_name('dropbox_mirror.py')),
                             str(repo),destination,'--delete'],capture_output=True)
    if result.returncode:
        raise RedactionError('Dropbox mirror failed; no child output retained')
    summary = json.loads(result.stdout.splitlines()[-1])
    if not summary.get('ok') or summary.get('extras'):
        raise RedactionError('Dropbox mirror verification failed')
    return {'matchedBefore':summary['deleted'],'replaced':summary['deleted'],'remainingAfter':0}


def run(args):
    needle = read_needle(args.needle_file)
    if not args.dry_run and not args.yes:
        raise RedactionError('review --dry-run, then supply --yes for the approved mutation')
    if not shutil.which('restic'):
        raise RedactionError('restic is required')
    root = Path(args.root).resolve()
    repo = Path(args.repository).resolve()
    stage = Path(args.stage).resolve()
    if not stage.is_dir() or not (repo/'config').is_file():
        raise RedactionError('replica stage and restic repository must exist')
    paths = set()
    if args.paths_from:
        paths.update(json.loads(Path(args.paths_from).read_text()).get('paths',[]))
    stores = {}
    with fence(root,exclusive=True,blocking=False), contextlib.ExitStack() as stack:
        if (root/'logs/backup.lock').exists() or (root/'logs/state/capture.lock').exists():
            raise RedactionError('capture or backup active; retry after it finishes')
        stores.update(stage_sweep(stage,needle,args.dry_run))
        if not args.dry_run and any(r['remainingAfter'] for r in stores.values()):
            raise RedactionError('replica stage still has matches')
        manifest_path = refresh_manifests(stage) if not args.dry_run else None
        stores[str(repo)] = rewrite_repo(repo,stage,needle,paths,dry_run=args.dry_run)
        if not args.local_only:
            cold = Path(args.cold_repository).resolve()
            if not cold.exists():
                cold = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='recall-cold-')))/'repo'
                download_cold(cold,args.cold_destination)
            stores[str(cold)] = rewrite_repo(cold,None,needle,paths,dry_run=args.dry_run)
            if not args.dry_run:
                stores[args.dropbox_destination] = mirror(repo,args.dropbox_destination)
                stores[args.cold_destination] = mirror(cold,args.cold_destination)
        if manifest_path:
            import transcript_backup_manifest as manifests
            manifests.publish(str(manifest_path),str(stage/'files/transcripts'),str(root/'data/backup-manifests'))
    result = {'stores':stores,'verify':not args.dry_run and all(r['remainingAfter']==0 for r in stores.values()),
              'localOnly':args.local_only,'dropboxHistoryPurged':False,'dropboxRetentionDays':None}
    if contains(json.dumps(result),needle):
        raise RedactionError('output path intersects redaction selector')
    return result
