import type { Approval, Ask, Draft, Knock, Suggestion } from "@t3tools/contracts";
import {
  type AskAnswerForm,
  type AskView,
  approvalDecisionInput,
  askAnswerInput,
  askView,
  draftDecisionInput,
  type DraftForm,
  EMPTY_ASK_ANSWER,
  type FormResult,
  knockDecisionInput,
  type KnockForm,
  suggestionAfterText,
  suggestionDecisionInput,
  type SuggestionForm,
  toggleAskOption,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { useState } from "react";
import { Alert } from "react-native";

import { missionsSource } from "./missionsStore";
import { confirmAction, useMissionAction } from "./useMissionsLogic";

// State and actions for each inbox card. The card components only render
// what these hooks return, so the look can change without touching this file.

/** Validates a form, then runs the mutation. Invalid input is shown, not sent. */
function submitForm<T>(
  run: ReturnType<typeof useMissionAction>["run"],
  failureTitle: string,
  result: FormResult<T>,
  send: (input: T) => Promise<void>,
): Promise<boolean> {
  if (!result.ok) {
    Alert.alert(failureTitle, result.error);
    return Promise.resolve(false);
  }
  return run(failureTitle, () => send(result.input));
}

export interface AskCardState {
  readonly view: AskView;
  readonly pickedOptionId: string | null;
  readonly text: string;
  readonly canSubmit: boolean;
  readonly pending: boolean;
  readonly pickOption: (optionId: string) => void;
  readonly setText: (text: string) => void;
  readonly submit: () => void;
}

/** An ask starts with nothing picked. The recommendation is advice only. */
export function useAskCard(ask: Ask, nowMs: number): AskCardState {
  const [form, setForm] = useState<AskAnswerForm>(EMPTY_ASK_ANSWER);
  const action = useMissionAction();
  return {
    view: askView(ask, nowMs),
    pickedOptionId: form.optionId,
    text: form.text,
    canSubmit: askAnswerInput(ask, form).ok && !action.pending,
    pending: action.pending,
    pickOption: (optionId) => setForm((current) => toggleAskOption(current, optionId)),
    setText: (text) => setForm((current) => ({ ...current, text })),
    submit: () => {
      void submitForm(
        action.run,
        "Could not send your answer",
        askAnswerInput(ask, form),
        (input) => missionsSource().answerAsk(input),
      );
    },
  };
}

export type DraftCardMode = "idle" | "editing" | "rewriting";

export interface DraftCardState {
  readonly mode: DraftCardMode;
  readonly editedText: string;
  readonly rewriteNote: string;
  readonly pending: boolean;
  readonly setEditedText: (text: string) => void;
  readonly setRewriteNote: (text: string) => void;
  readonly approve: () => void;
  readonly startEditing: () => void;
  readonly approveEdited: () => void;
  readonly startRewrite: () => void;
  readonly sendRewrite: () => void;
  readonly drop: () => void;
  readonly cancel: () => void;
}

export function useDraftCard(draft: Draft): DraftCardState {
  const [mode, setMode] = useState<DraftCardMode>("idle");
  const [editedText, setEditedText] = useState(draft.text);
  const [rewriteNote, setRewriteNote] = useState("");
  const action = useMissionAction();
  const decide = (failureTitle: string, form: DraftForm) => {
    void submitForm(action.run, failureTitle, draftDecisionInput(draft, form), (input) =>
      missionsSource().decideDraft(input),
    );
  };
  return {
    mode,
    editedText,
    rewriteNote,
    pending: action.pending,
    setEditedText,
    setRewriteNote,
    approve: () => decide("Could not approve the draft", { action: "approve" }),
    startEditing: () => {
      setEditedText(draft.text);
      setMode("editing");
    },
    approveEdited: () => decide("Could not approve the draft", { action: "approve", editedText }),
    startRewrite: () => setMode("rewriting"),
    sendRewrite: () =>
      decide("Could not ask for a rewrite", { action: "rewrite", note: rewriteNote }),
    drop: () =>
      confirmAction({
        title: "Drop this draft?",
        message: "The draft is not sent.",
        confirmLabel: "Drop",
        destructive: true,
        onConfirm: () => decide("Could not drop the draft", { action: "drop" }),
      }),
    cancel: () => setMode("idle"),
  };
}

export interface ApprovalCardState {
  readonly note: string;
  readonly pending: boolean;
  readonly setNote: (note: string) => void;
  readonly approve: () => void;
  readonly reject: () => void;
}

export function useApprovalCard(approval: Approval): ApprovalCardState {
  const [note, setNote] = useState("");
  const action = useMissionAction();
  const decide = (failureTitle: string, choice: "approve" | "reject") => {
    void submitForm(
      action.run,
      failureTitle,
      approvalDecisionInput(approval, choice, note),
      (input) => missionsSource().decideApproval(input),
    );
  };
  return {
    note,
    pending: action.pending,
    setNote,
    approve: () => decide("Could not approve", "approve"),
    reject: () =>
      confirmAction({
        title: `Reject "${approval.title}"?`,
        message: "Your note goes with the rejection if you wrote one.",
        confirmLabel: "Reject",
        destructive: true,
        onConfirm: () => decide("Could not reject", "reject"),
      }),
  };
}

export type KnockCardMode = "idle" | "editing";

export interface KnockCardState {
  readonly mode: KnockCardMode;
  readonly editedText: string;
  readonly pending: boolean;
  readonly setEditedText: (text: string) => void;
  readonly forward: () => void;
  readonly startEditing: () => void;
  readonly forwardEdited: () => void;
  readonly drop: () => void;
  readonly cancel: () => void;
}

/** Forwarding goes to the mission's master; the source chooses the master role. */
export function useKnockCard(knock: Knock): KnockCardState {
  const [mode, setMode] = useState<KnockCardMode>("idle");
  const [editedText, setEditedText] = useState(knock.summary);
  const action = useMissionAction();
  const decide = (failureTitle: string, form: KnockForm) => {
    void submitForm(action.run, failureTitle, knockDecisionInput(knock, form), (input) =>
      missionsSource().decideKnock(input),
    );
  };
  return {
    mode,
    editedText,
    pending: action.pending,
    setEditedText,
    forward: () => decide("Could not forward the knock", { action: "forward" }),
    startEditing: () => {
      setEditedText(knock.summary);
      setMode("editing");
    },
    forwardEdited: () => decide("Could not forward the knock", { action: "forward", editedText }),
    drop: () =>
      confirmAction({
        title: "Drop this knock?",
        message: "The master never sees it.",
        confirmLabel: "Drop",
        destructive: true,
        onConfirm: () => decide("Could not drop the knock", { action: "drop" }),
      }),
    cancel: () => setMode("idle"),
  };
}

export type SuggestionCardMode = "idle" | "editing" | "dismissing";

export interface SuggestionCardState {
  readonly mode: SuggestionCardMode;
  readonly afterText: string;
  readonly dismissReason: string;
  readonly pending: boolean;
  readonly setAfterText: (text: string) => void;
  readonly setDismissReason: (text: string) => void;
  readonly accept: () => void;
  readonly startEditing: () => void;
  readonly acceptEdited: () => void;
  readonly startDismiss: () => void;
  readonly dismiss: () => void;
  readonly cancel: () => void;
}

export function useSuggestionCard(suggestion: Suggestion): SuggestionCardState {
  const [mode, setMode] = useState<SuggestionCardMode>("idle");
  const [afterText, setAfterText] = useState(() => suggestionAfterText(suggestion));
  const [dismissReason, setDismissReason] = useState("");
  const action = useMissionAction();
  const decide = (failureTitle: string, form: SuggestionForm) => {
    void submitForm(action.run, failureTitle, suggestionDecisionInput(suggestion, form), (input) =>
      missionsSource().decideSuggestion(input),
    );
  };
  return {
    mode,
    afterText,
    dismissReason,
    pending: action.pending,
    setAfterText,
    setDismissReason,
    accept: () => decide("Could not accept the suggestion", { action: "accept" }),
    startEditing: () => {
      setAfterText(suggestionAfterText(suggestion));
      setMode("editing");
    },
    acceptEdited: () =>
      decide("Could not accept the suggestion", { action: "accept-edited", afterText }),
    startDismiss: () => setMode("dismissing"),
    dismiss: () =>
      decide("Could not dismiss the suggestion", { action: "dismiss", reason: dismissReason }),
    cancel: () => setMode("idle"),
  };
}
