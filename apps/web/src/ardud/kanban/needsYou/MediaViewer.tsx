import { Dialog } from "@base-ui/react/dialog";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { AttachmentImage } from "../../../components/media/AttachmentImage";
import { downloadMedia } from "../../../components/media/mediaContent";
import { cn } from "../../../lib/utils";

/** One picture or video an ask shows, with the URL it is read from. */
export interface AskMediaItem {
  readonly key: string;
  readonly kind: "image" | "video";
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly caption: string | null;
  /** Null until its signed URL is ready. */
  readonly src: string | null;
}

const MAX_SCALE = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface Placement {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}
const FIT: Placement = { scale: 1, x: 0, y: 0 };

function ViewerButton(props: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full text-white/80 outline-none hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white disabled:opacity-30 pointer-coarse:size-11 [&_svg]:size-4",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * Pictures and videos at full size, over the page: zoom with the wheel, a
 * pinch, a double click or the buttons; drag to pan; step with the arrows or a
 * swipe; Escape closes.
 */
export function MediaViewer(props: {
  items: ReadonlyArray<AskMediaItem>;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const { items } = props;
  const index = clamp(props.index, 0, items.length - 1);
  const item = items[index];
  const [placement, setPlacement] = useState<Placement>(FIT);
  const [natural, setNatural] = useState<{ width: number; height: number; fit: number } | null>(
    null,
  );
  const stage = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    readonly start: Placement;
    readonly x: number;
    readonly y: number;
    readonly distance: number;
    dx: number;
    dy: number;
  } | null>(null);

  if (!item) return null;

  const go = (next: number) => {
    const target = clamp(next, 0, items.length - 1);
    if (target === index) return;
    setPlacement(FIT);
    setNatural(null);
    props.onIndex(target);
  };
  /** Keeps a zoomed picture from being dragged off the stage. */
  const bounded = (next: Placement): Placement => {
    const box = stage.current?.getBoundingClientRect();
    const scale = clamp(next.scale, 1, MAX_SCALE);
    if (!box || !natural || scale === 1) return { scale, x: 0, y: 0 };
    const maxX = Math.max(0, (natural.width * natural.fit * scale - box.width) / 2);
    const maxY = Math.max(0, (natural.height * natural.fit * scale - box.height) / 2);
    return { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
  };
  const zoomTo = (scale: number) =>
    setPlacement((current) => {
      const next = clamp(scale, 1, MAX_SCALE);
      const ratio = next / current.scale;
      return bounded({ scale: next, x: current.x * ratio, y: current.y * ratio });
    });

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (item.kind !== "image") return;
    // A press on a control inside the stage is that control's, not a drag.
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = {
      start: placement,
      x: event.clientX,
      y: event.clientY,
      distance: spread(),
      dx: 0,
      dy: 0,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = gesture.current;
    if (!held || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 && held.distance > 0) {
      const scale = held.start.scale * (spread() / held.distance);
      setPlacement(bounded({ ...held.start, scale }));
      return;
    }
    held.dx = event.clientX - held.x;
    held.dy = event.clientY - held.y;
    if (held.start.scale > 1) {
      setPlacement(
        bounded({
          scale: held.start.scale,
          x: held.start.x + held.dx,
          y: held.start.y + held.dy,
        }),
      );
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = gesture.current;
    const single = pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    // A sideways swipe on a picture that is not zoomed steps to the next one.
    if (
      held &&
      single &&
      held.start.scale === 1 &&
      Math.abs(held.dx) > 60 &&
      Math.abs(held.dx) > 2 * Math.abs(held.dy)
    ) {
      go(index + (held.dx < 0 ? 1 : -1));
    }
  };

  const percent = natural ? Math.round(natural.fit * placement.scale * 100) : null;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Popup
          initialFocus={closeRef}
          aria-label={item.name}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") go(index + 1);
            else if (event.key === "ArrowLeft") go(index - 1);
            else if (event.key === "+" || event.key === "=") zoomTo(placement.scale * 1.5);
            else if (event.key === "-") zoomTo(placement.scale / 1.5);
            else if (event.key === "0") setPlacement(FIT);
            else return;
            event.preventDefault();
          }}
          className="fixed inset-0 z-60 flex flex-col bg-black pt-safe pb-safe text-white outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
        >
          <header className="flex shrink-0 items-center gap-1 px-3 py-2">
            <div className="min-w-0 flex-1 ps-1">
              <Dialog.Title className="truncate text-sm font-semibold">{item.name}</Dialog.Title>
              <p className="truncate text-xs text-white/60 tabular-nums">
                {[
                  natural ? `${natural.width} × ${natural.height}` : null,
                  item.sizeBytes ? formatAttachmentSize(item.sizeBytes) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {items.length > 1 ? (
              <span className="px-2 text-sm text-white/70 tabular-nums">
                {index + 1} of {items.length}
              </span>
            ) : null}
            {item.kind === "image" ? (
              <>
                <ViewerButton
                  label="Zoom out"
                  disabled={placement.scale <= 1}
                  onClick={() => zoomTo(placement.scale / 1.5)}
                  className="max-sm:hidden"
                >
                  <MinusIcon />
                </ViewerButton>
                <button
                  type="button"
                  aria-label="Fit to screen"
                  onClick={() => setPlacement(FIT)}
                  className="h-9 min-w-12 rounded-full px-1 text-sm text-white/80 tabular-nums outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white max-sm:hidden"
                >
                  {percent === null ? "" : `${percent}%`}
                </button>
                <ViewerButton
                  label="Zoom in"
                  disabled={placement.scale >= MAX_SCALE}
                  onClick={() => zoomTo(placement.scale * 1.5)}
                  className="max-sm:hidden"
                >
                  <PlusIcon />
                </ViewerButton>
              </>
            ) : null}
            <ViewerButton
              label="Save"
              disabled={item.src === null}
              onClick={() => {
                if (item.src) void downloadMedia(item.src, item.name).catch(() => undefined);
              }}
            >
              <DownloadIcon />
            </ViewerButton>
            {item.src ? (
              <a
                href={item.src}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in a new tab"
                className="grid size-9 shrink-0 place-items-center rounded-full text-white/80 outline-none hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white max-sm:hidden"
              >
                <ExternalLinkIcon className="size-4" />
              </a>
            ) : null}
            <Dialog.Close
              ref={closeRef}
              aria-label="Close"
              className="grid size-9 shrink-0 place-items-center rounded-full text-white/80 outline-none hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white pointer-coarse:size-11"
            >
              <XIcon className="size-4" />
            </Dialog.Close>
          </header>

          <div
            ref={stage}
            className={cn(
              "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none",
              item.kind === "image" && (placement.scale > 1 ? "cursor-grab" : "cursor-zoom-in"),
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={(event) => {
              if (item.kind === "image") zoomTo(placement.scale * Math.exp(-event.deltaY * 0.002));
            }}
            onDoubleClick={() => {
              if (item.kind === "image") zoomTo(placement.scale > 1 ? 1 : 2.5);
            }}
          >
            {item.src === null ? (
              <p className="text-sm text-white/60">Loading</p>
            ) : item.kind === "video" ? (
              <video
                key={item.key}
                controls
                playsInline
                src={item.src}
                aria-label={item.name}
                className="max-h-full max-w-full"
              />
            ) : (
              <AttachmentImage
                key={item.key}
                name={item.name}
                mimeType={item.mimeType}
                src={item.src}
                alt={item.caption ?? item.name}
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (image.naturalWidth === 0) return;
                  setNatural({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                    fit: image.clientWidth / image.naturalWidth,
                  });
                }}
                className="max-h-full max-w-full object-contain"
                style={{
                  transform: `translate(${placement.x}px, ${placement.y}px) scale(${placement.scale})`,
                }}
              />
            )}
            {items.length > 1 ? (
              <>
                <ViewerButton
                  label="Previous"
                  disabled={index === 0}
                  onClick={() => go(index - 1)}
                  className="absolute start-3 top-1/2 size-11 -translate-y-1/2 bg-white/10 max-sm:hidden"
                >
                  <ChevronLeftIcon />
                </ViewerButton>
                <ViewerButton
                  label="Next"
                  disabled={index === items.length - 1}
                  onClick={() => go(index + 1)}
                  className="absolute end-3 top-1/2 size-11 -translate-y-1/2 bg-white/10 max-sm:hidden"
                >
                  <ChevronRightIcon />
                </ViewerButton>
              </>
            ) : null}
          </div>

          {item.caption ? (
            <p className="shrink-0 px-4 pt-2 pb-3 text-center text-sm text-white/80 [overflow-wrap:anywhere]">
              {item.caption}
            </p>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
