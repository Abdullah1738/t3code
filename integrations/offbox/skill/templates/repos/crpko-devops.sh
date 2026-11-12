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

if [ "${1:-}" = --check ]; then
  offbox_crpko_tools_ready && terraform_ready
  exit $?
fi

offbox_crpko_tools
if ! terraform_ready; then
  case $(uname -m) in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'offbox: unsupported Terraform architecture' >&2; exit 98 ;;
  esac
  command -v unzip >/dev/null || sudo apt-get install -y -qq unzip
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  archive="terraform_${terraform_version}_linux_${arch}.zip"
  url="https://releases.hashicorp.com/terraform/$terraform_version"
  curl -fsSL --retry 5 "$url/$archive" -o "$stage/$archive"
  curl -fsSL --retry 5 "$url/terraform_${terraform_version}_SHA256SUMS" -o "$stage/SHA256SUMS"
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
for tool in vector aws terraform ruby; do
  command -v "$tool" >/dev/null || { echo "offbox: required tool missing on command PATH: $tool" >&2; exit 98; }
done
[ -x /usr/bin/ruby ] || { echo 'offbox: required tool missing: /usr/bin/ruby' >&2; exit 98; }
offbox_crpko_tools_ready && terraform_ready || { echo 'offbox: Crpko toolchain version check failed' >&2; exit 98; }
mkdir -p "$HOME/.offbox/repo-env"
printf 'export PATH="/usr/local/bin:$PATH"\n' > "$HOME/.offbox/repo-env/crpko-devops.sh.tmp"
mv -f "$HOME/.offbox/repo-env/crpko-devops.sh.tmp" "$HOME/.offbox/repo-env/crpko-devops.sh"
