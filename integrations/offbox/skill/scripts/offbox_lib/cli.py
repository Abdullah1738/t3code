"""offbox command line."""

from __future__ import annotations

import argparse
import json
import os
import sys

from .common import EXIT_BUSY, EXIT_CAP, EXIT_INFRA, SIZES, TEMPLATES, OffboxError, db, log, new_id, now, say

HELP = """offbox: run heavy work (tests, installs, docker) on a boat.dev VM instead of the Mac.
  offbox run [opts] -- <cmd...>     sync repo, run in the same relative dir, stream, exit with its code
  offbox run [opts] --step 'CMD' [--step 'CMD' ...]   each step runs with pipefail; per-step rc; first nonzero rc wins
  offbox logs <run> [--follow] | wait <run> [--timeout S]     for --bg runs; also a run another shell follows
  offbox save [--name N] [--default] [--note ..] | bases | base rm N | keep [--days N]
  offbox local --reason ".." [--ttl 2h] | --list | --clear
  offbox list [--all] | release [<id>|--mine] [--delete] | ssh [<id>] [-- cmd] | ports <port> [--local N] [--reverse]
  offbox spend [--json] [--check] | reap [--dry-run] | status | whoami | template build <name> | template list
Light Go checks (single-package go test -run, go vet of 1-3 packages, gofmt -l) run on this Mac in a sandbox;
--remote forces the box.
Exit codes: the command's code (last stderr line: "offbox: remote exit N" or "offbox: local exit N"); 90 infra/start-limit
failure; 91 spend cap; 92 pool busy for the whole queue wait (nothing ran; retry). Only small commands may fall back locally."""


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
    try:
        try:
            return runs.run_remote(a, me)
        except (OffboxError, KeyboardInterrupt):
            raise
        except Exception as e:  # noqa: BLE001  unexpected bug/network error: treat as infra, keep fallback working
            import traceback
            log("run crashed: " + traceback.format_exc()[-2000:])
            raise OffboxError(f"offbox internal error: {type(e).__name__}: {e}")
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


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    p = build_parser()
    a = p.parse_args(argv)
    if not a.sub:
        p.print_help()
        return 2
    from . import bases, misc, reap, spend
    from .identity import whoami
    try:
        me = whoami()
        log(f"cmd {a.sub} owner={me['owner']} repo={me['repo_root']} argv={argv[:12]}")
        if a.sub == "run":
            return cmd_run(a, me)
        if a.sub == "logs":
            return misc.logs(a.run_id, a.follow)
        if a.sub == "wait":
            return misc.wait(a.run_id, a.timeout)
        if a.sub == "local":
            misc.local_exempt(me, a.reason, a.ttl, a.list, a.clear)
        elif a.sub == "list":
            misc.list_leases(me, a.all, a.json)
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
        elif a.sub == "reap":
            reap.print_actions(reap.reap(a.dry_run))
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
