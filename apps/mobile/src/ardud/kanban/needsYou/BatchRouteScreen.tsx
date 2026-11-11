import type { StaticScreenProps } from "@react-navigation/native";
import {
  ASK_BATCH_MAX,
  askBatchTitle,
  askKey,
  askKindLabel,
  needsYouBatchKey,
  planAskBatch,
  type SnoozeUntil,
} from "@t3tools/client-runtime/ardud/kanban";
import { kanbanAskResponse, type KanbanAskFeedItem } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";

import type { AppBarMenuItem } from "../../../components/ui/AppBar.types";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { LoadingLine } from "../../common/FeedError";
import { useNowMs } from "../../common/hooks";
import { OptionRow } from "./AnswerParts";
import { useAskScope, useAsks, useOwnerStanding, useWatchAsks } from "./askStore";
import {
  batchAll,
  batchPrimaryLabel,
  ownerStandingBarText,
  type NeedsYouBatchParams,
} from "./logic";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { HandOverSheet, SnoozePickSheet, snoozeMenuItem } from "./sheets";
import {
  ActionRow,
  AskToastBar,
  BarButton,
  Check,
  FieldLabel,
  GrowingInput,
  Heading,
  Label,
  OwnerBand,
  OfflineBand,
  Problem,
  tapDone,
  tapProblem,
  tapSelection,
} from "./ui";
import { useQueue } from "./useQueue";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * Several asks of one shape, answered with one answer. Asks that take more
 * than that answer are listed apart and stay in the queue.
 */
export function BatchRouteScreen({ route }: StaticScreenProps<NeedsYouBatchParams | undefined>) {
  const nav = useNeedsYouNav();
  const nowMs = useNowMs();
  const bottomInset = useBottomInset();
  const { serial } = useAskScope();
  useWatchAsks(true);
  useOwnerStanding();
  const queue = useQueue(nowMs);
  const boardId = route.params?.boardId?.trim() ?? "";
  const batchKey = route.params?.batchKey ?? "";
  const batch = queue.needsYou.entries.find(
    (entry) => entry._tag === "batch" && entry.boardId === boardId && entry.batchKey === batchKey,
  );
  const entries =
    batch?._tag === "batch"
      ? batch.items.flatMap((item) =>
          queue.hidden.has(item.key) ? [] : (queue.entries.get(item.key) ?? []),
        )
      : [];
  const toast = (bar: number) => (
    <AskToastBar bottom={bottomInset + bar} onUndo={() => undefined} onView={nav.openAsk} />
  );
  if (batch?._tag !== "batch" || entries.length === 0) {
    return (
      <Screen title="Batch" onBack={nav.back}>
        <View className="gap-3 px-4 pt-4">
          {queue.read ? (
            <>
              <OfflineBand />
              <Text accessibilityRole="header" className="text-xl font-t3-semibold">
                Nothing left in this batch
              </Text>
              <Text className="text-base text-foreground-muted">
                These asks were answered or are on their way.
              </Text>
              <BarButton label="Needs you" onPress={nav.openQueue} />
            </>
          ) : (
            <LoadingLine />
          )}
        </View>
        {toast(8)}
      </Screen>
    );
  }
  return (
    <OpenBatch
      // What he ticked and typed for one server's batch never carries to another's.
      key={`${serial}:${needsYouBatchKey(batch)}`}
      focusKey={needsYouBatchKey(batch)}
      title={askBatchTitle(entries.map((entry) => entry.kind))}
      boardName={queue.boardNames.get(boardId) ?? ""}
      entries={entries}
      nowMs={nowMs}
      bottomInset={bottomInset}
      toast={toast}
    />
  );
}

function OpenBatch(props: {
  readonly focusKey: string;
  readonly title: string;
  readonly boardName: string;
  readonly entries: ReadonlyArray<KanbanAskFeedItem>;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly toast: (bar: number) => ReactNode;
}) {
  const asks = useAsks();
  const nav = useNeedsYouNav();
  const { standing } = useOwnerStanding();
  // Not known to be his own device (not yet, or not at all): nothing can be sent.
  const readOnly = standing !== "owner";
  const plan = planAskBatch(props.entries);
  const offered = plan.included.slice(0, ASK_BATCH_MAX);
  const over = plan.included.length - offered.length;
  // Every ask is in until he unticks it.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const included = offered.filter((entry) => !left.has(askKey(entry)));
  const count = included.length;
  // What History calls this answer: the asks it went to, not the whole batch.
  const only = count === 1 ? included[0] : undefined;
  const sentTitle = only
    ? (only.ask.title ?? only.ask.text)
    : askBatchTitle(included.map((entry) => entry.kind));
  const first = offered[0];
  const response = first ? kanbanAskResponse(first.ask) : null;
  const shape = plan.shape?.split(":")[0] ?? null;
  const [optionIds, setOptionIds] = useState<ReadonlyArray<string>>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [handOpen, setHandOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  // An evaluator can take what an owner can decide: not a notice, not one already asked of it.
  const handable =
    shape !== null && shape !== "ack" && included.every((entry) => entry.ask.to !== "evaluator");

  const labels = new Set(included.map((entry) => kanbanAskResponse(entry.ask).verdict?.approve));
  const approve = labels.size === 1 ? (response?.verdict?.approve ?? "Approve") : "Approve";
  const rejects = new Set(included.map((entry) => kanbanAskResponse(entry.ask).verdict?.reject));
  const reject = rejects.size === 1 ? (response?.verdict?.reject ?? "Reject") : "Reject";
  const all = batchAll(count, offered.length);
  const stop = (what: string) => {
    setProblem(what);
    tapProblem();
  };

  const send = (intent: "primary" | "refuse") => {
    if (count === 0 || shape === null || readOnly) return;
    const trimmedNote = note.trim();
    const extra = shape === "ack" || trimmedNote === "" ? {} : { note: trimmedNote };
    const go = (verdict: string, label: string, more: object = {}) => {
      asks.answerAskBatch(
        included,
        props.focusKey,
        { verdict, ...more, ...extra },
        label,
        sentTitle,
      );
      tapDone();
      nav.back();
    };
    if (shape === "ack") return go("acknowledged", "Seen");
    if (shape === "verdict") {
      return intent === "refuse"
        ? go("rejected", reject === "Reject" ? "Rejected" : reject)
        : go("approved", approve === "Approve" ? "Approved" : approve);
    }
    if (shape === "choose") {
      const choose = response?.choose;
      const picked =
        optionIds.length > 0
          ? optionIds
          : (
              choose?.options.filter((option) => option.recommended).map((option) => option.id) ??
              []
            ).slice(0, 1);
      if (choose && (picked.length < Math.max(1, choose.min) || picked.length > choose.max)) {
        return stop(choose.max === 1 ? "Pick one first" : `Pick ${choose.min} to ${choose.max}`);
      }
      return go("picked", "Answer sent", { optionIds: picked });
    }
    if (text.trim() === "") return stop("Type the answer first");
    return go("answered", "Answer sent", { text: text.trim() });
  };

  const snoozeUntil = (until: SnoozeUntil) => {
    if (readOnly) return;
    nav.back();
    void asks.snoozeAsks(included.length > 0 ? included : offered, until.iso, until.label);
  };
  const more: ReadonlyArray<AppBarMenuItem> = readOnly
    ? []
    : [
        snoozeMenuItem({
          nowMs: props.nowMs,
          title: `Snooze ${all} until`,
          onSnooze: snoozeUntil,
          onPick: () => setPickOpen(true),
        }),
      ];

  return (
    <Screen
      title={props.boardName || "Batch"}
      onBack={nav.back}
      {...(more.length > 0
        ? { menus: [{ title: "More", icon: "ellipsis.circle" as const, items: more }] }
        : {})}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerClassName="gap-5 px-4 pb-8 pt-4"
      >
        <View className="gap-2">
          {first ? (
            <Text className="text-sm text-foreground-muted">{askKindLabel(first.kind)}</Text>
          ) : null}
          <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
            {props.title}
          </Text>
        </View>
        <OwnerBand />
        <OfflineBand />

        {offered.length > 0 ? (
          <View className="gap-1.5">
            <Label>
              {count === 0
                ? "Tick the ones to answer"
                : `One answer goes to ${count === 1 ? "this one" : count === 2 ? "both" : `these ${count}`}`}
            </Label>
            <AskList
              entries={offered}
              left={left}
              disabled={readOnly}
              onToggle={(key) =>
                setLeft((current) => {
                  const next = new Set(current);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
              onToggleAll={() =>
                setLeft(
                  left.size === 0 ? new Set(offered.map((entry) => askKey(entry))) : new Set(),
                )
              }
              onOpenAsk={nav.openAsk}
            />
            {over > 0 ? (
              <Text className="text-sm text-foreground-muted">
                {over} more stay in the queue: one answer takes {ASK_BATCH_MAX} at most.
              </Text>
            ) : null}
          </View>
        ) : (
          <Text className="text-base text-foreground-muted">
            None of these can share an answer. Open each one.
          </Text>
        )}

        {plan.skipped.length > 0 ? (
          <View className="gap-1.5">
            <Label>Not answered with the batch</Label>
            <AskList
              entries={plan.skipped.map((entry) => entry.item)}
              why={plan.skipped.map((entry) => entry.why)}
              onOpenAsk={nav.openAsk}
            />
          </View>
        ) : null}

        {count > 0 && shape === "choose" && response?.choose ? (
          <View className="gap-3">
            <Heading>Your answer</Heading>
            <View
              accessibilityRole={response.choose.multi ? undefined : "radiogroup"}
              accessibilityLabel="Options"
              className="gap-2"
            >
              {response.choose.options.map((option) => {
                const checked = optionIds.includes(option.id);
                return (
                  <OptionRow
                    key={option.id}
                    label={option.label}
                    detail={option.detail}
                    recommended={option.recommended}
                    checked={checked}
                    multi={response.choose!.multi}
                    disabled={readOnly}
                    onPress={() => {
                      tapSelection();
                      setProblem(null);
                      setOptionIds(
                        response.choose!.multi
                          ? checked
                            ? optionIds.filter((id) => id !== option.id)
                            : [...optionIds, option.id]
                          : checked
                            ? []
                            : [option.id],
                      );
                    }}
                  />
                );
              })}
            </View>
            {problem ? <Problem>{problem}</Problem> : null}
          </View>
        ) : null}
        {count > 0 && shape === "text" ? (
          <View className="gap-3">
            <Heading>Your answer</Heading>
            <GrowingInput
              accessibilityLabel="Your answer"
              placeholder="Type one answer for all of them"
              editable={!readOnly}
              value={text}
              maxLength={20_000}
              invalid={problem !== null}
              onChangeText={(next) => {
                setProblem(null);
                setText(next);
              }}
            />
            {problem ? <Problem>{problem}</Problem> : null}
          </View>
        ) : null}
        {count > 0 && shape !== "ack" && shape !== null ? (
          <View className="gap-1.5">
            <FieldLabel label="Note" aside="Optional, goes with each" />
            <GrowingInput
              accessibilityLabel="Note, optional, goes with each"
              editable={!readOnly}
              value={note}
              maxLength={4_000}
              onChangeText={setNote}
            />
          </View>
        ) : null}
        {count > 0 && handable && !readOnly ? (
          <View className="gap-1.5">
            <Label>{count > 1 ? "Fewer like these" : "Fewer like this"}</Label>
            <View className="overflow-hidden rounded-2xl bg-card">
              <ActionRow
                label={
                  count > 1 ? `Hand these ${count} to the evaluator` : "Evaluator decides this one"
                }
                onPress={() => {
                  if (readOnly) return;
                  nav.back();
                  asks.handAsks(included, props.focusKey, undefined, sentTitle);
                }}
              />
              <View className="ml-3.5 h-px bg-border" />
              <ActionRow
                label={
                  count > 1 ? "…and ones like these from now on" : "…and ones like this from now on"
                }
                onPress={() => setHandOpen(true)}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>

      {count > 0 && shape !== null ? (
        <View
          className="flex-row items-center gap-2 border-t border-border bg-screen px-3 pt-2.5"
          style={{ paddingBottom: props.bottomInset }}
        >
          {standing !== "owner" ? (
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
              {ownerStandingBarText(standing, "answer")}
            </Text>
          ) : (
            <>
              {/* The "no" sits before the answer, as under a single ask. */}
              {shape === "verdict" ? (
                <BarButton limit label={`${reject} ${all}`} onPress={() => send("refuse")} />
              ) : null}
              <BarButton
                grow
                tone="primary"
                label={batchPrimaryLabel(shape, approve, all)}
                onPress={() => send("primary")}
              />
            </>
          )}
        </View>
      ) : null}
      {props.toast(count > 0 && shape !== null ? 76 : 8)}
      {handOpen && !readOnly ? (
        <HandOverSheet
          entries={included}
          focusKey={props.focusKey}
          title={sentTitle}
          onClose={() => setHandOpen(false)}
          onLeave={nav.back}
        />
      ) : null}
      {pickOpen && !readOnly ? (
        <SnoozePickSheet onClose={() => setPickOpen(false)} onSnooze={snoozeUntil} />
      ) : null}
    </Screen>
  );
}

function AskList(props: {
  readonly entries: ReadonlyArray<KanbanAskFeedItem>;
  readonly why?: ReadonlyArray<string>;
  /** With these, each row has a tick box: the asks he took out of the answer. */
  readonly left?: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly onToggle?: (key: string) => void;
  readonly onToggleAll?: () => void;
  readonly onOpenAsk: (key: string) => void;
}) {
  const { left, onToggle } = props;
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {left && props.onToggleAll && props.entries.length > 1 ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: left.size === 0, disabled: props.disabled ?? false }}
          accessibilityLabel="Select all"
          disabled={props.disabled}
          onPress={props.onToggleAll}
          className="min-h-12 flex-row items-center gap-3 px-3.5 active:bg-card-alt"
        >
          <Check checked={left.size === 0} />
          <Text className="text-base text-foreground">Select all</Text>
        </Pressable>
      ) : null}
      {props.entries.map((entry, index) => {
        const key = askKey(entry);
        const title = entry.ask.title ?? entry.ask.text;
        const ticked = left ? !left.has(key) : false;
        return (
          <View
            key={key}
            className={cn(
              "flex-row items-stretch",
              (index > 0 || (left && props.entries.length > 1)) && "border-t border-border",
            )}
          >
            {left && onToggle ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: ticked, disabled: props.disabled ?? false }}
                accessibilityLabel={`Answer #${entry.cardNumber} with the rest`}
                disabled={props.disabled}
                onPress={() => {
                  tapSelection();
                  onToggle(key);
                }}
                className="min-h-12 w-12 items-center justify-center active:bg-card-alt"
              >
                <Check checked={ticked} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open #${entry.cardNumber}, ${title}`}
              onPress={() => props.onOpenAsk(key)}
              className={cn(
                "min-h-12 min-w-0 flex-1 justify-center gap-0.5 py-2.5 pr-3.5 active:bg-card-alt",
                left && onToggle ? "pl-0.5" : "pl-3.5",
              )}
            >
              <Text className="text-base text-foreground">
                <Text className="font-t3-medium tabular-nums text-primary-text">
                  #{entry.cardNumber}
                </Text>{" "}
                {title}
              </Text>
              {entry.ask.action?.command ? (
                <Text className="text-2xs text-foreground-muted" style={{ fontFamily: MONO }}>
                  {entry.ask.action.command}
                </Text>
              ) : null}
              {props.why?.[index] ? (
                <Text className="text-sm text-foreground-muted">{props.why[index]}</Text>
              ) : null}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
