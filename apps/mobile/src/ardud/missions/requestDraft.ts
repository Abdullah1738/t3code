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
  readonly uploading: boolean;
  readonly preview: FilePreviewSource | null;
  readonly setText: (text: string) => void;
  readonly setSelection: (selection: DraftSelection) => void;
  readonly attach: () => Promise<void>;
  readonly pasteImages: (uris: ReadonlyArray<string>) => void;
  readonly openChip: (source: string) => void;
  readonly closePreview: () => void;
  /** Uploads the chipped images, then hands the text and their ids to `deliver`. */
  readonly send: (deliver: Deliver) => Promise<boolean>;
  /** The words for a settle or reopen note; null, after saying so, while images are chipped. */
  readonly noteOnly: () => string | null;
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
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  // What the box holds, uploads included, for clearing and closing it.
  const held = useRef(images);
  useEffect(() => {
    held.current = images;
  }, [images]);
  useEffect(() => () => releaseUploads(held.current), []);

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

  const clear = () => {
    // A sent message's images are mission images by now; the uploads were only the way there.
    releaseUploads(held.current);
    held.current = [];
    setField(EMPTY_FIELD);
    setImages([]);
  };

  const send = async (deliver: Deliver): Promise<boolean> => {
    if (uploading) return false;
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
    setUploading(true);
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
    } finally {
      setUploading(false);
    }
  };

  return {
    text: field.text,
    selection: field.selection,
    context: requestDraftContext(field.text, images),
    words,
    empty: words === "" && chipped.length === 0,
    uploading,
    preview,
    setText: (text) => setField((current) => ({ ...current, text })),
    setSelection: (selection) => setField((current) => ({ ...current, selection })),
    attach: async () => {
      const picked = await pickComposerImages({ existingCount: 0 });
      if (picked.error) Alert.alert("Could not attach", picked.error);
      add(picked.images);
    },
    pasteImages: (uris) => {
      void convertPastedImagesToAttachments({ uris, existingCount: 0 }).then(add);
    },
    openChip: (source) => {
      const image = imageOfChip(source, images);
      if (!image) return;
      setPreview({ ...previewItem(image), gallery: chipped.map(previewItem) });
    },
    closePreview: () => setPreview(null),
    send,
    noteOnly: () => {
      if (chipped.length === 0) return words;
      Alert.alert("Images go in a reply", "A note is words only. Send the images first.");
      return null;
    },
    clear,
  };
}
