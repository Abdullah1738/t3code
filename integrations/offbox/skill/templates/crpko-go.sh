# offbox template: crpko-go (large). Go services (risk-liquidation, trading-core, edge-api, registry, ...).
# Repos declare go 1.24.0 .. 1.25.x; one recent toolchain (>= all of them) avoids GOTOOLCHAIN downloads per module.
# Module caches live in $HOME (GOMODCACHE=$HOME/go/pkg/mod, GOCACHE=$HOME/.xcache/go-build) so stops/forks keep them.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

GO_VERSION="${OFFBOX_GO_VERSION:-1.26.9}"
# A matching binary version does not prove an old overlay left a clean source tree.
if [ -f /usr/local/go/src/runtime/traceexp.go ] || [ -f /usr/local/go/src/strconv/ctoa.go ] || [ -f /usr/local/go/src/syscall/syscall_linux_accept4.go ] || ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} "; then
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
  rm -f /tmp/go.tgz
fi
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH
go version

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends build-essential pkg-config jq rsync ca-certificates >/dev/null

offbox_crpko_tools

# FoundationDB client library (crpko services link github.com/apple/foundationdb/bindings/go via cgo).
FDB_VERSION="${OFFBOX_FDB_VERSION:-7.3.63}"
if ! dpkg -s foundationdb-clients >/dev/null 2>&1; then
  curl -fsSL --retry 5 "https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_amd64.deb" \
    -o /tmp/fdb-clients.deb
  sudo apt-get install -y -qq /tmp/fdb-clients.deb >/dev/null
  rm -f /tmp/fdb-clients.deb
fi
sudo apt-get clean

# Common tools used by Makefiles/CI in the Crpko Go repos.
go install gotest.tools/gotestsum@latest
go install github.com/jstemmer/go-junit-report/v2@latest

# Warm the module cache with the libraries every Crpko Go service shares (best effort; private modules need no auth).
mkdir -p /tmp/warm && cd /tmp/warm
cat > go.mod <<'EOF'
module warm

go 1.24.0
EOF
for m in github.com/aws/aws-sdk-go-v2@latest github.com/aws/aws-sdk-go-v2/config@latest \
         github.com/aws/aws-sdk-go-v2/service/ssm@latest github.com/aws/aws-sdk-go-v2/service/secretsmanager@latest \
         github.com/twmb/franz-go@latest github.com/twmb/franz-go/pkg/kfake@latest google.golang.org/grpc@latest \
         google.golang.org/protobuf@latest github.com/jackc/pgx/v5@latest github.com/google/uuid@latest \
         github.com/stretchr/testify@latest gopkg.in/yaml.v3@latest github.com/DataDog/datadog-go/v5@latest \
         github.com/apple/foundationdb/bindings/go@latest github.com/ClickHouse/clickhouse-go/v2@latest; do
  go get "$m" >/dev/null 2>&1 || echo "warm: skip $m"
done
cd ~ && rm -rf /tmp/warm

docker info --format '{{.ServerVersion}}' >/dev/null
mkdir -p ~/w
echo "crpko-go template ready: $(go version); modcache $(du -sh "$(go env GOMODCACHE)" | cut -f1)"
