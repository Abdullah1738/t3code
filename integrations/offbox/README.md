# offbox

Sends heavy agent work (test suites, installs, builds, Docker) to boat.dev VMs
instead of the Mac, and runs light Go checks locally in a macOS sandbox.

| Path here | Live copy |
| --- | --- |
| `skill/` | `~/.config/opencode/skills/remote-compute/` (the `remote-compute` skill, `offbox` CLI, classifier, monitor, box templates) |
| `plugin/offbox-gate.ts` | `~/.config/opencode/plugin/offbox-gate.ts` (OpenCode shell gate, loads at OpenCode start) |
| `bin/boat` | `~/.local/bin/boat` (boat CLI wrapper, signs in from Keychain `boat-api`/`ardud`) |
| `launchd/com.ardud.offbox-monitor.plist` | `~/Library/LaunchAgents/` (load monitor + reaper) |
| (link) | `~/.local/bin/offbox` -> `skill/scripts/offbox.py` in the live skill |

State stays outside the repo: `~/.local/share/offbox/` (offbox.db, logs,
backups), gate mode `~/.config/opencode/offbox-gate.json`, boat token under
`~/Library/Application Support/ascii/boat/`.

`skill/scripts/blockers/` goes first on every agent shell's PATH. Besides the
`docker` guard it holds `wacli`, `himalaya` and `himalaya-heal`, which refuse
sends so agents go through `wa` and `mailsend` (robob-watch helpers) and
Abdullah's OK on the exact draft. Reads and drafts pass through.

## Changing it

This tree is the source of truth. Every change is committed and pushed to
`origin main` before it goes live; `install.zsh` refuses unpushed changes.

```bash
cd integrations/offbox/skill/scripts
python3 -m unittest discover -s tests -p 'test_*.py'   # ~1-2 min
OFFBOX_RULES=../heavy-rules.json python3 classify.py --test
(cd tests && unset BUN_INSPECT && bun test classify.test.ts gate-plugin.test.ts)
cd ../.. && git commit ... && git push origin HEAD:main
./install.zsh --dry-run && ./install.zsh               # or: integrations/deploy.zsh offbox
./install.zsh --check                                   # live copy == repo, HEAD on origin
```

`install.zsh` restarts the monitor LaunchAgent. A gate plugin change only
takes effect after an OpenCode restart, which needs Abdullah's go.
