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
            s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                      (f"sub{i}", prev, tid, "claudeAgent", "claudeAgent",
                       json.dumps({"nativeTaskRef": {"driver": "claudeAgent", "nativeId": f"agent-{i}"},
                                   "providerThreadId": None})))
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
        s.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,?,?,?)",
                  ("subC", "CP", "CC", "claudeAgent", "claudeAgent",
                   json.dumps({"nativeTaskRef": {"driver": "claudeAgent", "nativeId": "AGT-7"},
                               "providerThreadId": None, "threadId": "CP"})))
        s.commit()
        s.close()
        ti.sync(self.mem, self.state)
        rows = [r for r in self.aliases() if r[0] == "CC"]
        self.assertEqual(len(rows), 1)
        canonical, root, native, agent = rows[0]
        self.assertEqual((native, agent), ("SESS-PARENT", "AGT-7"))
        self.assertNotEqual(native, "CP")

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
