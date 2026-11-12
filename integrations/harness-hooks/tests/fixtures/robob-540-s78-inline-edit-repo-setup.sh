python3 - <<'PY'
from pathlib import Path
p=Path('integrations/offbox/skill/scripts/offbox_lib/runs.py')
s=p.read_text()
start=s.index('# The old helper installed')
block='''# Recipes travel with this runner so an uninstalled checkout can prove the exact change.
REPO_RECIPES_DIR = Path(__file__).resolve().parents[2] / "templates" / "repos"
REPO_SETUP_FAILED_MARKER = "offbox-repo-setup-failed"
EXIT_REPO_SETUP = 98

REPO_SETUP = r\'''# offbox-repo-setup
(
  set -euo pipefail
  mkdir -p "$HOME/.offbox/repo-env"
  exec 9>"$HOME/.offbox/repo-setup-@KEY@.lock"
  flock -x -w 1800 9
  export OFFBOX_REPO_ROOT="$HOME"/@ROOT@
  _offbox_base="$HOME/.offbox/repo-setup-@KEY@"
  _offbox_stamp=$(python3 - "$OFFBOX_REPO_ROOT" <<'OFFBOX_REPO_STAMP'
import base64, hashlib, re, sys
from pathlib import Path
recipe = base64.b64decode('@RECIPE@')
mod = Path(sys.argv[1]) / 'core/go.mod'
match = re.search(r'^\\s*(?:require\\s+)?golang\\.org/x/mobile\\s+(v[^\\s]+)', mod.read_text(), re.M) if mod.exists() else None
version = match[1] if match else ''
print(hashlib.sha256(recipe + b'\\0' + version.encode()).hexdigest())
OFFBOX_REPO_STAMP
  )
  if [ "$(cat "$_offbox_base.stamp" 2>/dev/null || true)" != "$_offbox_stamp" ] ||
     [ ! -f "$HOME/.offbox/repo-env/@KEY@.sh" ]; then
    echo 'offbox: setting up @KEY@ toolchain on this box (first run here, a few minutes)' >&3
    _offbox_t0=$SECONDS
    python3 - "$_offbox_base.sh" <<'OFFBOX_REPO_RECIPE'
import base64, sys
from pathlib import Path
Path(sys.argv[1]).write_bytes(base64.b64decode('@RECIPE@'))
OFFBOX_REPO_RECIPE
    bash "$_offbox_base.sh"
    # A successful recipe must publish the environment before we trust its stamp.
    test -f "$HOME/.offbox/repo-env/@KEY@.sh"
    printf '%s\\n' "$_offbox_stamp" > "$_offbox_base.stamp.tmp"
    mv -f "$_offbox_base.stamp.tmp" "$_offbox_base.stamp"
    echo "offbox: @KEY@ toolchain ready ($((SECONDS - _offbox_t0))s)" >&3
  fi
) 3>&2 >>"$HOME/.offbox/repo-setup-@KEY@.log" 2>&1
_offbox_repo_rc=$?
if [ "$_offbox_repo_rc" -ne 0 ]; then
  tail -n 20 "$HOME/.offbox/repo-setup-@KEY@.log" >&2
  echo 'offbox: @KEY@ toolchain setup failed on this box; nothing ran' >&2
  echo offbox-repo-setup-failed >&2
  exit 98
fi
. "$HOME/.offbox/repo-env/@KEY@.sh" || {
  echo 'offbox: @KEY@ toolchain setup failed on this box; nothing ran' >&2
  echo offbox-repo-setup-failed >&2
  exit 98
}
\'''


def repo_setup_block(repo_key: str, rdir: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", repo_key):
        return ""
    recipe = REPO_RECIPES_DIR / f"{repo_key}.sh"
    if not recipe.is_file():
        return ""
    # The log redirection opens before the subshell can create its directories.
    return ('mkdir -p "$HOME/.offbox" || exit 98\\n' + REPO_SETUP.replace('@KEY@', repo_key)
            .replace('@ROOT@', shlex.quote(rdir))
            .replace('@RECIPE@', base64.b64encode(recipe.read_bytes()).decode()))


'''
s=s[:start]+block+s[start:]
s=s.replace('image_wait: int = 180) -> str:', 'image_wait: int = 180, repo_key: str = "") -> str:')
s=s.replace('              GO_REPAIR,\n              node,', '              repo_setup_block(repo_key, rdir),\n              GO_REPAIR,\n              node,')
s=s.replace('node=node_block, wait_images=wait_images, image_wait=image_wait_seconds())', 'node=node_block, wait_images=wait_images, image_wait=image_wait_seconds(),\n                               repo_key=me["repo_key"])')
s=s.replace('    if code == 97 and setup_failed(rn.log_path):', '''    if code == EXIT_REPO_SETUP and rn.log_path and REPO_SETUP_FAILED_MARKER in rn.log_path.read_text(errors="replace"):
        rn.started = False
        rn.record(error="repo toolchain setup failed (exit 98)")
        finish(rn.run_id, None, "infra")
        raise OffboxError("repo toolchain setup failed (exit 98), not your command", code=EXIT_INFRA)
    if code == 97 and setup_failed(rn.log_path):''')
p.write_text(s)
PY