import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { MissionId, RoomId, ThreadId } from "@t3tools/contracts";
import { badgeCount, type InboxEntry } from "@t3tools/client-runtime/ardud/missions";
import {
  focusChoices,
  inboxTotal,
  missionGroupRows,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenHeader } from "../../components/ScreenHeader";
import { cn } from "../../lib/cn";
import { InboxPane } from "./InboxPane";
import { MissionBoard } from "./MissionBoard";
import { useMissionList, useMissionOverview, useMissionsEnvironmentId } from "./missionsStore";
import { useOverviewActions } from "./overviewLogic";
import { CountPill, EmptyLine } from "./parts";
import {
  MISSIONS_TABS,
  missionsRouteParams,
  missionsRouteState,
  type MissionsRouteParams,
  type MissionsRouteState,
} from "./routeParams";
import { RoomsPane } from "./RoomsPane";
import { MissionRows } from "./rows";
import { useNowMs } from "./useMissionsLogic";

// Desk pages split into list + reading pane from tablet widths up.
const SPLIT_WIDTH = 700;

/**
 * The Missions area: Inbox, Missions and Rooms behind an in-screen bar at the
 * foot. Route params hold where the owner is, so back and links restore it.
 */
export function MissionsRouteScreen({ route }: StaticScreenProps<MissionsRouteParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const nowMs = useNowMs();
  const environmentId = useMissionsEnvironmentId();
  const state = missionsRouteState(route.params);
  const list = useMissionList();
  const overview = useMissionOverview(state.missionId);
  const actions = useOverviewActions(overview);
  const [width, setWidth] = useState(0);
  const [askKey, setAskKey] = useState(0);
  const wide = width >= SPLIT_WIDTH;
  const readerInset = keyboardVisible ? 8 : 0;

  const go = (next: Partial<MissionsRouteState>) =>
    navigation.setParams(missionsRouteParams({ ...state, ...next }));
  const openItem = (entry: InboxEntry) =>
    navigation.navigate("MissionRecord", {
      kind: "item",
      id: entry.key,
      missionId: entry.record.missionId ?? state.missionId ?? undefined,
    });
  const openRequest = (requestId: string) =>
    state.missionId &&
    navigation.navigate("MissionRecord", {
      kind: "request",
      id: requestId,
      missionId: state.missionId,
    });
  const openRoom = (roomId: RoomId) =>
    navigation.navigate("MissionRecord", {
      kind: "room",
      id: roomId,
      missionId: state.missionId ?? undefined,
    });
  const openThread = (threadId: ThreadId) => {
    if (environmentId) navigation.navigate("Thread", { environmentId, threadId });
  };

  const rows = missionGroupRows(list);
  const missionRow = rows.find((row) => row.id === state.missionId) ?? null;
  const roomsMissionId = state.missionId ?? (rows.length === 1 ? rows[0]!.id : null);
  const needsYou = missionRow
    ? (list?.missions.find((mission) => mission.id === missionRow.id)?.needsYou ?? 0)
    : inboxTotal(list);

  const title =
    state.tab === "inbox"
      ? "Inbox"
      : state.tab === "rooms"
        ? "Rooms"
        : (missionRow?.title ?? "Missions");
  const mission = overview?.mission ?? null;

  const pickMission = (missionId: MissionId) => go({ missionId, page: "board" });
  const missionPicker = (
    <ScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pb-8 pt-3">
      {list === undefined ? (
        <EmptyLine label="Loading" />
      ) : rows.length === 0 ? (
        <EmptyLine label="No missions yet." />
      ) : (
        <MissionRows rows={rows} selectedId={state.missionId} onOpen={pickMission} />
      )}
    </ScrollView>
  );

  let body: React.ReactNode;
  if (state.tab === "inbox") {
    body = (
      <InboxPane
        missionId={state.missionId}
        list={list}
        filter={state.inboxTab}
        onFilter={(filter) => go({ inboxTab: filter === "all" ? null : filter })}
        onOpen={openItem}
        wide={wide}
        nowMs={nowMs}
        bottomInset={readerInset}
      />
    );
  } else if (state.tab === "rooms") {
    body = roomsMissionId ? (
      <RoomsPane
        missionId={roomsMissionId}
        overview={roomsMissionId === state.missionId ? overview : undefined}
        wide={wide}
        nowMs={nowMs}
        bottomInset={readerInset}
        onOpenRoom={openRoom}
      />
    ) : (
      missionPicker
    );
  } else if (state.missionId === null) {
    body = missionPicker;
  } else if (overview === undefined) {
    body = <EmptyLine label="Loading" />;
  } else if (overview === null) {
    body = <EmptyLine label="This mission is gone." />;
  } else {
    body = (
      <MissionBoard
        overview={overview}
        list={list}
        page={state.page}
        onPage={(page) => go({ page })}
        askKey={askKey}
        wide={wide}
        nowMs={nowMs}
        bottomInset={readerInset}
        onOpenInbox={() => go({ tab: "inbox", inboxTab: null })}
        onOpenItem={openItem}
        onOpenRequest={openRequest}
        onOpenThread={openThread}
      />
    );
  }

  const inMission = state.tab === "missions" && mission !== null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <ScreenHeader
        title={title}
        sidebar={false}
        onBack={() => navigation.goBack()}
        actions={
          inMission
            ? [
                {
                  accessibilityLabel: "Ask the master",
                  icon: "square.and.pencil",
                  onPress: () => {
                    setAskKey((key) => key + 1);
                    go({ page: "requests" });
                  },
                },
              ]
            : []
        }
        menus={
          inMission && overview
            ? [
                {
                  title: "Mission",
                  icon: "ellipsis.circle",
                  items: [
                    {
                      id: "pause",
                      title: mission.status === "paused" ? "Resume" : "Pause",
                      disabled: actions.pending,
                      onPress: actions.togglePaused,
                    },
                    {
                      id: "focus",
                      title: "Focus",
                      items: focusChoices(overview).map((choice) => ({
                        id: choice.id ?? "none",
                        title: choice.title,
                        selected: choice.selected,
                        onPress: () => actions.setFocus(choice.id),
                      })),
                    },
                  ],
                },
              ]
            : []
        }
      />
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
        <View className="flex-1" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {body}
        </View>
        {keyboardVisible ? null : (
          <View
            className="flex-row border-t border-border bg-screen"
            style={{ paddingBottom: insets.bottom }}
            accessibilityRole="tablist"
          >
            {MISSIONS_TABS.map((tab) => {
              const selected = state.tab === tab.value;
              return (
                <Pressable
                  key={tab.value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  accessibilityLabel={
                    tab.value === "inbox" && needsYou > 0
                      ? `${tab.label}, ${needsYou} need you`
                      : tab.label
                  }
                  className="h-16 flex-1 flex-row items-center justify-center gap-2"
                  onPress={() =>
                    tab.value === "missions" && state.tab === "missions"
                      ? go({ missionId: null, page: "board" })
                      : go({ tab: tab.value })
                  }
                >
                  <Text
                    className={cn(
                      "text-[15px]",
                      selected ? "font-t3-semibold text-foreground" : "text-foreground-muted",
                    )}
                  >
                    {tab.label}
                  </Text>
                  {tab.value === "inbox" && needsYou > 0 ? (
                    <CountPill label={badgeCount(needsYou)} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}
