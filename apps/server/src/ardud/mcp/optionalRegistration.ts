import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export interface McpRegistrationStatus {
  readonly server: string;
  readonly status: "available" | "unavailable";
  readonly reason: "connected" | "connection_failed" | "control_rejected" | "timeout";
  readonly batchLatencyMs: number;
}

export function mcpStartupTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const value = Number(environment.ROBOB_MCP_STARTUP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(10_000, Math.max(100, value)) : 5_000;
}

// setMcpServers replaces the entire dynamic set. Never overlap replacements,
// including after our deadline: timing out an SDK promise does not cancel it.
export function optionalMcpRegistration(input: {
  readonly servers: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly register: () => Promise<{ readonly errors: Readonly<Record<string, unknown>> }>;
  readonly reconnect?: (
    servers: ReadonlyArray<string>,
  ) => Promise<{ readonly errors: Readonly<Record<string, unknown>> }>;
  readonly report: (status: McpRegistrationStatus) => Effect.Effect<void>;
}) {
  let pending = false;
  let closed = false;
  let retryAt = 0;
  let failures = 0;
  let available = false;
  let failedServers: string[] | undefined;
  let registrationAnswered = false;
  const attempt = Effect.fn("OptionalMcpRegistration.attempt")(function* () {
    const started = yield* Clock.currentTimeMillis;
    if (closed || pending || available || started < retryAt || input.servers.length === 0) return;
    pending = true;
    const result = yield* Effect.tryPromise(() =>
      Promise.resolve()
        .then(() =>
          registrationAnswered && failedServers && input.reconnect
            ? input.reconnect(failedServers)
            : input.register(),
        )
        .finally(() => {
          pending = false;
        }),
    ).pipe(
      Effect.map((result) => ({ reason: "connected" as const, errors: result.errors })),
      // SDK errors can echo credentials. Only bounded reason codes leave here.
      Effect.orElseSucceed(() => ({ reason: "control_rejected" as const, errors: {} })),
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () => Effect.succeed({ reason: "timeout" as const, errors: {} }),
      }),
    );
    if (closed) return;
    if (result.reason === "connected") registrationAnswered = true;
    const ended = yield* Clock.currentTimeMillis;
    const statuses = input.servers.map((server): McpRegistrationStatus => {
      const reason =
        failedServers && !failedServers.includes(server)
          ? "connected"
          : result.reason === "connected" && Object.hasOwn(result.errors, server)
            ? "connection_failed"
            : result.reason;
      return {
        server,
        status: reason === "connected" ? "available" : "unavailable",
        reason,
        batchLatencyMs: ended - started,
      };
    });
    failedServers = statuses
      .filter((status) => status.status === "unavailable")
      .map((status) => status.server);
    available = statuses.every((status) => status.status === "available");
    failures = available ? 0 : failures + 1;
    retryAt = ended + Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
    yield* Effect.forEach(statuses, (status) =>
      input
        .report(status)
        .pipe(Effect.withSpan("mcp.server.registration", { attributes: { ...status } })),
    );
  })();
  return {
    attempt,
    close: Effect.sync(() => {
      closed = true;
    }),
  };
}
