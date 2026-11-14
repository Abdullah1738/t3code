import * as NodeFS from "node:fs";
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
export function readLagTail(file, io = NodeFS) {
  let remaining = TAIL_BYTES;
  let bytesRead = 0;
  const parts = [];
  const identities = new Set();
  for (const name of [file, `${file}.1`]) {
    if (remaining === 0) break;
    let fd;
    try {
      fd = io.openSync(name, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
      const stat = io.fstatSync(fd);
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
        const n = io.readSync(fd, buffer, read, size - read, start + read);
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
        return { text: parts.join(""), bytesRead, error: error.code ?? error.message };
      }
    } finally {
      if (fd !== undefined) io.closeSync(fd);
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
  return `${report.verdict}: ${lag.stalls1s} stalls >=1s in 10 min (${lag.stalls5s} >=5s)${worst}; round trip ${trip}; rss ${rss}${unknown}${connection}`;
}

export function readRuntimeState(file) {
  let fd;
  try {
    fd = NodeFS.openSync(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) return null;
    const buffer = Buffer.alloc(8192);
    const size = NodeFS.readSync(fd, buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.toString("utf8", 0, size));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) NodeFS.closeSync(fd);
  }
}

export function ownsListener({ pid, port }, run = NodeChildProcess.execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535)
    return false;
  try {
    const output = run(
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node CLI probe; no Effect runtime.
      process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const owners = new Set(output.split("\n").filter((line) => /^p\d+$/.test(line)));
    // Check all listeners on the port, including both address families. A
    // second owner could be a tunnel that receives the loopback request.
    return owners.size === 1 && owners.has(`p${pid}`);
  } catch {
    return false;
  }
}

function matchesLocalRuntime(url, connection, runtime, checkListener) {
  try {
    const target = new URL(url);
    const expected = new URL(runtime.origin);
    const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (
      !["http:", "https:"].includes(expected.protocol) ||
      !loopback(target.hostname) ||
      !loopback(expected.hostname) ||
      target.protocol !== expected.protocol ||
      target.port !== expected.port ||
      target.pathname !== "/" ||
      target.search
    )
      return false;
    const recorded = Date.parse(runtime.startedAt);
    if (!Number.isFinite(recorded) || !Number.isInteger(runtime.pid) || runtime.pid <= 0)
      return false;
    process.kill(runtime.pid, 0);
    // HTTP cannot identify its boot while blocked. Preserve local evidence only
    // when the OS independently confirms the persisted process owns the listener.
    if (connection.status !== "ok") {
      const port = Number(expected.port || (expected.protocol === "https:" ? 443 : 80));
      return checkListener({ pid: runtime.pid, port });
    }
    const started = Date.parse(connection.serverStartedAt);
    return Number.isFinite(started) && Math.abs(started - recorded) <= 60_000;
  } catch {
    return false;
  }
}

export async function deepHealth({
  client,
  logPath = defaultLagPath(),
  timeoutMs = 10_000,
  readTail = readLagTail,
  readRuntime = readRuntimeState,
  checkListener = ownsListener,
}) {
  const controller = new AbortController();
  const deadline = Math.min(timeoutMs, 10_000);
  const probe = async (route, valid) => {
    const start = performance.now();
    let timer;
    try {
      const response = await Promise.race([
        client.request("GET", route, undefined, { signal: controller.signal, timeoutMs: deadline }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, deadline);
        }),
      ]);
      if (!valid(response)) throw new Error("invalid response");
      return {
        status: "ok",
        ms: Math.round(performance.now() - start),
        ...(route === "/health"
          ? { readiness: response.status, serverStartedAt: response.serverStartedAt }
          : {}),
      };
    } catch (error) {
      // Keep server bodies and credentials out of the health output.
      return {
        status: controller.signal.aborted || error.name === "TimeoutError" ? "timeout" : "error",
        ms: Math.round(performance.now() - start),
      };
    } finally {
      clearTimeout(timer);
    }
  };
  // TODO(#1124): use authenticated readiness once it proves state AND board reads.
  // Use an indexed recent range for the authenticated state probe.
  const stateRoute = `/threads?limit=1&updatedSince=${Date.now() - 60_000}`;
  const [connection, roundTrip] = await Promise.all([
    probe("/health", (response) => response?.ok === true),
    probe(stateRoute, (response) => Array.isArray(response?.threads)),
  ]);
  // Read after the probes: a response must not hide a gap that opened while waiting.
  // Bind local evidence to the persisted listener and this server boot, rather
  // than trusting arbitrary loopback ports (including tunnels and dev servers).
  const runtime = readRuntime(
    NodePath.join(NodePath.dirname(logPath), "..", "server-runtime.json"),
  );
  const local = matchesLocalRuntime(client.url, connection, runtime, checkListener);
  const tail = local
    ? readTail(logPath)
    : { text: "", bytesRead: 0, error: "local runtime identity unverified" };
  const now = Date.now();
  const lag = summarizeLag(tail, now);
  const report = {
    at: new Date(now).toISOString(),
    connection,
    lag,
    roundTrip,
    ...healthVerdict(lag, connection, roundTrip),
  };
  return { ...report, summary: healthLine(report) };
}
