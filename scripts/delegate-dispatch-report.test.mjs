import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { score } from "./delegate-dispatch-report.mjs";
const success = (id = "a") => ({
  ok: true,
  value: { taskId: id, childThreadId: `thread:${id}`, childRunId: `run:${id}`, partial: false },
});
const row = (id = "a", elapsedMs = 1) => ({
  tool: "delegate_task",
  id,
  measured: true,
  elapsedMs,
  retryElapsedMs: elapsedMs,
  result: success(id),
  beforeRetryCount: 1,
  originalCommitObserved: true,
  beforeRetryStatus: success(id),
  retry: success(id),
  status: success(id),
});
const send = { tool: "t3_thread_send", id: "s", measured: true, elapsedMs: 1, result: success() };
const inventory = (rows) => ({
  rows: rows.map((r) => ({
    id: r.retry?.value?.taskId,
    child: r.retry?.value?.childThreadId,
    runs: [r.retry?.value?.childRunId],
  })),
});
const run = (rows) => score({ mcpLoad: [...rows, send] }, inventory(rows));
NodeTest.test("passes saved same-id retries and inclusive 5s bound", () =>
  NodeAssert.equal(run([row("a", 5000)]).verdict, "PASS"),
);
NodeTest.test("rejects missing and unfinished observations", () => {
  NodeAssert.equal(score({}).verdict, "INVALID");
  const r = row();
  delete r.result;
  NodeAssert.equal(run([r]).verdict, "INVALID");
});
NodeTest.test("does not hide unsaved state behind a successful retry", () => {
  const r = row();
  r.beforeRetryCount = 0;
  NodeAssert.equal(run([r]).verdict, "FAIL");
});
NodeTest.test("rejects a retry returning a different task", () => {
  const r = row();
  r.retry = success("different");
  NodeAssert.equal(run([r]).verdict, "FAIL");
});
NodeTest.test("does not score unavailable provider failures as success", () => {
  const r = row();
  r.result = { ok: false, error: { code: "provider_unavailable" } };
  NodeAssert.equal(run([r]).verdict, "INVALID");
});
NodeTest.test("dispatch timeout fraction uses offered calls and includes exact 2 percent", () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(String(i)));
  rows[0].result = {
    ok: false,
    error: { code: "delegation_timeout", message: "delegate_task timed out during dispatch" },
  };
  NodeAssert.equal(run(rows).checks.dispatchTimeouts, true);
  rows[1].result = rows[0].result;
  NodeAssert.equal(run(rows).checks.dispatchTimeouts, false);
});
NodeTest.test("excludes warmup and rejects duplicate offered identities", () => {
  const r = row();
  r.measured = false;
  NodeAssert.equal(run([r]).verdict, "INVALID");
  NodeAssert.equal(run([row(), row()]).verdict, "INVALID");
});

NodeTest.test("does not hide a different retry task after a dispatch timeout", () => {
  const r = row();
  r.result = {
    ok: false,
    error: {
      code: "delegation_timeout",
      message: "delegate_task timed out during dispatch. Task a may still be created;",
    },
  };
  r.retry = success("different");
  NodeAssert.deepEqual(run([r]).changedTask, ["a"]);
});

NodeTest.test("does not accept an unobserved original commit after a successful retry", () => {
  const r = row();
  r.originalCommitObserved = false;
  NodeAssert.equal(run([r]).checks.saved, false);
});

NodeTest.test("includes retry failures and latency in the scored call population", () => {
  const r = row();
  r.retryElapsedMs = 6000;
  NodeAssert.equal(run([r]).checks.p95, false);
  r.retry = { ok: false, error: { code: "provider_unavailable" } };
  NodeAssert.equal(run([r]).verdict, "INVALID");
});

NodeTest.test("rejects originals sharing task or child identities", () => {
  for (const key of ["taskId", "childThreadId", "childRunId"]) {
    const rows = [row("a"), row("b")];
    for (const field of ["result", "retry", "beforeRetryStatus", "status"])
      rows[1][field].value[key] = rows[0][field].value[key];
    NodeAssert.equal(run(rows).checks.saved, false, key);
  }
});
NodeTest.test("rejects retry identity changes in every identity field", () => {
  for (const key of ["taskId", "childThreadId", "childRunId"]) {
    const r = row();
    r.retry.value[key] = "different";
    NodeAssert.equal(run([r]).checks.saved, false, key);
  }
});
NodeTest.test("rejects partial or mismatched status evidence", () => {
  for (const field of ["beforeRetryStatus", "status"])
    for (const shape of ["partial", "missing", "task", "thread", "run"]) {
      const r = row();
      if (shape === "partial") r[field].value = { partial: true, stoppedAt: "caller", taskId: "a" };
      if (shape === "missing") delete r[field].value.childThreadId;
      if (shape === "task") r[field].value.taskId = "other";
      if (shape === "thread") r[field].value.childThreadId = "other";
      if (shape === "run") r[field].value.childRunId = "other";
      NodeAssert.equal(run([r]).checks.saved, false, field + shape);
    }
});
NodeTest.test("requires complete persisted cardinality and bindings after retries", () => {
  const r = row();
  NodeAssert.equal(score({ mcpLoad: [r, send] }).verdict, "INVALID");
  for (const shape of ["extra", "missing", "duplicate", "child", "run", "extraRun"]) {
    const data = inventory([r]);
    if (shape === "extra") data.rows.push({ id: "extra", child: "extra", runs: ["extra"] });
    if (shape === "missing") data.rows = [];
    if (shape === "duplicate") data.rows.push(data.rows[0]);
    if (shape === "child") data.rows[0].child = "other";
    if (shape === "run") data.rows[0].runs = ["other"];
    if (shape === "extraRun") data.rows[0].runs.push("extra");
    NodeAssert.equal(score({ mcpLoad: [r, send] }, data).checks.saved, false, shape);
  }
});

NodeTest.test("reconciles warmup originals as strictly as measured originals", () => {
  for (const shape of [
    "aliasedOriginal",
    "partialBefore",
    "partialAfter",
    "missingBefore",
    "missingAfter",
    "noCommit",
    "notSaved",
  ]) {
    const warmup = row("warmup");
    warmup.measured = false;
    const measured = row("measured");
    if (shape === "aliasedOriginal") {
      warmup.result = success("measured");
      warmup.beforeRetryStatus = success("measured");
    }
    if (shape === "partialBefore")
      warmup.beforeRetryStatus = { ok: true, value: { partial: true, stoppedAt: "caller" } };
    if (shape === "partialAfter")
      warmup.status = { ok: true, value: { partial: true, stoppedAt: "caller" } };
    if (shape === "missingBefore") delete warmup.beforeRetryStatus;
    if (shape === "missingAfter") delete warmup.status;
    if (shape === "noCommit") warmup.originalCommitObserved = false;
    if (shape === "notSaved") warmup.beforeRetryCount = 0;
    const scored = run([warmup, measured]);
    NodeAssert.equal(scored.checks.saved, false, shape);
    NodeAssert.equal(scored.delegateCalls, 2, shape);
  }
});
