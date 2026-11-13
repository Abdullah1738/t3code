# Stalled transfers must fail: --retry alone never ends a transfer that stops sending bytes.
# Home IPv6 could not connect to AWS CLI (curl 7); IPv4 returned HTTP 206 in 1.47s.
OFFBOX_FETCH_BOUNDS=(--ipv4 --connect-timeout 20 --speed-limit 30720 --speed-time 60 --max-time 600 --retry 2)
offbox_fetch() { # offbox_fetch URL OUT
  curl -fsSL "${OFFBOX_FETCH_BOUNDS[@]}" "$1" -o "$2" && return 0
  local rc=$?
  echo "offbox: download failed (curl exit $rc): $1" >&2
  return 98
}
