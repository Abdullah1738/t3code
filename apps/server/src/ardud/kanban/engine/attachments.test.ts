import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type KanbanActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanModels from "./models.ts";
import * as KanbanService from "./KanbanService.ts";
import { KanbanThreads, type KanbanThreadView } from "./threads.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { opencodeTestProvider } from "./testProviders.ts";

const owner: KanbanActor = { _tag: "owner" };

interface FakeThread {
  readonly title: string;
  readonly messages: Array<string>;
}

const makeFake = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<string, FakeThread>());
  const layer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: (threadId) =>
        Ref.get(threads).pipe(
          Effect.map((all): KanbanThreadView | null => {
            const thread = all.get(threadId);
            if (!thread) return null;
            return {
              threadId,
              projectId: ProjectId.make("project-1"),
              title: thread.title,
              state: "idle",
              updatedAt: "2026-10-27T10:00:00.000Z",
              prs: [],
              archived: false,
            };
          }),
        ),
      launch: (input) =>
        Ref.modify(threads, (all) => {
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
      interrupt: () => Effect.void,
    }),
  );
  return { threads, layer };
});

const attachmentsLayerTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-kanban-attachments-",
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));

const testLayer = (fake: Layer.Layer<KanbanThreads>) =>
  KanbanService.layer.pipe(
    Layer.provideMerge(fake),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(attachmentsLayerTest),
  );

/** A file already kept under a given owner segment, as a claim would leave it. */
const writeKept = (attachmentsDir: string, segment: string, name: string, bytes: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const id = createAttachmentId(segment, path.extname(name).slice(1) || undefined)!;
    const attachment = {
      type: "file" as const,
      id,
      name,
      mimeType: "application/pdf",
      sizeBytes: new TextEncoder().encode(bytes).byteLength,
    };
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFileString(resolveAttachmentPath({ attachmentsDir, attachment })!, bytes);
    return attachment;
  });

/** A pending upload written the way the upload endpoint would store it. */
const writePending = (
  attachmentsDir: string,
  name: string,
  mimeType: string,
  bytes: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const id = createPendingAttachmentId(path.extname(name).slice(1) || undefined);
    const attachment = {
      type: "file" as const,
      id,
      name,
      mimeType,
      sizeBytes: new TextEncoder().encode(bytes).byteLength,
    };
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFileString(resolveAttachmentPath({ attachmentsDir, attachment })!, bytes);
    return attachment;
  });

it.effect("posting a pending file stores a board-owned id, the file exists and the pending file stays", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "attach",
        name: "Attach",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const discussion = yield* kanban.createDiscussion(board.id, "Files", owner);
      const pending = yield* writePending(config.attachmentsDir, "report.pdf", "application/pdf", "pdf-bytes");

      yield* kanban.post(discussion.id, owner, [{ _tag: "attachment", attachment: pending }]);

      const messages = yield* kanban.messages(discussion.id);
      const stored = messages.at(-1)?.blocks[0];
      if (stored?._tag !== "attachment") return assert.fail("expected an attachment block");
      assert.notStrictEqual(stored.attachment.id, pending.id);
      const fs = yield* FileSystem.FileSystem;
      const storedPath = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: stored.attachment })!;
      const pendingPath = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: pending })!;
      assert.isTrue(yield* fs.exists(storedPath));
      assert.isTrue(yield* fs.exists(pendingPath));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("the text the agent receives carries the absolute path of the stored file", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "attach-text",
        name: "Attach text",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const discussion = yield* kanban.createDiscussion(board.id, "Shots", owner);
      const pending = yield* writePending(config.attachmentsDir, "photo.png", "image/png", "png-bytes");

      yield* kanban.post(discussion.id, owner, [{ _tag: "attachment", attachment: pending }]);

      const messages = yield* kanban.messages(discussion.id);
      const stored = messages.at(-1)?.blocks[0];
      if (stored?._tag !== "attachment") return assert.fail("expected an attachment block");
      const storedPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: stored.attachment,
      })!;
      const path = yield* Path.Path;
      assert.isTrue(path.isAbsolute(storedPath));
      // The agent receives the text; it must carry the path it can open.
      const delivered = [...(yield* Ref.get(fake.threads)).values()].flatMap((thread) => thread.messages);
      assert.isTrue(delivered.some((text) => text.includes(storedPath)));
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("another thread's id is refused as invalid and nothing is stored", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "attach-foreign",
        name: "Attach foreign",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const config = yield* ServerConfig.ServerConfig;
      const discussion = yield* kanban.createDiscussion(board.id, "Foreign", owner);
      const otherThread = yield* writeKept(config.attachmentsDir, "thread-abc", "secret.pdf", "%PDF");
      const otherBoard = yield* writeKept(config.attachmentsDir, "kanban-other-board", "plan.pdf", "%PDF");
      const missing = {
        type: "file" as const,
        id: createAttachmentId(`kanban-${board.id}`, "pdf")!,
        name: "gone.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      };

      for (const foreign of [otherThread, otherBoard, missing]) {
        const error = yield* kanban
          .post(discussion.id, owner, [{ _tag: "attachment", attachment: foreign }])
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "invalid");
        assert.include(error.detail, foreign.name);
      }
      assert.strictEqual((yield* kanban.messages(discussion.id)).length, 0);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);

it.effect("re-posting a board-owned id works", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake;
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const kanban = yield* KanbanService.KanbanService;
      const board = yield* kanban.ensureBoard({
        slug: "attach-repost",
        name: "Attach repost",
        defaultProjectId: ProjectId.make("project-1"),
      });
      const discussion = yield* kanban.createDiscussion(board.id, "Repost", owner);
      const pending = yield* writePending(config.attachmentsDir, "note.txt", "text/plain", "hello");
      yield* kanban.post(discussion.id, owner, [{ _tag: "attachment", attachment: pending }]);
      const first = (yield* kanban.messages(discussion.id)).at(-1)?.blocks[0];
      if (first?._tag !== "attachment") return assert.fail("expected an attachment block");

      yield* kanban.post(discussion.id, owner, [{ _tag: "attachment", attachment: first.attachment }]);
      assert.strictEqual((yield* kanban.messages(discussion.id)).length, 2);
    }).pipe(Effect.provide(testLayer(fake.layer)));
  }),
);
