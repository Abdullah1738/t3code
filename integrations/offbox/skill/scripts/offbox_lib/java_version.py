"""Select a full JDK for Java runs, including leases made before templates had javac."""

import json
from pathlib import Path
import re
import shlex

from . import command_usage, lease

JAVA_WORD = re.compile(r'(?<![A-Za-z0-9_])(?:java|javac|quint|apalache|sbt|mvn|gradle|gradlew|mvnw|build-patched\.sh)(?![A-Za-z0-9_])')
PREFIX = 'offbox-jdk: '
WRAPPERS = command_usage.SHELLS | frozenset(('env', 'exec', 'command', 'sudo', 'time', 'timeout', 'nice',
                                           'stdbuf', 'xvfb-run', 'corepack', 'npx', 'pnpm', 'npm', 'yarn', 'bunx'))


def _words_need_java(words, cwd, word_pattern=JAVA_WORD):
    words = list(words)
    while words:
        if command_usage.ASSIGNMENT.match(words[0]):
            words = words[1:]
            continue
        if words[0].startswith('-'):
            return False
        first = Path(words[0]).name
        if word_pattern.search(words[0]):
            return True
        if first not in WRAPPERS:
            return False
        words = words[1:]
        value_options = lease._WRAPPERS.get(first, set())
        if first in command_usage.SHELLS:
            value_options = value_options | {'-o', '+o', '-O', '+O', '--rcfile', '--init-file'}
        if first == 'npm':
            value_options = value_options | {'--package', '-p'}
        shell_runner = first == 'npx'
        while words:
            if first in ('pnpm', 'npm', 'yarn') and words[:1] in (['exec'], ['dlx'], ['run']):
                shell_runner |= first == 'npm' and words[0] == 'exec'
                words = words[1:]
                continue
            if not (words[0].startswith('-') or first in command_usage.SHELLS and words[0].startswith('+')
                    or lease._DURATION.fullmatch(words[0])):
                break
            if first == 'command' and re.fullmatch(r'-[pVv]*[Vv][pVv]*', words[0]):
                return False
            option, sep, inline = words[0].partition('=')
            if ((first in command_usage.SHELLS and re.fullmatch(r'-[A-Za-z]*c[A-Za-z]*', words[0]))
                    or shell_runner and option in ('-c', '--call')
                    or first == 'env' and option in ('-S', '--split-string')):
                body = inline if sep else words[1] if len(words) > 1 else ''
                return bool(body) and _command_needs_java(body, cwd, word_pattern)
            takes_value = option in value_options or (first in command_usage.SHELLS and
                                                      re.fullmatch(r'[-+][A-Za-z]*[oO]', option))
            words = words[2:] if takes_value and not sep else words[1:]
    return False


def _command_needs_java(command, cwd, word_pattern=JAVA_WORD):
    sources = []
    parsed, _, _ = command_usage.segments(command, cwd, sources)
    if any(_words_need_java(segment.words, segment.cwd, word_pattern) for segment in parsed):
        return True
    # Sanitized groups retain wrapper options and substitution bodies without re-reading comments as code.
    for source in sources:
        try:
            if _words_need_java(shlex.split(source), cwd, word_pattern):
                return True
        except ValueError:
            pass
    return False


def trigger(root: Path, rel: str, argv: list[str], steps=None, *, repo_key='', template='') -> str:
    if 'harness' in repo_key or template == 'crpko-harness':
        return 'harness'
    if not template and lease.pick_template(root, repo_key)[0] == 'crpko-harness':
        return 'harness'
    folders = {root.resolve(), (root / rel).resolve()}
    for command in steps or [argv[0] if len(argv) == 1 else shlex.join(argv)]:
        sources = []
        parsed, _, _ = command_usage.segments(command, (root / rel).resolve(), sources)
        if _command_needs_java(command, (root / rel).resolve()):
            return 'command'
        folders.update(segment.cwd for segment in parsed if segment.cwd.is_relative_to(root.resolve()))
    for folder in folders:
        try:
            if any(path.is_file() and (path.name in ('build.sbt', 'pom.xml') or
                       path.name.startswith('build.gradle') or path.suffix == '.qnt') for path in folder.iterdir()):
                return 'repo-marker'
        except OSError:
            pass
    return ''


SHELL = r'''
__offbox_jdk_home= __offbox_jdk_version= __offbox_jdk_result=present
__offbox_jdk_start=$SECONDS
__offbox_find_jdk() {
  local compiler version
  for compiler in /usr/lib/jvm/java-21-openjdk-*/bin/javac; do
    [ -x "$compiler" ] && [ -x "${compiler%javac}java" ] || continue
    version=$(timeout -k 2 10 "$compiler" -version 2>/dev/null) || continue
    [[ $version == 'javac 21.'* ]] || continue
    __offbox_jdk_home=${compiler%/bin/javac}
    __offbox_jdk_version=${version#javac }
    return 0
  done
  return 1
}
__offbox_jdk_event() {
  printf 'offbox-jdk: {"attempt":"%s","result":"%s","duration_s":%s,"trigger":"%s"}\n' \
    "$1" "$2" "$((SECONDS - __offbox_jdk_start))" @TRIGGER@ >&2
}
__offbox_jdk_event check pending
if ! __offbox_find_jdk; then
  __offbox_jdk_result=installed
  __offbox_jdk_event install pending
  if timeout -k 5 300 sudo -n bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq openjdk-21-jdk-headless' >/dev/null 2>&1; then
    __offbox_find_jdk || __offbox_jdk_result=compiler-missing
  else
    __offbox_jdk_result=apt-exit-$?
  fi
fi
if [ -n "$__offbox_jdk_home" ]; then
  export JAVA_HOME="$__offbox_jdk_home"
  export PATH="$JAVA_HOME/bin:$PATH"
  echo "offbox: java $__offbox_jdk_version ($JAVA_HOME; $__offbox_jdk_result, $((SECONDS - __offbox_jdk_start))s)" >&2
else
  echo "offbox: could not install JDK 21: $__offbox_jdk_result; continuing with the command's environment" >&2
fi
__offbox_jdk_event result "$__offbox_jdk_result"
unset -f __offbox_find_jdk __offbox_jdk_event
:
'''


def block(reason: str) -> str:
    return SHELL.replace('@TRIGGER@', shlex.quote(reason)) if reason else ''


def record(con, run, path: Path, backend: str) -> None:
    """Translate remote diagnostics into the existing analytics logs; never affect the run result."""
    from .common import event
    import toollog
    try:
        with path.open(errors='replace') as stream:
            for line in stream:
                # Java setup precedes the command; never scan a test suite's full output.
                from offbox_protocol import for_run
                if for_run(run, path).command_started(line):
                    break
                if not line.startswith(PREFIX):
                    continue
                data = json.loads(line[len(PREFIX):])
                if data.get('attempt') not in ('check', 'install', 'result'):
                    continue
                key = f'jdk_event:{run["run_id"]}:{data["attempt"]}'
                if con.execute('SELECT 1 FROM kv WHERE k=?', (key,)).fetchone():
                    continue
                data.update(box=run['box_id'], backend=backend)
                event(con, run['box_id'], 'java_ensure', json.dumps(dict(run=run['run_id'], **data)))
                props = dict(jdk_phase=data['attempt'], jdk_result=data['result'],
                             jdk_trigger=data['trigger'], backend='home' if backend == 'server' else backend)
                if data['result'].startswith('apt-exit-'):
                    props.update(jdk_result='apt-failed', exitCode=int(data['result'][9:]))
                toollog.emit('run', 'run.java_ensure', ids={'run': run['run_id'], 'box': run['box_id']},
                             props=props, duration_ms=data['duration_s'] * 1000,
                             ok=data['result'] in ('pending', 'present', 'installed'))
                con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (key, '1'))
                con.commit()
    except Exception:
        pass
