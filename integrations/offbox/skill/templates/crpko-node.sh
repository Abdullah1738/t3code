# offbox template: crpko-node (large). Expo/React Native prototypes (crpko-mobile-prototype), crpko-devops scripts,
# Next.js frontends. Node 24 (nvm default), Node 20 and Node 22 for repos that pin 22.13 (.nvmrc/engines); offbox picks the one the repo asks for.
# npm cache lives in $HOME/.npm (npm_config_cache), kept by stops/forks.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

NODE_MAJOR="${OFFBOX_NODE_MAJOR:-24}"
# The builder provisions nvm Node 20, >=22.13 <23 and 24 with the run prelude before this recipe.
nvm alias default "$NODE_MAJOR" >/dev/null
nvm use default >/dev/null
node --version
npm --version

for major in 20 22 "$NODE_MAJOR"; do
  nvm use "$major" >/dev/null
  corepack enable
  corepack prepare pnpm@10 --activate
done
nvm use default >/dev/null

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends build-essential python3 jq rsync zsh openjdk-21-jre-headless >/dev/null
sudo apt-get install -y -qq --no-install-recommends watchman >/dev/null || true
sudo update-alternatives --set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java
sudo apt-get clean

sudo tee /etc/sysctl.d/90-offbox-inotify.conf >/dev/null <<'EOF'
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=1024
EOF
sudo sysctl --system >/dev/null

# Warm the npm cache with the heavy, shared parts of the Expo/RN/Jest toolchain (versions float; cache still helps).
mkdir -p /tmp/warm && cd /tmp/warm
npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts --loglevel=error \
  expo jest jest-expo babel-preset-expo typescript @types/jest react react-native >/dev/null 2>&1 || \
  echo "warm: npm cache warm-up partly failed (fine)"
cd ~ && rm -rf /tmp/warm

# Playwright browsers (some web repos test with it); path from the offbox env block, kept by snapshots.
npx -y playwright@latest install --with-deps chromium >/dev/null 2>&1 || echo "warm: playwright skipped"

mkdir -p ~/w
echo "crpko-node template ready: node $(node --version) npm $(npm --version); npm cache $(du -sh ~/.npm | cut -f1)"
