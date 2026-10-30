# offbox template: crpko-node (large). Expo/React Native prototypes (crpko-mobile-prototype), crpko-devops scripts,
# Next.js frontends. Node 24 (nvm default) plus Node 22 for repos that pin 22.13 (.nvmrc/engines); offbox picks the one the repo asks for.
# npm cache lives in $HOME/.npm (npm_config_cache), kept by stops/forks.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

NODE_MAJOR="${OFFBOX_NODE_MAJOR:-24}"
nvm install "$NODE_MAJOR" >/dev/null
nvm install 22 >/dev/null  # crpko_mobile_app and backoffice-frontend pin 22.13 via .nvmrc/engines; offbox picks per repo
nvm alias default "$NODE_MAJOR" >/dev/null
nvm use default >/dev/null
node --version
npm --version

corepack enable >/dev/null 2>&1 || true

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends build-essential python3 jq rsync watchman >/dev/null || \
  sudo apt-get install -y -qq --no-install-recommends build-essential python3 jq rsync >/dev/null
sudo apt-get clean

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
