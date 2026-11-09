"""sync_thread_identity: aliases from a read-only statev2 fixture, one canonical id per thread."""

import json
from replica_fixture import ready
import contextlib
import io
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import native_identity as ni  # noqa: E402
import sync_thread_identity as ti  # noqa: E402
import transcript_capture as tc  # noqa: E402

SCHEMA = open(os.path.join(SRC, "schema.sql")).read()
STATE_DDL = """
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, title TEXT, payload_json TEXT,
  deleted_at TEXT, active_provider_thread_id TEXT, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT PRIMARY KEY, thread_id TEXT,
  provider TEXT, driver TEXT, provider_instance_id TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_subagents(subagent_id TEXT PRIMARY KEY, thread_id TEXT,
  child_thread_id TEXT, provider_instance_id TEXT, driver TEXT, payload_json TEXT);
CREATE TABLE ardud_opencode_import(native_session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL);
"""


TURN_DDL = ("CREATE TABLE IF NOT EXISTS orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,"
            " thread_id TEXT, provider_thread_id TEXT, node_id TEXT, run_attempt_id TEXT, ordinal INTEGER, status TEXT,"
            " started_at TEXT, completed_at TEXT, payload_json TEXT)")


def add_turn(con, turn_id, thread_id, provider_thread_id, node_id):
    """A provider turn that ran at node_id on provider_thread_id: the link a child's parent chain resolves to."""
    con.execute(TURN_DDL)
    con.execute("INSERT INTO orchestration_v2_projection_provider_turns VALUES(?,?,?,?,NULL,1,'completed',NULL,NULL,'{}')",
                (turn_id, thread_id, provider_thread_id, node_id))


def thread(tid, title, parent=None, cwd="/repo", model="m"):
    return (tid, title, json.dumps({"worktreePath": cwd, "modelSelection": {"model": model},
                                    "lineage": {"parentThreadId": parent,
                                                "rootThreadId": parent or tid}}), None, None, "codex")


class IdentityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "statev2.sqlite")
        self.mem = os.path.join(self.tmp.name, "memory.db")
        s = sqlite3.connect(self.state)
        ready(s)
        s.executescript(STATE_DDL)
        # thread T: started as OpenCode (imported), then Claude native, then Codex native
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("T", "Kafka fix"))
        s.execute("INSERT INTO ardud_opencode_import VALUES('ses_OC','T','2026-10-01')")
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('pt1','T','opencode','opencode','opencode',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "opencode", "nativeId": "ses_OC"}}),))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('pt2','T','claudeAgent','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": "CLAUDE-S"}}),))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('pt3','T','codex','codex','codex',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "codex", "nativeId": "CODEX-T"}}),))
        # two distinct threads with identical title and cwd
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("U", "Same title"))
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("V", "Same title"))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('pu','U','codex','codex','codex',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "codex", "nativeId": "U-NATIVE"}}),))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('pv','V','codex','codex','codex',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "codex", "nativeId": "V-NATIVE"}}),))
        # deep chain: 100 children, each a thread whose parent is the previous one, plus a native agent
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("R", "Root"))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('ptR','R','claudeAgent','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": "ROOT-SESS"}}),))
        prev = "R"
        for i in range(1, 101):
            tid = f"C{i}"
            s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                      thread(tid, f"child {i}", parent=prev))
            # every link is a native parent: each level has its own provider thread (native session)
            s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                      (f"ptC{i}", tid, "claudeAgent", "claudeAgent", "claudeAgent",
                       json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": f"SESS-C{i}"}})))
            add_turn(s, f"turn-{i}", prev, f"ptC{i-1}" if i > 1 else "ptR", f"node-{i-1}")
            s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                      (f"sub{i}", prev, tid, "claudeAgent", "claudeAgent",
                       json.dumps({"nativeTaskRef": {"driver": "claudeAgent", "nativeId": f"agent-{i}"},
                                   "parentNodeId": f"node-{i-1}", "providerThreadId": None})))
            prev = tid
        s.commit()
        s.close()
        os.environ["MEMORY_DB"] = self.mem
        con = sqlite3.connect(self.mem)
        con.executescript(SCHEMA)
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop("MEMORY_DB", None)

    def aliases(self):
        con = sqlite3.connect(self.mem)
        rows = con.execute("SELECT canonical_thread_id, root_thread_id, native_id, agent_id FROM thread_aliases").fetchall()
        con.close()
        return rows

    def test_one_thread_three_native_aliases_one_canonical(self):
        ti.sync(self.mem, self.state)
        rows = [r for r in self.aliases() if r[0] == "T"]
        self.assertEqual({r[2] for r in rows}, {"ses_OC", "CLAUDE-S", "CODEX-T"})
        self.assertEqual({r[0] for r in rows}, {"T"})

    def test_same_title_and_cwd_stay_distinct(self):
        ti.sync(self.mem, self.state)
        by_native = {r[2]: r[0] for r in self.aliases()}
        self.assertEqual(by_native["U-NATIVE"], "U")
        self.assertEqual(by_native["V-NATIVE"], "V")

    def test_depth_100_child_resolves_to_root(self):
        ti.sync(self.mem, self.state)
        rows = {r[0]: r for r in self.aliases()}
        # C100's native key is its direct parent's native session (C99), agent = its own task id
        self.assertEqual(rows["C100"][2], "SESS-C99")
        self.assertEqual(rows["C100"][3], "agent-100")
        self.assertEqual(rows["C100"][1], "R")  # the canonical root still resolves to the top thread

    def test_claude_child_keyed_by_parent_native_session_and_agent(self):
        """Capture key for a Claude child is '<parent native sessionId>:agent:<agentId>'.

        The alias must carry the parent's NATIVE session (from its provider thread's
        nativeThreadRef), not the app thread id, and not providerThreadId (null for native tasks).
        """
        s = sqlite3.connect(self.state)
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("CP", "Claude parent"))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('ptc','CP','claudeAgent','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": "SESS-PARENT"}}),))
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("CC", "Claude child", parent="CP"))
        add_turn(s, "turn-cp", "CP", "ptc", "node-cp-root")
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                  ("subC", "CP", "CC", "claudeAgent", "claudeAgent",
                   json.dumps({"nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-7"},
                               "parentNodeId": "node-cp-root", "providerThreadId": None, "threadId": "CP"})))
        s.commit()
        s.close()
        ti.sync(self.mem, self.state)
        rows = [r for r in self.aliases() if r[0] == "CC"]
        self.assertEqual(len(rows), 1)
        canonical, root, native, agent = rows[0]
        self.assertEqual((native, agent), ("SESS-PARENT", "AGT-7"))
        self.assertNotEqual(native, "CP")
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "SESS-PARENT"), "CP")
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "SESS-PARENT:agent:AGT-7"), "CC")

    def test_codex_child_uses_its_task_id_not_parent_native_id(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("CODEX-CHILD", "Codex child", parent="T"))
            add_turn(con, "codex-turn", "T", "pt3", "codex-parent-node")
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("codex-sub", "T", "CODEX-CHILD", "codex", "codex",
                         json.dumps({"nativeTaskRef": {"driver": "codex", "nativeId": "CODEX-CHILD-ID"},
                                     "parentNodeId": "codex-parent-node"})))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            row = con.execute("SELECT native_id,agent_id FROM thread_aliases WHERE canonical_thread_id='CODEX-CHILD'")
            self.assertEqual(row.fetchone(), ("CODEX-T", "CODEX-CHILD-ID"))
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "CODEX-T"), "T")
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "CODEX-CHILD-ID"), "CODEX-CHILD")

    def test_mixed_provider_thread_child_binds_to_its_owning_incarnation(self):
        """One app thread: OpenCode -> Claude (CLAUDE-1) -> Codex -> Claude (CLAUDE-2). A child of the
        second Claude incarnation must alias under CLAUDE-2, never under the first provider row (ses_OC).
        """
        s = sqlite3.connect(self.state)
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("MX", "Mixed"))
        s.execute("INSERT INTO ardud_opencode_import VALUES('ses_MX_OC','MX','2026-10-01')")

        def pt(pid, drv, native):
            s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                      (pid, "MX", drv, drv, drv, json.dumps({"nativeThreadRef": {"driver": drv, "nativeId": native}})))

        pt("mx-oc", "opencode", "ses_MX_OC")
        pt("mx-cl1", "claudeAgent", "CLAUDE-1")
        pt("mx-cx", "codex", "CODEX-MX")
        pt("mx-cl2", "claudeAgent", "CLAUDE-2")
        # the run that spawned the child belongs to the second Claude incarnation
        s.execute("CREATE TABLE IF NOT EXISTS orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,"
                  " thread_id TEXT, provider_thread_id TEXT, node_id TEXT, run_attempt_id TEXT, ordinal INTEGER, status TEXT,"
                  " started_at TEXT, completed_at TEXT, payload_json TEXT)")
        s.execute("INSERT INTO orchestration_v2_projection_provider_turns VALUES('turn-cl2','MX','mx-cl2','node-parent-cl2',NULL,1,'completed',NULL,NULL,'{}')")
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("MXCH", "Claude child", parent="MX"))
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('mxsub','MX','MXCH','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-MX"},
                               "parentNodeId": "node-parent-cl2", "providerThreadId": None}),))
        s.commit()
        s.close()
        ti.sync(self.mem, self.state)
        rows = [r for r in self.aliases() if r[0] == "MXCH"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0][2], rows[0][3]), ("CLAUDE-2", "AGT-MX"))
        self.assertNotEqual(rows[0][2], "ses_MX_OC")

    def test_grandchild_under_claude_subagent_walks_to_the_owning_incarnation(self):
        """Native children have no provider_threads rows, so a grandchild is found by walking the
        parentNodeId chain: grandchild -> Claude subagent task node -> provider turn -> CLAUDE-2.
        """
        s = sqlite3.connect(self.state)
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("GC", "Grand"))
        s.execute("INSERT INTO ardud_opencode_import VALUES('ses_GC_OC','GC','2026-10-01')")

        def pt(pid, drv, native):
            s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                      (pid, "GC", drv, drv, drv, json.dumps({"nativeThreadRef": {"driver": drv, "nativeId": native}})))

        pt("gc-oc", "opencode", "ses_GC_OC")
        pt("gc-cl1", "claudeAgent", "CLAUDE-G1")
        pt("gc-cx", "codex", "CODEX-G")
        pt("gc-cl2", "claudeAgent", "CLAUDE-G2")
        s.execute("CREATE TABLE IF NOT EXISTS orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,"
                  " thread_id TEXT, provider_thread_id TEXT, node_id TEXT, run_attempt_id TEXT, ordinal INTEGER, status TEXT,"
                  " started_at TEXT, completed_at TEXT, payload_json TEXT)")
        # the root node of the second Claude incarnation's turn
        s.execute("INSERT INTO orchestration_v2_projection_provider_turns VALUES('gc-turn','GC','gc-cl2','node-root-cl2',NULL,1,'completed',NULL,NULL,'{}')")
        # a Claude subagent task (its own node id is task-node-A) spawned by that turn
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("GCH", "Claude subagent", parent="GC"))
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('sub-A','GC','GCH','claudeAgent','claudeAgent',?)",
                  (json.dumps({"id": "task-node-A", "nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-A"},
                               "parentNodeId": "node-root-cl2", "providerThreadId": None}),))
        # the grandchild, spawned by task-node-A (not by a turn)
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("GCC", "Grandchild", parent="GCH"))
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('sub-B','GCH','GCC','claudeAgent','claudeAgent',?)",
                  (json.dumps({"id": "task-node-B", "nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-B"},
                               "parentNodeId": "task-node-A", "providerThreadId": None}),))
        # an unresolvable child: its parent node exists nowhere in the state
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("ORPH", "Orphan", parent="GC"))
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('sub-C','GC','ORPH','claudeAgent','claudeAgent',?)",
                  (json.dumps({"id": "task-node-C", "nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-C"},
                               "parentNodeId": "node-that-does-not-exist", "providerThreadId": None}),))
        s.commit()
        s.close()
        ti.sync(self.mem, self.state)
        grand = [r for r in self.aliases() if r[0] == "GCC"]
        self.assertEqual(len(grand), 1)
        self.assertEqual((grand[0][2], grand[0][3]), ("CLAUDE-G2", "AGT-B"))
        self.assertNotEqual(grand[0][2], "ses_GC_OC")
        self.assertEqual([r for r in self.aliases() if r[0] == "ORPH"], [])

    def test_child_claimed_by_two_provider_threads_gets_no_alias(self):
        """Two different provider threads ran a turn at the same chain node: the child is ambiguous and
        gets no alias at all (logged), rather than a guess.
        """
        s = sqlite3.connect(self.state)
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("AMB", "Ambiguous"))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('amb-1','AMB','claudeAgent','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": "AMB-S1"}}),))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('amb-2','AMB','claudeAgent','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": "AMB-S2"}}),))
        add_turn(s, "amb-t1", "AMB", "amb-1", "node-shared")
        add_turn(s, "amb-t2", "AMB", "amb-2", "node-shared")
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("AMBC", "Ambiguous child", parent="AMB"))
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES('amb-sub','AMB','AMBC','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-AMB"},
                               "parentNodeId": "node-shared", "providerThreadId": None}),))
        s.commit()
        s.close()
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            ti.sync(self.mem, self.state)
        self.assertEqual([r for r in self.aliases() if r[0] == "AMBC"], [])
        self.assertIn("AMBC", buf.getvalue())
        self.assertIn("provider threads claim", buf.getvalue())

    def test_duplicate_provider_alias_claims_fail_closed_after_gather(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("CLASH", "Clashing thread"))
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                        ("pt-clash", "CLASH", "codex", "codex", "codex",
                         json.dumps({"nativeThreadRef": {"driver": "codex", "nativeId": "CODEX-T"}})))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "codex", "codex", "CODEX-T"))
            self.assertEqual(con.execute("SELECT count(*) FROM thread_aliases WHERE driver='codex'"
                                         " AND instance='codex' AND native_id='CODEX-T' AND agent_id IS NULL")
                             .fetchone()[0], 0)
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "U-NATIVE"), "U")
        # Resolution returns once the snapshot proves only one owner again.
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='pt-clash'")
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "CODEX-T"), "T")

    def test_duplicate_child_alias_claims_fail_closed_after_gather(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            for tid in ("CC1", "CC2"):
                con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                            thread(tid, tid, parent="R"))
                con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                            ("sub-" + tid, "R", tid, "claudeAgent", "claudeAgent",
                             json.dumps({"nativeTaskRef": {"nativeId": "DUP-AGENT"},
                                         "parentNodeId": "node-0"})))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "claudeAgent", "claude", "ROOT-SESS:agent:DUP-AGENT"))
            self.assertEqual(con.execute("SELECT count(*) FROM thread_aliases WHERE native_id='ROOT-SESS'"
                                         " AND agent_id='DUP-AGENT'").fetchone()[0], 0)

    def test_conflicting_codex_child_claims_cannot_expose_a_parent_alias(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("COLLIDING-PARENT", "Parent"))
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                        ("collision-parent", "COLLIDING-PARENT", "codex", "codex", "codex",
                         json.dumps({"nativeThreadRef": {"nativeId": "SHARED-CODEX"}})))
            add_turn(con, "collision-turn", "T", "pt3", "collision-node")
            for tid in ("CONFLICT-1", "CONFLICT-2"):
                con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                            thread(tid, tid, parent="T"))
                con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                            ("sub-" + tid, "T", tid, "codex", "codex",
                             json.dumps({"nativeTaskRef": {"nativeId": "SHARED-CODEX"},
                                         "parentNodeId": "collision-node"})))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "codex", "codex", "SHARED-CODEX"))
            self.assertIsNone(ni.ThreadResolver(con).resolve_thread("codex", "codex", "SHARED-CODEX"))

    def test_unresolved_codex_child_blocks_other_parent_or_child_claims(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("COLLIDING-PARENT", "Parent"))
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                        ("collision-parent", "COLLIDING-PARENT", "codex", "codex", "codex",
                         json.dumps({"nativeThreadRef": {"nativeId": "SHARED-CODEX"}})))
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("ORPHAN", "Orphan", parent="T"))
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("orphan", "T", "ORPHAN", "codex", "codex",
                         json.dumps({"nativeTaskRef": {"nativeId": "SHARED-CODEX"},
                                     "parentNodeId": "missing-node"})))
        with contextlib.redirect_stderr(io.StringIO()):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "codex", "codex", "SHARED-CODEX"))
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "U-NATIVE"), "U")

    def test_unresolved_claude_child_blocks_same_task_in_another_parent(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("ORPHAN", "Orphan", parent="R"))
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("orphan", "R", "ORPHAN", "claudeAgent", "claudeAgent",
                         json.dumps({"nativeTaskRef": {"nativeId": "agent-1"},
                                     "parentNodeId": "missing-node"})))
        with contextlib.redirect_stderr(io.StringIO()):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "claudeAgent", "claude", "ROOT-SESS:agent:agent-1"))
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "ROOT-SESS"), "R")

    def test_missing_child_task_suppresses_its_provider_scope(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("NO-TASK", "Unknown child", parent="T"))
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("no-task", "T", "NO-TASK", "codex", "codex", "{}"))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "codex", "codex", "CODEX-T"))
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "CLAUDE-S"), "T")

    def test_app_owned_child_does_not_block_its_or_unrelated_provider_alias(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("APP-CHILD", "App child", parent="T"))
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,?,?,?)",
                        ("app-provider", "APP-CHILD", "codex", "codex", "codex",
                         json.dumps({"nativeThreadRef": {"nativeId": "APP-SESSION"}})))
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("app-sub", "T", "APP-CHILD", "codex", "codex",
                         json.dumps({"origin": "app_owned", "nativeTaskRef": None})))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "U-NATIVE"), "U")
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "APP-SESSION"), "APP-CHILD")

    def test_recovery_keeps_historical_parent_and_child_without_guessing_new_child_parent(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("REC-CHILD", "Child", parent="T"))
            add_turn(con, "rec-turn", "T", "pt2", "rec-node")
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("rec-sub", "T", "REC-CHILD", "claudeAgent", "claudeAgent",
                         json.dumps({"nativeTaskRef": {"nativeId": "REC-AGENT"}, "parentNodeId": "rec-node"})))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.state)) as con, con:
            for pt, native in (("pt2", "CLAUDE-RECOVERED"), ("pt3", "CODEX-RECOVERED")):
                con.execute("UPDATE orchestration_v2_projection_provider_threads SET payload_json=? WHERE provider_thread_id=?",
                            (json.dumps({"nativeThreadRef": {"nativeId": native}}), pt))
        ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "CODEX-T"), "T")
            self.assertEqual(ni.resolve_thread(con, "codex", "codex", "CODEX-RECOVERED"), "T")
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "CLAUDE-S:agent:REC-AGENT"), "REC-CHILD")
            self.assertIsNone(ni.resolve_thread(con, "claudeAgent", "claude", "CLAUDE-RECOVERED:agent:REC-AGENT"))

    def test_valid_child_then_ambiguous_owner_drops_previous_alias(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("NEW-CHILD", "Child", parent="R"))
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("new-sub", "R", "NEW-CHILD", "claudeAgent", "claudeAgent",
                         json.dumps({"nativeTaskRef": {"nativeId": "NEW-AGENT"}, "parentNodeId": "node-0"})))
        with mock.patch.object(ti.time, "time", return_value=100):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "ROOT-SESS:agent:NEW-AGENT"),
                             "NEW-CHILD")
        with closing(sqlite3.connect(self.state)) as con, con:
            add_turn(con, "other-owner", "T", "pt2", "node-0")
        # Same timestamp proves removal does not depend on a changed watermark.
        with mock.patch.object(ti.time, "time", return_value=100), contextlib.redirect_stderr(io.StringIO()):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertIsNone(ni.resolve_thread(con, "claudeAgent", "claude", "ROOT-SESS:agent:NEW-AGENT"))
            self.assertEqual(con.execute("SELECT count(*) FROM thread_aliases WHERE canonical_thread_id='NEW-CHILD'")
                             .fetchone()[0], 0)

    def test_gather_uses_one_read_snapshot_across_projections(self):
        with closing(sqlite3.connect(self.state)) as con:
            con.execute("PRAGMA journal_mode=WAL")
        with closing(sqlite3.connect(self.state)) as reader, closing(sqlite3.connect(self.state)) as writer:
            changed = []

            def concurrent_update(sql):
                if not changed and "SELECT thread_id, payload_json, driver, provider_instance_id" in sql:
                    writer.execute("UPDATE orchestration_v2_projection_threads SET title='After' WHERE thread_id='T'")
                    writer.execute("UPDATE orchestration_v2_projection_provider_threads SET payload_json=?"
                                   " WHERE provider_thread_id='pt3'",
                                   (json.dumps({"nativeThreadRef": {"nativeId": "CODEX-AFTER"}}),))
                    writer.commit()
                    changed.append(True)

            reader.set_trace_callback(concurrent_update)
            rows = ti.gather(reader)
            reader.set_trace_callback(None)
            self.assertEqual(changed, [True])
            codex = [r for r in rows if r["canonical"] == "T" and r["driver"] == "codex"]
            self.assertEqual([(r["native"], r["title"]) for r in codex], [("CODEX-T", "Kafka fix")])
            self.assertFalse(reader.in_transaction)

    def test_cyclic_task_chain_gets_no_alias(self):
        """Two subagent task nodes that name each other as parent never reach a turn: no alias, logged."""
        import contextlib
        import io
        s = sqlite3.connect(self.state)
        s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread("CYC", "Cycle"))
        s.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES('cyc-1','CYC','claudeAgent','claudeAgent','claudeAgent',?)",
                  (json.dumps({"nativeThreadRef": {"driver": "claudeAgent", "nativeId": "CYC-S"}}),))
        for tid, own, up in (("CYA", "task-cya", "task-cyb"), ("CYB", "task-cyb", "task-cya")):
            s.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)", thread(tid, tid, parent="CYC"))
            s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                      (f"sub-{tid}", "CYC", tid, "claudeAgent", "claudeAgent",
                       json.dumps({"id": own, "nativeTaskRef": {"driver": "claudeAgent", "nativeId": f"AGT-{tid}"},
                                   "parentNodeId": up, "providerThreadId": None})))
        s.commit()
        s.close()
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            ti.sync(self.mem, self.state)
        self.assertEqual([r for r in self.aliases() if r[0] in ("CYA", "CYB")], [])
        self.assertIn("no provider turn in the parent chain", buf.getvalue())

    def test_conflicting_task_node_parents_cannot_guess_a_grandchild_owner(self):
        with closing(sqlite3.connect(self.state)) as con, con:
            add_turn(con, "conflict-turn", "T", "pt2", "other-root")
            for tid, node_parent in (("NODE-A", "node-0"), ("NODE-B", "other-root")):
                con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                            thread(tid, tid, parent="R"))
                con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                            ("sub-" + tid, "R", tid, "claudeAgent", "claudeAgent",
                             json.dumps({"id": "duplicate-node", "nativeTaskRef": {"nativeId": tid},
                                         "parentNodeId": node_parent})))
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)",
                        thread("GRAND", "Grandchild", parent="NODE-A"))
            con.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                        ("sub-grand", "NODE-A", "GRAND", "claudeAgent", "claudeAgent",
                         json.dumps({"nativeTaskRef": {"nativeId": "GRAND-AGENT"},
                                     "parentNodeId": "duplicate-node"})))
        with contextlib.redirect_stderr(io.StringIO()):
            ti.sync(self.mem, self.state)
        self.assertEqual([r for r in self.aliases() if r[0] == "GRAND"], [])

    def test_existing_snapshot_is_not_committed_by_gather(self):
        with closing(sqlite3.connect(self.state)) as con:
            con.execute("BEGIN")
            con.execute("UPDATE orchestration_v2_projection_threads SET title='Uncommitted' WHERE thread_id='T'")
            rows = ti.gather(con)
            self.assertTrue(con.in_transaction)
            self.assertTrue(any(r["title"] == "Uncommitted" for r in rows if r["canonical"] == "T"))
            con.rollback()
        with closing(sqlite3.connect(self.state)) as con:
            self.assertEqual(con.execute("SELECT title FROM orchestration_v2_projection_threads WHERE thread_id='T'")
                             .fetchone()[0], "Kafka fix")

    def test_refresh_updates_title_and_bumps_revision_without_new_rows(self):
        ti.sync(self.mem, self.state)
        n = len(self.aliases())
        s = sqlite3.connect(self.state)
        s.execute("UPDATE orchestration_v2_projection_threads SET title='Renamed Kafka fix', payload_json=payload_json WHERE thread_id='T'")
        s.commit()
        s.close()
        ti.sync(self.mem, self.state)
        self.assertEqual(len(self.aliases()), n)
        con = sqlite3.connect(self.mem)
        title = con.execute("SELECT title FROM thread_aliases WHERE native_id='CODEX-T'").fetchone()[0]
        con.close()
        self.assertEqual(title, "Renamed Kafka fix")

    def test_watermark_advances_on_metadata_only_and_empty_refresh(self):
        with mock.patch.object(ti.time, "time", return_value=100):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("UPDATE orchestration_v2_projection_threads SET title='Renamed' WHERE thread_id='T'")
        with mock.patch.object(ti.time, "time", return_value=200):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(con.execute("SELECT value FROM harness_schema_meta WHERE key='thread_identity_last_ok'").fetchone(),
                             ("200",))
            self.assertEqual(con.execute("SELECT title FROM thread_aliases WHERE native_id='CODEX-T'").fetchone(),
                             ("Renamed",))
        # A healthy no-alias refresh is still a successful refresh.
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("DELETE FROM orchestration_v2_projection_subagents")
            con.execute("DELETE FROM orchestration_v2_projection_provider_threads")
            con.execute("DELETE FROM ardud_opencode_import")
        with mock.patch.object(ti.time, "time", return_value=300):
            self.assertEqual(ti.sync(self.mem, self.state), 0)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(con.execute("SELECT value FROM harness_schema_meta WHERE key='thread_identity_last_ok'").fetchone(),
                             ("300",))
            self.assertGreater(con.execute("SELECT count(*) FROM thread_aliases").fetchone()[0], 0)

    def test_failed_write_rolls_back_watermark_and_alias_changes(self):
        with mock.patch.object(ti.time, "time", return_value=100):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con, con:
            con.execute("CREATE TRIGGER reject_watermark BEFORE UPDATE ON harness_schema_meta "
                        "WHEN NEW.key='thread_identity_last_ok' BEGIN SELECT RAISE(ABORT, 'rejected'); END")
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("UPDATE orchestration_v2_projection_threads SET title='Must roll back' WHERE thread_id='T'")
            con.execute("DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='pt2'")
        with mock.patch.object(ti.time, "time", return_value=200):
            with self.assertRaises(sqlite3.IntegrityError):
                ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(con.execute("SELECT value FROM harness_schema_meta WHERE key='thread_identity_last_ok'").fetchone(),
                             ("100",))
            self.assertEqual(con.execute("SELECT title FROM thread_aliases WHERE native_id='CODEX-T'").fetchone(),
                             ("Kafka fix",))
            self.assertEqual(ni.resolve_thread(con, "claudeAgent", "claude", "CLAUDE-S"), "T")

    def test_failed_gather_does_not_advance_watermark(self):
        with mock.patch.object(ti.time, "time", return_value=100):
            ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.state)) as con, con:
            con.execute("DROP TABLE ardud_opencode_import")
        with mock.patch.object(ti.time, "time", return_value=200):
            with self.assertRaises(sqlite3.OperationalError):
                ti.sync(self.mem, self.state)
        with closing(sqlite3.connect(self.mem)) as con:
            self.assertEqual(con.execute("SELECT value FROM harness_schema_meta WHERE key='thread_identity_last_ok'").fetchone(),
                             ("100",))

    def test_sync_reads_exact_state_path_with_uri_characters(self):
        special = os.path.join(self.tmp.name, "state?#%.sqlite")
        shutil.copyfile(self.state, special)
        self.assertGreater(ti.sync(self.mem, special), 0)
        self.assertTrue(any(row[0] == "T" for row in self.aliases()))

    def test_gather_does_not_hold_memory_writer_lock_and_refresh_is_serialized(self):
        ti.sync(self.mem, self.state)
        original = ti.gather
        observed = []
        def gather(state, budget=None):
            with closing(sqlite3.connect(self.mem, timeout=0)) as writer, writer:
                writer.execute("BEGIN IMMEDIATE")
                writer.execute("INSERT INTO harness_schema_meta VALUES('other-writer','ok')")
            # A second refresh must not gather a newer snapshot before this one publishes.
            observed.append(ti.sync(self.mem, self.state))
            return original(state, budget)
        with mock.patch.object(ti, "gather", side_effect=gather):
            self.assertGreater(ti.sync(self.mem, self.state), 0)
        self.assertEqual(observed, [0])

    def test_expired_gather_never_publishes_partial_aliases(self):
        from capture_budget import Budget, Exhausted
        ti.sync(self.mem, self.state)
        before = self.aliases()
        clock = [0]
        budget = Budget(1, clock=lambda: clock[0])
        original = ti.gather
        def gather(state, actual_budget):
            rows = original(state, actual_budget)
            clock[0] = 2
            return rows
        with mock.patch.object(ti, "Budget", return_value=budget), mock.patch.object(ti, "gather", side_effect=gather):
            with self.assertRaises(Exhausted):
                ti.sync(self.mem, self.state)
        self.assertEqual(self.aliases(), before)


class NativeIdentityTest(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.addCleanup(self.con.close)
        self.con.executescript(ti.DDL)
        self.con.executescript(tc.DDL)
        self.alias("cl-parent", "CL-PARENT", "claudeAgent", "claudeAgent", "sid")
        self.alias("cl-child", "CL-CHILD", "claudeAgent", "claudeAgent", "sid", "agent-X")
        self.alias("cx-parent", "CX-PARENT", "codex", "codex", "parent-cx")
        self.alias("cx-child", "CX-CHILD", "codex", "codex", "parent-cx", "child-cx")
        self.alias("cx-cu", "CX-CU", "codex", "codex-cu", "parent-cx")

    def alias(self, key, thread, driver, instance, native, agent=None):
        self.con.execute(
            "INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id,agent_id)"
            " VALUES (?,?,?,?,?,?,?)", (key, thread, thread, driver, instance, native, agent)
        )

    def check_both(self, instance, source, session_key, expected):
        self.assertEqual(ni.resolve_thread(self.con, instance, source, session_key), expected)
        self.assertEqual(ni.ThreadResolver(self.con).resolve_thread(instance, source, session_key), expected)

    def test_exact_claude_and_codex_parent_child_aliases(self):
        for instance, source, key, thread in (
                ("claudeAgent", "claude", "sid", "CL-PARENT"),
                ("claudeAgent", "claude", "sid:agent:agent-X", "CL-CHILD"),
                ("codex", "codex", "parent-cx", "CX-PARENT"),
                ("codex", "codex", "child-cx", "CX-CHILD"),
                ("codex-cu", "codex", "parent-cx", "CX-CU"),
                ("codex-cu", "codex", "child-cx", None),
                ("codex", "claude", "parent-cx", None),
                ("claudeAgent", "codex", "sid", None)):
            with self.subTest(instance=instance, source=source, key=key):
                self.check_both(instance, source, key, thread)

    def test_codex_distinct_canonicals_and_parent_child_collisions_fail_closed(self):
        self.alias("same-child", "CX-CHILD", "codex", "codex", "other-parent", "child-cx")
        self.check_both("codex", "codex", "child-cx", "CX-CHILD")
        self.alias("other-child", "OTHER", "codex", "codex", "third-parent", "child-cx")
        self.check_both("codex", "codex", "child-cx", None)
        self.alias("also-parent", "CX-PARENT", "codex", "codex", "child-cx")
        self.con.execute("DELETE FROM thread_aliases WHERE alias_key='other-child'")
        # Even the same canonical ID cannot establish whether this key is a parent or child.
        self.con.execute("UPDATE thread_aliases SET canonical_thread_id='CX-CHILD' WHERE alias_key='also-parent'")
        self.check_both("codex", "codex", "child-cx", None)

    def test_claude_distinct_canonical_and_literal_parent_collision_fail_closed(self):
        self.alias("same", "CL-CHILD", "claudeAgent", "claudeAgent", "sid", "agent-X")
        self.check_both("claudeAgent", "claude", "sid:agent:agent-X", "CL-CHILD")
        self.alias("different", "OTHER", "claudeAgent", "claudeAgent", "sid", "agent-X")
        self.check_both("claudeAgent", "claude", "sid:agent:agent-X", None)
        self.con.execute("DELETE FROM thread_aliases WHERE alias_key='different'")
        self.alias("literal", "CL-CHILD", "claudeAgent", "claudeAgent", "sid:agent:agent-X")
        self.check_both("claudeAgent", "claude", "sid:agent:agent-X", None)

    def test_invalid_matching_codex_child_identity_fails_closed(self):
        self.alias("invalid", "CX-CHILD", "codex", "codex", "", "child-cx")
        self.check_both("codex", "codex", "child-cx", None)

    def test_invalid_inputs_or_missing_schema_fail_closed(self):
        for instance, source, key in (("codex", "codex", None), ("codex", "codex", ""),
                                      ("codex", "codex", " "), ("codex", "codex", "a\x00b"),
                                      ("codex", "codex", "a\x85b"),
                                      ("", "codex", "parent-cx"), ("codex", "unknown", "parent-cx"),
                                      ("claudeAgent", "claude", ":agent:x"),
                                      ("claudeAgent", "claude", "sid:agent:"),
                                      ("claudeAgent", "claude", "sid:agent::x"),
                                      ("claudeAgent", "claude", "sid:agent:x:"),
                                      ("claudeAgent", "claude", "sid::agent:x"),
                                      ("claudeAgent", "claude", "sid:agent:x:agent:y")):
            with self.subTest(instance=instance, source=source, key=key):
                self.check_both(instance, source, key, None)
        self.con.execute("UPDATE thread_aliases SET canonical_thread_id='' WHERE alias_key='cx-parent'")
        self.check_both("codex", "codex", "parent-cx", None)
        self.con.execute("DROP TABLE thread_aliases")
        self.check_both("codex", "codex", "child-cx", None)

    def test_files_for_session_returns_only_current_exact_rows_as_dicts(self):
        for path, instance, key, retired in (("/one", "codex", "child-cx", 0),
                                             ("/two", "codex", "child-cx", 0),
                                             ("/old", "codex", "child-cx", 1),
                                             ("/other-home", "codex-cu", "child-cx", 0),
                                             ("/other-key", "codex", "other", 0)):
            self.con.execute("INSERT INTO native_capture_files(path,logical,instance,session_key,retired)"
                             " VALUES (?,?,?,?,?)", (path, path, instance, key, retired))
        rows = ni.files_for_session(self.con, "codex", "child-cx")
        self.assertEqual([r["path"] for r in rows], ["/one", "/two"])
        self.assertTrue(all(r["instance"] == "codex" and r["session_key"] == "child-cx" for r in rows))
        self.assertEqual(ni.files_for_session(self.con, "codex", ""), [])
        self.assertEqual(ni.files_for_session(self.con, None, "child-cx"), [])
        self.con.execute("INSERT INTO native_capture_files(path,logical,instance,session_key) VALUES (?,?,?,?)",
                         ("/invalid", "/invalid", "claudeAgent", "sid:agent:"))
        self.assertEqual(ni.files_for_session(self.con, "claudeAgent", "sid:agent:"), [])
        self.con.execute("INSERT INTO native_capture_files(path,logical,instance,session_key) VALUES (?,?,?,?)",
                         ("/custom", "/custom", "custom", "child-cx"))
        self.assertEqual([r["path"] for r in ni.files_for_session(self.con, "custom", "child-cx")], ["/custom"])
        self.con.execute("DROP TABLE native_capture_files")
        self.assertEqual(ni.files_for_session(self.con, "codex", "child-cx"), [])


if __name__ == "__main__":
    unittest.main()
