import { memo, useMemo, useState } from "react";

import {
  approverOf,
  type Approval,
  type Approver,
  type Ask,
  type Draft,
  type DraftNote,
  type InboxMark,
  type Knock,
  type MissionListSnapshot,
  type Note,
  type Suggestion,
  type SuggestionStats,
} from "@t3tools/contracts";
import {
  actorLabel,
  APPROVAL_KICKER,
  APPROVAL_STATUS_LABEL,
  askView,
  cardSubMission,
  draftKicker,
  draftNotesFor,
  draftNoteScopeLabel,
  draftTitle,
  noteFlags,
  noteKicker,
  fyiView,
  ownerConditionOf,
  parseDiffLines,
  PLAN_KICKER,
  routeLine,
  SUGGESTION_AUTHOR_LABEL,
  SUGGESTION_TARGET_LABEL,
  suggestionAfterText,
  suggestionTrackRecord,
  textEdit,
  type InboxEntry,
  type InboxUiEvent,
  type InboxUiState,
} from "@t3tools/client-runtime/ardud/missions";

import { Textarea } from "../../components/ui/textarea";
import {
  ChoiceBlock,
  DraftBlock,
  FactsBlock,
  FlagsBlock,
  LineDiffBlock,
  LinksBlock,
  RefsBlock,
  TextBlock,
  type DraftPerson,
} from "./cards/blocks";
import { CardFrame, type CardAction, type CardFrameProps } from "./cards/CardFrame";
import { APPROVER_NAME, PersonChip } from "./cards/chips";
import { useItemMarks, type ItemMarks } from "./cards/ItemMarks";
import { useTemplatedCard } from "./cards/TemplatedCard";
import { ConditionNote, useCardDiscussion, type CardDiscussion } from "./DiscussPanel";
import { rerouteRecord } from "./operationCommands";
import { inboxItemDomId, type InboxActions } from "./useInboxScreen";

// Inbox cards: each maps one record onto the card frame and its blocks.
// Decisions, validation and wording come from client-runtime through
// `InboxActions`; local state is only what the owner is typing.

interface CardContext {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly nowMs: number;
  readonly list: MissionListSnapshot | undefined;
  readonly size?: CardFrameProps["size"];
  /** The owner's comments and snooze on the item. */
  readonly marks?: ItemMarks;
  /** Overrides the kind chip: the day-one plan reads "Approve the plan". */
  readonly kicker?: string;
}

function frame(
  context: CardContext,
  key: string,
): Pick<CardFrameProps, "domId" | "selected" | "onSelect" | "nowMs" | "size" | "end" | "comments"> {
  const marks = context.marks ? { end: context.marks.end, comments: context.marks.panel } : {};
  // In the reading pane the list row owns the item id and the selection mark.
  if (context.size === "pane") {
    return { onSelect: context.onSelect, nowMs: context.nowMs, size: "pane", ...marks };
  }
  return {
    domId: inboxItemDomId(key),
    selected: context.selected,
    onSelect: context.onSelect,
    nowMs: context.nowMs,
    ...(context.size ? { size: context.size } : {}),
    ...marks,
  };
}

/** Runs one decision at a time so its buttons disable while it is in flight. */
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true);
    const sent = await action();
    setBusy(false);
    return sent;
  };
  return [busy, run] as const;
}

/** Comment, then the card's Discuss action, last in the footer (none outside a mission). */
function withDiscuss(discussion: CardDiscussion, context: CardContext): CardAction[] {
  return [
    ...(context.marks ? [context.marks.comment] : []),
    ...(discussion.action ? [discussion.action] : []),
  ];
}

/** A short reason field for Rewrite, Drop-with-reason and Move. */
function ReasonField(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Textarea
      size="sm"
      aria-label={props.label}
      placeholder={props.placeholder}
      autoFocus
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// Decide

export function AskCard(
  props: CardContext & {
    ask: Ask;
    picked: string | null;
    onPick: (optionId: string | null) => void;
    masterRoleId: string | null;
    actions: InboxActions;
  },
) {
  const { ask } = props;
  const view = askView(ask, props.nowMs);
  const discussion = useCardDiscussion(
    ask.missionId,
    { kind: "ask", id: ask.id, label: ask.question },
    props.nowMs,
  );
  const [text, setText] = useState("");
  const [busy, run] = useBusy();
  const choice = { picked: props.picked, onPick: props.onPick, disabled: busy };
  const backed = useMemo(() => ({ kind: "ask" as const, record: ask }), [ask]);
  const templated = useTemplatedCard(ask.missionId, backed, {
    nowMs: props.nowMs,
    masterRoleId: props.masterRoleId,
    choice,
  });
  const actions: CardAction[] = [
    {
      key: "answer",
      primary: true,
      disabled: busy || (props.picked === null && text.trim() === ""),
      onRun: () =>
        void run(() => props.actions.answer(ask, props.picked, text, templated?.attach)).then(
          (sent) => {
            if (!sent) return;
            setText("");
            templated?.clear();
          },
        ),
    },
    ...withDiscuss(discussion, props),
  ];
  return (
    <CardFrame
      {...frame(props, `ask:${ask.id}`)}
      kicker={props.kicker ?? templated?.kicker ?? (view.urgent ? "Urgent decision" : "Decision")}
      discussion={discussion.symbol}
      subMission={cardSubMission(props.list, ask.missionId, ask.subMissionId)}
      since={ask.createdAt}
      title={ask.question}
      actions={actions}
      approver="owner"
    >
      {templated ? (
        templated.body
      ) : (
        <>
          <TextBlock text={ask.context} tone="meta" maxLines={4} />
          <ChoiceBlock
            options={view.options}
            picked={props.picked}
            onPick={props.onPick}
            advice={ask.recommendation?.reason.trim() || null}
            disabled={busy}
          />
          <FactsBlock
            rows={[
              { label: "If you wait", value: ask.costOfWaiting },
              {
                label: "Blocks",
                value: ask.blocks.length > 0 ? <RefsBlock refs={ask.blocks} /> : null,
              },
            ]}
          />
        </>
      )}
      <Textarea
        size="sm"
        aria-label="Your answer"
        placeholder="Or answer in your own words"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {discussion.panel}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------
// Approve

/** Move a draft or approval to the other approver, with a reason. */
function useMove(record: Draft | Approval, kind: "draft" | "approval") {
  const [moving, setMoving] = useState(false);
  const [reason, setReason] = useState("");
  const to: Approver = approverOf(record) === "owner" ? "master" : "owner";
  const submit = async () => {
    if (await rerouteRecord(kind, record, to, reason)) {
      setMoving(false);
      setReason("");
      return true;
    }
    return false;
  };
  return { moving, setMoving, reason, setReason, to, submit };
}

export function DraftCard(
  props: CardContext & {
    draft: Draft;
    editing: boolean;
    onEdit: (open: boolean) => void;
    notes: ReadonlyArray<DraftNote>;
    masterRoleId: string | null;
    actions: InboxActions;
  },
) {
  const { draft } = props;
  const [edited, setEdited] = useState(draft.text);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteNote, setRewriteNote] = useState("");
  const [busy, run] = useBusy();
  const move = useMove(draft, "draft");
  const discussion = useCardDiscussion(
    draft.missionId,
    { kind: "draft", id: draft.id, label: draftTitle(draft) },
    props.nowMs,
  );
  const notes = draftNotesFor(draft, props.notes);
  const edit = textEdit(draft.text, edited);
  const writerRole = draft.writtenBy?.roleId ?? draft.writerRoleId;
  const writer =
    writerRole === null
      ? draft.source.kind
      : actorLabel({ _tag: "role", roleId: writerRole }, props.masterRoleId);
  const people: DraftPerson[] = [
    { kind: "person", name: draft.audience, prefix: "To " },
    {
      kind: writer === "master" ? "master" : "person",
      name: writer === "master" ? "Master" : writer,
      prefix: "Written by ",
    },
  ];
  const decide = (decision: Parameters<InboxActions["decideDraft"]>[1]) =>
    void run(() => props.actions.decideDraft(draft, decision));
  const actions: CardAction[] = rewriting
    ? [
        {
          key: "rewrite",
          label: "Send back",
          primary: true,
          disabled: busy || rewriteNote.trim() === "",
          onRun: () => decide({ action: "rewrite", note: rewriteNote }),
        },
        { key: "cancel", onRun: () => setRewriting(false) },
      ]
    : move.moving
      ? [
          {
            key: "move",
            label: `Move to ${APPROVER_NAME[move.to]}`,
            primary: true,
            disabled: busy || move.reason.trim() === "",
            onRun: () => void run(move.submit),
          },
          { key: "cancel", onRun: () => move.setMoving(false) },
        ]
      : [
          edit.changed
            ? {
                key: "send",
                label: "Edit and approve",
                primary: true,
                disabled: busy,
                onRun: () => decide({ action: "edit-approve", editedText: edited }),
              }
            : {
                key: "send",
                primary: true,
                disabled: busy,
                onRun: () => decide({ action: "approve" }),
              },
          ...(props.editing
            ? [
                {
                  key: "cancel" as const,
                  onRun: () => {
                    setEdited(draft.text);
                    props.onEdit(false);
                  },
                },
              ]
            : [
                { key: "rewrite" as const, disabled: busy, onRun: () => setRewriting(true) },
                {
                  key: "drop" as const,
                  disabled: busy,
                  onRun: () => decide({ action: "drop" }),
                },
              ]),
          {
            key: "move",
            label: `Move to ${APPROVER_NAME[move.to]}`,
            disabled: busy,
            onRun: () => move.setMoving(true),
          },
          ...withDiscuss(discussion, props),
        ];
  return (
    <CardFrame
      {...frame(props, `draft:${draft.id}`)}
      kicker={draftKicker(draft)}
      discussion={discussion.symbol}
      since={draft.createdAt}
      title={draftTitle(draft)}
      actions={actions}
      approver={approverOf(draft)}
    >
      <LinksBlock links={[draft.target]}>
        {draft.head ? (
          <span className="text-xs text-(--m-muted) tabular-nums">
            <span className="sr-only">Head commit </span>
            {draft.head.slice(0, 7)}
          </span>
        ) : null}
      </LinksBlock>
      <FlagsBlock flags={draft.flags ?? []} />
      <TextBlock text={routeLine(draft) ?? ""} tone="meta" maxLines={2} />
      <DraftBlock
        channel={draft.channel}
        people={people}
        text={draft.text}
        edit={{
          editing: props.editing,
          value: edited,
          onChange: setEdited,
          onStart: () => props.onEdit(true),
          onUndo: () => {
            setEdited(draft.text);
            props.onEdit(false);
          },
          diff: edit.segments,
        }}
      />
      <FactsBlock
        rows={[
          {
            label: "Notes applied",
            value:
              notes.applied.length > 0
                ? notes.applied
                    .map((note) => `${draftNoteScopeLabel(note.scope)}: ${note.text}`)
                    .join("\n")
                : null,
          },
          { label: "Send failed", value: draft.sendError ?? null },
          {
            label: "Notes not listed",
            value:
              notes.skipped.length > 0 ? notes.skipped.map((note) => note.text).join("\n") : null,
          },
        ]}
      />
      <TextBlock text={draft.withdrawNote ?? ""} tone="meta" maxLines={2} />
      {rewriting ? (
        <ReasonField
          label="What should change"
          placeholder="What should the writer change?"
          value={rewriteNote}
          onChange={setRewriteNote}
        />
      ) : null}
      {move.moving ? (
        <ReasonField
          label="Why move it?"
          placeholder="Why move it?"
          value={move.reason}
          onChange={move.setReason}
        />
      ) : null}
      {discussion.panel}
    </CardFrame>
  );
}

export function ApprovalCard(
  props: CardContext & {
    approval: Approval;
    masterRoleId: string | null;
    actions: InboxActions;
  },
) {
  const { approval } = props;
  const [busy, run] = useBusy();
  const move = useMove(approval, "approval");
  const discussion = useCardDiscussion(
    approval.missionId,
    { kind: "approval", id: approval.id, label: approval.title },
    props.nowMs,
  );
  const backed = useMemo(() => ({ kind: "approval" as const, record: approval }), [approval]);
  const templated = useTemplatedCard(approval.missionId, backed, {
    nowMs: props.nowMs,
    masterRoleId: props.masterRoleId,
  });
  const decide = (action: "approve" | "reject") =>
    void run(() => props.actions.decideApproval(approval, action));
  const actions: CardAction[] = move.moving
    ? [
        {
          key: "move",
          label: `Move to ${APPROVER_NAME[move.to]}`,
          primary: true,
          disabled: busy || move.reason.trim() === "",
          onRun: () => void run(move.submit),
        },
        { key: "cancel", onRun: () => move.setMoving(false) },
      ]
    : [
        { key: "approve", primary: true, disabled: busy, onRun: () => decide("approve") },
        { key: "reject", disabled: busy, onRun: () => decide("reject") },
        {
          key: "move",
          label: `Move to ${APPROVER_NAME[move.to]}`,
          disabled: busy,
          onRun: () => move.setMoving(true),
        },
        ...withDiscuss(discussion, props),
      ];
  return (
    <CardFrame
      {...frame(props, `approval:${approval.id}`)}
      kicker={props.kicker ?? templated?.kicker ?? APPROVAL_KICKER[approval.kind]}
      discussion={discussion.symbol}
      since={approval.createdAt}
      title={approval.title}
      actions={actions}
      approver={approverOf(approval)}
    >
      {templated ? (
        templated.body
      ) : (
        <>
          <LinksBlock links={approval.links} />
          <FlagsBlock flags={approval.flags ?? []} />
          <TextBlock text={approval.summary ?? approval.detail} tone="meta" maxLines={4} />
        </>
      )}
      <FactsBlock
        rows={[
          { label: "Requested by", value: approval.requestedBy },
          { label: "Moved because", value: routeLine(approval) },
        ]}
      />
      {move.moving ? (
        <ReasonField
          label="Why move it?"
          placeholder="Why move it?"
          value={move.reason}
          onChange={move.setReason}
        />
      ) : null}
      {discussion.panel}
    </CardFrame>
  );
}

/**
 * A decided approval in the history list (stale ones show why they closed;
 * ones the master decided on the owner's condition quote it).
 */
export function ClosedApprovalRow(props: { approval: Approval; nowMs: number }) {
  const { approval } = props;
  const condition = ownerConditionOf(approval);
  return (
    <li className="flex min-w-0 flex-col gap-2">
      <CardFrame
        kicker={APPROVAL_KICKER[approval.kind]}
        since={approval.decidedAt ?? approval.createdAt}
        nowMs={props.nowMs}
        title={approval.title}
        done={{
          verb: APPROVAL_STATUS_LABEL[approval.status],
          ...(approval.staleReason ? { detail: approval.staleReason } : {}),
        }}
      />
      {condition ? <ConditionNote condition={condition} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Knocks

export function KnockCard(
  props: CardContext & {
    knock: Knock;
    editing: boolean;
    onEdit: (open: boolean) => void;
    actions: InboxActions;
  },
) {
  const { knock } = props;
  const [edited, setEdited] = useState(knock.summary);
  const [busy, run] = useBusy();
  const discussion = useCardDiscussion(
    knock.missionId,
    { kind: "knock", id: knock.id, label: knock.summary },
    props.nowMs,
  );
  const edit = textEdit(knock.summary, edited);
  const decide = (decision: Parameters<InboxActions["decideKnock"]>[1]) =>
    void run(() => props.actions.decideKnock(knock, decision));
  const actions: CardAction[] = [
    {
      key: "forward",
      label: edit.changed ? "Forward edited" : "Forward",
      primary: true,
      disabled: busy,
      onRun: () =>
        decide(edit.changed ? { action: "forward", editedText: edited } : { action: "forward" }),
    },
    ...(props.editing ? [] : [{ key: "edit" as const, onRun: () => props.onEdit(true) }]),
    { key: "dismiss", disabled: busy, onRun: () => decide({ action: "drop" }) },
    ...withDiscuss(discussion, props),
  ];
  return (
    <CardFrame
      {...frame(props, `knock:${knock.id}`)}
      kicker="Knock"
      discussion={discussion.symbol}
      since={knock.createdAt}
      title={knock.summary}
      actions={actions}
      approver="owner"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <PersonChip kind="person" name={knock.fromTitle} prefix="From " />
      </div>
      <TextBlock text={knock.body ?? ""} tone="meta" maxLines={6} />
      <FactsBlock rows={[{ label: "Via", value: knock.path }]} />
      {props.editing ? (
        <DraftBlock
          channel={null}
          people={[{ kind: "master", name: "Master", prefix: "To " }]}
          text={knock.summary}
          edit={{
            editing: true,
            value: edited,
            onChange: setEdited,
            onStart: () => props.onEdit(true),
            onUndo: () => {
              setEdited(knock.summary);
              props.onEdit(false);
            },
            diff: edit.segments,
          }}
        />
      ) : null}
      {discussion.panel}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------
// Suggestions

export function SuggestionCard(
  props: CardContext & {
    suggestion: Suggestion;
    /** `null` when the server has no track record to show. */
    stats: ReadonlyArray<SuggestionStats> | null;
    actions: InboxActions;
  },
) {
  const { suggestion } = props;
  const [mode, setMode] = useState<"idle" | "edit" | "dismiss">("idle");
  const [edited, setEdited] = useState(() => suggestionAfterText(suggestion));
  const [reason, setReason] = useState("");
  const [busy, run] = useBusy();
  const discussion = useCardDiscussion(
    suggestion.missionId,
    { kind: "suggestion", id: suggestion.id, label: suggestion.title },
    props.nowMs,
  );
  const record = props.stats === null ? null : suggestionTrackRecord(props.stats, suggestion);
  const decide = (decision: Parameters<InboxActions["decideSuggestion"]>[1]) =>
    void run(() => props.actions.decideSuggestion(suggestion, decision));
  const actions: CardAction[] =
    mode === "edit"
      ? [
          {
            key: "accept",
            label: "Accept edited",
            primary: true,
            disabled: busy,
            onRun: () => decide({ action: "accept-edited", editedText: edited }),
          },
          { key: "cancel", onRun: () => setMode("idle") },
        ]
      : mode === "dismiss"
        ? [
            {
              key: "dismiss-suggestion",
              primary: true,
              disabled: busy,
              onRun: () => decide({ action: "dismiss", reason }),
            },
            { key: "cancel", onRun: () => setMode("idle") },
          ]
        : [
            {
              key: "accept",
              primary: true,
              disabled: busy,
              onRun: () => decide({ action: "accept" }),
            },
            { key: "edit", disabled: busy, onRun: () => setMode("edit") },
            { key: "dismiss-suggestion", disabled: busy, onRun: () => setMode("dismiss") },
            ...withDiscuss(discussion, props),
          ];
  return (
    <CardFrame
      {...frame(props, `suggestion:${suggestion.id}`)}
      kicker={SUGGESTION_TARGET_LABEL[suggestion.targetKind]}
      discussion={discussion.symbol}
      since={suggestion.createdAt}
      title={suggestion.title}
      actions={actions}
      approver={suggestion.acceptor}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <PersonChip
          kind={suggestion.author === "master" ? "master" : "person"}
          name={SUGGESTION_AUTHOR_LABEL[suggestion.author]}
          prefix="From "
        />
        {suggestion.target ? <RefsBlock refs={[suggestion.target]} /> : null}
      </div>
      {mode === "edit" ? (
        <Textarea
          aria-label="Edited change"
          autoFocus
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
        />
      ) : (
        <LineDiffBlock lines={parseDiffLines(suggestion.diffText)} />
      )}
      <TextBlock text={suggestion.why} tone="meta" maxLines={3} />
      <RefsBlock refs={suggestion.evidence} />
      <FactsBlock
        rows={[
          { label: "Track record", value: record?.author.label ?? null },
          {
            label: `On ${SUGGESTION_TARGET_LABEL[suggestion.targetKind].toLowerCase()}`,
            value: record?.kind
              ? `${record.kind.label}${record.kind.bar !== "normal" ? `, bar ${record.kind.bar}` : ""}`
              : null,
          },
        ]}
      />
      {mode === "dismiss" ? (
        <ReasonField label="Why dismiss" placeholder="Reason" value={reason} onChange={setReason} />
      ) : null}
      {discussion.panel}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------
// FYI

export function NoteCard(props: CardContext & { note: Note; actions: InboxActions }) {
  const { note } = props;
  const view = fyiView(note);
  const [busy, run] = useBusy();
  const discussion = useCardDiscussion(
    note.missionId,
    { kind: "note", id: note.id, label: note.summary },
    props.nowMs,
  );
  return (
    <CardFrame
      {...frame(props, `note:${note.id}`)}
      kicker={noteKicker(note)}
      discussion={discussion.symbol}
      subMission={cardSubMission(props.list, note.missionId, note.subMissionId)}
      since={note.createdAt}
      title={note.summary}
      actions={[
        {
          key: "ack",
          primary: true,
          disabled: busy,
          onRun: () => void run(() => props.actions.ack(note)),
        },
        ...withDiscuss(discussion, props),
      ]}
      approver={null}
    >
      <FlagsBlock flags={noteFlags(note)} />
      {view.quote ? (
        <TextBlock
          text={`“${view.quote}”${view.sourceEvent !== null ? ` coord #${view.sourceEvent}` : ""}`}
          tone="meta"
          maxLines={4}
        />
      ) : null}
      <RefsBlock refs={note.evidenceLinks} />
      {discussion.panel}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------
// One inbox entry, whichever kind it is

/** What every entry card reads besides its record. */
export interface EntryCardDeps {
  readonly draftNotes: ReadonlyArray<DraftNote>;
  /** `null` while suggestion track records are sample data. */
  readonly stats: ReadonlyArray<SuggestionStats> | null;
  readonly list: MissionListSnapshot | undefined;
  readonly masterRoleId: string | null;
  readonly nowMs: number;
  readonly actions: InboxActions;
  readonly size?: CardFrameProps["size"];
  /** The owner's comments and snoozes, by item key. */
  readonly marks?: ReadonlyArray<InboxMark> | undefined;
  /** The day-one plan's item key; its card reads "Approve the plan". */
  readonly planKey?: string | null;
}

/** One entry's slice of the inbox UI state, so a card only re-renders when its own state changes. */
export function entryCardState(ui: InboxUiState, key: string) {
  return {
    selected: ui.selectedKey === key,
    editing: ui.editingKey === key,
    picked: ui.picked[key] ?? null,
  };
}

/** Renders an inbox entry with its card, wired to a selection/edit/pick reducer. */
export const InboxEntryCard = memo(function InboxEntryCard(props: {
  entry: InboxEntry;
  selected: boolean;
  editing: boolean;
  picked: string | null;
  dispatch: (event: InboxUiEvent) => void;
  deps: EntryCardDeps;
}) {
  const { entry, editing, dispatch, deps } = props;
  const marks = useItemMarks(
    entry,
    deps.marks?.find((mark) => mark.id === entry.key),
    deps.nowMs,
    deps.actions,
  );
  const context: CardContext = {
    selected: props.selected,
    onSelect: () => dispatch({ type: "select", key: entry.key }),
    nowMs: deps.nowMs,
    list: deps.list,
    ...(deps.size ? { size: deps.size } : {}),
    marks,
    ...(deps.planKey === entry.key ? { kicker: PLAN_KICKER } : {}),
  };
  const onEdit = (open: boolean) => dispatch({ type: "edit", key: open ? entry.key : null });
  switch (entry.kind) {
    case "ask":
      return (
        <AskCard
          {...context}
          ask={entry.record}
          picked={props.picked}
          onPick={(optionId) => dispatch({ type: "pick", key: entry.key, optionId })}
          masterRoleId={deps.masterRoleId}
          actions={deps.actions}
        />
      );
    case "draft":
      return (
        <DraftCard
          {...context}
          draft={entry.record}
          editing={editing}
          onEdit={onEdit}
          notes={deps.draftNotes}
          masterRoleId={deps.masterRoleId}
          actions={deps.actions}
        />
      );
    case "approval":
      return (
        <ApprovalCard
          {...context}
          approval={entry.record}
          masterRoleId={deps.masterRoleId}
          actions={deps.actions}
        />
      );
    case "knock":
      return (
        <KnockCard
          {...context}
          knock={entry.record}
          editing={editing}
          onEdit={onEdit}
          actions={deps.actions}
        />
      );
    case "suggestion":
      return (
        <SuggestionCard
          {...context}
          suggestion={entry.record}
          stats={deps.stats}
          actions={deps.actions}
        />
      );
    case "note":
      return <NoteCard {...context} note={entry.record} actions={deps.actions} />;
  }
});
