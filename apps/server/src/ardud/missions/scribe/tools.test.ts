import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import {
  harness,
  masterThread,
  missionId,
  seed,
  strayThread,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as ScribeService from "./ScribeService.ts";
import * as ScribeStore from "./ScribeStore.ts";
import * as ReportTools from "./tools.ts";

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

const call = (
  name: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result): ToolOutcome => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: (result.structuredContent as Record<string, unknown> | undefined) ?? {},
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const fresh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(ReportTools.ReportsToolkit, ReportTools.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(liveThreadsLayer),
        Layer.provideMerge(
          ScribeService.layer.pipe(
            Layer.provideMerge(ScribeStore.layer),
            Layer.provideMerge(harness().layer),
          ),
        ),
      ),
    ),
  );

const day = {
  missionId,
  kind: "daily",
  coversFrom: "2026-10-20T20:00:00.000Z",
  coversTo: "2026-10-21T20:00:00.000Z",
  text: "# Mission one daily\n\nAll quiet.",
};

describe("report MCP tools", () => {
  it.effect("the master keeps a report and gets its id and revision back", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const first = yield* call("mission_report_put", threadCaller(masterThread), {
          ...day,
          facts: { merged: 3 },
        });
        expect(first.isError).toBe(false);
        expect(first.structured.report).toMatchObject({
          reportId: `${missionId}|daily|2026-10-21T20:00:00.000Z`,
          revision: 1,
          author: "master",
          saved: true,
          hides: [],
        });
        const second = yield* call("mission_report_put", threadCaller(masterThread), {
          ...day,
          text: "# Mission one daily\n\nRewritten.",
        });
        expect(second.structured.report).toMatchObject({
          reportId: `${missionId}|daily|2026-10-21T20:00:00.000Z|r2`,
          revision: 2,
          hides: [`${missionId}|daily|2026-10-21T20:00:00.000Z`],
        });
        const scribe = yield* ScribeStore.ScribeStore;
        const listed = yield* scribe.listReports(missionId, ["daily"], 10);
        expect(listed.rows.map((row) => row.revision)).toEqual([2]);
      }),
    ),
  );

  it.effect("refuses everyone but the master, and unknown parameters", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        for (const scope of [threadCaller(writerThread), threadCaller(strayThread), clientCaller]) {
          const refused = yield* call("mission_report_put", scope, day);
          expect(refused.isError).toBe(true);
        }
        for (const extra of [{ author: "owner" }, { provenance: { _tag: "owner-app" } }]) {
          const outcome = yield* Effect.exit(
            call("mission_report_put", threadCaller(masterThread), { ...day, ...extra }),
          );
          expect(outcome._tag === "Failure" || outcome.value.isError).toBe(true);
        }
        const bad = yield* call("mission_report_put", threadCaller(masterThread), {
          ...day,
          coversFrom: day.coversTo,
        });
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("report window");
        const scribe = yield* ScribeStore.ScribeStore;
        expect((yield* scribe.listReports(missionId, ["daily"], 10)).total).toBe(0);
      }),
    ),
  );
});
