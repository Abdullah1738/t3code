"""offbox command line."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import common
from .common import (EXIT_BUSY, EXIT_CAP, EXIT_HOME_DOWN, EXIT_INFRA, SIZES, TEMPLATES, OffboxError, db, log, new_id, now,
                     say)

HELP = """offbox: run heavy work (tests, installs, docker) off the Mac: on the home offbox server when one is set up
and up, else on a boat.dev VM.
  offbox run [opts] -- <cmd...>     sync repo, run in the same relative dir, stream, exit with its code
  offbox run [opts] --step 'CMD' [--step 'CMD' ...]   each step runs with pipefail; per-step rc; first nonzero rc wins
  offbox logs <run> [--follow] | wait <run> [--timeout S]     for --bg runs; also a run another shell follows
  offbox kill <run>                 stop a hung starting/running box run (confirmed on boat), then release works
  offbox save [--name N] [--default] [--note ..] | bases | base rm N | keep [--days N]
  offbox local --reason ".." [--ttl 2h] | --list | --clear
  offbox list [--all] | release [<id>|--mine] [--delete] | ssh [<id>] [-- cmd] | ports <port> [--local N] [--reverse]
  offbox spend [--json] [--check] | reap [--dry-run] | status | whoami | template build <name> | template list
Light Go checks (single-package go test -run, go vet of 1-3 packages, gofmt -l) run on this Mac in a sandbox;
--remote forces the box.
Exit codes: the command's code (last stderr line: "offbox: remote exit N" or "offbox: local exit N"); 90 infra/start-limit
failure; 91 spend cap; 92 pool busy for the whole queue wait (nothing ran; retry). Only small commands may fall back locally.
With a home server: 93 a person's task while the home server is down (it waits; never sent to Boat; nothing ran);
94 the home server restarted under the run and it was not run again (--no-retry, a person's task, or already retried once)."""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="offbox", description=HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="sub")

    r = sp.add_parser("run", help="run a command on the lease box")
    r.add_argument("--size", choices=SIZES)
    r.add_argument("--template", choices=TEMPLATES)
    r.add_argument("--base", help="saved base for a NEW lease (name or repo:name)")
    r.add_argument("--fresh", action="store_true", help="new lease ignores saved bases and templates")
    r.add_argument("--env", action="append", default=[], metavar="VAR[=VAL]")
    r.add_argument("--pull", action="append", default=[], metavar="PATH")
    r.add_argument("--no-sync", action="store_true")
    r.add_argument("--git", action="store_true", help="export portable HEAD/ancestor history (tests that need git metadata)")
    r.add_argument("--include", action="append", default=[], metavar="PATH",
                   help="sync a repo-relative path the secret/ignore filters would skip (e.g. committed test certs)")
    r.add_argument("--bg", action="store_true")
    r.add_argument("--no-fallback", action="store_true")
    r.add_argument("--no-retry", action="store_true",
                   help="home server only: if the server restarts under this run, do not run it again by itself "
                        "(exit 94 instead). For commands that must not run twice")
    r.add_argument("--remote", action="store_true",
                   help="always use the box, even for light Go checks that would otherwise run on this Mac")
    r.add_argument("--step", action="append", default=[], metavar="CMD",
                   help="repeatable: run each CMD in order with pipefail; reports per-step rc and exits with the first nonzero rc")
    r.add_argument("cmd", nargs=argparse.REMAINDER)

    lg = sp.add_parser("logs")
    lg.add_argument("run_id")
    lg.add_argument("--follow", "-f", action="store_true")
    w = sp.add_parser("wait")
    w.add_argument("run_id")
    w.add_argument("--timeout", type=float, metavar="S",
                   help="stop waiting after S seconds with exit 124; the run keeps going on its box")

    lo = sp.add_parser("local", help="log an exemption to run heavy work locally")
    lo.add_argument("--reason")
    lo.add_argument("--ttl", default="2h")
    lo.add_argument("--list", action="store_true")
    lo.add_argument("--clear", action="store_true")

    li = sp.add_parser("list")
    li.add_argument("--all", action="store_true")
    li.add_argument("--json", action="store_true")
    kl = sp.add_parser("kill", help="stop a hung box run by run id")
    kl.add_argument("run_id")
    rl = sp.add_parser("release")
    rl.add_argument("box_id", nargs="?")
    rl.add_argument("--mine", action="store_true")
    rl.add_argument("--delete", action="store_true", help="delete instead of stop (loses the warm disk)")
    sh = sp.add_parser("ssh")
    sh.add_argument("box_id", nargs="?")
    sh.add_argument("cmd", nargs=argparse.REMAINDER)
    po = sp.add_parser("ports")
    po.add_argument("remote_port", type=int)
    po.add_argument("--local", type=int)
    po.add_argument("--box")
    po.add_argument("--reverse", action="store_true",
                    help="expose the Mac's 127.0.0.1:<--local> on the box at 127.0.0.1:<port> instead")
    sp.add_parser("whoami")
    sp.add_parser("status")

    s = sp.add_parser("spend")
    s.add_argument("--json", action="store_true")
    s.add_argument("--check", action="store_true")
    st = sp.add_parser("stats", help="per-run resource use on the offbox server (right-sizing)")
    st.add_argument("--days", type=float, default=14)
    st.add_argument("--json", action="store_true")
    rp = sp.add_parser("reap")
    rp.add_argument("--dry-run", action="store_true")

    sv = sp.add_parser("save", help="fork this lease into a stopped, reusable base")
    sv.add_argument("--name", default="default")
    sv.add_argument("--default", action="store_true", dest="make_default")
    sv.add_argument("--note")
    bs = sp.add_parser("bases")
    bs.add_argument("--json", action="store_true")
    b = sp.add_parser("base")
    b.add_argument("action", choices=["rm"])
    b.add_argument("name")
    k = sp.add_parser("keep", help="pin this lease so the reaper never deletes it")
    k.add_argument("--days", type=float, default=30)

    t = sp.add_parser("template")
    t.add_argument("action", choices=["build", "list"])
    t.add_argument("name", nargs="?")
    t.add_argument("--json", action="store_true")
    return p


def _remote_once(a, me) -> int:
    from . import runs
    try:
        return runs.run_remote(a, me)
    except (OffboxError, KeyboardInterrupt):
        raise
    except Exception as e:  # noqa: BLE001  unexpected bug/network error: treat as infra, keep fallback working
        import traceback
        log("run crashed: " + traceback.format_exc()[-2000:])
        raise OffboxError(f"offbox internal error: {type(e).__name__}: {e}")


def _outage_wait_applies(a, e: OffboxError) -> bool:
    """Wait out a boat API outage only when nothing started and the run can't fall back to the Mac anyway.
    Small commands that may fall back keep today's immediate fallback."""
    from . import fallback
    if not (e.outage and not e.started and e.code == EXIT_INFRA):
        return False
    if a.no_fallback or a.remote or a.bg:
        return True
    return not fallback.allowed(a.cmd, e, os.getcwd())


def cmd_run(a, me) -> int:
    from . import capacity, fallback, runs
    if a.cmd and a.cmd[0] == "--":
        a.cmd = a.cmd[1:]
    if a.step and a.cmd:
        say("use either --step CMD (repeatable) or a trailing -- <cmd>, not both")
        return 2
    a.steps = list(a.step)
    if a.steps:
        # One joined string keeps multi-step runs out of automatic local fallback (fallback.allowed rejects ';').
        a.cmd = ["; ".join(a.steps)]
    if not a.cmd:
        say("usage: offbox run [opts] -- <cmd...>  or  offbox run --step CMD [--step CMD ...]")
        return 2
    from . import localfirst
    try:
        why = localfirst.decide(a, me, os.getcwd())
    except Exception as e:  # noqa: BLE001 - any doubt means the box
        why = f"local-first check failed: {e!r}"
    if why is None:
        try:
            code = localfirst.run(a, me, a.steps)
        except localfirst.Rerun as e:
            # The sandbox blocked something the check needs (a fixture write, a socket). It changed nothing
            # outside its private dir, so the box gets the same command; no local fallback after that.
            say(f"the local run failed and the Mac sandbox may be why ({str(e)[:160]}); rerunning it on the box")
            log(f"remote: sandbox blocked: {e}")
            a.remote = True
            code = None
            why = "sandbox blocked the local run"
        if code is not None:
            return code
        if not a.remote:
            why = "could not start locally"
    log(f"remote: {why}")
    from . import home
    if home.may_fail_over():
        # One short look before any work: a home server that does not answer costs this run 3 s, not minutes.
        down = home.probe()
        if down:
            home.fail_over(down, getattr(a, "argv", None) or sys.argv[1:])
    elif home.on_standby() and not os.environ.get(home.FAILOVER_ENV):
        st = common.home_state()
        say(f"home offbox server is down ({st.get('reason') or 'marked down by the health monitor'}); "
            "this run is on Boat")
    from . import api, outage, pool
    waited_from = None
    capacity_since = capacity_last_say = None
    capacity_round = None
    last_outage = None
    try:
        while True:
            try:
                if waited_from is None:
                    return _remote_once(a, me)
                remaining = outage.window_seconds() - (time.monotonic() - waited_from)
                if remaining <= 0:
                    raise last_outage
                if capacity_round is not None:
                    pause = outage.CAPACITY_RETRY_S - (time.monotonic() - capacity_round)
                    if pause > 0:
                        time.sleep(min(pause, remaining))
                        remaining = outage.window_seconds() - (time.monotonic() - waited_from)
                        if remaining <= 0:
                            raise last_outage
                    capacity_round = time.monotonic()
                with outage.allocation_budget(remaining):
                    return _remote_once(a, me)
            except OffboxError as e:
                if isinstance(e, pool.PoolBusyError) and waited_from is not None and last_outage is not None and \
                        time.monotonic() - waited_from >= outage.window_seconds() and not e.started:
                    raise last_outage
                if home.active() and home.unreachable(e):
                    # Nothing was accepted by the home server. Ordinary work goes to Boat for this one run; a
                    # person's work waits for the home server; a pinned backend keeps today's waiting.
                    if home.may_fail_over():
                        home.fail_over(str(e), getattr(a, "argv", None) or sys.argv[1:])
                    if common.person():
                        raise OffboxError(f"the home offbox server is down ({e}); {common.person()}'s tasks wait "
                                          "until it is back. Nothing ran and nothing was sent to Boat",
                                          code=EXIT_HOME_DOWN) from e
                machine_capacity = isinstance(e, api.BoatAtCapacity)
                if machine_capacity:
                    if e.started or not (a.no_fallback or a.remote or a.bg or
                                         not fallback.allowed(a.cmd, e, os.getcwd())):
                        raise
                elif not _outage_wait_applies(a, e):
                    raise
                if waited_from is None:
                    waited_from = time.monotonic()
                last_outage = e
                if machine_capacity:
                    if capacity_since is None:
                        capacity_since = outage.now()
                        capacity_round = time.monotonic()
                    retry, capacity_last_say = outage.wait_for_capacity(
                        waited_from, capacity_since, capacity_last_say, outage.window_seconds())
                    if retry:
                        continue
                    raise
                left = outage.window_seconds() - (time.monotonic() - waited_from)
                if left > 0 and outage.wait_until_up(outage.reason_of(e), left):
                    continue
                raise outage.down_error(e, time.monotonic() - waited_from) from e
    except OffboxError as e:
        if e.code not in (EXIT_INFRA, EXIT_CAP, EXIT_BUSY):
            say(str(e))
            return e.code
        if e.code == EXIT_INFRA and not isinstance(e, capacity.CapacityError):
            fallback.note_infra_failure(str(e))
        if e.started:
            say(f"remote run failed after the command started: {e}. Not re-running locally (it may have side effects).")
            return e.code
        if a.no_fallback or a.remote:
            say(str(e))
            return e.code
        if a.bg:
            say(f"{e}. --bg can't fall back to a local background run; run it in the foreground or retry later.")
            return e.code
        if not fallback.allowed(a.cmd, e, os.getcwd()):
            say(f"{e}. Heavy command NOT run locally; retry offbox later (exit {e.code}).")
            return e.code
        con = db()
        rid = new_id("run")
        con.execute("INSERT INTO runs (run_id, owner, session_id, thread_id, repo_root, cwd, cmd, mode, status, start_at)"
                    " VALUES (?,?,?,?,?,?,?, 'local', 'running', ?)",
                    (rid, me["owner"], me.get("session"), me.get("thread"), me["repo_root"], os.getcwd(),
                     " ".join(a.cmd)[:4000], now()))
        con.commit()
        why = {EXIT_CAP: "spend cap", EXIT_BUSY: "repository pool busy"}.get(e.code, "boat infra failure")
        code = fallback.run_local(a.cmd, f"{why}: {e}", rid)
        say(f"local fallback exit {code}")
        return code


# Commands that never talk to a box: they work for a person's lease even while the home server is down.
LOCAL_ONLY = ("whoami", "local", "list", "status", "spend", "stats", "reap", "bases")


def _reap_other_backend(dry_run: bool) -> None:
    """With a home server configured, leases exist on both backends and both need the reaper (Boat boxes left
    from a failover must still be stopped and deleted). The other one runs as its own process: one backend each."""
    if common.home_config() is None or os.environ.get("OFFBOX_BACKEND") or os.environ.get("OFFBOX_REAP_CHILD"):
        return
    import subprocess
    other = "boat" if common.backend() == "server" else "server"
    if other == "server" and common.home_state().get("state") == "home_down":
        return
    env = dict(os.environ, OFFBOX_BACKEND=other, OFFBOX_REAP_CHILD="1")
    try:
        subprocess.run([sys.executable, os.path.realpath(sys.argv[0]), "reap", *(["--dry-run"] if dry_run else [])],
                       env=env, timeout=110, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        log(f"reap of the {other} backend did not finish: {e}")


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    p = build_parser()
    a = p.parse_args(argv)
    if not a.sub:
        p.print_help()
        return 2
    from . import bases, home, misc, reap, spend
    from .identity import whoami
    from .redact import redact_argv, warn_env_values
    try:
        me = whoami()
        log(f"cmd {a.sub} owner={me['owner']} repo={me['repo_root']} backend={common.backend()} "
            f"argv={redact_argv(argv)[:12]}")
        if a.sub not in LOCAL_ONLY:
            home.person_gate()   # a person's box lives on the home server only: stop here while it is down
        if a.sub == "run":
            warn_env_values(a.env)
            a.argv = list(argv)
            return cmd_run(a, me)
        if a.sub == "logs":
            return misc.logs(a.run_id, a.follow)
        if a.sub == "wait":
            return misc.wait(a.run_id, a.timeout)
        if a.sub == "local":
            misc.local_exempt(me, a.reason, a.ttl, a.list, a.clear)
        elif a.sub == "list":
            misc.list_leases(me, a.all, a.json)
        elif a.sub == "kill":
            return misc.kill_run(a.run_id, me)
        elif a.sub == "release":
            misc.release(me, a.box_id, a.mine, a.delete)
        elif a.sub == "ssh":
            box, cmd = a.box_id, list(a.cmd)
            if box and not box.startswith("bx_"):
                cmd, box = [box] + cmd, None
            if cmd and cmd[0] == "--":
                cmd = cmd[1:]
            return misc.ssh_shell(me, box, cmd)
        elif a.sub == "ports":
            return misc.ports(me, a.remote_port, a.local, a.box, a.reverse)
        elif a.sub == "whoami":
            print(json.dumps(me, indent=1))
        elif a.sub == "status":
            misc.status(me)
        elif a.sub == "spend":
            out = spend.check() if a.check else spend.compute()
            spend.print_report(out, a.json)
        elif a.sub == "stats":
            misc.stats(a.days, a.json)
        elif a.sub == "reap":
            reap.print_actions(reap.reap(a.dry_run))
            _reap_other_backend(a.dry_run)
        elif a.sub == "save":
            print(json.dumps(bases.save(me, a.name, a.make_default, a.note), indent=1))
        elif a.sub == "bases":
            bases.list_bases(a.json)
        elif a.sub == "base":
            bases.rm_base(me, a.name)
        elif a.sub == "keep":
            bases.keep(me, a.days)
        elif a.sub == "template":
            if a.action == "list":
                bases.list_templates(a.json)
            else:
                if not a.name:
                    say(f"usage: offbox template build <{'|'.join(TEMPLATES)}>")
                    return 2
                print(json.dumps(bases.build_template(a.name), indent=1))
        return 0
    except OffboxError as e:
        say(str(e))
        return e.code
    except KeyboardInterrupt:
        return 130
    except Exception as e:  # noqa: BLE001
        import traceback
        log("crash: " + traceback.format_exc()[-2000:])
        say(f"internal error: {type(e).__name__}: {e} (details in ~/.local/share/offbox/offbox.log)")
        return EXIT_INFRA
