import { clampHtmlRenderHeight, injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { ChartNoAxesColumnIcon, Maximize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { HtmlRenderDialog } from "../../../components/chat/HtmlRenderDialog";
import { HtmlRenderDocument } from "../../../components/files/BrowserDocumentFrame";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { Bar, Btn } from "./ui";

/** A value a page inside an ask hands back: `{ type: "robob.ask.value", value }`, or the older `{ robobPick }`. */
function readAskValue(data: unknown): { readonly value: unknown } | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; value?: unknown; robobPick?: unknown };
  if (message.type === "robob.ask.value" && "value" in message) return { value: message.value };
  if (typeof message.robobPick === "number") return { value: message.robobPick };
  return null;
}

/**
 * An html block of an ask: the same sandboxed frame the app draws `html_render`
 * pages in (scripts, no origin), with the same expand-to-full dialog. The page
 * is the ask's own text, so it is served to the frame from a blob.
 */
export function AskHtmlFrame(props: {
  html: string;
  title: string | null;
  height: number | null;
  /** Called when the page posts a value for a custom field. */
  onValue?: (value: unknown) => void;
}) {
  const title = props.title ?? "Page";
  const [src, setSrc] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([injectHtmlRenderBootstrap(props.html)], { type: "text/html;charset=utf-8" }),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- The blob URL exists only while this effect holds it.
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [props.html]);

  const onValue = useStableCallback((value: unknown) => props.onValue?.(value));
  const listens = props.onValue !== undefined;
  useEffect(() => {
    if (!listens) return;
    const receive = (event: MessageEvent) => {
      // Only from a frame of this block: the inline one or its expanded copy.
      const mine = [
        box.current?.querySelector("iframe")?.contentWindow,
        ...[...document.querySelectorAll<HTMLIFrameElement>("[role=dialog] iframe")].map(
          (frame) => frame.contentWindow,
        ),
      ];
      if (event.source === null || !mine.includes(event.source as Window)) return;
      const message = readAskValue(event.data);
      if (message !== null) onValue(message.value);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [listens, onValue]);

  const height = clampHtmlRenderHeight(contentHeight ?? props.height ?? 320);
  return (
    <figure className="min-w-0 overflow-hidden rounded-2xl ring-1 ring-(--m-rule)">
      <figcaption className="flex items-center gap-2 border-b border-(--m-rule) py-1.5 ps-3.5 pe-1.5 text-sm font-medium">
        <ChartNoAxesColumnIcon aria-hidden className="size-4 shrink-0 text-(--m-muted)" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <Btn tone="ghost" size="sm" disabled={src === null} onClick={() => setExpanded(true)}>
          <Maximize2Icon aria-hidden />
          Expand
        </Btn>
      </figcaption>
      <div ref={box} style={{ height }} className="bg-(--m-surface)">
        {src === null ? (
          <Bar className="size-full rounded-none" />
        ) : (
          <HtmlRenderDocument
            key={src}
            src={src}
            title={title}
            className="block size-full"
            onContentHeight={setContentHeight}
          />
        )}
      </div>
      {expanded && src !== null ? (
        <HtmlRenderDialog src={src} title={title} onClose={() => setExpanded(false)} />
      ) : null}
    </figure>
  );
}
