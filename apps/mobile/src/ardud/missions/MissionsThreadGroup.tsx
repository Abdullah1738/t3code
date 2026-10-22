import { useNavigation } from "@react-navigation/native";
import { inboxTotal, missionGroupRows } from "@t3tools/client-runtime/ardud/missions/mobile";
import { useMemo } from "react";
import { View } from "react-native";

import { warmBoard } from "./boardFeeds";
import { useMissionList } from "./missionsStore";
import { LinkButton, SectionHead } from "./parts";
import { missionsRouteParams } from "./routeParams";
import { MissionRows } from "./rows";

/**
 * The Missions group at the top of the phone's thread list: one row per
 * mission, "Inbox N" on the right. Nothing shows until a mission exists.
 */
export function MissionsThreadGroup() {
  const navigation = useNavigation();
  const list = useMissionList();
  const rows = useMemo(() => missionGroupRows(list), [list]);
  if (rows.length === 0) return null;
  const waiting = inboxTotal(list);
  return (
    <View className="gap-1.5 px-4 pb-1 pt-3">
      <SectionHead
        title="Missions"
        trailing={
          <LinkButton
            label={waiting > 0 ? `Inbox ${waiting}` : "Inbox"}
            onPress={() => navigation.navigate("Missions", missionsRouteParams({ tab: "inbox" }))}
          />
        }
      />
      <MissionRows
        rows={rows}
        onPressIn={warmBoard}
        onOpen={(missionId) =>
          navigation.navigate("Missions", missionsRouteParams({ tab: "missions", missionId }))
        }
      />
    </View>
  );
}
