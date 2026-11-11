/**
 * The exhibits of an ask: what approving will run, the texts it replaces, the
 * draft it wants to send, and why it sits in the queue.
 */
import {
  STAGE_LABELS,
  askDraftEdited,
  askDraftText,
  diffCount,
  diffPieces,
  diffReadsInline,
  wordDiff,
  type AskForm,
  type ChangeView,
  type DiffSide,
  type NeedsYouItem,
} from "@t3tools/client-runtime/ardud/kanban";
import type {
  KanbanAskAction,
  KanbanAskChange,
  KanbanAskDraft,
  KanbanAskFeedItem,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { cn } from "../../../lib/cn";
import { MarkdownText, type ResolveKanbanLink } from "../../common/MarkdownText";
import { asks } from "./askStore";
import { askFacts } from "./logic";
import { GrowingInput, Label, Panel, Problem } from "./ui";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** A word-level difference in one paragraph: removed is struck out, added is marked. */
export function DiffText(props: {
  readonly before: string;
  readonly after: string;
  readonly side: DiffSide;
  readonly className?: string;
}) {
  const pieces = diffPieces(wordDiff(props.before, props.after), props.side);
  const removed = pieces.filter((piece) => piece.kind === "removed").length;
  const added = pieces.filter((piece) => piece.kind === "added").length;
  return (
    <Text
      accessibilityLabel={`${props.side === "before" ? props.before : props.after}. ${added} added, ${removed} removed.`}
      className={cn("text-base leading-6 text-foreground", props.className)}
    >
      {pieces.map((piece, index) =>
        piece.kind === "same" ? (
          // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
          <Text key={index}>{piece.text}</Text>
        ) : piece.kind === "removed" ? (
          // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
          <Text key={index} className="text-danger-foreground line-through">
            {piece.text}
          </Text>
        ) : (
          <Text
            // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
            key={index}
            className="bg-inline-skill-background font-t3-medium text-inline-skill-foreground"
          >
            {piece.text}
          </Text>
        ),
      )}
    </Text>
  );
}

const paper = "rounded-xl bg-screen p-3.5";

function Detail(props: { readonly name: string; readonly children: ReactNode }) {
  return (
    <View className="gap-0.5">
      <Label>{props.name}</Label>
      {props.children}
    </View>
  );
}

/**
 * What approving will run, laid out so nothing has to be looked up: the exact
 * command, where it runs, what it changes, the evidence it rests on, how to
 * undo it and what its agent does next.
 */
export function ActionDetails(props: {
  readonly action: KanbanAskAction;
  readonly resolveKanbanLink: ResolveKanbanLink;
}) {
  const { action } = props;
  return (
    <Panel accessibilityLabel="What this runs">
      {action.command ? (
        <View className="gap-1.5">
          <Label>Runs exactly this</Label>
          <View className={paper}>
            <Text
              selectable
              accessibilityLabel={`Command: ${action.command}`}
              className="text-sm leading-5 text-foreground"
              style={{ fontFamily: MONO }}
            >
              <Text className="text-foreground-muted" style={{ fontFamily: MONO }}>
                ${" "}
              </Text>
              {action.command}
            </Text>
          </View>
        </View>
      ) : null}
      {action.target ? (
        <Detail name="Where">
          <Text className="text-base text-foreground">{action.target}</Text>
        </Detail>
      ) : null}
      {action.summary ? (
        <Detail name="Changes">
          <MarkdownText
            text={action.summary}
            maxLines={null}
            resolveKanbanLink={props.resolveKanbanLink}
          />
        </Detail>
      ) : null}
      {action.evidence && action.evidence.length > 0 ? (
        <Detail name="Evidence">
          <View className="gap-1">
            {action.evidence.map((line) => (
              <View key={line} className="flex-row items-start gap-2">
                <View className="pt-[5px]">
                  <SymbolView
                    name="checkmark"
                    size={11}
                    tintColorClassName="accent-primary-text"
                    type="monochrome"
                  />
                </View>
                <Text className="min-w-0 flex-1 text-base text-foreground">{line}</Text>
              </View>
            ))}
          </View>
        </Detail>
      ) : null}
      {action.undo ? (
        <Detail name="To undo">
          <Text className="text-base text-foreground">{action.undo}</Text>
        </Detail>
      ) : null}
      {action.then && action.then.trim() !== "" ? (
        <Detail name="Then">
          <Text className="text-base text-foreground">{action.then}</Text>
        </Detail>
      ) : null}
    </Panel>
  );
}

const VIEW_OPTIONS = [
  { value: "after", label: "After" },
  { value: "before", label: "Before" },
  { value: "diff", label: "Changes" },
] as const;

function Whole(props: {
  readonly text: string;
  readonly format: KanbanAskChange["format"];
  readonly resolveKanbanLink: ResolveKanbanLink;
}) {
  return props.format === "markdown" ? (
    <MarkdownText text={props.text} maxLines={null} resolveKanbanLink={props.resolveKanbanLink} />
  ) : (
    <Text selectable className="text-base leading-6 text-foreground">
      {props.text}
    </Text>
  );
}

/**
 * The texts an ask replaces: as they will read, as they read now, or with the
 * difference marked. Several changes are stepped through one at a time. A
 * phone has no room for the two side by side, so that view reads as Changes.
 */
export function ChangeViewer(props: {
  readonly changes: ReadonlyArray<KanbanAskChange>;
  readonly view: ChangeView;
  readonly resolveKanbanLink: ResolveKanbanLink;
}) {
  const { changes } = props;
  const [at, setAt] = useState(0);
  const index = Math.max(0, Math.min(changes.length - 1, at));
  const change = changes[index];
  if (!change) return null;
  const view = props.view === "both" ? "diff" : props.view;
  const ops = wordDiff(change.before, change.after);
  const { added, removed } = diffCount(ops);
  const inline = diffReadsInline(ops, change.before, change.after);
  return (
    <Panel accessibilityLabel="Change">
      <SegmentedControl
        options={VIEW_OPTIONS}
        selected={view}
        onSelect={(next) => asks.setAskChangeView(next)}
        role="tab"
      />
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Text className="min-w-0 shrink text-sm font-t3-medium text-foreground">
          {change.label}
        </Text>
        <Text className="text-2xs text-foreground-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {added} {added === 1 ? "word" : "words"} added, {removed} removed
        </Text>
      </View>
      {view === "after" ? (
        <View className={paper}>
          <Whole
            text={change.after}
            format={change.format}
            resolveKanbanLink={props.resolveKanbanLink}
          />
        </View>
      ) : view === "before" ? (
        <View className={paper}>
          <Whole
            text={change.before}
            format={change.format}
            resolveKanbanLink={props.resolveKanbanLink}
          />
        </View>
      ) : inline ? (
        <View className={cn(paper, "gap-1.5")}>
          <Label>Removed is struck out, added is marked</Label>
          <DiffText before={change.before} after={change.after} side="both" />
        </View>
      ) : (
        <View className="gap-2">
          <Label>Rewritten: shown as it was and as it will be</Label>
          <View className={cn(paper, "gap-1")}>
            <Label>Before</Label>
            <DiffText before={change.before} after={change.after} side="before" />
          </View>
          <View className={cn(paper, "gap-1")}>
            <Label>After</Label>
            <DiffText before={change.before} after={change.after} side="after" />
          </View>
        </View>
      )}
      {changes.length > 1 ? (
        <View className="flex-row items-center justify-between">
          <StepButton
            label="Previous change"
            symbol="chevron.left"
            disabled={index === 0}
            onPress={() => setAt(index - 1)}
          />
          <Text
            accessibilityLiveRegion="polite"
            className="text-sm text-foreground-muted"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {index + 1} of {changes.length}
          </Text>
          <StepButton
            label="Next change"
            symbol="chevron.right"
            disabled={index === changes.length - 1}
            onPress={() => setAt(index + 1)}
          />
        </View>
      ) : null}
    </Panel>
  );
}

function StepButton(props: {
  readonly label: string;
  readonly symbol: "chevron.left" | "chevron.right";
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-full bg-screen active:opacity-70",
        props.disabled && "opacity-30",
      )}
    >
      <SymbolView
        name={props.symbol}
        size={14}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * A text the agent wants to send, shown as it will read. Where the ask lets
 * him edit it, Edit opens the text itself.
 */
export function DraftPart(props: {
  readonly entry: KanbanAskFeedItem;
  readonly draft: KanbanAskDraft;
  readonly form: AskForm;
  readonly editable: boolean;
  readonly editing: boolean;
  readonly onEditing: (editing: boolean) => void;
  readonly problem: string | undefined;
  readonly resolveKanbanLink: ResolveKanbanLink;
}) {
  const { entry, draft, form } = props;
  const text = askDraftText({ draft }, form);
  const edited = askDraftEdited({ draft }, form);
  const open = props.editable && (props.editing || props.problem !== undefined);
  return (
    <Panel accessibilityLabel="Draft">
      <View className="flex-row items-center justify-between gap-3">
        <Label className="min-w-0 flex-1">
          As it will appear{draft.target ? ` · ${draft.target}` : ""}
        </Label>
        {props.editable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? "Done editing the draft" : "Edit the draft"}
            hitSlop={10}
            onPress={() => props.onEditing(!open)}
            className="min-h-11 flex-row items-center gap-1.5"
          >
            {open ? null : (
              <SymbolView
                name="pencil"
                size={12}
                tintColorClassName="accent-primary-text"
                type="monochrome"
              />
            )}
            <Text className="text-sm font-t3-semibold text-primary-text">
              {open ? "Done" : "Edit"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <GrowingInput
          autoFocus
          accessibilityLabel="Draft text"
          invalid={props.problem !== undefined}
          value={text}
          maxLength={20_000}
          onChangeText={(next) => asks.patchAskForm(entry, { draft: next })}
          className={cn("bg-screen leading-6", draft.format === "markdown" && "text-sm")}
          style={draft.format === "markdown" ? { fontFamily: MONO } : undefined}
        />
      ) : (
        <View className={paper}>
          {draft.format === "markdown" ? (
            <MarkdownText text={text} maxLines={null} resolveKanbanLink={props.resolveKanbanLink} />
          ) : (
            <Text selectable className="text-base leading-6 text-foreground">
              {text}
            </Text>
          )}
        </View>
      )}
      {props.problem ? <Problem>{props.problem}</Problem> : null}
      {edited ? (
        <View className="gap-1">
          <Text className="text-sm text-warning-foreground">
            Edited. Your text is what gets sent.
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              props.onEditing(false);
              asks.patchAskForm(entry, { draft: null });
            }}
            className="min-h-11 justify-center self-start"
          >
            <Text className="text-sm font-t3-medium text-primary-text">
              Revert to the agent's text
            </Text>
          </Pressable>
        </View>
      ) : null}
    </Panel>
  );
}

/** Under the ask: its card, and why it sits in the queue. */
export function AskFacts(props: {
  readonly entry: KanbanAskFeedItem;
  readonly item: NeedsYouItem;
  readonly onOpenCard: () => void;
}) {
  const { entry, item } = props;
  const facts = askFacts(entry, item);
  return (
    <View className="gap-3">
      <View className="gap-1.5">
        <Label>Card</Label>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open card ${entry.cardNumber}, ${entry.cardTitle}`}
          onPress={props.onOpenCard}
          className="min-h-14 flex-row items-center gap-3 rounded-2xl bg-card px-3.5 py-2.5 active:bg-card-alt"
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base font-t3-medium text-foreground">
              {entry.boardName} #{entry.cardNumber}
            </Text>
            <Text numberOfLines={2} className="text-sm text-foreground-muted">
              {STAGE_LABELS[entry.stage]} · {entry.cardTitle}
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
      </View>
      <View className="gap-1.5">
        <Label>Why it is here</Label>
        <View className="gap-1.5 rounded-2xl bg-card px-3.5 py-3">
          {facts.map(([name, value]) => (
            <View
              key={name}
              accessible
              accessibilityLabel={`${name}: ${value}`}
              className="flex-row items-baseline justify-between gap-4"
            >
              <Text className="text-sm text-foreground">{name}</Text>
              <Text
                className="min-w-0 shrink text-right text-sm font-t3-medium text-foreground"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
