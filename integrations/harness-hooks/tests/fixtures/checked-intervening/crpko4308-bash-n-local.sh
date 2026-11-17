cat > tmp/hc026f-timing.hCRQL3/setup.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT=$PWD
TASK_DIR=tmp/hc026f-timing.hCRQL3
BENCH="$ROOT/$TASK_DIR"
mkdir -p "$BENCH/bin" "$BENCH/sources" "$BENCH/results"
export PATH="$BENCH/bin:$PATH"
if ! command -v terraform >/dev/null; then
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 https://releases.hashicorp.com/terraform/1.13.5/terraform_1.13.5_linux_amd64.zip -o "$BENCH/terraform.zip"
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 https://releases.hashicorp.com/terraform/1.13.5/terraform_1.13.5_SHA256SUMS -o "$BENCH/terraform.SHA256SUMS"
  (cd "$BENCH"; sed 's/terraform_1.13.5_linux_amd64.zip/terraform.zip/' terraform.SHA256SUMS | grep ' terraform.zip$' | sha256sum --check --strict)
  unzip -oq "$BENCH/terraform.zip" -d "$BENCH/bin"
fi
if ! command -v java >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y openjdk-21-jdk-headless
fi
{
  date -u
  uname -a
  lscpu
  df -h "$BENCH"
  uv --version
  python3 --version
  node --version
  terraform version
  java -version
  cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
} > "$BENCH/results/machine.txt" 2>&1
python3 -I - "$BENCH" <<'PY'
import shutil,sys
assert shutil.disk_usage(sys.argv[1]).free > 25*1024**3, 'Timing baseline needs space to retain passed fixtures'
PY
ARCH=15432347b1be1fd342ca5057efba9db38d7e3d03
git init -q "$BENCH/sources/architecture"
git -C "$BENCH/sources/architecture" unpack-objects < "$BENCH/architecture.pack"
printf '%s\n' "$ARCH" > "$BENCH/sources/architecture/.git/shallow"
git -C "$BENCH/sources/architecture" update-ref HEAD "$ARCH"
git -C "$BENCH/sources/architecture" reset -q --hard "$ARCH"
test -z "$(git -C "$BENCH/sources/architecture" status --porcelain --untracked-files=all)"
git init -q "$BENCH/sources/vendor"
git -C "$BENCH/sources/vendor" fetch -q "$ROOT/tmp/hc026f.QmgT9M/vendor.bundle" HEAD
git -C "$BENCH/sources/vendor" checkout -q --detach be599254f9d304161167295de6cec9e33a0bac0a
for spec in base:4fc2c595f079747067363c82e283a3bace7e5e89 head:648870f20d4fb0f3814570a9de17babf94ad73da; do
  dir="$BENCH/${spec%:*}"
  git clone -q --shared --no-checkout "$ROOT" "$dir"
  git -C "$dir" checkout -q --detach "${spec#*:}"
  git clone -q --shared "$BENCH/sources/vendor" "$dir/vendor/crpko-devops"
  (cd "$dir"; bash "$BENCH/setup-kafka-libs.sh")
  git -C "$dir" diff --exit-code
  git -C "$dir" diff --cached --exit-code
  git -C "$dir/vendor/crpko-devops" status --porcelain
  git -C "$dir" rev-parse HEAD
 done
exec python3 -I "$BENCH/benchmark.py"
SH
 bash -n tmp/hc026f-timing.hCRQL3/setup.sh
bash tmp/hc026f-timing.hCRQL3/setup.sh