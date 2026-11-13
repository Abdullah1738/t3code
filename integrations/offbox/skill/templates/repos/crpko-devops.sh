#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

# Read literal CI pins; expression-based saved-plan/latest selections aren't a toolchain pin.
terraform_version=$(python3 - "${OFFBOX_REPO_ROOT:?}/.github/workflows/terraform-dev.yml" <<'PY'
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text()
versions = set()
for line in text.splitlines():
    match = re.fullmatch(r"\s*terraform_version:\s*([^#]*)(?:#.*)?", line)
    value = match[1].strip() if match else ""
    if len(value) >= 2 and value[0] in (chr(34), chr(39)) and value[-1] == value[0]:
        value = value[1:-1]
    if re.fullmatch(r"\d+\.\d+\.\d+", value):
        versions.add(value)
if len(versions) != 1:
    sys.exit('offbox: terraform requires one unambiguous literal CI pin in terraform-dev.yml')
print(versions.pop())
PY
) || exit 98

terraform_ready() {
  [ -x /usr/local/bin/terraform ] && [ "$(terraform version -json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["terraform_version"])' 2>/dev/null)" = "$terraform_version" ]
}

tf_provider_mirror() {
  python3 - "$1" "${2:-}" "$OFFBOX_REPO_ROOT" "$HOME/.offbox/tf-provider-mirror" "$(uname -m)" <<'PY'
from pathlib import Path
import fcntl, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time

mode, work, root, mirror, arch = sys.argv[1:]
root, mirror = Path(root), Path(mirror)
platform = {'x86_64': 'linux_amd64', 'aarch64': 'linux_arm64', 'arm64': 'linux_arm64'}.get(arch)

def locked_providers(path):
    return [(source, version) for source, version in re.findall(
        r'provider\s+"([^"]+)"\s*\{\s*version\s*=\s*"([^"]+)"', path.read_text())]

def fixture_requirements():
    requirements = set()
    sources = list((root / 'terraform/modules').rglob('*.tf')) + list((root / 'scripts').rglob('*.mjs'))
    for path in sources:
        if '.terraform' in path.parts:
            continue
        text = path.read_text().replace('\\n', '\n')
        if 'required_providers' not in text:
            continue
        for body in re.findall(r'\b[\w-]+\s*=\s*\{([^{}]*)\}', text):
            address = re.search(r'\bsource\s*=\s*"((?:registry\.terraform\.io/)?hashicorp/[\w-]+)"', body)
            if not address:
                continue
            source = address[1]
            source = source if source.startswith('registry.') else 'registry.terraform.io/' + source
            version = re.search(r'\bversion\s*=\s*"([^"]+)"', body)
            terms = (version[1] if version else '').split(',')
            terms = {re.sub(r'^(~>|>=|<=|!=|=|>|<)\s*', r'\1', term.strip()).removeprefix('=')
                     for term in terms}
            requirements.add((source, ', '.join(sorted(terms))))
    return sorted(requirements)

try:
    locks = sorted(path for path in (root / 'terraform').rglob('.terraform.lock.hcl')
                   if '.terraform' not in path.parts)
    pins = {entry for lock in locks for entry in locked_providers(lock)}
    requirements = fixture_requirements()
except (OSError, ValueError) as error:
    if mode != 'check':
        print(f'offbox: terraform provider mirror fill failed ({error}); tests will download providers', file=sys.stderr)
    sys.exit(1)
# Pool boxes serve multiple checkouts; only matching input sets share completion state.
signature = hashlib.sha256(json.dumps({'pins': sorted(pins), 'fixtures': requirements}, sort_keys=True).encode()).hexdigest()
completed = mirror / f'.complete-{platform}-{signature}'

def package(source, version):
    return mirror / source / f'terraform-provider-{source.split("/")[-1]}_{version}_{platform}.zip'

def pinned_ready():
    return bool(platform) and all(package(s, v).is_file() and package(s, v).stat().st_size for s, v in pins)

def ready():
    # The repo's strict hook cannot fall back to downloads for a missing fixture package.
    return pinned_ready() and completed.is_file()

if mode == 'check':
    sys.exit(0 if ready() else 1)

def atomic_json(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.index-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)

def publish(stage):
    for archive in stage.glob('*/*/*/terraform-provider-*.zip'):
        dest = mirror / archive.relative_to(stage)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # The box lock serializes publishers; rename exposes only complete authenticated zips.
        if not dest.exists():
            archive.chmod(0o444)
            archive.rename(dest)
    for directory in mirror.glob('*/*/*'):
        if not directory.is_dir():
            continue
        versions = {}
        for archive in directory.glob('terraform-provider-*.zip'):
            match = re.fullmatch(r'terraform-provider-[^_]+_([^_]+)_([^_]+_[^_]+)\.zip', archive.name)
            if not match:
                continue
            version, target = match.groups()
            versions.setdefault(version, {})[target] = {'url': archive.name,
                'hashes': ['zh:' + hashlib.sha256(archive.read_bytes()).hexdigest()]}
        for version, archives in versions.items():
            atomic_json(directory / (version + '.json'), {'archives': archives})
        atomic_json(directory / 'index.json', {'versions': {v: {} for v in versions}})

def fill(config, stage, label):
    for attempt in range(3):
        result = subprocess.run(['timeout', '900', 'terraform', 'providers', 'mirror',
                                 '-platform=' + platform, str(stage)], cwd=config)
        if result.returncode == 0:
            publish(stage)
            return
        if attempt < 2:
            time.sleep(attempt + 1)
    raise RuntimeError(f'{label}, exit {result.returncode} after 3 attempts')

def config_dir(base, entries):
    base.mkdir()
    (base / 'main.tf.json').write_text(json.dumps({'terraform': {'required_providers': {
        'p' + str(i): {'source': source, **({'version': constraint} if constraint else {})}
        for i, (source, constraint) in enumerate(entries)}}}))
    return base

try:
    if not platform:
        raise RuntimeError('unsupported architecture ' + arch)
    mirror.parent.mkdir(parents=True, exist_ok=True)
    with (mirror.parent / 'tf-provider-mirror.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if ready():
            sys.exit(0)
        completed.unlink(missing_ok=True)
        mirror.mkdir(exist_ok=True)
        work = Path(work)
        stage = work / 'packages'
        stage.mkdir()
        # Synthetic roots preserve the exact locks without initializing modules or changing the checkout.
        for i, path in enumerate(locks):
            entries = locked_providers(path)
            if all(package(s, v).is_file() for s, v in entries):
                continue
            config = config_dir(work / ('locked-' + str(i)), entries)
            shutil.copyfile(path, config / '.terraform.lock.hcl')
            fill(config, stage, str(path.relative_to(root)))
        # Keep requirements independent of disk contents so the signature survives a successful fill.
        for i, requirement in enumerate(requirements):
            source, constraint = requirement
            exact = re.fullmatch(r'\d+\.\d+\.\d+', constraint)
            if exact and package(source, constraint).is_file():
                continue
            config = config_dir(work / ('fixture-' + str(i)), [requirement])
            fill(config, stage, 'fixture ' + ' '.join(requirement))
        if not pinned_ready():
            raise RuntimeError('locked package missing after fill')
        completed.touch()
except (OSError, RuntimeError) as error:
    print(f'offbox: terraform provider mirror fill failed ({error}); tests will download providers', file=sys.stderr)
    sys.exit(1)
PY
}

tf_provider_mirror_ready() { tf_provider_mirror check; }

OFFBOX_GNU_TIME=${OFFBOX_GNU_TIME:-/usr/bin/time}
gnu_time_ready() {
  [ -x "$OFFBOX_GNU_TIME" ] && "$OFFBOX_GNU_TIME" -p true >/dev/null 2>&1
}

if [ "${1:-}" = --check ]; then
  offbox_crpko_tools_ready && terraform_ready && gnu_time_ready && tf_provider_mirror_ready
  exit $?
fi

offbox_crpko_tools
gnu_time_ready || offbox_apt_install time || { echo 'offbox: GNU time install failed' >&2; exit 98; }
gnu_time_ready || { echo 'offbox: GNU time install failed' >&2; exit 98; }
if ! terraform_ready; then
  case $(uname -m) in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'offbox: unsupported Terraform architecture' >&2; exit 98 ;;
  esac
  command -v unzip >/dev/null || offbox_apt_install unzip
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  archive="terraform_${terraform_version}_linux_${arch}.zip"
  url="https://releases.hashicorp.com/terraform/$terraform_version"
  offbox_fetch "$url/$archive" "$stage/$archive"
  offbox_fetch "$url/terraform_${terraform_version}_SHA256SUMS" "$stage/SHA256SUMS"
  (cd "$stage" && python3 - "$archive" <<'PY'
import hashlib, re, sys
from pathlib import Path
archive = sys.argv[1]
checksums = [line.split()[0] for line in Path('SHA256SUMS').read_text().splitlines()
             if len(line.split()) == 2 and line.split()[1] == archive]
if (len(checksums) != 1 or not re.fullmatch('[a-fA-F0-9]{64}', checksums[0])
        or hashlib.sha256(Path(archive).read_bytes()).hexdigest() != checksums[0].lower()):
    sys.exit('offbox: terraform SHA256 mismatch for ' + archive)
PY
  ) || exit 98
  unzip -q "$stage/$archive" -d "$stage"
  sudo install -m 0755 "$stage/terraform" /usr/local/bin/terraform
fi
hash -r
for tool in vector aws terraform ruby gh; do
  command -v "$tool" >/dev/null || { echo "offbox: required tool missing on command PATH: $tool" >&2; exit 98; }
done
[ -x /usr/bin/ruby ] || { echo 'offbox: required tool missing: /usr/bin/ruby' >&2; exit 98; }
offbox_crpko_tools_ready && terraform_ready || { echo 'offbox: Crpko toolchain version check failed' >&2; exit 98; }
mkdir -p "$HOME/.offbox/tf-provider-mirror"
if ! tf_provider_mirror_ready; then
  (
    mkdir -p "$HOME/.offbox"
    mirror_work=$(mktemp -d "$HOME/.offbox/tf-provider-mirror-stage.XXXXXX")
    trap 'rm -rf "$mirror_work"' EXIT
    tf_provider_mirror fill "$mirror_work"
  ) || :
fi
mirror_enabled=false
tf_provider_mirror_ready && mirror_enabled=true
python3 - "$HOME" "$mirror_enabled" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
home = Path(sys.argv[1])
content = ('provider_installation {\n  filesystem_mirror {\n    path = '
           + json.dumps(str(home / '.offbox/tf-provider-mirror')) + '\n  }\n  direct {}\n}\n')
# An explicit test config can ignore this file; the repo's mirror hook covers those callers.
fd, tmp = tempfile.mkstemp(prefix='.offbox-terraformrc-', dir=home)
try:
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
    try:
        os.link(tmp, home / '.terraformrc')
    except FileExistsError:
        pass
finally:
    Path(tmp).unlink(missing_ok=True)
env = home / '.offbox/repo-env'
env.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix='.crpko-devops-', dir=env)
try:
    with os.fdopen(fd, 'w') as stream:
        stream.write('export PATH="/usr/local/bin:$PATH"\n')
        if sys.argv[2] == 'true':
            stream.write('export TERRAFORM_PROVIDER_MIRROR="$HOME/.offbox/tf-provider-mirror"\n')
        else:
            stream.write('unset TERRAFORM_PROVIDER_MIRROR\n')
    os.replace(tmp, env / 'crpko-devops.sh')
finally:
    Path(tmp).unlink(missing_ok=True)
PY
