// @effect-diagnostics nodeBuiltinImport:off - writes throwaway image files to attach.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  placeRequestImages,
  requestImageRef,
  requestTextParts,
  type AssetResource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import {
  agent,
  failureCode,
  laneThread,
  masterThread,
  missionId,
  otherMasterThread,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import { guardRequestImageUrl, type RequestImageCaller } from "./requestImageAccess.ts";
import { ViewService } from "./ViewService.ts";
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

const drop = (name: string) =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    NodeFS.mkdirSync(attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, name), png(6, 4));
  });

const threadAttachment = (threadId: string) =>
  Effect.gen(function* () {
    const id = `${toSafeThreadAttachmentSegment(threadId)}-${NodeCrypto.randomUUID()}`;
    yield* drop(`${id}.png`);
    return id;
  });

const callers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const as = (session: RequestImageCaller["session"], surface: RequestImageCaller["surface"]) =>
    ({ surface, session, sql }) satisfies RequestImageCaller;
  return {
    // A paired client the owner didn't pair, or a token with orchestration:read only.
    reader: as({ sessionId: "session-reader" }, "web"),
    owner: as(
      { sessionId: "session-owner", origin: { _tag: "owner", source: "paired-client" } },
      "web",
    ),
    bridge: as(
      { sessionId: "session-bridge", origin: { _tag: "component", component: "spectrum-bridge" } },
      undefined,
    ),
  };
});

const attachment = (attachmentId: string): AssetResource => ({ _tag: "attachment", attachmentId });

const refusal = (caller: RequestImageCaller, attachmentId: string) =>
  guardRequestImageUrl(caller, attachment(attachmentId)).pipe(
    Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "allowed" }),
  );

describe("request image URLs", () => {
  it.effect("a reader who sees the wake text can't mint his image; the owner can", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const { reader, owner, bridge } = yield* callers;
        const upload = yield* threadAttachment(masterThread);
        const stored = yield* views.addRequestImages(ownerApp, {
          missionId,
          requestId: "request-a",
          sources: [{ _tag: "attachment", attachmentId: upload }],
        });
        // What the master's wake carries, and what any thread reader can see.
        const wake = placeRequestImages("Like {image1}", [
          requestImageRef(1, stored.images[0]!.path),
        ]);
        const image = requestTextParts(wake).find((part) => part.type === "image");
        assert.equal(image?.type === "image" ? image.assetId : null, stored.images[0]!.assetId);
        const assetId = stored.images[0]!.assetId;

        for (const id of [assetId, `./${assetId}`, `/${assetId}`]) {
          assert.equal(yield* refusal(reader, id), "AssetAttachmentNotFoundError", id);
        }
        // Case-insensitive disks reach the same file under another spelling.
        const upper = assetId.toUpperCase();
        if (resolveAttachmentPathById({ attachmentsDir, attachmentId: upper }) !== null) {
          assert.equal(yield* refusal(reader, upper), "AssetAttachmentNotFoundError");
        }

        assert.equal(yield* refusal(owner, assetId), "allowed");
        assert.equal(yield* refusal(bridge, assetId), "allowed");
      }),
    ),
  );

  it.effect("other attachments and mission images stay open to readers", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const { reader } = yield* callers;
        const upload = yield* threadAttachment(masterThread);
        assert.equal(yield* refusal(reader, upload), "allowed");

        const shot = NodePath.join(NodeFS.realpathSync(attachmentsDir), "..", "shot.png");
        NodeFS.writeFileSync(shot, png(12, 8));
        const added = yield* views.addAsset(ownerApp, {
          missionId,
          source: { _tag: "file", path: shot },
          subject: { kind: "work-item", id: "wi-held" },
        });
        assert.equal(yield* refusal(reader, added.ref.id), "allowed");
        // Not on disk: the mint reports it missing on its own.
        assert.equal(yield* refusal(reader, `mission-${NodeCrypto.randomUUID()}`), "allowed");
      }),
    ),
  );

  it.effect("a mission file with no record is refused to readers", () =>
    fresh(
      Effect.gen(function* () {
        const { reader, owner } = yield* callers;
        const id = `mission-${NodeCrypto.randomUUID()}`;
        yield* drop(`${id}.png`);
        assert.equal(yield* refusal(reader, id), "AssetAttachmentNotFoundError");
        assert.equal(yield* refusal(owner, id), "allowed");
      }),
    ),
  );
});

/** One of his request images in m-1, and the path the master's wake names. */
const storedRequestImage = Effect.gen(function* () {
  yield* seed;
  const views = yield* ViewService;
  const upload = yield* threadAttachment(masterThread);
  const stored = yield* views.addRequestImages(ownerApp, {
    missionId,
    requestId: "request-a",
    sources: [{ _tag: "attachment", attachmentId: upload }],
  });
  return stored.images[0]!;
});

const fileSource = (path: string) => ({ _tag: "file" as const, path });

describe("request image copies", () => {
  it.effect("an agent other than the master can't copy his image by its wake path", () =>
    fresh(
      Effect.gen(function* () {
        const image = yield* storedRequestImage;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const dir = NodeFS.realpathSync(attachmentsDir);
        const filesBefore = NodeFS.readdirSync(dir).length;
        const real = NodeFS.realpathSync(image.path);

        const link = NodePath.join(dir, "..", "linked.png");
        NodeFS.symlinkSync(real, link);
        const file = NodePath.basename(real);
        // Template strings, since path.join would tidy the `.` and `..` away.
        const spellings = [
          image.path,
          real,
          `${dir}/./${file}`,
          `${dir}/../${NodePath.basename(dir)}/${file}`,
          link,
        ];
        // Case-insensitive disks reach the same file under another spelling.
        const upper = NodePath.join(dir, file.toUpperCase());
        if (NodeFS.existsSync(upper)) spellings.push(upper);

        for (const path of spellings) {
          for (const caller of [agent(writerThread), agent(laneThread)]) {
            assert.equal(
              yield* failureCode(views.addAsset(caller, { missionId, source: fileSource(path) })),
              "forbidden",
              path,
            );
          }
        }
        assert.deepEqual((yield* views.snapshot(missionId)).assets ?? [], []);
        assert.equal(NodeFS.readdirSync(dir).length, filesBefore);
      }),
    ),
  );

  it.effect("the owner and the mission's master can still copy it", () =>
    fresh(
      Effect.gen(function* () {
        const image = yield* storedRequestImage;
        const views = yield* ViewService;
        const real = NodeFS.realpathSync(image.path);
        for (const caller of [ownerApp, agent(masterThread)]) {
          yield* views.addAsset(caller, { missionId, source: fileSource(real) });
        }
        assert.equal((yield* views.snapshot(missionId)).assets?.length, 2);
      }),
    ),
  );

  it.effect("another mission's master can't copy it into theirs", () =>
    fresh(
      Effect.gen(function* () {
        const image = yield* storedRequestImage;
        yield* seedOther;
        const views = yield* ViewService;
        assert.equal(
          yield* failureCode(
            views.addAsset(agent(otherMasterThread), {
              missionId: otherMissionId,
              source: fileSource(NodeFS.realpathSync(image.path)),
            }),
          ),
          "forbidden",
        );
      }),
    ),
  );

  it.effect("only his side and the master can file a copy as his", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const shot = NodePath.join(NodeFS.realpathSync(attachmentsDir), "..", "shot.png");
        NodeFS.writeFileSync(shot, png(12, 8));
        const subject = { kind: "owner-request" as const, id: "request-a" };
        assert.equal(
          yield* failureCode(
            views.addAsset(agent(writerThread), { missionId, source: fileSource(shot), subject }),
          ),
          "forbidden",
        );
        yield* views.addAsset(agent(masterThread), {
          missionId,
          source: fileSource(shot),
          subject,
        });
      }),
    ),
  );

  it.effect("ordinary images still copy for any agent of the mission", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const shot = NodePath.join(NodeFS.realpathSync(attachmentsDir), "..", "shot.png");
        NodeFS.writeFileSync(shot, png(12, 8));
        const added = yield* views.addAsset(agent(writerThread), {
          missionId,
          source: fileSource(shot),
          subject: { kind: "work-item", id: "wi-held" },
        });
        // A mission image that isn't his copies again too.
        const copy = NodePath.join(NodeFS.realpathSync(attachmentsDir), `${added.ref.id}.png`);
        yield* views.addAsset(agent(writerThread), { missionId, source: fileSource(copy) });
        yield* views.addAsset(agent(writerThread), {
          missionId,
          source: { _tag: "attachment", attachmentId: yield* threadAttachment(writerThread) },
        });
        assert.equal((yield* views.snapshot(missionId)).assets?.length, 3);
      }),
    ),
  );
});
