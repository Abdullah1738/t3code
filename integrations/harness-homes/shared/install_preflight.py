"""Validate install inputs without changing the package, homes or live config."""
import argparse
import plistlib
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import generate_homes as gh
from shared.opencode import patch, remote_entries
from shared.runtime_paths import validate_plist


def preflight(staged, baseline=None):
    for name in ('com.ardud.shared-mcp-flighty', 'com.ardud.shared-mcp-inbody', 'com.ardud.harness-homes'):
        with (gh.PKG / 'launchd' / (name + '.plist')).open('rb') as stream:
            plistlib.load(stream)
        if name.startswith('com.ardud.shared-mcp-'):
            validate_plist(gh.PKG / 'launchd' / (name + '.plist'))
    for relative in ('shared/check.py', 'shared/serve.py', 'shared/flighty_python.py',
                     'shared/inbody_python.py', 'shared/runtime_paths.py'):
        (gh.PKG / relative).read_bytes()
    manifest = gh.load_manifest()
    gh.validate_manifest(manifest)
    for specs in manifest.get('paritySources', {}).values():
        for spec in specs:
            if isinstance(spec, dict):
                installed = Path(gh.expand(spec['installed']))
                if not installed.is_file():
                    relative = str(installed).removeprefix(str(Path.home() / '.config/opencode') + '/')
                    if relative.startswith(('plugin/', 'lib/')):
                        raise gh.HomeError(f'install opencode-plugins first: missing {relative}')
                    raise gh.HomeError(f'required installed parity source missing: {installed}')
                installed.read_bytes()
            elif not spec.startswith('../'):
                # Inside this package: the install copies it, so check the copy being installed.
                gh.source_digest(str(gh.PKG / spec))
            else:
                # plan_all reads repo siblings; the installed generator reads
                # siblings under ~/.local/share instead. Check those as well.
                gh.source_digest(str((Path.home() / '.local/share/harness-homes' / spec).resolve()))
    config = Path(gh.opencode_config_path(manifest, None))
    original = config.read_bytes()
    updated = patch(original.decode(), remote_entries(manifest))
    if baseline is not None:
        Path(baseline).write_bytes(original)
    gh.load_opencode_mcp(str(config))
    # Compare the staged MCP migration before changing the live config.
    Path(staged).write_text(updated)
    failures = gh.mcp_parity(manifest, str(staged))[2]
    _, homes, _, unreadable, files = gh.plan_all(None)
    gh.guard_outputs([*homes.values(), *files])
    if unreadable:
        failures.append('skills: could not inspect ' + ', '.join(unreadable))
    with tempfile.TemporaryDirectory(prefix='homes-preflight-') as tmp:
        checks = {}
        for name, home in homes.items():
            check_home = Path(tmp) / name
            check_home.mkdir()
            checks[name] = str(check_home)
            for path, data in files.items():
                if Path(path).parent == Path(home):
                    (check_home / Path(path).name).write_bytes(data)
        failures.extend(gh.safe_chain_failures(checks, Path(gh.expand('~/.local/share/opencode-service/start.zsh'))))
    if failures:
        raise gh.HomeError('; '.join(failures))
    # Includes skill-farm operations and personal-home/symlink protection.
    gh.generate(None, True, str(staged))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('staged')
    parser.add_argument('--baseline')
    args = parser.parse_args()
    try:
        preflight(args.staged, args.baseline)
    except (OSError, ValueError, gh.HomeError) as error:
        parser.exit(1, f'preflight: {error}\n')


if __name__ == '__main__':
    main()
