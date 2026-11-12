# Shared scratch import names

Reports Python module names in shared scratch roots that collide with the running
interpreter's standard library, common packages, or startup customization modules.
It lists and stats entries only; it never reads or imports scratch source, accesses
credentials or APIs, opens databases, or cleans up files.

The layout follows `checks/money-cases`: a check, launcher, watcher template and
focused unittest file. Python 3.10+ is required for `sys.stdlib_module_names`.
The launcher pins Homebrew Python and uses `-I -B` so the check itself cannot load
scratch imports. `/usr/bin/python3` on this Mac is 3.9.

From a fresh `mktemp -d` cwd, use the absolute path to this package:

```sh
python3 -I -B /path/to/python-shadow/check.py --report
python3 -I -B /path/to/python-shadow/test_check.py -v
```

`--report` prints a JSON inventory and writes no state. Repeated `--root` options
replace the default roots for isolated fixtures. Defaults: `/tmp`, `/private/tmp`,
`$TMPDIR`, `~/tmp`, `/Volumes/ExternalSSD/tmp`, and the `tmp/` roots of
`t3code-fork` and `crpko-devops` on ExternalSSD. Canonical root aliases are scanned
once. Darwin's per-user temp root is also included through `confstr`, since the
watch runner's minimal environment omits `TMPDIR`. Absent optional roots are
listed; other I/O failures fail the check.

Only direct entries can shadow imports when one of those roots enters `sys.path`.
The check does not recurse into clones, virtual environments or private scratch
subdirectories. It detects `.py`, sourceless `.pyc`, native extension suffixes and
regular packages, including symlinks. Bare namespace directories are listed in the
inventory but do not alert: a regular stdlib module/package wins over them.
`__pycache__` bytecode without its source does not load as a root-level module.
An actual collision still depends on module import order (builtins/frozen/already
loaded modules may win); these are candidates, not proof of execution.

Installation and registration require the owner's approval. Nothing registers
automatically. An evaluator can copy the three runtime files (`check.py`, executable
`check.sh`, `watcher.json`) to the private watcher directory and register that
definition with `robob-watch add --json watcher.json`. Preserve the state on updates.
Before registering, review `--report` for existing offenders: the first check run
records a silent baseline, as required by the watcher contract. Run
`robob-watch test python-shadow` after registration; no LaunchAgent restart is needed.
`integrations/deploy.zsh robob-watch` alone does not register this watcher.

The runner supplies `WATCH_DIR` and `WATCH_RUN`. New or changed candidates alert
once per path/device/inode/size/mtime fingerprint. The outbox replays until the
runner's `.run-ok` acknowledges acceptance; the runner owns delivery retries after
that. Batches stay below 4,000 characters and remaining candidates follow on later
runs. State lives only in `WATCH_DIR`; findings are never deleted, renamed or moved.
`robob-watch test` supplies a scratch `WATCH_DIR` without `WATCH_RUN`; that path
gets a unique manual run identifier and never acknowledges the live state.
This is detection, not an execution guard, and it is not a substitute for `-I` on
one-off Python probes.
