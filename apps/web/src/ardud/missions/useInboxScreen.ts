import { useEffect, useMemo, useReducer, useRef } from "react";

import type {
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
  decideDraftInput,
  decideKnockInput,
  decideSuggestionInput,
  discussAskInput,
  inboxEntries,
  inboxKeyAction,
  inboxUiReducer,
  INITIAL_INBOX_UI,
  type DraftDecision,
  type InboxEntry,
  type InboxUiEvent,
  type SuggestionDecision,
} from "@t3tools/client-runtime/ardud/missions";

import { runMissionAction, submitMissionInput } from "./missionActions";
import { missionsSource, useMissionInbox } from "./missionsStore";

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
 * Inbox screen state for one tab: the visible entries, selection, picks and
 * the open editor, plus j/k / 1-9 / e on the window. The logic lives in the
 * client-runtime reducer; this hook only wires it to React and the DOM.
 */
export function useInboxScreen(missionId: MissionId | null, tab: InboxTab) {
  const inbox = useMissionInbox(missionId);
  const entries = useMemo(() => (inbox ? inboxEntries(inbox, tab) : []), [inbox, tab]);
  const [ui, dispatch] = useReducer(inboxUiReducer, INITIAL_INBOX_UI);
  const selected = entries.find((entry) => entry.key === ui.selectedKey) ?? null;

  // Another mission filter or tab starts fresh; a decision in the same list
  // keeps the selection on the next item.
  const scope = `${missionId ?? "*"}|${tab}`;
  const previous = useRef<{ scope: string; keys: ReadonlyArray<string> }>({ scope, keys: [] });
  useEffect(() => {
    const nextKeys = entries.map((entry) => entry.key);
    if (previous.current.scope !== scope) {
      dispatch({ type: "scope-changed" });
    } else {
      dispatch({ type: "entries-changed", previousKeys: previous.current.keys, nextKeys });
    }
    previous.current = { scope, keys: nextKeys };
  }, [entries, scope]);

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
      dispatch({ type: "key", action, keys: entries.map((entry) => entry.key) });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entries, selected]);

  useEffect(() => {
    if (ui.selectedKey === null) return;
    document.getElementById(inboxItemDomId(ui.selectedKey))?.scrollIntoView({ block: "nearest" });
  }, [ui.selectedKey]);

  return { inbox, entries, ui, selected, dispatch };
}

/**
 * Owner decisions from the inbox. Each resolves `true` when the source took
 * it, and marks the item done so its pick and editor are forgotten.
 */
export function inboxActions(dispatch: (event: InboxUiEvent) => void) {
  const done = (key: string) => (sent: boolean) => {
    if (sent) dispatch({ type: "done", key });
    return sent;
  };
  return {
    answer: (ask: Ask, optionId: string | null, text: string) =>
      submitMissionInput(
        answerAskInput(ask, { optionId, text }),
        (input) => missionsSource.answerAsk(input),
        "Couldn't send the answer",
      ).then(done(`ask:${ask.id}`)),
    discuss: (ask: Ask, text: string) =>
      runMissionAction(
        missionsSource.openFork(discussAskInput(ask, text)),
        "Couldn't open the discussion",
      ),
    decideDraft: (draft: Draft, decision: DraftDecision) =>
      submitMissionInput(
        decideDraftInput(draft, decision),
        (input) => missionsSource.decideDraft(input),
        "Couldn't decide the draft",
      ).then(done(`draft:${draft.id}`)),
    decideApproval: (approval: Approval, action: "approve" | "reject") =>
      runMissionAction(
        missionsSource.decideApproval({ approvalId: approval.id, action }),
        "Couldn't decide the approval",
      ).then(done(`approval:${approval.id}`)),
    decideKnock: (
      knock: Knock,
      decision:
        | { readonly action: "forward"; readonly editedText?: string }
        | { readonly action: "drop" },
    ) =>
      submitMissionInput(
        decideKnockInput(knock, decision),
        (input) => missionsSource.decideKnock(input),
        "Couldn't decide the knock",
      ).then(done(`knock:${knock.id}`)),
    decideSuggestion: (suggestion: Suggestion, decision: SuggestionDecision) =>
      submitMissionInput(
        decideSuggestionInput(suggestion, decision),
        (input) => missionsSource.decideSuggestion(input),
        "Couldn't decide the suggestion",
      ).then(done(`suggestion:${suggestion.id}`)),
    ack: (note: Note) =>
      runMissionAction(missionsSource.ackNote({ noteId: note.id }), "Couldn't mark it seen").then(
        done(`note:${note.id}`),
      ),
  };
}

export type InboxActions = ReturnType<typeof inboxActions>;
export type { InboxEntry };
