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
import { masterThread, missionId, ownerApp, seed } from "../asks/AsksService.testkit.ts";
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
