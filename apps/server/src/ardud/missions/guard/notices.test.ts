// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway bridge database for the ledger.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeNoticeLedger } from "./notices.ts";

const tempStore = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "missions-notices-")),
    "state.sqlite",
  );

describe("notice ledger", () => {
  it.effect("reads the rows the bridge's send step writes, and nothing from an older bridge", () =>
    Effect.gen(function* () {
      const file = tempStore();
      const db = new NodeSqlite.DatabaseSync(file);
      // The bridge's own DDL (integrations/spectrum-bridge/src/store.ts).
      db.exec(`
        CREATE TABLE IF NOT EXISTS notices (
          guid TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
          session TEXT NOT NULL, record_id TEXT NOT NULL, sent_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notices_sent_at ON notices(sent_at);
      `);
      const insert = db.prepare(
        "INSERT INTO notices (guid, operation_id, kind, session, record_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("guid-1", "request:1:permission:a", "runtime-request", "ses_abc", "perm-1", 1_000);
      insert.run("guid-2", "request:1:question:b", "runtime-request", "t-master", "q-1", 2_000);
      db.close();

      const ledger = makeNoticeLedger(file);
      assert.deepStrictEqual(yield* ledger.byGuid("guid-1"), {
        guid: "guid-1",
        kind: "runtime-request",
        session: "ses_abc",
        recordId: "perm-1",
        sentAt: 1_000,
      });
      assert.strictEqual(yield* ledger.byGuid("guid-unknown"), null);
      const between = yield* ledger.sentBetween(1_500, 2_000);
      assert.deepStrictEqual(
        between.map((notice) => notice.guid),
        ["guid-2"],
      );

      // A store an older bridge wrote has no ledger: nothing binds, nothing fails.
      const older = tempStore();
      new NodeSqlite.DatabaseSync(older).close();
      assert.strictEqual(yield* makeNoticeLedger(older).byGuid("guid-1"), null);
      assert.deepStrictEqual(yield* makeNoticeLedger(older).sentBetween(0, 10_000), []);
      assert.strictEqual(yield* makeNoticeLedger(`${older}.missing`).byGuid("guid-1"), null);
    }),
  );
});
