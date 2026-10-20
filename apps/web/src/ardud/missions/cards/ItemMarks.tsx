import { useState, type ReactNode } from "react";

import type { InboxMark } from "@t3tools/contracts";
import {
  ageView,
  isSnoozed,
  snoozeChoices,
  snoozeLabel,
  snoozeUntilFromLocal,
  type InboxEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../../components/ui/menu";
import { Textarea } from "../../../components/ui/textarea";
import type { InboxActions } from "../useInboxScreen";
import type { CardAction } from "./CardFrame";
import { AgeElement, PersonChip } from "./chips";

// The owner's own marks on an inbox item: comments, which decide nothing, and
// a snooze, which moves the item out of Needs you and the inbox until its time
// passes or the item changes. Neither ever hides anything from the master.

export interface ItemMarks {
  /** Snooze, or the snooze's end and Unsnooze, after the card's age. */
  readonly end: ReactNode;
  /** Comment in the footer, after the decisions. */
  readonly comment: CardAction;
  /** The comments, and the comment or snooze-time box while one is open. */
  readonly panel: ReactNode;
}

type MarkActions = Pick<InboxActions, "comment" | "snooze" | "unsnooze">;

export function useItemMarks(
  entry: InboxEntry,
  mark: InboxMark | undefined,
  nowMs: number,
  actions: MarkActions,
): ItemMarks {
  const [open, setOpen] = useState<"comment" | "time" | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: Promise<boolean>) => {
    setBusy(true);
    const ok = await action;
    setBusy(false);
    if (ok) setOpen(null);
    return ok;
  };
  const snoozed = isSnoozed(mark, nowMs);
  const end = snoozed ? (
    <>
      <span className="whitespace-nowrap">{snoozeLabel(mark, nowMs)}</span>
      <Button
        variant="ghost-muted"
        size="xs"
        disabled={busy}
        onClick={() => void run(actions.unsnooze(entry))}
      >
        Unsnooze
      </Button>
    </>
  ) : (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} />}>
        Snooze
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        {snoozeChoices(nowMs).map((choice) => (
          <MenuItem key={choice.key} onClick={() => void run(actions.snooze(entry, choice.until))}>
            {choice.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => setOpen("time")}>Pick a time</MenuItem>
      </MenuPopup>
    </Menu>
  );
  const comments = mark?.comments ?? [];
  const panel =
    comments.length > 0 || open ? (
      <div className="flex max-w-[72ch] min-w-0 flex-col gap-2.5">
        {comments.length > 0 ? (
          <ul aria-label="Your comments" className="flex min-w-0 flex-col gap-2.5">
            {comments.map((comment) => {
              const age = ageView(comment.at, nowMs);
              return (
                <li key={comment.id} className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <PersonChip kind="you" name="You" />
                    {age ? (
                      <span className="ms-auto">
                        <AgeElement age={age} at={comment.at} />
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm leading-5.5 text-pretty whitespace-pre-line">
                    {comment.body}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : null}
        {open === "comment" ? (
          <CommentBox
            busy={busy}
            onSend={(text) => run(actions.comment(entry, text))}
            onClose={() => setOpen(null)}
          />
        ) : null}
        {open === "time" ? (
          <SnoozeTimeBox
            busy={busy}
            nowMs={nowMs}
            onSnooze={(until) => run(actions.snooze(entry, until))}
            onClose={() => setOpen(null)}
          />
        ) : null}
      </div>
    ) : null;
  return {
    end,
    comment: {
      key: "comment",
      disabled: busy,
      onRun: () => setOpen(open === "comment" ? null : "comment"),
    },
    panel,
  };
}

function CommentBox(props: {
  busy: boolean;
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    if (text.trim() !== "") void props.onSend(text);
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Textarea
        size="sm"
        autoFocus
        aria-label="Comment"
        placeholder="Comment"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={props.busy || text.trim() === ""}
        >
          Add comment
        </Button>
        <Button type="button" size="sm" variant="ghost-muted" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A time picked in the device's zone, sent as an instant. */
function SnoozeTimeBox(props: {
  busy: boolean;
  nowMs: number;
  onSnooze: (until: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const until = snoozeUntilFromLocal(value, props.nowMs);
  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (until) void props.onSnooze(until);
      }}
    >
      <Input
        type="datetime-local"
        nativeInput
        size="sm"
        autoFocus
        aria-label="Snooze until"
        className="w-56"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={props.busy || !until}>
        Snooze
      </Button>
      <Button type="button" size="sm" variant="ghost-muted" onClick={props.onClose}>
        Cancel
      </Button>
    </form>
  );
}
