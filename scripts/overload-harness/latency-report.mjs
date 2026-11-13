import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
const relativeMode = process.argv.includes("--relative-r11");
const [output, basePath, fixPath] = process.argv.slice(2).filter((arg) => arg !== "--relative-r11");
if (!output || !basePath || !fixPath)
  throw new Error("Usage: latency-report.mjs OUTPUT BASE_JSON FIX1365_JSON");
try {
  const inputs = await Promise.all(
    [basePath, fixPath].map(async (filename) => ({
      filename,
      run: JSON.parse(await NodeFSP.readFile(filename, "utf8")),
    })),
  );
  const streams = ["threads", "nodePk", "providerCredential", "clientCredential"];
  const quantile = (values, q) =>
    [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
  const rows = [];
  for (const [index, input] of inputs.entries()) {
    const invalid = [];
    if (
      typeof input.run.node !== "string" ||
      typeof input.run.cpu !== "string" ||
      !Number.isInteger(input.run.samples) ||
      input.run.samples < 100 ||
      !Array.isArray(input.run.runtimeFlags) ||
      !input.run.runtimeFlags.every((flag) => typeof flag === "string") ||
      !input.run.counts ||
      ["threads", "runs", "nodes"].some(
        (key) => !Number.isInteger(input.run.counts[key]) || input.run.counts[key] <= 0,
      )
    )
      invalid.push("missing runtime/seed provenance");
    if (
      !Number.isFinite(Date.parse(input.run.startedAt)) ||
      !Number.isFinite(Date.parse(input.run.completedAt)) ||
      !/^[a-f0-9]{64}$/.test(input.run.source?.workloadHash ?? "") ||
      input.run.source?.productRevision !== input.run.revision
    )
      invalid.push("missing window/source provenance");
    const run = input.run;
    if (
      run.scenario !== "request-latency-1365" ||
      !/^[a-f0-9]{40}$/.test(run.revision ?? "") ||
      !run.offboxRunId ||
      !run.offboxLogPath ||
      !run.source?.workloadHash
    )
      invalid.push("missing run/source provenance");
    if (index === 0 && run.revision !== "dbc99fc3a4b817977bc23a57ea7c049da5d45190")
      invalid.push("base must be .9");
    if (relativeMode && index === 1 && run.revision !== "aeb6617ef8219665cf7ce2e89f834a8abb801a05")
      invalid.push("candidate must be exact R11");
    if (index === 1 && run.candidateIndexPresent !== true)
      invalid.push("startup candidates index missing");
    if (run.archiveExit !== "Success") invalid.push("archive snapshot did not complete");
    if (index === 1)
      for (const key of ["node", "cpu", "samples"])
        if (inputs[0].run[key] !== run[key]) invalid.push(`changed ${key}`);
    if (
      index === 1 &&
      (JSON.stringify(inputs[0].run.counts) !== JSON.stringify(run.counts) ||
        inputs[0].run.source?.workloadHash !== run.source?.workloadHash ||
        JSON.stringify(inputs[0].run.runtimeFlags) !== JSON.stringify(run.runtimeFlags))
    )
      invalid.push("changed seed/driver/runtime");
    const values = {};
    for (const stream of streams) {
      const samples = run.streams?.[stream]?.observations;
      if (
        !Array.isArray(samples) ||
        samples.length < 100 ||
        samples.some(
          (sample) =>
            !Number.isFinite(sample.ms) ||
            sample.ms < 0 ||
            !sample.longReaderActive ||
            !sample.writerActive ||
            typeof sample.completed !== "boolean" ||
            typeof sample.timedOut !== "boolean" ||
            sample.error !== null ||
            sample.completed === sample.timedOut,
        )
      ) {
        invalid.push(`missing or invalid ${stream} samples`);
        continue;
      }
      values[stream] = {
        p99: quantile(
          samples.map((sample) => sample.ms),
          0.99,
        ),
        max: Math.max(...samples.map((sample) => sample.ms)),
        completed: samples.filter((sample) => sample.completed).length,
        censored: samples.filter((sample) => sample.timedOut).length,
        count: samples.length,
      };
    }
    if (!Array.isArray(run.telemetry) || run.telemetry.length === 0)
      invalid.push("missing SQL/auth telemetry");
    const requiredDiagnostics =
      index === 0
        ? ["db.lock_wait_ms", "db.reader.hold_ms"]
        : [
            "db.lock_wait_ms",
            "db.reader.hold_ms",
            "db.reader.acquire_wait_ms",
            "db.statement.execution_ms",
          ];
    for (const key of requiredDiagnostics)
      if (!(run.telemetry ?? []).some((span) => Number.isFinite(span.attributes?.[key])))
        invalid.push(`required emitted diagnostic absent: ${key}`);
    const failures = [];
    const notes = [];
    if (!invalid.length)
      for (const stream of streams) {
        const value = values[stream];
        const calibrate = index === 0 && ["threads", "nodePk"].includes(stream);
        if (calibrate && value.p99 <= 2000)
          (relativeMode ? notes : failures).push(
            `${stream}: base did not reproduce p99>2s; fidelity note, no fix credit`,
          );
        if (!calibrate && (value.p99 > 500 || value.max > 2000 || value.completed !== value.count))
          failures.push(`${stream}: p99≤500ms / max≤2s / completed line missed`);
      }
    rows.push({
      ...input,
      role: index === 0 ? "base" : "fix1365",
      values,
      invalid,
      failures,
      notes,
      verdict: invalid.length ? "INVALID" : failures.length ? "FAIL" : "PASS",
    });
  }
  const verdict = rows.some((row) => row.invalid.length)
    ? "INVALID"
    : rows.some((row) => row.failures.length)
      ? "FAIL"
      : "PASS";
  const lines = [
    "# Request latency: #1365",
    "",
    `Scenario verdict: **${verdict}**. ${relativeMode ? "R11 relative release gate, with the candidate absolute latency line." : "Per-fix latency scenario."}`,
    "",
    relativeMode
      ? "Line: the21:12Z amendment makes base affected-stream p99>2s a fidelity note. Credentials remain guard streams on both revisions. Candidate streams each require p99≤500ms and no sample>2s. All samples must occur while reader and writer are held. Censored values are lower bounds."
      : "Line: PASS-LINE.md addition forwarded 13 Nov ~19:26Z. Base affected streams require p99>2s; credentials are guard streams on both revisions. Fix streams each require p99≤500ms and no sample>2s. All samples must occur while reader and writer are held. Censored values are lower bounds.",
    "",
  ];
  for (const row of rows) {
    lines.push(
      `## ${row.role}`,
      "",
      ...row.notes.map((note) => `Fidelity note: ${note}`),
      "",
      "| Revision | Stream | p99 ms (lower bound if censored) | Max ms (lower bound if censored) | Completed / samples | Censored | Verdict |",
      "|---|---|---:|---:|---:|---:|---|",
    );
    for (const [name, value] of Object.entries(row.values))
      lines.push(
        `| ${row.role} ${row.run.revision} | ${name} | ${value.p99.toFixed(2)} | ${value.max.toFixed(2)} | ${value.completed}/${value.count} | ${value.censored} | ${row.verdict} |`,
      );
    lines.push(
      "",
      `Run ${row.run.offboxRunId}; log ${row.run.offboxLogPath}; result ${row.filename}`,
      "",
      ...[...row.invalid, ...row.failures].map((reason) => `- ${row.verdict}: ${reason}`),
      "",
      "```json",
      JSON.stringify(
        {
          counts: row.run.counts,
          indexPresent: row.run.candidateIndexPresent,
          postSeedIndexEnsureMs: row.run.postSeedIndexEnsureMs,
          wholeMcp: row.run.streams?.wholeMcp,
          limitations: row.run.limitations,
        },
        null,
        2,
      ),
      "```",
      "",
    );
    const attrs = [
      "db.reader.acquire_wait_ms",
      "db.reader.hold_ms",
      "db.statement.execution_ms",
      "db.lock_wait_ms",
    ];
    lines.push("| Telemetry | Samples | p99 ms | Max ms |", "|---|---:|---:|---:|");
    for (const attr of attrs) {
      const values = (row.run.telemetry ?? [])
        .map((span) => span.attributes?.[attr])
        .filter(Number.isFinite);
      lines.push(
        `| ${attr} | ${values.length} | ${values.length ? quantile(values, 0.99).toFixed(2) : row.role === "base" && ["db.reader.acquire_wait_ms", "db.statement.execution_ms"].includes(attr) ? "not emitted by this revision" : "unavailable"} | ${values.length ? Math.max(...values).toFixed(2) : "unavailable"} |`,
      );
    }
    for (const spanName of [
      "McpSessionRegistry.resolve",
      "EnvironmentAuth.authenticateMcpClient",
      "McpHttpServer.authenticateRequest",
      "Latency.tool",
    ]) {
      const values = (row.run.telemetry ?? [])
        .filter((span) => span.name === spanName)
        .map((span) => span.durationMs)
        .filter(Number.isFinite);
      lines.push(
        `| ${spanName} | ${values.length} | ${values.length ? quantile(values, 0.99).toFixed(2) : "unavailable"} | ${values.length ? Math.max(...values).toFixed(2) : "unavailable"} |`,
      );
    }
  }
  await NodeFSP.mkdir(output, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(output, "LATENCY-REPORT.md"), lines.join("\n") + "\n");
  await NodeFSP.writeFile(
    NodePath.join(output, "latency-verdict.json"),
    JSON.stringify({ verdict, rows }, null, 2) + "\n",
  );
  process.stdout.write(`${verdict}: ${NodePath.join(output, "LATENCY-REPORT.md")}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
} catch (error) {
  const reason = String(error);
  await NodeFSP.mkdir(output, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(output, "latency-verdict.json"),
    JSON.stringify({ verdict: "INVALID", rows: [], invalid: [reason] }, null, 2) + "\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(output, "LATENCY-REPORT.md"),
    `# Request latency: #1365\n\nVerdict: **INVALID**.\n\n${reason}\n`,
  );
  process.exitCode = 1;
}
