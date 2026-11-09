// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Distribution = { count: number; p50: number; p95: number; p99: number; max: number };
export function percentiles(values: readonly number[]): Distribution | null {
  if (!values.length) return null;
  if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("Invalid measurement");
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1)! };
}
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// O_APPEND prevents an interrupted run from replacing earlier evidence.
export function appendLedger(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + "\n", { flag: "a" });
}
export type Run = {
  gateVersion?: string;
  requests?: Record<string, number[]>;
  summaries?: Record<string, Distribution>;
  host?: { stealPct: number; ioSomePct: number; ioFullPct: number };
  sha: string;
  serverHash?: string;
  harnessHash?: string;
  workloadMode?: "steady" | "legacy-burst";
  ownerAnswers?: { workload: string; rpcAnswers: number; consumedAsks: number; routedAsks: number; launchedEvaluators: number; mockProvider: "acp-local"; mockDelivered: number; liveDelivery: "unmeasured" };
  fixtureHash: string;
  runtimeHash: string;
  hardwareHash: string;
  seed: number;
  agents: number;
  scale: string;
  repeat: number;
  correctness: "pass" | "fail" | "unmeasured";
  metrics: Record<string, number | null>;
  gaps: string[];
};

export interface TraceSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}
// Attribute queues separately; do not sum nested spans into end-to-end latency.
export function phaseMetrics(spans: readonly TraceSpan[]) {
  const phases = {
    admission: /admission|acquire|semaphore|wait/i,
    sql: /sqlite|sql\./i,
    encode: /encode|jsonReply/i,
    decode: /decode/i,
    replyBuilder: /ReplyBuilders/i,
    board: /BoardLocks|board.*lock/i,
  };
  const attributes = {
    boardAdmission: "board.admission_wait_ms",
    replyBuilderAdmission: "reply_builder.admission_wait_ms",
  };
  const waits = Object.fromEntries(
    Object.entries(attributes).map(([phase, key]) => [
      phase,
      percentiles(
        spans.map((s) => s.attributes?.[key]).filter((v): v is number => typeof v === "number"),
      ),
    ]),
  );
  const sqlWaits = Object.fromEntries(
    ["reader", "writer"].map((connection) => [
      `${connection}Admission`,
      percentiles(
        spans
          .filter((s) => s.attributes?.["db.connection"] === connection)
          .map((s) => s.attributes?.["db.lock_wait_ms"])
          .filter((v): v is number => typeof v === "number"),
      ),
    ]),
  );
  return {
    ...waits,
    ...sqlWaits,
    ...Object.fromEntries(["routing", "evaluating"].map((queue) => [
      queue === "routing" ? "kanbanRoutingAdmission" : "kanbanEvaluatingAdmission",
      percentiles(spans.filter((span) => span.attributes?.["serial.queue"] === queue)
        .map((span) => span.attributes?.["serial.wait_ms"]).filter((value): value is number => typeof value === "number")),
    ])),
    ...Object.fromEntries(
      Object.entries(phases).map(([phase, pattern]) => [
        phase,
        percentiles(
          spans
            .filter((s) => pattern.test(s.name) && typeof s.durationMs === "number")
            .map((s) => s.durationMs!),
        ),
      ]),
    ),
  };
}

export async function fileHash(path: string) {
  const { createReadStream } = await import("node:fs");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function artifactHash(entry: string) {
  const { readdirSync } = await import("node:fs");
  // Source execution is useful when building an artifact is deliberately forbidden.
  // Hash the complete source closure, not the empty list of adjacent .mjs files.
  if (entry.endsWith(".ts")) {
    const { resolve, relative } = await import("node:path");
    const { dirname, basename } = await import("node:path");
    const source = dirname(resolve(entry));
    if (basename(source) !== "src" || basename(dirname(source)) !== "server")
      throw new Error("Source entry must be in apps/server/src");
    const root = resolve(source, "../../..");
    const files: string[] = [];
    function visit(directory: string) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", "tmp"].includes(item.name)) continue;
        const path = resolve(directory, item.name);
        if (item.isDirectory()) visit(path);
        else if (/\.(?:ts|json)$/.test(item.name)) files.push(path);
      }
    }
    visit(source);
    visit(resolve(root, "packages"));
    for (const manifest of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "apps/server/package.json",
    ])
      files.push(resolve(root, manifest));
    const parts = [];
    for (const path of files.sort()) parts.push([relative(root, path), await fileHash(path)]);
    return hash({ entry: relative(root, resolve(entry)), files: parts });
  }
  const { dirname, resolve } = await import("node:path");
  const directory = dirname(resolve(entry));
  const parts = [];
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".mjs"))
    .sort())
    parts.push([name, await fileHash(resolve(directory, name))]);
  return hash(parts);
}
