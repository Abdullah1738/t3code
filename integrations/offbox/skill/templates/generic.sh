# offbox template: generic (default size). Appended after common-env.sh by `offbox template build generic`.
# Base image already has: Ubuntu 24.04, Docker 29 + compose + buildx, git, build-essential, Python 3.12 + uv,
# Node 24 (nvm) + pnpm, Go 1.23, Rust, Java. We add a current Go, the cache env, and warm a few common caches.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

GO_VERSION="${OFFBOX_GO_VERSION:-1.26.9}"
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} "; then
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
  rm -f /tmp/go.tgz
fi
/usr/local/go/bin/go version

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends build-essential pkg-config jq rsync zip unzip ca-certificates \
  python3-venv python3-pip libssl-dev >/dev/null
sudo apt-get clean

# corepack shims for yarn/pnpm (cache dirs come from the offbox env block)
corepack enable >/dev/null 2>&1 || sudo env "PATH=$PATH" corepack enable || true

# Docker: make sure it starts on resume and the user can talk to it.
sudo systemctl enable docker >/dev/null 2>&1 || true
docker info --format '{{.ServerVersion}}' >/dev/null

# Use a buildx builder whose cache can be exported to $HOME/.buildcache (kept by snapshots).
docker buildx inspect offbox >/dev/null 2>&1 || docker buildx create --name offbox --driver docker-container --use >/dev/null
docker buildx use default

mkdir -p ~/w
echo "generic template ready: $(go version) node $(node --version) $(docker --version)"
