# offbox template: crpko-harness (xlarge, 16 vCPU / 32 GB). Docker-heavy Crpko work: the integration-harness platform
# compose (postgres x3, kafka, clickhouse, localstack, foundationdb), testcontainers suites, devops localstack compose.
# Snapshots keep only images that a container uses, so every image is pulled AND attached to a created (not running)
# container. The build uploads ~/.offbox/upload/harness-platform.tar first (git archive of the harness repo's
# docker/platform from origin/archive/main-pre-fresh-start; main no longer carries a compose file).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

GO_VERSION="${OFFBOX_GO_VERSION:-1.26.9}"
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} "; then
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
fi
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends jq rsync postgresql-client >/dev/null || true
sudo apt-get clean
sudo systemctl enable docker containerd >/dev/null 2>&1 || true

# Docker daemon: the harness stack and testcontainers start many containers; raise default address pools and
# keep logs bounded so the disk (251 GB) doesn't fill on long runs.
sudo mkdir -p /etc/docker
if ! sudo test -s /etc/docker/daemon.json; then
  echo '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"3"},
"default-address-pools":[{"base":"172.80.0.0/12","size":24}]}' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl restart docker
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

# Testcontainers: don't start ryuk reaper sidecar per run on a throwaway VM (faster), and let it find docker.
grep -q TESTCONTAINERS_RYUK_DISABLED ~/.bashrc || sed -i '1i export TESTCONTAINERS_RYUK_DISABLED=true' ~/.bashrc

# Harness platform stack: images pulled + fdb image built + containers created (not started).
H=~/harness/platform
mkdir -p "$H" ~/harness/evidence
if [ -f ~/.offbox/upload/harness-platform.tar ]; then
  tar -xf ~/.offbox/upload/harness-platform.tar -C ~/harness --strip-components=1
fi
if [ -f "$H/compose.yaml" ]; then
  cd "$H"
  export RUN_EVIDENCE_DIR=~/harness/evidence
  docker compose -p offbox-harness-template pull --ignore-buildable --quiet
  docker compose -p offbox-harness-template build --quiet
  docker compose -p offbox-harness-template create
  # Compose names a built image <project>-<service>. Without -p the project is the compose file's dir name
  # ("platform", also for `-f docker/platform/compose.yaml`), so alias the FDB build there: runs then reuse it
  # instead of rebuilding (~40 s). Another -p NAME: `docker tag platform-foundationdb NAME-foundationdb` first.
  docker tag offbox-harness-template-foundationdb:latest platform-foundationdb:latest
  cd ~
else
  echo "WARN: harness platform compose not uploaded; skipping stack images"
fi

# Extra images the Crpko repos use outside that compose (devops localstack compose, testcontainers defaults).
keep() {  # pull an image and pin it with a created container so snapshots keep it
  local img="$1" name="offbox-keep-$(echo "$1" | tr '/:@.' '----' | cut -c1-60)"
  docker pull -q "$img" >/dev/null || { echo "WARN: pull $img failed"; return 0; }
  docker inspect "$name" >/dev/null 2>&1 || docker create --name "$name" --entrypoint /bin/true "$img" >/dev/null 2>&1 \
    || docker create --name "$name" "$img" >/dev/null
}
keep localstack/localstack-pro:4.9.0
keep localstack/localstack:4.9
keep testcontainers/ryuk:0.11.0
keep public.ecr.aws/docker/library/postgres:16-alpine
keep redis:7-alpine

# Images are kept by templates/docker-images.sh, which `offbox template build` appends to every recipe
# (boat snapshots drop image layers; see notes-B.md).

docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | sort
docker ps -a --format '{{.Names}} {{.Status}}' | sort
echo "crpko-harness template ready: $(docker images -q | wc -l) images, $(docker ps -aq | wc -l) created containers"
