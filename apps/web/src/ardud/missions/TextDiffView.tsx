import type { DiffLine, DiffSegment } from "@t3tools/client-runtime/ardud/missions";

import { cn } from "../../lib/utils";

// Pure presentation: renders diffs computed in client-runtime.

/** Stable keys for an ordered list of text pieces: kind plus character offset. */
function keyed<T extends { readonly text: string; readonly kind: string }>(
  items: ReadonlyArray<T>,
): Array<{ readonly key: string; readonly item: T }> {
  let offset = 0;
  return items.map((item) => {
    const key = `${item.kind}:${offset}`;
    offset += item.text.length + 1;
    return { key, item };
  });
}

/** Inline word diff: removed words struck through, added words highlighted. */
export function WordDiff(props: { segments: ReadonlyArray<DiffSegment>; className?: string }) {
  return (
    <p className={cn("whitespace-pre-wrap text-sm", props.className)}>
      {keyed(props.segments).map(({ key, item }) =>
        item.kind === "same" ? (
          <span key={key}>{item.text}</span>
        ) : item.kind === "removed" ? (
          <del key={key} className="text-destructive-foreground line-through">
            {item.text}
          </del>
        ) : (
          <ins key={key} className="bg-success/16 text-success-foreground no-underline">
            {item.text}
          </ins>
        ),
      )}
    </p>
  );
}

/** A "+"/"-" line diff, as suggestions carry it. */
export function LineDiff(props: { lines: ReadonlyArray<DiffLine> }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
      {keyed(props.lines).map(({ key, item }) => (
        <div
          key={key}
          className={cn(
            item.kind === "added" && "text-success-foreground",
            item.kind === "removed" && "text-destructive-foreground",
          )}
        >
          {item.kind === "added" ? "+ " : item.kind === "removed" ? "- " : "  "}
          {item.text}
        </div>
      ))}
    </pre>
  );
}
