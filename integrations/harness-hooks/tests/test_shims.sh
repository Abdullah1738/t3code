#!/bin/zsh -f
set -eu
pkg=${0:A:h:h}
offbox=${pkg:h}/offbox/skill
blockers=$offbox/scripts/blockers
tmp=$(mktemp -d "${TMPDIR:-/tmp}/harness-shims.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.local/bin" "$tmp/engine" "$tmp/state"
for name in wacli himalaya himalaya-heal docker; do
  cat >"$tmp/bin/$name" <<'EOF'
#!/bin/sh
printf 'real:%s\n' "${0##*/}"
EOF
  chmod +x "$tmp/bin/$name"
done
touch "$tmp/home/.local/bin/offbox"
chmod +x "$tmp/home/.local/bin/offbox"
cat >"$tmp/engine/engine.py" <<'EOF'
def decide(event, harness):
    assert event['tool_name'] == 'Bash'
    assert harness in ('claude', 'codex')
    return {'decision': 'deny'}
EOF

run_shim() {
  local kind=$1 name=$2; shift 2
  local -a ident
  case $kind in
    claude) ident=(CLAUDE_CODE_SESSION_ID=claude-test) ;;
    codex) ident=(CODEX_THREAD_ID=codex-test) ;;
    marker) ident=(ROBOB_HARNESS=claude) ;;
    human) ident=() ;;
  esac
  env -i HOME="$tmp/home" PATH="$blockers:$tmp/bin:/usr/bin:/bin" \
    OFFBOX_GATE_MODE=enforce OFFBOX_STATE_DIR="$tmp/state" OFFBOX_RULES="$offbox/heavy-rules.json" \
    HARNESS_HOOKS_SRC="$tmp/engine" "${ident[@]}" "$blockers/$name" "$@" >"$tmp/out" 2>"$tmp/err"
}

for kind in claude codex marker; do
  for name in wacli himalaya himalaya-heal; do
    if [[ $name == wacli ]]; then args=(send text); else args=(message send); fi
    if run_shim "$kind" "$name" "${args[@]}"; then
      print -u2 -- "FAIL: $kind $name passed a raw send"; exit 1
    else
      rc=$?
      [[ $rc == 2 ]] || { cat "$tmp/err" >&2; exit 1; }
      grep -q 'Blocked:' "$tmp/err"
      [[ ! -s "$tmp/out" ]]
    fi
  done
  if run_shim "$kind" docker run alpine; then
    print -u2 -- "FAIL: $kind docker passed a heavy command"; exit 1
  else
    rc=$?
    [[ $rc == 3 ]] || { cat "$tmp/err" >&2; exit 1; }
    grep -q 'offbox gate:' "$tmp/err"
    [[ ! -s "$tmp/out" ]]
  fi
done
for name in wacli himalaya himalaya-heal docker; do
  case $name in
    wacli) args=(send text) ;;
    docker) args=(run alpine) ;;
    *) args=(message send) ;;
  esac
  run_shim human "$name" "${args[@]}"
  grep -q "real:$name" "$tmp/out"
done
print 'offbox shims: Claude, Codex, harness marker and human checks passed'
