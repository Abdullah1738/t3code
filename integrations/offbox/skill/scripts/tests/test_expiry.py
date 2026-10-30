"""Offline tests for boat's 14-day data limit on stopped boxes (expired templates, bases and leases)."""
import contextlib
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, bases, common, lease, pool, reap  # noqa: E402
from test_capacity import Isolated  # noqa: E402

EXPIRED = api.ApiError(409, "snapshot_data_expired", "The sandbox stayed stopped for 14 days. boat deleted its data.")
DAY = 86400


def iso_ago(seconds):
    import datetime as dt
    return dt.datetime.fromtimestamp(common.now() - seconds, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ExpiryTests(Isolated):
    def setUp(self):
        super().setUp()
        self.quiet = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def template(self, name="crpko-node", box="bx_tpl", saved=None, expired_at=None, size="large"):
        self.con.execute("INSERT INTO templates (name, box_id, size, built_at, recipe_sha, note, saved, expired_at) "
                         "VALUES (?,?,?,?,?,?,?,?)", (name, box, size, common.now(), "sha", "{}", saved, expired_at))
        self.con.commit()

    def base(self, name="repo:default", box="bx_base", default=1, saved=None, expired_at=None):
        self.con.execute("INSERT INTO bases (name, repo_key, short, box_id, size, remote_dir, is_default, created_at, "
                         "saved, expired_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (name, "repo", name.split(":")[1], box, "large", "w/base", default, common.now(), saved,
                          expired_at))
        self.con.commit()

    def new_box(self, template=None, base=None, fresh=False):
        with patch.object(lease, "pick_template", return_value="crpko-node"):
            return lease._new_box(self.con, self.me, None, template, base, fresh)

    def kinds(self, box_id=None):
        q = "SELECT kind FROM events" + (" WHERE box_id=?" if box_id else "")
        return [r[0] for r in self.con.execute(q, (box_id,) if box_id else ())]

    # ------------------------------------------------------------ starting a new lease

    def test_expired_template_builds_from_recipe_instead_of_exit_90(self):
        self.template()
        with patch.object(api, "fork", side_effect=EXPIRED), \
                patch.object(api, "create", return_value={"id": "bx_new"}) as create:
            s, source, rdir, sz = self.new_box()
        self.assertEqual((s["id"], source, rdir, sz), ("bx_new", "recipe:crpko-node", None, "large"))
        self.assertIsNone(create.call_args.kwargs.get("saved"))
        self.assertIsNotNone(self.con.execute("SELECT expired_at FROM templates").fetchone()[0])
        self.assertIn("template_expired", self.kinds("bx_tpl"))
        # Once marked, the next lease skips the doomed fork entirely.
        with patch.object(api, "fork") as fork, patch.object(api, "create", return_value={"id": "bx_2"}):
            self.assertEqual(self.new_box()[1], "recipe:crpko-node")
        fork.assert_not_called()

    def test_saved_snapshot_is_tried_first(self):
        self.template(saved="offbox-template-crpko-node", expired_at=common.now())
        with patch.object(api, "fork") as fork, patch.object(api, "create", return_value={"id": "bx_new"}) as create:
            s, source, _, sz = self.new_box()
        self.assertEqual((s["id"], source, sz), ("bx_new", "template:crpko-node", "large"))
        self.assertEqual(create.call_args.kwargs["saved"], "offbox-template-crpko-node")
        self.assertEqual(create.call_args.args[0], "large")
        fork.assert_not_called()

    def test_missing_saved_snapshot_falls_back_to_the_box(self):
        self.template(saved="offbox-template-crpko-node")
        gone = api.ApiError(404, "snapshot_not_found", "No saved snapshot")
        with patch.object(api, "create", side_effect=gone), patch.object(api, "fork", return_value={"id": "bx_f"}):
            s, source, _, _ = self.new_box()
        self.assertEqual((s["id"], source), ("bx_f", "template:crpko-node"))
        self.assertIsNone(self.con.execute("SELECT saved FROM templates").fetchone()[0])

    def test_other_boat_errors_still_fail(self):
        self.template()
        with patch.object(api, "fork", side_effect=api.ApiError(500, "internal", "boom")), \
                patch.object(api, "create") as create:
            with self.assertRaises(api.ApiError):
                self.new_box()
        create.assert_not_called()
        self.assertIsNone(self.con.execute("SELECT expired_at FROM templates").fetchone()[0])

    def test_expired_default_base_falls_through_to_template(self):
        self.base()
        self.template()
        with patch.object(api, "fork", side_effect=[EXPIRED, {"id": "bx_t"}]):
            s, source, rdir, _ = self.new_box()
        self.assertEqual((s["id"], source, rdir), ("bx_t", "template:crpko-node", None))
        self.assertIsNotNone(self.con.execute("SELECT expired_at FROM bases").fetchone()[0])
        # A marked default base without a saved snapshot is skipped next time.
        with patch.object(api, "fork", return_value={"id": "bx_t2"}) as fork:
            self.assertEqual(self.new_box()[1], "template:crpko-node")
        self.assertEqual(fork.call_args.args[0], "bx_tpl")

    def test_explicit_expired_base_is_a_usage_error(self):
        self.base(default=0, expired_at=common.now())
        with patch.object(api, "fork") as fork:
            with self.assertRaises(common.OffboxError) as cm:
                self.new_box(base="default")
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("boat deletes", str(cm.exception))
        fork.assert_not_called()

    def test_recipe_lease_runs_the_recipe_and_serves_template_pools(self):
        self.template(expired_at=common.now())
        with patch.object(api, "create", return_value={"id": "bx_r"}), patch.object(api, "rename"), \
                patch.object(lease, "_bring_up") as up, patch.object(lease, "pick_template", return_value="crpko-node"):
            row = lease.acquire_private(dict(self.me, owner="pool:repo"))
        self.assertEqual(row["source"], "recipe:crpko-node")
        self.assertEqual(up.call_args.kwargs, {"fresh": False, "recipe": "crpko-node"})
        self.assertEqual(lease.natural_size(self.con, row), "large")
        self.con.execute("INSERT INTO pool_members VALUES ('bx_r','repo')")
        self.con.commit()
        rows, _ = pool.candidates(self.con, "repo", None, "template:crpko-node")
        self.assertEqual([r["box_id"] for r in rows], ["bx_r"])

    def test_run_recipe_uploads_and_runs_the_template_script(self):
        with patch.object(lease.ssh_sync, "put_file") as put, patch.object(bases, "template_uploads") as up, \
                patch.object(api, "cmd_start", return_value={"processId": 7}) as start, \
                patch("offbox_lib.runs.follow", return_value=0):
            lease.run_recipe("bx_r", "crpko-node")
        self.assertEqual(put.call_args.args[1], "/home/user/.offbox/recipe.sh")
        self.assertIn(b"# ---- recipe ----", put.call_args.args[2])
        up.assert_called_once_with("crpko-node", "bx_r")
        self.assertIn("recipe.sh", start.call_args.args[1])
        self.assertIn("lease_recipe", self.kinds("bx_r"))

    # ------------------------------------------------------------ reusing a stopped lease

    def test_reuse_forgets_a_lease_whose_data_is_gone(self):
        self.box("old", "stopped")
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='old'").fetchone())
        with patch.object(api, "get", return_value={"state": "archived", "dataExpiredAt": iso_ago(DAY)}), \
                patch.object(api, "resume") as resume:
            self.assertIsNone(lease._reuse(self.con, row, None))
        resume.assert_not_called()
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], "deleted")
        self.box("old2", "stopped")
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='old2'").fetchone())
        with patch.object(api, "get", return_value={"state": "archived", "type": "large"}), \
                patch.object(api, "resume", side_effect=EXPIRED):
            self.assertIsNone(lease._reuse(self.con, row, None))
        self.assertIn("lease_expired", self.kinds("old2"))

    def test_pool_moves_on_to_a_new_box_after_an_expired_member(self):
        self.box("old", "stopped", member=True)
        with patch.object(api, "get", return_value={"state": "archived", "type": "large"}), \
                patch.object(api, "resume", side_effect=EXPIRED), \
                patch.object(lease, "acquire_private", return_value={"box_id": "bx_new", "size": "large"}) as new:
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(row["box_id"], "bx_new")
        new.assert_called_once()

    # ------------------------------------------------------------ listing

    def test_template_list_shows_expiry(self):
        self.template(box="bx_dead")
        self.template(name="crpko-go", box="bx_live")
        self.template(name="generic", box="bx_saved", saved="offbox-template-generic", size="default")
        boxes = {"bx_dead": {"state": "archived", "dataExpiredAt": iso_ago(2 * DAY)},
                 "bx_live": {"state": "archived", "stoppedAt": iso_ago(3 * DAY)}}
        with patch.object(api, "get", side_effect=boxes.get) as get:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                bases.list_templates(False)
            text = out.getvalue()
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                bases.list_templates(True)
        lines = {line.split()[0]: line for line in text.splitlines()}
        self.assertIn("EXPIRED", lines["crpko-node"])
        self.assertIn("box only, boat deletes it", lines["crpko-go"])
        self.assertIn("kept (saved snapshot)", lines["generic"])
        self.assertIn("not built", lines["crpko-harness"])
        self.assertNotIn("bx_saved", [c.args[0] for c in get.call_args_list])
        data = json.loads(out.getvalue())
        self.assertEqual(data["expired"], ["crpko-node"])
        self.assertEqual({r["name"]: r["status"] for r in data["built"]},
                         {"crpko-go": "box", "crpko-node": "expired", "generic": "saved"})

    def test_bases_json_keeps_its_shape(self):
        self.base()
        with patch.object(api, "get", side_effect=common.OffboxError("boat API unreachable")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                bases.list_bases(True)
        rows = json.loads(out.getvalue())
        self.assertEqual((rows[0]["name"], rows[0]["box_id"], rows[0]["status"]), ("repo:default", "bx_base", "unknown"))

    def test_saved_name_fits_boat_rules(self):
        import re
        for name in ("crpko-mobile-app-pr298-2b578:crpko-mobile-pr298-2b578", "moni:person", "a:b.c_d"):
            n = bases.saved_name("base", name)
            self.assertRegex(n, r"^[a-z0-9][a-z0-9-]{0,62}$")
        self.assertNotEqual(bases.saved_name("base", "a:b.c"), bases.saved_name("base", "a:b-c"))
        self.assertEqual(bases.saved_name("template", "crpko-go"), "offbox-template-crpko-go")
        self.assertTrue(re.match(r"^offbox-base-moni-person-[0-9a-f]{6}$", bases.saved_name("base", "moni:person")))

    # ------------------------------------------------------------ keeping saved snapshots

    def test_keep_saved_never_spends_beyond_the_included_slots(self):
        self.template()
        full = {"included": 50, "used": 50}
        with patch.object(api, "saved_list", return_value=([], full)), patch.object(api, "save") as save:
            self.assertFalse(bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "offbox-template-x"))
        save.assert_not_called()
        # Replacing a snapshot of the same name doesn't take a new slot.
        with patch.object(api, "saved_list", return_value=([{"name": "offbox-template-x", "status": "ready"}], full)), \
                patch.object(api, "save") as save, \
                patch.object(api, "saved_get", return_value={"status": "ready", "sourceSandboxId": "bx_tpl"}):
            self.assertTrue(bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "offbox-template-x"))
        save.assert_called_once_with("bx_tpl", "offbox-template-x")
        self.assertEqual(self.con.execute("SELECT saved FROM templates").fetchone()[0], "offbox-template-x")

    def test_stale_cached_list_cannot_take_the_last_slot(self):
        # upkeep listed 49 of 50 used; another save finished after that list but before our lock. The fresh read
        # under the lock shows 50 used, so the second save must be refused (no paid snapshot #51).
        self.template()
        fresh = {"included": 50, "used": 50}
        with patch.object(api, "saved_list", return_value=([], fresh)), patch.object(api, "save") as save:
            self.assertFalse(bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "offbox-template-x",
                                              [], {"included": 50, "used": 49}))
        save.assert_not_called()

    def test_ambiguous_save_keeps_its_slot_until_reconciled(self):
        # The save was accepted but the response was lost (5xx/timeout): boat counts a slot, the list is stale.
        # The reservation must survive, so the next check sees 50 used and refuses.
        self.template()
        lost = api.ApiError(502, "upstream", "response lost")
        with patch.object(api, "saved_list", return_value=([], {"included": 50, "used": 49})), \
                patch.object(api, "save", side_effect=lost):
            self.assertFalse(bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "offbox-template-a"))
        self.assertIn("offbox-template-a", bases._pending_load(self.con))
        with patch.object(api, "saved_list", return_value=([], {"included": 50, "used": 49})), patch.object(api, "save") as save:
            self.assertFalse(bases.keep_saved(self.con, "bases", "repo:b", "bx_b", "offbox-base-b-000000"))
        save.assert_not_called()

    def test_definitive_refusal_releases_the_reservation(self):
        self.template()
        with patch.object(api, "saved_list", return_value=([], {"included": 50, "used": 0})), \
                patch.object(api, "save", side_effect=api.ApiError(400, "credit_required", "no credit")):
            self.assertFalse(bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "offbox-template-r"))
        self.assertNotIn("offbox-template-r", bases._pending_load(self.con))

    def test_keep_saved_failure_is_only_a_warning(self):
        self.template()
        with patch.object(api, "saved_list", return_value=([], {"included": 50, "used": 0})), \
                patch.object(api, "save", side_effect=api.ApiError(400, "credit_required", "no credit")):
            self.assertFalse(bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "n"))
        self.assertIsNone(self.con.execute("SELECT saved FROM templates").fetchone()[0])
        self.assertIn("saved_failed", self.kinds("bx_tpl"))

    def test_retry_sleep_respects_the_budget(self):
        # A connect failure with a near-spent budget must not sleep past the deadline or retry six times.
        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise api.ApiError(502, "sandbox_direct_failed", "connect EADDRNOTAVAIL")

        with patch("urllib.request.urlopen", side_effect=lambda *a, **k: boom()), \
                patch.object(api, "_key", return_value="k"), patch.object(api.time, "sleep") as sleep:
            with api.budget(0.5):
                with self.assertRaises(Exception):
                    api.call("POST", "/sandboxes", {}, {"Idempotency-Key": "x"})
        self.assertEqual(sleep.call_count, 0)

    def test_keep_saved_lock_wait_is_capped_by_the_budget(self):
        # The reap budget has seconds left: the slot lock must not block for the 60 s default.
        self.template()
        real = bases.file_lock
        seen = []

        def spy(name, timeout=600):
            seen.append(timeout)
            return real(name, timeout=0.5)  # keep the test fast: the real lock is free anyway

        with api.budget(8), patch.object(bases, "file_lock", side_effect=spy), \
                patch.object(api, "saved_list", return_value=([], {"included": 50, "used": 0})), \
                patch.object(api, "save", side_effect=api.ApiError(400, "x", "refused")):
            bases.keep_saved(self.con, "templates", "crpko-node", "bx_tpl", "offbox-template-w", timeout=300)
        self.assertTrue(seen and seen[0] <= 8, seen)

    def test_recipe_timeout_with_lost_kill_stays_quarantined(self):
        # The follower never ends and the kill response is lost: the lease must stay quarantined, never 'stopped'
        # or 'running', so pool/reuse cannot hand it out, and it is not released without a confirmed stop.
        con = common.db()
        con.execute("INSERT INTO leases (box_id, owner, repo_root, repo_key, remote_dir, size, source, state, "
                    "created_at, last_used_at) VALUES ('bx_q','o','/r','rk','d','small','recipe:generic',"
                    "'running',0,0)")
        con.commit()
        with patch.object(lease, "RECIPE_TIMEOUT_S", 0), \
                patch.object(bases, "recipe", return_value=("echo", "sha")), \
                patch.object(lease.ssh_sync, "put_file"), patch.object(bases, "template_uploads"), \
                patch.object(lease.api, "cmd_start", return_value={"processId": 9}), \
                patch.object(lease, "_follow_bounded", return_value="timeout"), \
                patch.object(lease.api, "cmd_kill", side_effect=api.ApiError(500, "x", "lost")), \
                patch.object(lease.api, "cmd_status", return_value=None):
            with self.assertRaises(common.OffboxError):
                lease.run_recipe("bx_q", "generic")
        self.assertEqual(con.execute("SELECT state FROM leases WHERE box_id='bx_q'").fetchone()[0], "quarantined")
        self.assertFalse(lease.release_quarantine(con, "bx_q"))
        self.assertNotIn("bx_q", [r["box_id"] for r in con.execute(
            "SELECT box_id FROM leases WHERE state IN ('running','stopped')")])

    def test_rm_base_deletes_its_saved_snapshot(self):
        self.base(saved="offbox-base-x")
        with patch.object(api, "delete"), patch.object(api, "delete_saved") as rm, \
                contextlib.redirect_stdout(io.StringIO()):
            bases.rm_base(self.me, "default")
        rm.assert_called_once_with("offbox-base-x")

    # ------------------------------------------------------------ reaper

    def reap(self, live, snaps=None, allowance=None):
        actions = []
        with patch.object(api, "list_boxes", return_value=live), \
                patch.object(api, "saved_list", return_value=(snaps or [], allowance or {"included": 50, "used": 0})), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(api, "get", side_effect=lambda bid: next((x for x in live if x["id"] == bid), None)), \
                patch.object(lease, "ensure_ttl"), patch.object(lease, "stop_box"):
            reap._reap(self.con, False, actions)
        return actions

    def test_reaper_forgets_expired_leases(self):
        self.box("dead", "stopped", member=True, used=common.now())
        self.box("alive", "stopped", used=common.now())
        self.reap([{"id": "dead", "state": "archived", "dataExpiredAt": iso_ago(DAY)},
                   {"id": "alive", "state": "archived", "stoppedAt": iso_ago(DAY)}])
        states = dict(self.con.execute("SELECT box_id, state FROM leases").fetchall())
        self.assertEqual(states, {"dead": "deleted", "alive": "stopped"})
        self.assertIn("reap_expired", self.kinds("dead"))

    def test_reaper_keeps_expired_lease_while_its_box_is_locked(self):
        self.box("dead", "stopped", member=True, used=common.now())
        lease.ensure_holds(self.con)
        self.con.execute("INSERT INTO prune_holds VALUES ('dead', 'r1', ?)", (common.now(),))
        self.con.commit()
        with common.file_lock("box-dead", timeout=1):
            actions = self.reap([{"id": "dead", "state": "archived", "dataExpiredAt": iso_ago(DAY)}])
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='dead'").fetchone()[0], "stopped")
        self.assertTrue(any("hold kept dead" in a for a in actions))
        self.reap([{"id": "dead", "state": "archived", "dataExpiredAt": iso_ago(DAY)}])
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='dead'").fetchone()[0], "deleted")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM prune_holds").fetchone()[0], 0)

    def test_reaper_adopts_saves_and_marks_templates(self):
        self.template(name="crpko-node", box="bx_adopt")
        self.template(name="crpko-go", box="bx_save")
        self.template(name="generic", box="bx_dead", size="default")
        live = [{"id": "bx_adopt", "state": "archived", "stoppedAt": iso_ago(DAY)},
                {"id": "bx_save", "state": "archived", "stoppedAt": iso_ago(DAY)},
                {"id": "bx_dead", "state": "archived", "dataExpiredAt": iso_ago(DAY)}]
        snaps = [{"name": "offbox-template-crpko-node", "status": "ready", "sourceSandboxId": "bx_adopt"}]
        with patch.object(api, "save") as save, \
                patch.object(api, "saved_get", return_value={"status": "ready", "sourceSandboxId": "bx_save"}), \
                patch.object(bases, "_spawn_rebuild", return_value=True) as rebuild:
            actions = self.reap(live, snaps)
        saved = dict(self.con.execute("SELECT name, saved FROM templates").fetchall())
        self.assertEqual(saved, {"crpko-node": "offbox-template-crpko-node", "crpko-go": "offbox-template-crpko-go",
                                 "generic": None})
        save.assert_called_once_with("bx_save", "offbox-template-crpko-go")
        self.assertIsNotNone(self.con.execute("SELECT expired_at FROM templates WHERE name='generic'").fetchone()[0])
        rebuild.assert_called_once_with(self.con, "generic")
        self.assertTrue(any("rebuild expired template generic" in a for a in actions))
        # Hourly: the next pass doesn't list saved snapshots again.
        with patch.object(api, "saved_list") as listed, patch.object(bases, "_spawn_rebuild", return_value=False):
            self.reap(live)
        listed.assert_not_called()

    def test_reaper_refreshes_unsaved_base_and_pinned_lease_before_day_14(self):
        self.base(box="bx_old")
        self.base(name="repo:young", box="bx_young", default=0)
        self.box("pinned", "stopped", used=common.now() - 20 * DAY)
        self.con.execute("UPDATE leases SET pinned_until=? WHERE box_id='pinned'", (common.now() + 30 * DAY,))
        self.con.commit()
        live = [{"id": "bx_old", "state": "archived", "stoppedAt": iso_ago(13 * DAY)},
                {"id": "bx_young", "state": "archived", "stoppedAt": iso_ago(2 * DAY)},
                {"id": "pinned", "state": "archived", "stoppedAt": iso_ago(13 * DAY)}]
        full = {"included": 50, "used": 50}
        with patch.object(lease, "refresh_box") as refresh:
            self.reap(live, [], full)
        self.assertEqual(sorted(c.args[1] for c in refresh.call_args_list), ["bx_old", "pinned"])

    def test_refresh_box_resumes_then_stops(self):
        with patch.object(api, "resume") as resume, patch.object(api, "wait_state"), patch.object(api, "stop") as stop:
            lease.refresh_box(self.con, "bx_x")
        resume.assert_called_once()
        stop.assert_called_once_with("bx_x")
        self.assertIn("refresh", self.kinds("bx_x"))

    def test_db_migration_adds_columns(self):
        for table in ("templates", "bases"):
            cols = {r[1] for r in self.con.execute(f"PRAGMA table_info({table})")}
            self.assertTrue({"saved", "expired_at"} <= cols)
        common.db().close()  # idempotent


if __name__ == "__main__":
    import unittest
    unittest.main()
