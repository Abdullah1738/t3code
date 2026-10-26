import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  actorKey,
  avatarOf,
  discussionRows,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import { ageView } from "@t3tools/client-runtime/ardud/missions";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { Chat, Composer } from "./Chat";
import { kanban, runAction } from "./kanbanStore";
import { Avatar, UnreadDot } from "./parts";

/** Search value that opens an empty room for a new request. */
export const NEW_DISCUSSION = "new";

/** Mounted only while drafting, so a half-sent draft never leaks into the next one. */
function DraftRoom(props: {
  boardId: string;
  onOpenDiscussion: (discussionId: string | undefined) => void;
}) {
  // Created but the first post failed: the retry goes into that discussion
  // instead of creating another.
  const created = useRef<string | null>(null);
  return (
    <div className="flex min-h-0 min-w-0 flex-col pe-5 md:px-6">
      <div className="flex h-9 shrink-0 items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate text-base font-medium">New request</h3>
      </div>
      <div className="flex min-h-0 w-full max-w-160 flex-1 flex-col justify-end">
        <Composer
          placeholder="What do you need?"
          onSend={async (text) => {
            created.current ??= (
              await kanban.createDiscussion(props.boardId, requestTitle(text))
            ).id;
            const discussionId = created.current;
            await kanban.post(props.boardId, discussionId, [{ _tag: "md", text }]);
            created.current = null;
            props.onOpenDiscussion(discussionId);
          }}
        />
      </div>
    </div>
  );
}

function requestTitle(text: string) {
  const line =
    text
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
  const rows = discussionRows(state);
  const narrow = useMediaQuery("max-md");
  const drafting = props.discussionId === NEW_DISCUSSION;
  const selected = props.discussionId ? state.discussions.get(props.discussionId) : undefined;
  const showList = !narrow || (!selected && !drafting);
  const showRoom = !narrow || selected || drafting;

  useEffect(() => kanban.watchPreviews(props.boardId), [props.boardId]);

  return (
    <div className={cn("grid min-h-0 flex-1", narrow ? "grid-cols-1" : "grid-cols-[270px_1fr]")}>
      {showList ? (
        <div className="flex min-h-0 flex-col gap-1 pe-2.5 md:border-e md:border-(--m-rule)">
          <div className="flex h-9 shrink-0 items-center justify-between ps-2.5">
            <h2 className="text-base font-semibold">Discussions</h2>
            <NewDiscussion
              onCreate={async (title) => {
                const discussion = await kanban.createDiscussion(props.boardId, title);
                props.onOpenDiscussion(discussion.id);
              }}
            />
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-3">
            {!state.discussionsLoaded && rows.length === 0 ? null : rows.length === 0 ? (
              <li className="px-2.5 py-2 text-sm text-(--m-muted)">No discussions yet.</li>
            ) : null}
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => props.onOpenDiscussion(row.id)}
                  aria-current={row.id === props.discussionId ? "true" : undefined}
                  className={cn(
                    "grid w-full grid-cols-[1fr_auto] gap-x-2 gap-y-px rounded-xl px-2.5 py-2.25 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                    row.id === props.discussionId ? "bg-(--m-surface)" : "hover:bg-(--m-surface)",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.title}</span>
                    {row.unread > 0 ? <UnreadDot label={`${row.unread} unread`} /> : null}
                  </span>
                  <span className="text-xs text-(--m-muted) tabular-nums">
                    {row.at ? (ageView(row.at, props.nowMs)?.label ?? "") : ""}
                  </span>
                  {row.preview ? (
                    <span className="col-span-2 truncate text-sm text-(--m-muted)">
                      {row.preview}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {showRoom ? (
        drafting ? (
          <DraftRoom boardId={props.boardId} onOpenDiscussion={props.onOpenDiscussion} />
        ) : selected ? (
          <div className="flex min-h-0 min-w-0 flex-col pe-5 md:px-6">
            <div className="flex h-9 shrink-0 items-center gap-3">
              {narrow ? (
                <button
                  type="button"
                  aria-label="All discussions"
                  onClick={() => props.onOpenDiscussion(undefined)}
                  className="-ms-1.5 grid size-8 shrink-0 place-items-center rounded-full text-(--m-muted) outline-none hover:bg-(--m-chip) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
                >
                  <ArrowLeftIcon className="size-4" />
                </button>
              ) : null}
              <h3 className="min-w-0 flex-1 truncate text-base font-medium">{selected.title}</h3>
              <span className="flex -space-x-1">
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
            {rows.length > 0 ? "Pick a discussion." : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function NewDiscussion(props: { onCreate: (title: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="New discussion"
        className="grid size-7.5 place-items-center rounded-full bg-(--m-chip) text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      >
        <PlusIcon className="size-4" />
      </button>
    );
  }
  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await runAction("Couldn't start the discussion", () => props.onCreate(value));
    setBusy(false);
    if (ok) {
      setTitle("");
      setOpen(false);
    }
  };
  return (
    <form
      className="ms-2 flex min-w-0 flex-1 items-center"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!title.trim()) setOpen(false);
        }}
        placeholder="Title"
        aria-label="Discussion title"
        className="h-7.5 min-w-0 flex-1 rounded-full bg-(--m-surface) px-3 text-sm text-(--m-text) outline-none placeholder:text-(--m-muted) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      />
    </form>
  );
}
