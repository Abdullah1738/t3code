import type { InboxTab, MissionId, MissionInbox } from "@t3tools/contracts";
import {
  INBOX_EMPTY_LABEL,
  type InboxSegment,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import {
  ApprovalCard,
  AskCard,
  DraftCard,
  KnockCard,
  NoteCard,
  SuggestionCard,
} from "./InboxCards";
import { Meta } from "./parts";

export interface ChipOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly count?: number;
}

/** A row of tappable chips that scrolls sideways when it does not fit. */
export function ChipRow<Value extends string>(props: {
  readonly options: ReadonlyArray<ChipOption<Value>>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  readonly accessibilityLabel: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={props.accessibilityLabel}
      contentContainerClassName="gap-2 px-1"
    >
      {props.options.map((option) => {
        const selected = option.value === props.selected;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "h-9 flex-row items-center gap-1.5 rounded-full px-3.5",
              selected ? "bg-primary" : "bg-subtle",
            )}
          >
            <Text
              className={cn(
                "text-xs font-t3-bold",
                selected ? "text-primary-foreground" : "text-foreground",
              )}
            >
              {option.label}
              {option.count ? ` ${option.count}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function InboxSegments(props: {
  readonly segments: ReadonlyArray<InboxSegment>;
  readonly selected: InboxTab;
  readonly onSelect: (tab: InboxTab) => void;
}) {
  return (
    <ChipRow
      accessibilityLabel="Inbox sections"
      options={props.segments.map((segment) => ({
        value: segment.tab,
        label: segment.label,
        count: segment.count,
      }))}
      selected={props.selected}
      onSelect={props.onSelect}
    />
  );
}

/** The records of one inbox tab, newest first as the source sends them. */
export function InboxList(props: {
  readonly inbox: MissionInbox;
  readonly tab: InboxTab;
  readonly missionTitles: ReadonlyMap<MissionId, string>;
  readonly nowMs: number;
}) {
  const { inbox, nowMs } = props;
  const cards = (() => {
    switch (props.tab) {
      case "decide":
        return inbox.asks.map((ask) => <AskCard key={ask.id} ask={ask} nowMs={nowMs} />);
      case "approve":
        return [
          ...inbox.drafts.map((draft) => <DraftCard key={draft.id} draft={draft} nowMs={nowMs} />),
          ...inbox.approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} nowMs={nowMs} />
          )),
        ];
      case "knocks":
        return inbox.knocks.map((knock) => (
          <KnockCard
            key={knock.id}
            knock={knock}
            missionTitle={props.missionTitles.get(knock.missionId) ?? null}
            nowMs={nowMs}
          />
        ));
      case "suggestions":
        return inbox.suggestions.map((suggestion) => (
          <SuggestionCard key={suggestion.id} suggestion={suggestion} />
        ));
      case "fyi":
        return inbox.fyi.map((note) => <NoteCard key={note.id} note={note} nowMs={nowMs} />);
    }
  })();
  if (cards.length === 0) {
    return <EmptyState title={INBOX_EMPTY_LABEL[props.tab]} detail="New items show up here." />;
  }
  return (
    <View className="gap-3">
      {props.tab === "fyi" ? (
        <Meta>Ranked: what you must know first, then by severity.</Meta>
      ) : null}
      {cards}
    </View>
  );
}
