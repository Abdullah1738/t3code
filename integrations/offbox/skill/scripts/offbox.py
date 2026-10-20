#!/opt/homebrew/bin/python3
"""offbox: heavy agent compute (tests, installs, Docker) runs on boat.dev VMs, not on Abdullah's Mac.

Entry point only; logic lives in offbox_lib/. Skill: ~/.config/opencode/skills/remote-compute/SKILL.md.
State: ~/.local/share/offbox/ (offbox.db, exemptions.json, cap.json, local.sem*, logs/, ssh/).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from offbox_lib.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
