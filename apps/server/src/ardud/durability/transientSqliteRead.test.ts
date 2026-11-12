import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as SqlError from "effect/sql/SqlError";

import { isTransientSqliteReadFailure } from "./transientSqliteRead.ts";

const readerFailure = (message: string) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause: new Error(message),
      message: "Failed to execute statement",
      operation: "execute",
    }),
  });

it("treats a retired, missing or exited reader as transient through wrappers", () => {
  // The 9 Nov chain: normalize error -> projection read error -> SqlError -> reason -> Error.
  const wrapped = {
    _tag: "ProviderEventNormalizeError",
    message: "Failed to normalize provider event node.updated",
    cause: {
      _tag: "ProjectionStoreReadError",
      message: "Failed to read orchestration projection",
      cause: readerFailure("Database reader retired: a statement ran longer than 120000 ms"),
    },
  };
  assert.isTrue(isTransientSqliteReadFailure(wrapped));
  assert.isTrue(isTransientSqliteReadFailure(Cause.fail(wrapped)));
  assert.isTrue(isTransientSqliteReadFailure(readerFailure("Reader lane unavailable")));
  assert.isTrue(isTransientSqliteReadFailure(readerFailure("Database reader exited with code 1")));
  assert.isTrue(isTransientSqliteReadFailure(readerFailure("database is locked")));
});

it("does not retry permanent failures or interruption", () => {
  assert.isFalse(isTransientSqliteReadFailure(readerFailure("no such table: nodes")));
  assert.isFalse(isTransientSqliteReadFailure(new Error("Expected string, got null")));
  assert.isFalse(isTransientSqliteReadFailure(Cause.interrupt()));
  assert.isFalse(isTransientSqliteReadFailure(undefined));
  const cyclic: Record<string, unknown> = { message: "outer" };
  cyclic.cause = cyclic;
  assert.isFalse(isTransientSqliteReadFailure(cyclic));
});
