#!/usr/bin/env python3
"""Install only the shell selector. Default: print exact diffs without writing."""
import argparse
import difflib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
BEGIN = '# >>> repo-node-pin (managed by local-helpers) >>>'
END = '# <<< repo-node-pin <<<'
BLOCK = f'''{BEGIN}
[ ! -r "$HOME/.local/libexec/repo-node-pin/init.sh" ] || . "$HOME/.local/libexec/repo-node-pin/init.sh"
{END}
'''


def updated(text):
    if BEGIN in text or END in text:
        start = text.find(BEGIN)
        stop = text.find(END)
        if start < 0 or stop < start or text.count(BEGIN) != 1 or text.count(END) != 1:
            raise ValueError('incomplete/duplicate repo-node-pin block; refusing to modify')
        stop += len(END)
        if text[stop:stop + 1] == '\n':
            stop += 1
        return text[:start] + BLOCK + text[stop:]
    return text + ('\n' if text and not text.endswith('\n') else '') + '\n' + BLOCK


def plan(home):
    payload = HERE / 'libexec/repo-node-pin'
    changes = []
    for src in sorted(payload.rglob('*')):
        if not src.is_file() or '__pycache__' in src.parts:
            continue
        dst = home / '.local/libexec/repo-node-pin' / src.relative_to(payload)
        changes.append((dst, src.read_bytes(), src.stat().st_mode & 0o777))
    login = next((name for name in ['.bash_profile', '.bash_login', '.profile'] if (home / name).exists()), '.bash_profile')
    for name in ['.zshenv', '.zprofile', '.zshrc', login, '.bashrc']:
        dst = home / name
        if dst.is_symlink():
            raise ValueError(f'{dst} is a symlink; resolve its owner before installing')
        old = dst.read_text() if dst.exists() else ''
        changes.append((dst, updated(old).encode(), (dst.stat().st_mode & 0o777) if dst.exists() else 0o644))
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', help='write files after owner approval')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.install and args.check:
        parser.error('choose --install or --check')
    if args.install:
        # The evaluator merges/pushes before asking to install. Never fetch here.
        repo = HERE.parents[1]
        subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'], check=True)
        dirty = subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--', str(HERE)], text=True)
        if dirty:
            raise SystemExit('local-helpers has uncommitted changes; install a clean approved revision')
    changes = plan(Path.home())
    drift = False
    for dst, new, mode in changes:
        old = dst.read_bytes() if dst.exists() else b''
        if dst.is_symlink():
            raise SystemExit(f'{dst} is a symlink; refusing to replace it')
        if old == new and dst.exists() and dst.stat().st_mode & 0o777 == mode:
            continue
        drift = True
        print(''.join(difflib.unified_diff(old.decode().splitlines(True), new.decode().splitlines(True),
                                         fromfile=str(dst), tofile=str(dst) + ' (after)')), end='')
        if args.install:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                fd, backup = tempfile.mkstemp(prefix=dst.name + '.bak-node-pin-', dir=dst.parent)
                os.close(fd)
                shutil.copy2(dst, backup)
            fd, temp = tempfile.mkstemp(prefix=dst.name + '.new-', dir=dst.parent)
            with os.fdopen(fd, 'wb') as f:
                f.write(new)
            os.chmod(temp, mode)
            os.replace(temp, dst)
    if args.check and drift:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
