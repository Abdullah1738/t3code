import { ArrowUpIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type ClipboardEvent } from "react";

import {
  avatarOf,
  canSendChoice,
  discussionPresence,
  ownerChoiceAnswer,
  type KanbanBoardState,
  type PresenceFace,
} from "@t3tools/client-runtime/ardud/kanban";
import { formatTimeOfDay } from "@t3tools/client-runtime/ardud/common";
import type {
  KanbanBlock,
  KanbanDiscussion,
  KanbanMessage,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../components/ComposerPromptEditor";
import {
  EMPTY_COMPOSER_CONTEXT_RECORDS,
  type ComposerDraftContextRecords,
} from "../../components/composerContextPresentation";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { threadContextRecord, threadContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useNowMs } from "./useNowMs";
import { kanban, kanbanErrorMessage, runAction, useFeed, useMessages } from "./kanbanStore";
import { KanbanMarkdown } from "./links";
import { Avatar, Chip, Glyph, stageGlyph } from "./parts";

/** One discussion: messages, read receipts, typing and the composer. */
export function Chat(props: {
  boardId: string;
  discussion: KanbanDiscussion;
  state: KanbanBoardState;
  onOpenCard?: (cardId: string) => void;
  className?: string;
}) {
  const { boardId, discussion, state } = props;
  const messages = useMessages(boardId, discussion.id);
  const feed = useFeed(kanban.messages(boardId, discussion.id));
  const nowMs = useNowMs();
  const presence = discussionPresence(discussion, messages ?? [], nowMs);
  const lastSeq = messages?.at(-1)?.seq ?? 0;

  const unread = state.unread.get(discussion.id) ?? 0;

  useEffect(() => {
    if (lastSeq > 0 && unread > 0) kanban.markRead(boardId, discussion.id, lastSeq);
  }, [boardId, discussion.id, lastSeq, unread]);

  const lastOwnSeq = messages?.findLast((message) => message.author._tag === "owner")?.seq;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", props.className)}>
      {/* Column-reverse keeps the view pinned to the newest message without a scroll effect. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain">
        <div className="flex shrink-0 flex-col gap-3.5 py-4">
          {feed.failure ? (
            <p role="status" className="flex items-center gap-3 text-sm text-(--m-muted)">
              <span className="min-w-0 flex-1">
                Couldn't load messages. {kanbanErrorMessage(feed.failure.error)}
              </span>
              <button
                type="button"
                onClick={feed.retry}
                className="h-7 shrink-0 rounded-full bg-(--m-chip) px-3 font-medium text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              >
                Retry
              </button>
            </p>
          ) : null}
          {messages === undefined ? null : messages.length === 0 ? (
            <p className="text-(--m-muted)">No messages yet.</p>
          ) : (
            messages.map((message) => (
              <Message
                key={message.seq}
                boardId={boardId}
                message={message}
                cards={state.cards}
                onOpenCard={props.onOpenCard}
                seen={message.seq === lastOwnSeq ? presence.seenBy : undefined}
              />
            ))
          )}
          {presence.typing.map((face) => (
            <div key={face.key} className="grid grid-cols-[28px_1fr] items-center gap-2.5">
              <Avatar kind={face.kind} letter={face.letter} name={face.name} />
              <span
                className="inline-flex h-7.5 w-fit items-center gap-1 rounded-full bg-(--m-surface) px-3"
                role="status"
                aria-label={`${face.name} is typing`}
              >
                <i className="size-1.5 rounded-full bg-(--m-muted)" />
                <i className="size-1.5 rounded-full bg-(--m-muted) opacity-70" />
                <i className="size-1.5 rounded-full bg-(--m-muted) opacity-45" />
              </span>
            </div>
          ))}
        </div>
      </div>
      <Composer
        placeholder="Message"
        onSend={(text) => kanban.post(boardId, discussion.id, [{ _tag: "md", text }])}
      />
    </div>
  );
}

const Message = memo(function Message(props: {
  boardId: string;
  message: KanbanMessage;
  cards: KanbanBoardState["cards"];
  seen: ReadonlyArray<PresenceFace> | undefined;
  onOpenCard: ((cardId: string) => void) | undefined;
}) {
  const { message } = props;
  const time = formatTimeOfDay(message.createdAt);
  const blocks = message.blocks.map((block, index) => (
    <Block
      key={blockKey(block, index)}
      block={block}
      boardId={props.boardId}
      message={message}
      cards={props.cards}
      onOpenCard={props.onOpenCard}
    />
  ));

  if (message.author._tag === "owner") {
    return (
      <div className="flex flex-col items-end gap-0.75">
        <div className="flex max-w-[78%] flex-col gap-2 rounded-2xl rounded-br-sm bg-(--m-surface) px-3.5 py-2.25">
          {blocks}
        </div>
        <span className="text-xs text-(--m-muted) tabular-nums">{time}</span>
        {props.seen && props.seen.length > 0 ? (
          <span
            className="flex gap-0.75"
            aria-label={`Seen by ${props.seen.map((face) => face.name).join(", ")}`}
          >
            {props.seen.map((face) => (
              <Avatar key={face.key} kind={face.kind} letter={face.letter} size="xs" />
            ))}
          </span>
        ) : null}
      </div>
    );
  }

  const face = avatarOf(message.author, message.authorName);
  return (
    <div className="grid grid-cols-[28px_1fr] gap-2.5">
      <Avatar kind={face.kind} letter={face.letter} name={message.authorName} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <b className="text-sm font-medium">{message.authorName}</b>
          <span className="text-xs text-(--m-muted) tabular-nums">{time}</span>
        </span>
        <div className="flex max-w-[88%] min-w-0 flex-col gap-2 self-start rounded-2xl rounded-tl-sm bg-(--m-surface) px-3.5 py-2.25">
          {blocks}
        </div>
      </div>
    </div>
  );
});

function blockKey(block: KanbanBlock, index: number) {
  return block._tag === "choice" ? `choice:${block.id}` : `${block._tag}:${index}`;
}

function Block(props: {
  block: KanbanBlock;
  boardId: string;
  message: KanbanMessage;
  cards: KanbanBoardState["cards"];
  onOpenCard: ((cardId: string) => void) | undefined;
}) {
  const { block } = props;
  switch (block._tag) {
    case "md":
      return (
        <div className="min-w-0 text-sm leading-normal">
          <KanbanMarkdown text={block.text} />
        </div>
      );
    case "collapse":
      return (
        <details className="group rounded-xl bg-(--m-ground)">
          <summary className="flex h-8 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden
              className="size-1.5 -rotate-45 border-r-2 border-b-2 border-current transition-transform group-open:rotate-45"
            />
            {block.title}
          </summary>
          <div className="px-3 pb-2.5 text-sm">
            <KanbanMarkdown text={block.text} />
          </div>
        </details>
      );
    case "html":
      return (
        <iframe
          title={block.title ?? "Attachment"}
          sandbox=""
          srcDoc={block.html}
          className="w-full rounded-xl bg-(--m-ground)"
          style={{ height: block.height ?? 240 }}
        />
      );
    case "image":
      return (
        <img
          src={block.url}
          alt={block.alt ?? ""}
          className="max-h-80 w-auto max-w-full rounded-xl object-contain"
        />
      );
    // Composer and rendering for uploads come in the follow-up cards; until then, the name only.
    case "attachment":
      return <p className="text-sm text-(--m-muted)">{block.attachment.name}</p>;
    case "card": {
      const card = props.cards.get(block.cardId);
      if (!card) return <span className="text-(--m-muted)">Card</span>;
      return (
        <button
          type="button"
          onClick={() => props.onOpenCard?.(card.id)}
          className="flex min-h-9 items-center gap-2 rounded-xl bg-(--m-ground) px-3 text-left text-sm font-medium outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
        >
          <Glyph kind={stageGlyph(card.stage)} />
          <span className="min-w-0 flex-1 truncate">{card.title}</span>
          <span className="text-xs text-(--m-muted) tabular-nums">#{card.number}</span>
        </button>
      );
    }
    case "choice":
      return <ChoiceBlock block={block} boardId={props.boardId} message={props.message} />;
  }
}

interface ChoiceDraft {
  readonly choice: ReadonlyArray<string>;
  readonly text: string;
  readonly against: string | null;
  readonly sent: boolean;
}

function ChoiceBlock(props: {
  block: Extract<KanbanBlock, { _tag: "choice" }>;
  boardId: string;
  message: KanbanMessage;
}) {
  const { block, message } = props;
  const answers = message.answers.filter((answer) => answer.blockId === block.id);
  const own = ownerChoiceAnswer(block, message.answers);
  const mine = own?.choice ?? [];
  // A multi pick being put together, or an answer on its way. It holds until
  // the owner's own answer on this block changes, so re-reads and other
  // people's answers don't drop it, and it can't flicker back early.
  const ownAt = own?.at ?? null;
  const [draft, setDraft] = useState<ChoiceDraft | null>(null);
  const [sending, setSending] = useState(false);
  const current = draft !== null && draft.against === ownAt ? draft : null;
  // Words he sent but the server hasn't echoed yet still show as his answer.
  const sentWords = current?.sent && current.text.trim() !== "" ? current.text.trim() : null;
  const ownWords = own?.text ?? sentWords;
  const picked = current?.choice ?? mine;
  const words = current?.text ?? "";
  const answered = mine.length > 0 || own?.text != null || current?.sent === true;
  const recommended = block.options[0]?.id;

  const send = async (choice: ReadonlyArray<string>, text: string) => {
    if (!canSendChoice(block, choice, text) || sending) return;
    const against = ownAt;
    setDraft({ choice, text, against, sent: true });
    setSending(true);
    const ok = await runAction("Couldn't send your answer", () =>
      kanban.answer(
        props.boardId,
        message.discussionId,
        message.seq,
        block.id,
        [...choice],
        text.trim() || null,
      ),
    );
    setSending(false);
    // A failed pick keeps what was ticked and typed so it can be sent again.
    if (!ok)
      setDraft(
        block.multi || text.trim() !== ""
          ? { choice: block.multi ? choice : [], text, against, sent: false }
          : null,
      );
  };

  // A poll takes every change at once (votes can change); a multi pick waits
  // for Send. A vote can move but never empty: the server keeps one.
  const toggle = (optionId: string) => {
    if (answered && block.style === "pick") return;
    const next = block.multi
      ? picked.includes(optionId)
        ? picked.filter((id) => id !== optionId)
        : [...picked, optionId]
      : [optionId];
    if (block.style === "poll" || !block.multi) {
      void send(next, "");
      return;
    }
    setDraft({ choice: next, text: words, against: ownAt, sent: false });
  };

  if (block.style === "poll") {
    const total = answers.length;
    return (
      <div className="flex flex-col gap-1.5">
        <p className="font-medium">{block.question}</p>
        {block.options.map((option) => {
          const votes = answers.filter((answer) => answer.choice.includes(option.id)).length;
          const share = total === 0 ? 0 : Math.round((votes / total) * 100);
          const on = picked.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              disabled={sending}
              onClick={() => toggle(option.id)}
              aria-pressed={on}
              className={cn(
                "relative flex h-8.5 items-center gap-2.5 overflow-hidden rounded-lg bg-(--m-ground) px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                on && "font-medium",
              )}
            >
              <span
                className="absolute inset-y-0 left-0 bg-(--m-band)"
                style={{ width: `${share}%` }}
              />
              <span className="relative min-w-0 flex-1 truncate">{option.label}</span>
              <span className="relative text-xs text-(--m-muted) tabular-nums">{share}%</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-medium">{block.question}</p>
      {block.options.map((option) => {
        const on = picked.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            role={block.multi ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={answered || sending}
            onClick={() => toggle(option.id)}
            className={cn(
              "flex min-h-9 items-center gap-2.5 rounded-xl bg-(--m-ground) px-3 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:cursor-default",
              on && "ring-2 ring-inset ring-(--m-accent)",
              answered && !on && "opacity-55",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                block.multi ? "rounded-sm" : "rounded-full",
                on ? "ring-4 ring-inset ring-(--m-accent)" : "ring-2 ring-inset ring-(--m-control)",
              )}
            />
            <span className="min-w-0 flex-1">{option.label}</span>
            {option.id === recommended && !answered ? (
              <Chip className="h-5 bg-(--m-band) text-2xs text-(--m-accent-text)">Recommended</Chip>
            ) : null}
          </button>
        );
      })}
      {!answered ? (
        <div className="flex min-h-9 items-center gap-2.5 rounded-xl bg-(--m-ground) px-3 py-1.5 text-sm ring-inset focus-within:ring-2 focus-within:ring-(--m-accent)">
          <textarea
            rows={1}
            value={words}
            placeholder="Your own answer"
            aria-label="Your own answer"
            onChange={(event) =>
              setDraft({ choice: picked, text: event.target.value, against: ownAt, sent: false })
            }
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send(block.multi ? picked : [], words);
            }}
            className="max-h-32 min-w-0 flex-1 resize-none bg-transparent text-sm leading-5 text-(--m-text) outline-none [field-sizing:content] placeholder:text-(--m-muted)"
          />
          {block.multi ? null : (
            <button
              type="button"
              aria-label="Send your answer"
              disabled={!canSendChoice(block, [], words) || sending}
              onClick={() => void send([], words)}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--m-accent) text-(--m-accent-ink) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-text) disabled:opacity-50"
            >
              <ArrowUpIcon className="size-4" aria-hidden />
            </button>
          )}
        </div>
      ) : ownWords !== null ? (
        <div className="flex min-h-9 items-center gap-2.5 rounded-xl bg-(--m-ground) px-3 py-1.5 text-left text-sm ring-2 ring-inset ring-(--m-accent)">
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-full ring-4 ring-inset ring-(--m-accent)"
          />
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{ownWords}</span>
        </div>
      ) : null}
      {block.multi && !answered ? (
        <button
          type="button"
          disabled={!canSendChoice(block, picked, words) || sending}
          onClick={() => void send(picked, words)}
          className="h-8 self-start rounded-full bg-(--m-accent) px-3.5 text-sm font-medium text-(--m-accent-ink) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-text) disabled:opacity-50"
        >
          Send
        </button>
      ) : null}
    </div>
  );
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const THREAD_LINK = /\[([^\]\n]*)\]\((t3-thread:\/\/v1\/[^\s)]+)\)/g;

/**
 * Message box: Enter sends, Shift+Enter breaks the line. A pasted board link
 * turns into a chip, the same way thread links do in the thread composer.
 */
export function Composer(props: {
  placeholder: string;
  onSend: (text: string) => Promise<unknown>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [records, setRecords] = useState<ComposerDraftContextRecords>(
    EMPTY_COMPOSER_CONTEXT_RECORDS,
  );
  const [sending, setSending] = useState(false);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

  // Thread chips go out as plain thread links, which messages show as live
  // links and agents can read.
  const outgoing = (value: string) =>
    replaceComposerContextReferences(value, (reference) => {
      const entry = records.get(reference.contextId);
      return entry?.kind === "thread"
        ? formatThreadLink(entry.record.threadId, entry.record.title)
        : reference.source;
    });

  const send = async () => {
    const body = outgoing(text).trim();
    if (body.length === 0 || sending) return;
    setSending(true);
    const ok = await runAction("Couldn't send", () => props.onSend(body));
    setSending(false);
    if (ok) {
      setText("");
      setCursor(0);
      setRecords(EMPTY_COMPOSER_CONTEXT_RECORDS);
    }
    editorRef.current?.focus();
  };

  // A pasted thread link becomes a thread chip, like in a thread's composer.
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const pasted = event.clipboardData.getData("text/plain");
    if (environmentId === null || !pasted.includes("](t3-thread://v1/")) return;
    const added = new Map(records);
    const converted = pasted.replace(THREAD_LINK, (source, label: string, href: string) => {
      const threadId = parseThreadLinkHref(href);
      if (threadId === null) return source;
      const record = threadContextRecord({ environmentId, threadId }, label || threadId);
      added.set(record.contextId, { kind: "thread", record });
      return formatInlineContextReference(threadContextReference(record));
    });
    if (converted === pasted) return;
    event.preventDefault();
    event.stopPropagation();
    const range = editorRef.current?.readSelectionRange() ?? {
      start: text.length,
      end: text.length,
    };
    const next = `${text.slice(0, range.start)}${converted}${text.slice(range.end)}`;
    const nextCursor = collapseExpandedComposerCursor(next, range.start + converted.length);
    setRecords(added);
    setText(next);
    setCursor(nextCursor);
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

  return (
    <form
      className="mb-3.5 flex min-h-11 shrink-0 items-end gap-1.5 rounded-3xl bg-(--m-surface) py-1.5 ps-4 pe-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="min-w-0 flex-1 py-1.5">
        <ComposerPromptEditor
          value={text}
          cursor={cursor}
          contextRecords={records}
          skills={NO_SKILLS}
          disabled={false}
          placeholder={props.placeholder}
          ariaLabel={props.placeholder}
          className="max-h-40 min-h-5 text-sm leading-5 text-(--m-text)"
          placeholderClassName="leading-5 text-(--m-muted)"
          editorRef={editorRef}
          onPaste={onPaste}
          onChange={(value, nextCursor) => {
            setText(value);
            setCursor(nextCursor);
          }}
          onCommandKeyDown={(key, event) => {
            if (key !== "Enter" || event.shiftKey) return false;
            void send();
            return true;
          }}
        />
      </div>
      <button
        type="submit"
        disabled={text.trim().length === 0 || sending}
        aria-label="Send"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-(--m-text) text-(--m-ground) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-40"
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </form>
  );
}
