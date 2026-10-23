import type { RequestDraftImage } from "@t3tools/client-runtime/ardud/missions";
import type { EnvironmentId, OrchestrationMessageContext } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import type { FilePreviewItem, FilePreviewSource } from "../../components/FilePreviewModal.types";
import {
  prepareTurnAttachments,
  releasePendingAttachmentUploads,
} from "../../lib/attachmentUpload";
import {
  convertPastedImagesToAttachments,
  isComposerImageAttachment,
  pickComposerImages,
  type DraftComposerImageAttachment,
} from "../../lib/composerImages";
import { useMissionsEnvironmentId } from "./missionsStore";
import {
  chippedImages,
  draftWords,
  imageOfChip,
  insertImageChips,
  REQUEST_IMAGE_LIMIT,
  requestDraftContext,
  type DraftSelection,
} from "./requestDraftModel";

type Deliver = (text: string, images: ReadonlyArray<RequestDraftImage>) => Promise<boolean>;

/**
 * A request, reply or Discuss draft: his words with image chips where he put
 * them. Images upload when he sends, and only the ones still chipped go.
 */
export interface RequestDraft {
  readonly text: string;
  readonly selection: DraftSelection;
  readonly context: OrchestrationMessageContext | undefined;
  /** The words alone, for a settle or reopen note. */
  readonly words: string;
  readonly empty: boolean;
  /** A send or note is in flight; the box takes no words or images until it ends. */
  readonly busy: boolean;
  readonly preview: FilePreviewSource | null;
  readonly setText: (text: string) => void;
  readonly setSelection: (selection: DraftSelection) => void;
  readonly attach: () => Promise<void>;
  readonly pasteImages: (uris: ReadonlyArray<string>) => void;
  readonly openChip: (source: string) => void;
  readonly closePreview: () => void;
  /** Uploads the chipped images, then hands the text and their ids to `deliver`. */
  readonly send: (deliver: Deliver) => Promise<boolean>;
  /**
   * Runs a settle or reopen with the words alone, and clears the box once it's
   * done. Refused, after saying so, while images are chipped.
   */
  readonly sendNote: (action: (note: string) => Promise<boolean>) => Promise<boolean>;
  readonly clear: () => void;
}

interface Field {
  readonly text: string;
  readonly selection: DraftSelection;
}

const EMPTY_FIELD: Field = { text: "", selection: { start: 0, end: 0 } };

function previewItem(image: DraftComposerImageAttachment): FilePreviewItem {
  return { kind: "image", uri: image.previewUri, name: image.name, mimeType: image.mimeType };
}

/** Drops uploads a draft made but never sent; best effort, the server sweeps the rest. */
function releaseUploads(images: ReadonlyArray<DraftComposerImageAttachment>): void {
  const byEnvironment = new Map<EnvironmentId, string[]>();
  for (const image of images) {
    if (!image.uploadedAttachmentId || !image.uploadEnvironmentId) continue;
    const ids = byEnvironment.get(image.uploadEnvironmentId) ?? [];
    ids.push(image.uploadedAttachmentId);
    byEnvironment.set(image.uploadEnvironmentId, ids);
  }
  for (const [environmentId, ids] of byEnvironment) {
    void releasePendingAttachmentUploads(environmentId, ids).catch(() => undefined);
  }
}

export function useRequestDraft(): RequestDraft {
  const environmentId = useMissionsEnvironmentId();
  const [field, setField] = useState<Field>(EMPTY_FIELD);
  const [images, setImages] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  // What the box holds, uploads included, for clearing and closing it.
  const held = useRef(images);
  useEffect(() => {
    held.current = images;
  }, [images]);
  useEffect(() => () => releaseUploads(held.current), []);
  // A send in flight takes no new images, and images still being read when a
  // message went were meant for it, so they don't land in the next one.
  const sending = useRef(false);
  const cleared = useRef(0);

  const chipped = chippedImages(field.text, images);
  const words = draftWords(field.text);

  const add = (picked: ReadonlyArray<DraftComposerImageAttachment>) => {
    const room = Math.max(0, REQUEST_IMAGE_LIMIT - chipped.length);
    const kept = picked.slice(0, room);
    if (kept.length < picked.length) {
      Alert.alert("Too many images", `A message takes up to ${REQUEST_IMAGE_LIMIT} images.`);
    }
    if (kept.length === 0) return;
    setImages((current) => [...current, ...kept]);
    setField((current) => insertImageChips(current.text, current.selection, kept));
  };

  /** Adds images picked or pasted before now, unless a message went or is going meanwhile. */
  const addFrom = async (read: () => Promise<ReadonlyArray<DraftComposerImageAttachment>>) => {
    if (sending.current) {
      Alert.alert("Not attached", "Wait for the message to send, then attach it.");
      return;
    }
    const round = cleared.current;
    const picked = await read();
    if (sending.current || cleared.current !== round) {
      if (picked.length > 0) {
        Alert.alert("Not attached", "A message went while it was read. Attach it again.");
      }
      return;
    }
    add(picked);
  };

  const clear = () => {
    cleared.current += 1;
    // A sent message's images are mission images by now; the uploads were only the way there.
    releaseUploads(held.current);
    held.current = [];
    setField(EMPTY_FIELD);
    setImages([]);
  };

  // Set before the first await, so a second tap in the same frame sees it.
  const whileSending = async (work: () => Promise<boolean>): Promise<boolean> => {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const deliverDraft = async (deliver: Deliver): Promise<boolean> => {
    const { text } = field;
    if (chipped.length === 0) {
      const sent = await deliver(text, []);
      if (sent) clear();
      return sent;
    }
    if (environmentId === null) {
      Alert.alert("Could not send", "Connect to the server to send images.");
      return false;
    }
    try {
      const prepared = await prepareTurnAttachments({
        environmentId,
        attachments: chipped,
        supportsImageUploads: true,
      });
      if (prepared.status !== "ready") return false;
      // A failed send keeps the uploads, so trying again doesn't upload twice.
      const uploaded = new Map(
        prepared.draftAttachments
          .filter(isComposerImageAttachment)
          .map((image) => [image.id, image]),
      );
      const annotated = images.map((image) => uploaded.get(image.id) ?? image);
      held.current = annotated;
      setImages(annotated);
      const refs = chipped.flatMap((image, index): RequestDraftImage[] => {
        const attachment = prepared.attachments[index];
        return attachment && "id" in attachment && attachment.id !== undefined
          ? [{ contextId: image.id, attachmentId: attachment.id }]
          : [];
      });
      if (refs.length < chipped.length) {
        Alert.alert("Could not send", "Some images didn't upload. Try again.");
        return false;
      }
      const sent = await deliver(text, refs);
      if (sent) clear();
      return sent;
    } catch (error) {
      Alert.alert(
        "Could not send",
        error instanceof Error ? error.message : "The images didn't upload.",
      );
      return false;
    }
  };

  return {
    text: field.text,
    selection: field.selection,
    context: requestDraftContext(field.text, images),
    words,
    empty: words === "" && chipped.length === 0,
    busy,
    preview,
    setText: (text) => setField((current) => ({ ...current, text })),
    setSelection: (selection) => setField((current) => ({ ...current, selection })),
    attach: () =>
      addFrom(async () => {
        const picked = await pickComposerImages({ existingCount: 0 });
        if (picked.error) Alert.alert("Could not attach", picked.error);
        return picked.images;
      }),
    pasteImages: (uris) => {
      void addFrom(() => convertPastedImagesToAttachments({ uris, existingCount: 0 }));
    },
    openChip: (source) => {
      const image = imageOfChip(source, images);
      if (!image) return;
      setPreview({ ...previewItem(image), gallery: chipped.map(previewItem) });
    },
    closePreview: () => setPreview(null),
    send: (deliver) => whileSending(() => deliverDraft(deliver)),
    sendNote: async (action) => {
      if (chipped.length > 0) {
        Alert.alert("Images go in a reply", "A note is words only. Send the images first.");
        return false;
      }
      const done = await whileSending(() => action(words));
      if (done) clear();
      return done;
    },
    clear,
  };
}
