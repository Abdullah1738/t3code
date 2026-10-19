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
import { ViewsLive } from "./layer.ts";
import * as ViewTools from "./tools.ts";
import { ViewService } from "./ViewService.ts";

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
      McpHttpServer.toolkitRegistration(ViewTools.ViewsToolkit, ViewTools.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(liveThreadsLayer),
        Layer.provideMerge(ViewsLive.pipe(Layer.provideMerge(harness().layer))),
      ),
    ),
  );

const crwMerge = {
  key: "crw-merge",
  name: "crw merge",
  backing: "approval",
  kicker: "Merge",
  body: [{ _tag: "text", bind: "record.summary", style: "body", maxLines: 2 }],
  actions: ["approve", "reject", "discuss"],
  primary: "approve",
  match: { approvalKind: ["merge"], requestedBy: ["crw"] },
};

describe("views MCP tools", () => {
  it.effect("the master acts as itself; identity never comes from parameters", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const master = threadCaller(masterThread);

        // Reads work for any caller, catalog on request.
        const read = yield* call("mission_views", clientCaller, { missionId, catalog: true });
        expect(read.isError).toBe(false);
        expect((read.structured.catalog as { version: number }).version).toBe(1);

        // The master defines a template and hides a section.
        const made = yield* call("mission_view_template", master, {
          missionId,
          definition: crwMerge,
        });
        expect(made.isError).toBe(false);
        const hidden = yield* call("mission_view_layout", master, {
          missionId,
          ops: [{ _tag: "hide", key: "since-last-looked" }],
        });
        expect(hidden.isError).toBe(false);
        const views = yield* ViewService;
        const snapshot = yield* views.snapshot(missionId);
        expect(snapshot.templates[0]?.by).toBe("master");
        expect(snapshot.layout.by).toBe("master");

        // Strict params: an actor or provenance in the arguments is rejected.
        for (const extra of [
          { by: "owner" },
          { provenance: { _tag: "owner-app", surface: "web", sessionId: "x" } },
        ]) {
          const outcome = yield* Effect.exit(
            call("mission_view_layout", master, {
              missionId,
              ops: [{ _tag: "show", key: "since-last-looked" }],
              ...extra,
            }),
          );
          expect(outcome._tag === "Failure" || outcome.value.isError).toBe(true);
        }

        // A writer, a stray thread and a signed-in client can't write.
        for (const scope of [threadCaller(writerThread), threadCaller(strayThread), clientCaller]) {
          const refused = yield* call("mission_view_layout", scope, {
            missionId,
            ops: [{ _tag: "show", key: "since-last-looked" }],
          });
          expect(refused.isError).toBe(true);
        }
        expect((yield* views.snapshot(missionId)).layout.version).toBe(2);

        // Invalid definitions come back as issues; preview stores nothing.
        const bad = yield* call("mission_view_template", master, {
          missionId,
          definition: { ...crwMerge, key: "bad", body: [{ _tag: "gallery" }] },
        });
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("unknown-node");
        const preview = yield* call("mission_view_preview", master, {
          missionId,
          definition: { _tag: "template", definition: { ...crwMerge, key: "other" } },
        });
        expect(preview.isError).toBe(false);
        expect((yield* views.snapshot(missionId)).templates.length).toBe(1);
      }),
    ),
  );
});
