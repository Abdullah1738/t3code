import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

export const WINDOW_MS = 10 * 60_000;
export const SAMPLE_INTERVAL_MS = 30_000;
export const TAIL_BYTES = 2 * 1024 * 1024;
export const defaultLagPath = () =>
  NodePath.join(
    process.env.ROBOB_HOME ?? process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".robob"),
    "userdata/logs/event-loop-stalls.ndjson",
  );

// Include the writer's single rotation without exceeding the total read budget.
export async function readLagTail(file, io = NodeFSP) {
  let remaining = TAIL_BYTES;
  let bytesRead = 0;
  const parts = [];
  const identities = new Set();
  for (const name of [file, `${file}.1`]) {
    if (remaining === 0) break;
    let fd;
    try {
      fd = await io.open(name, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
      const stat = await fd.stat();
      if (!stat.isFile()) throw new Error("lag log is not a regular file");
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity))
        return { text: parts.join(""), bytesRead, error: "log rotated during read" };
      identities.add(identity);
      const size = Math.min(stat.size, remaining);
      const start = stat.size - size;
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const { bytesRead: n } = await fd.read(buffer, read, size - read, start + read);
        if (!n) break;
        read += n;
      }
      bytesRead += read;
      remaining -= size;
      let text = buffer.toString("utf8", 0, read);
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      // A concurrent append may leave an unfinished JSON record.
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      parts.push(text);
    } catch (error) {
      if (error.code !== "ENOENT" || name === file) {
        return { text: parts.join(""), bytesRead, error: safeFileError(error) };
      }
    } finally {
      if (fd !== undefined) await fd.close();
    }
  }
  return { text: parts.join(""), bytesRead, error: null };
}

export function summarizeLag(tail, now = Date.now()) {
  const samples = [];
  const rss = [];
  let malformed = false;
  for (const line of tail.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const time = Date.parse(row.time ?? row.at);
      if (!Number.isFinite(time) || time > now) {
        malformed = true;
        continue;
      }
      if (typeof row.rssMb === "number" && Number.isFinite(row.rssMb) && row.rssMb >= 0)
        rss.push({ time, value: row.rssMb });
      if (row.kind === "heap-spaces") continue;
      if (
        (row.kind !== "sample" || row.delayMaxMs !== undefined) &&
        !(
          typeof row.delayMaxMs === "number" &&
          Number.isFinite(row.delayMaxMs) &&
          row.delayMaxMs >= 0
        )
      ) {
        malformed = true;
        continue;
      }
      samples.push({ time, delay: row.delayMaxMs ?? 0 });
    } catch {
      malformed = true;
    }
  }
  samples.sort((a, b) => a.time - b.time);
  rss.sort((a, b) => a.time - b.time);
  const start = now - WINDOW_MS;
  const recent = samples.filter((row) => row.time >= start);
  const severe = recent.filter((row) => row.delay >= 5000);
  const worst = recent.reduce((a, b) => (b.delay > (a?.delay ?? 0) ? b : a), null);
  const latest = samples.at(-1);
  // Check both edges as well as internal gaps. Older stall-only logs cannot prove
  // quiet periods; after the heartbeat ships, ten minutes of samples can.
  const preceding = samples.findLast((row) => row.time < start);
  const times = [preceding?.time ?? start, ...recent.map((row) => row.time), now];
  const maxGapMs = Math.max(...times.slice(1).map((time, i) => time - times[i]));
  const reasons = [];
  if (tail.error) reasons.push(`lag log unavailable (${tail.error})`);
  if (malformed) reasons.push("invalid lag records");
  if (recent.length === 0) reasons.push("no samples in 10 min");
  if (maxGapMs > 2 * SAMPLE_INTERVAL_MS)
    reasons.push(`sample gap ${(maxGapMs / 1000).toFixed(0)}s (quiet or blocked)`);
  return {
    status: reasons.length ? "unknown" : "complete",
    reasons,
    sampleCount: recent.length,
    stalls1s: recent.filter((row) => row.delay >= 1000).length,
    stalls5s: severe.length,
    severeMinutes: new Set(severe.map((row) => Math.floor(row.time / 60_000))).size,
    worstMs: worst?.delay ?? 0,
    worstAt: worst ? new Date(worst.time).toISOString() : null,
    latestRssMb: rss.at(-1)?.value ?? null,
    secondsSinceLastRow: latest ? (now - latest.time) / 1000 : null,
    maxGapMs,
    bytesRead: tail.bytesRead,
  };
}

export function summarizeMainThread(tail, now = Date.now(), pid, bootId) {
  // A PID can be reused; only this server boot can identify its own blocked episodes.
  if (!validBootId(bootId)) return null;
  const episodes = new Map();
  for (const line of tail.text.split("\n")) {
    try {
      const row = JSON.parse(line);
      if (
        !["blocked", "unblocked"].includes(row.kind) ||
        !Number.isFinite(Date.parse(row.at)) ||
        Date.parse(row.at) > now ||
        typeof row.episode !== "string" ||
        !Number.isFinite(row.blockedForMs) ||
        row.blockedForMs < 0 ||
        row.pid !== pid ||
        row.bootId !== bootId
      )
        continue;
      const prior = episodes.get(row.episode);
      if (!prior || Date.parse(prior.at) < Date.parse(row.at)) episodes.set(row.episode, row);
    } catch {
      /* An unfinished or malformed line cannot identify a blocker. */
    }
  }
  const latest = [...episodes.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!latest || now - Date.parse(latest.at) > 15 * 60_000) return null;
  const ageMs = now - Date.parse(latest.at);
  const reportIntervalMs =
    Number.isFinite(latest.reportIntervalMs) && latest.reportIntervalMs > 0
      ? latest.reportIntervalMs
      : 30_000;
  // Missing recovery is not proof of a continuing block if the worker stopped writing.
  const recoveryUnconfirmed = latest.kind === "blocked" && ageMs > 2 * reportIntervalMs + 2000;
  const ongoing = latest.kind === "blocked" && !recoveryUnconfirmed;
  const safe = (value) =>
    typeof value === "string" && /^[\w.$ <>:/#@%+!~'()*-]{0,512}$/.test(value) ? value : "unknown";
  const calls = (Array.isArray(latest.inFlight) ? latest.inFlight : []).slice(0, 16);
  const tools = [
    ...new Set(
      calls.map((call) => `${safe(call.tool)}${call.boardId ? `(${safe(call.boardId)})` : ""}`),
    ),
  ];
  const frames = (Array.isArray(latest.frames) ? latest.frames : [])
    .slice(0, 3)
    .map(
      (frame) =>
        `${safe(frame.functionName)} (${safe(frame.url)}:${Number.isInteger(frame.lineNumber) ? frame.lineNumber : 0})`,
    );
  const durationMs = latest.blockedForMs + (ongoing ? ageMs : 0);
  return {
    ongoing,
    recoveryUnconfirmed,
    durationMs,
    tools,
    frames,
    summary: `main thread blocked ${(durationMs / 1000).toFixed(0)}s by ${tools.join(", ") || "unknown handler"}${frames.length ? `; ${frames.join(" → ")}` : ""}${recoveryUnconfirmed ? `; last observed ${(ageMs / 1000).toFixed(0)}s ago, recovery unconfirmed` : ""}`,
  };
}

export function healthVerdict(lag, connection, roundTrip) {
  if (roundTrip.status === "timeout" || connection.status === "timeout" || lag.stalls5s >= 3)
    return { verdict: "stalled", exitCode: 2 };
  if (
    connection.status !== "ok" ||
    !["healthy", "degraded"].includes(connection.readiness) ||
    roundTrip.status !== "ok" ||
    lag.status === "unknown"
  )
    return { verdict: "unknown", exitCode: 1 };
  if (lag.stalls5s > 0 || roundTrip.ms >= 2000 || connection.readiness === "degraded")
    return { verdict: "degraded", exitCode: 1 };
  return { verdict: "healthy", exitCode: 0 };
}

export function healthLine(report) {
  const { lag, roundTrip } = report;
  const blocked = report.mainThread ? `; ${report.mainThread.summary}` : "";
  const worst = lag.worstAt ? `, worst ${(lag.worstMs / 1000).toFixed(1)}s at ${lag.worstAt}` : "";
  const trip =
    roundTrip.status === "ok" ? `${(roundTrip.ms / 1000).toFixed(2)}s` : roundTrip.status;
  const rss = lag.latestRssMb === null ? "unknown" : `${(lag.latestRssMb / 1024).toFixed(2)} GB`;
  const unknown = lag.status === "unknown" ? `; lag unknown: ${lag.reasons.join(", ")}` : "";
  const connection =
    report.connection.status !== "ok"
      ? `; connection ${report.connection.status}`
      : report.connection.readiness !== "healthy"
        ? `; readiness ${report.connection.readiness ?? "unavailable"}`
        : "";
  return `${report.verdict}: ${lag.stalls1s} stalls >=1s in 10 min (${lag.stalls5s} >=5s)${worst}; round trip ${trip}; rss ${rss}${unknown}${connection}${blocked}`;
}

function safeFileError(error) {
  return ["ENOENT", "EACCES", "EPERM", "EIO"].includes(error?.code) ? error.code : "read failed";
}

function safeFailure(error) {
  const fields = {};
  // fetch wraps socket errors in cause; bound traversal even for cyclic causes.
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (fields.code === undefined) {
      if (
        typeof error.code === "string" &&
        (Object.hasOwn(NodeOS.constants.errno, error.code) ||
          [
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            "ERR_INVALID_ARG_TYPE",
            "ERR_OUT_OF_RANGE",
          ].includes(error.code))
      )
        fields.code = error.code;
      else if (Number.isInteger(error.code) && error.code > 0 && error.code <= 255)
        fields.code = error.code;
    }
    // spawn errors can append the executable's full path to the syscall.
    const syscall = typeof error.syscall === "string" ? error.syscall.split(" ")[0] : null;
    if (
      fields.syscall === undefined &&
      [
        "open",
        "read",
        "stat",
        "fstat",
        "close",
        "kill",
        "spawn",
        "connect",
        "getaddrinfo",
      ].includes(syscall)
    )
      fields.syscall = syscall;
    if (
      fields.path === undefined &&
      typeof error.path === "string" &&
      !error.path.includes("://")
    ) {
      const basename = NodePath.win32.basename(NodePath.basename(error.path.split(/[?#]/)[0]));
      if (/^[\w.-]{1,255}$/.test(basename) && ![".", ".."].includes(basename))
        fields.path = basename;
    }
  }
  return fields;
}

export async function readRuntimeState(file) {
  const fd = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > 8192) return null;
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    try {
      return JSON.parse(buffer.toString("utf8", 0, bytesRead));
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  } finally {
    await fd.close();
  }
}

export async function ownsListener(
  { pid, port, signal, timeoutMs = 1000 },
  run = NodeChildProcess.execFile,
) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535)
    return false;
  const output = await new Promise((resolve, reject) => {
    let child;
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child?.kill("SIGKILL");
      // A kernel-stuck child may never emit close, even after SIGKILL.
      child?.unref();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      reject(new DOMException("Listener deadline", "TimeoutError"));
    };
    if (signal?.aborted) return abort();
    timer = setTimeout(abort, Math.min(timeoutMs, 1000));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = run(
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node CLI probe; no Effect runtime.
        process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
        { encoding: "utf8", maxBuffer: 64 * 1024, killSignal: "SIGKILL" },
        (error, stdout) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(stdout);
        },
      );
      child?.stdin?.destroy();
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });
  const owners = new Set(output.split("\n").filter((line) => /^p\d+$/.test(line)));
  // Check both address families: another owner could be a loopback tunnel.
  return owners.size === 1 && owners.has(`p${pid}`);
}

async function matchesLocalRuntime(url, connection, runtime, checkListener, stages) {
  const result = (reason, stage = "runtime", code = stages[stage]?.code ?? null) => ({
    ok: reason === null,
    reason,
    stage,
    code,
  });
  if (stages.runtime.status === "skipped") return result("deadline-exhausted");
  if (stages.runtime.status !== "ok")
    return result(stages.runtime.status === "timeout" ? "runtime-timeout" : "runtime-unreadable");
  if (!runtime || typeof runtime !== "object") return result("runtime-invalid");
  let target;
  let expected;
  try {
    target = new URL(url);
    expected = new URL(runtime.origin);
  } catch {
    return result("runtime-invalid");
  }
  const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!loopback(target.hostname) || !loopback(expected.hostname)) return result("non-loopback");
  if (
    !["http:", "https:"].includes(expected.protocol) ||
    target.protocol !== expected.protocol ||
    target.port !== expected.port ||
    target.pathname !== "/" ||
    target.search
  )
    return result("origin-mismatch");
  const recorded = typeof runtime.startedAt === "string" ? Date.parse(runtime.startedAt) : NaN;
  if (!Number.isFinite(recorded) || !Number.isInteger(runtime.pid) || runtime.pid <= 0)
    return result("runtime-invalid");
  try {
    process.kill(runtime.pid, 0);
  } catch (error) {
    return result(
      error?.code === "ESRCH" ? "pid-mismatch" : "pid-unverified",
      "runtime",
      safeFailure(error).code ?? null,
    );
  }
  // Route initialization and ready-time publication can be minutes apart.
  if (
    connection.status === "ok" &&
    connection.bootId !== undefined &&
    runtime.bootId !== undefined
  ) {
    if (!validBootId(runtime.bootId)) return result("runtime-invalid");
    return result(connection.bootId === runtime.bootId ? null : "bootid-mismatch");
  }
  // Older or blocked servers cannot identify their boot over HTTP. Confirm
  // the persisted process owns the listener within the same deadline instead.
  const port = Number(expected.port || (expected.protocol === "https:" ? 443 : 80));
  const owned = await checkListener({ pid: runtime.pid, port });
  const status = stages.listener.status;
  if (status !== "ok")
    return result(
      status === "timeout"
        ? "listener-timeout"
        : status === "error"
          ? "listener-error"
          : "deadline-exhausted",
      "listener",
    );
  return result(owned === true ? null : "listener-not-owner", "listener");
}

const validBootId = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export const deepHealthBudget = (timeoutMs = 10_000) => Math.max(1, Math.min(timeoutMs, 10_000));

export async function deepHealth({
  client,
  logPath = defaultLagPath(),
  timeoutMs,
  readTail = readLagTail,
  readRuntime = readRuntimeState,
  checkListener = ownsListener,
  onStage = () => {},
}) {
  const budget = deepHealthBudget(timeoutMs);
  const deadline = performance.now() + budget;
  // Leave a small part of the same budget for local evidence during an HTTP stall.
  const probeBudget = budget - Math.min(2000, budget / 5);
  const stages = Object.fromEntries(
    ["connection", "roundTrip", "runtime", "listener", "lagTail", "mainThreadTail"].map((name) => [
      name,
      { status: "skipped", ms: 0 },
    ]),
  );
  const controllers = [];
  let expired = false;
  const stage = async (name, run, fallback, capMs = Infinity) => {
    const start = performance.now();
    const remaining = Math.ceil(deadline - start);
    if (expired || remaining <= 0) return fallback;
    const limit = Math.min(remaining, Math.ceil(capMs));
    onStage(name);
    const controller = new AbortController();
    controllers.push(controller);
    let timer;
    let status = "ok";
    let failure = {};
    try {
      return await Promise.race([
        Promise.resolve().then(() => run({ signal: controller.signal, timeoutMs: limit })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (limit === remaining) expired = true;
            // Reject before abort listeners run, preserving the timeout classification.
            reject(new DOMException("Stage deadline", "TimeoutError"));
            controller.abort();
          }, limit);
        }),
      ]);
    } catch (error) {
      // Never include server bodies, credentials or arbitrary I/O error messages.
      status = error?.name === "TimeoutError" ? "timeout" : "error";
      failure = { ...safeFailure(error), ...(status === "timeout" ? { code: "ETIMEDOUT" } : {}) };
      return fallback;
    } finally {
      clearTimeout(timer);
      stages[name] = { status, ms: Math.round(performance.now() - start), ...failure };
    }
  };
  const probe = async (name, route, valid) => {
    const response = await stage(
      name,
      async (options) => {
        const result = await client.request("GET", route, undefined, options);
        if (!valid(result)) throw new Error("invalid response");
        return result;
      },
      null,
      probeBudget,
    );
    return {
      ...stages[name],
      ...(response && route === "/health"
        ? {
            readiness: ["healthy", "degraded", "recovered-unverified"].includes(response.status)
              ? response.status
              : undefined,
            serverStartedAt: Number.isFinite(Date.parse(response.serverStartedAt))
              ? new Date(response.serverStartedAt).toISOString()
              : undefined,
            bootId: validBootId(response.bootId) ? response.bootId : undefined,
          }
        : {}),
    };
  };
  // TODO(#1124): use authenticated readiness once it proves state AND board reads.
  const stateRoute = `/threads?limit=1&updatedSince=${Date.now() - 60_000}`;
  const [connection, roundTrip] = await Promise.all([
    probe("connection", "/health", (response) => response?.ok === true),
    probe("roundTrip", stateRoute, (response) => Array.isArray(response?.threads)),
  ]);
  // Read after the probes so a response cannot hide a newly opened sampler gap.
  const runtime = await stage(
    "runtime",
    () => readRuntime(NodePath.join(NodePath.dirname(logPath), "..", "server-runtime.json")),
    null,
  );
  const localIdentity = await matchesLocalRuntime(
    client.url,
    connection,
    runtime,
    (identity) => stage("listener", (options) => checkListener({ ...identity, ...options }), false),
    stages,
  );
  const tail = localIdentity.ok
    ? await stage("lagTail", () => readTail(logPath), {
        text: "",
        bytesRead: 0,
        error: "lagTail unavailable",
      })
    : {
        text: "",
        bytesRead: 0,
        error: `local runtime identity unverified (${localIdentity.reason}${localIdentity.code ? ` ${localIdentity.code}` : ""}) at ${localIdentity.stage}`,
      };
  const blockedTail = localIdentity.ok
    ? await stage(
        "mainThreadTail",
        () => readTail(NodePath.join(NodePath.dirname(logPath), "main-thread-blocked.ndjson")),
        { text: "", bytesRead: 0 },
      )
    : { text: "", bytesRead: 0 };
  for (const controller of controllers) controller.abort();
  const now = Date.now();
  const lag = summarizeLag(tail, now);
  const mainThread = summarizeMainThread(blockedTail, now, runtime?.pid, runtime?.bootId);
  const timedOut = Object.keys(stages).filter((name) => stages[name].status === "timeout");
  const report = {
    at: new Date(now).toISOString(),
    connection,
    lag,
    localIdentity,
    mainThread,
    roundTrip,
    stages,
    ...healthVerdict(lag, connection, roundTrip),
    ...(mainThread?.ongoing ? { verdict: "stalled", exitCode: 2 } : {}),
    ...(timedOut.length ? { status: "timeout", stage: timedOut[0], exitCode: 2 } : {}),
  };
  return {
    ...report,
    summary: healthLine(report) + (timedOut.length ? `; timed out: ${timedOut.join(", ")}` : ""),
  };
}
