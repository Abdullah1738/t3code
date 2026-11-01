#!/bin/zsh -f
set -eu
pkg=${0:A:h:h}
offbox=${pkg:h}/offbox/skill
blockers=$offbox/scripts/blockers
tmp=$(mktemp -d "${TMPDIR:-/tmp}/harness-shims.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.local/bin" "$tmp/engine" "$tmp/state"
for name in wacli himalaya himalaya-heal docker aws psql fdbcli clickhouse-client terraform; do
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
def resolve_identity(event, harness, fresh=False):
    return {'resolution': 'resolved', 'robobThreadId': event['session_id']}
def approval_valid(value):
    return value == 'valid-pin'
def decide_coord(command, identity, cwd, approved=False):
    decision = 'allow' if approved else 'deny'
    return {'decision': decision, 'reason': 'coord Haiku lane: blocked',
            'context': {'rule': 'approved-sha256' if approved else 'test-deny'}}
def _log(**record):
    pass
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
    OFFBOX_GATE_MODE=enforce OFFBOX_STATE_DIR="$tmp/state" OFFBOX_RULES="${TEST_RULES:-$offbox/heavy-rules.json}" \
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

# Preserve the existing fail-closed OpenCode Docker backstop. Native policy
# errors fail open, like the new hooks, instead of blocking every docker call.
TEST_RULES="$tmp/no-rules.json" run_shim claude docker run alpine
grep -q 'real:docker' "$tmp/out"

coord=$pkg/coord-blockers
run_coord() {
  local kind=$1 name=$2; shift 2
  local -a ident
  case $kind in
    claude) ident=(CLAUDE_CODE_SESSION_ID=claude-test) ;;
    codex) ident=(CODEX_THREAD_ID=codex-test) ;;
    approved) ident=(CODEX_THREAD_ID=codex-test AGENT_GUARD_APPROVED=valid-pin) ;;
    human) ident=() ;;
  esac
  env -i HOME="$tmp/home" PATH="$coord:$tmp/bin:/usr/bin:/bin" \
    HARNESS_HOOKS_SRC="$tmp/engine" "${ident[@]}" "$coord/$name" "$@" >"$tmp/out" 2>"$tmp/err"
}
for name in aws psql fdbcli clickhouse-client terraform; do
  for kind in claude codex; do
    if run_coord "$kind" "$name" mutating-argument; then
      print -u2 -- "FAIL: $kind $name passed a blocked command"; exit 1
    else
      rc=$?
      [[ $rc == 3 ]] || { cat "$tmp/err" >&2; exit 1; }
      grep -q 'coord Haiku lane:' "$tmp/err"
      [[ ! -s "$tmp/out" ]]
    fi
  done
  for kind in approved human; do
    run_coord "$kind" "$name" mutating-argument
    grep -q "real:$name" "$tmp/out"
  done
done
print 'coord shims: Claude, Codex, approved and human checks passed'
