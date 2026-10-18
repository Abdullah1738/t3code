import { useState, type ReactNode } from "react";

import {
  approverOf,
  type Approval,
  type Ask,
  type Draft,
  type DraftNote,
  type Knock,
  type Note,
  type Suggestion,
  type SuggestionStats,
} from "@t3tools/contracts";
import {
  actorLabel,
  APPROVAL_STATUS_LABEL,
  APPROVER_LABEL,
  askView,
  DRAFT_CHANNEL_LABEL,
  draftNotesFor,
  draftNoteScopeLabel,
  formatRelative,
  fyiView,
  decideLine,
  openForkFor,
  parseDiffLines,
  refLabel,
  routeLine,
  SUGGESTION_AUTHOR_LABEL,
  SUGGESTION_TARGET_LABEL,
  suggestionAfterText,
  suggestionTrackRecord,
  textEdit,
  type MissionForkEntry,
} from "@t3tools/client-runtime/ardud/missions";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { MissionLinkList, MissionLinkText } from "./MissionLinkText";
import { rerouteRecord } from "./operationCommands";
import { LineDiff, WordDiff } from "./TextDiffView";
import { inboxItemDomId, type InboxActions } from "./useInboxScreen";

// Inbox cards. Presentation plus local text-field state; decisions, input
// validation and wording come from client-runtime (inboxViewModel) through
// `InboxActions`. Restyle freely.

function InboxCard(props: {
  itemKey: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <article
      id={inboxItemDomId(props.itemKey)}
      data-selected={props.selected || undefined}
      onClickCapture={props.onSelect}
      onFocusCapture={props.onSelect}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm",
        props.selected ? "border-ring" : "border-border/60",
      )}
    >
      {props.children}
    </article>
  );
}

function Meta(props: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{props.children}</p>;
}

function Actions(props: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{props.children}</div>;
}

// ---------------------------------------------------------------------------
// Decide

export function AskCard(props: {
  ask: Ask;
  selected: boolean;
  onSelect: () => void;
  picked: string | null;
  onPick: (optionId: string | null) => void;
  forks: ReadonlyArray<MissionForkEntry>;
  nowMs: number;
  masterRoleId: string | null;
  actions: InboxActions;
}) {
  const { ask } = props;
  const view = askView(ask, props.nowMs, props.masterRoleId);
  const discussing = openForkFor(props.forks, { kind: "ask", id: ask.id });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<boolean>, clear: boolean) => {
    setBusy(true);
    const sent = await action();
    setBusy(false);
    if (sent && clear) setText("");
  };
  return (
    <InboxCard itemKey={`ask:${ask.id}`} selected={props.selected} onSelect={props.onSelect}>
      <Meta>
        Asked by {view.askedBy} · {view.waiting}
        {view.urgent ? " · P0" : ""}
      </Meta>
      <h3 className="font-medium text-foreground">{ask.question}</h3>
      {ask.context ? <p className="text-muted-foreground">{ask.context}</p> : null}
      {view.recommendation ? <p>{view.recommendation}</p> : null}
      <p className="text-muted-foreground">{view.blocks}</p>
      {ask.costOfWaiting ? (
        <p className="text-muted-foreground">Cost of waiting: {ask.costOfWaiting}</p>
      ) : null}
      <div role="group" aria-label="Options" className="flex flex-col gap-1.5">
        {view.options.map((option) => {
          const isPicked = props.picked === option.id;
          return (
            <Button
              key={option.id}
              variant={isPicked ? "secondary" : "outline"}
              size="sm-multiline"
              aria-pressed={isPicked}
              onClick={() => props.onPick(isPicked ? null : option.id)}
            >
              {option.shortcut ? <Kbd>{option.shortcut}</Kbd> : null}
              <span>
                {option.label}
                {option.recommended ? " (master's recommendation)" : ""}
              </span>
            </Button>
          );
        })}
      </div>
      <Textarea
        size="sm"
        aria-label="Your answer"
        placeholder="Answer in your own words, with or without an option"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Actions>
        <Button
          size="sm"
          disabled={busy || (props.picked === null && text.trim() === "")}
          onClick={() => void run(() => props.actions.answer(ask, props.picked, text), true)}
        >
          Send answer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => props.actions.discuss(ask, text), true)}
        >
          Discuss first
        </Button>
        {discussing ? <Meta>Discussing in a fork of the master.</Meta> : null}
      </Actions>
    </InboxCard>
  );
}

// ---------------------------------------------------------------------------
// Approve

export function DraftCard(props: {
  draft: Draft;
  selected: boolean;
  onSelect: () => void;
  editing: boolean;
  onEdit: (open: boolean) => void;
  notes: ReadonlyArray<DraftNote>;
  masterRoleId: string | null;
  nowMs: number;
  actions: InboxActions;
}) {
  const { draft } = props;
  const [edited, setEdited] = useState(draft.text);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteNote, setRewriteNote] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = draftNotesFor(draft, props.notes);
  const liveEdit = props.editing ? textEdit(draft.text, edited) : null;
  const decide = async (decision: Parameters<InboxActions["decideDraft"]>[1]) => {
    setBusy(true);
    await props.actions.decideDraft(draft, decision);
    setBusy(false);
  };
  const writer = draft.writerRoleId
    ? actorLabel({ _tag: "role", roleId: draft.writerRoleId } as never, props.masterRoleId)
    : draft.source.kind;
  return (
    <InboxCard itemKey={`draft:${draft.id}`} selected={props.selected} onSelect={props.onSelect}>
      <Meta>
        Draft to {draft.audience} · {DRAFT_CHANNEL_LABEL[draft.channel]} ·{" "}
        <MissionLinkText link={draft.target} /> · written by {writer} ·{" "}
        {formatRelative(draft.createdAt, props.nowMs)}
      </Meta>
      <RouteMeta record={draft} kind="draft" />
      {props.editing ? (
        <>
          <Textarea
            aria-label="Edit the draft"
            autoFocus
            value={edited}
            onChange={(event) => setEdited(event.target.value)}
          />
          {liveEdit?.changed ? (
            <div className="flex flex-col gap-1">
              <Meta>
                Your changes: {liveEdit.stats.addedWords} words added, {liveEdit.stats.removedWords}{" "}
                removed
              </Meta>
              <WordDiff segments={liveEdit.segments} />
            </div>
          ) : null}
        </>
      ) : (
        <p className="whitespace-pre-wrap text-foreground">{draft.text}</p>
      )}
      {notes.applied.length > 0 ? (
        <Meta>
          Notes applied:{" "}
          {notes.applied
            .map((note) => `${draftNoteScopeLabel(note.scope)}: ${note.text}`)
            .join(" · ")}
        </Meta>
      ) : null}
      {notes.skipped.length > 0 ? (
        <Meta>
          Notes not listed by the writer: {notes.skipped.map((note) => note.text).join(" · ")}
        </Meta>
      ) : null}
      {rewriting ? (
        <Textarea
          size="sm"
          aria-label="What should change"
          placeholder="What should the writer change?"
          autoFocus
          value={rewriteNote}
          onChange={(event) => setRewriteNote(event.target.value)}
        />
      ) : null}
      <Actions>
        {props.editing ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void decide({ action: "edit-approve", editedText: edited })}
            >
              Approve edited
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEdited(draft.text);
                props.onEdit(false);
              }}
            >
              Cancel edit
            </Button>
          </>
        ) : rewriting ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void decide({ action: "rewrite", note: rewriteNote })}
            >
              Send back for rewrite
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRewriting(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => void decide({ action: "approve" })}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => props.onEdit(true)}>
              <Kbd>e</Kbd> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRewriting(true)}>
              Request rewrite
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void decide({ action: "drop" })}
            >
              Drop
            </Button>
          </>
        )}
      </Actions>
    </InboxCard>
  );
}

export function ApprovalCard(props: {
  approval: Approval;
  selected: boolean;
  onSelect: () => void;
  masterRoleId: string | null;
  nowMs: number;
  actions: InboxActions;
}) {
  const { approval } = props;
  const [busy, setBusy] = useState(false);
  const decide = async (action: "approve" | "reject") => {
    setBusy(true);
    await props.actions.decideApproval(approval, action);
    setBusy(false);
  };
  return (
    <InboxCard
      itemKey={`approval:${approval.id}`}
      selected={props.selected}
      onSelect={props.onSelect}
    >
      <Meta>
        {approval.kind} approval · requested by {approval.requestedBy} ·{" "}
        {formatRelative(approval.createdAt, props.nowMs)}
      </Meta>
      <RouteMeta record={approval} kind="approval" />
      <h3 className="font-medium text-foreground">{approval.title}</h3>
      {approval.detail ? <p className="text-muted-foreground">{approval.detail}</p> : null}
      {approval.links.length > 0 ? (
        <Meta>
          <MissionLinkList links={approval.links} />
        </Meta>
      ) : null}
      <Actions>
        <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </Button>
      </Actions>
    </InboxCard>
  );
}

/** A decided approval in the history list (stale ones show why they closed). */
export function ClosedApprovalRow(props: { approval: Approval; nowMs: number }) {
  const { approval } = props;
  return (
    <li className="text-sm">
      <span className="text-foreground">{approval.title}</span>{" "}
      <span className="text-muted-foreground">
        · {APPROVAL_STATUS_LABEL[approval.status]}
        {approval.decidedAt ? ` ${formatRelative(approval.decidedAt, props.nowMs)}` : ""}
        {approval.staleReason ? ` · ${approval.staleReason}` : ""}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Knocks

export function KnockCard(props: {
  knock: Knock;
  selected: boolean;
  onSelect: () => void;
  editing: boolean;
  onEdit: (open: boolean) => void;
  nowMs: number;
  actions: InboxActions;
}) {
  const { knock } = props;
  const [edited, setEdited] = useState(knock.summary);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: Parameters<InboxActions["decideKnock"]>[1]) => {
    setBusy(true);
    await props.actions.decideKnock(knock, decision);
    setBusy(false);
  };
  return (
    <InboxCard itemKey={`knock:${knock.id}`} selected={props.selected} onSelect={props.onSelect}>
      <Meta>
        From “{knock.fromTitle}” · via {knock.path} · {formatRelative(knock.createdAt, props.nowMs)}
      </Meta>
      {props.editing ? (
        <Textarea
          aria-label="What to forward"
          autoFocus
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
        />
      ) : (
        <p className="text-foreground">{knock.summary}</p>
      )}
      {knock.body && !props.editing ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{knock.body}</p>
      ) : null}
      <Actions>
        {props.editing ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void decide({ action: "forward", editedText: edited })}
            >
              Forward edited
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEdited(knock.summary);
                props.onEdit(false);
              }}
            >
              Cancel edit
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => void decide({ action: "forward" })}>
              Forward to master
            </Button>
            <Button size="sm" variant="outline" onClick={() => props.onEdit(true)}>
              <Kbd>e</Kbd> Edit + forward
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void decide({ action: "drop" })}
            >
              Drop
            </Button>
          </>
        )}
      </Actions>
    </InboxCard>
  );
}

// ---------------------------------------------------------------------------
// Suggestions

export function SuggestionCard(props: {
  suggestion: Suggestion;
  selected: boolean;
  onSelect: () => void;
  stats: ReadonlyArray<SuggestionStats>;
  nowMs: number;
  actions: InboxActions;
}) {
  const { suggestion } = props;
  const [mode, setMode] = useState<"idle" | "edit" | "dismiss">("idle");
  const [edited, setEdited] = useState(() => suggestionAfterText(suggestion));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const record = suggestionTrackRecord(props.stats, suggestion);
  const decide = async (decision: Parameters<InboxActions["decideSuggestion"]>[1]) => {
    setBusy(true);
    await props.actions.decideSuggestion(suggestion, decision);
    setBusy(false);
  };
  return (
    <InboxCard
      itemKey={`suggestion:${suggestion.id}`}
      selected={props.selected}
      onSelect={props.onSelect}
    >
      <Meta>
        {SUGGESTION_TARGET_LABEL[suggestion.targetKind]}
        {suggestion.target ? ` · ${refLabel(suggestion.target)}` : ""} · from{" "}
        {SUGGESTION_AUTHOR_LABEL[suggestion.author]} ({record.author.label}) ·{" "}
        {suggestion.acceptor === "owner" ? "you decide" : "master decides, you can overrule"} ·{" "}
        {formatRelative(suggestion.createdAt, props.nowMs)}
      </Meta>
      <h3 className="font-medium text-foreground">{suggestion.title}</h3>
      <LineDiff lines={parseDiffLines(suggestion.diffText)} />
      {suggestion.why ? <p className="text-muted-foreground">Why: {suggestion.why}</p> : null}
      {suggestion.evidence.length > 0 ? (
        <Meta>
          Evidence: <MissionLinkList links={suggestion.evidence} />
        </Meta>
      ) : null}
      {record.kind ? (
        <Meta>
          On {SUGGESTION_TARGET_LABEL[suggestion.targetKind].toLowerCase()}: {record.kind.label}
          {record.kind.bar !== "normal" ? ` · bar ${record.kind.bar}` : ""}
        </Meta>
      ) : null}
      {mode === "edit" ? (
        <Textarea
          aria-label="Edited change"
          autoFocus
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
        />
      ) : null}
      {mode === "dismiss" ? (
        <Textarea
          size="sm"
          aria-label="Why dismiss"
          placeholder="Why not? The author learns from this."
          autoFocus
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      ) : null}
      <Actions>
        {mode === "idle" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => void decide({ action: "accept" })}>
              Accept
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
              Accept edited
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("dismiss")}>
              Dismiss
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void decide(
                  mode === "edit"
                    ? { action: "accept-edited", editedText: edited }
                    : { action: "dismiss", reason },
                )
              }
            >
              {mode === "edit" ? "Accept this version" : "Dismiss"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </>
        )}
      </Actions>
    </InboxCard>
  );
}

// ---------------------------------------------------------------------------
// FYI

const SEVERITY_BADGE = {
  low: "outline",
  medium: "secondary",
  high: "warning",
  critical: "error",
} as const;

export function NoteCard(props: {
  note: Note;
  selected: boolean;
  onSelect: () => void;
  nowMs: number;
  actions: InboxActions;
}) {
  const { note } = props;
  const view = fyiView(note);
  const [busy, setBusy] = useState(false);
  return (
    <InboxCard itemKey={`note:${note.id}`} selected={props.selected} onSelect={props.onSelect}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={SEVERITY_BADGE[view.severity]} size="sm">
          {view.severity}
        </Badge>
        <Meta>
          {view.heading} · {view.basis}
          {view.evidence ? ` · ${view.evidence.label}` : ""}
          {view.citation ? ` · ${view.citation}` : ""} ·{" "}
          {formatRelative(note.createdAt, props.nowMs)}
        </Meta>
      </div>
      <p className="text-foreground">{note.summary}</p>
      {view.quote ? (
        <blockquote className="border-s-2 border-border ps-2 text-muted-foreground">
          “{view.quote}”{view.sourceEvent !== null ? ` (coord #${view.sourceEvent})` : ""}
        </blockquote>
      ) : null}
      {note.evidenceLinks.length > 0 ? (
        <Meta>
          <MissionLinkList links={note.evidenceLinks} />
        </Meta>
      ) : null}
      <Actions>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await props.actions.ack(note);
            setBusy(false);
          }}
        >
          Got it
        </Button>
      </Actions>
    </InboxCard>
  );
}

/**
 * Whose inbox a draft or approval is routed to and why, with a way to move it.
 * Whoever it waits on, you can still decide it here.
 */
function RouteMeta(props: { record: Draft | Approval; kind: "draft" | "approval" }) {
  const [moving, setMoving] = useState(false);
  const [reason, setReason] = useState("");
  const to = approverOf(props.record) === "owner" ? "master" : "owner";
  const note = routeLine(props.record);
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{decideLine(props.record)}</span>
        {note ? <span>{note}</span> : null}
        <button
          type="button"
          className="underline"
          onClick={(event) => {
            event.stopPropagation();
            setMoving(!moving);
          }}
        >
          Move to {APPROVER_LABEL[to]}
        </button>
      </p>
      {moving ? (
        <form
          className="flex flex-wrap gap-2"
          onClick={(event) => event.stopPropagation()}
          onSubmit={async (event) => {
            event.preventDefault();
            if (await rerouteRecord(props.kind, props.record, to, reason)) {
              setMoving(false);
              setReason("");
            }
          }}
        >
          <Textarea
            size="sm"
            aria-label="Why move it?"
            placeholder="Why move it?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline">
            Move
          </Button>
        </form>
      ) : null}
    </div>
  );
}
