#!/usr/bin/env zsh
# Links authbox into the user's PATH and skills dir. Does not start any box.
set -eu
here=${0:A:h}
mkdir -p "$HOME/.local/bin" "$HOME/.config/opencode/skills"
ln -sfn "$here/bin/authbox" "$HOME/.local/bin/authbox"
ln -sfn "$here/skill" "$HOME/.config/opencode/skills/authbox"
print "linked authbox -> $HOME/.local/bin/authbox and skill -> $HOME/.config/opencode/skills/authbox"
