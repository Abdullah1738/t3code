import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { MAX_PROVIDER_FAILURE_MESSAGE_LENGTH } from "@t3tools/provider-core/server/failure";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { runIngestionFailure } from "./runPersistenceFailure.ts";

it.each([14, 1546, 10, 13, 5])("retains nested SQLite error %s as persistence", (errcode) => {
  const sql = new PersistenceSqlError({
    operation: "OrchestrationEventStore.appendAgentEvents:insert",
    detail: `SQLITE(${errcode}) unable to open database file`,
    cause: { cause: { errcode, errstr: "unable to open database file" } },
  });
  const failure = runIngestionFailure(
    Cause.fail({
      _tag: "RunExecutionIngestError",
      cause: {
        _tag: "ProviderEventPublishError",
        cause: { _tag: "EventSinkWriteError", cause: sql },
      },
    }),
  );
  assert.equal(failure.category, "persistence");
  assert.equal(failure.code, `sqlite_${errcode}`);
  assert.equal(
    failure.message,
    `Robob could not save the run's events: SQLITE(${errcode}) unable to open database file`,
  );
  assert.equal(failure.retryable, false);
});

it("handles cycles and defects without classifying a provider tool's SQLite failure", () => {
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.isUndefined(runIngestionFailure(cycle).category);
  assert.isUndefined(runIngestionFailure(new Error("SQLITE(14) from model's tool")).category);
  const sql = new PersistenceSqlError({ operation: "write", cause: { errcode: 14 } });
  assert.equal(
    runIngestionFailure(Cause.combine(Cause.fail(cycle), Cause.die(sql))).category,
    "persistence",
  );
});

it("bounds and redacts SQL details before persisting the run failure", () => {
  const failure = runIngestionFailure(
    new PersistenceSqlError({
      operation: "write",
      detail: `SQLITE(14) Authorization: Bearer private-value ${"x".repeat(5000)}`,
    }),
  );
  assert.equal(failure.code, "persistence_sql_error");
  assert.include(failure.message, "[REDACTED]");
  assert.notInclude(failure.message, "private-value");
  assert.isAtMost(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});
