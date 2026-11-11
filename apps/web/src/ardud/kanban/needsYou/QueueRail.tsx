import {
  askUnreadableCard,
  askUnreadableLine,
  type AskUnreadable,
  askAge,
  askBatchTitle,
  askKindLabel,
  needsYouBatchKey,
  needsYouMarkOf,
  type NeedsYouEntry,
  type NeedsYouFilter,
  type NeedsYouItem,
  type NeedsYouMark,
  type NeedsYouSection,
} from "@t3tools/client-runtime/ardud/kanban";
import { ImageIcon, PlayIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "../../../lib/utils";
import { shortWhen } from "./snoozeTimes";
import { Bar, FilterChip, Key, Pill, fieldClass, linkClass } from "./ui";

const MARK_LABELS: Record<NeedsYouMark, string> = {
  reply: "Reply",
  updated: "Updated",
  failed: "Not sent",
  back: "Back",
};

export interface QueueRailProps {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly sections: ReadonlyArray<NeedsYouSection>;
  readonly focusKey: string | null;
  readonly onFocus: (key: string) => void;
  readonly openBatches: ReadonlySet<string>;
  readonly onToggleBatch: (key: string) => void;
  readonly filter: NeedsYouFilter;
  readonly onFilter: (patch: Partial<NeedsYouFilter>) => void;
  readonly filtered: boolean;
  readonly onClearFilter: () => void;
  readonly kinds: ReadonlyArray<{ readonly kind: string; readonly count: number }>;
  readonly boardNames: ReadonlyMap<string, string>;
  /** With one board showing, rows leave its name out. */
  readonly oneBoard: boolean;
  readonly marks: Readonly<Record<string, NeedsYouMark>>;
  readonly nowMs: number;
  readonly onShortcuts: () => void;
  /** Open asks this build could not read: said in one line, with their cards to open. */
  readonly unreadable: ReadonlyArray<AskUnreadable>;
  readonly onOpenUnreadable: (ask: AskUnreadable) => void;
  /** In a sheet on a phone: no footer, rows a thumb can hit. */
  readonly inSheet?: boolean;
}

/** The queue: search and filters on top, then every ask in its section. */
export function QueueRail(props: QueueRailProps) {
  const { filter, sections } = props;
  const listRef = useRef<HTMLDivElement>(null);

  // The focused row stays in view as J and K move through the list, and keeps
  // keyboard focus when focus was already on a row.
  useEffect(() => {
    if (props.focusKey === null) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-ny-row="${CSS.escape(props.focusKey)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    if (row && list?.contains(document.activeElement) && document.activeElement !== row) {
      row.focus({ preventScroll: true });
    }
  }, [props.focusKey]);
  const onRowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-ny-row]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    rows[next]?.focus();
    rows[next]?.click();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-(--m-rule) p-3">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-(--m-muted)"
          />
          <input
            data-ny-search
            type="search"
            value={filter.query}
            onChange={(event) => props.onFilter({ query: event.target.value })}
            placeholder="Search asks…"
            aria-label="Search asks"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              fieldClass,
              "h-9 rounded-full ps-9 pe-9 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden",
            )}
          />
          {filter.query === "" ? (
            <Key className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2">/</Key>
          ) : (
            <button
              type="button"
              aria-label="Clear search"
              onClick={(event) => {
                props.onFilter({ query: "" });
                event.currentTarget.parentElement?.querySelector("input")?.focus();
              }}
              className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-(--m-muted) outline-none after:absolute hover:bg-(--m-chip) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:after:-inset-2.5"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <select
            aria-label="Kind of ask"
            value={filter.kind ?? ""}
            onChange={(event) => props.onFilter({ kind: event.target.value || null })}
            className={cn(
              fieldClass,
              "h-7.5 w-auto max-w-[55%] rounded-full py-0 ps-3 pe-7 pointer-coarse:h-9",
              filter.kind !== null && "font-medium",
            )}
          >
            <option value="">All kinds</option>
            {props.kinds.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {askKindLabel(entry.kind)} · {entry.count}
              </option>
            ))}
          </select>
          <FilterChip
            pressed={filter.holds}
            onClick={() => props.onFilter({ holds: !filter.holds })}
          >
            Holds a card
          </FilterChip>
        </div>
      </div>

      <div
        ref={listRef}
        data-ny-rows
        onKeyDown={onRowKeys}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-3"
        aria-busy={props.status === "loading"}
      >
        {props.status === "loading" || props.status === "idle" ? null : (
          <UnreadableNotice asks={props.unreadable} onOpen={props.onOpenUnreadable} />
        )}
        {props.status === "loading" || props.status === "idle" ? (
          <RailSkeleton />
        ) : sections.length === 0 &&
          props.unreadable.length > 0 &&
          !props.filtered ? null : sections.length === 0 ? (
          props.filtered ? (
            props.inSheet ? (
              <div className="flex flex-col items-start gap-2 px-2.5 pt-4 text-sm">
                <p className="font-medium">No asks match.</p>
                <button type="button" onClick={props.onClearFilter} className={linkClass}>
                  Clear filters
                </button>
              </div>
            ) : (
              // Beside the reader, which says it in full and offers to clear the filters.
              <p className="px-2.5 pt-4 text-sm text-(--m-muted)">No asks match</p>
            )
          ) : (
            <p className="px-2.5 pt-4 text-sm text-(--m-muted)">No asks</p>
          )
        ) : (
          sections.map((section) => (
            <section key={section.id} aria-label={section.label}>
              <h2 className="flex items-baseline justify-between gap-2 px-2.5 pt-3.5 pb-1.5 text-xs font-normal text-(--m-muted)">
                <span>{section.label}</span>
                <span className="tabular-nums">{section.count}</span>
              </h2>
              <ul className="flex flex-col gap-0.5">
                {section.entries.map((entry) =>
                  entry._tag === "ask" ? (
                    <Row key={entry.item.key} item={entry.item} {...rowProps(props)} />
                  ) : (
                    <BatchRows key={needsYouBatchKey(entry)} entry={entry} rail={props} />
                  ),
                )}
              </ul>
            </section>
          ))
        )}
      </div>

      {props.inSheet ? null : (
        <footer className="flex shrink-0 items-center gap-1.5 border-t border-(--m-rule) px-3 py-2 text-xs text-(--m-muted) pointer-coarse:hidden">
          <Key>J</Key>
          <Key>K</Key>
          <span>move</span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <Key className="ms-1.5">A</Key>
            <span className="truncate">approve</span>
          </span>
          <button
            type="button"
            onClick={props.onShortcuts}
            className={cn(
              linkClass,
              "ms-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
            )}
          >
            All shortcuts <Key>?</Key>
          </button>
        </footer>
      )}
    </div>
  );
}

/**
 * Asks the feed carried that this build can't read. They are still open, so
 * the queue says so in one quiet line and names the cards he can open instead.
 */
function UnreadableNotice(props: {
  readonly asks: ReadonlyArray<AskUnreadable>;
  readonly onOpen: (ask: AskUnreadable) => void;
}) {
  if (props.asks.length === 0) return null;
  const named = props.asks.filter(
    (ask) => ask.boardId !== null && ask.cardId !== null && askUnreadableCard(ask) !== null,
  );
  const shown = named.slice(0, 3);
  return (
    <p role="status" className="px-2.5 pt-3 text-xs text-(--m-muted) [overflow-wrap:anywhere]">
      {askUnreadableLine(props.asks.length)}.{shown.length > 0 ? " Open " : ""}
      {shown.map((ask, index) => (
        <span key={`${ask.cardId}:${ask.askId}`}>
          {index > 0 ? ", " : ""}
          <button type="button" onClick={() => props.onOpen(ask)} className={linkClass}>
            {askUnreadableCard(ask)}
          </button>
        </span>
      ))}
      {named.length > shown.length ? ` and ${named.length - shown.length} more` : ""}
      {shown.length > 0 ? "." : ""}
    </p>
  );
}

const rowProps = (rail: QueueRailProps) => ({
  focusKey: rail.focusKey,
  onFocus: rail.onFocus,
  boardNames: rail.boardNames,
  oneBoard: rail.oneBoard,
  marks: rail.marks,
  nowMs: rail.nowMs,
});

function rowTone(item: NeedsYouItem): string {
  if (item.notice) return "bg-(--m-tick)";
  return item.blocking ? "bg-(--m-warning)" : "bg-(--m-tick)";
}

function Row(props: {
  item: NeedsYouItem;
  focusKey: string | null;
  onFocus: (key: string) => void;
  boardNames: ReadonlyMap<string, string>;
  oneBoard: boolean;
  marks: Readonly<Record<string, NeedsYouMark>>;
  nowMs: number;
  nested?: boolean;
}) {
  const { item } = props;
  const focused = props.focusKey === item.key;
  const mark = needsYouMarkOf(item, props.marks);
  const board = props.boardNames.get(item.boardId) ?? "";
  const blocks = item.ask.blocks ?? [];
  const pictures = blocks.filter(
    (block) =>
      block._tag === "image" || (block._tag === "attachment" && block.attachment.type === "image"),
  ).length;
  const video = blocks.some(
    (block) => block._tag === "attachment" && block.attachment.mimeType.startsWith("video/"),
  );
  return (
    <li>
      <button
        type="button"
        data-ny-row={item.key}
        aria-current={focused ? "true" : undefined}
        tabIndex={focused || props.focusKey === null ? 0 : -1}
        onClick={() => props.onFocus(item.key)}
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 rounded-xl py-2 pe-2.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:py-2.5",
          props.nested ? "ps-6.5" : "ps-2.5",
          focused ? "bg-(--m-chip)" : "hover:bg-(--m-surface)",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-(--m-muted)">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", rowTone(item))} />
          <span className="min-w-0 truncate">
            {askKindLabel(item.kind)} · {props.oneBoard ? "" : `${board} `}#{item.cardNumber}
          </span>
          {item.blocking ? <span className="sr-only">, holds its card</span> : null}
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {mark ? (
              <Pill
                tone={mark === "failed" ? "negative" : "accent"}
                className="h-4.5 px-1.75 text-2xs"
              >
                {MARK_LABELS[mark]}
              </Pill>
            ) : null}
            {pictures > 0 ? (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <ImageIcon aria-hidden className="size-3" />
                {pictures}
                <span className="sr-only"> {pictures === 1 ? "picture" : "pictures"}</span>
              </span>
            ) : null}
            {video ? <PlayIcon aria-label="Has video" className="size-3" /> : null}
            <span className="tabular-nums">
              {item.snoozed && item.ask.snoozedUntil
                ? shortWhen(item.ask.snoozedUntil, props.nowMs)
                : askAge(item.ageMs)}
            </span>
          </span>
        </span>
        <span className={cn("truncate text-sm", focused || mark ? "font-medium" : "")}>
          {item.ask.title ?? item.cardTitle}
        </span>
      </button>
    </li>
  );
}

function BatchRows(props: {
  entry: Extract<NeedsYouEntry, { _tag: "batch" }>;
  rail: QueueRailProps;
}) {
  const { entry, rail } = props;
  const key = needsYouBatchKey(entry);
  const open = rail.openBatches.has(key);
  const focused = rail.focusKey === key;
  const first = entry.items[0]!;
  const count = entry.items.length;
  const oldest = Math.max(...entry.items.map((item) => item.ageMs));
  return (
    <li className="flex flex-col gap-0.5">
      <button
        type="button"
        data-ny-row={key}
        aria-current={focused ? "true" : undefined}
        tabIndex={focused ? 0 : -1}
        onClick={() => rail.onFocus(key)}
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 rounded-xl px-2.5 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:py-2.5",
          focused ? "bg-(--m-chip)" : "hover:bg-(--m-surface)",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-(--m-muted)">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              entry.items.some((item) => item.blocking) ? "bg-(--m-warning)" : "bg-(--m-tick)",
            )}
          />
          <span className="min-w-0 truncate">
            {rail.oneBoard ? askKindLabel(first.kind) : (rail.boardNames.get(entry.boardId) ?? "")}
          </span>
          <span className="ms-auto shrink-0 tabular-nums">{askAge(oldest)}</span>
        </span>
        <span className={cn("truncate text-sm", focused ? "font-medium" : "")}>
          {askBatchTitle(entry.items.map((item) => item.kind))}
        </span>
      </button>
      {open ? (
        <ul className="flex flex-col gap-0.5">
          {entry.items.map((item) => (
            <Row key={item.key} item={item} nested {...rowProps(rail)} />
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => rail.onToggleBatch(key)}
        className={cn(linkClass, "self-start px-2.5 py-1.5 text-sm font-medium")}
      >
        {open ? "Hide" : "Show"} the {count}
      </button>
    </li>
  );
}

function RailSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-2.5 pt-4" aria-hidden>
      {[72, 88, 64, 80, 70, 84].map((width) => (
        <div key={width} className="flex flex-col gap-2">
          <Bar className="h-2.5 w-24" />
          <span style={{ width: `${width}%` }}>
            <Bar className="h-3.5" />
          </span>
        </div>
      ))}
    </div>
  );
}
