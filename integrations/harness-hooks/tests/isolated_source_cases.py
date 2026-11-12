"""Commands to classify only; none of these shell strings may be executed."""
from pathlib import Path


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
