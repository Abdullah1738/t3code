import { goalPage, type KanbanBoardState } from "@t3tools/client-runtime/ardud/kanban";
import { formatDayLabel } from "@t3tools/client-runtime/ardud/missions";
import { Fragment } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyLine } from "../missions/parts";
import { cardGlyph } from "./logic";
import { GoalBar, Glyph, KChip, StageHead } from "./parts";

/** A goal: progress, what is happening now, the story so far, and its cards by stage. */
export function GoalView(props: {
  readonly state: KanbanBoardState;
  readonly goalId: string;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const page = goalPage(props.state, props.goalId, props.nowMs);
  if (page === null) return <EmptyLine label="This goal is gone." />;
  const { progress } = page;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-5 px-4 pt-3"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
    >
      <View className="gap-3">
        <Text
          accessibilityRole="header"
          className="text-[24px] font-t3-bold leading-8 text-foreground"
        >
          {page.goal.name}
        </Text>
        {page.projects.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5">
            {page.projects.map((project) => (
              <KChip key={project} label={project} />
            ))}
          </View>
        ) : null}
        <View className="flex-row items-center gap-3">
          <GoalBar progress={progress} tall />
          <Text className="text-[13px] text-foreground-muted">
            {progress.verified} of {progress.total} verified
          </Text>
        </View>
      </View>

      {page.now ? (
        <View className="gap-1.5">
          <View className="flex-row items-baseline gap-2">
            <Text accessibilityRole="header" className="text-[15px] font-t3-bold text-foreground">
              Now
            </Text>
            {page.now.age ? (
              <Text className="text-[12px] text-foreground-muted">{page.now.age}</Text>
            ) : null}
          </View>
          <Text selectable className="text-[16px] leading-6 text-foreground">
            {page.now.text}
          </Text>
        </View>
      ) : null}

      {page.story.length > 0 ? (
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-[15px] font-t3-bold text-foreground">
            Story
          </Text>
          {page.story.map((entry, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- the story only grows at the end
            <View key={index} className="flex-row gap-3">
              <Text className="w-5 text-[14px] font-t3-medium leading-[21px] text-foreground">
                {index + 1}
              </Text>
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[12px] text-foreground-muted">
                  {formatDayLabel(entry.at)}
                </Text>
                <Text selectable className="text-[15px] leading-[22px] text-foreground">
                  {entry.text}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View className="gap-3">
        {page.stages.map((column) => (
          <View key={column.stage} className="rounded-[14px] bg-card px-3 pb-1.5 pt-1.5">
            <StageHead
              label={column.label}
              count={column.cards.length}
              owner={column.stage === "needs_owner"}
            />
            {column.cards.map((view, index) => (
              <Fragment key={view.id}>
                {index > 0 ? <View className="ml-[22px] h-px bg-border" /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${view.number}, ${view.title}`}
                  onPress={() => props.onOpenCard(view.id)}
                  className="min-h-11 flex-row items-center gap-3 px-1 py-2"
                >
                  <Glyph kind={cardGlyph(view.card)} />
                  <Text numberOfLines={2} className="flex-1 text-[15px] text-foreground">
                    {view.title}
                  </Text>
                  <Text className="text-[12px] text-foreground-muted">{view.number}</Text>
                </Pressable>
              </Fragment>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
