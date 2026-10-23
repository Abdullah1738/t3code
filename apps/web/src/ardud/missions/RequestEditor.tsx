import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type ReactNode,
} from "react";
import { PaperclipIcon } from "lucide-react";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ServerProviderSkill } from "@t3tools/contracts";
import type { RequestDraftImage } from "@t3tools/client-runtime/ardud/missions";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../components/ComposerPromptEditor";
import {
  ComposerContextActionsContext,
  composerContextRecordsFromDraft,
  type ComposerContextActions,
} from "../../components/composerContextPresentation";
import { ExpandedImageDialog } from "../../components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../../components/chat/ExpandedImagePreview";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "../../components/chat/composerAttachmentFiles";
import {
  makeWorkspaceFileDropHandlers,
  splitTransferredFiles,
} from "../../components/chat/workspaceFileDrop";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  releaseAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { imageContextReference } from "../../lib/composerContextRecords";
import {
  inlineContextReferenceReplacement,
  stripInlineContextReferences,
} from "../../lib/composerContextReferences";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { cn, randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { chippedImages, REQUEST_IMAGE_LIMIT, requestDraftImages } from "./requestDraft";

// The owner's words to the master with images as chips where he put them: the
// thread composer's editor, upload queue and lightbox, without its draft store.

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const noop = () => {};

function warn(title: string, description?: string) {
  toastManager.add({ type: "warning", title, description });
}

function discard(image: ComposerImageAttachment) {
  releaseAttachmentUpload(image.id);
  URL.revokeObjectURL(image.previewUrl);
}

function attachable(files: ReadonlyArray<File>, room: number): File[] {
  const accepted: File[] = [];
  for (const file of files) {
    const kind = classifyComposerAttachmentFile(file);
    if (kind === "file") warn("Only images", `'${file.name}' isn't an image.`);
    else if (kind === "unsupported-image")
      warn("Couldn't attach", `'${file.name}' is not a supported image type.`);
    else accepted.push(normalizeComposerImageFileMimeType(file));
  }
  if (accepted.length > room) {
    warn("Too many images", `A message takes up to ${REQUEST_IMAGE_LIMIT} images.`);
    return accepted.slice(0, Math.max(0, room));
  }
  return accepted;
}

async function prepared(files: ReadonlyArray<File>): Promise<ComposerImageAttachment[]> {
  const images: ComposerImageAttachment[] = [];
  for (const file of files) {
    const result = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!result.ok) {
      warn(
        "Couldn't attach",
        result.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`,
      );
      continue;
    }
    images.push({
      type: "image",
      id: randomUUID(),
      name: result.file.name || "image",
      mimeType: result.file.type,
      sizeBytes: result.file.size,
      previewUrl: URL.createObjectURL(result.file),
      file: result.file,
    });
  }
  return images;
}

export type RequestDraft = ReturnType<typeof useRequestDraft>;

export function useRequestDraft() {
  const environmentId = usePrimaryEnvironmentId();
  const editor = useRef<ComposerPromptEditorHandle | null>(null);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<ReadonlyArray<ComposerImageAttachment>>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  // Closing the box drops its pending uploads; a sent draft has already cleared.
  const held = useRef(images);
  useEffect(() => {
    held.current = images;
  }, [images]);
  useEffect(() => () => held.current.forEach(discard), []);

  const chipped = chippedImages(text, images);
  const words = stripInlineContextReferences(text).trim();
  const empty = words === "" && chipped.length === 0;

  const setEditor = useStableCallback((handle: ComposerPromptEditorHandle | null) => {
    editor.current = handle;
  });

  const onChange = useStableCallback((value: string, nextCursor: number) => {
    setText(value);
    setCursor(nextCursor);
  });

  // Chips go in at the caret, like the thread composer; past the end when
  // the editor has moved on since the files were read.
  const insertImages = useStableCallback((added: ReadonlyArray<ComposerImageAttachment>) => {
    const snapshot = editor.current?.readSnapshot();
    const at = snapshot && snapshot.value === text ? snapshot.expandedCursor : text.length;
    const edit = inlineContextReferenceReplacement(
      text,
      { start: at, end: at },
      added.map(imageContextReference),
    );
    const next = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
    const nextCursor = collapseExpandedComposerCursor(next, edit.start + edit.text.length);
    setText(next);
    setCursor(nextCursor);
    setImages([...images, ...added]);
    window.requestAnimationFrame(() => editor.current?.focusAt(nextCursor));
  });

  const addFiles = useStableCallback(async (files: ReadonlyArray<File>) => {
    if (environmentId === null) {
      warn("Couldn't attach", "Not connected to the server.");
      return;
    }
    const added = await prepared(attachable(files, REQUEST_IMAGE_LIMIT - chipped.length));
    if (added.length === 0) return;
    insertImages(added);
    for (const image of added) startAttachmentUpload({ environmentId, image });
  });

  const onPaste = useStableCallback((event: ClipboardEvent<HTMLElement>) => {
    const { files } = splitTransferredFiles(event.clipboardData);
    const plainText = event.clipboardData.getData("text/plain");
    if (files.length === 0 || !shouldHandleComposerAttachmentPaste({ files, plainText })) return;
    event.preventDefault();
    event.stopPropagation();
    void addFiles(files);
  });

  const expandImage = useStableCallback((imageId: string) => {
    const index = chipped.findIndex((image) => image.id === imageId);
    if (index < 0) return;
    setPreview({
      images: chipped.map((image) => ({
        src: image.previewUrl,
        name: image.name,
        mimeType: image.mimeType,
      })),
      index,
    });
  });

  const clear = () => {
    images.forEach(discard);
    setImages([]);
    setText("");
    setCursor(0);
  };

  /**
   * Sends the words with each chip's uploaded image, and clears the box once
   * `deliver` reports it went. A draft still uploading says so instead.
   */
  const send = useStableCallback(
    async (
      deliver: (text: string, images: ReadonlyArray<RequestDraftImage>) => Promise<boolean>,
    ) => {
      const ready = requestDraftImages(text, images, uploads);
      if (!ready.ok) {
        warn("Not sent yet", ready.reason);
        return false;
      }
      setBusy(true);
      const sent = await deliver(text, ready.images);
      setBusy(false);
      if (sent) clear();
      return sent;
    },
  );

  /** Another action on the box's words alone (Settle with note, Reopen). */
  const run = useStableCallback(
    async (action: (words: string) => Promise<boolean>, clearOnDone: boolean) => {
      setBusy(true);
      const done = await action(words);
      setBusy(false);
      if (done && clearOnDone) clear();
      return done;
    },
  );

  return {
    text,
    cursor,
    words,
    empty,
    busy,
    dragging,
    preview,
    environmentId,
    contextRecords: composerContextRecordsFromDraft({
      terminalContexts: [],
      images: chipped,
      uploadsByImageId: uploads,
    }),
    setEditor,
    setDragging,
    setPreview,
    onChange,
    onPaste,
    expandImage,
    addFiles,
    send,
    run,
  };
}

/**
 * The draft's editor in the field look of the box it replaces. Cmd/Ctrl+Enter
 * sends; image files paste or drop in at the caret.
 */
export function RequestEditor(props: {
  draft: RequestDraft;
  label: string;
  placeholder: string;
  autoFocus?: boolean | undefined;
  onSubmit: () => void;
  onEscape?: (() => void) | undefined;
  /** Focus left the editor and its buttons with nothing written. */
  onLeaveEmpty?: (() => void) | undefined;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const { draft } = props;
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const setEditor = draft.setEditor;
  const autoFocus = props.autoFocus ?? false;
  useEffect(() => {
    setEditor(editorRef.current);
    if (!autoFocus) return () => setEditor(null);
    const frame = window.requestAnimationFrame(() => editorRef.current?.focusAtEnd());
    return () => {
      window.cancelAnimationFrame(frame);
      setEditor(null);
    };
  }, [autoFocus, setEditor]);
  const actions: ComposerContextActions = {
    environmentId: draft.environmentId,
    expandImage: draft.expandImage,
    expandVideo: noop,
    openFile: noop,
    openMention: noop,
    openPullRequest: noop,
  };
  const drop = makeWorkspaceFileDropHandlers({
    setDragActive: draft.setDragging,
    addFiles: (files) => void draft.addFiles(files),
    addFolders: () => warn("Only images", "Drop image files, not folders."),
  });
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    // The file picker takes the window's focus; that isn't leaving the box.
    if (!document.hasFocus()) return;
    if (props.onLeaveEmpty && draft.empty) props.onLeaveEmpty();
  };
  return (
    <ComposerContextActionsContext value={actions}>
      <div
        className={cn("flex min-w-0 flex-1 items-end gap-1", props.className)}
        onBlur={onBlur}
        {...drop}
      >
        <div
          className={cn(
            "relative min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 py-1.5 shadow-xs/5 ring-ring/24 focus-within:border-ring focus-within:ring-3 focus-within:ring-inset dark:bg-input/32",
            draft.dragging && "border-ring ring-3 ring-inset",
          )}
        >
          <ComposerPromptEditor
            value={draft.text}
            cursor={draft.cursor}
            contextRecords={draft.contextRecords}
            skills={NO_SKILLS}
            disabled={false}
            placeholder={props.placeholder}
            ariaLabel={props.label}
            className="max-h-64 min-h-12"
            editorRef={editorRef}
            onPaste={draft.onPaste}
            onChange={draft.onChange}
            onCommandKeyDown={(key, event) => {
              if (key === "Enter" && (event.metaKey || event.ctrlKey)) {
                props.onSubmit();
                return true;
              }
              if (key === "Escape" && props.onEscape) {
                props.onEscape();
                return true;
              }
              return false;
            }}
          />
        </div>
        {props.children}
      </div>
      {draft.preview ? (
        <ExpandedImageDialog preview={draft.preview} onClose={() => draft.setPreview(null)} />
      ) : null}
    </ComposerContextActionsContext>
  );
}

/** The paperclip: images from disk, or the photo library and camera on iPad/iPhone web. */
export function AttachImagesButton(props: { draft: RequestDraft; disabled?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void props.draft.addFiles(files);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Attach images"
              disabled={props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => input.current?.click()}
            />
          }
        >
          <PaperclipIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup>Attach images</TooltipPopup>
      </Tooltip>
    </>
  );
}
