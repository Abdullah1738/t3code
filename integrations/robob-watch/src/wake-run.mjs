import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Use the installed CLI's client and credentials, including its permissions and deadlines.
const [cli, threadId, runId] = process.argv.slice(2);
try {
  const { ControlClient } = await import(pathToFileURL(join(dirname(realpathSync(cli)), "client.mjs")).href);
  const client = new ControlClient({ component: "t3ctl", timeoutMs: 10_000 });
  const result = await client.request("GET", `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/evidence`);
  const { ok, threadId: target, runId: id, status, requestedAt, startedAt } = result;
  console.log(JSON.stringify({ ok, threadId: target, runId: id, status, requestedAt, startedAt }));
} catch (error) {
  // A missing route or thread is not proof that this run disappeared.
  if (error?.code === "not_found" && error.message === `Run ${runId} was not found on thread ${threadId}.`) {
    console.log(JSON.stringify({ ok: true, threadId, runId, missing: true }));
  } else {
    console.error("run lookup unavailable");
    process.exitCode = 1;
  }
}
