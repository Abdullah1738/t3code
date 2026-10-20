import type {
  Approval,
  Ask,
  Draft,
  InboxMark,
  Knock,
  MissionId,
  Note,
  Suggestion,
} from "@t3tools/contracts";
import {
  ageView,
  entryHeadline,
  ownerConditionOf,
  refLabel,
  routeLine,
  type InboxEntry,
} from "@t3tools/client-runtime/ardud/missions";
import {
  draftFacts,
  entrySubject,
  knockFacts,
  noteFacts,
  suggestionFacts,
  type CardFact,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { DiscussionPanel } from "./Discussion";
import {
  useApprovalCard,
  useAskCard,
  useDraftCard,
  useItemMarks,
  useKnockCard,
  useMoveRecord,
  useNoteCard,
  useSuggestionCard,
  type AskCardState,
  type MoveState,
} from "./inboxLogic";
import { CommentsBlock, SnoozeControl } from "./ItemMarks";
import {
  ActionBar,
  ActionButton,
  Body,
  Chip,
  ConditionQuote,
  Facts,
  LinkChips,
  Meta,
  TextField,
} from "./parts";
import { useTemplatedItem } from "./ViewBlocks";

// The reading card for one inbox item with its decide bar pinned below. The
// same component fills the pushed item screen on phones and the reading pane
// on iPad. The discussion sits open on the item; it adds to no count.

interface FrameProps {
  readonly entry: InboxEntry;
  readonly missionId: MissionId | null;
  readonly nowMs: number;
  readonly bottomInset: number;
  /** The owner's comments and snooze on the item. */
  readonly mark: InboxMark | undefined; // ardud missions: finish-a
}

export function ItemReader(props: FrameProps) {
  const { entry } = props;
  switch (entry.kind) {
    case "ask":
      return <AskItem {...props} ask={entry.record} />;
    case "draft":
      return <DraftItem {...props} draft={entry.record} />;
    case "approval":
      return <ApprovalItem {...props} approval={entry.record} />;
    case "knock":
      return <KnockItem {...props} knock={entry.record} />;
    case "suggestion":
      return <SuggestionItem {...props} suggestion={entry.record} />;
    case "note":
      return <NoteItem {...props} note={entry.record} />;
  }
}

function Frame(
  props: FrameProps & {
    readonly children: ReactNode;
    readonly actions: ReactNode;
    readonly condition?: string | null;
    readonly kicker?: string | null; // ardud missions: views (a template's kicker)
  },
) {
  const headline = entryHeadline(props.entry);
  const age = ageView(headline.since, props.nowMs)?.label ?? null;
  const marks = useItemMarks(props.entry, props.mark, props.nowMs);
  return (
    <View className="flex-1">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerClassName="gap-4 px-4 pb-8 pt-4"
      >
        <View className="flex-row items-center gap-2">
          <Chip label={props.kicker ?? headline.kicker} />
          {age ? <Meta>{age}</Meta> : null}
          <SnoozeControl marks={marks} />
        </View>
        <Text selectable className="text-2xl leading-8 text-foreground">
          {headline.title}
        </Text>
        {props.condition ? <ConditionQuote quote={props.condition} /> : null}
        {props.children}
        <CommentsBlock marks={marks} nowMs={props.nowMs} />
        <View className="h-px bg-border" />
        <DiscussionPanel
          missionId={props.missionId}
          subject={entrySubject(props.entry)}
          nowMs={props.nowMs}
          open
        />
      </ScrollView>
      <ActionBar bottomInset={props.bottomInset}>{props.actions}</ActionBar>
    </View>
  );
}

function withFacts(facts: ReadonlyArray<CardFact>, extra: CardFact | null): CardFact[] {
  return extra ? [...facts, extra] : [...facts];
}

/** The reason field and buttons while a draft or approval is being moved. */
function MoveField(props: { readonly move: MoveState }) {
  if (!props.move.open) return null;
  return (
    <TextField
      autoFocus
      value={props.move.reason}
      onChangeText={props.move.setReason}
      placeholder="Why move it?"
    />
  );
}

function MoveActions(props: { readonly move: MoveState }) {
  return (
    <>
      <ActionButton
        primary
        label={props.move.label}
        disabled={props.move.pending || props.move.reason.trim() === ""}
        onPress={props.move.send}
      />
      <ActionButton label="Cancel" onPress={props.move.cancel} />
    </>
  );
}

// ---------------------------------------------------------------------------

function AskItem(props: FrameProps & { readonly ask: Ask }) {
  const backed = useMemo(() => ({ kind: "ask" as const, record: props.ask }), [props.ask]);
  const templated = useTemplatedItem(props.missionId, backed, props.nowMs);
  const card = useAskCard(props.ask, templated ?? undefined);
  const { view } = card;
  const facts: CardFact[] = [{ label: "If you wait", value: view.costOfWaiting }];
  if (props.ask.blocks.length > 0) {
    facts.push({ label: "Blocks", value: props.ask.blocks.map((ref) => refLabel(ref)).join(", ") });
  }
  return (
    <Frame
      {...props}
      kicker={templated?.kicker}
      actions={
        <ActionButton
          primary
          label="Answer"
          disabled={!card.canSubmit || card.pending}
          onPress={card.submit}
        />
      }
    >
      {templated ? (
        templated.render({
          picked: card.pickedOptionId,
          onPick: card.pickOption,
          disabled: card.pending,
        })
      ) : (
        <AskBody card={card} facts={facts} />
      )}
      <TextField
        value={card.text}
        onChangeText={card.setText}
        placeholder={view.options.length > 0 ? "Or answer in your own words" : "Your answer"}
        minHeight="few"
      />
    </Frame>
  );
}

function AskBody(props: { readonly card: AskCardState; readonly facts: ReadonlyArray<CardFact> }) {
  const { card } = props;
  const { view } = card;
  return (
    <>
      {view.context ? <Body>{view.context}</Body> : null}
      <Facts facts={props.facts} />
      {view.options.length > 0 ? (
        <View accessibilityRole="radiogroup" className="gap-2">
          {view.options.map((option) => {
            const picked = card.pickedOptionId === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked }}
                onPress={() => card.pickOption(option.id)}
                className={cn(
                  "min-h-11 flex-row gap-3 rounded-[18px] px-3.5 py-3",
                  picked ? "bg-update" : "bg-grouped-card",
                )}
              >
                <View
                  className={cn(
                    "mt-1 size-3.5 rounded-full border",
                    picked ? "border-primary bg-primary" : "border-foreground-muted",
                  )}
                />
                <View className="flex-1 gap-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="flex-1 text-[15px] font-t3-semibold text-foreground">
                      {option.label}
                    </Text>
                    {option.recommended ? <Meta>Master's pick</Meta> : null}
                  </View>
                  {option.detail ? <Meta>{option.detail}</Meta> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {view.recommendation ? <Meta>{view.recommendation.reason}</Meta> : null}
    </>
  );
}

function DraftItem(props: FrameProps & { readonly draft: Draft }) {
  const card = useDraftCard(props.draft);
  const move = useMoveRecord("draft", props.draft);
  const moved = routeLine(props.draft);
  const actions = move.open ? (
    <MoveActions move={move} />
  ) : card.mode === "editing" ? (
    <>
      <ActionButton
        primary
        label="Edit and approve"
        disabled={card.pending}
        onPress={card.approveEdited}
      />
      <ActionButton label="Cancel" onPress={card.cancel} />
    </>
  ) : card.mode === "rewriting" ? (
    <>
      <ActionButton
        primary
        label="Rewrite"
        disabled={card.pending || card.rewriteNote.trim() === ""}
        onPress={card.sendRewrite}
      />
      <ActionButton label="Cancel" onPress={card.cancel} />
    </>
  ) : (
    <>
      <ActionButton primary label="Approve" disabled={card.pending} onPress={card.approve} />
      <ActionButton label="Edit" onPress={card.startEditing} />
      <ActionButton label="Rewrite" onPress={card.startRewrite} />
      <ActionButton label="Drop" disabled={card.pending} onPress={card.drop} />
      <ActionButton label={move.label} onPress={move.start} />
    </>
  );
  return (
    <Frame {...props} actions={actions} condition={ownerConditionOf(props.draft)?.quote ?? null}>
      <LinkChips links={[props.draft.target]} />
      <Facts
        facts={withFacts(
          draftFacts(props.draft),
          moved ? { label: "Moved because", value: moved } : null,
        )}
      />
      {card.mode === "editing" ? (
        <TextField
          autoFocus
          value={card.editedText}
          onChangeText={card.setEditedText}
          placeholder="Draft"
          minHeight="few"
        />
      ) : (
        <Body>{props.draft.text}</Body>
      )}
      {props.draft.withdrawNote ? <Meta>{props.draft.withdrawNote}</Meta> : null}
      {card.mode === "rewriting" ? (
        <TextField
          autoFocus
          value={card.rewriteNote}
          onChangeText={card.setRewriteNote}
          placeholder="What should change?"
        />
      ) : null}
      <MoveField move={move} />
    </Frame>
  );
}

function ApprovalItem(props: FrameProps & { readonly approval: Approval }) {
  const card = useApprovalCard(props.approval);
  const move = useMoveRecord("approval", props.approval);
  const moved = routeLine(props.approval);
  const text = props.approval.summary?.trim() || props.approval.detail;
  const backed = useMemo(
    () => ({ kind: "approval" as const, record: props.approval }),
    [props.approval],
  );
  const templated = useTemplatedItem(props.missionId, backed, props.nowMs);
  return (
    <Frame
      {...props}
      kicker={templated?.kicker}
      condition={ownerConditionOf(props.approval)?.quote ?? null}
      actions={
        move.open ? (
          <MoveActions move={move} />
        ) : (
          <>
            <ActionButton primary label="Approve" disabled={card.pending} onPress={card.approve} />
            <ActionButton label="Reject" disabled={card.pending} onPress={card.reject} />
            <ActionButton label={move.label} onPress={move.start} />
          </>
        )
      }
    >
      {templated ? (
        templated.render()
      ) : (
        <>
          <LinkChips links={props.approval.links} />
          {text ? <Body>{text}</Body> : null}
        </>
      )}
      {moved ? <Facts facts={[{ label: "Moved because", value: moved }]} /> : null}
      {move.open ? (
        <MoveField move={move} />
      ) : (
        <TextField value={card.note} onChangeText={card.setNote} placeholder="Note" />
      )}
    </Frame>
  );
}

function KnockItem(props: FrameProps & { readonly knock: Knock }) {
  const card = useKnockCard(props.knock);
  return (
    <Frame
      {...props}
      actions={
        card.mode === "editing" ? (
          <>
            <ActionButton
              primary
              label="Forward"
              disabled={card.pending || card.editedText.trim() === ""}
              onPress={card.forwardEdited}
            />
            <ActionButton label="Cancel" onPress={card.cancel} />
          </>
        ) : (
          <>
            <ActionButton primary label="Forward" disabled={card.pending} onPress={card.forward} />
            <ActionButton label="Edit" onPress={card.startEditing} />
            <ActionButton label="Drop" disabled={card.pending} onPress={card.drop} />
          </>
        )
      }
    >
      <Facts facts={knockFacts(props.knock)} />
      {card.mode === "editing" ? (
        <TextField
          autoFocus
          value={card.editedText}
          onChangeText={card.setEditedText}
          placeholder="What the master reads"
          minHeight="few"
        />
      ) : props.knock.body ? (
        <Body>{props.knock.body}</Body>
      ) : null}
    </Frame>
  );
}

function SuggestionItem(props: FrameProps & { readonly suggestion: Suggestion }) {
  const card = useSuggestionCard(props.suggestion);
  const actions =
    card.mode === "editing" ? (
      <>
        <ActionButton primary label="Accept" disabled={card.pending} onPress={card.acceptEdited} />
        <ActionButton label="Cancel" onPress={card.cancel} />
      </>
    ) : card.mode === "dismissing" ? (
      <>
        <ActionButton
          primary
          label="Dismiss"
          disabled={card.pending || card.dismissReason.trim() === ""}
          onPress={card.dismiss}
        />
        <ActionButton label="Cancel" onPress={card.cancel} />
      </>
    ) : (
      <>
        <ActionButton primary label="Accept" disabled={card.pending} onPress={card.accept} />
        <ActionButton label="Edit" onPress={card.startEditing} />
        <ActionButton label="Dismiss" onPress={card.startDismiss} />
      </>
    );
  return (
    <Frame {...props} actions={actions}>
      <Facts facts={suggestionFacts(props.suggestion)} />
      {props.suggestion.why ? <Body>{props.suggestion.why}</Body> : null}
      {card.mode === "editing" ? (
        <TextField
          autoFocus
          value={card.afterText}
          onChangeText={card.setAfterText}
          placeholder="Change"
          minHeight="few"
        />
      ) : props.suggestion.diffText ? (
        <Text
          selectable
          className="rounded-[18px] bg-grouped-card p-3.5 font-mono text-xs leading-5 text-foreground"
        >
          {props.suggestion.diffText}
        </Text>
      ) : null}
      {card.mode === "dismissing" ? (
        <TextField
          autoFocus
          value={card.dismissReason}
          onChangeText={card.setDismissReason}
          placeholder="Why not?"
        />
      ) : null}
    </Frame>
  );
}

function NoteItem(props: FrameProps & { readonly note: Note }) {
  const card = useNoteCard(props.note);
  return (
    <Frame
      {...props}
      actions={<ActionButton primary label="Got it" disabled={card.pending} onPress={card.ack} />}
    >
      <Facts facts={noteFacts(props.note)} />
      <LinkChips links={props.note.evidenceLinks} />
    </Frame>
  );
}
