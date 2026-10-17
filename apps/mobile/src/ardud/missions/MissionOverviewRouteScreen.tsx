import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { InboxTab, MissionId } from "@t3tools/contracts";
import { focusChoices, overviewHeaderView } from "@t3tools/client-runtime/ardud/missions/mobile";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useMissionOverview } from "./missionsStore";
import {
  Blockers,
  BottomLine,
  CriticalPath,
  DirectionCheck,
  Feed,
  OverviewHeader,
  PriorityStack,
} from "./OverviewSections";
import { useOverviewActions } from "./overviewLogic";
import { Meta } from "./parts";
import { inboxRouteParams } from "./routeParams";
import { useNowMs } from "./useMissionsLogic";

export type MissionOverviewRouteParams = {
  readonly missionId: string;
};

/** One mission at a glance: bottom line, blockers, critical path, direction, stack, feed. */
export function MissionOverviewRouteScreen({
  route,
}: StaticScreenProps<MissionOverviewRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const nowMs = useNowMs();
  const missionId = route.params.missionId as MissionId;
  const overview = useMissionOverview(missionId);
  const actions = useOverviewActions(overview);

  const openInbox = (inboxTab?: InboxTab) =>
    navigation.dispatch(StackActions.popTo("Missions", inboxRouteParams(missionId, inboxTab)));
  const paused = overview?.mission.status === "paused";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title={overview?.mission.title ?? "Mission"}
        subtitle="Prototype"
        sidebar={false}
        onBack={() => navigation.goBack()}
        actions={
          overview
            ? [
                {
                  accessibilityLabel: paused ? "Resume mission" : "Pause mission",
                  icon: paused ? "play" : "stop.fill",
                  onPress: actions.togglePaused,
                  disabled: actions.pending,
                },
              ]
            : undefined
        }
        menus={
          overview
            ? [
                {
                  title: "Focus",
                  icon: "target",
                  items: focusChoices(overview).map((choice) => ({
                    id: choice.id ?? "none",
                    title: choice.title,
                    selected: choice.selected,
                    onPress: () => actions.setFocus(choice.id),
                  })),
                },
              ]
            : undefined
        }
      />
      <ScreenScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {overview === undefined ? (
          <Meta>Loading the mission…</Meta>
        ) : overview === null ? (
          <EmptyState title="Mission not found" detail="It may have been archived." />
        ) : (
          <>
            <OverviewHeader view={overviewHeaderView(overview, nowMs)} />
            <BottomLine overview={overview} nowMs={nowMs} />
            <Blockers overview={overview} onOpenInbox={() => openInbox()} />
            <CriticalPath overview={overview} nowMs={nowMs} />
            <DirectionCheck
              overview={overview}
              nowMs={nowMs}
              pending={actions.pending}
              onReact={actions.react}
            />
            <PriorityStack overview={overview} pending={actions.pending} onMove={actions.move} />
            <Feed
              overview={overview}
              nowMs={nowMs}
              pending={actions.pending}
              onMarkSeen={actions.markSeen}
              onReviewDraft={() => openInbox("approve")}
            />
          </>
        )}
      </ScreenScrollView>
    </View>
  );
}
