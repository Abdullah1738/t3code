#!/opt/homebrew/bin/python3
"""offbox: heavy agent compute (tests, installs, Docker) runs off Abdullah's Mac: on the home offbox server
when one is configured and up, on boat.dev VMs otherwise.

Entry point only; logic lives in offbox_lib/. Skill: ~/.config/opencode/skills/remote-compute/SKILL.md.
State: ~/.local/share/offbox/ (offbox.db for Boat, offbox-home.db for the home server, exemptions.json, cap.json,
local.sem*, logs/, ssh/).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from offbox_lib import common  # noqa: E402

# One backend per process, fixed before api and capacity bind their backend at import.
try:
    common.select_backend(common.entry_backend(sys.argv[1:]))
except common.OffboxError as error:
    common.say(str(error))
    sys.exit(error.code)

from offbox_lib.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
