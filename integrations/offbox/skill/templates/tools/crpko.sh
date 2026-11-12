# Shared by crpko-go template builds and crpko-devops per-box setup.
OFFBOX_VECTOR_VERSION=0.50.0

offbox_crpko_tools_ready() {
  [ -x /usr/local/bin/vector ] && [[ $(vector --version 2>/dev/null) == "vector $OFFBOX_VECTOR_VERSION "* ]] &&
    [ -x /usr/bin/ruby ] && [ -x /usr/local/bin/aws ] && [[ $(aws --version 2>&1) == aws-cli/2.* ]]
}

offbox_crpko_tools() (
  set -euo pipefail
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  case $(uname -m) in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo 'offbox: unsupported Crpko toolchain architecture' >&2; exit 98 ;;
  esac
  if [ ! -x /usr/local/bin/vector ] || ! [[ $(vector --version 2>/dev/null) == "vector $OFFBOX_VECTOR_VERSION "* ]]; then
    curl -fsSL --retry 5 "https://github.com/vectordotdev/vector/releases/download/v$OFFBOX_VECTOR_VERSION/vector-$OFFBOX_VECTOR_VERSION-$arch-unknown-linux-gnu.tar.gz" -o "$stage/vector.tar.gz"
    tar -xzf "$stage/vector.tar.gz" -C "$stage"
    sudo install -m 0755 "$stage/vector-$arch-unknown-linux-gnu/bin/vector" /usr/local/bin/vector
  fi
  if [ ! -x /usr/bin/ruby ]; then
    sudo apt-get install -y -qq ruby
    if [ ! -x /usr/bin/ruby ]; then
      # apt's installed-package state does not prove its files survived a snapshot.
      sudo apt-get install -y -qq --reinstall ruby
      if [ ! -x /usr/bin/ruby ] && [ -L /usr/bin/ruby ]; then
        ruby_target=$(readlink -f /usr/bin/ruby)
        ruby_owner=$(dpkg-query -S "$ruby_target")
        sudo apt-get install -y -qq --reinstall "${ruby_owner%%: /*}"
      fi
    fi
  fi
  if [ ! -x /usr/local/bin/aws ] || ! [[ $(aws --version 2>&1) == aws-cli/2.* ]]; then
    command -v unzip >/dev/null || sudo apt-get install -y -qq unzip
    # No existing AWS pin: use the latest official v2 bundle, as hosted CI does.
    curl -fsSL --retry 5 "https://awscli.amazonaws.com/awscli-exe-linux-$arch.zip" -o "$stage/aws.zip"
    unzip -q "$stage/aws.zip" -d "$stage"
    (cd "$stage" && sudo ./aws/install --update --bin-dir /usr/local/bin)
    # --update skips an existing release before repairing its command symlinks.
    aws_version=$("$stage/aws/dist/aws" --version)
    aws_version=${aws_version#aws-cli/}
    aws_version=${aws_version%% *}
    [[ $aws_version =~ ^2\.[0-9]+\.[0-9]+$ ]] || exit 98
    aws_release="/usr/local/aws-cli/v2/$aws_version"
    if [ ! -x "$aws_release/dist/aws" ]; then
      sudo mkdir -p "$aws_release/dist"
      sudo cp -a "$stage/aws/dist/." "$aws_release/dist/"
    fi
    sudo mkdir -p "$aws_release/bin"
    sudo ln -sfn ../dist/aws "$aws_release/bin/aws"
    sudo ln -sfn "/usr/local/aws-cli/v2/$aws_version" /usr/local/aws-cli/v2/current
    sudo ln -sfn /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws
  fi
)
