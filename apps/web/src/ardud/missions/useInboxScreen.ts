import { useEffect, useMemo, useReducer, useRef } from "react";

import type {
  AnswerAskInput,
  Approval,
  Ask,
  Draft,
  InboxTab,
  Knock,
  MissionId,
  Note,
  Suggestion,
} from "@t3tools/contracts";
import {
  answerAskInput,
  commentInput,
  decideApprovalInput,
  decideDraftInput,
  decideKnockInput,
  decideSuggestionInput,
  groupEntriesByMission,
  inboxEntries,
  inboxItemRef,
  inboxKeyAction,
  inboxUiReducer,
  INITIAL_INBOX_UI,
  snoozedEntries,
  type DraftDecision,
  type InboxRouteFilter,
  type InboxEntry,
  type InboxUiEvent,
  type SuggestionDecision,
} from "@t3tools/client-runtime/ardud/missions";

import { runMissionAction, submitMissionInput, type BuiltInput } from "./missionActions";
import { missionsSource, useMissionInbox, useMissionList } from "./missionsStore";
import { useNowMs } from "./useNowMs";

/** DOM id of an inbox item, so keyboard moves can scroll it into view. */
export function inboxItemDomId(key: string): string {
  return `inbox-item-${key}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select, [role='textbox'], [role='combobox']") !== null;
}

/**
 * Inbox screen state for one tab: the visible entries grouped by mission,
 * selection, picks and the open editor, plus j/k / 1-9 / e on the window.
 * With `autoSelectFirst` (the wide reading-pane layout) the first item counts
 * as selected until the owner picks another. Items the owner snoozed out of
 * this tab come back as `snoozed`, still openable. The logic lives in the
 * client-runtime reducer; this hook only wires it to React and the DOM.
 */
export function useInboxScreen(
  missionId: MissionId | null,
  tab: InboxTab,
  route: InboxRouteFilter = "owner",
  options: { autoSelectFirst?: boolean } = {},
) {
  const inbox = useMissionInbox(missionId);
  const list = useMissionList();
  // Snoozes end on the minute clock, so the lists follow it.
  const nowMs = useNowMs();
  // Entries keep their identity across mission-list updates, so memoized cards hold.
  const listed = useMemo(
    () => (inbox ? inboxEntries(inbox, tab, route, nowMs) : []),
    [inbox, tab, route, nowMs],
  );
  // The master's view never hides a snoozed item, so it has no Snoozed group.
  const snoozed = useMemo(
    () => (inbox && route === "owner" ? snoozedEntries(inbox, nowMs, [tab]) : []),
    [inbox, tab, route, nowMs],
  );
  const groups = useMemo(() => groupEntriesByMission(listed, list), [listed, list]);
  // Visual order, so j/k walks the list the way it reads.
  const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const [ui, dispatch] = useReducer(inboxUiReducer, INITIAL_INBOX_UI);
  const selected =
    entries.find((entry) => entry.key === ui.selectedKey) ??
    snoozed.find((entry) => entry.key === ui.selectedKey) ??
    (options.autoSelectFirst ? (entries[0] ?? null) : null);

  // Another mission filter or tab starts fresh; a decision in the same list
  // keeps the selection on the next item.
  const scope = `${missionId ?? "*"}|${tab}|${route}`;
  const previous = useRef<{ scope: string; keys: ReadonlyArray<string> }>({ scope, keys: [] });
  // A snoozed item stays open where it was, now with Unsnooze.
  useEffect(() => {
    const nextKeys = [...entries, ...snoozed].map((entry) => entry.key);
    if (previous.current.scope !== scope) {
      dispatch({ type: "scope-changed" });
    } else {
      dispatch({ type: "entries-changed", previousKeys: previous.current.keys, nextKeys });
    }
    previous.current = { scope, keys: nextKeys };
  }, [entries, snoozed, scope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = inboxKeyAction({
        key: event.key,
        modified: event.metaKey || event.ctrlKey || event.altKey,
        typing: isTypingTarget(event.target),
        selected,
      });
      if (action === null) return;
      event.preventDefault();
      // An implicit first-item selection becomes explicit before the key acts on it.
      if (selected && selected.key !== ui.selectedKey) {
        dispatch({ type: "select", key: selected.key });
      }
      dispatch({ type: "key", action, keys: entries.map((entry) => entry.key) });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entries, selected, ui.selectedKey]);

  useEffect(() => {
    if (ui.selectedKey === null) return;
    document.getElementById(inboxItemDomId(ui.selectedKey))?.scrollIntoView({ block: "nearest" });
  }, [ui.selectedKey]);

  return { inbox, groups, entries, snoozed, ui, selected, dispatch };
}

/** An answer with what the card adds to it (per-image review marks). */
const withAttached = (
  built: BuiltInput<AnswerAskInput>,
  attach: (input: AnswerAskInput) => AnswerAskInput,
): BuiltInput<AnswerAskInput> => (built.ok ? { ok: true, value: attach(built.value) } : built);

/**
 * Owner decisions from the inbox. Each resolves `true` when the source took
 * it, and marks the item done so its pick and editor are forgotten. `note`
 * goes with the decision to whoever acts on it and stays on the item as a
 * comment; it opens no discussion.
 */
export function inboxActions(dispatch: (event: InboxUiEvent) => void) {
  const done = (key: string) => (sent: boolean) => {
    if (sent) dispatch({ type: "done", key });
    return sent;
  };
  return {
    answer: (
      ask: Ask,
      optionId: string | null,
      text: string,
      attach: (input: AnswerAskInput) => AnswerAskInput = (input) => input,
      note = "",
    ) =>
      submitMissionInput(
        withAttached(answerAskInput(ask, { optionId, text }, note), attach),
        (input) => missionsSource.answerAsk(input),
        "Couldn't send the answer",
      ).then(done(`ask:${ask.id}`)),
    decideDraft: (draft: Draft, decision: DraftDecision, note = "") =>
      submitMissionInput(
        decideDraftInput(draft, decision, note),
        (input) => missionsSource.decideDraft(input),
        "Couldn't decide the draft",
      ).then(done(`draft:${draft.id}`)),
    decideApproval: (approval: Approval, action: "approve" | "reject", note = "") =>
      submitMissionInput(
        decideApprovalInput(approval, action, note),
        (input) => missionsSource.decideApproval(input),
        "Couldn't decide the approval",
      ).then(done(`approval:${approval.id}`)),
    decideKnock: (
      knock: Knock,
      decision:
        | { readonly action: "forward"; readonly editedText?: string }
        | { readonly action: "drop" },
      note = "",
    ) =>
      submitMissionInput(
        decideKnockInput(knock, decision, note),
        (input) => missionsSource.decideKnock(input),
        "Couldn't decide the knock",
      ).then(done(`knock:${knock.id}`)),
    decideSuggestion: (suggestion: Suggestion, decision: SuggestionDecision, note = "") =>
      submitMissionInput(
        decideSuggestionInput(suggestion, decision, note),
        (input) => missionsSource.decideSuggestion(input),
        "Couldn't decide the suggestion",
      ).then(done(`suggestion:${suggestion.id}`)),
    ack: (note: Note) =>
      runMissionAction(missionsSource.ackNote({ noteId: note.id }), "Couldn't mark it seen").then(
        done(`note:${note.id}`),
      ),
    // Comment and snooze decide nothing, so the item stays as it was.
    comment: (entry: InboxEntry, text: string) =>
      submitMissionInput(
        commentInput(entry, text),
        (input) => missionsSource.commentInboxItem(input),
        "Couldn't add the comment",
      ),
    snooze: (entry: InboxEntry, until: string | null) =>
      runMissionAction(
        missionsSource.snoozeInboxItem({ subject: inboxItemRef(entry), until }),
        "Couldn't snooze it",
      ),
    unsnooze: (entry: InboxEntry) =>
      runMissionAction(
        missionsSource.unsnoozeInboxItem({ subject: inboxItemRef(entry) }),
        "Couldn't unsnooze it",
      ),
  };
}

export type InboxActions = ReturnType<typeof inboxActions>;
export type { InboxEntry };
