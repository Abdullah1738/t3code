#!/bin/bash
# Runs inside a fresh images:ubuntu/24.04 container; the result is published as `offbox-base`.
# Mirrors what offbox relied on in boat.dev's base box: user `user` (uid 1000) with passwordless sudo, sshd,
# Docker + compose, git/rsync/jq/build tools, Node 24 + pnpm, Go, Python 3 + uv, bun. Template recipes
# (offbox skill/templates/*.sh) add the per-stack tools on top.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server sudo ca-certificates curl wget gnupg git rsync jq \
  build-essential pkg-config make unzip zip xz-utils zstd file less vim-tiny procps psmisc lsof iproute2 \
  iputils-ping dnsutils python3 python3-venv python3-pip python3-dev tzdata locales util-linux tmux htop \
  fuse-overlayfs >/dev/null
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
NODE=v24.22.1
curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
corepack enable
npm config -g set update-notifier false fund false audit false
GO=1.26.9
curl -fsSL "https://go.dev/dl/go$GO.linux-amd64.tar.gz" | tar -xz -C /usr/local
ln -sf /usr/local/go/bin/go /usr/local/bin/go; ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
sudo -u user bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
ln -sf /home/user/.bun/bin/bun /usr/local/bin/bun

# Lingering so user services (Moni's wacli-sync etc.) start with the box.
mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/user
timedatectl set-timezone UTC 2>/dev/null || true
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /etc/ssh/ssh_host_*
truncate -s0 /etc/machine-id
echo "base ok: $(node -v) $(go version | cut -d' ' -f3) $(docker --version)"
