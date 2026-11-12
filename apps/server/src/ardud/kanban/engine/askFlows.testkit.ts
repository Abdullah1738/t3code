/** The board service and its HTTP routes over fake threads, for the ask tests. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import { createPendingAttachmentId, resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { KANBAN_ROUTE_PREFIX, kanbanRouteLayer } from "../http.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanModels from "./models.ts";
import * as KanbanService from "./KanbanService.ts";
import { KanbanScripts } from "./ScriptService.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreadError, KanbanThreads, type KanbanThreadView } from "./threads.ts";

/** Text that makes the fake refuse to start the thread it is in. */
export const FAIL_LAUNCH = "[fail-launch]";

export const owner: KanbanActor = { _tag: "owner" };

interface FakeThread {
  readonly title: string;
  readonly messages: Array<string>;
}

export const makeFake = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<string, FakeThread>());
  const view = (threadId: ThreadId) =>
    Ref.get(threads).pipe(
      Effect.map((all): KanbanThreadView | null => {
        const thread = all.get(threadId);
        if (!thread) return null;
        return {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: thread.title,
          state: "idle",
          updatedAt: "2026-11-10T10:00:00.000Z",
          quietSince: "2026-11-10T10:00:00.000Z",
          runStartedAt: null,
          backgroundWork: 0,
          prWatches: 0,
          prs: [],
          archived: false,
        };
      }),
    );
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view,
      find: view,
      launch: (input) =>
        // A test makes one launch fail by putting this marker in what the thread is told.
        input.text.includes(FAIL_LAUNCH)
          ? Effect.fail(
              new KanbanThreadError({ operation: "launch", detail: "the provider is down" }),
            )
          : Ref.modify(threads, (all) => {
              const threadId = ThreadId.make(`thread-${all.size + 1}`);
              const copy = new Map(all);
              copy.set(threadId, { title: input.title, messages: [input.text] });
              return [threadId, copy] as const;
            }),
      send: (input) =>
        Ref.update(threads, (all) => {
          all.get(input.threadId)?.messages.push(input.text);
          return all;
        }),
      lastFailure: () => Effect.succeed(null),
      findLastFailure: () => Effect.succeed(null),
      latestRun: () => Effect.succeed(null),
      compactRun: () => Effect.succeed(null),
      model: () => Effect.succeed(null),
      setModel: () => Effect.void,
      cancelQueued: () => Effect.succeed(false),
      interrupt: () => Effect.void,
    }),
  );
  /** Every text a thread was sent, its first message included. */
  const heard = (threadId: string) =>
    Ref.get(threads).pipe(Effect.map((all) => all.get(threadId)?.messages ?? []));
  /** The evaluator thread that was started for a card's discussion, and what it was told. */
  const evaluators = Ref.get(threads).pipe(
    Effect.map((all) =>
      [...all.entries()]
        .filter(([, thread]) => thread.title.startsWith("Evaluator"))
        .map(([threadId, thread]) => ({ threadId: ThreadId.make(threadId), ...thread })),
    ),
  );
  return { threads, layer, heard, evaluators };
});

export const filesLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-asks-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
);

export const testLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(filesLayer),
  );

/**
 * The same service over a database file, so a test can stop one service and
 * start another on what it left behind. `store` stands in for the board store.
 */
export const fileTestLayer = (
  fake: Layer.Layer<KanbanThreads>,
  dbPath: string,
  store: typeof KanbanStore.layer = KanbanStore.layer,
) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(store),
    Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(filesLayer),
  );

export const toyBoard = (slug = "toy") =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const board = yield* kanban.ensureBoard({
      slug,
      name: "Toy",
      defaultProjectId: ProjectId.make("project-1"),
    });
    yield* kanban.setPool(board.id, board.defaultCardModel, 2);
    return { kanban, board };
  });

/** A card with a live work thread. */
export const workingCard = (title = "A") =>
  Effect.gen(function* () {
    const { kanban, board } = yield* toyBoard();
    const card = yield* kanban.createCard(board.id, { prompt: title, title }, owner);
    yield* kanban.dispatchNow;
    const threadId = (yield* kanban.card(card.id)).card.activeThreadId!;
    const worker: KanbanActor = { _tag: "thread", threadId };
    return { kanban, board, card, threadId, worker };
  });

export const askOf = (card: KanbanCard, id = "q1") => card.asks.find((ask) => ask.id === id)!;

/** A pending upload written the way the upload endpoint stores it. */
export const writePending = (name: string, mimeType: string, bytes: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const attachment = {
      type: "file" as const,
      id: createPendingAttachmentId(path.extname(name).slice(1) || undefined),
      name,
      mimeType,
      sizeBytes: new TextEncoder().encode(bytes).byteLength,
    };
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFileString(
      resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
      bytes,
    );
    return attachment;
  });

/** The session an HTTP caller holds: the owner's paired app unless a test says otherwise. */
export type HttpCaller =
  | { readonly _tag: "owner" }
  | { readonly _tag: "component"; readonly component: string }
  /** A session nobody marked, issued by hand: `t3 auth session issue`, the old shared control token. */
  | { readonly _tag: "unmarked" }
  /** A device paired from a link made on the Mac (`t3 pair`): a pairing-link session nobody marked. */
  | { readonly _tag: "paired" };

/** The session each caller's cookie or bearer maps to. */
export const sessionOf = (caller: HttpCaller) => ({
  sessionId: AuthSessionId.make(`session-${caller._tag}`),
  subject:
    caller._tag === "component"
      ? `component:${caller.component}`
      : caller._tag === "unmarked"
        ? "cli-issued-session"
        : "one-time-token",
  method: "bearer-access-token" as const,
  scopes: ["orchestration:read" as const, "orchestration:operate" as const],
  ...(caller._tag === "owner"
    ? { origin: { _tag: "owner" as const, source: "paired-client" as const } }
    : caller._tag === "component"
      ? { origin: { _tag: "component" as const, component: caller.component } }
      : {}),
});

/** The board's HTTP routes over the service under test, as the owner's app or as `caller`. */
export const makeHttpAs = (caller: HttpCaller) => makeHttpFor(caller);
export const makeHttp = Effect.suspend(() => makeHttpFor({ _tag: "owner" }));

const makeHttpFor = (caller: HttpCaller) =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const sql = yield* SqlClient.SqlClient;
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          kanbanRouteLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                  authenticateHttpRequest: () => Effect.succeed(sessionOf(caller)),
                }),
                Layer.succeed(KanbanService.KanbanService, kanban),
                Layer.mock(KanbanScripts)({}),
                Layer.succeed(SqlClient.SqlClient, sql),
              ).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
            Layer.provide(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(NodeServices.layer),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    // The routes read the server settings per request.
    const context = Context.make(
      ServerSettings.ServerSettingsService,
      yield* ServerSettings.ServerSettingsService,
    );
    const call = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://env.local${KANBAN_ROUTE_PREFIX}${path}`, {
            method,
            headers: { authorization: "Bearer owner", "content-type": "application/json" },
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          context,
        );
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      });
    return {
      get: (path: string) => call("GET", path),
      post: (path: string, body?: unknown) => call("POST", path, body),
      request: call,
    };
  });
