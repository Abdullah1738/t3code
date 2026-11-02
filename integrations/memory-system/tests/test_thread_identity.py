"""sync_thread_identity: aliases from a read-only statev2 fixture, one canonical id per thread."""

import json
import os
import sqlite3
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import sync_thread_identity as ti  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
