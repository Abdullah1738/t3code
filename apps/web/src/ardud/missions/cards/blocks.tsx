import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  MailIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  PencilIcon,
  ReplyIcon,
  SendIcon,
  TicketIcon,
  Undo2Icon,
} from "lucide-react";

import type { DraftChannel, MissionLink, MissionRecordRef } from "@t3tools/contracts";
import {
  DRAFT_CHANNEL_LABEL,
  type DiffLine,
  type DiffSegment,
  type ReplyContextView,
} from "@t3tools/client-runtime/ardud/missions";

import { GitHubIcon } from "../../../components/Icons";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { observeResize } from "../../../lib/observeResize";
import { cn } from "../../../lib/utils";
import {
  AnyLinkChip,
  Avatar,
  ChipRow,
  linkKey,
  LinkChip,
  PersonChip,
  type AvatarKind,
} from "./chips";

// Card body blocks. Each is a plain presentational component fed by props, so
// the views track can map template nodes straight onto them. Props are
// documented in tmp/memory/missions-build/notes/ui-web.md.

// ---------------------------------------------------------------------------
// text, label

const CLAMP = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;

export type MaxLines = keyof typeof CLAMP;

/** Body or meta text, optionally clamped to 1-6 lines. */
export function TextBlock(props: { text: string; tone?: "body" | "meta"; maxLines?: MaxLines }) {
  if (props.text.trim() === "") return null;
  return (
    <p
      className={cn(
        "text-sm leading-5.5 text-pretty whitespace-pre-line wrap-anywhere",
        props.tone === "meta" ? "text-(--m-muted)" : "text-(--m-text)",
        props.maxLines ? CLAMP[props.maxLines] : null,
      )}
    >
      {props.text}
    </p>
  );
}

/** A fixed short label (60 characters at most). */
export function LabelBlock(props: { text: string }) {
  return <p className="text-xs font-medium text-(--m-muted)">{props.text}</p>;
}

// ---------------------------------------------------------------------------
// facts, flags, links, refs

export interface FactRow {
  /** 24 characters at most. */
  readonly label: string;
  readonly value: ReactNode;
}

/** Label and value pairs on a two-column grid. Rows with no value are left out. */
export function FactsBlock(props: { rows: ReadonlyArray<FactRow> }) {
  const rows = props.rows.filter((row) => row.value !== null && row.value !== "");
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-sm leading-5.5">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-xs leading-5.5 text-(--m-muted)">{row.label}</dt>
          <dd className="min-w-0 text-(--m-text)">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type FlagTone = "neutral" | "warning" | "error";

const FLAG_VARIANT = { neutral: "outline", warning: "warning", error: "error" } as const;

export interface Flag {
  readonly label: string;
  readonly tone?: FlagTone;
}

/** Short state words as chips. */
export function FlagsBlock(props: { flags: ReadonlyArray<Flag | string> }) {
  if (props.flags.length === 0) return null;
  return (
    <ChipRow>
      {props.flags.map((flag) => {
        const { label, tone = "neutral" } = typeof flag === "string" ? { label: flag } : flag;
        return (
          <Badge key={label} variant={FLAG_VARIANT[tone]} size="sm">
            {label}
          </Badge>
        );
      })}
    </ChipRow>
  );
}

/** Outside links (PRs, tickets, runs) as link chips, plus anything else on the row. */
export function LinksBlock(props: { links: ReadonlyArray<MissionLink>; children?: ReactNode }) {
  if (props.links.length === 0 && !props.children) return null;
  return (
    <ChipRow>
      {props.links.map((link) => (
        <LinkChip key={linkKey(link)} link={link} />
      ))}
      {props.children}
    </ChipRow>
  );
}

/** Records inside the mission, or links, as chips. */
export function RefsBlock(props: { refs: ReadonlyArray<MissionRecordRef | MissionLink> }) {
  if (props.refs.length === 0) return null;
  return (
    <ChipRow>
      {props.refs.map((ref) => (
        <AnyLinkChip key={linkKey(ref)} link={ref} />
      ))}
    </ChipRow>
  );
}

// ---------------------------------------------------------------------------
// group

/** Lays out 1-6 child blocks in a column or a row. No border, no box. */
export function GroupBlock(props: { direction?: "column" | "row"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-w-0 gap-2.5",
        props.direction === "row" ? "flex-row flex-wrap items-start" : "flex-col",
      )}
    >
      {props.children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// choice

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** Gets a "Recommended" mark. Who recommended it is left out (owner, 19 Oct). */
  readonly recommended: boolean;
}

/** One-of buttons. `advice` is the reason for the recommendation, shown under the options. */
export function ChoiceBlock(props: {
  options: ReadonlyArray<ChoiceOption>;
  picked: string | null;
  onPick: (optionId: string | null) => void;
  advice?: string | null;
  disabled?: boolean;
}) {
  if (props.options.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Answers" className="flex flex-col gap-2">
        {props.options.map((option) => {
          const pressed = props.picked === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={pressed}
              disabled={props.disabled}
              onClick={() => props.onPick(pressed ? null : option.id)}
              className={cn(
                "grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 rounded-xl bg-(--m-raised) px-3.5 py-3 text-start text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-64",
                pressed ? "ring-2 ring-(--m-accent) ring-inset" : "hover:bg-(--m-active)",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-3.5 rounded-full",
                  pressed ? "border-4 border-(--m-accent)" : "border border-(--m-control)",
                )}
              />
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-(--m-text)">{option.label}</span>
                {option.recommended ? (
                  <span className="text-xs text-(--m-muted)">Recommended</span>
                ) : null}
              </span>
              {option.detail ? (
                <span className="col-start-2 text-xs leading-4.5 text-(--m-muted)">
                  {option.detail}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {props.advice ? (
        <p className="text-sm leading-5.5 text-pretty text-(--m-muted)">{props.advice}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// draft

const CHANNEL_ICON: Record<DraftChannel, typeof MailIcon | typeof GitHubIcon> = {
  github: GitHubIcon,
  linear: TicketIcon,
  cliq: MessageSquareIcon,
  imessage: MessageCircleIcon,
  whatsapp: MessageCircleIcon,
  email: MailIcon,
  telegram: SendIcon,
  other: SendIcon,
};

export interface DraftPerson {
  readonly kind: AvatarKind;
  readonly name: string;
  /** Read out before the name: "To ", "Written by ". */
  readonly prefix: string;
}

/**
 * Outgoing text the owner can edit in place. While editing, the text becomes a
 * field and a word diff against the original shows under it.
 */
export function DraftBlock(props: {
  /** `null` for text that goes somewhere other than a channel (a forwarded knock). */
  channel: DraftChannel | null;
  people: ReadonlyArray<DraftPerson>;
  link?: MissionLink | null;
  text: string;
  /** `null` when the block is read-only. */
  edit: {
    readonly editing: boolean;
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onStart: () => void;
    readonly onUndo: () => void;
    /** Word diff of `value` against `text`, empty when unchanged. */
    readonly diff: ReadonlyArray<DiffSegment>;
  } | null;
  maxLines?: MaxLines;
}) {
  const Icon = props.channel === null ? null : CHANNEL_ICON[props.channel];
  const edit = props.edit;
  const changed = edit !== null && edit.diff.some((segment) => segment.kind !== "same");
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg px-3 pt-2.5 pb-3",
        edit?.editing ? "bg-(--m-ground) ring-1 ring-(--m-control) ring-inset" : "bg-(--m-raised)",
      )}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-(--m-muted)">
        {Icon && props.channel !== null ? (
          <span role="img" aria-label={DRAFT_CHANNEL_LABEL[props.channel]}>
            <Icon aria-hidden className="size-3.5" />
          </span>
        ) : null}
        {props.people.map((person) => (
          <PersonChip
            key={`${person.prefix}${person.name}`}
            kind={person.kind}
            name={person.name}
            prefix={person.prefix}
          />
        ))}
        {props.link ? <LinkChip link={props.link} /> : null}
        {edit === null ? null : changed ? (
          <span className="ms-auto flex items-center gap-1">
            <span className="inline-flex items-center gap-1.5 font-medium text-(--m-accent-text)">
              <Avatar kind="you" small />
              Edited
            </span>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Undo your edits"
              onClick={edit.onUndo}
            >
              <Undo2Icon aria-hidden />
            </Button>
          </span>
        ) : edit.editing ? null : (
          <Button
            className="ms-auto"
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Edit the draft"
            onClick={edit.onStart}
          >
            <PencilIcon aria-hidden />
          </Button>
        )}
      </div>
      {edit?.editing ? (
        <Textarea
          unstyled
          aria-label="Edit the draft"
          autoFocus
          value={edit.value}
          onChange={(event) => edit.onChange(event.target.value)}
        />
      ) : (
        <TextBlock text={props.text} {...(props.maxLines ? { maxLines: props.maxLines } : {})} />
      )}
      {changed ? <WordDiffText segments={edit.diff} /> : null}
    </div>
  );
}

/**
 * What a draft answers, above its text: who and when, the quoted words clamped
 * to a few lines, and the writer's summary. One toggle opens both when either
 * is cut.
 */
export function ReplyContextBlock(props: { reply: ReplyContextView }) {
  const { reply } = props;
  const id = useId();
  const quote = useRef<HTMLQuoteElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (open) return;
    const measure = () => {
      const over = (element: HTMLElement | null) =>
        element !== null && element.scrollHeight > element.clientHeight + 1;
      setCut(over(quote.current) || over(summary.current));
    };
    measure();
    const stops = [quote.current, summary.current].flatMap((element) =>
      element === null ? [] : [observeResize(element, measure)],
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [open]);
  return (
    <div role="group" aria-label={reply.label} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--m-muted)">
        <span className="inline-flex items-center gap-1.5">
          <ReplyIcon aria-hidden className="size-3.5 shrink-0" />
          {reply.label}
        </span>
        {reply.author ? (
          <span className="min-w-0 truncate font-medium text-(--m-text)">{reply.author}</span>
        ) : null}
        {reply.when && reply.at ? (
          <time dateTime={reply.at} className="tabular-nums">
            {reply.when}
          </time>
        ) : null}
        {reply.link ? <LinkChip link={reply.link} /> : null}
      </div>
      <div id={id} className="flex min-w-0 flex-col gap-1.5">
        {reply.quote ? (
          <blockquote
            ref={quote}
            className={cn(
              "min-w-0 border-s-2 border-(--m-control) ps-2.5 text-sm leading-5.5 whitespace-pre-wrap wrap-anywhere text-(--m-muted)",
              !open && "line-clamp-3",
            )}
          >
            {reply.quote}
          </blockquote>
        ) : null}
        <p
          ref={summary}
          className={cn(
            "min-w-0 text-sm leading-5.5 text-pretty whitespace-pre-line wrap-anywhere text-(--m-text)",
            !open && "line-clamp-3",
          )}
        >
          {reply.summary}
        </p>
      </div>
      {cut || open ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="self-start"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

/** Stable keys for an ordered list of text pieces: kind plus character offset. */
function withOffsetKeys<T extends { readonly kind: string; readonly text: string }>(
  items: ReadonlyArray<T>,
): Array<{ readonly key: string; readonly item: T }> {
  const keyed: Array<{ readonly key: string; readonly item: T }> = [];
  let offset = 0;
  for (const item of items) {
    keyed.push({ key: `${item.kind}:${offset}`, item });
    offset += item.text.length + 1;
  }
  return keyed;
}

/** Inline word diff: removed words struck in red, added words in the update colour. */
export function WordDiffText(props: { segments: ReadonlyArray<DiffSegment> }) {
  return (
    <p className="text-sm leading-5.5 whitespace-pre-wrap wrap-anywhere text-(--m-text)">
      {withOffsetKeys(props.segments).map(({ key, item: segment }) => {
        if (segment.kind === "same") return <span key={key}>{segment.text}</span>;
        if (segment.kind === "removed") {
          return (
            <del key={key} className="rounded-sm bg-error/9 text-(--m-negative) line-through">
              {segment.text}
            </del>
          );
        }
        return (
          <ins key={key} className="rounded-sm bg-(--m-band) text-(--m-accent-text) no-underline">
            {segment.text}
          </ins>
        );
      })}
    </p>
  );
}

/** A "+"/"-" line diff, as suggestions carry it. */
export function LineDiffBlock(props: { lines: ReadonlyArray<DiffLine> }) {
  return (
    <div className="flex min-w-0 flex-col overflow-x-auto rounded-xl bg-(--m-raised) px-3 py-2 font-mono text-xs leading-5">
      {withOffsetKeys(props.lines).map(({ key, item: line }) => {
        return (
          <span
            key={key}
            className={cn(
              "whitespace-pre-wrap",
              line.kind === "added" && "text-(--m-accent-text)",
              line.kind === "removed" && "text-(--m-negative) line-through",
              line.kind === "context" && "text-(--m-muted)",
            )}
          >
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
            {line.text}
          </span>
        );
      })}
    </div>
  );
}
