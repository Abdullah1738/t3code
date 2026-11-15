"""Process labels only; argv is never retained in state or emitted."""
from pathlib import Path
import re
import shlex
import sys


def janitor_redact(value):
    # Use the reviewed #45 helper, from this checkout or its installed location.
    source = Path(__file__).resolve().parents[1] / 'dev-resource-janitor/skill/scripts'
    if not source.is_dir():
        source = Path.home() / '.config/opencode/skills/dev-resource-janitor/scripts'
    sys.path.insert(0, str(source))
    try:
        from leftover_processes import redact
        return redact(value)
    finally:
        sys.path.pop(0)


def family(command):
    name = Path(command).name
    if re.fullmatch(r'[Pp]ython(?:\d+(?:\.\d+)*)?', name):
        return 'python'
    if name.startswith('mds'):
        return 'mds*'
    # Nested helper bundles have their own basename (including Renderer/GPU).
    bundle = re.findall(r'/([^/]+)\.app/', command)
    return bundle[-1] if bundle else name


def script_hint(args):
    try:
        words = shlex.split(janitor_redact(args))
    except ValueError:
        return None
    skip = False
    module = False
    for word in words[1:]:
        if skip:
            skip = False
            continue
        if word in ('-c', '-e', '--eval', '--print', '-p') or word.startswith(('--eval=', '--print=', '-c', '-e', '-p')):
            return None  # Inline programs are contents, not script names.
        if word in ('-r', '--require', '--import', '--loader', '--experimental-loader', '-X', '-W'):
            skip = True
            continue
        if word == '-m':
            module = True
            continue
        if word.startswith('-'):
            continue
        if '[REDACTED]' in word or not word or '://' in word:
            return None
        if module:
            return word if re.fullmatch(r'[\w.]{1,72}', word) else None
        if not re.search(r'\.(?:[cm]?js|tsx?|jsx|py|sh)$', word) and '/' not in word:
            return None
        parts = word.split('/')
        for marker in ('ExternalSSD/', '.local/share/'):
            if marker in word:
                tail = word.split(marker, 1)[1].split('/')
                return '/'.join(tail) if len(tail) <= 2 else tail[0]+'/…/'+tail[-1]
        return parts[-1] or None
    return None
