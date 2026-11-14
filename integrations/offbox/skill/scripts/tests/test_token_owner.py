"""Every owner's leases on the home server share one database, but a token only sees its owner's boxes there.

12 Nov 2026: a reap pass with our token did not find Moni's box in its list, decided it was gone and forgot her
lease; her next call made a second, empty box. Leases now record whose token opens their box, and on the home
server nothing compares another owner's lease with this token's view or sends a request for it.

The home-server tests run the client against boatd's real HTTP handler (two owners, two tokens), as test_home_wire
does. Boat has one account: there nothing is filtered."""
import contextlib
import io
import os
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "tests"))
from offbox_lib import api, bases, common, lease, misc, pool, reap  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from test_home_wire import test_boatd  # noqa: E402

GONE = "bx_gone0000"   # a box id the server has never heard of


class Scoped(Isolated):
    """Isolated state plus the owner switch: who() runs a block as that owner's process (her OFFBOX_THREAD, her
    token)."""

    def setUp(self):
        super().setUp()
        self.people = Path(self.tmp.name) / "people"
        env = {k: v for k, v in os.environ.items() if k != "OFFBOX_THREAD"}
        env["OFFBOX_PERSON_ROOT"] = str(self.people)
        self.stack.enter_context(patch.dict(os.environ, env, clear=True))
        self.stack.enter_context(patch.object(api, "_OWN_BOXES", set()))

    def lease(self, bid, owner=None, root="/checkout/repo", key="repo", state="running", used=None):
        t = common.now() if used is None else used
        self.con.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,created_at,"
                         "last_used_at,source,token_owner) VALUES (?,?,?,?,'w/x',?,'default',?,?,'fresh',?)",
                         (bid, "pool:" + key, root, key, state, t, t, owner))
        self.con.commit()

    def state(self, bid):
        return self.con.execute("SELECT state FROM leases WHERE box_id=?", (bid,)).fetchone()[0]

    def events(self, bid):
        return [(r[0], r[1]) for r in self.con.execute("SELECT kind, detail FROM events WHERE box_id=?", (bid,))]

    def quiet(self, fn, *a, **kw):
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            return fn(*a, **kw)


class Home(Scoped):
    def setUp(self):
        super().setUp()
        self.srv = test_boatd.Http("call")      # boatd with fakes behind a real HTTP server, tokens for ardud and moni
        self.srv.setUp()
        self.addCleanup(self.srv.doCleanups)
        for name, value in (("API", self.srv.url), ("BACKEND", "server"), ("NAME", "offbox server"),
                            ("KEY_SERVICE", "offbox-server-api")):
            self.stack.enter_context(patch.object(api, name, value))
        self.stack.enter_context(patch.object(common, "_BACKEND", "server"))
        self.his = self.srv.make_box("ardud")
        self.hers = self.srv.make_box("moni")
        self.her_root = str(self.people / "moni")

    @contextlib.contextmanager
    def who(self, name):
        env = {"OFFBOX_THREAD": f"person:{name}"} if name != common.DEFAULT_OWNER else {}
        with patch.dict(os.environ, env), patch.object(api, "_key", return_value=self.srv.tok[name]):
            yield

    def reap(self, name):
        with self.who(name):
            return self.quiet(reap.reap)


class Reaper(Home):
    def test_a_pass_with_our_token_leaves_her_lease_alone_when_her_box_is_not_in_our_list(self):
        self.lease(self.his, "ardud")
        self.lease(self.hers, "moni", root=self.her_root, key="moni")
        with self.who("ardud"):
            self.assertEqual([b["id"] for b in api.list_boxes()], [self.his], "our token does not list her box")
        actions = self.reap("ardud")
        self.assertEqual(self.state(self.hers), "running")
        self.assertEqual(self.events(self.hers), [])
        self.assertFalse([a for a in actions if self.hers in a], actions)
        self.assertEqual(self.state(self.his), "running")

    def test_the_live_rows_of_12_nov_no_owner_recorded_yet_are_hers_by_her_folder(self):
        # Exactly the row the reaper forgot: owner pool:moni, made from offbox-person's folder, no token owner.
        self.lease(self.hers, None, root=self.her_root, key="moni")
        self.lease(GONE, None)                      # ours, and really gone: the same pass still does its work
        actions = self.reap("ardud")
        self.assertEqual(self.state(self.hers), "running")
        self.assertEqual(self.state(GONE), "deleted")
        self.assertIn(f"forget {GONE}: gone from offbox server", actions)
        self.assertEqual(self.con.execute("SELECT token_owner FROM leases WHERE box_id=?", (self.hers,)).fetchone()[0],
                         "moni")

    def test_her_half_made_and_quarantined_boxes_are_not_forgotten_by_our_pass_either(self):
        for bid, state in (("bx_herup000", "bringing_up"), ("bx_herq0000", "quarantined")):
            self.lease(bid, "moni", root=self.her_root, key="moni", state=state)
        self.lease("bx_ourq0000", "ardud", state="quarantined")
        self.reap("ardud")
        self.assertEqual((self.state("bx_herup000"), self.state("bx_herq0000")), ("bringing_up", "quarantined"))
        self.assertEqual(self.state("bx_ourq0000"), "deleted")

    def test_a_pass_with_her_token_still_forgets_her_box_that_is_really_gone(self):
        self.lease(GONE, "moni", root=self.her_root, key="moni")
        self.lease(self.hers, "moni", root=self.her_root, key="moni")
        self.lease(self.his, "ardud")
        actions = self.reap("moni")
        self.assertEqual(self.state(GONE), "deleted")
        self.assertIn(("reap_forget", "box no longer exists on offbox server"), self.events(GONE))
        self.assertIn(f"forget {GONE}: gone from offbox server", actions)
        self.assertEqual(self.state(self.hers), "running", "her live box stays")
        self.assertEqual(self.state(self.his), "running", "our box is not in her list and is not hers to judge")
        self.assertEqual(self.events(self.his), [])

    def test_our_base_is_not_marked_expired_or_unsaved_by_her_pass(self):
        self.con.execute("INSERT INTO bases (name, repo_key, short, box_id, saved, created_by, token_owner) "
                         "VALUES ('repo:default','repo','default',?, 'offbox-base-repo-default-abc123','thread:t',NULL)",
                         (self.his,))
        self.con.commit()
        self.reap("moni")
        row = self.con.execute("SELECT saved, expired_at FROM bases WHERE name='repo:default'").fetchone()
        self.assertEqual((row["saved"], row["expired_at"]), ("offbox-base-repo-default-abc123", None))


class OtherPaths(Home):
    """The same mistake by other routes: a 404 for her box, read with our token, must never retire her lease."""

    def setUp(self):
        super().setUp()
        self.lease(self.hers, "moni", root=self.her_root, key="moni")
        self.con.execute("INSERT INTO pool_members VALUES (?, 'moni')", (self.hers,))
        self.con.execute("INSERT INTO runs (run_id, box_id, owner, mode, status, process_id, start_at) "
                         "VALUES ('run-hers', ?, 'person:moni', 'bg', 'running', 1001, ?)", (self.hers, common.now()))
        self.con.commit()
        self.me = dict(owner="thread:ours", repo_key="moni", repo_root=self.her_root, session="s", thread="thread:ours",
                       proven=True)

    def refused(self, fn, *a, **kw):
        with self.who("ardud"), self.assertRaises(common.NotYours) as cm:
            self.quiet(fn, *a, **kw)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("belongs to moni", str(cm.exception))
        self.assertEqual(self.state(self.hers), "running")
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-hers'").fetchone()[0], "running")

    def test_no_request_for_her_box_leaves_with_our_token(self):
        sent = []
        real = api._request
        with patch.object(api, "_request", side_effect=lambda *a, **k: sent.append(a[:2]) or real(*a, **k)):
            self.refused(api.get, self.hers)
            self.refused(api.stop, self.hers)
            self.refused(api.cmd_status, self.hers, 1001)
            self.refused(lambda: list(api.cmd_attach(self.hers, 1001)))
            with self.who("moni"):
                self.assertEqual(api.get(self.hers)["id"], self.hers)
        self.assertEqual(sent, [("GET", f"/sandboxes/{self.hers}")], "only her own read was sent")

    def test_release_ssh_ports_logs_wait_and_kill_by_id_are_refused(self):
        with patch.object(lease, "keep_images", side_effect=AssertionError("nothing may reach her box")), \
                patch("subprocess.call", side_effect=AssertionError("no ssh to her box")):
            self.refused(misc.release, self.me, self.hers, False, False)
            self.refused(misc.release, self.me, self.hers, False, True)
            self.refused(misc.ssh_shell, self.me, self.hers, ["id"])
            self.refused(misc.ports, self.me, 3000, None, self.hers)
            self.refused(misc.logs, "run-hers", False)
            self.refused(misc.wait, "run-hers", 1)
            self.refused(misc.kill_run, "run-hers")

    def test_her_pool_box_is_not_offered_to_our_checkout_with_the_same_repository_key(self):
        self.con.execute("UPDATE runs SET status='done' WHERE run_id='run-hers'")   # idle: any caller could take it
        self.con.commit()
        with self.who("ardud"):
            rows, _ = pool.candidates(self.con, "moni", None, None, self.me)
            self.assertEqual([r["box_id"] for r in rows], [])
            self.assertEqual(pool.members(self.con, "moni"), [])
            self.assertIsNone(lease.find_lease(self.con, "pool:moni", self.her_root))
        with self.who("moni"):
            rows, _ = pool.candidates(self.con, "moni", None, None, dict(self.me, owner="person:moni"))
            self.assertEqual([r["box_id"] for r in rows], [self.hers])
            self.assertEqual(lease.find_lease(self.con, "pool:moni", self.her_root)["box_id"], self.hers)

    def test_her_new_box_does_not_start_from_or_expire_our_template(self):
        self.con.execute("INSERT INTO templates (name, box_id, size, saved, token_owner) "
                         "VALUES ('generic', ?, 'default', 'offbox-template-generic', 'ardud')", (self.his,))
        self.con.commit()
        made = []
        with self.who("moni"), patch.object(api, "create", side_effect=lambda *a, **k: made.append(k) or {"id": "bx_new"}), \
                patch.object(api, "fork", side_effect=AssertionError("our template is not hers to fork")):
            _box, source, _dir, _size = self.quiet(lease._new_box, self.con, dict(self.me, owner="person:moni"), None,
                                                    None, None, False)
        self.assertEqual((source, made), ("recipe:generic", [{}]), "her own recipe box, without our saved snapshot")
        row = self.con.execute("SELECT saved, expired_at FROM templates WHERE name='generic'").fetchone()
        self.assertEqual((row["saved"], row["expired_at"]), ("offbox-template-generic", None))
        with self.who("moni"), self.assertRaises(common.OffboxError) as cm:
            bases._refuse_other_owner(self.con, "templates", "generic")
        self.assertIn("belongs to ardud", str(cm.exception))

    def test_a_new_lease_records_the_token_owner_that_made_it(self):
        for name, bid in (("moni", "bx_newhers0"), ("ardud", "bx_newours0")):
            with self.who(name), patch.object(lease, "_bring_up"), patch.object(api, "rename"):
                row = self.quiet(lease._create_row, self.con, dict(self.me, owner="pool:x"), bid, "fresh", None,
                                 "default", common.now())
            self.assertEqual(row["token_owner"], name)


class Boat(Scoped):
    """boat.dev has one account: every lease is visible to it, whatever its token owner says. Nothing changes."""

    def test_a_boat_pass_forgets_any_lease_whose_box_is_gone_as_before(self):
        self.assertEqual((common.backend(), api.NAME, common.mine(), common.mine("l")), ("boat", "boat", "1=1", "1=1"))
        self.lease("bx_ours0000", None)
        self.lease("bx_named000", "ardud")
        self.lease("bx_hers0000", "moni", root=str(self.people / "moni"), key="moni")
        self.lease("bx_live0000", None)
        live = [{"id": "bx_live0000", "state": "ready", "type": "default", "name": "x"}]
        for env in ({}, {"OFFBOX_THREAD": "person:moni"}):
            with patch.dict(os.environ, env), patch.object(api, "list_boxes", return_value=live), \
                    patch.object(api, "get", return_value=None), patch.object(lease, "ensure_ttl", return_value=True):
                actions = self.quiet(reap.reap)
        for bid in ("bx_ours0000", "bx_named000", "bx_hers0000"):
            self.assertEqual(self.state(bid), "deleted", bid)
            self.assertIn(("reap_forget", "box no longer exists on boat"), self.events(bid))
        self.assertEqual(self.state("bx_live0000"), "running")
        self.assertEqual(actions, [])
        # Rows with no owner recorded stay as they are on Boat: nothing reads the column there.
        self.assertIsNone(self.con.execute("SELECT token_owner FROM leases WHERE box_id='bx_ours0000'").fetchone()[0])

    def test_no_boat_request_or_command_is_refused_for_a_lease_with_another_token_owner(self):
        self.lease("bx_hers0000", "moni")
        common.require_mine(self.con, "bx_hers0000")
        with patch.object(api, "_request", return_value={"sandbox": {"id": "bx_hers0000"}}) as sent:
            self.assertEqual(api.get("bx_hers0000"), {"id": "bx_hers0000"})
        sent.assert_called_once()
        rows, _ = pool.candidates(self.con, "repo", None, None, self.me)
        self.assertEqual([r["box_id"] for r in rows], ["bx_hers0000"])


OLD_SCHEMA = """
CREATE TABLE leases (box_id TEXT PRIMARY KEY, owner TEXT NOT NULL, thread_id TEXT, session_id TEXT, thread_title TEXT,
  manager_thread TEXT, repo_root TEXT NOT NULL, repo_key TEXT NOT NULL, remote_dir TEXT NOT NULL, size TEXT,
  source TEXT, state TEXT NOT NULL DEFAULT 'running', created_at REAL, last_used_at REAL, archive_after REAL,
  pinned_until REAL, thread_gone_since REAL, ssh_ready_at REAL, deleted_at REAL, note TEXT);
CREATE TABLE bases (name TEXT PRIMARY KEY, repo_key TEXT, short TEXT, box_id TEXT, from_box TEXT, size TEXT,
  remote_dir TEXT, is_default INTEGER DEFAULT 0, note TEXT, created_at REAL, created_by TEXT, size_bytes INTEGER,
  saved TEXT, expired_at REAL);
CREATE TABLE templates (name TEXT PRIMARY KEY, box_id TEXT, size TEXT, built_at REAL, recipe_sha TEXT, note TEXT,
  saved TEXT, expired_at REAL);
"""


class Migration(Scoped):
    """A database from before leases recorded their token owner."""

    def old_db(self):
        path = Path(self.tmp.name) / "old.sqlite"
        con = sqlite3.connect(path)
        con.executescript(OLD_SCHEMA)
        rows = (("bx_hers0000", str(self.people / "moni"), "moni", "deleted"),        # forgotten on 12 Nov
                ("bx_hers0001", str(self.people / "moni" / "project"), "project", "running"),
                ("bx_ours0000", "/Volumes/ExternalSSD/crpko-devops", "crpko-devops", "running"),
                ("bx_ours0001", str(self.people) + "-backup/moni", "moni", "stopped"),  # a look-alike folder
                ("bx_ours0002", str(self.people / "state"), "state", "running"),        # offbox-person's own folder
                ("bx_ours0003", str(self.people), "people", "running"))                 # the root itself
        con.executemany("INSERT INTO leases (box_id, owner, repo_root, repo_key, remote_dir, state) "
                        "VALUES (?, 'pool:x', ?, ?, 'w/x', ?)", rows)
        con.executemany("INSERT INTO bases (name, box_id, created_by) VALUES (?,?,?)",
                        (("moni:default", "bx_base0000", "person:moni"), ("repo:default", "bx_base0001", "thread:t")))
        con.execute("INSERT INTO templates (name, box_id) VALUES ('generic', 'bx_tpl00000')")
        con.commit()
        con.close()
        self.stack.enter_context(patch.object(common, "DB_PATH", path))
        return path

    def owners(self, table="leases", key="box_id"):
        with contextlib.closing(common.db()) as con:
            return {r[0]: r[1] for r in con.execute(f"SELECT {key}, token_owner FROM {table}")}

    def test_the_home_database_gets_the_column_and_every_old_row_its_owner(self):
        self.old_db()
        with patch.object(common, "_BACKEND", "server"):
            want = {"bx_hers0000": "moni", "bx_hers0001": "moni", "bx_ours0000": "ardud", "bx_ours0001": "ardud",
                    "bx_ours0002": "ardud", "bx_ours0003": "ardud"}
            self.assertEqual(self.owners(), want)
            self.assertEqual(self.owners("bases", "name"), {"moni:default": "moni", "repo:default": "ardud"})
            self.assertEqual(self.owners("templates", "name"), {"generic": "ardud"})
            # Again, and as her process: the same answer, and a row that has an owner is never rewritten.
            with contextlib.closing(common.db()) as con:
                con.execute("UPDATE leases SET token_owner='moni' WHERE box_id='bx_ours0003'")
                con.commit()
            with patch.dict(os.environ, {"OFFBOX_THREAD": "person:moni"}):
                self.assertEqual(self.owners(), {**want, "bx_ours0003": "moni"})
            self.assertEqual(self.owners(), {**want, "bx_ours0003": "moni"})

    def test_a_row_an_older_client_writes_later_without_the_column_is_filled_on_the_next_open(self):
        self.old_db()
        with patch.object(common, "_BACKEND", "server"):
            self.owners()
            with contextlib.closing(common.db()) as con:
                con.execute("INSERT INTO leases (box_id, owner, repo_root, repo_key, remote_dir) "
                            "VALUES ('bx_hers0002', 'pool:moni', ?, 'moni', 'w/x')", (str(self.people / "moni"),))
                con.commit()
            self.assertEqual(self.owners()["bx_hers0002"], "moni")

    def test_the_boat_database_gets_the_column_and_nothing_else(self):
        self.old_db()
        self.assertEqual(common.backend(), "boat")
        self.assertEqual(set(self.owners().values()), {None})
        self.assertEqual(set(self.owners("bases", "name").values()) | set(self.owners("templates", "name").values()),
                         {None})

    def test_whose_folder(self):
        root = str(self.people)
        for path, who in ((root + "/moni", "moni"), (root + "/moni/a/b", "moni"), (root + "/moni/", "moni"),
                          (root + "/lydia-2", "lydia-2"), (root, "ardud"), (root + "/", "ardud"),
                          (root + "/state", "ardud"), (root + "/restic/moni", "ardud"), (root + "/bad name", "ardud"),
                          (root + "x/moni", "ardud"), ("/checkout/moni", "ardud"), ("", "ardud"), (None, "ardud")):
            self.assertEqual(common.owner_of_root(path), who, path)
        with patch.dict(os.environ, {"OFFBOX_PERSON_ROOT": ""}), patch.object(common, "HOME", Path("/Users/x")):
            self.assertEqual(common.owner_of_root("/Users/x/.local/share/offbox-person/moni"), "moni")


if __name__ == "__main__":
    unittest.main()
