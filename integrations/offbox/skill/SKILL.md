---
name: remote-compute
description: Use for any heavy test suite, dependency install, build or Docker/compose/testcontainers work - it runs on an offbox machine (the home offbox server when one is set up, else a boat.dev VM) via `offbox run -- <cmd>`, not on Abdullah's Mac.
---

# remote-compute: heavy work runs on the offbox server

Abdullah's Mac (M4 Max) sits at load 100+ when agents run test suites, installs and Docker stacks locally. That
work runs through `offbox` on boxes (x86_64 Ubuntu 24.04, Docker included): since 12 Nov 2026 on his own server at
home, unmetered and uncapped, with boat.dev VMs as the standby when it is down (see "Home server, Boat standby"). A gate
(worker C's plugin + Docker shim) denies heavy commands that don't go through offbox. Owner decisions and the
interface contract: `/Users/ardud/.robob/scratch/2026-10-13-we-often-run-simulations-tests-24789d2f/plan.md`.

## The one rule

Prefix heavy commands with `offbox run --`, from the same directory you'd run them in:

```bash
offbox run -- go test ./...
# Choose these commands with 'Install with the repo’s package manager' below.
offbox run -- '<repo-install> && <repo-test>'
offbox run -- 'docker compose up -d && ./scripts/health.sh'      # one string = run by bash
offbox run --size xlarge -- make test-integration
```

offbox finds the repo root (`git rev-parse --show-toplevel`, else cwd), rsyncs it to your box (only changed files;
gitignored files git doesn't track, `.git`, secrets and `node_modules`/`.terraform`/caches are not sent; a tracked
file sends even when .gitignore matches it, e.g. a committed `package-lock.json`), `cd`s into the same relative
dir, runs, streams stdout/stderr live, and exits with the remote exit code. Ctrl-C/SIGTERM kills the remote process.

A repo’s pool name (at home and on the Boat standby alike) comes from its origin URL’s basename, normalized to lowercase letters, digits and dashes.
If git is slow or fails, offbox reuses the last good name for that resolved checkout root and logs the fallback; a first failure warns before using the directory name.

**Where it runs.** With no home server set up (no `~/.local/share/offbox/server.json`, or `"disabled": true` in
it), everything below is boat.dev, as it always was. With one, see "Home server, Boat standby".

**No caps, no meter (owner, 13 Nov 2026).** The home server costs nothing per run and has no spend cap, no start
limits and no usage limit: use it as much as the work needs. When it is full, runs queue (first the repo's pool on
the Mac, then the server's own memory queue) and start by themselves. A queued run prints `queued for a ... pool
box` or `offbox-server: waiting for memory`: **leave it waiting**. Do not kill it, retry it, shrink the job or move
it to the Mac because of a queue. For a wait that may outlast your tool call, start it with `--bg` and collect it
with `offbox wait <run>`.

**Every `offbox run` goes to a box.** The local-first lane (light Go checks on the Mac, 2026-10-19) is retired: it
existed to save boat.dev minutes. `OFFBOX_LOCAL_FIRST` no longer does anything. A narrow check the gate allows can
still be run directly on the Mac without offbox; that is your choice, not a cost rule.

Heavy = `go test` (multi-package or no `-run`), `pytest` with no named file, on a dir, with a glob/brace expansion
or `$VAR`/`$(...)`, or with `-n`; `jest`/`vitest`/`bun test`/`vp test` without 1-3 named files,
`npm ci`/`npm install`/`pnpm install`/`yarn install`, `docker run/build/compose up`, testcontainers, `gradlew`,
`cargo build/test`, `make test`, `forge test`/anvil. In review/worktree clones (`/tmp`, `$TMPDIR`, `coord-wt`,
`crw` work dirs) also `go build`/`go vet` of `./...` or 4+ packages, project-wide `tsc`, `eslint .` and
`npm run typecheck|lint`.
In a repo whose go.mod has testcontainers, `go test -run X ./pkg` stays local only if that package (and what it
imports from the module) never mentions testcontainers. The harness template's FDB image is prebuilt for the default
compose project (`platform`).

**Stays local** (don't wrap): `xcodebuild`, `adb`/`ph`, mitmproxy, Dia, `terraform` (AWS creds), `git`, and
narrow tests: `go test -run TestX ./pkg`, `jest path/file.test.ts` (up to 3 files), `pytest a.py b.py::test_x`
(any number of named files), and `--version`/`--help` calls or `command -v` lookups. Wrap a narrow
test only when it needs Docker or Linux (testcontainers, e.g. rewards' Postgres conftest; a container an earlier
box step started). Small scripts over local files (`python3 -c`, `node -e`, parsing a log you have here) belong
on the Mac, not on a box.

If something must run on the Mac (needs local devices, AWS creds, the local Docker daemon on purpose), log an
exemption first; the gate and monitor respect it:

```bash
offbox local --reason "xcode UI test needs the local simulator stack" --ttl 1h
offbox local --list ; offbox local --clear
```

A Claude Code subagent (in-process child) shares its parent's session id, so its exemption and its `--clear`
cover its own Robob thread only, never the parent's or a sibling's. An inherited `OFFBOX_THREAD` only counts for such
a child when it names the child itself.

The monitor ignores apps opened by LaunchServices (XPC_SERVICE_NAME=application.*) that carry an agent's session id from the shell that opened them; reopen apps with a clean env anyway.

## Install with the repo's package manager

Before installing or writing a review packet, inspect the **pinned checkout's repo root**.
Record the Node version, manager/version, install command and the files that chose them:

1. Read `package.json` `packageManager` first. `pnpm@x` → `corepack pnpm@x install --frozen-lockfile`;
   `yarn@x` → `corepack yarn@x install --immutable` (v2+) or `--frozen-lockfile` (v1);
   `npm@x` → `npm ci` using that npm version. `bun@x` → `bun install --frozen-lockfile` using that Bun version.
2. Without that field, use the lockfile: `pnpm-lock.yaml` → the shared CI pin, or pnpm 10 for lockfile 9.0 (`corepack pnpm@10 install --frozen-lockfile`);
   `yarn.lock` → Corepack Yarn (v2+ `--immutable`, v1 `--frozen-lockfile`);
   `bun.lock` / `bun.lockb` → `bun install --frozen-lockfile`;
   `package-lock.json` / `npm-shrinkwrap.json` → `npm ci`; none → `npm install`.
   Resolve contradictory metadata against CI; never generate a different manager's lock to get past an error.
3. Inspect `.github/workflows` and any setup action it calls. Copy the matching install step's flags,
   including frozen/immutable, script and workspace options. Use the repo's own bootstrap when required
   (e.g. `vp i` for this fork, once the manager install has put vite-plus in node_modules). An npm pin without its npm lockfile is a repo prerequisite to resolve, not a
   reason to run a different manager. Hints cover common literal pins; inspect expressions/matrices yourself.
4. Select **versions**, not just a manager name. Node: `.nvmrc` / `.node-version`, then `engines.node`,
   then CI `setup-node`; offbox follows the CI setup-node version when the repo has no pin.
   Use an installed match on local narrow checks (e.g. put its `~/.nvm/versions/node/<version>/bin` first
   on PATH); offbox provisions a matching Node or stops before the command. Log `node --version`.
   pnpm: `packageManager`, then CI `PNPM_VERSION` / `pnpm/action-setup` `version`. Run it explicitly pinned
   (`corepack pnpm@10 ...` for CI major 10), never a conflicting global pnpm. Check the selected manager's
   `--version` under that Node before both install and checks; select matching npm/Yarn/Bun versions too.
5. Run scripts/tools with that same manager and version (`corepack pnpm@10 run lint`,
   `corepack pnpm@10 exec vitest ...`, `corepack yarn@4 run lint`, `npm run lint`, `bun run lint`).
   Do not substitute `npm run` / `npx` for pnpm/Yarn/Bun, or download an unpinned test tool.

Borrowed `node_modules` (a symlink to another checkout) is not an install target. pnpm 11 can correctly refuse
`exec`/scripts with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` when the source lock differs. For a narrow local check,
use the repo's supported Node and `node_modules/.bin/<tool>` (or the pinned pnpm's
`--config.verify-deps-before-run=false exec`) **only after checking the tool and test-relevant dependency
versions against the pinned lock**, and name those checks in the evidence. This is a scoped workaround,
not proof of a clean install. Otherwise install from the pinned lock in the isolated offbox checkout.
Never install into shared symlinked dependencies.

Put the selected install and check in the same `offbox run -- '<repo-install> && <repo-check>'` call.
Stop on an install failure before reporting later tools as failed code checks. Commands in examples below
are placeholders unless they name a particular repo; apply this check first.

## Your box (lease)

A new worktree’s first run on a box can take minutes; it is seeded from a sibling when available. For long first syncs, use `--bg` and `offbox wait` instead of a short shell timeout.

- Up to **four pooled boxes per repository key** (default raised from 2 on 2026-10-17 for the PR factory ramp), shared by threads and worktrees. An idle running box is preferred,
  then an existing stopped box; legacy boxes are adopted without deleting their disks. Each box runs one command
  at a time, including sync and artifact pulls. Background runs reserve their slot until completion. Checkout
  directories remain separate per local repo path. Installs stay on the box that ran them; the next run, including
  an auto-sized typecheck, may get another pool box, so install and run in the same call (examples below). Old
  checkouts are deleted at run start: a box keeps the 10 most recent used in the last 3 days plus any used in the
  last 12 h (`OFFBOX_PRUNE_KEEP`, `OFFBOX_PRUNE_DAYS`), so a worktree idle for days may sync and install deps again.
- A busy pool is a queue (progress line every 60 s). At home the run waits for a free box for up to 24 h and then
  starts; a repo pool has up to 8 boxes (`OFFBOX_POOL_SIZE`, 1-64). On the Boat standby it waits **up to 600 seconds**
  and then returns **92** (nothing ran; retry), with 4 boxes (`OFFBOX_POOL_SIZE` 1-16; raised from 8 for TorSSH by
  Abdullah, 12 Nov 2026) and `OFFBOX_POOL_WAIT_SECONDS` 0-1200. Sizes are minimums on pooled boxes; a larger warm box is reused.
  Waiters are served in arrival order among callers that can use the same box or create slot; `OFFBOX_POOL_SIZE`
  raises the cap for the whole pool while that caller is waiting or holds a box. The queue line separates busy
  boxes, idle boxes that cannot serve this run, and boxes being created, shows source-compatible members for
  `--template`/`--base` and your place in line, and explains any surplus over the cap.
- Boxes stop after **5 min idle (xlarge) or 10 min (other sizes)**. 20 min if a run on the box started a container in
  the last 2 h (offbox checks `docker events` at the end of each run; a testcontainers manifest alone no longer
  counts) or half the hourly/daily start allowance is used, 60 min once 75% of the daily allowance is used or during a start
  cooldown (stopped = free; boat keeps the disk 14 days after the stop, then deletes it). When a run ends after its client dies,
  the reaper brings the box back to its idle window instead of the 30-min run ttl. A resume takes ~6-10 s. Resuming that box keeps everything
  you installed (`node_modules`, Go module cache, files in ~, Docker named volumes). Docker images are kept too:
  boat drops image layers on stop, so offbox archives them into ~ before every stop and reloads them at boot
  (a few seconds to ~20 s for big stacks; runs wait for it automatically).
- Before each command, pooled boxes report and remove containers left by earlier runs (best effort); boxes pinned with `offbox keep`, saved bases and private leases only report them.
- Crpko ClickHouse 24.8 alert fixtures need `max_threads=8` on large and xlarge boxes: ClickHouse's own 10000-thread pool runs out on 32 CPUs, and raising OS limits doesn't help.
- Warm runs avoid a sandbox start; queueing and synchronization can add latency.
- Put the repo-selected install and command together (see **Install with the repo's package manager**):
  `offbox run -- '<repo-install> && <repo-check>'`. Use `&&` so an install failure stops dependent checks;
  `--step` deliberately keeps going after a failed step.
  A missing node_modules bin (`command not found`, exit 127, or `not found` under npm/pnpm, exit 1/254) can mean
  that box has no deps yet; local `node_modules` is never synced. Once #466's own-box affinity is installed,
  separate runs can reuse deps while no box switch is reported.
- Node version: offbox selects Node from the repo pin (`.nvmrc`/`.node-version`/`engines.node`), then the CI setup-node version, then the nvm default (or newest installed nvm Node, otherwise the box default), and prints its choice, provisioning a missing pinned version or stopping with exit 99.
- In JS repos, runs put the current directory's and ancestor `node_modules/.bin` directories up to the repo root first on PATH, so repo-pinned `vp`/`tsc-rs` win over global copies, including after `cd apps/server`. On a fresh checkout or box, install with the repo's package manager first (see **Install with the repo's package manager**); `vp i` itself needs vite-plus installed.
- pnpm: repos with `pnpm-lock.yaml` use `packageManager` (including explicit pnpm 11+) > CI `PNPM_VERSION` / `pnpm/action-setup` version > lockfile compatibility (9.0 → pnpm 10; fallback never 11+). A verified package in the box-local cache supplies a PATH shim, bypassing Corepack defaults. `offbox: pnpm vX (<source>)` records the selection; activation failure exits 99. Matching installed/cached toolchains make no network requests. Downloads retry all errors twice with 20 s connect, <30 KB/s for 60 s stall, and 600 s per attempt limits.
- Source of a new lease: `--base N` > the repo's default saved base > the repo's template > `generic`. If boat has
  deleted a template's data, the run builds its box from the template's recipe instead (a few minutes; `offbox:`
  says so) and the reaper rebuilds the template. An expired default base falls back to the template.
  Templates: `crpko-go` (Go 1.26 + FDB client + warm module cache, large), `crpko-node` (nvm Node 20, 22 (>=22.13) + 24, warm npm cache,
  large), `crpko-harness` (large, harness Docker images pre-pulled when the registry allows; rate-limited pulls retry, and
  a failed pre-pull doesn't stop the box, the images are then pulled on first use), `generic` (default).
  Auto-pick: crpko-devops → crpko-go; repo key containing `harness` or go.mod with testcontainers → crpko-harness; other
  go.mod → crpko-go; package.json → crpko-node; otherwise generic. A root compose file alone doesn't pick a template.
  Each run prints the template it picked and why; `--template` overrides it.
- On each box, crpko-devops runs check Vector 0.50.0, `/usr/bin/ruby`, GitHub CLI (`gh`), AWS CLI v2, GNU time (`/usr/bin/time`), the Terraform version pinned in the checkout's `terraform-dev.yml` and a local Terraform provider mirror pre-filled from the repo's lock files and unpinned fixtures (`TERRAFORM_PROVIDER_MIRROR`). Missing or wrong versions are installed on the first run there (a few minutes); ready boxes only run a fast check. Binaries are installed on the runner PATH under `/usr/local/bin` (Ruby and gh are installed by apt under `/usr/bin`). It has no package-lock.json, so run tests directly or use `npm install`, not `npm ci`.
- LocalStack calls must still point `aws` at its endpoint (`--endpoint-url` or `AWS_ENDPOINT_URL`). Box runs get no AWS credentials unless forwarded with `--env`.
- Type-check runs (tsc, tsc-rs, `vp run typecheck`) in JS/TS repos get xlarge by default; large boxes run out of memory on the Robob server typecheck.
- Other automatic xlarge (no `--size` given; offbox says why): compose/LocalStack/testcontainers in the command,
  any run in a `*harness*` repo, a whole suite (`./...`, `make test`, bare `pytest`) in a repo whose manifests use
  testcontainers. An exit 137 bumps later runs of the same kind (pytest, vitest, tsc, `make test`...) in that repo one
  size up from the box it was killed on, for 3 days; other commands in the repo keep their size. Everything else
  runs at the template/base size (large; generic default). Real per-job peak is ~12 GB, which large (16 GB) holds.
- Sizes: `small` 2 vCPU/4 GB, `default` 4/8, `large` 8/16, `xlarge` 16/32. Growing an idle pooled box requires
  a start allowance (stop + resume). Use xlarge only for big Docker stacks. Don't pass `--size` for ordinary runs:
  the template/base size is right. `--size xlarge` is kept for Docker commands, type-checks, the harness repo and whole
  test suites in a testcontainers/compose repo; anything else (incl. one named test or file) with no same-kind OOM
  behind it runs on large and says so (5 Nov: 1,054 hand-picked xlarge runs, mostly uv sync + pytest and narrow go tests);
  `OFFBOX_ALLOW_XLARGE=1` forces it. A pooled box grown for one xlarge run goes back to its natural size (template
  or base size, at least large; generic stays default) the next time it resumes. While starts are plentiful an
  oversized running box is skipped for a stopped one so it can stop on its short timer; a grown xlarge box is
  skipped even when it is the one you used last (5,448 ordinary runs rode grown xlarge boxes, 13 Oct - 5 Nov). A live box is never stopped just to shrink it, and a shrink boat refuses resumes at the old size.
  A stopped box whose disk has outgrown its size (boat 409 "needs N GiB of disk") is skipped and marked too big: it
  stays stopped with its disk, stops counting toward the pool, and the run moves on to another pool box or a fresh
  lease. `offbox list` shows it; `offbox release <id> --delete` removes it.
  When boat has no machines of a size ("supply for size xlarge is over"), offbox stops trying that size for 10 min (OFFBOX_SUPPLY_COOLDOWN_SECONDS) and resumes or creates the pool box one size smaller (never below large), unless you passed --size or offbox picked xlarge for the run itself (container stack, typecheck, recent OOM): then it queues and returns 90 "nothing ran" if the size doesn't come back. `offbox status` shows `boat supply: ... out until`.
  A box whose filesystem has died (`Transport endpoint is not connected`) is caught by a write check before the sync, or by the sync itself: it is stopped, marked `dead-mount:` and taken out of the pool, and the run moves to another box (once). `offbox list --all` shows it; `offbox release <id> --delete` removes it.

## Options

| Flag | Use |
|---|---|
| `--size S` / `--template T` | machine size / template for a new lease |
| `--env VAR` (or `VAR=val`) | forward a variable. Only CI=1 plus a safe allowlist (TZ, LANG, GOFLAGS, NODE_OPTIONS, ...) is sent by default. Box runs also get AWS_EC2_METADATA_DISABLED=true (boxes have no AWS metadata service); `--env AWS_EC2_METADATA_DISABLED=false` turns it off. Other AWS_*, tokens and keys are **never** forwarded unless you name them. For a secret, export it and pass the name only (`export LOCALSTACK_AUTH_TOKEN=...; offbox run --env LOCALSTACK_AUTH_TOKEN ...`): a `NAME=value` value sits on offbox's command line, where ps and transcripts see it (offbox.log keeps only the name). |
| `--pull PATH` | copy an artifact back after the run (coverage.out, junit.xml, `test-results/`), relative to your cwd |
| `--git` | export a portable `.git` with the selected checkout's exact HEAD and ancestor history |
| `--include PATH` | sync a path the filters skip (e.g. a committed `testdata/server.key`). Under a gitignored dir such as `tmp/`, only that path mirrors; the box's other files in that dir are kept |
| `--no-sync` | run without syncing (box already has what you need) |
| `--bg` | queue in a detached client and return a run id at once, even while the pool is full; then `offbox logs <id> --follow` / `offbox wait <id> [--timeout S]` (exits with its code, does `--pull`). Client diagnostics: `logs/<id>.client.log` in the offbox state directory. |
| `--base N` / `--fresh` | new lease from saved base N / ignoring bases and templates. `--fresh` doesn't always mean a new box: in the repository pool it can still reuse a pool box that was itself created fresh. In a full pool with no box of that kind, it stops at once (exit 2) instead of queueing. It isn't a way off a bad box: offbox now stops broken boxes itself, and `offbox release <id>` stops one by hand. |
| `--no-fallback` | return 90/91 instead of falling back to a local run |
| `--remote` | same as `--no-fallback` (kept for old commands; every run uses a box now) |
| `--step CMD` (repeatable) | run several checks with a real exit code each (see Fallback and exit codes) |
| `--no-retry` | home server only: if the server restarts under this run, don't run it again (exit 94). For commands that are not safe to run twice (a deploy, a migration, anything that sends) |

Runs longer than 10 minutes are fine (every run is a boat background command, reattached on network blips).
For long gates, use `offbox run --bg …` followed by bounded `offbox wait <run-id> --timeout 45` calls; do not rely on setsid or detached tmux to protect a foreground client from interruption.
If Robob restarts on the Mac during a foreground run (home box or Boat), the run detaches and keeps going; re-attach with `offbox wait <run-id>` (client exit 95). The home server itself restarting is a separate case (exit 94, below).
Ctrl-C, Stop and SIGTERM-based timeouts still kill the run; a native SIGKILL cannot be caught by offbox.
The reaper refreshes the box's deadline while the remote run is confirmed live, even if its starting client is gone, for up to 6 hours from run start.
`offbox wait` / `logs --follow` on a run whose own `offbox run` is still following it waits for that run to record
its end and returns its code. If the box says the process ended but that `offbox run` still hasn't recorded it a
minute later (30 min with `--pull`), wait returns the box's exit code and says the other client looks stuck.
`--timeout S` stops waiting after S seconds with exit 124; the run keeps going.
On a run still queued for a pool box they say "waiting for a box" and keep polling until it gets one or settles.
A queued `--bg` run survives its caller ending. If the offbox client itself dies before getting a box, wait marks the run lost and wait/logs return 100 ("never started; nothing ran, safe to rerun").

`--git` works with normal checkouts and linked worktrees, including detached HEADs. It exports only HEAD's
reachable history and branch/remote/tag refs whose commits are ancestors of HEAD; divergent refs and other
worktrees' private histories are omitted. Shallow history stays shallow; locally available alternate objects
are packed into the export. It does not copy Git config/credentials, hooks, reflogs, stashes, other worktree
metadata or the local index. The remote index starts at HEAD; dirty/untracked working files use the usual
sync filters, so staged changes appear as unstaged remotely. A committed HEAD and locally available objects
are required (no automatic fetch). Committed content in the exported history remains available to Git,
including paths excluded from the working-file sync. The local Git state is read-only. Submodule git-dirs
are not materialized. Each `--git` sync rebuilds and replaces the remote metadata; `--no-sync` retains it.
A partial clone (`--filter=blob:none`, e.g. the board's mobile review worktrees) usually lacks old blobs: `--git`
then sends HEAD alone as a one-commit shallow `.git` and says so in one line. If even HEAD's files aren't local
(a `--no-checkout` partial clone) it stops before syncing and tells you to run without `--git`.

UIs/dashboards on the box: `offbox ports 3000` opens `http://127.0.0.1:3000` on the Mac via an SSH tunnel
(`--local 13000` to pick the local port). `offbox ports 1055 --local 8080 --reverse` goes the other way: the Mac's
`127.0.0.1:8080` shows up on the box at `127.0.0.1:1055` (e.g. a Mac-side proxy). Interactive shell or one-off command: `offbox ssh` / `offbox ssh -- 'docker ps'`.

### Control a box without SSH

`offbox exec [box_id] [--timeout N] [--cwd DIR] [--json] -- <command...>` runs through the authenticated
offbox server API, owner-checked, on home or Boat. With no box ID it uses this caller's current lease.
Use `offbox exec <box> -- <cmd>` when a guest has stopped, masked or replaced its own sshd (for example
TorSSH testhost fixtures). Never bypass a host-key mismatch by editing known_hosts or disabling strict
host-key checking. `boat exec` is Boat-only and returns 404 for home boxes.
Timeout defaults to 60 seconds and is clamped to 1..600. Output goes to stdout/stderr, or `--json` prints
the raw result dict; the CLI returns the remote exit code. API/transport failures exit 90. A box ID selects
its recorded backend; a failed request never retries on the other backend. This command does not sync files.

## Repo toolchains

The `usdtwallet-android` repo recipe installs JDK 17, Android command-line tools, SDK platforms 37.1 and 36,
build-tools 36.0.0, platform-tools, NDK 26.3.11579264, and gomobile/gobind pinned to `core/go.mod`.
Offbox sets `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME` and `PATH` for you: no export
prefix is needed. Setup is locked per box and skipped after success; recipe or x/mobile version changes rerun it.
Boxes the pool grows into (including through `OFFBOX_POOL_SIZE`) or resumes start with whatever they had and
get the toolchain on their first run.

`android/app/libs/` AARs aren't synced, so every Android run starts with `./scripts/build-core.sh` before Gradle.
Run Gradle online (no `--offline`): every box has its own Gradle cache, and an offline run can miss dependencies.
JDK 25 for the wallet's unit tests is resolved by Gradle's existing toolchain resolver.

To add another repo, add `templates/repos/<repo_key>.sh`. The recipe gets `OFFBOX_REPO_ROOT` pointing to the
synced root and must write `~/.offbox/repo-env/<repo_key>.sh`. A failed setup stops before your command and
returns infra exit 90 (internal exit 98); its log is `~/.offbox/repo-setup-<repo_key>.log` on the box.

## Save state for later (do this!)

Stopped boxes are free, but boat deletes a stopped box's data 14 days after its last stop. Bases and templates
are also kept as boat saved snapshots (no expiry; the plan includes 50, offbox never pays for more), and the reaper
resumes+stops pinned leases and unsaved bases/templates before day 14. Save generously:

- After an expensive setup (the repo-selected install above, `go mod download`, harness images pulled, a seeded database), run
  `offbox save --default --note "repo deps installed at <sha>"`. New threads on this repo then start from that state and
  only rsync the delta. `save` briefly stops your lease to capture it (the next run resumes it), costs one machine
  start (~15-25 s), then $0. Names: `offbox save --name pg-seeded`; use one
  later with `offbox run --base pg-seeded -- ...` (only for a new lease).
- `offbox bases` lists saved bases and whether each is kept (saved snapshot), box-only (with the date boat deletes
  it) or EXPIRED; `offbox base rm <name>` removes one. Bases are never auto-deleted by offbox.
- `offbox keep --days 30` pins your current lease so the reaper never deletes it and keeps its disk past boat's
  14 days (it still stops when idle). Unpinned leases stopped 14 days are gone; the next run starts a new box.
- Leases are deleted only when their thread has been archived for 7 days, or unused for 30 days and not pinned.

A saved base retains its checkout path in project build state. When offbox relocates that checkout for another local path, it clears project `.gradle` directories before the move, including nested Gradle builds; shared Gradle user-home dependency caches and module build outputs stay warm. For a lease created before this fix, move aside the project's `.gradle` once before rerunning Gradle. When a base is restored under a new directory, offbox removes CMake caches that name the old path.

## Housekeeping

- `offbox list [--all]`, `offbox release` (stop your lease now), `offbox release --delete` (throw the disk away),
  `offbox whoami`, `offbox status`.
- `offbox kill <run>` stops your starting/running box run and marks it `killed` once the backend confirms the process
  stopped. Release refuses while a run is active and names the run ids. Use kill, not pkill on the box.
  Local runs are refused. It also cancels your own run before its command starts, whether queued for a box or
  still syncing/starting on one, by sending SIGTERM to its proven client and letting it release the pool guard.
  If the client has not settled the row after 15 seconds, check `offbox list`; kill does not force it to stop.
- A run that never got a box and whose client is gone is marked lost by the reaper within 5 minutes.
- Before ending a long task you don't need to do anything: idle boxes stop themselves. Release explicitly if you
  are done with a big (xlarge) box.

## Home server, Boat standby

On home boxes the stock ssh.service on port 22 is yours (stop, mask or replace it); offbox manages the box through its own `offbox-mgmt-ssh` service on port 2222, which you must leave alone.

Once `bootstrap.zsh client` has written `server.json`, runs go to Abdullah's own server at home (boatd; same
commands, same box model, no hourly price, no start limits, no spend cap). Boat stays as the standby. Each
`offbox run` picks its backend once, when it starts:

- A health monitor on the Mac checks the server every minute and writes `backend-state.json`. Up: the run goes
  home. A run double-checks a down state with a live probe before choosing Boat. Alerts recover after 3 good
  checks; nothing to switch by hand. `offbox status` shows which one is in use.
- Marked up but not answering when your run starts (or while its box is being fetched): the run moves to Boat
  before it is sent, with one line (`... this run goes to Boat instead`). **Once the server accepted a run it
  never moves**, so nothing runs twice. A server that says it is starting is waited for (up to 600 s) instead of failing over. A slow but reachable server is waited for; runs move to Boat only when home is offline or refusing work, or has not answered for 5 minutes.
- A run naming `--base` saved only on home waits for home (exit **93** when the wait expires) and never runs on Boat's template.
- The server restarts under an accepted run (power cut, reboot, boatd restart): the client reconnects for up to
  15 minutes and carries on from where the output stopped. If the machine itself restarted, the server runs the
  command **again from the start, once**, and you get one line saying so (`... running it again from the start
  (attempt 2)`). Runs the server had queued start after it. `--no-retry` turns the second run off; the run then
  ends with **94**.
- Each backend has its own boxes, saved states and templates. `offbox bases` lists both backends; expired bases
  are hidden unless `--all`. An unpinned run naming a base that exists only on Boat uses Boat and says so.
  `offbox list` shows the selected backend; `logs`, `wait`, `kill`, `release`, `ssh` find the right one from the
  run or box id. A saved state or template
  that exists only at home is not on Boat: a standby run says so in one line and uses a plain Boat box, so the
  first standby run of a repo is a cold one.
- Person work (`offbox-person`, Moni's box) never goes to Boat. Server down = exit **93**, nothing ran; it waits.
- Home boxes reach the internet through Mullvad VPN (exit: Frankfurt, a shared VPN address), Docker inside them
  included, and nothing leaves without the tunnel (owner, 12 Nov 2026). So a site can answer a home run with a
  captcha, a 403 or German content where a Boat run got through; that is the VPN address, not your code. DNS
  goes to the server's resolver whatever the box asks for. The home server's own tailnet and LAN services are
  not reachable from a box. A tunnel that stays down for 2 minutes makes the server report itself not ok, and
  runs go to Boat like in any other outage; a run caught in that gap fails on its downloads, run it again
  (server side: `server/home/README.md`, "VPN (Mullvad)").
- A few sites refuse VPN addresses outright. Box connections to the names on the server's list (now
  `dl.google.com` and `go.dev`: Go toolchains, Android SDK) leave through one residential address instead. If
  another site refuses a home box (403/404/captcha there, fine from the Mac), don't work around it: report the
  host name so it can go on the list (`server/home/README.md`, "Residential exit"). The list stays short
  because that address has a traffic limit.
- At home every owner has their own token and it only sees that owner's boxes, saved states and templates. Plain
  `offbox` (reap, pools, `release`, `ssh`, `ports`, `logs`, `wait`, `kill`) only acts on our own. A box or run id
  of a person's box is refused with exit 2 ("belongs to moni ..."), nothing changed: go through `offbox-person`.
  A person's new box starts fresh, never from our templates or saved states.
- The Boat cap, `offbox spend` and the start limits below apply to standby runs only. offbox reads Boat's plan
  from its API: on a plan without xlarge machines a standby run that asks for `--size xlarge` gets `large` with
  one line, and the start limits follow the plan (85% of what it includes).
- Pin by hand only for maintenance: `OFFBOX_BACKEND=boat|server` for one command, or the one word in
  `~/.local/share/offbox/backend`. A pin switches automatic failover off.

## Costs and the cap

$100/month plan. default $0.036/h, large $0.072/h, xlarge $0.20/h; stopped boxes, auto snapshots and the plan's 50
included saved snapshots are free. `offbox spend` reads the account meter once and shows billing-period spend. Abdullah gets a Telegram
at every $100. At $1200 the cap trips (raised from $500 to $750 by Abdullah on 5 Nov 2026, to $900 on 10 Nov 2026, then to $1200 on 12 Nov 2026): new leases are refused and all boxes stop. Heavy work returns 91.

Create, fork and resume each consume a start. Offbox reserves starts atomically against rolling **25/minute,
180/hour, 760/day** budgets; `OFFBOX_STARTS_PER_MINUTE`, `OFFBOX_STARTS_PER_HOUR`, `OFFBOX_STARTS_PER_DAY` can lower
these limits. `offbox status` shows usage and the next local allowance. Existing running boxes remain usable.
Boat 429s fail immediately and set a shared cooldown from Retry-After (or a conservative default); one start-limit
Telegram is attempted at most every six hours. Account activity outside offbox may consume additional starts.

## Fallback and exit codes

- Remote command's own exit code is returned as is, except disk exhaustion returns **90**; the original command exit remains in the run record. Offbox's last stderr line reports the command's own exit.
  Command strings automatically use bash pipefail, so a failed check piped through `tee` or `tail` returns nonzero.
  A simple single-line pipeline such as `yes | head -1` succeeds when only non-last stages exit with SIGPIPE (141);
  compound scripts and uncertain shell syntax keep strict pipefail so skipped checks cannot look successful.
  An explicit trailing `; echo EXIT=$?` or `|| true` can still mask failure; offbox flags that choice on the exit line.
  A run that fell back to the Mac prints `offbox: local exit N` instead; same exit-code rules.
- (nightly 2026-10-19) **Several checks in one run: use `--step`**, one per command, instead of chaining
  `a | tee x | tail; b; grep ...`. 18 Oct: 4+ Crpko lanes read `remote exit 1` from a trailing grep on clean runs,
  or a blank PIPESTATUS gate.
  `offbox run --step 'go vet ./...' --step 'go test -count=1 ./pkg/...'`
  Each step runs in its own subshell with pipefail and does not stop the next. You get `offbox step N rc=X: ...`
  per step, then `offbox steps: K ok, M failed (step N rc=X)`, then `offbox: remote exit <first nonzero rc>`.
  A run missing any planned step result exits 90 (`steps incomplete`); rerun the checks before treating them as passed.
  `--step` plus a trailing `-- cmd` is a usage error (2). Exit 1 whose last pipeline stage is grep gets a hint line:
  it may mean "no match" or an earlier stage failed.
- **99** = the repo-pinned Node or pnpm could not be provided or activated. The command never started; fix the pin or retry after the download failure. Offbox does not run on the box default instead.
- **97 + "box setup failed (exit 97), not your command"** = the box's toolchain setup failed before your command ran
  (18 Oct: `mv: cannot overwrite '/usr/local/go'`). Offbox turns it into 90 (infra) and the normal infra/fallback rules
  apply. A plain 97 without that line is your command's own exit code.
- **92** = every pool box stayed busy for the whole queue wait (24 h at home, 10 min on the Boat standby; or other
  runs held the pool's lock that long). Nothing ran, not an infra failure: just retry. A slow box resume or create no longer holds up other runs of the same repo.
- **93** = person work (`offbox-person`) while the home server is down. Nothing ran and nothing went to Boat. It
  is not a failure of the command: the task waits for the server. Don't retry in a loop and don't route around it.
- **94** = the home server restarted under the run and it was not run again (`--no-retry`, person work, or it
  had already been retried once). The command ran partly: check what it did before running it again.
- **96** = local state DB failure. Before start: 'nothing ran, safe to retry'. After start: the message names the run and tells you to use `offbox wait <run>`; do not rerun the command. No automatic local fallback. A local bookkeeping failure after a known remote exit warns and returns that remote exit code.
- **100** from `offbox wait` / `offbox logs` = the client ended before it got a box. The run never started; nothing ran, safe to rerun.
- **124** from `offbox wait --timeout` = you stopped waiting; the run is still going. Wait again.
- **90** = infra failure (or, on the Boat standby, an exhausted start budget); **91** = Boat's spend guard, which only
  exists on the standby (the home server has no cap). Heavy commands
  and opaque project scripts **stay remote-only**, returning 90/91/92/96 with a clear retry message after bounded
  capacity waiting. Known-small direct commands and targeted tests may still fall back under the 2-job local
  semaphore with `taskpolicy -b` and a loud warning, unless `--no-fallback` is set.
- **90 + "boat.dev is down (HTTP 525 since HH:MM, waited Ns); nothing ran"** = boat's own API was unreachable
  (Cloudflare 520-526 or no answer), not your box. Before a run starts, offbox waits up to 600 s for it to come back
  (`OFFBOX_OUTAGE_WAIT_SECONDS`, max 1800), prints a line every minute and retries by itself. Small commands that may
  fall back locally don't wait. A run that already started keeps reattaching for up to 30 min of outage and keeps its
  box's auto-stop extended, so it survives an outage of about 25 minutes. `offbox status` answers within ~25 s and
  shows `boat.dev: DOWN since ...` during one.
- A resume with no answer is checked on the box; 503 out_of_capacity and 409 resume_failed / deploy_failed at capacity are waited out like a boat.dev outage.
- A boat "500 Request timeout" during SSH key setup is retried for up to ~4 min before exit 90; nothing ran.
- No fallback after a remote command may have started, including a lost start response. No local `--bg` fallback.
  A start boat rejects outright (HTTP 4xx) counts as not started: you get 90 at once instead of a run stuck "lost"
  for an hour. `E2BIG` (huge inline command, e.g. `"$(cat big.sh)"`) returns 2: put it in a script file in the
  repo and run that. Boat's `lost` is checked against retained command history, then the wrapper's exit file
  (`~/.offbox/exit/<run>.rc`), then its PID marker on the box. A live process stays reserved and followed;
  an SSH failure or missing legacy PID marker is unknown, so it cannot settle the run as lost or free its lease.
  Only a confirmed missing process with no saved exit returns 90. `offbox wait` on a wrongly-lost run recovers
  its saved exit code and corrects the row, or re-attaches while its process is alive. After a confirmed loss,
  inspect the box with `offbox ssh <box>` before rerunning.
  After a network error or a non-Cloudflare 5xx on start, offbox checks the box over SSH. Its atomic start claim
  prevents a late copy from running: “Nothing ran” retries through the outage wait with a new run ID; an exit
  receipt supplies the real result; an unknown start ends as infra and reserves the box until it stops. The
  message gives the run ID, box and receipt check command. `offbox wait` and `offbox reap` use the same check
  for a dead client's unrecorded start. Claims remain for the box's lifetime.

- Three ordinary infra failures within an hour send one Telegram; start-limit alerts use the six-hour cooldown.

## Disk space

Offbox records /tmp, /var/tmp and workspace filesystem space before and after each run. Below 1 GiB free in /tmp it warns; below 256 MiB it refuses the command with **90**. On home boxes, an idle box first attempts safe cleanup of stale user-owned temp files. Critically full boxes with concurrent runs are refused without cleanup. The pool picker does not automatically move the run to another box.

After a nonzero exit, ENOSPC output or less than 64 MiB free on a measured filesystem marks the result `infra_failure: "enospc"` and returns **90** from run/wait/logs. The command's original exit and the start/end measurements stay in the state record and analytics. These test results are invalid; rerun after space is available. Successful commands retain exit 0.

The home reaper runs only below 50% temp space free. It preserves live-held files, recent trees, foreign-owned entries, sockets and every /tmp/offbox-run tree. Every removal is logged. Raising the tmpfs cap is a separate capacity change.

## Logs

Detailed metadata logs are at `~/.robob/logs/tools/offbox/YYYY-MM-DD.ndjson` (UTC). Run events are `run.request`, `run.queue`, `run.lease`, `run.sync`, `run.command`, `run.pull`, `run.end`, `run.invocation` and `run.error`. Other events include `backend.failover`, `home.probe`, `pool.snapshot`, `gate.decision`, `local.override`, `ssh.setup`, `ssh.readiness`, `ssh.drop`, `ssh.put_file`, `mullvad.check`, `reaper.action`, `reaper.pass` and `cli.<command>`. Logs contain ids, counts, sizes, durations and stable error tags; command output stays in the existing per-run logs.

`offbox log-rollup --day YYYY-MM-DD` writes `rollup-YYYY-MM-DD.json` beside the day file; omit `--day` for today. Monitor/reaper ticks roll up yesterday after 00:05 UTC. Logs keep 30 days; after 50 MB in a day, only errors continue. Home-server services write their own local file at the same path.

## Troubleshooting

- A box held by an unconfirmed checkout cleanup is rechecked by reap, release and the pool queue; it frees itself once the cleanup is confirmed gone.

- A just-resumed box can have a cold disk: its first sync, installs and Docker databases can be slow for 5-25 min. Offbox moves a first sync once to a free warm box when available; otherwise use `--bg` + `offbox wait` instead of a short shell timeout.

- Python/boto3 suites that take hours with idle pytest workers on a box: AWS instance-metadata lookups. Offbox now sets `AWS_EC2_METADATA_DISABLED=true` on every box run; older notes that say to pass `--env AWS_EC2_METADATA_DISABLED` by hand are no longer needed.
- Go `unsafeTraceExpWriter redeclared`: stale overlay sources; the run preamble removes `runtime/traceexp.go` for Go 1.25+ and replaces mixed Go 1.26+ trees from the exact official release; template installs replace GOROOT, never overlay it.
- Managed Go trees carry an official path/type/size manifest; a missing or mismatched manifest triggers a clean reinstall, verified with `go build std`. Healthy runs only scan the inventory, not compile it. Each repair first prints the old tree's state (`old tree manifest=missing|mismatch|ok`).
- Go `package unsafe is not in std` or `build constraints exclude all Go files in /usr/local/go/src/...` while other go commands in the same run pass: a box read glitch seen on the first run after a resume, not your code and not a repair race (one run per box). offbox prints a hint and logs a `go_std_glitch` event; rerun the same command. A nested `/usr/local/go/go` is a half-swapped GOROOT; the next run repairs it under a box-local lock and verifies the replacement.
- Docker won't start on a box (`docker.service` 203/EXEC, `/usr/local/bin/sync-docker-firewall` missing): boat's Docker firewall hook was lost when the box resumed from an older snapshot. Every `offbox run` restores it from `templates/boat-sync-docker-firewall` and restarts a failed Docker; for an `offbox ssh` session, run any `offbox run -- true` first.
- Python `libpq library not found` / psycopg `no pq wrapper available` (or `cannot open shared object file` for a library that is installed): the box resumed with a stale linker cache (`/etc/ld.so.cache`). Every `offbox run` runs `sudo ldconfig` first when an installed library is missing from the cache; in an `offbox ssh` session, run `sudo ldconfig` yourself. Reinstalling the package is not needed.
- npm `EACCES … _cacache` / `EEXIST` on a pool box: an earlier run left foreign-owned cache folders. Every `offbox run` gives the user's npm, .cache, pnpm and yarn caches back before the command. In an `offbox ssh` session, run the printed `sudo chown -R` command yourself.
- A run whose only output is `Failed to start transient scope unit: Transport endpoint is not connected` means the box's systemd broke. Nothing ran. offbox returns 90, stops the box, and the next run resumes it clean, so just retry. Don't `boat resume` pool boxes by hand: on a 409 "is stopped", offbox marks the box stopped and resumes it itself on the next run.
- Sync fails with rsync 23 `delete_file: unlink(...) failed: Permission denied (13)`: a container wrote root-owned files into the checkout on the box (LocalStack's `tmp/localstack`). offbox gives them back to the box user (`sudo chown -R`) and syncs once more by itself. If that fails too it exits 90 before your command and names the `offbox ssh <box> -- sudo chown ...` to run.
- A push with no data for 180 s (`OFFBOX_SYNC_STALL_S`) is killed and retried once with a fresh SSH connection, then fails with exit 90.
- Push sync retries dropped connections (255/12) up to 3 times, re-reading the box's endpoint before each retry, and resumes the box once if it stopped mid-push, before exit 90.
- `remote dir ... missing`: you used `--no-sync` on a new box. Run once without it.
- Tests can't find a file: it's gitignored and untracked, or matched a secret filter (`.env*`, `*.pem`, `*.key`,
  ...). Use `--include path`. Never sync real credentials; tests needing AWS stay local (`offbox local --reason`).
  Tracked files go even when .gitignore matches them (offbox prints `also synced N git-tracked file(s) that
  .gitignore matches: ...` when it sent any), so `npm ci`, `pnpm install --frozen-lockfile` and `go.sum` checks get their
  lockfile without `--include`.
- Wrong arch: the box is linux/amd64. Don't sync built binaries; build on the box.
- A box wedged after resume (kept image restore stuck and Docker not answering) is stopped and set aside, and the run moves once to another box; offbox release <box> --delete drops it for good.
- Hung box run: `offbox kill <run>` first (it confirms the stop on boat), then `offbox release --delete` if the box
  is still in the way, then rerun (fresh lease from base/template). Don't pkill on the box.
- Weird box with no active run: `offbox release --delete`, then rerun (fresh lease from base/template).
- A bg run that settled while nobody followed it gets its log completed from boat's history the next time you run `offbox logs` or `offbox wait`; if that fails, offbox says the output is incomplete.
- For a run that is still going, plain `offbox logs` fetches and saves the available output when no follower owns the box; use `offbox logs --follow` or `offbox wait --timeout` to keep following it.
- Logs and state: `~/.local/share/offbox/` (`offbox.log`, `offbox.db`, `logs/<run>.log`). Code:
  `~/.config/opencode/skills/remote-compute/scripts/offbox.py` + `offbox_lib/`. Template recipes: `templates/`.
  Rebuild one: `offbox template build crpko-go` (keeps the old one until the new one is ready). `offbox template
  list` shows each template's state: kept (saved snapshot), box only (date boat deletes it) or EXPIRED.
- **Changing offbox**: the source is the Robob fork, `/Volumes/ExternalSSD/t3code-fork/integrations/offbox/`
  (this skill is `skill/`, plus the gate plugin, `boat` wrapper and monitor plist). Never edit the live copy.
  Edit there, run its tests (README), commit, `git push origin HEAD:main`, then `integrations/offbox/install.zsh`.
  Always push: install refuses unpushed changes, and `install.zsh --check` shows drift.
- Raw boat access: `~/.local/bin/boat` (CLI, signed in). API key is in Keychain `boat-api`/`ardud`; never print it.
