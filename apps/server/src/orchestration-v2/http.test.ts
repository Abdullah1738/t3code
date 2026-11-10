import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { middleware as replyMiddleware } from "../ardud/http/replyMiddleware.ts";
import { SHELL_WALK_START_CURSOR } from "../ardud/perf/shellPages.ts";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "./http.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const decodeTurnItem = Schema.decodeUnknownEffect(OrchestrationV2TurnItem);
const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const environmentId = EnvironmentId.make("source-بيئة");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeUnknownSync(OrchestrationV2AppThread)({
  id: "source-thread",
  projectId: "source-project",
  title: "Source 界\nconversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    type: "command_execution",
    status: "completed",
    title: "Read notes",
    input: "cat notes.md",
    output: position === 0 ? output : "Done",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })),
);

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-transcript" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadManagementService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
          ),
        ),
        OrchestrationEventStore.layer,
        ProjectStore.layer,
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const eventSink = Context.get(services, EventSinkV2);
    yield* eventSink.write({
      events: Array.from({ length: 505 }, (_, index) => {
        const id = ThreadId.make(`paged-${String(index).padStart(4, "0")}`);
        return {
          id: EventId.make(`created-${id}`),
          type: "thread.created" as const,
          threadId: id,
          occurredAt: now,
          payload: { ...thread, id },
        };
      }),
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-source"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
        {
          // Finished weeks ago: only clients that opt in leave it out of the shell.
          id: EventId.make("create-idle-subagent"),
          type: "thread.created",
          threadId: ThreadId.make("idle-subagent"),
          occurredAt: now,
          payload: {
            ...thread,
            id: ThreadId.make("idle-subagent"),
            lineage: {
              parentThreadId: thread.id,
              relationshipToParent: "subagent",
              rootThreadId: thread.id,
            },
          },
        },
      ],
    });
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(allowed ? ["orchestration:read"] : []),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(Layer.mock(ProjectEnrichmentService)({})),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provide(HttpRouter.middleware(replyMiddleware, { global: true })),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const read = (threadId: ThreadId) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );

    const emptyResponse = yield* read(thread.id);
    expect(emptyResponse.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => emptyResponse.json()))).items,
    ).toEqual([]);
    const shellRequest = (after?: string) =>
      Effect.promise(() =>
        handler(
          new Request(
            `http://localhost/api/orchestration/shell?paged=true${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
            { headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT } },
          ),
        ),
      );
    const firstShell = yield* shellRequest();
    expect(firstShell.status).toBe(200);
    const firstPage = (yield* Effect.promise(() => firstShell.json())) as {
      threads: Array<{ id: string }>;
      page: { nextAfter: string | null };
    };
    expect(firstPage.threads).toHaveLength(500);
    expect(firstPage.page.nextAfter).toBe(firstPage.threads.at(-1)!.id);
    const lastShell = yield* shellRequest(firstPage.page.nextAfter!);
    const lastPage = (yield* Effect.promise(() => lastShell.json())) as typeof firstPage;
    expect(lastPage.threads).toHaveLength(7);
    expect(lastPage.page.nextAfter).toBeNull();
    expect(
      new Set([...firstPage.threads, ...lastPage.threads].map((thread) => thread.id)).size,
    ).toBe(507);
    const legacyShell = yield* Effect.promise(() =>
      handler(
        new Request("http://localhost/api/orchestration/shell", {
          headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
        }),
      ),
    );
    const legacyData = (yield* Effect.promise(() => legacyShell.json())) as typeof firstPage;
    expect(legacyData.threads).toHaveLength(507);
    expect(legacyData.page).toBeUndefined();
    const sidebarPage = (after?: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(
            `http://localhost/api/orchestration/shell?paged=true&omitIdleSubagents=true${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
            { headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT } },
          ),
        );
        return (await response.json()) as typeof firstPage;
      });
    const sidebarFirst = yield* sidebarPage();
    const sidebarLast = yield* sidebarPage(sidebarFirst.page.nextAfter!);
    const sidebarIds = [...sidebarFirst.threads, ...sidebarLast.threads].map((thread) => thread.id);
    expect(sidebarLast.page.nextAfter).toBeNull();
    expect(sidebarIds).toHaveLength(506);
    expect(sidebarIds).not.toContain("idle-subagent");
    expect(legacyData.threads.map((thread) => thread.id)).toContain("idle-subagent");
    // ardud: a client that asks for it gets the most recently updated rows first, then the
    // same walk by id from the start; every row still arrives, recent ones twice.
    const sql = Context.get(services, SqlClient.SqlClient);
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET updated_at = '2099-01-01T00:00:00.000Z'
      WHERE thread_id IN ('paged-0503', 'paged-0504')
    `;
    const recentPage = (after?: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(
            `http://localhost/api/orchestration/shell?paged=true&recentFirst=true${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
            { headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT } },
          ),
        );
        return (await response.json()) as typeof firstPage;
      });
    const recentFirst = yield* recentPage();
    expect(recentFirst.threads).toHaveLength(500);
    expect(recentFirst.threads.slice(0, 2).map((thread) => thread.id)).toEqual([
      "paged-0503",
      "paged-0504",
    ]);
    expect(recentFirst.page.nextAfter).toBe(SHELL_WALK_START_CURSOR);
    const walkFirst = yield* recentPage(recentFirst.page.nextAfter!);
    expect(walkFirst.threads.map((thread) => thread.id)).toEqual(
      firstPage.threads.map((thread) => thread.id),
    );
    expect(walkFirst.page.nextAfter).toBe(firstPage.page.nextAfter);
    const walkLast = yield* recentPage(walkFirst.page.nextAfter!);
    expect(walkLast.page.nextAfter).toBeNull();
    expect(
      new Set([...walkFirst.threads, ...walkLast.threads].map((thread) => thread.id)).size,
    ).toBe(507);
    // Without the option the first page is unchanged, and the walk cursor works on its own.
    const plainWalkResponse = yield* shellRequest(SHELL_WALK_START_CURSOR);
    const plainWalk = (yield* Effect.promise(() => plainWalkResponse.json())) as typeof firstPage;
    expect(plainWalk.threads.map((thread) => thread.id)).toEqual(
      firstPage.threads.map((thread) => thread.id),
    );
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const emptyOutputRows = transcript.items.map((row, position) =>
      position === 0 ? { ...row, item: { ...row.item, output: "" } } : row,
    );
    const header = threadTranscriptHeader(environmentId, transcript);
    const baseSize =
      Buffer.byteLength(header, "utf8") +
      emptyOutputRows.reduce(
        (size, row) => size + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
        0,
      );
    const boundaryOutput = "界" + "x".repeat(PROVIDER_SEND_TURN_MAX_FILE_BYTES - baseSize - 3);
    for (const [suffix, expectedStatus] of [
      ["", 413],
      ["x", 400],
    ] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`boundary-${expectedStatus}`),
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: {
              ...items.find((item) => item.type === "command_execution")!,
              output: boundaryOutput + suffix,
            },
          },
        ],
      });
      const response = yield* read(thread.id);
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 413) {
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          error: "reply_too_large",
        });
      }
      if (expectedStatus === 400) {
        const error = yield* Context.get(services, ThreadManagementService.ThreadManagementService)
          .getThreadTranscript(thread.id)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Effect.flip,
          );
        expect(error).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "EnvironmentRequestInvalidError",
          reason: "thread_transcript_too_large",
        });
      }
    }

    const huge = yield* decodeTurnItem({
      ...items[0],
      id: "huge-assistant",
      ordinal: 201,
      type: "assistant_message",
      messageId: "huge-answer",
      text: "x".repeat(18 * 1024 * 1024),
      streaming: false,
    });
    const newest = yield* decodeTurnItem({
      ...huge,
      id: "newest-assistant",
      ordinal: 202,
      text: "newest",
    });
    const collection = yield* decodeTurnItem({
      ...items[0],
      id: "huge-search",
      ordinal: 200,
      type: "web_search",
      results: Array.from({ length: 2000 }, (_, index) => ({
        url: `https://example.com/${index}`,
        snippet: "x".repeat(10_000),
      })),
    });
    yield* eventSink.write({
      events: [collection, huge, newest].map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });
    const requestPath = (path: string) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${thread.id}/${path}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
    const boundedResponse = yield* requestPath("bounded");
    expect(boundedResponse.status).toBe(200);
    const boundedText = yield* Effect.promise(() => boundedResponse.text());
    expect(Buffer.byteLength(boundedText)).toBeLessThan(1024 * 1024);
    const bounded = JSON.parse(boundedText) as { historyCursor: string };
    const historyResponse = yield* requestPath(
      `history?cursor=${encodeURIComponent(bounded.historyCursor)}`,
    );
    expect(historyResponse.status).toBe(200);
    const historyText = yield* Effect.promise(() => historyResponse.text());
    expect(Buffer.byteLength(historyText)).toBeLessThan(1024 * 1024);
    expect(historyText).toContain("truncated for transport");
    expect(historyText).toContain("This history item is too large");

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);
