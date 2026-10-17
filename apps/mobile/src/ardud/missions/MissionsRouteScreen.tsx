import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { InboxTab, MissionId } from "@t3tools/contracts";
import {
  inboxSegments,
  missionListRows,
  resolveInboxTab,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { needsYouLine, needsYouCounts } from "@t3tools/client-runtime/ardud/missions";
import { useMemo } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ChipRow, InboxList, InboxSegments } from "./InboxPanel";
import { MissionsListPanel, RoomsPanel } from "./ListPanels";
import { useMissionInbox, useMissionList } from "./missionsStore";
import { Meta } from "./parts";
import {
  inboxRouteParams,
  MISSIONS_TABS,
  type MissionsRouteParams,
  missionsRouteState,
  type MissionsTab,
} from "./routeParams";
import { useNowMs } from "./useMissionsLogic";

const ALL_MISSIONS = "all";

/** Missions on the phone: Inbox, Missions and Rooms. Route params hold the tab state. */
export function MissionsRouteScreen({ route }: StaticScreenProps<MissionsRouteParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const nowMs = useNowMs();
  const state = missionsRouteState(route.params);
  const list = useMissionList();
  const inbox = useMissionInbox(state.missionId);

  const rows = useMemo(() => (list ? missionListRows(list.missions) : undefined), [list]);
  const missionTitles = useMemo(
    () => new Map<MissionId, string>(rows?.map((row) => [row.id, row.title]) ?? []),
    [rows],
  );
  const inboxTab = resolveInboxTab(state.inboxTab, inbox);
  const summary = inbox ? (needsYouLine(needsYouCounts(inbox)) ?? "Nothing needs you.") : null;

  const selectTab = (tab: MissionsTab) => navigation.setParams({ tab });
  const selectInboxTab = (tab: InboxTab) => navigation.setParams({ inboxTab: tab });
  const filterInbox = (value: string) =>
    navigation.setParams({ missionId: value === ALL_MISSIONS ? undefined : value });
  const openMission = (missionId: MissionId) =>
    navigation.navigate("MissionOverview", { missionId });
  const openInbox = (missionId: MissionId) => navigation.setParams(inboxRouteParams(missionId));

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title="Missions"
        subtitle="Prototype"
        sidebar={false}
        onBack={() => navigation.goBack()}
      />
      <ScreenScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SegmentedControl
          options={MISSIONS_TABS}
          selected={state.tab}
          onSelect={selectTab}
          role="tab"
        />
        {state.tab === "inbox" ? (
          <>
            {rows && rows.length > 1 ? (
              <ChipRow
                accessibilityLabel="Show the inbox of"
                options={[
                  { value: ALL_MISSIONS, label: "All missions" },
                  ...rows.map((row) => ({ value: row.id as string, label: row.title })),
                ]}
                selected={state.missionId ?? ALL_MISSIONS}
                onSelect={filterInbox}
              />
            ) : null}
            {summary ? <Meta>{summary}</Meta> : null}
            <InboxSegments
              segments={inboxSegments(inbox)}
              selected={inboxTab}
              onSelect={selectInboxTab}
            />
            {inbox ? (
              <InboxList inbox={inbox} tab={inboxTab} missionTitles={missionTitles} nowMs={nowMs} />
            ) : (
              <Meta>Loading the inbox…</Meta>
            )}
          </>
        ) : state.tab === "missions" ? (
          <MissionsListPanel rows={rows} onOpenMission={openMission} onOpenInbox={openInbox} />
        ) : (
          <RoomsPanel missions={rows} nowMs={nowMs} />
        )}
      </ScreenScrollView>
    </View>
  );
}
