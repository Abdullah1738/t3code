import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { KanbanError, type ChatAttachment, type KanbanBlock, type KanbanBoardId } from "@t3tools/contracts";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import {
  attachmentIsPendingUpload,
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../../../orchestration-v2/AttachmentClaims.ts";

/** Owner id a board's files are claimed under; the store's segment is derived from it. */
const boardOwner = (boardId: KanbanBoardId) => `kanban-${boardId}`;

const cantPost = (attachment: ChatAttachment) =>
  new KanbanError({ code: "invalid", detail: `attachment ${attachment.name} can't be posted here` });

export interface BoardAttachments {
  /**
   * Copies pending uploads under this board's segment so a stored message never
   * points at another thread's or board's files. Ids already kept by this board
   * pass if the file still exists. Board files are kept on purpose: nothing
   * deletes them yet.
   *
   * Returns the blocks with claimed ids swapped in and the claimed paths, which
   * the caller releases if the message is not stored.
   */
  readonly claim: (
    boardId: KanbanBoardId,
    blocks: ReadonlyArray<KanbanBlock>,
  ) => Effect.Effect<
    { readonly blocks: KanbanBlock[]; readonly claimedPaths: ReadonlyArray<string> },
    KanbanError
  >;
  /** Absolute path an agent can open, or null when the attachment has none. */
  readonly pathOf: (attachment: ChatAttachment) => string | null;
  readonly release: (claimedPaths: ReadonlyArray<string>) => Effect.Effect<void>;
}

/**
 * Board attachment helpers over the services they need. The service resolves
 * ServerConfig and FileSystem once when it is built, so posting does not add
 * them to every call's requirements.
 */
export const makeBoardAttachments = (
  config: ServerConfig.ServerConfig["Service"],
  fileSystem: FileSystem.FileSystem,
): BoardAttachments => {
  const claim: BoardAttachments["claim"] = (boardId, blocks) =>
    Effect.gen(function* () {
      const attachments = blocks.flatMap((block) =>
        block._tag === "attachment" ? [block.attachment] : [],
      );
      if (attachments.length === 0) return { blocks: [...blocks], claimedPaths: [] as ReadonlyArray<string> };

      const owner = boardOwner(boardId);
      const segment = toSafeThreadAttachmentSegment(owner);
      const pending: ChatAttachment[] = [];
      for (const attachment of attachments) {
        const existing = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
        });
        if (attachmentIsPendingUpload(attachment)) {
          if (!existing) return yield* cantPost(attachment);
          pending.push(attachment);
          continue;
        }
        // The caller's name and mimeType decide the path agents open, so they must
        // resolve to the file the id already points at, not a different extension.
        const kept =
          segment !== null &&
          parseThreadSegmentFromAttachmentId(attachment.id) === segment &&
          existing !== null &&
          existing ===
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (!kept) return yield* cantPost(attachment);
      }

      const claimed = yield* claimPendingAttachments({
        threadId: owner,
        attachments: pending,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.mapError((error) => new KanbanError({ code: "invalid", detail: error.message })),
      );
      // claimPendingAttachments returns attachments in input order; key by the pending id it came from.
      const claimedById = new Map<string, ChatAttachment>(
        pending.map((attachment, index) => [attachment.id, claimed.attachments[index]!]),
      );
      const next = blocks.map((block): KanbanBlock => {
        if (block._tag !== "attachment") return block;
        const claimedCopy = claimedById.get(block.attachment.id);
        return claimedCopy
          ? {
              ...block,
              attachment: { ...block.attachment, id: claimedCopy.id, mimeType: claimedCopy.mimeType },
            }
          : block;
      });
      return { blocks: [...next], claimedPaths: claimed.claimedPaths };
    });

  return {
    claim,
    pathOf: (attachment) =>
      resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
    release: (claimedPaths) =>
      releaseClaimedAttachments(claimedPaths).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
  };
};
