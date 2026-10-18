import { createFileRoute } from "@tanstack/react-router";

import type { MissionId, RoomId } from "@t3tools/contracts";

import { MissionPage } from "../ardud/missions/MissionPage";
import { parseMissionSearch } from "../ardud/missions/missionSearch";

function MissionRouteView() {
  const { missionId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <MissionPage
      missionId={missionId as MissionId}
      tab={search.tab ?? "overview"}
      highlightSubMissionId={search.sub ?? null}
      roomId={(search.room ?? null) as RoomId | null}
    />
  );
}

export const Route = createFileRoute("/_chat/missions/$missionId")({
  validateSearch: parseMissionSearch,
  component: MissionRouteView,
});
