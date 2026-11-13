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

background_payload = None
if sys.argv[1:2] == ['_bg-queue']:
    import faulthandler
    faulthandler.enable(file=sys.stderr, all_threads=True)
    import json
    background_payload = json.load(sys.stdin)
    os.environ.clear()
    os.environ.update(background_payload['env'])
    with open(os.devnull, 'rb') as background_stdin:
        os.dup2(background_stdin.fileno(), 0)

from offbox_lib import common  # noqa: E402

# One backend per process, fixed before api and capacity bind their backend at import.
try:
    common.select_backend(background_payload['backend'] if background_payload is not None else
                          common.entry_backend(sys.argv[1:]))
except common.OffboxError as error:
    common.say(str(error))
    sys.exit(error.code)

from offbox_lib.cli import main  # noqa: E402

if __name__ == "__main__":
    if background_payload is not None:
        from offbox_lib.runs import background_queue
        sys.exit(background_queue(sys.argv[2], background_payload))
    else:
        sys.exit(main())
