import type { Approval, Ask, Draft, Knock, Note, Suggestion } from "@t3tools/contracts";
import {
  approvalMeta,
  draftHeadline,
  draftMeta,
  knockHeadline,
  knockMeta,
  noteMeta,
  suggestionAcceptorLine,
  suggestionMeta,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import {
  useApprovalCard,
  useAskCard,
  useDraftCard,
  useKnockCard,
  useSuggestionCard,
} from "./inboxLogic";
import { ActionButton, Actions, Body, Card, Meta, Mono, TextField, Title } from "./parts";

// One card per inbox record. Each card renders its hook's state; all decisions
// and validation live in inboxLogic.ts and the shared client-runtime helpers.

export function AskCard(props: { readonly ask: Ask; readonly nowMs: number }) {
  const card = useAskCard(props.ask, props.nowMs);
  const { view } = card;
  return (
    <Card>
      {view.urgent ? <Meta warning>P0</Meta> : null}
      <Title>{view.question}</Title>
      <Meta>
        Asked by {view.askedBy} · {view.askedAt}
      </Meta>
      <Body selectable>{view.context}</Body>
      {view.blocksLine ? <Meta>{view.blocksLine}</Meta> : null}
      <Meta>Cost of waiting: {view.costOfWaiting}</Meta>
      <View className="gap-2">
        {view.options.map((option) => {
          const picked = card.pickedOptionId === option.id;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: picked }}
              onPress={() => card.pickOption(option.id)}
              className={cn(
                "gap-1 rounded-2xl border p-3",
                picked ? "border-primary bg-subtle" : "border-border",
              )}
            >
              <Text className="text-sm font-t3-bold text-foreground">
                {picked ? "● " : "○ "}
                {option.label}
                {option.recommended ? "  · master recommends" : ""}
              </Text>
              <Text className="text-xs text-foreground-muted">{option.detail}</Text>
            </Pressable>
          );
        })}
      </View>
      {view.recommendation ? (
        <Meta>
          {view.recommendation.label
            ? `Why the master leans "${view.recommendation.label}": `
            : "Master's note: "}
          {view.recommendation.reason}
        </Meta>
      ) : null}
      <TextField
        value={card.text}
        onChangeText={card.setText}
        placeholder={
          view.options.length > 0 ? "Add a note, or answer in your own words" : "Your answer"
        }
        accessibilityLabel="Your answer"
      />
      <Actions>
        <ActionButton
          primary
          label={card.pending ? "Sending…" : "Send answer"}
          disabled={!card.canSubmit}
          onPress={card.submit}
        />
      </Actions>
      <Meta>The master waits for your answer. Nothing is decided for you.</Meta>
    </Card>
  );
}

export function DraftCard(props: { readonly draft: Draft; readonly nowMs: number }) {
  const card = useDraftCard(props.draft);
  return (
    <Card>
      <Title>{draftHeadline(props.draft)}</Title>
      <Meta>{draftMeta(props.draft, props.nowMs)}</Meta>
      {card.mode === "editing" ? (
        <TextField
          autoFocus
          value={card.editedText}
          onChangeText={card.setEditedText}
          placeholder="Draft text"
          accessibilityLabel="Edit draft"
        />
      ) : (
        <Body selectable>{props.draft.text}</Body>
      )}
      {card.mode === "rewriting" ? (
        <TextField
          autoFocus
          value={card.rewriteNote}
          onChangeText={card.setRewriteNote}
          placeholder="What should the rewrite change?"
          accessibilityLabel="Rewrite note"
        />
      ) : null}
      <Actions>
        {card.mode === "idle" ? (
          <>
            <ActionButton primary label="Approve" disabled={card.pending} onPress={card.approve} />
            <ActionButton label="Edit" disabled={card.pending} onPress={card.startEditing} />
            <ActionButton label="Rewrite" disabled={card.pending} onPress={card.startRewrite} />
            <ActionButton label="Drop" disabled={card.pending} onPress={card.drop} />
          </>
        ) : (
          <>
            <ActionButton
              primary
              label={card.mode === "editing" ? "Approve edited" : "Ask for rewrite"}
              disabled={card.pending}
              onPress={card.mode === "editing" ? card.approveEdited : card.sendRewrite}
            />
            <ActionButton label="Cancel" disabled={card.pending} onPress={card.cancel} />
          </>
        )}
      </Actions>
    </Card>
  );
}

export function ApprovalCard(props: { readonly approval: Approval; readonly nowMs: number }) {
  const card = useApprovalCard(props.approval);
  return (
    <Card>
      <Title>{props.approval.title}</Title>
      <Meta>{approvalMeta(props.approval, props.nowMs)}</Meta>
      <Body selectable>{props.approval.detail}</Body>
      {props.approval.links.length > 0 ? (
        <Meta>{props.approval.links.map((link) => link.label).join(" · ")}</Meta>
      ) : null}
      <TextField
        value={card.note}
        onChangeText={card.setNote}
        placeholder="Note (optional)"
        accessibilityLabel="Approval note"
      />
      <Actions>
        <ActionButton primary label="Approve" disabled={card.pending} onPress={card.approve} />
        <ActionButton label="Reject" disabled={card.pending} onPress={card.reject} />
      </Actions>
    </Card>
  );
}

export function KnockCard(props: {
  readonly knock: Knock;
  readonly missionTitle: string | null;
  readonly nowMs: number;
}) {
  const card = useKnockCard(props.knock);
  return (
    <Card>
      <Title>{knockHeadline(props.knock, props.missionTitle)}</Title>
      <Meta>{knockMeta(props.knock, props.nowMs)}</Meta>
      {card.mode === "editing" ? (
        <TextField
          autoFocus
          value={card.editedText}
          onChangeText={card.setEditedText}
          placeholder="What the master should read"
          accessibilityLabel="Edit the forwarded message"
        />
      ) : (
        <>
          <Body selectable>{props.knock.summary}</Body>
          {props.knock.body && props.knock.body !== props.knock.summary ? (
            <Meta>{props.knock.body}</Meta>
          ) : null}
        </>
      )}
      <Actions>
        {card.mode === "idle" ? (
          <>
            <ActionButton
              primary
              label="Forward to master"
              disabled={card.pending}
              onPress={card.forward}
            />
            <ActionButton label="Edit" disabled={card.pending} onPress={card.startEditing} />
            <ActionButton label="Drop" disabled={card.pending} onPress={card.drop} />
          </>
        ) : (
          <>
            <ActionButton
              primary
              label="Forward edited"
              disabled={card.pending}
              onPress={card.forwardEdited}
            />
            <ActionButton label="Cancel" disabled={card.pending} onPress={card.cancel} />
          </>
        )}
      </Actions>
    </Card>
  );
}

export function SuggestionCard(props: { readonly suggestion: Suggestion }) {
  const card = useSuggestionCard(props.suggestion);
  const { suggestion } = props;
  return (
    <Card>
      <Title>{suggestion.title}</Title>
      <Meta>{suggestionMeta(suggestion)}</Meta>
      <Body>{suggestion.why}</Body>
      {card.mode === "editing" ? (
        <TextField
          autoFocus
          mono
          value={card.afterText}
          onChangeText={card.setAfterText}
          placeholder="The change"
          accessibilityLabel="Edit the change"
        />
      ) : suggestion.diffText ? (
        <Mono>{suggestion.diffText}</Mono>
      ) : null}
      {card.mode === "dismissing" ? (
        <TextField
          autoFocus
          value={card.dismissReason}
          onChangeText={card.setDismissReason}
          placeholder="Why not? (optional, teaches the scribe)"
          accessibilityLabel="Dismiss reason"
        />
      ) : null}
      <Meta>{suggestionAcceptorLine(suggestion)}</Meta>
      <Actions>
        {card.mode === "idle" ? (
          <>
            <ActionButton primary label="Accept" disabled={card.pending} onPress={card.accept} />
            <ActionButton label="Edit" disabled={card.pending} onPress={card.startEditing} />
            <ActionButton label="Dismiss" disabled={card.pending} onPress={card.startDismiss} />
          </>
        ) : (
          <>
            <ActionButton
              primary
              label={card.mode === "editing" ? "Accept edited" : "Dismiss"}
              disabled={card.pending}
              onPress={card.mode === "editing" ? card.acceptEdited : card.dismiss}
            />
            <ActionButton label="Cancel" disabled={card.pending} onPress={card.cancel} />
          </>
        )}
      </Actions>
    </Card>
  );
}

export function NoteCard(props: { readonly note: Note; readonly nowMs: number }) {
  return (
    <Card>
      <Body selectable>{props.note.summary}</Body>
      <Meta>{noteMeta(props.note, props.nowMs)}</Meta>
      {props.note.evidenceLinks.length > 0 ? (
        <Meta>{props.note.evidenceLinks.map((link) => link.label).join(" · ")}</Meta>
      ) : null}
    </Card>
  );
}
