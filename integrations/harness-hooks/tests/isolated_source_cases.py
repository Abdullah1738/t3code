"""Commands to classify only; none of these shell strings may be executed."""
import os
from pathlib import Path


def fixture_environment():
    return {name: '' for name in os.environ if name.startswith(('BASH_FUNC_', 'PYTHON', 'LD_', 'DYLD_')) or name in {'BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS'}}


def cases(root):
    live = str(Path.home() / '.robob/userdata/statev2.sqlite')
    opencode = str(Path.home() / '.local/share/opencode/opencode.db')
    read = 'live-database-read'
    unresolved = 'live-database-script-unresolved'
    safe = '/tmp/script-card-read-evidence/dev-home/userdata/statev2.sqlite'
    migrate = ['vp run migrate-dev-db', 'node apps/server/scripts/migrate-dev-db.ts',
               'node ' + str(root / 'apps/server/scripts/migrate-dev-db.ts')]
    rows = []
    for invocation in migrate:
        rows += [('a-b', invocation + ' --source ' + safe + ' --base-dir /tmp/x --projects 1 --threads-per-project 1', None),
                 ('a-equals', invocation + ' --source=' + safe + ' --base-dir=/tmp/x', None),
                 ('d', invocation + ' --base-dir /tmp/x', read),
                 ('f', invocation + ' --source ' + str(root / 'link.sqlite'), read)]
        rows.append(('migration-live-destination', invocation + ' --source ' + safe + ' --base-dir ' + str(Path.home() / '.robob'), read))
        rows.append(('migration-implicit-destination', invocation + ' --source ' + safe, unresolved))
        for escaped in ('\\\n', '\\\r\n'):
            for part in ('.robob', 'userdata', 'statev2.sqlite'):
                split_path = live.replace(part, part[:2] + escaped + part[2:])
                rows.append(('migration-source-continuation', invocation + ' --source ' + split_path + ' --base-dir /tmp/dev-home', unresolved))
            split_destination = str(Path.home()) + '/.ro' + escaped + 'bob'
            rows.append(('migration-destination-continuation', invocation + ' --source ' + safe + ' --base-dir ' + split_destination, unresolved))
        rows += [('migration-live-stdin', invocation + ' --source ' + safe + ' < ' + live, read),
                 ('migration-prior-edit', "sed -i '' 's/input.source/undefined/' apps/server/scripts/migrate-dev-db.ts; " + invocation + ' --source ' + safe, unresolved),
                 ('migration-prior-link', 'ln -s ' + live + ' /tmp/copy.sqlite; ' + invocation + ' --source /tmp/copy.sqlite', unresolved),
                 ('migration-named-tilde', invocation + ' --source ~' + Path.home().name + '/.t3/userdata/statev2.sqlite', unresolved),
                 ('migration-runtime-options', 'NODE_OPTIONS="--require /tmp/preload.cjs" ' + invocation + ' --source ' + safe, unresolved)]
        for prefix in ('~', '$HOME', '${HOME}', str(Path.home())):
            for suffix in ('.robob/userdata/statev2.sqlite', '.local/share/opencode/opencode.db', '.t3/userdata/statev2.sqlite'):
                rows.append(('e', invocation + ' --source ' + prefix + '/' + suffix, read))
        for args in ('--source "$X/copy.sqlite"', '--source', '--source ' + safe + ' --source ' + safe,
                     '-- --source ' + safe, '--source ' + safe + ' --unexpected value',
                     '--source ' + safe + ' --base-dir "$UNKNOWN"',
                     "--source '~/copy.sqlite' --base-dir /tmp/dev-home",
                     "--source '$HOME/copy.sqlite' --base-dir /tmp/dev-home",
                     "--source '${HOME}/copy.sqlite' --base-dir /tmp/dev-home",
                     "--source /tmp/copy.sqlite --base-dir '~/dev-home'",
                     "--source /tmp/copy.sqlite --base-dir '$HOME/dev-home'"):
            rows.append(('migration-ambiguous', invocation + ' ' + args, unresolved))
    rows += [('b-legacy-path', 'node scripts/migrate-dev-db.ts --source ' + safe + ' --base-dir /tmp/x', None),
             ('c', "sqlite3 /tmp/a/userdata/statev2.sqlite 'select 1'", None),
             ('g', '''python3 -I -c "print('statev2 migrate-dev-db')"''', None)]
    for marker in ("<<'EOF'", '<<EOF'):
        body = f'Never read {live} or {opencode}.\n'
        rows += [('h', f'cat > tmp/x/NOTES.md {marker}\n{body}EOF\ncp a b', None),
                 ('i-sqlite', f'sqlite3 {live} {marker}\nselect 1;\nEOF', read)]
    rows += [('i-python', f"python3 - <<'PY'\nopen({live!r}).read()\nPY", read),
             ('i-substitution', f'cat > tmp/x/NOTES.md <<EOF\n$(sqlite3 {live} .tables)\nEOF', read),
             ('i-backticks', f'cat > tmp/x/NOTES.md <<EOF\n`sqlite3 {live} .tables`\nEOF', read),
             ('l', 'python3 "$X/gate.py" a b', unresolved),
             ('l-shell', 'bash <<\'EOF\'\npython3 "$X/gate.py"\nEOF', unresolved),
             ('l-uv', 'uv run python "$X/x.py"', unresolved),
             ('l-bash', 'bash "$X/x.sh"', unresolved),
             ('l-relative-after-cd', 'cd "$UNKNOWN"; bash tmp/missing.sh', unresolved),
             # The base permits Python subprocess calls without a live path;
             # this card preserves that behavior rather than adding a policy.
             ('l-subprocess', "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['python3', some_var])\nPY", None)]
    for call in ("subprocess.run(['git','diff','--stat'], capture_output=True, text=True)", "'no subprocess'"):
        rows.append(('n-subvariant', "python3 - <<'PY'\nfrom pathlib import Path\nimport json,subprocess,datetime,hashlib\njson.loads(Path('tmp/cards/169/evidence/verification.json').read_text())\n" + call + "\nPath('tmp/cards/169/REPORT.md').write_text('''Run `python3 tmp/cards/169/verify-downloads.py`''')\nPY", None))
    for header in ("cat > /tmp/STATE.md <<'EOF'", "cat <<'EOF' >> /tmp/STATE.md", "cat >> /tmp/STATE.md <<'EOF'"):
        rows.append(('u-redirection-order', header + '\nRun `bash tmp/missing.sh` later.\nEOF', None))
    rows += [('v', "rg --files --hidden --no-ignore /tmp -g '*apalache*.jar' -g '!statev2.sqlite*' -g '!opencode.db*'", None),
             ('v-content-robob', "rg needle " + str(Path.home() / '.robob/userdata') + " -g 'statev2.sqlite*'", read),
             ('v-content-opencode', "rg needle " + str(Path.home() / '.local/share/opencode') + " -g 'opencode.db*'", read),
             ('v-direct', 'rg needle ' + live, read),
             ('v-stdin', 'rg needle < ' + live, read)]
    return rows


def mktemp_scripts():
    suffix = '/.robob/userdata/statev2.sqlite'
    good = 'TOP=$(mktemp -d "${TMPDIR:-/tmp}/backuptest.XXXXXX")\nT=$(mktemp -d "$TOP/case.XXXXXX")\n'
    rows = [(good + 'cat "$T' + suffix + '"', None),
            ('T=$(mktemp -d)\ncat "${T}' + suffix + '"', None),
            ('T="$(mktemp -d)"\ncat "$T' + suffix + '"', None)]
    for executable in ('"$(/bin/ln -s "$HOME/.robob" "$T/.robob"; printf /bin)/cat"',
                       '"`/bin/ln -s "$HOME/.robob" "$T/.robob"; printf /bin`/cat"',
                       '"${X}/cat"', '"$X/cat"', '$CAT'):
        rows.append(('T=$(mktemp -d)\n' + executable + ' "${T}' + suffix + '"', 'live-database-script'))
    for assignment in ('T=$($(printf mktemp) -d)', 'T=$(`printf mktemp` -d)',
                       'T=$(mktemp -d "${X}/fixture.XXXXXX")',
                       'T=$(mktemp -d "$(printf /tmp)/fixture.XXXXXX")'):
        rows.append((assignment + '\ncat "$T' + suffix + '"', 'live-database-script'))
    for operand in ('"${T}/$(printf .robob)/userdata/statev2.sqlite"',
                    '"${T}/`printf .robob`/userdata/statev2.sqlite"',
                    '"${T}/${X}/.robob/userdata/statev2.sqlite"'):
        rows.append(('T=$(mktemp -d)\ncat ' + operand, 'live-database-script'))
    for prefix, root in [('', '$X'), ('H=$HOME\n', '$H'), ('H=${HOME}\n', '${H}'),
                         ('T=$(mktemp -d)\nT=$HOME\n', '$T'), (good + 'T=$HOME\n', '$T'),
                         ('HOME=$(mktemp -d)\n', '$HOME'), ('', '~'), ('', '${HOME}'),
                         ('', str(Path.home())), ('', ''), ('', '$HOME')]:
        rows.append((prefix + 'cat "' + root + suffix + '"', 'live-database-script'))
    for mutation in ('read T', 'unset T', 'for T in "$HOME"; do :; done', 'eval "T=$HOME"', 'source unknown.sh', 'printf -v T %s "$HOME"', 'printf -vT %s "$HOME"', '/usr/bin/printf -vT %s "$HOME"', 'builtin printf -vT %s "$HOME"'):
        rows.append(('T=$(mktemp -d)\n' + mutation + '\ncat "$T' + suffix + '"', 'live-database-script'))
    for linker in ('ln', '/bin/ln', 'command ln', 'env ln', "$'ln'", '"$LINKER"'):
        rows.append(('T=$(mktemp -d)\n' + linker + ' -s "$HOME/.robob" "$T/.robob"\ncat "$T' + suffix + '"', 'live-database-script'))
    rows.append(('T=$(mktemp -d)\nX=$(/bin/ln -s "$HOME/.robob" "$T/.robob")\ncat "$T' + suffix + '"', 'live-database-script'))
    rows += [("cat <<'EOF'\nT=$(mktemp -d)\nEOF\ncat \"$T" + suffix + '"', 'live-database-script'),
             ('echo "\nT=$(mktemp -d)\n"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d) env true\ncat "$T' + suffix + '"', 'live-database-script'),
             ("'T=$(mktemp -d)'\ncat \"$T" + suffix + '"', 'live-database-script'),
             ("T='$(mktemp -d)'\ncat \"$T" + suffix + '"', 'live-database-script'),
             ('mktemp() { echo "$HOME"; }\nT=$(mktemp -d)\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d -u)\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\nln -s "$HOME/.robob" "$T/.robob"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\nrmdir "$T"\nln -s "$HOME" "$T"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\nmv "$HOME/.robob" "$T/.robob"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('if false; then\nT=$(mktemp -d)\nfi\ncat "$T' + suffix + '"', 'live-database-script'),
             ('unused() {\nT=$(mktemp -d)\n}\ncat "$T' + suffix + '"', 'live-database-script'),
             ('cat "$T' + suffix + '"\nT=$(mktemp -d)\n', 'live-database-script'),
             ('V=T\nT=$(mktemp -d)\nread "$V"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\nV=T\nprintf -v "$V" %s "$HOME"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\nln -s "$T" "$T/sibling"\nln -s "$HOME/.robob" "$T/sibling/.robob"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\nln -s "$HOME/.robob" "$T//.robob"\ncat "$T' + suffix + '"', 'live-database-script'),
             ('PATH=/tmp/helpers:$PATH\nT=$(mktemp -d)\ncat "$T' + suffix + '"', 'live-database-script'),
             ('T=$(mktemp -d)\ncat "prefix$T' + suffix + '"', 'live-database-script')]
    return rows


def fixture_tool_cases(root):
    """Executable fixtures are inspected by the guard, never run."""
    source = 'T=$(mktemp -d)\ncat "$T/.robob/userdata/statev2.sqlite"\n'
    system_path = '/usr/bin:/bin'
    for name in ('cat', 'mktemp', 'bash'):
        helper = root / (name + '-shadow') / name
        helper.parent.mkdir(parents=True, exist_ok=True)
        helper.write_text('#!/bin/sh\nexit 1\n')
        helper.chmod(0o755)
    local = root / 'cat'
    local.write_text('#!/bin/sh\nexit 1\n')
    local.chmod(0o755)
    alias = root / 'cat-alias' / 'cat'
    alias.parent.mkdir(parents=True, exist_ok=True)
    alias.symlink_to('/bin/cat')
    helper_alias = root / 'cat-helper-alias' / 'cat'
    helper_alias.parent.mkdir(parents=True, exist_ok=True)
    helper_alias.symlink_to(root / 'cat-shadow/cat')
    rows = []
    for executable in (str(root / 'cat-shadow/cat'), '"' + str(root / 'cat-shadow/cat') + '"',
                       'cat-shadow/cat', './cat-shadow/cat', './cat'):
        rows.append(('custom-literal', source.replace('\ncat ', '\n' + executable + ' '), system_path, 'live-database-script'))
    for executable in ('cat', '/bin/cat', '/usr/bin/cat', '"/bin/cat"'):
        rows.append(('system-reader', source.replace('\ncat ', '\n' + executable + ' '), system_path, None))
    for entry in (str(root / 'cat-shadow'), 'cat-shadow', './cat-shadow', ''):
        rows.append(('path-shadow-cat', source, entry + ':' + system_path, 'live-database-script'))
    for entry in (str(root / 'mktemp-shadow'), 'mktemp-shadow'):
        rows.append(('path-shadow-mktemp', source.replace('\ncat ', '\n/bin/cat '), entry + ':' + system_path, 'live-database-script'))
    rows.append(('path-shadow-shell', source, str(root / 'bash-shadow') + ':' + system_path, 'live-database-script'))
    rows.append(('path-system-alias', source, str(alias.parent) + ':' + system_path, None))
    rows.append(('path-helper-alias', source, str(helper_alias.parent) + ':' + system_path, 'live-database-script'))
    return [(*row, 'bash') for row in rows] + [
        ('literal-helper-shell', source, system_path, 'live-database-script', str(root / 'bash-shadow/bash')),
        ('relative-helper-shell', source, system_path, 'live-database-script', './bash-shadow/bash'),
        ('system-shell', source, str(root / 'bash-shadow') + ':' + system_path, None, '/bin/bash'),
    ]


def backup_cases(root, original):
    path = 'integrations/memory-system/tests/test_backup_replica.sh'
    commands = [
        ('repo-relative', 'bash ' + path, root),
        ('absolute', '/bin/bash ' + str(root / path), root),
        ('offbox', 'offbox run -- bash ' + path, root),
        ('offbox-options', 'offbox run --remote --no-fallback -- bash ' + path, root),
        ('archived-relative-redirect', 'bash tests/test_backup_replica.sh > /tmp/recall-978-r2-backup-replica.log 2>&1', root / 'integrations/memory-system'),
    ]
    variants = [
        ('original', original, None),
        ('edited', original + '\n# harmless fixture edit\n', None),
        ('literal-live-sibling', original + '\ncat ~/.t3/userdata/statev2.sqlite\n', 'live-database-script'),
        ('home-live-sibling', original + '\ncat "$HOME/.robob/userdata/statev2.sqlite"\n', 'live-database-script'),
        ('root-rebound', original + '\nT=$HOME\ncat "$T/.robob/userdata/statev2.sqlite"\n', 'live-database-script'),
        ('link-live', original.replace('ln -s "$REAL_RSYNC"', 'ln -s "$HOME/.robob"'), 'live-database-script'),
        ('sourced-live', original + '\nsource sibling.sh\n', 'live-database-script'),
        ('cat-function', original + '\ncat() { /bin/cat "$HOME/.t3/userdata/statev2.sqlite"; }\n', 'live-database-script'),
        ('skipped-reset', original.replace('\nsetup fake\n', '\nif false; then\nsetup fake\nfi\n') + '\ncat "$T/.robob/userdata/statev2.sqlite"\n', 'live-database-script'),
    ]
    return commands, variants


def setup_control_cases(original):
    minimal = '''TOP=$(mktemp -d "${TMPDIR:-/tmp}/backuptest.XXXXXX") || exit 1
setup() { # fixture
  T=$(mktemp -d "$TOP/case.XXXXXX")
}
setup fake
cat "$T/.robob/userdata/statev2.sqlite"
'''
    cases = [('minimal', minimal, None)]
    for reserved in ('PWD', 'OLDPWD', 'IFS', 'BASH_ENV'):
        cases.append(('reserved-root', minimal.replace('\n  T=', '\n  ' + reserved + '=').replace('$T/.robob', '$' + reserved + '/.robob'), 'live-database-script'))
    for header in ('setup() { return;', 'setup() { false &&', 'setup() { # fixture\nreturn'):
        cases.append(('skipped-assignment', minimal.replace('setup() { # fixture', header), 'live-database-script'))
    for call in ('unused() {\nsetup fake\n}', 'echo "\nsetup fake\n"', "cat <<'NOTE'\nsetup fake\nNOTE", '(\nsetup fake\n)', 'setup fake &', 'false && setup fake', 'false && \nsetup fake', 'true || \n\nsetup fake', 'false |& setup fake', 'setup fake | cat', 'setup fake < /missing-input', 'if false; then\nsetup fake\nfi', 'case x in y)\nsetup fake\n;; esac'):
        cases.append(('non-dominating-call', minimal.replace('\nsetup fake\n', '\n' + call + '\n'), 'live-database-script'))
    cases.append(('conditional-definition', minimal.replace('setup() { # fixture', 'if false; then\nsetup() { # fixture').replace('\n}\n', '\n}\nfi\n'), 'live-database-script'))
    for header in ('setup () { :; }', '  setup() { :; }', 'setup\t() { :; }'):
        cases.append(('duplicate-definition', minimal.replace('\nsetup fake\n', '\n' + header + '\nsetup fake\n'), 'live-database-script'))
    for interpreter, body in [('/usr/bin/perl', "-e 'symlink $ENV{HOME}, $ARGV[0]'"), ('/bin/bash', "-c 'ln -s \"$HOME\" \"$1\"' --")]:
        injected = minimal.replace('setup() { # fixture', 'LINKER=' + interpreter + '\nsetup() { # fixture').replace('\n}\n', '\n  rm -rf "$T"\n  "$LINKER" ' + body + ' "$T"\n}\n')
        cases.append(('literal-helper-root-replacement', injected, 'live-database-script'))
        cases.append(('literal-direct-root-replacement', injected.replace('"$LINKER"', interpreter), 'live-database-script'))
    for wrapper in ('env ', 'env -i ', 'X=1 ', 'X=1 env ', 'command ', 'exec ', 'nohup ', 'timeout 1 '):
        injection = '  rm -rf "$T"\n  ' + wrapper + '/usr/bin/perl -e \'symlink $ENV{HOME}, $ARGV[0]\' "$T"\n'
        cases.append(('wrapped-root-replacement', minimal.replace('\n}\n', '\n' + injection + '}\n'), 'live-database-script'))
    for prefix, suffix in [('X=$(', ')'), ('X="$(' , ')"'), ('X=`', '`')]:
        injection = '  rm -rf "$T"\n  ' + prefix + 'env /usr/bin/perl -e \'symlink $ENV{HOME}, $ARGV[0]\' "$T"' + suffix + '\n'
        cases.append(('substitution-root-replacement', minimal.replace('\n}\n', '\n' + injection + '}\n'), 'live-database-script'))
    python_cases = [
        ('import json,sys; print(json.loads("{}"))', None),
        ('import os,sys; op=os.symlink; op(os.environ["HOME"],sys.argv[1])', 'live-database-script'),
        ('import os as fs,sys; op=fs.symlink; op(fs.environ["HOME"],sys.argv[1])', 'live-database-script'),
        ('from pathlib import Path; import sys; Path(sys.argv[1]).symlink_to(Path.home())', 'live-database-script'),
        ('import os,sys; getattr(os,"symlink")(os.environ["HOME"],sys.argv[1])', 'live-database-script'),
        ('import sys; open(sys.argv[1],"w").write("changed")', 'live-database-script'),
        *[(code, 'live-database-script') for code in (
            'from os import symlink as print; import sys; print(sys.argv[2],sys.argv[1])',
            'from os import symlink as open; import sys; open(sys.argv[2],sys.argv[1])',
            'from os import symlink as len; import sys; len(sys.argv[2],sys.argv[1])',
            'from os import *; symlink("/tmp", "/tmp/link")',
            'import os as print; print.symlink("/tmp", "/tmp/link")',
        )],
    ]
    for code, expected in python_cases:
        for invocation in ("/opt/homebrew/bin/python3 -c '" + code + "' \"$T\"", "env /opt/homebrew/bin/python3 -c '" + code + "' \"$T\"", "/opt/homebrew/bin/python3 - \"$T\" <<'PY'\n" + code + '\nPY'):
            cases.append(('python-helper-operations', minimal.replace('\n}\n', '\n  ' + invocation + '\n}\n'), expected))
    for mutation in (
        original.replace('HOME="$T"', 'HOME="$HOME"'),
        original.replace('env -i PATH=', 'env PATH='),
        original.replace('/bin/bash "$R/scripts/memory_backup.sh"', '/bin/bash "$R/scripts/unknown.sh"'),
        original.replace('run "$source"', 'run "$HOME/other.sqlite"'),
        original + '\nprintf "exit 0" > "$R/scripts/memory_backup.sh"\n',
        original.replace('HERE="$(cd "$(dirname "$0")/.." && pwd)"', 'HERE="$TOP"'),
        original + '\nprintf "payload" > "$HERE/src/transcript_backup_manifest.py"\n',
        original + '\nP="$HERE/src"\nprintf "payload" > "$P/transcript_backup_manifest.py"\n',
        original + '\ncp "$R/src/dropbox_mirror.py" "$HERE/src/transcript_backup_manifest.py"\n',
    ):
        cases.append(('child-script-isolation', mutation, 'live-database-script'))
    for module in ('fixture_run_limited', 'transcript_backup_manifest'):
        for invocation in (
            "/opt/homebrew/bin/python3 -c 'import sys; sys.path.insert(0,sys.argv[1]); import " + module + "' \"$TOP\" \"$T\" \"$HOME\"",
            "/opt/homebrew/bin/python3 - \"$TOP\" \"$T\" \"$HOME\" <<'PY'\nimport sys; sys.path.insert(0,sys.argv[1]); import " + module + '\nPY',
        ):
            payload = "  rm -rf \"$T\"\n  printf 'from os import symlink as print\\nimport sys\\nprint(sys.argv[3],sys.argv[2])\\n' > \"$TOP/" + module + '.py"\n  ' + invocation + '\n'
            cases.append(('generated-import-provenance', minimal.replace('\n}\n', '\n' + payload + '}\n'), 'live-database-script'))
    for call, expected in (
        ("/opt/homebrew/bin/python3 - <<'PY'\nprint('ok')\nPY", None),
        ('/opt/homebrew/bin/python3 -', 'live-database-script'),
        ("/opt/homebrew/bin/python3 - <<'PY'\nnot valid python\nPY", 'live-database-script'),
        ("/opt/homebrew/bin/python3 - <<'PY' <<'SECOND'\nprint('ok')\nPY\nprint('ok')\nSECOND", 'live-database-script'),
        ("/opt/homebrew/bin/python3 - < /tmp/helper.py <<'PY'\nprint('ok')\nPY", 'live-database-script'),
    ):
        cases.append(('python-stdin-provenance', minimal.replace('\n}\n', '\n  ' + call + '\n}\n'), expected))
    payload = "  rm -rf \"$T\"\n  printf '%s\\n' 'from os import symlink as print; import sys; print(sys.argv[2],sys.argv[1])' > \"$TOP/helper.py\"\n"
    for call in (
        '/opt/homebrew/bin/python3 - "$T" "$HOME" < "$TOP/helper.py"',
        'cat "$TOP/helper.py" | /opt/homebrew/bin/python3 - "$T" "$HOME"',
        'cat "$TOP/helper.py" | env /opt/homebrew/bin/python3 - "$T" "$HOME"',
        '/opt/homebrew/bin/python3 - "$T" "$HOME" <<< "$CODE"',
    ):
        cases.append(('unproved-python-stdin', minimal.replace('\n}\n', '\n' + payload + '  ' + call + '\n}\n'), 'live-database-script'))
    for name, command in (
        ('BASH_ENV', "bash -c 'sleep 0; :'"), ('ENV', "sh -c 'sleep 0; :'"),
        ('PYTHONPATH', "/opt/homebrew/bin/python3 -c 'import glob'"), ('PYTHONHOME', "/opt/homebrew/bin/python3 -c 'import glob'"),
        ('LD_PRELOAD', "/opt/homebrew/bin/python3 -c 'import glob'"), ('DYLD_INSERT_LIBRARIES', "/opt/homebrew/bin/python3 -c 'import glob'"),
    ):
        for prefix in ('env ', '', 'X=1 env '):
            for separator in (' ', '\n  '):
                call = prefix + name + '="$TOP/preload"' + separator + command
                cases.append(('interpreter-startup-environment', minimal.replace('\n}\n', '\n  ' + call + '\n}\n'), 'live-database-script'))
        call = 'X=$(env ' + name + '="$TOP/preload" ' + command + ')'
        cases.append(('interpreter-startup-substitution', minimal.replace('\n}\n', '\n  ' + call + '\n}\n'), 'live-database-script'))
    for operation in ('.shell ln -s', '.system ln -s', '.load', 'SELECT load_extension(', 'SELECT writefile('):
        call = '/opt/homebrew/opt/sqlite/bin/sqlite3 :memory: "' + operation + ' $HOME $T"'
        cases.append(('sqlite-helper-operations', minimal.replace('\n}\n', '\n  rm -rf "$T"\n  ' + call + '\n}\n'), 'live-database-script'))
    cases.append(('trap-root-mutation', minimal.replace('setup fake\n', 'trap \'rm -rf "$T"; ln -s "$HOME" "$T"\' DEBUG\nsetup fake\n'), 'live-database-script'))
    for linker in ('"$LINKER"', '"${LINKER}"', '"$(printf ln)"', '`printf ln`'):
        cases.append(('computed-link', original.replace('  R="$T/.local/share/memory-system"', '  LINKER=ln\n  ' + linker + ' -s "$HOME" "$T"\n  R="$T/.local/share/memory-system"'), 'live-database-script'))
    for name in ('R', 'H', 'source', 'REAL_RSYNC'):
        for mutation in ('for ' + name + ' in "$HOME"; do :; done', 'select ' + name + ' in "$HOME"; do :; done', name + '=$HOME', name + '[0]=$HOME', name + '+=$HOME', 'read ' + name, 'printf -v ' + name + ' %s "$HOME"'):
            cases.append(('descendant-mutation', original + '\n' + mutation + '\ncat "$T/.robob/userdata/statev2.sqlite"\n', 'live-database-script'))
    for copy in ('cp -as "$HOME" "$T"', 'cp "$HOME" "$T"', 'tar -xf /tmp/tree.tar -C "$T"'):
        cases.append(('tree-replacement', original.replace('  R="$T/.local/share/memory-system"', '  ' + copy + '\n  R="$T/.local/share/memory-system"'), 'live-database-script'))
    return cases


def migration_mutations(original):
    return [
        ('harmless-edit', original + '\n// harmless comment\n', None),
        *[(label, original.replace('source: Option.getOrUndefined(source),', replacement), 'live-database-script') for label, replacement in [
            ('missing-source', ''), ('undefined-source', 'source: undefined,'),
            ('wrong-source', 'source: Option.getOrUndefined(baseDir),'),
            ('overridden-source', 'source: Option.getOrUndefined(source), source: undefined,'),
        ]],
        ('source-assigned', original.replace('const result = yield* runMigrateDevDb({', 'source = undefined; const result = yield* runMigrateDevDb({'), 'live-database-script'),
        ('default-source', original.replace('input.source ?? path.join', 'undefined ?? path.join'), 'live-database-script'),
        *[('input-mutation', original.replace('  const sourcePath = path.resolve(', '  ' + mutation + '\n  const sourcePath = path.resolve('), 'live-database-script') for mutation in (
            'Reflect.deleteProperty(input, "source");', 'input["source"] = undefined;', 'input.source &&= undefined;', 'input.source ||= undefined;', 'const alias = input; alias.source = undefined;', 'Object.defineProperty(input, "source", {value: undefined});',
        )],
        ('option-mutation', original.replace('  const sourcePath = path.resolve(', '  Option["getOrUndefined"] = () => undefined;\n  const sourcePath = path.resolve('), 'live-database-script'),
        *[('cli-option-mutation', original.replace('      const result = yield* runMigrateDevDb({', '      ' + mutation + '\n      const result = yield* runMigrateDevDb({'), 'live-database-script') for mutation in (
            'delete source.value;', 'source["value"] = undefined;', 'source.value &&= undefined;', 'const alias = source; delete alias.value;', 'Reflect.deleteProperty(source, "value");', 'Object.defineProperty(source, "value", {value: undefined});',
        )],
        ('flag-mapping', original.replace('source: Flag.String("source").pipe(', 'source: Flag.String("source").pipe(Flag.map(() => ({_tag:"None"})), '), 'live-database-script'),
        *[('effective-options-override', original.replace('  },\n  ({ projects, threadsPerProject, baseDir, source })', extra + '\n  },\n  ({ projects, threadsPerProject, baseDir, source })'), 'live-database-script') for extra in (
            '    source: Flag.String("alternate-source").pipe(Flag.optional),',
            '    ...{ source: Flag.String("alternate-source").pipe(Flag.optional) },',
            '    capturedSource: Flag.String("source").pipe(Flag.optional),\n    ...{ source: Flag.String("alternate-source").pipe(Flag.optional) },',
            '    ["source"]: Flag.String("alternate-source").pipe(Flag.optional),',
            '    ...otherOptions,',
        )],
        *[('migration-read-operand', original.replace('copySourceSlice(sourcePath)', 'copySourceSlice(' + operand + ')'), 'live-database-script') for operand in (
            'path.join(sharedHome, "userdata", "statev2.sqlite")', 'path.join(NodeOS.homedir(), ".t3", "userdata", "statev2.sqlite")', 'undefined', 'snapshotPath',
        )],
        ('migration-attach-operand', original.replace('NodeURL.pathToFileURL(sourcePath)', 'NodeURL.pathToFileURL(path.join(sharedHome, "userdata", "statev2.sqlite"))'), 'live-database-script'),
        ('migration-client-operand', original.replace('filename: snapshotPath', 'filename: path.join(sharedHome, "userdata", "statev2.sqlite")'), 'live-database-script'),
        ('migration-home-alias', original.replace('  const sourcePath = path.resolve(', '  const alias = sharedHome;\n  const sourcePath = path.resolve('), 'live-database-script'),
        *[('migration-source-use', original.replace('  const sql = yield* SqlClient.SqlClient;\n  yield* sql`ATTACH', '  ' + mutation + '\n  const sql = yield* SqlClient.SqlClient;\n  yield* sql`ATTACH'), 'live-database-script') for mutation in (
            'const path = yield* Path.Path; const getHome = NodeOS.homedir; [sourcePath] = [path.join(getHome(), ".t3", "userdata", "statev2.sqlite")];',
            '[sourcePath] = [undefined];', '({ sourcePath } = other);', 'const alias = sourcePath;', 'sourcePath ||= undefined;',
            'const getHome = NodeOS.homedir;', 'const toUrl = NodeURL.pathToFileURL;', 'const alias = path ;', 'path["resolve"] = () => "/tmp";',
        )],
    ]
