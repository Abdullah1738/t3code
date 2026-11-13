import { annotateSqliteError } from "@t3tools/shared/nodeSqliteErrors";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { CommandId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { CommandPolicyCapabilityUnsupportedError } from "./CommandPolicy.ts";
import {
  OrchestratorDispatchError,
  OrchestratorCommandPreviouslyRejectedError,
} from "./Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

describe("userFacingDispatchErrorMessage", () => {
  it("returns the deepest actionable domain error instead of generic dispatch wrappers", () => {
    const message = userFacingDispatchErrorMessage({
      message: "Failed to dispatch orchestration command checkpoint.rollback (command-1).",
      cause: {
        message: "Provider adapter failed while dispatching orchestration command command-1.",
        cause: {
          message:
            "claudeAgent cannot satisfy rollback for command command-1: provider conversation rollback is unavailable",
        },
      },
    });

    assert.equal(
      message,
      "claudeAgent cannot satisfy rollback for command command-1: provider conversation rollback is unavailable",
    );
  });

  it("translates policy capability rejections into provider-named prose", () => {
    assert.equal(
      userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command checkpoint.rollback (command-1).",
        cause: {
          _tag: "CommandPolicyCapabilityUnsupportedError",
          commandId: "command-1",
          threadId: "thread-1",
          providerInstanceId: "pi",
          capability: "rollback_snapshot",
          detail: "rollback must return a provider thread snapshot",
          message:
            "pi cannot satisfy rollback_snapshot for command command-1: rollback must return a provider thread snapshot",
        },
      }),
      "Pi did not report its rewound conversation state, so the checkpoint was not restored.",
    );
    assert.equal(
      userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command checkpoint.rollback (command-2).",
        cause: {
          _tag: "CommandPolicyCapabilityUnsupportedError",
          commandId: "command-2",
          threadId: "thread-1",
          providerInstanceId: "grok",
          capability: "rollback",
          detail: "provider conversation rollback is unavailable",
        },
      }),
      "Grok cannot rewind its conversation, so this checkpoint cannot be restored on this thread.",
    );
  });

  it.each(["claudeAgent", "pi"])(
    "keeps the %s restart reason on first call and replay",
    (provider) => {
      const commandId = CommandId.make("command:restart-rejected");
      const reason = `${provider === "claudeAgent" ? "Claude" : "Pi"} cannot restart an active run. Use t3_thread_interrupt, then send the message.`;
      const error = new OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: new CommandPolicyCapabilityUnsupportedError({
          commandId,
          threadId: ThreadId.make("thread:restart-rejected"),
          providerInstanceId: ProviderInstanceId.make(provider),
          capability: "interrupt_restart_steering",
          detail: "required interrupt-and-restart",
        }),
      });
      assert.equal(userFacingDispatchErrorMessage(error), reason);
      const replay = new OrchestratorCommandPreviouslyRejectedError({
        commandId,
        commandType: "message.dispatch",
        detail: reason,
      });
      assert.include(userFacingDispatchErrorMessage(replay), `previously rejected: ${reason}`);
      assert.notInclude(replay.message, "Failed to dispatch orchestration command");
    },
  );

  it("uses explicit detail fields as user-facing messages", () => {
    assert.equal(
      userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command message.dispatch (command-1).",
        cause: {
          detail: "Claude provider thread provider-thread-1 has no live query.",
        },
      }),
      "Claude provider thread provider-thread-1 has no live query.",
    );
  });

  it.effect("explains a real database open failure through dispatch and persistence wrappers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-database-error-" });
      const cause = yield* Effect.void.pipe(
        Effect.provide(
          NodeSqliteClient.layer({ filename: path.join(directory, "missing", "state.sqlite") }),
        ),
        Effect.flip,
      );
      const message = userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command message.dispatch (command-1).",
        cause: toPersistenceSqlError("OrchestrationEventStore.append:query")(cause),
      });

      assert.include(message, "storage is temporarily unavailable");
      assert.include(message, "then retry");
      assert.notInclude(message, directory);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains a full database and allows a retry after capacity is restored", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (payload BLOB)`;
      yield* sql`PRAGMA max_page_count = 2`;
      const cause = yield* sql`INSERT INTO entries VALUES (zeroblob(16384))`.pipe(Effect.flip);
      const message = userFacingDispatchErrorMessage({ cause });

      assert.include(message, "database or disk is full (SQLITE_FULL)");
      assert.include(message, "Free space on the machine running the server, then retry");
      assert.include(message, "database size limit");

      yield* sql`PRAGMA max_page_count = 100`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(16384))`;
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`;
      assert.equal(rows[0]?.count, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("gives server permission guidance for a real read-only failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (payload TEXT)`;
      yield* sql`PRAGMA query_only = ON`;
      const cause = yield* sql`INSERT INTO entries VALUES ('private-message')`.pipe(Effect.flip);
      const message = userFacingDispatchErrorMessage(cause);

      assert.include(message, "server database is read-only (SQLITE_READONLY)");
      assert.include(message, "data directory is writable");
      assert.notInclude(message, "private-message");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.each([
    [5, "SQLITE_BUSY", "Wait a moment, then retry"],
    [6, "SQLITE_LOCKED", "Wait a moment, then retry"],
    [10 | (3 << 8), "SQLITE_IOERR", "free disk space and disk health"],
    [14 | (6 << 8), "SQLITE_CANTOPEN", "exist and are writable"],
    [11, "SQLITE_CORRUPT", "temporarily unavailable"],
    [26, "SQLITE_NOTADB", "temporarily unavailable"],
  ] as const)("maps SQLite code %i to %s with recovery guidance", (errcode, code, guidance) => {
    const cause = Object.assign(new Error("private-query-data"), { errcode, errno: errcode });
    const error = new SqlError({ reason: classifySqliteError(cause) });
    const message = userFacingDispatchErrorMessage({ cause: error });

    assert.include(message, code);
    assert.include(message, guidance);
    assert.notInclude(message, "private-query-data");
  });

  it.each([
    ["primary", false, undefined, "appears damaged"],
    ["primary", true, undefined, "temporarily unavailable"],
    ["replica", false, undefined, "temporarily unavailable"],
    ["unknown", false, undefined, "temporarily unavailable"],
    ["primary", false, "EIO", "temporarily unavailable"],
    ["primary", false, "ENOENT", "temporarily unavailable"],
  ] as const)(
    "classifies corruption from %s (missing=%s, io=%s)",
    (role, volumeUnavailable, code, wording) => {
      const raw = Object.assign(new Error("private-sql"), {
        errcode: 779,
        errno: 779,
        ...(code ? { code } : {}),
      });
      annotateSqliteError(raw, {
        file: ":memory:",
        role,
        connection: "reader",
        operation: "execute",
        span: "test",
        ...(code ? {} : { volumeUnavailable }),
      });
      const message = userFacingDispatchErrorMessage(
        new SqlError({ reason: classifySqliteError(raw) }),
      );
      assert.include(message, wording);
      assert.notInclude(message, "backup");
      assert.notInclude(message, "private-sql");
    },
  );

  it("returns retryable wording for a replica read interrupted by replacement", () => {
    const raw = { errcode: 26, errno: 26 };
    annotateSqliteError(raw, {
      file: ":memory:",
      role: "replica",
      connection: "reader",
      operation: "execute",
      span: "test",
    });
    const message = userFacingDispatchErrorMessage(
      new SqlError({ reason: classifySqliteError(raw) }),
    );
    assert.include(message, "temporarily unavailable");
    assert.notInclude(message, "backup");
  });

  it.effect("reports a real failed replica open as retryable storage unavailability", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "replica.sqlite");
      yield* fs.writeFileString(filename, "invalid SQLite file".repeat(1024));
      const failed = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT * FROM sqlite_schema`;
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({ filename, readonly: true, databaseRole: "replica" }),
        ),
        Effect.flip,
      );
      assert.include(userFacingDispatchErrorMessage(failed), "temporarily unavailable");
      assert.notInclude(userFacingDispatchErrorMessage(failed), "backup");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.each(["ENOENT", "EIO"])(
    "maps volume error %s without a SQLite result code to retryable wording",
    (code) => {
      const cause = { code };
      annotateSqliteError(cause, {
        file: ":memory:",
        role: "primary",
        connection: "writer",
        operation: "open",
        span: "test",
      });
      const message = userFacingDispatchErrorMessage(
        new SqlError({ reason: classifySqliteError(cause) }),
      );
      assert.include(message, "temporarily unavailable");
      assert.notInclude(message, "backup");
    },
  );

  it("keeps unknown SQL failures contextual without exposing driver text or parameters", () => {
    const cause = Object.assign(new Error("private-query-data"), { errcode: 1 });
    const error = new SqlError({ reason: classifySqliteError(cause) });
    const message = userFacingDispatchErrorMessage({
      cause: toPersistenceSqlError("OrchestrationEventStore.append:query")(error),
    });

    assert.include(message, "server could not complete this database request");
    assert.include(message, "server logs");
    assert.notInclude(message, "private-query-data");
  });
});
