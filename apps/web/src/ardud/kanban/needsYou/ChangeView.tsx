import {
  CHANGE_VIEWS,
  diffCount,
  diffPieces,
  diffReadsInline,
  wordDiff,
  type ChangeView as View,
  type DiffSide,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskChange } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { KanbanMarkdown } from "../links";
import { Seg } from "../parts";
import { IconBtn, Key, Label } from "./ui";

const VIEW_LABELS: Record<View, string> = {
  after: "After",
  before: "Before",
  diff: "Changes",
  both: "Side by side",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Marked(props: { change: KanbanAskChange; side: DiffSide }) {
  const pieces = diffPieces(wordDiff(props.change.before, props.change.after), props.side);
  return (
    <p className="leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">
      {pieces.map((piece, index) =>
        piece.kind === "same" ? (
          // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
          <span key={index}>{piece.text}</span>
        ) : piece.kind === "removed" ? (
          // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
          <del key={index}>{piece.text}</del>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
          <ins key={index}>{piece.text}</ins>
        ),
      )}
    </p>
  );
}

function Whole(props: { text: string; format: KanbanAskChange["format"] }) {
  return props.format === "markdown" ? (
    <div className="[overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <KanbanMarkdown text={props.text} />
    </div>
  ) : (
    <p className="leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">{props.text}</p>
  );
}

const paper = "rounded-xl bg-(--m-ground) p-4 ring-1 ring-inset ring-(--m-rule)";

/**
 * The texts an ask replaces: as they will read, as they read now, with the
 * difference marked, or the two side by side. Several changes are stepped
 * through one at a time.
 */
export function ChangeViewer(props: {
  changes: ReadonlyArray<KanbanAskChange>;
  view: View;
  onView: (view: View) => void;
  index: number;
  onIndex: (index: number) => void;
  /** Side by side needs the room. */
  wide: boolean;
}) {
  const { changes } = props;
  const index = Math.max(0, Math.min(changes.length - 1, props.index));
  const change = changes[index];
  if (!change) return null;
  const view: View = props.view === "both" && !props.wide ? "diff" : props.view;
  const ops = wordDiff(change.before, change.after);
  const { added, removed } = diffCount(ops);
  const inline = diffReadsInline(ops, change.before, change.after);
  const views = props.wide ? CHANGE_VIEWS : CHANGE_VIEWS.filter((entry) => entry !== "both");

  return (
    <section aria-label="Change" className="rounded-2xl bg-(--m-surface) p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Seg
          label="What to show"
          value={view}
          options={views.map((entry) => ({ value: entry, label: VIEW_LABELS[entry] }))}
          onChange={props.onView}
        />
        <Key>V</Key>
        <span className="text-sm text-(--m-muted) tabular-nums">
          {plural(added, "word")} added, {removed} removed
        </span>
        {changes.length > 1 ? (
          <span className="ms-auto flex items-center gap-1 text-sm tabular-nums">
            <IconBtn
              label="Previous change"
              disabled={index === 0}
              onClick={() => props.onIndex(index - 1)}
            >
              <ChevronLeftIcon />
            </IconBtn>
            <span aria-live="polite">
              {index + 1} of {changes.length}
            </span>
            <IconBtn
              label="Next change"
              disabled={index === changes.length - 1}
              onClick={() => props.onIndex(index + 1)}
            >
              <ChevronRightIcon />
            </IconBtn>
            <Key>[</Key>
            <Key>]</Key>
          </span>
        ) : null}
      </div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Label className="font-medium text-(--m-text)">{change.label}</Label>
        {view === "diff" ? (
          <Label>
            {inline
              ? "Removed is struck out, added is marked"
              : "Rewritten: shown as it was and as it will be"}
          </Label>
        ) : null}
      </div>
      {view === "after" ? (
        <div className={paper}>
          <Whole text={change.after} format={change.format} />
        </div>
      ) : view === "before" ? (
        <div className={paper}>
          <Whole text={change.before} format={change.format} />
        </div>
      ) : view === "diff" && inline ? (
        <div className={paper}>
          <Marked change={change} side="both" />
        </div>
      ) : (
        <div className={cn("grid gap-3", view === "both" && "grid-cols-2")}>
          <div className={paper}>
            <Label className="mb-1.5">Before</Label>
            <Marked change={change} side="before" />
          </div>
          <div className={paper}>
            <Label className="mb-1.5">After</Label>
            <Marked change={change} side="after" />
          </div>
        </div>
      )}
    </section>
  );
}
