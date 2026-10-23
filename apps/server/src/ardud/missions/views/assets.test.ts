// @effect-diagnostics nodeBuiltinImport:off - writes throwaway image files to attach.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type {
  MissionAssetSource,
  MissionId,
  MissionProvenance,
  MissionStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import { toSafeThreadAttachmentSegment } from "../../../attachmentStore.ts";
import {
  agent,
  failureCode,
  masterThread,
  missionId,
  ownerApp,
  seed,
  strayThread,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { sniffImage } from "./assets.ts";
import { ViewService } from "./ViewService.ts";
import * as ViewStore from "./ViewStore.ts";
import { fresh } from "./views.testkit.ts";

/** A PNG header with real dimensions; enough for the sniff and size reads. */
const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

/** Writes a file at its canonical path (macOS temp dirs sit behind /var -> /private/var). */
const writeFile = (dir: string, name: string, bytes: Uint8Array) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const path = NodePath.join(NodeFS.realpathSync(dir), name);
  NodeFS.writeFileSync(path, bytes);
  return path;
};

/** Drops an image into a thread's attachments, the way an upload would. */
const threadAttachment = (threadId: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const id = `${toSafeThreadAttachmentSegment(threadId)}-${NodeCrypto.randomUUID()}`;
    writeFile(attachmentsDir, `${id}.png`, bytes);
    return id;
  });

/** A one-image request message. */
const addRequestImage = (
  views: ViewService["Service"],
  provenance: MissionProvenance,
  input: {
    readonly missionId: MissionId;
    readonly requestId: string;
    readonly source: MissionAssetSource;
  },
) =>
  Effect.map(
    views.addRequestImages(provenance, {
      missionId: input.missionId,
      requestId: input.requestId,
      sources: [input.source],
    }),
    (stored) => stored.images[0]!,
  );

describe("mission images", () => {
  it("knows images by their bytes, not their names", () => {
    assert.equal(sniffImage(png(4, 3)), "image/png");
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(new TextEncoder().encode("GIF89a......")), "image/gif");
    assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.isNull(sniffImage(new TextEncoder().encode("<svg xmlns='x'/>")));
  });

  it.effect("copies an image into the mission, serves it as an attachment, removes it", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir, stateDir } = yield* ServerConfig.ServerConfig;
        const source = writeFile(NodePath.join(stateDir, "shots"), "home.png", png(1280, 800));
        const added = yield* views.addAsset(ownerApp, {
          missionId,
          source: { _tag: "file", path: source },
          subject: { kind: "work-item", id: "wi-held" },
        });
        // The mission keeps its own copy: the original can go.
        NodeFS.rmSync(source);
        const asset = (yield* views.snapshot(missionId)).assets?.[0];
        assert.equal(asset?.id, added.ref.id);
        assert.equal(asset?.mimeType, "image/png");
        assert.equal(asset?.width, 1280);
        assert.equal(asset?.height, 800);
        assert.equal(asset?.name, "home.png");
        const stored = NodePath.join(attachmentsDir, `${added.ref.id}.png`);
        assert.isTrue(NodeFS.existsSync(stored));

        yield* views.removeAsset(ownerApp, { missionId, assetId: added.ref.id as never });
        assert.equal((yield* views.snapshot(missionId)).assets?.length, 0);
        assert.isFalse(NodeFS.existsSync(stored));
      }),
    ),
  );

  it.effect("refuses what isn't an image and paths that aren't real files", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const dir = NodePath.join(stateDir, "shots");
        const svg = writeFile(dir, "logo.png", new TextEncoder().encode("<svg xmlns='x'/>"));
        const add = (path: string) =>
          views.addAsset(ownerApp, { missionId, source: { _tag: "file", path } });
        assert.equal(yield* failureCode(add(svg)), "invalid");
        assert.equal(yield* failureCode(add("shots/home.png")), "invalid");
        const real = writeFile(dir, "real.png", png(2, 2));
        const link = NodePath.join(NodePath.dirname(real), "link.png");
        NodeFS.symlinkSync(real, link);
        assert.equal(yield* failureCode(add(link)), "invalid");
        assert.equal((yield* views.snapshot(missionId)).assets?.length, 0);
      }),
    ),
  );

  it.effect("agents attach only from their own thread; only the adder or the master removes", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const masters = yield* threadAttachment(masterThread, png(10, 10));
        const writers = yield* threadAttachment(writerThread, png(20, 20));
        const attach = (threadId: typeof masterThread, attachmentId: string) =>
          views.addAsset(agent(threadId), {
            missionId,
            source: { _tag: "attachment", attachmentId },
          });

        assert.equal(yield* failureCode(attach(writerThread, masters)), "forbidden");
        assert.equal(yield* failureCode(attach(strayThread, masters)), "forbidden");
        const fromMaster = yield* attach(masterThread, masters);
        const fromWriter = yield* attach(writerThread, writers);
        // The owner may attach any upload.
        yield* views.addAsset(ownerApp, {
          missionId,
          source: { _tag: "attachment", attachmentId: writers },
        });

        assert.equal(
          yield* failureCode(
            views.removeAsset(agent(writerThread), {
              missionId,
              assetId: fromMaster.ref.id as never,
            }),
          ),
          "forbidden",
        );
        yield* views.removeAsset(agent(writerThread), {
          missionId,
          assetId: fromWriter.ref.id as never,
        });
        yield* views.removeAsset(agent(masterThread), {
          missionId,
          assetId: fromMaster.ref.id as never,
        });
        assert.equal((yield* views.snapshot(missionId)).assets?.length, 1);
      }),
    ),
  );

  it.effect("keeps a request's image once, about that request, however often it is sent", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const upload = yield* threadAttachment(masterThread, png(6, 4));
        const source = { _tag: "attachment", attachmentId: upload } as const;
        const first = yield* addRequestImage(views, ownerApp, {
          missionId,
          requestId: "request-a",
          source,
        });
        assert.equal(first.path, NodePath.join(attachmentsDir, `${first.assetId}.png`));
        assert.isTrue(NodeFS.existsSync(first.path));
        assert.deepEqual(
          yield* addRequestImage(views, ownerApp, { missionId, requestId: "request-a", source }),
          first,
        );
        const other = yield* addRequestImage(views, ownerApp, {
          missionId,
          requestId: "request-b",
          source,
        });
        assert.notEqual(other.assetId, first.assetId);
        // His request images stay out of the views every agent reads, nameless.
        assert.deepEqual((yield* views.snapshot(missionId)).assets ?? [], []);
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const onServer = writeFile(NodePath.join(stateDir, "shots"), "salary.png", png(2, 2));
        assert.equal(
          yield* failureCode(
            addRequestImage(views, ownerApp, {
              missionId,
              requestId: "request-a",
              source: { _tag: "file", path: onServer },
            }),
          ),
          "invalid",
        );
        const fromDesk = yield* addRequestImage(
          views,
          { _tag: "owner-imessage", chat: "owner", inboundId: "spc-msg-1" },
          { missionId, requestId: "request-a", source: { _tag: "file", path: onServer } },
        );
        const store = yield* MissionStore.MissionStore;
        const added = (yield* store.recentEvents(missionId, 50)).filter(
          (event) => event.kind === "view.asset-added",
        );
        assert.lengthOf(added, 3);
        assert.isFalse(added.some((event) => JSON.stringify(event).includes("salary")));
        assert.isFalse(added.some((event) => JSON.stringify(event).includes("request-a")));
        assert.notEqual(fromDesk.assetId, first.assetId);
      }),
    ),
  );

  it.effect("a request message stores all its images or none, and can take back its own", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const good = {
          _tag: "attachment",
          attachmentId: yield* threadAttachment(masterThread, png(6, 4)),
        } as const;
        const bad = {
          _tag: "attachment",
          attachmentId: yield* threadAttachment(masterThread, new Uint8Array([1, 2, 3, 4])),
        } as const;
        const files = () =>
          NodeFS.readdirSync(attachmentsDir).filter((name) => name.startsWith("mission-"));
        assert.equal(
          yield* failureCode(
            views.addRequestImages(ownerApp, {
              missionId,
              requestId: "request-a",
              sources: [good, bad],
            }),
          ),
          "invalid",
        );
        assert.deepEqual(files(), []);

        const kept = yield* addRequestImage(views, ownerApp, {
          missionId,
          requestId: "request-a",
          source: good,
        });
        const other = {
          _tag: "attachment",
          attachmentId: yield* threadAttachment(masterThread, png(8, 8)),
        } as const;
        const retried = yield* views.addRequestImages(ownerApp, {
          missionId,
          requestId: "request-a",
          sources: [good, other],
        });
        assert.equal(retried.images[0]!.assetId, kept.assetId);
        assert.deepEqual(retried.created, [retried.images[1]!.assetId]);
        yield* views.dropRequestImages(missionId, retried.created);
        assert.deepEqual(files(), [`${kept.assetId}.png`]);
        const viewStore = yield* ViewStore.ViewStore;
        const active = (yield* viewStore.assets(missionId)).filter(
          (asset) => asset.status === "active",
        );
        assert.deepEqual(
          active.map((asset) => asset.id),
          [kept.assetId],
        );
      }),
    ),
  );

  it.effect("no event a reader can see names his request images", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const store = yield* MissionStore.MissionStore;
        const missions = yield* MissionService.MissionService;
        const upload = yield* threadAttachment(masterThread, png(6, 4));
        const source = { _tag: "attachment", attachmentId: upload } as const;
        const removed = yield* addRequestImage(views, ownerApp, {
          missionId,
          requestId: "request-a",
          source,
        });
        yield* views.removeAsset(ownerApp, { missionId, assetId: removed.assetId as never });
        const kept = yield* addRequestImage(views, ownerApp, {
          missionId,
          requestId: "request-b",
          source,
        });
        const card = yield* views.addAsset(ownerApp, { missionId, source });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* store.subscribe;
            yield* missions.setMissionStatus(ownerApp, { missionId, status: "archived" });
            yield* Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (item: MissionStreamItem) =>
                  item._tag === "upsert" &&
                  item.record._tag === "event" &&
                  item.record.record.kind === "view.assets-expired",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }),
        );
        const digest = JSON.stringify(yield* missions.digest(missionId, { _tag: "seq", seq: 0 }));
        assert.include(digest, "view.assets-expired");
        assert.include(digest, card.ref.id);
        assert.notInclude(digest, removed.assetId);
        assert.notInclude(digest, kept.assetId);
      }),
    ),
  );

  it.effect("archiving the mission expires its images and deletes their files", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const store = yield* MissionStore.MissionStore;
        const missions = yield* MissionService.MissionService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const upload = yield* threadAttachment(masterThread, png(10, 10));
        const added = yield* views.addAsset(ownerApp, {
          missionId,
          source: { _tag: "attachment", attachmentId: upload },
        });
        const stored = NodePath.join(attachmentsDir, `${added.ref.id}.png`);
        assert.isTrue(NodeFS.existsSync(stored));

        yield* Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* store.subscribe;
            yield* missions.setMissionStatus(ownerApp, { missionId, status: "archived" });
            yield* Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (item: MissionStreamItem) =>
                  item._tag === "upsert" &&
                  item.record._tag === "event" &&
                  item.record.record.kind === "view.assets-expired",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }),
        );
        // Views writes run one at a time, so this refusal also waits out the expiry.
        assert.equal(
          yield* failureCode(
            views.addAsset(ownerApp, {
              missionId,
              source: { _tag: "attachment", attachmentId: upload },
            }),
          ),
          "invalid",
        );
        assert.equal((yield* views.snapshot(missionId)).assets?.length, 0);
        assert.isFalse(NodeFS.existsSync(stored));
      }),
    ),
  );
});
