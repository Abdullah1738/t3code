import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

const replaceOnce = (source, needle, replacement) => {
  if (source.split(needle).length !== 2)
    throw new Error(`Paired measurement hook no longer matches: ${needle}`);
  return source.replace(needle, replacement);
};

// These hooks add observation at the original boundaries; the frozen seed and
// driver remain byte-identical on disk, and no SQL or provider work is added.
export const instrumentHarness = (source) => {
  const databasePaths =
    '{ statev2: cfg.dbPath, boards: NodePath.join(NodePath.dirname(cfg.dbPath), "boards.sqlite") }';
  source = replaceOnce(
    source,
    "const before = NodePerfHooks.performance.eventLoopUtilization();",
    `globalThis.__overloadMeasurement.filesystems(${databasePaths}, "start");\n      globalThis.__overloadMeasurement.resources("start");\n      const before = NodePerfHooks.performance.eventLoopUtilization();`,
  );
  source = replaceOnce(
    source,
    'import * as SqlClient from "effect/sql/SqlClient";',
    'import * as SqlClient from "effect/sql/SqlClient";\nimport * as Statement from "effect/sql/Statement";',
  );
  source = replaceOnce(
    source,
    "const warnings = Logger.make(({ logLevel }) => {",
    "const warnings = Logger.make((options) => {\n  const { logLevel } = options;\n  globalThis.__overloadMeasurement.warning(options, measuring);",
  );
  source = replaceOnce(
    source,
    "measuring = true;",
    "measuring = true;\n      globalThis.__overloadMeasurement.start(started);",
  );
  source = replaceOnce(
    source,
    "const current = NodePerfHooks.performance.now();",
    "const current = NodePerfHooks.performance.now();\n        globalThis.__overloadMeasurement.interval(current);",
  );
  source = replaceOnce(
    source,
    "measuring = false;\n      lag.disable();",
    `measuring = false;\n      globalThis.__overloadMeasurement.stop(gcWindowEnd);\n      lag.disable();\n      globalThis.__overloadMeasurement.resources("end");\n      globalThis.__overloadMeasurement.filesystems(${databasePaths}, "end");`,
  );
  source = replaceOnce(
    source,
    'yield* Effect.tryPromise(() => session.post("Profiler.start"));',
    'yield* Effect.tryPromise(() => session.post("Profiler.start"));\n          globalThis.__overloadMeasurement.mark("profileStart");',
  );
  source = replaceOnce(
    source,
    'const profile = yield* Effect.tryPromise(() => session.post("Profiler.stop"));',
    'const profile = yield* Effect.tryPromise(() => session.post("Profiler.stop"));\n          globalThis.__overloadMeasurement.mark("profileEnd");',
  );
  source = replaceOnce(
    source,
    "telemetrySchemaVersion: 2,",
    "telemetrySchemaVersion: 2,\n        pairedMeasurement: globalThis.__overloadMeasurement.snapshot(),",
  );
  source = replaceOnce(
    source,
    "Effect.withTracer(trace)),",
    "Effect.withTracer(trace), Effect.provideService(Statement.SpanPropagationEnabled, true)),",
  );
  return source;
};

export const instrumentSqlite = (source) => {
  source = replaceOnce(
    source,
    "return statement.all(...(params as any));",
    'return globalThis.__overloadMeasurement.native(statement.sourceSQL, "all", Context.getOrUndefined(fiber.context, Tracer.ParentSpan), () => statement.all(...(params as any)));',
  );
  source = replaceOnce(
    source,
    "const result = statement.run(...(params as any));",
    'const result = globalThis.__overloadMeasurement.native(statement.sourceSQL, "run", Context.getOrUndefined(fiber.context, Tracer.ParentSpan), () => statement.run(...(params as any)));',
  );
  const begin = source.indexOf(
    'parentPort.on("message", ({ id, sql, params, cached, values, raw, safeIntegers }) => {',
  );
  const end = source.indexOf("\n});\n`;", begin);
  if (begin < 0 || end < 0) throw new Error("Reader measurement hook no longer matches");
  const body = source.slice(begin, end);
  const marker = '  let operation = "open";';
  const at = body.indexOf(marker);
  if (at < 0) throw new Error("Reader execution boundary missing");
  const prefix = body.slice(0, at + marker.length);
  const suffix = body
    .slice(at + marker.length)
    .replaceAll("parentPort.postMessage(", "__overloadReply(");
  source =
    source.slice(0, begin) +
    prefix +
    "\n  const __overloadReaderStart = performance.now();\n  const __overloadReply = (reply) => parentPort.postMessage({ ...reply, overloadExecutionMs: performance.now() - __overloadReaderStart });" +
    suffix +
    source.slice(end);
  source = replaceOnce(
    source,
    "          const entry: {",
    "          const __overloadOffered = globalThis.__overloadMeasurement.capture();\n          const entry: {",
  );
  source = replaceOnce(
    source,
    "            resume: (reply) => {",
    "            resume: (reply) => {\n              globalThis.__overloadMeasurement.reader(input.sql, Context.getOrUndefined(fiber.context, Tracer.ParentSpan), reply.overloadExecutionMs, __overloadOffered, reply);",
  );
  source = replaceOnce(
    source,
    "request.resume({ id, rows: [] });",
    'request.resume({ id, rows: [], overloadSynthetic: "transaction-cleanup" });',
  );
  source = replaceOnce(
    source,
    'error: { operation: "execute", message, ...(started ? {} : { notStarted: true }) },',
    'overloadSynthetic: started ? "worker-retired-after-start" : "requeue-before-start",\n          error: { operation: "execute", message, ...(started ? {} : { notStarted: true }) },',
  );
  return source;
};

export const makeMeasurement = ({ now, wallNow, elu, filesystemSnapshot, resourceSnapshot }) => {
  let active = false;
  let origin = 0;
  let epoch = 0;
  let lastInterval = 0;
  let firstElu;
  const statements = new Map();
  const ids = new Map();
  const warnings = [];
  const intervals = [];
  const hooks = [];
  const marks = [];
  const nonExecutionReplies = [];
  const filesystems = [];
  const resources = [];
  const caller = (span) => {
    const names = [];
    for (let depth = 0; span?._tag === "Span" && depth < 32; depth++) {
      if (!/^(?:sql\.|sqlite$)/.test(span.name)) {
        const operation = span.attributes.get("kanban.operation");
        names.push(span.name + (typeof operation === "string" ? `:${operation}` : ""));
      }
      span = span.parent?._tag === "Some" ? span.parent.value : undefined;
    }
    return names.join(" > ") || "unattributed";
  };
  const record = (sql, method, span, durationMs, success, offered) => {
    if (!active || !offered?.active) return;
    let id = ids.get(sql);
    if (!id) {
      id = NodeCrypto.createHash("sha256").update(sql).digest("hex");
      ids.set(sql, id);
    }
    const path = caller(span);
    const key = `${method}|${id}|${path}`;
    let row = statements.get(key);
    if (!row) {
      row = { id, sql, method, caller: path, samples: [] };
      statements.set(key, row);
    }
    row.samples.push({ seconds: offered.seconds, durationMs, success });
  };
  const api = {
    resources(boundary) {
      const beforeEpochMs = wallNow();
      const data = resourceSnapshot();
      resources.push({ boundary, beforeEpochMs, afterEpochMs: wallNow(), data });
    },
    filesystems(paths, boundary) {
      const beforeEpochMs = wallNow();
      const files = filesystemSnapshot(paths);
      filesystems.push({ boundary, beforeEpochMs, afterEpochMs: wallNow(), files });
    },
    hook(kind, source, instrumented) {
      const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
      hooks.push({ kind, sourceHash: hash(source), instrumentedHash: hash(instrumented) });
    },
    mark(name) {
      marks.push({ name, seconds: (now() - origin) / 1000, epochMs: wallNow() });
    },
    start(at) {
      origin = at;
      epoch = wallNow();
      firstElu = elu();
      active = true;
      api.interval(at, true);
    },
    capture: () => ({ active, seconds: (now() - origin) / 1000 }),
    native(sql, method, span, invoke) {
      if (!active) return invoke();
      const offered = api.capture();
      const before = now();
      let success = false;
      try {
        const value = invoke();
        success = true;
        return value;
      } finally {
        record(sql, `main:${method}`, span, now() - before, success, offered);
      }
    },
    reader(sql, span, durationMs, offered, reply) {
      if (!active || !offered?.active) return;
      if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
        record(sql, "worker:prepare+execute", span, durationMs, "rows" in reply, offered);
        return;
      }
      const reason =
        reply.overloadSynthetic ??
        (reply.error?.notStarted === true
          ? "cancelled-before-start"
          : "missing-worker-execution-timing");
      nonExecutionReplies.push({ sql, caller: caller(span), seconds: offered.seconds, reason });
    },
    warning(options, steady) {
      if (options.logLevel !== "Warn" && options.logLevel !== "Error") return;
      warnings.push({
        level: options.logLevel,
        steady,
        wallTime: new Date(wallNow()).toISOString(),
        seconds: active ? (now() - origin) / 1000 : null,
        text: NodeUtil.inspect(options.message, { depth: 5, breakLength: Infinity }),
        cause:
          options.cause === undefined
            ? null
            : NodeUtil.inspect(options.cause, { depth: 5, breakLength: Infinity }),
      });
    },
    interval(at, force = false) {
      if (!active || (!force && at - lastInterval < 1000)) return;
      const value = elu();
      intervals.push({
        seconds: (at - origin) / 1000,
        epochMs: wallNow(),
        activeMs: value.active - firstElu.active,
        idleMs: value.idle - firstElu.idle,
      });
      lastInterval = at;
    },
    stop(at) {
      api.interval(at, true);
      active = false;
    },
    snapshot: () => ({
      version: 3,
      hooks,
      marks,
      nonExecutionReplies,
      filesystems,
      resources,
      steadyEpochMs: epoch,
      intervals,
      warnings,
      statements: [...statements.values()],
    }),
  };
  return api;
};
