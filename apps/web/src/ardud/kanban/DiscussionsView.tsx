import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowLeftIcon,
  CircleCheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  actorKey,
  avatarOf,
  type DiscussionRow,
  discussionRows,
  discussionSnoozed,
  type KanbanBoardState,
  linkLabels,
} from "@t3tools/client-runtime/ardud/kanban";
import { ageView } from "@t3tools/client-runtime/ardud/common";
import type { KanbanDiscussion, KanbanDiscussionUpdateInput } from "@t3tools/contracts";

import { requestCustomSnooze } from "../../components/CustomSnoozeDialog";
import { resolveSnoozePresets, snoozeWakeLabel } from "../../components/Sidebar.snooze";
import { CollapsibleSectionHeader } from "../../components/ui/collapsible-section-header";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Chat, Composer } from "./Chat";
import { composerTitleSource } from "./composerAttachments";
import { kanban, runAction } from "./kanbanStore";
import { CopyLinkButton } from "./links";
import { Avatar, UnreadDot } from "./parts";

/** Search value that opens an empty room for a new request. */
export const NEW_DISCUSSION = "new";

const SNOOZED_EXPANDED_KEY = "t3code:kanban:discussions:snoozed-expanded";
const SETTLED_EXPANDED_KEY = "t3code:kanban:discussions:settled-expanded";

const ROUND_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-full text-(--m-muted) outline-none hover:bg-(--m-chip) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) data-popup-open:bg-(--m-chip) data-popup-open:text-(--m-text)";

type DiscussionPatch = Omit<KanbanDiscussionUpdateInput, "discussionId">;

function updateDiscussion(boardId: string, discussionId: string, patch: DiscussionPatch) {
  const failure =
    patch.title !== undefined
      ? "Couldn't rename the discussion"
      : patch.settled !== undefined
        ? patch.settled
          ? "Couldn't settle the discussion"
          : "Couldn't unsettle the discussion"
        : patch.snoozedUntil === null
          ? "Couldn't unsnooze the discussion"
          : "Couldn't snooze the discussion";
  return runAction(failure, () => kanban.updateDiscussion(boardId, discussionId, patch));
}

/** Mounted only while drafting, so a half-sent draft never leaks into the next one. */
function DraftRoom(props: {
  boardId: string;
  narrow: boolean;
  onOpenDiscussion: (discussionId: string | undefined) => void;
}) {
  // Created but the first post failed: the retry goes into that discussion
  // instead of creating another.
  const created = useRef<string | null>(null);
  return (
    <div className="flex min-h-0 min-w-0 flex-col pe-5 md:px-6">
      <div className="flex h-9 shrink-0 items-center gap-3">
        {props.narrow ? <BackButton onBack={() => props.onOpenDiscussion(undefined)} /> : null}
        <h3 className="min-w-0 flex-1 truncate text-base font-medium">New discussion</h3>
      </div>
      <div className="flex min-h-0 w-full max-w-160 flex-1 flex-col justify-end">
        <Composer
          placeholder="What do you need?"
          attachments
          onSend={async (blocks) => {
            const text = blocks.find((block) => block._tag === "md")?.text ?? "";
            const firstFile = blocks.find((block) => block._tag === "attachment");
            created.current ??= (
              await kanban.createDiscussion(
                props.boardId,
                requestTitle(
                  composerTitleSource(
                    text,
                    firstFile?._tag === "attachment" ? [firstFile.attachment.name] : [],
                  ),
                ),
              )
            ).id;
            const discussionId = created.current;
            await kanban.post(props.boardId, discussionId, blocks);
            created.current = null;
            props.onOpenDiscussion(discussionId);
          }}
        />
      </div>
    </div>
  );
}

/** Stand-in title until the server writes one from the first message. */
function requestTitle(text: string) {
  const line =
    linkLabels(text)
      .split("\n")
      .find((entry) => entry.trim().length > 0)
      ?.trim() ?? "Request";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
}

export function DiscussionsView(props: {
  boardId: string;
  state: KanbanBoardState;
  nowMs: number;
  discussionId: string | undefined;
  onOpenDiscussion: (discussionId: string | undefined) => void;
  onOpenCard: (cardId: string) => void;
}) {
  const { state } = props;
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useLocalStorage(
    SNOOZED_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [settledOpen, setSettledOpen] = useLocalStorage(
    SETTLED_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const groups = discussionRows(state, props.nowMs, { query });
  const total = groups.active.length + groups.snoozed.length + groups.settled.length;
  const searching = query.trim().length > 0;
  const narrow = useMediaQuery("max-md");
  const drafting = props.discussionId === NEW_DISCUSSION;
  const selected = props.discussionId ? state.discussions.get(props.discussionId) : undefined;
  const showList = !narrow || (!selected && !drafting);
  const showRoom = !narrow || selected || drafting;

  useEffect(() => kanban.watchPreviews(props.boardId), [props.boardId]);

  const rename = (discussionId: string) => {
    props.onOpenDiscussion(discussionId);
    setRenaming(discussionId);
  };
  const renderRows = (rows: ReadonlyArray<DiscussionRow>) =>
    rows.map((row) => (
      <DiscussionListRow
        key={row.id}
        boardId={props.boardId}
        row={row}
        nowMs={props.nowMs}
        current={row.id === props.discussionId}
        onOpen={() => props.onOpenDiscussion(row.id)}
        onRename={() => rename(row.id)}
      />
    ));

  return (
    <div className={cn("grid min-h-0 flex-1", narrow ? "grid-cols-1" : "grid-cols-[270px_1fr]")}>
      {showList ? (
        <div className="flex min-h-0 flex-col gap-1 pe-2.5 md:border-e md:border-(--m-rule)">
          <div className="flex h-9 shrink-0 items-center ps-2.5">
            <h2 className="text-base font-semibold">Discussions</h2>
          </div>
          <SearchField value={query} onChange={setQuery} />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3">
            {!state.discussionsLoaded && total === 0 ? null : total === 0 ? (
              <p className="px-2.5 py-2 text-sm text-(--m-muted)">
                {searching ? "No matches." : "No discussions yet."}
              </p>
            ) : null}
            <ul className="flex flex-col gap-0.5">{renderRows(groups.active)}</ul>
            <ListGroup
              label="Snoozed"
              count={groups.snoozed.length}
              tone="info"
              expanded={snoozedOpen || searching}
              onToggle={() => setSnoozedOpen((open) => !open)}
            >
              {renderRows(groups.snoozed)}
            </ListGroup>
            <ListGroup
              label="Settled"
              count={groups.settled.length}
              tone="muted"
              expanded={settledOpen || searching}
              onToggle={() => setSettledOpen((open) => !open)}
            >
              {renderRows(groups.settled)}
            </ListGroup>
          </div>
        </div>
      ) : null}
      {showRoom ? (
        drafting ? (
          <DraftRoom
            boardId={props.boardId}
            narrow={narrow}
            onOpenDiscussion={props.onOpenDiscussion}
          />
        ) : selected ? (
          <div className="flex min-h-0 min-w-0 flex-col pe-5 md:px-6">
            <div className="flex h-9 shrink-0 items-center gap-2">
              {narrow ? <BackButton onBack={() => props.onOpenDiscussion(undefined)} /> : null}
              <RoomTitle
                key={selected.id}
                discussion={selected}
                editing={renaming === selected.id}
                onEditingChange={(editing) => setRenaming(editing ? selected.id : null)}
                onSave={(title) => updateDiscussion(props.boardId, selected.id, { title })}
              />
              <RoomStatus discussion={selected} nowMs={props.nowMs} />
              <CopyLinkButton kind="kanban-discussion" id={selected.id} label={selected.title} />
              <DiscussionMenu
                boardId={props.boardId}
                discussion={selected}
                nowMs={props.nowMs}
                onRename={() => setRenaming(selected.id)}
              />
              <span className="flex -space-x-1 ps-1">
                {selected.participants.map((entry) => {
                  const face = avatarOf(entry.actor, entry.name);
                  return (
                    <Avatar
                      key={actorKey(entry.actor)}
                      kind={face.kind}
                      letter={face.letter}
                      name={entry.name}
                      size="sm"
                    />
                  );
                })}
              </span>
            </div>
            <Chat
              boardId={props.boardId}
              discussion={selected}
              state={state}
              onOpenCard={props.onOpenCard}
              className="w-full max-w-160"
            />
          </div>
        ) : (
          <div className="grid place-items-center text-sm text-(--m-muted)">
            {total > 0 ? "Pick a discussion." : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function BackButton(props: { onBack: () => void }) {
  return (
    <button
      type="button"
      aria-label="All discussions"
      onClick={props.onBack}
      className={cn("-ms-1.5", ROUND_BUTTON)}
    >
      <ArrowLeftIcon className="size-4" />
    </button>
  );
}

function SearchField(props: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="mx-0.5 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-full bg-(--m-chip) ps-3 pe-1 focus-within:ring-2 focus-within:ring-inset focus-within:ring-(--m-accent)">
      <SearchIcon aria-hidden className="size-4 shrink-0 text-(--m-muted)" />
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.value) {
            event.preventDefault();
            props.onChange("");
          }
        }}
        placeholder="Search discussions"
        aria-label="Search discussions"
        className="min-w-0 flex-1 bg-transparent text-sm text-(--m-text) outline-none placeholder:text-(--m-muted)"
      />
      {props.value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => props.onChange("")}
          className="grid size-6 shrink-0 place-items-center rounded-full text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </label>
  );
}

function ListGroup(props: {
  label: string;
  count: number;
  tone: "info" | "muted";
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (props.count === 0) return null;
  return (
    <section className="mt-3 flex flex-col gap-0.5">
      <CollapsibleSectionHeader
        expanded={props.expanded}
        tone={props.tone}
        onClick={props.onToggle}
      >
        {props.expanded ? props.label : `${props.label} (${props.count})`}
      </CollapsibleSectionHeader>
      {props.expanded ? <ul className="flex flex-col gap-0.5">{props.children}</ul> : null}
    </section>
  );
}

function DiscussionListRow(props: {
  boardId: string;
  row: DiscussionRow;
  nowMs: number;
  current: boolean;
  onOpen: () => void;
  onRename: () => void;
}) {
  const { row } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const settled = row.settledAt !== null;
  const when =
    row.snoozedUntil !== null
      ? snoozeWakeLabel(row.snoozedUntil, { now: new Date(props.nowMs).toISOString() })
      : row.at
        ? (ageView(row.at, props.nowMs)?.label ?? "")
        : "";
  return (
    <li
      className="group/row relative"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        type="button"
        onClick={props.onOpen}
        aria-current={props.current ? "true" : undefined}
        className={cn(
          "grid w-full grid-cols-[1fr_auto] gap-x-2 gap-y-px rounded-xl px-2.5 py-2.25 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
          props.current ? "bg-(--m-surface)" : "hover:bg-(--m-surface)",
        )}
      >
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 text-sm font-medium",
            settled && "text-(--m-muted)",
          )}
        >
          <span className="truncate">{row.title}</span>
          {row.unread > 0 ? <UnreadDot label={`${row.unread} unread`} /> : null}
        </span>
        <span
          className={cn(
            "flex items-center gap-1 text-xs tabular-nums transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0 group-has-data-popup-open/row:opacity-0 pointer-coarse:opacity-0",
            row.snoozedUntil !== null ? "text-(--m-info)" : "text-(--m-muted)",
          )}
        >
          {row.snoozedUntil !== null ? (
            <AlarmClockIcon aria-label="Snoozed for" className="size-3" />
          ) : null}
          {when}
        </span>
        {row.preview ? (
          <span className="col-span-2 truncate text-sm text-(--m-muted)">{row.preview}</span>
        ) : null}
      </button>
      <span className="absolute end-1 top-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
        <DiscussionMenu
          boardId={props.boardId}
          discussion={row}
          nowMs={props.nowMs}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onRename={props.onRename}
        />
      </span>
    </li>
  );
}

/** Settle, snooze and rename for one discussion: the row's menu and the room header's. */
function DiscussionMenu(props: {
  boardId: string;
  discussion: {
    readonly id: string;
    readonly title: string;
    readonly settledAt: string | null;
    readonly snoozedUntil: string | null;
  };
  nowMs: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRename: () => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { discussion } = props;
  const settled = discussion.settledAt !== null;
  const snoozed = !settled && discussionSnoozed(discussion, props.nowMs);
  const presets = open ? resolveSnoozePresets(new Date(), timestampFormat) : [];
  const update = (patch: DiscussionPatch) =>
    void updateDiscussion(props.boardId, discussion.id, patch);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Actions for ${discussion.title}`}
            className={ROUND_BUTTON}
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        {settled ? (
          <MenuItem onClick={() => update({ settled: false })}>
            <Undo2Icon />
            Unsettle
          </MenuItem>
        ) : (
          <MenuItem onClick={() => update({ settled: true })}>
            <CircleCheckIcon />
            Settle
          </MenuItem>
        )}
        {snoozed ? (
          <MenuItem onClick={() => update({ snoozedUntil: null })}>
            <AlarmClockOffIcon />
            Unsnooze
          </MenuItem>
        ) : (
          <MenuSub>
            <MenuSubTrigger>
              <AlarmClockIcon />
              Snooze
            </MenuSubTrigger>
            <MenuSubPopup>
              {presets.map((preset) => (
                <MenuItem
                  key={preset.id}
                  onClick={() => update({ snoozedUntil: preset.snoozedUntil })}
                >
                  {preset.label}
                  <MenuShortcut>{preset.whenLabel}</MenuShortcut>
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onClick={async () => {
                  const choice = await requestCustomSnooze();
                  if (choice) update({ snoozedUntil: choice.snoozedUntil });
                }}
              >
                Custom…
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        )}
        <MenuSeparator />
        <MenuItem onClick={props.onRename}>
          <PencilIcon />
          Rename
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Says why an open discussion is out of the main list. */
function RoomStatus(props: { discussion: KanbanDiscussion; nowMs: number }) {
  const { discussion } = props;
  if (discussion.settledAt !== null) {
    return <span className="shrink-0 text-xs text-(--m-muted)">Settled</span>;
  }
  if (!discussionSnoozed(discussion, props.nowMs) || discussion.snoozedUntil === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-(--m-info) tabular-nums">
      <AlarmClockIcon aria-hidden className="size-3" />
      {snoozeWakeLabel(discussion.snoozedUntil, { now: new Date(props.nowMs).toISOString() })}
    </span>
  );
}

function RoomTitle(props: {
  discussion: KanbanDiscussion;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (title: string) => Promise<boolean>;
}) {
  if (!props.editing) {
    return (
      <h3 className="flex min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => props.onEditingChange(true)}
                className="-ms-1.5 min-w-0 truncate rounded-lg px-1.5 py-0.5 text-left text-base font-medium outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              />
            }
          >
            {props.discussion.title}
          </TooltipTrigger>
          <TooltipPopup>Rename</TooltipPopup>
        </Tooltip>
      </h3>
    );
  }
  return (
    <TitleInput
      title={props.discussion.title}
      onClose={() => props.onEditingChange(false)}
      onSave={props.onSave}
    />
  );
}

/** Mounted per edit, so it starts from the title as it is now (the server may have rewritten it). */
function TitleInput(props: {
  title: string;
  onClose: () => void;
  onSave: (title: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(props.title);
  const [saving, setSaving] = useState(false);
  // Enter and the blur that follows both commit; only the first one saves.
  const done = useRef(false);

  const commit = async () => {
    if (done.current) return;
    done.current = true;
    const title = draft.trim();
    if (!title || title === props.title) {
      props.onClose();
      return;
    }
    setSaving(true);
    const ok = await props.onSave(title);
    setSaving(false);
    if (ok) props.onClose();
    else done.current = false;
  };
  return (
    <input
      autoFocus
      value={draft}
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          props.onClose();
        }
      }}
      aria-label="Discussion title"
      maxLength={200}
      className="-ms-1.5 h-8 min-w-0 flex-1 rounded-lg bg-(--m-surface) px-1.5 text-base font-medium text-(--m-text) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
    />
  );
}
