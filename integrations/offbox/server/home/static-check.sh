#!/bin/bash
# static-check.sh: every check of the installer stick that needs no VM (verification layer A).
#
#   static-check.sh [--tree DIR]
#
#   --tree DIR   build-tree.sh output (default ~/ohv/tree-out). Its ISO files carry the installer's own
#                subiquity + curtin + Python, which validate the autoinstall config here. Without the tree
#                that one check is reported as NOT RUN and the script fails.
#
# Needs: shellcheck, yamllint, cloud-init, netplan, grub-script-check (grub-common), zsh, unsquashfs, python3.
# Prints one PASS / FAIL / NOT RUN line per check; exit code 0 only when everything passed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE" || exit 2
TREE=$HOME/ohv/tree-out
while [ $# -gt 0 ]; do
  case $1 in
    --tree) TREE=$2; shift 2 ;;
    *) echo "usage: static-check.sh [--tree DIR]" >&2; exit 2 ;;
  esac
done
FAILS=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export PYTHONDONTWRITEBYTECODE=1

# check NAME CMD...: run CMD, print one verdict line; on failure also the first lines of its output
check() {
  local name=$1 out rc
  shift
  out=$("$@" 2>&1)
  rc=$?
  if [ $rc = 0 ]; then
    echo "PASS    $name${out:+  [$(echo "$out" | tail -1 | cut -c1-150)]}"
  else
    echo "FAIL    $name (exit $rc)"
    echo "$out" | head -40 | sed 's/^/          /'
    FAILS=$((FAILS + 1))
  fi
}
notrun() { echo "NOT RUN $1: $2"; FAILS=$((FAILS + 1)); }
need() { command -v "$1" >/dev/null 2>&1; }

# ---- the files
mapfile -t SH < <(grep -rlE '^#!(/usr)?/bin/(env )?(ba)?sh' . --exclude-dir=__pycache__ | sort)
SH+=(../install-host.sh)
mapfile -t ZSH < <(ls ./*.zsh ../bootstrap.zsh)
mapfile -t PY < <(find . -name '*.py' | sort)
YAML=(stick/nocloud/user-data stick/nocloud/meta-data stick/offbox/target/rootfs/etc/netplan/01-offbox.yaml
      stick/offbox/target/rootfs/etc/cloud/cloud.cfg.d/99-offbox-no-network.cfg)

# ---- shell
syntax_sh() {
  local f rc=0
  for f in "${SH[@]}"; do
    case $(head -1 "$f") in *bash*) bash -n "$f" || rc=1 ;; *) sh -n "$f" || rc=1 ;; esac
  done
  echo "${#SH[@]} scripts"
  return $rc
}
check "bash -n / sh -n on every shell script" syntax_sh
if need shellcheck; then
  sc() { shellcheck -x "${SH[@]}" && echo "${#SH[@]} scripts, $(shellcheck --version | sed -n 's/^version: //p')"; }
  check "shellcheck -x (settings: .shellcheckrc)" sc
else
  notrun shellcheck "not installed"
fi
if need zsh; then
  syntax_zsh() { local f rc=0; for f in "${ZSH[@]}"; do zsh -n "$f" || rc=1; done; echo "${ZSH[*]}"; return $rc; }
  check "zsh -n on the Mac-side scripts" syntax_zsh
else
  notrun "zsh -n" "zsh not installed"
fi

# ---- python
pyc() { local f rc=0; for f in "${PY[@]}"; do python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$f" || rc=1; done; echo "${#PY[@]} files"; return $rc; }
check "python syntax" pyc
unit() { python3 vmtest/test_plan.py 2>&1 | tail -3 | tr '\n' ' '; return "${PIPESTATUS[0]}"; }
check "plan.py unit tests (disk decision, wipe scope, storage layout)" unit

# ---- yaml / cloud-init / netplan / grub
if need yamllint; then
  yl() {
    yamllint -s -d '{extends: default, rules: {line-length: disable, document-start: disable, truthy: disable, comments: {min-spaces-from-content: 1, require-starting-space: false}}}' "${YAML[@]}" &&
      echo "${#YAML[@]} files"
  }
  check "yamllint" yl
else
  notrun yamllint "not installed"
fi
if need cloud-init; then
  ci() { cloud-init schema --config-file stick/nocloud/user-data 2>&1 | tail -3; return "${PIPESTATUS[0]}"; }
  check "cloud-init schema: stick/nocloud/user-data" ci
else
  notrun "cloud-init schema" "cloud-init not installed"
fi
if need netplan; then
  np() {
    mkdir -p "$TMP/np/etc/netplan" && install -m 600 stick/offbox/target/rootfs/etc/netplan/01-offbox.yaml "$TMP/np/etc/netplan/" &&
      netplan generate --root-dir "$TMP/np" && find "$TMP/np/run" -type f | sed "s|$TMP/np||" | tr '\n' ' '
  }
  check "netplan generate: target 01-offbox.yaml" np
else
  notrun "netplan generate" "netplan not installed"
fi
if need grub-script-check; then
  check "grub-script-check: stick/boot/grub/grub.cfg" grub-script-check stick/boot/grub/grub.cfg
  trial() {
    # the snippet 01_offbox_trial adds to the installed system's grub.cfg must be valid GRUB script too
    sed -n "/^cat <<'EOF_GRUB'$/,/^EOF_GRUB$/p" stick/offbox/target/rootfs/etc/grub.d/01_offbox_trial | sed '1d;$d' > "$TMP/trial.cfg"
    [ -s "$TMP/trial.cfg" ] && grub-script-check "$TMP/trial.cfg" && echo "$(wc -l < "$TMP/trial.cfg") lines"
  }
  check "grub-script-check: the kernel-trial snippet of 01_offbox_trial" trial
else
  notrun grub-script-check "grub-common not installed"
fi

# ---- our own consistency rules
modes() {
  local rc=0 f m root=stick/offbox/target/rootfs
  while read -r f m; do
    case $f in '' | '#'*) continue ;; esac
    [ -f "$root/$f" ] || { echo "target/modes names a missing file: $f"; rc=1; }
    case $m in 0[0-7][0-7][0-7]) ;; *) echo "bad mode for $f: $m"; rc=1 ;; esac
  done < stick/offbox/target/modes
  # everything that must be executable on the installed system is listed as 0755
  while read -r f; do
    f=${f#"$root"/}
    grep -qx "$f 0755" stick/offbox/target/modes || { echo "executable $f is not 0755 in target/modes"; rc=1; }
  done < <(find "$root/usr/local/sbin" "$root/etc/grub.d" "$root/etc/kernel" -type f)
  # every unit late.sh enables exists, and the other way round
  for f in "$root"/etc/systemd/system/offbox-*.service "$root"/etc/systemd/system/offbox-*.timer; do
    grep -q "$(basename "$f")" stick/offbox/installer/late.sh || case $(basename "$f") in
      offbox-rtcwake.service | offbox-boot-health.service | offbox-tailscale-join.service) ;;  # started by their timers
      *) echo "unit $(basename "$f") is never enabled by late.sh"; rc=1 ;;
    esac
  done
  echo "modes list, executables and units agree"
  return $rc
}
check "target/modes covers every executable; every unit is enabled" modes
secrets() {
  # nothing secret may sit in the repo part of the stick: auth keys, password hashes, private keys
  if grep -rIlE 'tskey-[a-z]+-[A-Za-z0-9]{6,}|\$(6|y|2b)\$[./A-Za-z0-9]{8,}\$|BEGIN [A-Z ]*PRIVATE KEY' . --exclude-dir=__pycache__ --exclude=static-check.sh; then
    return 1
  fi
  echo "no auth key, password hash or private key in home/"
}
check "no secrets in the repository files" secrets
pins() {
  # shellcheck source=versions.env
  . ./versions.env
  local v
  for v in "$ISO_SHA256" "$TAILSCALE_DEB_SHA256" "$TAILSCALE_KEYRING_SHA256"; do
    [[ $v =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha256 pin: $v"; return 1; }
  done
  case $ISO_URL in https://releases.ubuntu.com/*"$ISO_NAME") ;; *) echo "ISO url/name mismatch"; return 1 ;; esac
  echo "$ISO_NAME + $TAILSCALE_DEB pinned by sha256"
}
check "versions.env pins" pins

# ---- the installer's own validators (subiquity + curtin from the ISO, under the ISO's Python)
LAYER=$TREE/boot/casper/ubuntu-server-minimal.ubuntu-server.installer.squashfs
if [ ! -s "$LAYER" ]; then
  notrun "subiquity + curtin schema validation" "no stick tree at $TREE (run build-tree.sh, or pass --tree)"
elif ! need unsquashfs; then
  notrun "subiquity + curtin schema validation" "unsquashfs (squashfs-tools) not installed"
else
  W=${OFFBOX_STATIC_CACHE:-$HOME/.cache/offbox-static}/$(sha256sum "$LAYER" | cut -c1-16)
  subi() {
    mkdir -p "$W" && cd "$W" || return 1
    [ -d layer ] || unsquashfs -q -n -no-xattrs -d layer "$LAYER" 'var/lib/snapd/seed/snaps/*' >/dev/null 2>&1
    local s c
    s=$(find layer/var/lib/snapd/seed/snaps -name 'subiquity_*.snap' | head -1)
    c=$(find layer/var/lib/snapd/seed/snaps -name 'core22_*.snap' | head -1)
    [ -n "$s" ] && [ -n "$c" ] || { echo "subiquity/core22 snaps not found in the installer layer"; return 1; }
    [ -d subiquity ] || unsquashfs -q -n -no-xattrs -d subiquity "$s" >/dev/null 2>&1
    [ -d core22 ] || unsquashfs -q -n -no-xattrs -d core22 "$c" >/dev/null 2>&1
    python3 "$HERE/vmtest/test_plan.py" --dump-storage > "$TMP/storage.json" || return 1
    # the snap's Python 3.10 with the snap's libraries, started through its own dynamic loader
    PYTHONHOME=$W/core22/usr \
      PYTHONPATH=$W/subiquity/lib/python3.10/site-packages:$W/subiquity/usr/lib/python3/dist-packages:$W/core22/usr/lib/python3/dist-packages \
      SNAP=$W/subiquity SUBIQUITY_ROOT=$W/subiquity \
      "$W/core22/lib64/ld-linux-x86-64.so.2" \
      --library-path "$W/core22/usr/lib/x86_64-linux-gnu:$W/core22/lib/x86_64-linux-gnu:$W/subiquity/usr/lib/x86_64-linux-gnu" \
      "$W/core22/usr/bin/python3.10" "$HERE/vmtest/subiquity_check.py" "$HERE/stick/nocloud/user-data" "$TMP/storage.json" 2>&1 |
      grep -E '^(ok|FAIL) |Error|error:' | cut -c1-300 | sed 's/^/          /'
    local rc=${PIPESTATUS[0]}
    echo "$(basename "$s") on the ISO, python 3.10 from $(basename "$c")"
    return "$rc"
  }
  check "subiquity autoinstall schema + curtin storage schema (the ISO's own code)" subi
fi

echo
if [ "$FAILS" = 0 ]; then echo "static checks: ALL PASSED"; else echo "static checks: $FAILS FAILED / NOT RUN"; fi
[ "$FAILS" = 0 ]
