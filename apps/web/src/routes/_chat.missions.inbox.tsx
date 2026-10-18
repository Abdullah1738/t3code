import { createFileRoute } from "@tanstack/react-router";

import type { MissionId } from "@t3tools/contracts";

import { MissionInboxPage } from "../ardud/missions/MissionInboxPage";
import { parseMissionInboxSearch } from "../ardud/missions/missionSearch";

function MissionInboxRouteView() {
  const search = Route.useSearch();
  return (
    <MissionInboxPage
      missionId={(search.mission ?? null) as MissionId | null}
      tab={search.tab ?? null}
      route={search.route ?? "owner"}
    />
  );
}

export const Route = createFileRoute("/_chat/missions/inbox")({
  validateSearch: parseMissionInboxSearch,
  component: MissionInboxRouteView,
});
