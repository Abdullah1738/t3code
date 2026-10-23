// @effect-diagnostics nodeBuiltinImport:off - the file an attachment id reaches is read off the disk.
/**
 * His request images are stored as `mission-<uuid>` attachments, and the
 * master's wake text names their paths, so anyone who can read threads can
 * name one. The attachment URL mint only asks for orchestration:read. This is
 * the owner check on top, the same one the requests desk uses for his words.
 * The master reads the images straight from disk and needs no URL.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AssetAttachmentNotFoundError,
  type AssetResource,
  type ClientSurface,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import {
  componentProvenance,
  isOwnerSession,
  ownerAppProvenance,
  type OriginSession,
} from "../core/provenance.ts";
import { readsRequestWords } from "../router/requests.ts";

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
  if (name === null || !name.startsWith("mission-")) return;
  const rows = yield* caller.sql<{ readonly kind: string | null }>`
    SELECT json_extract(value_json, '$.subject.kind') AS "kind"
    FROM ardud_mission_views_current
    WHERE scope = 'asset' AND id = ${name}
  `.pipe(Effect.mapError(() => refused));
  const row = rows[0];
  if (row === undefined || row.kind === "owner-request") return yield* refused;
});
