// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hash unrecognized labels instead of logging free text.
import * as NodeCrypto from "node:crypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const AuthenticatedClientObserver = Context.Reference<
  ((session: { readonly clientLabel?: string }) => void) | undefined
>("t3/observability/AuthenticatedClientObserver", { defaultValue: () => undefined });

const booleanParams = new Set(["active", "includeSubagents", "archived", "all", "drain"]);
const presenceParams = new Set([
  "after",
  "afterMessageId",
  "boardId",
  "role",
  "runId",
  "threadId",
  "timeoutMs",
  "types",
  "until",
  "ids",
  "projectId",
  "parentThreadId",
  "cursor",
  "updatedSince",
  "since",
  "origin",
  "state",
  "creationSource",
  "driver",
  "view",
  "limit",
  "offset",
  "nativeId",
  "instance",
  "agentId",
]);

// Values and unknown parameter names may contain credentials. Only bounded modes survive.
export const queryShape = (url: string) => {
  const params = new URL(url, "http://control.invalid").searchParams;
  const shapes = new Set<string>();
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (booleanParams.has(name)) {
      const value =
        values.length === 1 && /^(true|false|1|0)$/.test(values[0]!) ? values[0]! : "other";
      shapes.add(`${name}:${value}`);
    } else if (name === "limit") {
      const value =
        values.length === 1 && /^\d{1,3}$/.test(values[0]!) && Number(values[0]) <= 500
          ? String(Number(values[0]))
          : "other";
      shapes.add(`limit:${value}`);
    } else if (presenceParams.has(name)) shapes.add(name);
    else shapes.add("other");
  }
  return [...shapes].sort().join("/").slice(0, 160);
};

const clientLabel = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[ _]+/g, "-")
    .replace(/^component-/, "");
  return /^(telegram-bridge|spectrum-bridge|stream-recovery|robob-watch|watchers|offbox|rcsim|t3ctl|crw|coord|coord-guard|harness-hooks|memory|device-enroll|dev-resource-janitor|reusable-dev-token)$/.test(
    normalized,
  )
    ? normalized
    : `sha256:${NodeCrypto.createHash("sha256").update(value).digest("hex")}`;
};

// Keep the product/version useful for attribution without comments, URLs or arbitrary header text.
export const userAgent = (value: string | undefined) => {
  if (!value) return "missing";
  if (value.length > 160) return "other";
  const match =
    /^(node|Bun|curl|Python-urllib|undici|t3ctl)(?:\/(\d{1,3}(?:\.\d{1,3}){0,3}))?$/i.exec(value);
  return match ? `${match[1]!.toLowerCase()}${match[2] ? `/${match[2]}` : ""}` : "other";
};

export const make = Effect.fn("ControlHttpTelemetry.make")(function* (
  url: string,
  agent: string | undefined,
) {
  const parentWait = yield* NodeSqliteClient.ReaderWaitObserver;
  const parentTiming = yield* NodeSqliteClient.StatementTimingObserver;
  const parentClient = yield* AuthenticatedClientObserver;
  const lanes = new Set<string>();
  let waitMs = 0;
  let queryMs = 0;
  let statements = 0;
  let label: string | undefined;
  return {
    props: () => ({
      queryShape: queryShape(url),
      userAgent: userAgent(agent),
      ...(label === undefined ? {} : { controlClient: label }),
      ...(lanes.size === 0
        ? {}
        : {
            readerLane: [...lanes].sort().join("/"),
            readerAcquireMs: waitMs,
            readerQueryMs: queryMs,
            readerStatements: statements,
          }),
    }),
    observe: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(AuthenticatedClientObserver, (session) => {
          if (session.clientLabel) label = clientLabel(session.clientLabel);
          parentClient?.(session);
        }),
        Effect.provideService(NodeSqliteClient.ReaderWaitObserver, (ms, lane) => {
          waitMs += ms;
          lanes.add(lane ?? "unknown");
          parentWait?.(ms, lane);
        }),
        Effect.provideService(NodeSqliteClient.StatementTimingObserver, (observation) => {
          if (observation.connection === "reader") {
            lanes.add(observation.lane ?? "background");
            queryMs += observation.durationMs;
            statements++;
          }
          parentTiming?.(observation);
        }),
      ),
  };
});

// Retain path structure without arbitrary IDs, credentials, or query values.
const pathSegments = new Set([
  "api",
  "ardud",
  "control",
  "kanban",
  "threads",
  "messages",
  "runs",
  "evidence",
  "health",
  "projects",
  "models",
  "usage",
  "requests",
  "events",
  "cards",
  "boards",
  "discussions",
  "wiki",
  "by-native",
  "send",
  "interrupt",
  "origin",
  "install-report",
  "recovery-snapshot",
  "attachments",
  "mcp",
  "assets",
  "auth",
  "oauth",
]);
export const pathHint = (url: string) => {
  // Node supplies raw origin-form targets, where leading // is still a path.
  const target = url.split(/[?#]/, 1)[0]!;
  const path = url.startsWith("/") ? target : (URL.parse(url)?.pathname ?? target);
  return {
    pathHint:
      path
        .split("/")
        .slice(0, 20)
        .map((part) => (part === "" || pathSegments.has(part) ? part : ":value"))
        .join("/")
        .slice(0, 160) || "/",
    pathHash: `sha256:${NodeCrypto.createHash("sha256").update(path).digest("hex")}`,
  };
};
