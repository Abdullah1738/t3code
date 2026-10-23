// @effect-diagnostics nodeBuiltinImport:off - the file an attachment id reaches is read off the disk.
/**
 * His request images are stored as `mission-<uuid>` attachments, and the
 * master's wake text names their paths, so anyone who can read threads can
 * name one. The attachment URL mint only asks for orchestration:read. This is
 * the owner check on top, the same one the requests desk uses for his words.
 * The master reads the images straight from disk and needs no URL. Copying
 * one into an ordinary mission image asks the same question.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AssetAttachmentNotFoundError,
  MissionError,
  MissionId,
  type AssetResource,
  type ClientSurface,
  type MissionAssetSource,
  type MissionProvenance,
  type MissionRecordRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import { isMasterOf } from "../core/master.ts";
import {
  componentProvenance,
  isOwnerSession,
  ownerAppProvenance,
  type OriginSession,
} from "../core/provenance.ts";
import { readsRequestWords } from "../router/requests.ts";
import type * as MissionStore from "../store/MissionStore.ts";

export interface RequestImageCaller {
  readonly surface: ClientSurface | undefined;
  readonly session: OriginSession;
  readonly sql: SqlClient.SqlClient;
}

/**
 * The stored name of the file an attachment id reaches, without its
 * extension. Ids are matched loosely (`./x`, `/x`, and on macOS any case
 * folding the disk does), so the real file name decides, not the id.
 */
const reachedFile = <E>(attachmentsDir: string, attachmentId: string, unreadable: E) =>
  Effect.try({
    try: () => {
      const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
      if (path === null) return null;
      const real = NodeFS.realpathSync.native(path);
      return NodePath.basename(real, NodePath.extname(real));
    },
    catch: () => unreadable,
  });

/**
 * Whether a stored file name is one of his request images, and whose mission
 * it belongs to. A mission file without a readable record counts as his, with
 * no mission, so only the owner's side gets past it.
 */
const requestImageNamed = (sql: SqlClient.SqlClient, name: string | null) =>
  name === null || !name.startsWith("mission-")
    ? Effect.succeed(null)
    : sql<{ readonly kind: string | null; readonly missionId: string }>`
        SELECT json_extract(value_json, '$.subject.kind') AS "kind", mission_id AS "missionId"
        FROM ardud_mission_views_current
        WHERE scope = 'asset' AND id = ${name}
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          if (row === undefined) return { missionId: null };
          return row.kind === "owner-request" ? { missionId: MissionId.make(row.missionId) } : null;
        }),
        Effect.orElseSucceed(() => ({ missionId: null })),
      );

/**
 * The request image an asset source would copy, if it is one. Only files in
 * the attachments folder count, by their name on disk, so `./`, links and
 * case folding reach the same answer. A path that can't be resolved is left
 * to the read, which fails on it anyway.
 */
export const requestImageSource = Effect.fn("MissionRequestImages.source")(function* (
  sql: SqlClient.SqlClient,
  attachmentsDir: string,
  source: MissionAssetSource,
) {
  const name = yield* Effect.sync(() => {
    try {
      const path =
        source._tag === "file"
          ? source.path
          : resolveAttachmentPathById({ attachmentsDir, attachmentId: source.attachmentId });
      if (path === null) return null;
      const real = NodeFS.realpathSync.native(path);
      if (NodePath.dirname(real) !== NodeFS.realpathSync.native(attachmentsDir)) return null;
      return NodePath.basename(real, NodePath.extname(real));
    } catch {
      return null;
    }
  });
  return yield* requestImageNamed(sql, name);
});

/**
 * Copying one of his request images into an ordinary mission image, or
 * filing a copy as his, needs the same right as reading his words: the owner's
 * side, or the master of the mission the image (or the copy) belongs to.
 */
export const guardRequestImageCopy = Effect.fn("MissionRequestImages.guardCopy")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly store: MissionStore.MissionStore["Service"];
  readonly attachmentsDir: string;
  readonly provenance: MissionProvenance;
  readonly missionId: MissionId;
  readonly source: MissionAssetSource;
  readonly subject: MissionRecordRef | null;
}) {
  if (readsRequestWords(input.provenance)) return;
  const held = yield* requestImageSource(input.sql, input.attachmentsDir, input.source);
  const masterOf = (missionId: MissionId | null) =>
    missionId === null
      ? Effect.succeed(false)
      : isMasterOf(input.store, missionId, input.provenance);
  const allowed =
    (held === null || (yield* masterOf(held.missionId))) &&
    (input.subject?.kind !== "owner-request" || (yield* masterOf(input.missionId)));
  if (!allowed) {
    return yield* new MissionError({
      code: "forbidden",
      detail: "Only the owner and the mission's master can copy his request images.",
    });
  }
});

/**
 * Fails like a missing attachment when the caller doesn't read his request
 * words and the attachment is one of his request images. A mission file
 * without a readable record is refused too.
 */
export const guardRequestImageUrl = Effect.fn("MissionRequestImages.guardUrl")(function* (
  caller: RequestImageCaller,
  resource: AssetResource,
) {
  if (resource._tag !== "attachment") return;
  const provenance = ownerAppProvenance(caller) ?? componentProvenance(caller.session);
  if (isOwnerSession(caller.session) || (provenance !== null && readsRequestWords(provenance))) {
    return;
  }
  const refused = new AssetAttachmentNotFoundError({ resource });
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const name = yield* reachedFile(attachmentsDir, resource.attachmentId, refused);
  if ((yield* requestImageNamed(caller.sql, name)) !== null) return yield* refused;
});
