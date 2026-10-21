#!/usr/bin/env zsh
# Links offbox-person into the user's PATH and skills dir. Does not start any box.
set -eu
here=${0:A:h}
mkdir -p "$HOME/.local/bin" "$HOME/.config/opencode/skills"
ln -sfn "$here/bin/offbox-person" "$HOME/.local/bin/offbox-person"
ln -sfn "$here/skill" "$HOME/.config/opencode/skills/offbox-person"
print "linked offbox-person -> $HOME/.local/bin/offbox-person and skill -> $HOME/.config/opencode/skills/offbox-person"
