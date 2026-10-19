import { describe, expect, it } from "vite-plus/test";

import {
  LaneId,
  MissionId,
  type Lane,
  type MissionOverview,
  type MissionRecordRef,
} from "@t3tools/contracts";

import { createFixtureMissionsSource, FIXTURE_NOW } from "../fixture/index.ts";
import type { MissionOverviewSnapshot, OwnerRequest, Unsubscribe } from "../source.ts";
import { boardFigures, clockLabel, laneSections, sinceView, towardView } from "./board.ts";

const CRPKO = MissionId.make("crpko-engineering");
const NOW = Date.parse(FIXTURE_NOW) + 60_000;

function latest<T>(subscribe: (listener: (value: T) => void) => Unsubscribe): T {
  let value: T | undefined;
  subscribe((next) => {
    value = next;
  })();
  if (value === undefined) throw new Error("no value");
  return value;
}

function overviewOf(source = createFixtureMissionsSource({ now: () => NOW, surface: "mobile" })) {
  const overview = latest<MissionOverviewSnapshot | null>((listener) =>
    source.subscribeOverview(CRPKO, listener),
  );
  if (!overview) throw new Error("no overview");
  return { source, overview };
}

function request(
  id: string,
  status: OwnerRequest["status"],
  unread: boolean,
  subject: MissionRecordRef | null = null,
): OwnerRequest {
  return {
    id,
    missionId: CRPKO,
    title: id,
    status,
    messages: [],
    hasOlder: false,
    links: [],
    subject,
    unread,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    settledAt: null,
  };
}

describe("phone board", () => {
  it("reads clock times in the zone it is given", () => {
    const at = "2026-10-17T05:06:00.000Z";
    expect(clockLabel(at, NOW, "UTC")).toBe("05:06");
    expect(clockLabel(at, NOW, "Asia/Dubai")).toBe("09:06");
    // 22:06 on the 16th in Los Angeles, where it is already the 17th now.
    expect(clockLabel(at, NOW, "America/Los_Angeles")).toBe("Fri 16 Oct");
    expect(clockLabel("2026-10-17T08:00:00.000Z", NOW, "America/Los_Angeles")).toBe("01:00");
    expect(clockLabel("2026-10-14T19:30:00.000Z", NOW, "UTC")).toBe("Wed 14 Oct");
  });

  it("counts own requests in the figures and leaves discussions out", () => {
    const { overview } = overviewOf();
    const figures = boardFigures(
      overview,
      [
        request("a", "answered", true),
        request("b", "waiting", false),
        request("c", "answered", true, { kind: "ask", id: "ask-1" }),
      ],
      NOW,
      "UTC",
    );
    const requests = figures.find((figure) => figure.key === "requests");
    expect(requests).toMatchObject({ value: "1 answered", detail: "1 waiting" });
    const lanes = figures.find((figure) => figure.key === "lanes");
    expect(lanes?.value).toBe(
      `${overview.lanes.working} of ${
        overview.lanes.working +
        overview.lanes.stuck +
        overview.lanes.waiting +
        overview.lanes.idle +
        overview.lanes.parked
      }`,
    );
    expect(figures.find((figure) => figure.key === "since")?.label).toBe("Since 05:06");
  });

  it("moves Since you last looked only when the owner marks it seen", async () => {
    const { source, overview } = overviewOf();
    const before = sinceView(overview, NOW, "UTC");
    expect(before.mark).toBe("05:06");
    expect(before.rows.length).toBeGreaterThan(0);
    expect(before.canMarkSeen).toBe(true);

    // Reading the board again changes nothing.
    const again = overviewOf(source).overview;
    expect(sinceView(again, NOW, "UTC").rows).toEqual(before.rows);

    await source.markMissionSeen({ missionId: CRPKO });
    const after = overviewOf(source).overview;
    const seen = sinceView({ ...after, directionCheck: [] }, NOW, "UTC");
    expect(seen.mark).toBe("08:34");
    expect(seen.rows).toEqual([]);
    expect(seen.canMarkSeen).toBe(false);
  });

  it("lets the owner answer the master's calls with Fine", () => {
    const { overview } = overviewOf();
    const view = sinceView(
      {
        feed: [],
        ownerLastLookedAt: overview.ownerLastLookedAt,
        directionCheck: [
          {
            ref: { kind: "call", id: "call-1" },
            summary: "Held the deploy",
            reason: "Master call",
            at: FIXTURE_NOW,
          },
          {
            ref: { kind: "rule", id: "rule-1" },
            summary: "New rule",
            reason: "Guide change",
            at: FIXTURE_NOW,
          },
        ],
      } satisfies Pick<MissionOverview, "feed" | "ownerLastLookedAt" | "directionCheck">,
      NOW,
      "UTC",
    );
    expect(view.rows.map((row) => row.callId)).toEqual(["call-1", null]);
    expect(view.rows[0]?.time).toBe("08:33");
  });

  it("names the next milestone day in the reader's zone", () => {
    const { overview } = overviewOf();
    const toward = towardView(overview, NOW, "UTC");
    expect(toward?.title).toMatch(/^Toward \w{3} \d{1,2} \w{3}$/);
    expect(toward?.subMissions[0]?.rank).toBe(1);
  });

  it("groups lanes problems first and keeps their threads", () => {
    const lane = (id: string, status: Lane["status"], lastActiveAt: string | null): Lane =>
      ({
        id: LaneId.make(id),
        missionId: CRPKO,
        subMissionId: null,
        name: id,
        purpose: `${id} purpose`,
        status,
        statusReason: status === "stuck" ? "CI red" : null,
        leadRoleId: null,
        threadId: null,
        currentItemId: null,
        lastEvidence: null,
        context: null,
        lastActiveAt,
        createdAt: FIXTURE_NOW,
        updatedAt: FIXTURE_NOW,
      }) as unknown as Lane;
    const sections = laneSections(
      [
        lane("idle-1", "idle", null),
        lane("work-old", "working", "2026-10-17T06:00:00.000Z"),
        lane("work-new", "working", "2026-10-17T08:00:00.000Z"),
        lane("stuck-1", "stuck", "2026-10-17T07:00:00.000Z"),
        lane("gone", "retired", null),
      ],
      NOW,
    );
    expect(sections.map((section) => section.key)).toEqual(["stuck", "working", "idle", "parked"]);
    expect(sections[0]?.rows[0]).toMatchObject({ reason: "CI red", age: "1h" });
    expect(sections[1]?.rows.map((row) => row.name)).toEqual(["work-new", "work-old"]);
  });
});
