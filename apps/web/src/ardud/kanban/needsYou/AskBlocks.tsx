/**
 * What an ask shows beside its question: text, a folded detail, a page, a
 * linked card, pictures, video, audio and files. Pictures and videos open in
 * the full-size viewer; other files open in the app's own file preview.
 */
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { EnvironmentId, KanbanAskBlock, KanbanOwnerAsk } from "@t3tools/contracts";
import { filePreviewKind, type FilePreviewKind } from "@t3tools/shared/filePreview";
import {
  ChevronRightIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  Maximize2Icon,
  MusicIcon,
  PlayIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useAssetUrls } from "../../../assets/assetUrls";
import { AttachmentFilePreview } from "../../../components/files/AttachmentFilePreview";
import { AttachmentImage } from "../../../components/media/AttachmentImage";
import { cn } from "../../../lib/utils";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { KanbanMarkdown } from "../links";
import { AskHtmlFrame } from "./HtmlFrame";
import type { AskMediaItem } from "./MediaViewer";
import { Bar, Btn, Layer } from "./ui";

type Attachment = Extract<KanbanAskBlock, { _tag: "attachment" }>["attachment"];

const kindOf = (attachment: Attachment): FilePreviewKind =>
  attachment.type === "image"
    ? "image"
    : filePreviewKind({ name: attachment.name, mimeType: attachment.mimeType });

export interface AskMedia {
  /** Pictures and videos in the order the ask shows them. */
  readonly items: ReadonlyArray<AskMediaItem>;
  /** Where a block sits in `items`; absent for a block that is not a picture or video. */
  readonly indexOf: ReadonlyMap<number, number>;
  /** Signed URLs of every attachment block, by block index. */
  readonly urlOf: ReadonlyMap<number, string | null>;
  /** Text blocks that are the caption of the picture or video before them. */
  readonly captions: ReadonlySet<number>;
  /** Files held here and not on the server, by block index. */
  readonly fileOf?: ReadonlyMap<number, Blob>;
}

const shortCaption = (block: KanbanAskBlock | undefined): string | null =>
  block?._tag === "md" && block.truncated !== true && block.text.length <= 240 ? block.text : null;

/** The ask's pictures and videos with their URLs, for the blocks and the viewer to share. */
export function useAskMedia(ask: KanbanOwnerAsk): AskMedia {
  const environmentId = usePrimaryEnvironmentId();
  const blocks = ask.blocks ?? [];
  const attachments = blocks.flatMap((block, index) =>
    block._tag === "attachment" ? [{ index, attachment: block.attachment }] : [],
  );
  const urls = useAssetUrls(
    environmentId ?? ("" as EnvironmentId),
    attachments.map(({ attachment }) => ({
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
    })),
  );
  return askMediaOf(
    blocks,
    new Map<number, string | null>(
      attachments.map(({ index }, position) => [index, urls[position] ?? null]),
    ),
  );
}

/**
 * The same, from URLs already in hand. `fileOf` is for files that are not on
 * the server (the reference page's samples): they open from the Blob itself.
 */
export function askMediaOf(
  blocks: ReadonlyArray<KanbanAskBlock>,
  urlOf: ReadonlyMap<number, string | null>,
  fileOf?: ReadonlyMap<number, Blob>,
): AskMedia {
  const items: Array<AskMediaItem> = [];
  const indexOf = new Map<number, number>();
  const captions = new Set<number>();
  blocks.forEach((block, index) => {
    // A short line of text right after a picture is its caption.
    const caption = shortCaption(blocks[index + 1]);
    if (block._tag === "image") {
      if (caption !== null) captions.add(index + 1);
      indexOf.set(index, items.length);
      items.push({
        key: `b${index}`,
        kind: "image",
        name: block.alt ?? "Picture",
        caption: caption ?? block.alt ?? null,
        src: block.url,
      });
      return;
    }
    if (block._tag !== "attachment") return;
    const kind = kindOf(block.attachment);
    if (kind !== "image" && kind !== "video") return;
    if (caption !== null) captions.add(index + 1);
    indexOf.set(index, items.length);
    items.push({
      key: `b${index}`,
      kind,
      name: block.attachment.name,
      mimeType: block.attachment.mimeType,
      sizeBytes: block.attachment.sizeBytes,
      caption,
      src: urlOf.get(index) ?? null,
    });
  });
  return { items, indexOf, urlOf, captions, ...(fileOf ? { fileOf } : {}) };
}

/** One picture of the ask as a thumbnail that opens the viewer. */
export function BlockPicture(props: {
  media: AskMedia;
  index: number;
  onOpen: (mediaIndex: number) => void;
  className?: string;
  /** Inside another control (an option): draws the picture only. */
  bare?: boolean;
}) {
  const mediaIndex = props.media.indexOf.get(props.index);
  const item = mediaIndex === undefined ? undefined : props.media.items[mediaIndex];
  if (mediaIndex === undefined || !item) return null;
  const picture =
    item.src === null ? (
      <Bar className={cn("h-40 w-56 rounded-xl", props.className)} />
    ) : item.kind === "video" ? (
      <span
        className={cn(
          "grid h-40 w-56 place-items-center rounded-xl bg-(--m-chip) text-(--m-muted)",
          props.className,
        )}
      >
        <PlayIcon className="size-6" />
      </span>
    ) : (
      <AttachmentImage
        name={item.name}
        mimeType={item.mimeType}
        src={item.src}
        alt={item.caption ?? item.name}
        loading="lazy"
        className={cn("max-h-72 max-w-full rounded-xl object-contain", props.className)}
      />
    );
  if (props.bare) return picture;
  return (
    <button
      type="button"
      aria-label={`Open ${item.name} full size`}
      onClick={() => props.onOpen(mediaIndex)}
      className="group relative block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-xl outline-none ring-1 ring-(--m-rule) after:pointer-events-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-(--m-accent) focus-visible:after:ring-inset"
    >
      {picture}
      <span
        aria-hidden
        className="absolute end-2 top-2 grid size-7 place-items-center rounded-full bg-(--m-ground)/90 text-(--m-text) opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <Maximize2Icon className="size-3.5" />
      </span>
    </button>
  );
}

const FILE_ICONS: Partial<Record<FilePreviewKind, typeof FileIcon>> = {
  pdf: FileTextIcon,
  text: FileTextIcon,
  markdown: FileTextIcon,
  audio: MusicIcon,
};

/** Whether this browser draws a PDF in the page; a phone browser may only offer to open it. */
const drawsPdf = (): boolean => typeof navigator !== "undefined" && navigator.pdfViewerEnabled;

/**
 * The first page of a PDF, drawn by the browser's own viewer with its chrome
 * off. It is a picture of the page: a click anywhere opens the whole document.
 */
function PdfPage(props: { name: string; url: string | null; onOpen: () => void }) {
  return (
    <div className="relative h-72 overflow-hidden rounded-xl bg-(--m-surface) ring-1 ring-(--m-rule)">
      {props.url === null ? (
        <Bar className="size-full rounded-none" />
      ) : (
        <embed
          aria-hidden
          tabIndex={-1}
          src={`${props.url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
          type="application/pdf"
          // A few pixels past the frame on every side: the viewer keeps a dark gutter around the page.
          className="pointer-events-none absolute -inset-1 size-[calc(100%+0.5rem)] max-w-none"
        />
      )}
      <button
        type="button"
        aria-label={`Open ${props.name}`}
        onClick={props.onOpen}
        className="absolute inset-0 cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      />
    </div>
  );
}

/** The same for a PDF on the server: the viewer needs it served inline, and the block's own URL is a download. */
function ServedPdfPage(props: {
  attachment: Attachment;
  environmentId: EnvironmentId;
  onOpen: () => void;
}) {
  const { attachment } = props;
  const [url] = useAssetUrls(props.environmentId, [
    {
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
      disposition: "inline" as const,
    },
  ]);
  return <PdfPage name={attachment.name} url={url ?? null} onOpen={props.onOpen} />;
}

function FileCard(props: {
  attachment: Attachment;
  kind: FilePreviewKind;
  /** A file held here and not on the server, with the URL it is shown from. */
  file?: Blob | undefined;
  fileUrl?: string | null;
}) {
  const { attachment, kind } = props;
  const environmentId = usePrimaryEnvironmentId();
  const [open, setOpen] = useState(false);
  const Icon = /\.(csv|tsv|xlsx?)$/i.test(attachment.name)
    ? FileSpreadsheetIcon
    : (FILE_ICONS[kind] ?? FileIcon);
  const local = props.file !== undefined;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {kind !== "pdf" || !drawsPdf() ? null : local ? (
        <PdfPage name={attachment.name} url={props.fileUrl ?? null} onOpen={() => setOpen(true)} />
      ) : environmentId !== null ? (
        <ServedPdfPage
          attachment={attachment}
          environmentId={environmentId}
          onOpen={() => setOpen(true)}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-3 rounded-xl py-2 ps-3.5 pe-2 ring-1 ring-(--m-rule)">
        <Icon aria-hidden className="size-5 shrink-0 text-(--m-muted)" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{attachment.name}</p>
          <p className="text-xs text-(--m-muted) tabular-nums">
            {formatAttachmentSize(attachment.sizeBytes)}
            {kind === "unsupported" ? " · no preview" : ""}
          </p>
        </div>
        <Btn size="sm" disabled={!local && environmentId === null} onClick={() => setOpen(true)}>
          <Maximize2Icon aria-hidden />
          Open
        </Btn>
      </div>
      <Layer
        open={open}
        onClose={() => setOpen(false)}
        title={attachment.name}
        side="center"
        wide
        tall
        bare
        bodyClassName="flex min-h-0 flex-col overflow-hidden rounded-2xl p-0"
      >
        {open && (local || environmentId !== null) ? (
          <AttachmentFilePreview
            name={attachment.name}
            mimeType={attachment.mimeType}
            sizeBytes={attachment.sizeBytes}
            {...(props.file !== undefined
              ? { file: props.file }
              : { asset: { environmentId: environmentId!, attachmentId: attachment.id } })}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </Layer>
    </div>
  );
}

function Stub(props: { children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      {props.children}
      <Bar className="h-3.5 w-11/12" />
      <Bar className="h-3.5 w-3/4" />
    </div>
  );
}

function Block(props: {
  block: KanbanAskBlock;
  index: number;
  media: AskMedia;
  onOpenMedia: (mediaIndex: number) => void;
  onOpenCard: (cardId: string) => void;
}) {
  const { block } = props;
  switch (block._tag) {
    case "md":
      return block.truncated ? (
        <Stub>
          <KanbanMarkdown text={block.text} />
        </Stub>
      ) : (
        <div className="[overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <KanbanMarkdown text={block.text} />
        </div>
      );
    case "collapse":
      return (
        <details className="group rounded-xl ring-1 ring-(--m-rule)">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3.5 py-2.5 font-medium outline-none hover:bg-(--m-surface) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              aria-hidden
              className="size-4 shrink-0 text-(--m-muted) transition-transform duration-150 group-open:rotate-90"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{block.title}</span>
          </summary>
          <div className="border-t border-(--m-rule) px-3.5 py-3 [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {block.truncated ? (
              <Stub>
                <KanbanMarkdown text={block.text} />
              </Stub>
            ) : (
              <KanbanMarkdown text={block.text} />
            )}
          </div>
        </details>
      );
    case "html":
      return block.truncated ? (
        <Bar className="h-48 rounded-2xl" />
      ) : (
        <AskHtmlFrame html={block.html} title={block.title} height={block.height} />
      );
    case "card":
      return (
        <Btn size="sm" onClick={() => props.onOpenCard(block.cardId)} className="self-start">
          <SquareArrowOutUpRightIcon aria-hidden />
          Open the linked card
        </Btn>
      );
    case "image":
      return <BlockPicture media={props.media} index={props.index} onOpen={props.onOpenMedia} />;
    case "attachment": {
      const kind = kindOf(block.attachment);
      const url = props.media.urlOf.get(props.index) ?? null;
      if (kind === "image") {
        return <BlockPicture media={props.media} index={props.index} onOpen={props.onOpenMedia} />;
      }
      if (kind === "video") {
        const mediaIndex = props.media.indexOf.get(props.index);
        return (
          // No wider than the demo's player: in a wide column it would be mostly black bars.
          <figure className="flex max-w-[560px] flex-col gap-1.5">
            {url === null ? (
              <Bar className="aspect-video w-full rounded-xl" />
            ) : (
              <video
                controls
                playsInline
                preload="metadata"
                src={url}
                aria-label={block.attachment.name}
                className="max-h-96 w-full rounded-xl bg-black"
              />
            )}
            <figcaption className="flex items-center gap-3 text-xs text-(--m-muted)">
              <span className="min-w-0 truncate">
                {block.attachment.name} · {formatAttachmentSize(block.attachment.sizeBytes)}
              </span>
              {mediaIndex === undefined ? null : (
                <button
                  type="button"
                  onClick={() => props.onOpenMedia(mediaIndex)}
                  className="relative ms-auto shrink-0 rounded font-medium text-(--m-accent-text) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:after:absolute pointer-coarse:after:-inset-x-2 pointer-coarse:after:-inset-y-3.5"
                >
                  Full screen
                </button>
              )}
            </figcaption>
          </figure>
        );
      }
      if (kind === "audio") {
        return (
          <figure className="flex max-w-[560px] flex-col gap-1.5">
            {url === null ? (
              <Bar className="h-12 rounded-full" />
            ) : (
              <audio
                controls
                preload="metadata"
                src={url}
                aria-label={block.attachment.name}
                className="w-full"
              />
            )}
            <figcaption className="truncate text-xs text-(--m-muted)">
              {block.attachment.name} · {formatAttachmentSize(block.attachment.sizeBytes)}
            </figcaption>
          </figure>
        );
      }
      return (
        <FileCard
          attachment={block.attachment}
          kind={kind}
          file={props.media.fileOf?.get(props.index)}
          fileUrl={url}
        />
      );
    }
    default:
      return null;
  }
}

const isPicture = (block: KanbanAskBlock): boolean =>
  block._tag === "image" || (block._tag === "attachment" && kindOf(block.attachment) === "image");

type Shown =
  | { readonly kind: "block"; readonly index: number; readonly block: KanbanAskBlock }
  | { readonly kind: "pictures"; readonly index: number; readonly indexes: ReadonlyArray<number> };

/** The ask's blocks in order, without the ones a field or an option already shows. */
export function AskBlocks(props: {
  ask: KanbanOwnerAsk;
  media: AskMedia;
  skip: ReadonlySet<number>;
  onOpenMedia: (mediaIndex: number) => void;
  onOpenCard: (cardId: string) => void;
}) {
  const blocks = props.ask.blocks ?? [];
  const { media } = props;
  // Pictures that follow one another sit in one row, each over its caption.
  const shown: Array<Shown> = [];
  blocks.forEach((block, index) => {
    if (props.skip.has(index)) return;
    if (isPicture(block)) {
      const last = shown.at(-1);
      if (last?.kind === "pictures") {
        shown[shown.length - 1] = { ...last, indexes: [...last.indexes, index] };
      } else {
        shown.push({ kind: "pictures", index, indexes: [index] });
      }
      return;
    }
    if (media.captions.has(index)) {
      // A picture's caption goes where the picture goes; a video's stays a line of its own.
      const before = blocks[index - 1];
      if (before && isPicture(before)) return;
    }
    shown.push({ kind: "block", index, block });
  });
  if (shown.length === 0) return null;
  return (
    <section aria-label="Shown with the ask" className="flex min-w-0 flex-col gap-3">
      {shown.map((entry) =>
        entry.kind === "pictures" ? (
          <div key={entry.index} className="flex flex-wrap items-start gap-3">
            {entry.indexes.map((index) => {
              const item = media.items[media.indexOf.get(index) ?? -1];
              return (
                <figure key={index} className="flex max-w-full min-w-0 flex-col gap-1.5">
                  <BlockPicture media={media} index={index} onOpen={props.onOpenMedia} />
                  {item?.caption ? (
                    // As wide as its picture and no wider, so a long caption doesn't push the next picture away.
                    <figcaption className="w-0 min-w-full text-xs text-(--m-muted) [overflow-wrap:anywhere]">
                      {item.caption}
                    </figcaption>
                  ) : null}
                </figure>
              );
            })}
          </div>
        ) : (
          <Block
            key={entry.index}
            block={entry.block}
            index={entry.index}
            media={media}
            onOpenMedia={props.onOpenMedia}
            onOpenCard={props.onOpenCard}
          />
        ),
      )}
    </section>
  );
}
