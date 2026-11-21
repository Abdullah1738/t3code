import * as Cause from "effect/Cause";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { sqliteErrorDetails } from "@t3tools/shared/nodeSqliteErrors";
import { PersistenceSqlError } from "../../persistence/Errors.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);

// Only server persistence errors qualify: a model's own SQLite/tool failure does not.
export function runIngestionFailure(cause: unknown) {
  const pending = [cause];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!Predicate.isObject(current) || seen.has(current)) continue;
    seen.add(current);
    if (isPersistenceSqlError(current)) {
      const sqlite = sqliteErrorDetails(current);
      return makeProviderFailure({
        class: "unknown",
        category: "persistence",
        code: sqlite === undefined ? "persistence_sql_error" : `sqlite_${sqlite.errcode}`,
        message: `Robob could not save the run's events: ${
          current.detail ??
          (sqlite === undefined
            ? "SQL error"
            : `SQLITE(${sqlite.errcode}) ${sqlite.errstr ?? "SQL error"}`)
        }`,
        retryable: false,
      });
    }
    if (Cause.isCause(current)) {
      for (const reason of current.reasons) {
        if (Cause.isFailReason(reason)) pending.push(reason.error);
        else if (Cause.isDieReason(reason)) pending.push(reason.defect);
      }
    } else {
      pending.push(current.cause, current.reason);
    }
  }
  return makeProviderFailure({
    cause: Cause.isCause(cause) ? Cause.squash(cause) : cause,
    class: "unknown",
  });
}
