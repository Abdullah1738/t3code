"""VM user namespace policy and the shared, warn-only rootless sandbox check."""

import shlex


SETUP = r'''(
  _offbox_backend=@BACKEND@
  _offbox_box=@BOX@
  _offbox_restrict=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null) || _offbox_restrict=unknown
  _offbox_clone=$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null) || _offbox_clone=unknown
  if [ "$_offbox_backend" = boat ]; then
    # TorSSH, bwrap and Chrome need rootless sandboxes; this single-tenant VM policy preserves host/other-box isolation.
    _offbox_conf='kernel.apparmor_restrict_unprivileged_userns = 0'
    if [ "$_offbox_clone" != unknown ]; then
      _offbox_conf="$_offbox_conf
kernel.unprivileged_userns_clone = 1"
    fi
    _offbox_apply=false
    if [ "$(cat /etc/sysctl.d/99-offbox-userns.conf 2>/dev/null)" != "$_offbox_conf" ]; then
      if printf '%s\n' "$_offbox_conf" | sudo -n timeout -k 0.1 0.8 tee /etc/sysctl.d/99-offbox-userns.conf >/dev/null 2>&1; then
        _offbox_apply=true
      fi
    fi
    if [ "$_offbox_restrict" != 0 ] || { [ "$_offbox_clone" != unknown ] && [ "$_offbox_clone" != 1 ]; }; then
      _offbox_apply=true
    fi
    if $_offbox_apply; then
      sudo -n timeout -k 0.1 0.8 sysctl -p /etc/sysctl.d/99-offbox-userns.conf >/dev/null 2>&1 || true
      _offbox_restrict=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null) || _offbox_restrict=unknown
      _offbox_clone=$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null) || _offbox_clone=unknown
    fi
  fi
  # The home backend is LXC: only its host may change these non-namespaced sysctls (#1141).
  _offbox_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || _offbox_boot=
  _offbox_cache="$HOME/.offbox/userns-v1-$_offbox_backend-$_offbox_box"
  _offbox_key="$_offbox_boot $_offbox_restrict $_offbox_clone"
  _offbox_result=$(cat "$_offbox_cache" 2>/dev/null) || _offbox_result=
  # A host-policy change invalidates a cached failure even without rebooting the box.
  if [ -z "$_offbox_boot" ] || { [ "$_offbox_result" != "$_offbox_key pass" ] && [ "$_offbox_result" != "$_offbox_key fail" ]; }; then
    _offbox_result="$_offbox_key fail"
    if timeout -k 0.1 0.8 unshare --user --map-root-user --net --mount true >/dev/null 2>&1; then
      _offbox_result="$_offbox_key pass"
    fi
    if [ -n "$_offbox_boot" ]; then
      mkdir -p "$HOME/.offbox" && printf '%s\n' "$_offbox_result" > "$_offbox_cache.tmp" &&
        mv -f "$_offbox_cache.tmp" "$_offbox_cache"
    fi
  fi
  if [ "$_offbox_result" = "$_offbox_key fail" ]; then
    printf "offbox: warning: box %s (%s) can't create user namespaces (apparmor_restrict_unprivileged_userns=%s); rootless sandboxes will fail\n" \
      "$_offbox_box" "$_offbox_backend" "$_offbox_restrict" >&2
  fi
) || true'''


def setup(backend: str, box_id: str) -> str:
    return SETUP.replace('@BACKEND@', shlex.quote(backend)).replace('@BOX@', shlex.quote(box_id))
