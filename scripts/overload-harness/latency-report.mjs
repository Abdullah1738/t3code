import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
const [output, basePath, fixPath] = process.argv.slice(2);
if (!output || !basePath || !fixPath) throw new Error("Usage: latency-report.mjs OUTPUT BASE_JSON FIX1365_JSON");
const inputs = await Promise.all([basePath, fixPath].map(async filename => ({ filename, run: JSON.parse(await NodeFSP.readFile(filename, "utf8")) })));
const streams = ["threads", "nodePk", "providerCredential", "clientCredential"];
const quantile = (values, q) => [...values].sort((a,b) => a-b)[Math.ceil(q * values.length)-1];
const rows = [];
for (const [index, input] of inputs.entries()) {
  const invalid = [];
  const run = input.run;
  if (run.scenario !== "request-latency-1365" || !/^[a-f0-9]{40}$/.test(run.revision ?? "") || !run.offboxRunId || !run.offboxLogPath || !run.source?.workloadHash) invalid.push("missing run/source provenance");
  if (index === 0 && run.revision !== "dbc99fc3a4b817977bc23a57ea7c049da5d45190") invalid.push("base must be .9");
  if (index === 1 && run.candidateIndexPresent !== true) invalid.push("startup candidates index missing");
  if (run.archiveExit !== "Success") invalid.push("archive snapshot did not complete");
  if (index === 1) for (const key of ["node", "cpu", "samples"]) if (inputs[0].run[key] !== run[key]) invalid.push(`changed ${key}`);
  if (index === 1 && (JSON.stringify(inputs[0].run.counts) !== JSON.stringify(run.counts) || inputs[0].run.source?.workloadHash !== run.source?.workloadHash || JSON.stringify(inputs[0].run.runtimeFlags) !== JSON.stringify(run.runtimeFlags))) invalid.push("changed seed/driver/runtime");
  const values = {};
  for (const stream of streams) {
    const samples = run.streams?.[stream]?.observations;
    if (!Array.isArray(samples) || samples.length < 100 || samples.some(sample => !Number.isFinite(sample.ms) || sample.ms < 0 || !sample.longReaderActive || !sample.writerActive || typeof sample.completed !== "boolean" || typeof sample.timedOut !== "boolean" || sample.error !== null || sample.completed === sample.timedOut)) {
      invalid.push(`missing or invalid ${stream} samples`); continue;
    }
    values[stream] = { p99: quantile(samples.map(sample => sample.ms), .99), max: Math.max(...samples.map(sample => sample.ms)), completed: samples.filter(sample => sample.completed).length, censored: samples.filter(sample => sample.timedOut).length, count: samples.length };
  }
  if (!Array.isArray(run.telemetry) || run.telemetry.length === 0) invalid.push("missing SQL/auth telemetry");
  const requiredDiagnostics = index === 0 ? ["db.lock_wait_ms", "db.reader.hold_ms"] : ["db.lock_wait_ms", "db.reader.hold_ms", "db.reader.acquire_wait_ms", "db.statement.execution_ms"];
  for (const key of requiredDiagnostics) if (!(run.telemetry ?? []).some(span => Number.isFinite(span.attributes?.[key]))) invalid.push(`required emitted diagnostic absent: ${key}`);
  const failures = [];
  if (!invalid.length) for (const stream of streams) {
    const value = values[stream];
    const calibrate = index === 0 && ["threads", "nodePk"].includes(stream);
    if (calibrate && value.p99 <= 2000) failures.push(`${stream}: base did not reproduce p99>2s; no fix credit`);
    if (!calibrate && (value.p99 > 500 || value.max > 2000 || value.completed !== value.count)) failures.push(`${stream}: p99≤500ms / max≤2s / completed line missed`);
  }
  rows.push({ ...input, role: index === 0 ? "base" : "fix1365", values, invalid, failures, verdict: invalid.length ? "INVALID" : failures.length ? "FAIL" : "PASS" });
}
const verdict = rows.some(row => row.invalid.length) ? "INVALID" : rows.some(row => row.failures.length) ? "FAIL" : "PASS";
const lines = ["# Request latency: #1365", "", `Scenario verdict: **${verdict}**. This is a per-fix latency result, not a release verdict. No full overload candidate ran.`, "", "Line: PASS-LINE.md addition forwarded 13 Nov ~19:26Z. Base affected streams require p99>2s; credentials are guard streams on both revisions. Fix streams each require p99≤500ms and no sample>2s. All samples must occur while reader and writer are held. Censored values are lower bounds.", "", "| Revision | Stream | p99 ms (lower bound if censored) | Max ms (lower bound if censored) | Completed / samples | Censored | Verdict |", "|---|---|---:|---:|---:|---:|---|"];
for (const row of rows) {
  for (const [name,value] of Object.entries(row.values)) lines.push(`| ${row.role} ${row.run.revision} | ${name} | ${value.p99.toFixed(2)} | ${value.max.toFixed(2)} | ${value.completed}/${value.count} | ${value.censored} | ${row.verdict} |`);
  lines.push("", `## ${row.role}`, "", `Run ${row.run.offboxRunId}; log ${row.run.offboxLogPath}; result ${row.filename}`, "", ...[...row.invalid, ...row.failures].map(reason => `- ${row.verdict}: ${reason}`), "", "```json", JSON.stringify({ counts: row.run.counts, indexPresent: row.run.candidateIndexPresent, postSeedIndexEnsureMs: row.run.postSeedIndexEnsureMs, wholeMcp: row.run.streams?.wholeMcp, limitations: row.run.limitations }, null, 2), "```", "");
  const attrs = ["db.reader.acquire_wait_ms", "db.reader.hold_ms", "db.statement.execution_ms", "db.lock_wait_ms"];
  lines.push("| Telemetry | Samples | p99 ms | Max ms |", "|---|---:|---:|---:|");
  for (const attr of attrs) { const values = (row.run.telemetry ?? []).map(span => span.attributes?.[attr]).filter(Number.isFinite); lines.push(`| ${attr} | ${values.length} | ${values.length ? quantile(values,.99).toFixed(2) : row.role === "base" && ["db.reader.acquire_wait_ms", "db.statement.execution_ms"].includes(attr) ? "not emitted by this revision" : "unavailable"} | ${values.length ? Math.max(...values).toFixed(2) : "unavailable"} |`); }
  for (const spanName of ["McpSessionRegistry.resolve", "EnvironmentAuth.authenticateMcpClient", "McpHttpServer.authenticateRequest", "Latency.tool"]) { const values = (row.run.telemetry ?? []).filter(span => span.name===spanName).map(span => span.durationMs).filter(Number.isFinite); lines.push(`| ${spanName} | ${values.length} | ${values.length ? quantile(values,.99).toFixed(2) : "unavailable"} | ${values.length ? Math.max(...values).toFixed(2) : "unavailable"} |`); }
}
await NodeFSP.mkdir(output,{recursive:true});
await NodeFSP.writeFile(NodePath.join(output,"LATENCY-REPORT.md"),lines.join("\n")+"\n");
await NodeFSP.writeFile(NodePath.join(output,"latency-verdict.json"),JSON.stringify({ verdict, rows },null,2)+"\n");
process.stdout.write(`${verdict}: ${NodePath.join(output,"LATENCY-REPORT.md")}\n`);
process.exitCode = verdict === "PASS" ? 0 : 1;
