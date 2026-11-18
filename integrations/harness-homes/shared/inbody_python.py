#!/usr/bin/env python3
"""Install InBody and its locked dependencies without runtime access to ExternalSSD."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib

from runtime_paths import internal_path, validate_inbody


def prepare(*, source=Path('/Volumes/ExternalSSD/inbody-api-mcp'), destination=None,
            python=Path('/opt/homebrew/opt/python@3.14/bin/python3.14'), uv='uv', dry_run=False):
    destination = internal_path(destination or Path.home() / '.local/share/shared-mcp-inbody/python')
    python = internal_path(python).resolve(strict=True)
    source = Path(source).resolve(strict=True)
    if source.is_relative_to(destination.resolve()) or destination.resolve().is_relative_to(source):
        raise ValueError('dedicated InBody Python must be separate from its source')
    version = subprocess.check_output([str(python), '-I', '-c',
        'import json, sys; print(json.dumps([list(sys.version_info[:3]), sys.base_prefix]))'], text=True)
    info, base = json.loads(version)
    if info[:2] != [3, 14]:
        raise ValueError('InBody requires an internal-disk Python 3.14')
    internal_path(base)
    # Stage only build inputs, never the source venv, credentials or runtime data.
    files = [source / name for name in ('pyproject.toml', 'uv.lock', 'README.md')]
    files += sorted((source / 'src').rglob('*.py'))
    files += [path for path in (source / 'LICENSE', source / 'LICENSE.md') if path.exists()]
    if not (source / 'src/inbody_api_mcp/server.py').is_file():
        raise ValueError('InBody source package is missing')
    project = tomllib.loads(files[0].read_text())
    lock = tomllib.loads(files[1].read_text())
    if project['project']['name'] != 'inbody-api-mcp' or not lock.get('package'):
        raise ValueError('expected the InBody project and its uv.lock')
    digest = hashlib.sha256(Path(__file__).read_bytes() + version.encode() + str(python).encode())
    for path in files:
        digest.update(str(path.relative_to(source)).encode() + b'\0' + path.read_bytes())
    fingerprint = digest.hexdigest() + '\n'
    stamp = destination / '.inbody-runtime-sha256'
    internal_path(stamp)
    interpreter = internal_path(destination / 'bin/python')
    if dry_run:
        print(f'INBODY_PYTHON_PATH={interpreter} (dry-run)')
        return
    if stamp.is_file() and stamp.read_text() == fingerprint:
        validate_inbody(interpreter)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='inbody-build-', dir=destination.parent) as tmp:
            staged = Path(tmp)
            for path in files:
                target = staged / path.relative_to(source)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
            # Copy wheel contents, rather than linking to a possibly external uv cache.
            subprocess.run([uv, 'sync', '--frozen', '--no-dev', '--no-editable',
                '--no-managed-python', '--no-python-downloads', '--link-mode', 'copy',
                '--python', str(python), '--project', str(staged)], check=True,
                env={**os.environ, 'UV_PROJECT_ENVIRONMENT': str(destination)})
        validate_inbody(interpreter)
        stamp.write_text(fingerprint)
    print(f'INBODY_PYTHON_PATH={interpreter}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/Volumes/ExternalSSD/inbody-api-mcp'))
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--python', type=Path, default=Path('/opt/homebrew/opt/python@3.14/bin/python3.14'))
    parser.add_argument('--uv', default='/opt/homebrew/bin/uv')
    parser.add_argument('--dry-run', action='store_true')
    try:
        prepare(**vars(parser.parse_args()))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        parser.exit(1, f'inbody: cannot prepare dedicated Python: {exc}\n')
