#!/bin/bash
# Runs inside a fresh images:ubuntu/24.04 container; the result is published as `offbox-base`.
# Mirrors what offbox relied on in boat.dev's base box: user `user` (uid 1000) with passwordless sudo, sshd,
# Docker + compose, git/rsync/jq/build tools, zsh, Node 24 + pnpm, Go, Python 3 + uv, bun. Template recipes
# (offbox skill/templates/*.sh) add the per-stack tools on top.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server sudo ca-certificates curl wget gnupg git rsync jq \
  build-essential pkg-config make unzip zip xz-utils zstd file less vim-tiny procps psmisc lsof iproute2 \
  iputils-ping dnsutils python3 python3-venv python3-pip python3-dev tzdata locales util-linux tmux htop \
  fuse-overlayfs openjdk-21-jdk-headless sqlite3 zsh >/dev/null
bash /root/offbox-sqlite.sh
rm -f /root/offbox-sqlite.sh /root/fetch.sh
update-alternatives --set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java
update-alternatives --set javac /usr/lib/jvm/java-21-openjdk-amd64/bin/javac
javac -version 2>&1 | grep -q '^javac 21\.' || { echo 'offbox template: javac 21 missing' >&2; exit 1; }
test -x /bin/zsh || { echo 'offbox base: /bin/zsh missing' >&2; exit 1; }
locale-gen en_US.UTF-8 >/dev/null

id user >/dev/null 2>&1 || { userdel -r ubuntu 2>/dev/null || true; useradd -m -u 1000 -s /bin/bash user; }
echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-user && chmod 440 /etc/sudoers.d/90-user
install -d -m 700 -o user -g user /home/user/.ssh

# sshd: keys only, user `user`.
cat > /etc/ssh/sshd_config.d/10-offbox.conf <<'C'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers user
AllowTcpForwarding yes
StreamLocalBindUnlink yes
ClientAliveInterval 30
MaxSessions 64
MaxStartups 64:30:128
C
systemctl enable ssh >/dev/null 2>&1 || true

# Kept outside openssh-server's conffiles and guest sshd includes.
install -m 0644 /root/offbox-mgmt-ssh.service /etc/systemd/system/offbox-mgmt-ssh.service
install -m 0600 /root/offbox_mgmt_sshd_config /etc/ssh/offbox_mgmt_sshd_config
install -d /etc/systemd/system/ssh.service.d
install -m 0644 /root/offbox-ssh-runtime.conf /etc/systemd/system/ssh.service.d/10-offbox-runtime.conf
systemctl daemon-reload
systemctl enable offbox-mgmt-ssh.service
rm -f /root/offbox-mgmt-ssh.service /root/offbox_mgmt_sshd_config /root/offbox-ssh-runtime.conf

# Docker CE.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
usermod -aG docker user
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'C'
{"storage-driver": "overlay2", "log-driver": "local", "log-opts": {"max-size": "20m"},
 "default-address-pools": [{"base": "172.30.0.0/16", "size": 24}], "features": {"buildkit": true}}
C
systemctl enable docker containerd >/dev/null

# Node 24 + corepack (pnpm), Go, uv, bun.
NODE=v24.22.3
curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar --no-same-owner -xJ -C /usr/local --strip-components=1
corepack enable
npm config -g set update-notifier false fund false audit false
GO=1.26.9
curl -fsSL "https://go.dev/dl/go$GO.linux-amd64.tar.gz" | tar --no-same-owner -xz -C /usr/local
ln -sf /usr/local/go/bin/go /usr/local/bin/go; ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
# Stamp the tree the way the client's Go repair does (offbox_lib/runs.py GO_REPAIR, "_offbox_inventory").
# Without the stamp every new box re-downloads the 75 MB archive before its first command (13 Nov 2026:
# 29 boxes doing that at once filled the server's link and runs sat in setup for 15 minutes).
(cd /usr/local/go && printf 'offbox-go-tree-v1 %s %s\n' "$(head -n 1 VERSION)" \
  "$(LC_ALL=C find . ! -type d ! -path './.offbox-manifest' -printf '%P\t%y\t%s\t%l\0' | LC_ALL=C sort -z | sha256sum)" \
  > .offbox-manifest)
curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
sudo -u user bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
ln -sf /home/user/.bun/bin/bun /usr/local/bin/bun

# Root tar extraction must not import the archive's uid into trusted PATH ancestors.
for path in /usr/local /usr/local/{bin,lib,include,share} /usr/local/bin/node \
  /usr/local/lib/node_modules /usr/local/go /usr/local/bin/{npm,npx,corepack}; do
  target=$(readlink -f -- "$path") || { echo "offbox base: cannot resolve $path" >&2; exit 1; }
  [ "$(stat -c %u -- "$target")" = 0 ] || { echo "offbox base: not root-owned: $path -> $target" >&2; exit 1; }
done
foreign=$(find -P /usr/local -xdev ! -uid 0 -print -quit)
[ -z "$foreign" ] || { echo "offbox base: not root-owned: $foreign" >&2; exit 1; }
actual=$(/usr/local/bin/node --version)
[ "$actual" = "$NODE" ] || { echo "offbox base: Node version $actual, expected $NODE" >&2; exit 1; }

# Lingering so user services (Moni's wacli-sync etc.) start with the box.
mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/user
timedatectl set-timezone UTC 2>/dev/null || true
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /etc/ssh/ssh_host_*
truncate -s0 /etc/machine-id
echo "base ok: $(node -v) $(go version | cut -d' ' -f3) $(docker --version)"
