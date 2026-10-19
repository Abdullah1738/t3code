import type { MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import {
  groupRequests,
  isRequestUnread,
  openRequestInput,
  requestPreview,
  requestTitle,
  unreadRequestCount,
} from "./requestsViewModel.ts";
import type { MissionsSource, OwnerRequest } from "./source.ts";

const CRPKO = "crpko-engineering" as MissionId;
const now = () => Date.parse(FIXTURE_NOW) + 60_000;

function latest(source: MissionsSource) {
  let value: ReadonlyArray<OwnerRequest> = [];
  source.subscribeRequests(CRPKO, (next) => {
    value = next;
  });
  return () => value;
}

describe("owner requests", () => {
  it("titles a request by its first line and refuses an empty one", () => {
    expect(requestTitle("  Park the e2e lane\nIt has been idle all week")).toBe(
      "Park the e2e lane",
    );
    expect(requestTitle("x".repeat(90))).toHaveLength(80);
    expect(openRequestInput(CRPKO, "   ").ok).toBe(false);
  });

  it("groups answered unread first and keeps settled apart", () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    const { open, settled } = groupRequests(read());
    expect(open.map((r) => r.id)).toEqual([
      "request-dev-cost",
      "request-risk-round",
      "request-dylan-rebase",
    ]);
    expect(settled.map((r) => r.id)).toEqual(["request-codex-topups"]);
    expect(unreadRequestCount(read())).toBe(1);
    expect(requestPreview(open[0]!)).toMatch(/^Parked two idle lanes/);
  });

  it("opens, reads, replies, settles and reopens", async () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    await source.markRequestRead({ requestId: "request-dev-cost" });
    expect(unreadRequestCount(read())).toBe(0);

    const created = await source.openRequest({ missionId: CRPKO, text: "Park the e2e lane" });
    expect(read().find((r) => r.id === created.id)).toMatchObject({
      status: "waiting",
      title: "Park the e2e lane",
    });

    await source.replyRequest({ requestId: "request-dev-cost", text: "Yes to the resize." });
    const replied = read().find((r) => r.id === "request-dev-cost")!;
    expect(replied.status).toBe("waiting");
    expect(replied.messages.at(-1)).toMatchObject({ author: "owner", text: "Yes to the resize." });

    await source.settleRequest({ requestId: "request-risk-round" });
    await expect(
      source.replyRequest({ requestId: "request-risk-round", text: "more" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await source.reopenRequest({ requestId: "request-risk-round" });
    const reopened = read().find((r) => r.id === "request-risk-round")!;
    expect(reopened.status).toBe("answered");
    expect(isRequestUnread(reopened)).toBe(false);
  });

  it("keeps one open request per discussed record", async () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    const subject = { kind: "ask" as const, id: "ask-kafka-capacity-r004", label: "Kafka" };
    const first = await source.openRequest({ missionId: CRPKO, text: "Why 3 brokers?", subject });
    const again = await source.openRequest({ missionId: CRPKO, text: "And the cost?", subject });
    expect(again.id).toBe(first.id);
    expect(
      read()
        .find((r) => r.id === first.id)
        ?.messages.map((m) => m.text),
    ).toEqual(["Why 3 brokers?", "And the cost?"]);
    await source.settleRequest({ requestId: first.id });
    const fresh = await source.openRequest({ missionId: CRPKO, text: "Back again", subject });
    expect(fresh.id).not.toBe(first.id);
  });
});
