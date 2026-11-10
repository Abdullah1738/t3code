---
name: remote-compute
description: Use for any heavy test suite, dependency install, build or Docker/compose/testcontainers work - it runs on a boat.dev VM via `offbox run -- <cmd>`, not on Abdullah's Mac.
---

# remote-compute: heavy work runs on boat via offbox

Abdullah's Mac (M4 Max) sits at load 100+ when agents run test suites, installs and Docker stacks locally. Since
2026-10-13 that work runs on boat.dev VMs (EU, x86_64 Ubuntu 24.04, Docker included) through `offbox`. A gate
(worker C's plugin + Docker shim) denies heavy commands that don't go through offbox. Owner decisions and the
interface contract: `/Users/ardud/.robob/scratch/2026-10-13-we-often-run-simulations-tests-24789d2f/plan.md`.

## The one rule

Prefix heavy commands with `offbox run --`, from the same directory you'd run them in:

```bash
offbox run -- go test ./...
offbox run -- npm ci
offbox run -- npx jest
offbox run -- 'docker compose up -d && ./scripts/health.sh'      # one string = run by bash
offbox run --size xlarge -- make test-integration
```

offbox finds the repo root (`git rev-parse --show-toplevel`, else cwd), rsyncs it to your box (only changed files;
gitignored files git doesn't track, `.git`, secrets and `node_modules`/`.terraform`/caches are not sent; a tracked
file sends even when .gitignore matches it, e.g. a committed `package-lock.json`), `cd`s into the same relative
dir, runs, streams stdout/stderr live, and exits with the remote exit code. Ctrl-C/SIGTERM kills the remote process.

**Light Go checks run on the Mac (local-first, 2026-10-19).** Waking a box for a 5 s check was most of the bill, so
`offbox run` itself runs these locally (niced, max 4 at once) and prints `offbox: light command: running on this Mac`:
single-package `go test -run X` (`-count` <= 3), `go vet`/`go build -o /dev/null` of 1-3 packages (6 per run at
most), `gofmt -l`, `go version|env|list`, alone or in `--step`s / `bash -c` with read-only pipe filters (`grep`,
`head`, `tail`, `sort`, `sed -n`, ...) and `tee /tmp/x`. Packages must be `./relative` paths inside the repo, and
neither they nor any module package they import may have OS/arch-specific files or build tags (`_linux.go`,
`//go:build linux`): the Mac would build different code. Tests that read `.env` need `--include .env`; tests in a
module that uses testcontainers go to the box. Go flags and env are an allowlist (`-run -v -race -count -timeout
-tags -short`, `GOFLAGS=-mod=readonly`, `GOTOOLCHAIN=goX.Y`); `-exec`, `-toolexec`, `-gcflags`, `-coverprofile`,
`-bench`, `-C` and friends send the run to the box. Anything else (python, node, uv, make, git, scripts, docker,
`cd`, subshells, loops, heredocs, repo-file redirects, `/proc`, reading `/tmp` left by an earlier box run) still goes
to the box, as do runs with `--bg`, `--no-sync`, `--pull`, `--base`, `--fresh`, `--template`, a Mac whose CPUs are
over 80% busy (load averages alone mislead on macOS: ~30 with 60% idle is normal here), or a
repo that used Docker on the box in the last 2 h; so do go.mod files with local-path `replace`s and nested modules,
and a `go.work` above the repo is ignored (`GOWORK=off`) because it never reaches the box. Local runs use the box's
Go version (`GOTOOLCHAIN`), a small allowlisted environment (no AWS profile, tokens or service URLs), a dead
`FDB_CLUSTER_FILE`/`DOCKER_HOST`, and a macOS sandbox: writes only to a private run dir (your `/tmp/x` paths are
mapped into it, fresh each run) and the Go caches, never to the repo; no reads of `~` or secret files (`.env`, keys)
unless `--include`d; no unix sockets, local UDP or local service ports. When the run ends, everything it started is
killed. A failed local check is rerun on the box by itself when the output says `Operation not permitted` or the
tested package writes files (`os.WriteFile`, `os.Create`, ...). Other code that hides a blocked write, or
third-party modules with Mac-only behaviour, can still differ: if a local failure looks wrong or Mac-specific, rerun
with `offbox run --remote -- ...`, which always uses the box and never falls back to the Mac.
`OFFBOX_LOCAL_FIRST=0` only turns local-first off.

Heavy = `go test` (multi-package or no `-run`), `pytest` on a dir or with `-n`, `jest`/`vitest` (whole suite),
`npm ci`/`npm install`/`pnpm install`/`yarn install`, `docker run/build/compose up`, testcontainers, `gradlew`,
`cargo build/test`, `make test`, `forge test`/anvil. In review/worktree clones (`/tmp`, `$TMPDIR`, `coord-wt`,
`crw` work dirs) also `go build`/`go vet` of `./...` or 4+ packages, project-wide `tsc`, `eslint .` and
`npm run typecheck|lint`.
In a repo whose go.mod has testcontainers, `go test -run X ./pkg` stays local only if that package (and what it
imports from the module) never mentions testcontainers. The harness template's FDB image is prebuilt for the default
compose project (`platform`).

**Stays local** (don't wrap): `xcodebuild`, `adb`/`ph`, mitmproxy, Dia, `terraform` (AWS creds), `git`, and
narrow single tests: `go test -run TestX ./pkg`, `jest path/file.test.ts`, `pytest path::test`. Wrap a narrow
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

## Your box (lease)

- Up to **four pooled boxes per repository key** (default raised from 2 on 2026-10-17 for the PR factory ramp), shared by threads and worktrees. An idle running box is preferred,
  then an existing stopped box; legacy boxes are adopted without deleting their disks. Each box runs one command
  at a time, including sync and artifact pulls. Background runs reserve their slot until completion. Checkout
  directories remain separate per local repo path. Dependencies are warm on whichever box you receive. Old
  checkouts are deleted at run start: a box keeps the 10 most recent used in the last 3 days plus any used in the
  last 12 h (`OFFBOX_PRUNE_KEEP`, `OFFBOX_PRUNE_DAYS`), so a worktree idle for days may sync and install deps again.
- A busy pool queues for **up to 600 seconds** (progress line every 60 s), then returns **92** (nothing ran; retry).
  Give the tool call a timeout above the wait, or use a background shell. `OFFBOX_POOL_SIZE` (1–8) and
  `OFFBOX_POOL_WAIT_SECONDS` (0–1200) configure this. Sizes are minimums on pooled boxes; a larger warm box is reused.
- Boxes stop after **5 min idle (xlarge) or 10 min (other sizes)**. 20 min if a run on the box started a container in
  the last 2 h (offbox checks `docker events` at the end of each run; a testcontainers manifest alone no longer
  counts) or half the hourly/daily start allowance is used, 60 min once 75% of the daily allowance is used or during a start
  cooldown (stopped = free; boat keeps the disk 14 days after the stop, then deletes it). When a run's client dies,
  the reaper brings the box back to its idle window instead of the 30-min run ttl. A resume takes ~6-10 s. The next run resumes it with everything
  you installed (`node_modules`, Go module cache, files in ~, Docker named volumes). Docker images are kept too:
  boat drops image layers on stop, so offbox archives them into ~ before every stop and reloads them at boot
  (a few seconds to ~20 s for big stacks; runs wait for it automatically).
- Warm runs avoid a sandbox start; queueing and synchronization can add latency.
- Deps you install on the box stay there: run `offbox run -- npm ci` once, then `offbox run -- npx jest` many
  times. Local `node_modules` is never synced (macOS binaries would be wrong anyway).
- Node version: offbox puts the newest nvm Node on the box that fits the repo's `.nvmrc`/`.node-version` and `package.json` `engines.node` (nearest to your cwd) first on PATH and prints `offbox: node vX (...)`. If none fits it warns and keeps the box default; install one with `offbox run -- 'source ~/.nvm/nvm.sh && nvm install 22'`.
- Source of a new lease: `--base N` > the repo's default saved base > the repo's template > `generic`. If boat has
  deleted a template's data, the run builds its box from the template's recipe instead (a few minutes; `offbox:`
  says so) and the reaper rebuilds the template. An expired default base falls back to the template.
  Templates: `crpko-go` (Go 1.26 + FDB client + warm module cache, large), `crpko-node` (nvm Node 22 + 24, system Node 20, warm npm cache,
  large), `crpko-harness` (large, Docker images for the harness stack pre-pulled), `generic` (default).
  Auto-pick: crpko-devops / go.mod → crpko-go; package.json → crpko-node; compose file or testcontainers → crpko-harness.
- crpko-devops's template includes Vector 0.50.0 and `/usr/bin/ruby`; it has no package-lock.json, so run tests directly or use `npm install`, not `npm ci`.
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
| `--bg` | start and return a run id at once; then `offbox logs <id> --follow` / `offbox wait <id> [--timeout S]` (exits with its code, does `--pull`) |
| `--base N` / `--fresh` | new lease from saved base N / ignoring bases and templates. `--fresh` doesn't always mean a new box: in the repository pool it can still reuse a pool box that was itself created fresh. In a full pool with no box of that kind, it stops at once (exit 2) instead of queueing. It isn't a way off a bad box: offbox now stops broken boxes itself, and `offbox release <id>` stops one by hand. |
| `--no-fallback` | return 90/91 instead of falling back to a local run (does not stop local-first) |
| `--remote` | always use the box, even for a light Go check that would run on the Mac; never falls back to the Mac |
| `--step CMD` (repeatable) | run several checks with a real exit code each (see Fallback and exit codes) |

Runs longer than 10 minutes are fine (every run is a boat background command, reattached on network blips).
For runs over ~30 min prefer `--bg` + `offbox wait`, so your own tool-call timeout doesn't kill the client.
`offbox wait` / `logs --follow` on a run whose own `offbox run` is still following it waits for that run to record
its end and returns its code. If the box says the process ended but that `offbox run` still hasn't recorded it a
minute later (30 min with `--pull`), wait returns the box's exit code and says the other client looks stuck.
`--timeout S` stops waiting after S seconds with exit 124; the run keeps going.
On a run still queued for a pool box they say "waiting for a box" and keep polling until it gets one or settles.
If that run's own `offbox run` has died (a tool-call timeout), wait marks it lost ("never started, nothing ran", 90).

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

- After an expensive setup (`npm ci`, `go mod download`, harness images pulled, a seeded database), run
  `offbox save --default --note "npm ci done at <sha>"`. New threads on this repo then start from that state and
  only rsync the delta. `save` briefly stops your lease to capture it (the next run resumes it), costs one machine
  start (~15-25 s), then $0. Names: `offbox save --name pg-seeded`; use one
  later with `offbox run --base pg-seeded -- ...` (only for a new lease).
- `offbox bases` lists saved bases and whether each is kept (saved snapshot), box-only (with the date boat deletes
  it) or EXPIRED; `offbox base rm <name>` removes one. Bases are never auto-deleted by offbox.
- `offbox keep --days 30` pins your current lease so the reaper never deletes it and keeps its disk past boat's
  14 days (it still stops when idle). Unpinned leases stopped 14 days are gone; the next run starts a new box.
- Leases are deleted only when their thread has been archived for 7 days, or unused for 30 days and not pinned.

## Housekeeping

- `offbox list [--all]`, `offbox release` (stop your lease now), `offbox release --delete` (throw the disk away),
  `offbox whoami`, `offbox status`.
- `offbox kill <run>` stops a hung starting/running box run and marks it `killed` once boat confirms the process
  stopped. Release refuses while a run is active and names the run ids. Use kill, not pkill on the box.
  Local runs and runs with no box process are refused.
- A run that never got a box and whose client is gone is marked lost by the reaper within 5 minutes.
- Before ending a long task you don't need to do anything: idle boxes stop themselves. Release explicitly if you
  are done with a big (xlarge) box.

## Costs and the cap

$100/month plan. default $0.036/h, large $0.072/h, xlarge $0.20/h; stopped boxes, auto snapshots and the plan's 50
included saved snapshots are free. `offbox spend` reads the account meter once and shows billing-period spend. Abdullah gets a Telegram
at every $100. At $900 the cap trips (raised from $500 to $750 by Abdullah on 5 Nov 2026, then to $900 on 10 Nov 2026): new leases are refused and all boxes stop. Heavy work returns 91.

Create, fork and resume each consume a start. Offbox reserves starts atomically against rolling **25/minute,
180/hour, 760/day** budgets; `OFFBOX_STARTS_PER_MINUTE`, `OFFBOX_STARTS_PER_HOUR`, `OFFBOX_STARTS_PER_DAY` can lower
these limits. `offbox status` shows usage and the next local allowance. Existing running boxes remain usable.
Boat 429s fail immediately and set a shared cooldown from Retry-After (or a conservative default); one start-limit
Telegram is attempted at most every six hours. Account activity outside offbox may consume additional starts.

## Fallback and exit codes

- Remote command's own exit code is returned as is, and offbox's last stderr line is `offbox: remote exit N`.
  Command strings automatically use bash pipefail, so a failed check piped through `tee` or `tail` returns nonzero.
  A simple single-line pipeline such as `yes | head -1` succeeds when only non-last stages exit with SIGPIPE (141);
  compound scripts and uncertain shell syntax keep strict pipefail so skipped checks cannot look successful.
  An explicit trailing `; echo EXIT=$?` or `|| true` can still mask failure; offbox flags that choice on the exit line.
  A local-first run prints `offbox: local exit N` instead; same exit-code rules.
- (nightly 2026-10-19) **Several checks in one run: use `--step`**, one per command, instead of chaining
  `a | tee x | tail; b; grep ...`. 18 Oct: 4+ Crpko lanes read `remote exit 1` from a trailing grep on clean runs,
  or a blank PIPESTATUS gate.
  `offbox run --step 'go vet ./...' --step 'go test -count=1 ./pkg/...'`
  Each step runs in its own subshell with pipefail and does not stop the next. You get `offbox step N rc=X: ...`
  per step, then `offbox steps: K ok, M failed (step N rc=X)`, then `offbox: remote exit <first nonzero rc>`.
  `--step` plus a trailing `-- cmd` is a usage error (2). Exit 1 whose last pipeline stage is grep gets a hint line:
  it may mean "no match" or an earlier stage failed.
- **97 + "box setup failed (exit 97), not your command"** = the box's toolchain setup failed before your command ran
  (18 Oct: `mv: cannot overwrite '/usr/local/go'`). Offbox turns it into 90 (infra) and the normal infra/fallback rules
  apply. A plain 97 without that line is your command's own exit code.
- **92** = every pool box stayed busy for the whole queue wait (or other runs held the pool's lock that long). Nothing
  ran, not an infra failure: just retry. A slow box resume or create no longer holds up other runs of the same repo.
- **124** from `offbox wait --timeout` = you stopped waiting; the run is still going. Wait again.
- **90** = boat/infra failure or exhausted start budget; **91** = spend cap. Heavy commands
  and opaque project scripts **stay remote-only**, returning 90/91/92 with a clear retry message after bounded
  capacity waiting. Known-small direct commands and targeted tests may still fall back under the 2-job local
  semaphore with `taskpolicy -b` and a loud warning, unless `--no-fallback` is set.
- **90 + "boat.dev is down (HTTP 525 since HH:MM, waited Ns); nothing ran"** = boat's own API was unreachable
  (Cloudflare 520-526 or no answer), not your box. Before a run starts, offbox waits up to 600 s for it to come back
  (`OFFBOX_OUTAGE_WAIT_SECONDS`, max 1800), prints a line every minute and retries by itself. Small commands that may
  fall back locally don't wait. A run that already started keeps reattaching for up to 30 min of outage and keeps its
  box's auto-stop extended, so it survives an outage of about 25 minutes. `offbox status` answers within ~25 s and
  shows `boat.dev: DOWN since ...` during one.
- A resume with no answer is checked on the box; 503 out_of_capacity and 409 resume_failed / deploy_failed at capacity are waited out like a boat.dev outage.
- No fallback after a remote command may have started, including a lost start response. No local `--bg` fallback.
  A start boat rejects outright (HTTP 4xx) counts as not started: you get 90 at once instead of a run stuck "lost"
  for an hour. `E2BIG` (huge inline command, e.g. `"$(cat big.sh)"`) returns 2: put it in a script file in the
  repo and run that. If boat loses track of a run that already ended (status `lost`), offbox reads the exit code the run left on the box (`~/.offbox/exit/<run>.rc`) or, for `--step` runs, the step lines when every step reported; only when neither exists is it 90.
- Three ordinary infra failures within an hour send one Telegram; start-limit alerts use the six-hour cooldown.

## Troubleshooting

- Python/boto3 suites that take hours with idle pytest workers on a box: AWS instance-metadata lookups. Offbox now sets `AWS_EC2_METADATA_DISABLED=true` on every box run; older notes that say to pass `--env AWS_EC2_METADATA_DISABLED` by hand are no longer needed.
- Go `unsafeTraceExpWriter redeclared`: stale overlay sources; the run preamble removes `runtime/traceexp.go` for Go 1.25+ and replaces mixed Go 1.26+ trees from the exact official release; template installs replace GOROOT, never overlay it.
- Managed Go trees carry an official path/type/size manifest; a missing or mismatched manifest triggers a clean reinstall, verified with `go build std`. Healthy runs only scan the inventory, not compile it. Each repair first prints the old tree's state (`old tree manifest=missing|mismatch|ok`).
- Go `package unsafe is not in std` or `build constraints exclude all Go files in /usr/local/go/src/...` while other go commands in the same run pass: a box read glitch seen on the first run after a resume, not your code and not a repair race (one run per box). offbox prints a hint and logs a `go_std_glitch` event; rerun the same command. A nested `/usr/local/go/go` is a half-swapped GOROOT; the next run repairs it under a box-local lock and verifies the replacement.
- Docker won't start on a box (`docker.service` 203/EXEC, `/usr/local/bin/sync-docker-firewall` missing): boat's Docker firewall hook was lost when the box resumed from an older snapshot. Every `offbox run` restores it from `templates/boat-sync-docker-firewall` and restarts a failed Docker; for an `offbox ssh` session, run any `offbox run -- true` first.
- Python `libpq library not found` / psycopg `no pq wrapper available` (or `cannot open shared object file` for a library that is installed): the box resumed with a stale linker cache (`/etc/ld.so.cache`). Every `offbox run` runs `sudo ldconfig` first when an installed library is missing from the cache; in an `offbox ssh` session, run `sudo ldconfig` yourself. Reinstalling the package is not needed.
- A run whose only output is `Failed to start transient scope unit: Transport endpoint is not connected` means the box's systemd broke. Nothing ran. offbox returns 90, stops the box, and the next run resumes it clean, so just retry. Don't `boat resume` pool boxes by hand: on a 409 "is stopped", offbox marks the box stopped and resumes it itself on the next run.
- Sync fails with rsync 23 `delete_file: unlink(...) failed: Permission denied (13)`: a container wrote root-owned files into the checkout on the box (LocalStack's `tmp/localstack`). offbox gives them back to the box user (`sudo chown -R`) and syncs once more by itself. If that fails too it exits 90 before your command and names the `offbox ssh <box> -- sudo chown ...` to run.
- `remote dir ... missing`: you used `--no-sync` on a new box. Run once without it.
- Tests can't find a file: it's gitignored and untracked, or matched a secret filter (`.env*`, `*.pem`, `*.key`,
  ...). Use `--include path`. Never sync real credentials; tests needing AWS stay local (`offbox local --reason`).
  Tracked files go even when .gitignore matches them (offbox prints `also synced N git-tracked file(s) that
  .gitignore matches: ...` when it sent any), so `npm ci`, `pnpm --frozen-lockfile` and `go.sum` checks get their
  lockfile without `--include`.
- Wrong arch: the box is linux/amd64. Don't sync built binaries; build on the box.
- Hung box run: `offbox kill <run>` first (it confirms the stop on boat), then `offbox release --delete` if the box
  is still in the way, then rerun (fresh lease from base/template). Don't pkill on the box.
- Weird box with no active run: `offbox release --delete`, then rerun (fresh lease from base/template).
- Old output of a run: `offbox logs <run-id>` (works after the box stopped, from boat's 90-day command history).
- Logs and state: `~/.local/share/offbox/` (`offbox.log`, `offbox.db`, `logs/<run>.log`). Code:
  `~/.config/opencode/skills/remote-compute/scripts/offbox.py` + `offbox_lib/`. Template recipes: `templates/`.
  Rebuild one: `offbox template build crpko-go` (keeps the old one until the new one is ready). `offbox template
  list` shows each template's state: kept (saved snapshot), box only (date boat deletes it) or EXPIRED.
- **Changing offbox**: the source is the Robob fork, `/Volumes/ExternalSSD/t3code-fork/integrations/offbox/`
  (this skill is `skill/`, plus the gate plugin, `boat` wrapper and monitor plist). Never edit the live copy.
  Edit there, run its tests (README), commit, `git push origin HEAD:main`, then `integrations/offbox/install.zsh`.
  Always push: install refuses unpushed changes, and `install.zsh --check` shows drift.
- Raw boat access: `~/.local/bin/boat` (CLI, signed in). API key is in Keychain `boat-api`/`ardud`; never print it.
