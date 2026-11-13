# Binary-only server install: tests start their own cluster; the server package's postinst would claim port 4500.
offbox_foundationdb() (
  set -euo pipefail
  FDB_VERSION="${OFFBOX_FDB_VERSION:-7.3.63}"
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  release="https://github.com/apple/foundationdb/releases/download/$FDB_VERSION"
  if [ "$(dpkg-query -W -f='${Version}' foundationdb-clients 2>/dev/null || true)" != "$FDB_VERSION-1" ]; then
    curl -fsSL --retry 5 "$release/foundationdb-clients_${FDB_VERSION}-1_amd64.deb" -o "$stage/clients.deb"
    sudo apt-get install -y -qq "$stage/clients.deb" >/dev/null
  fi
  if ! fdbserver --version 2>/dev/null | grep -Fq "(v$FDB_VERSION)"; then
    curl -fsSL --retry 5 "$release/foundationdb-server_${FDB_VERSION}-1_amd64.deb" -o "$stage/server.deb"
    dpkg-deb -x "$stage/server.deb" "$stage/server"
    sudo install -m 0755 "$stage/server/usr/sbin/fdbserver" /usr/local/bin/fdbserver
  fi
)
