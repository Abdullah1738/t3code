import { describe, expect, it } from "vite-plus/test";
import {
  askLatencyRollup,
  askTimingProps,
  markAskTiming,
  type AskTimingRow,
} from "./askLatency.ts";
import type { KanbanOwnerAsk } from "@t3tools/contracts";

const row = (patch: Partial<AskTimingRow> = {}): AskTimingRow => ({
  boardId: "board-robob",
  cardId: "c1",
  askId: "q1",
  createdAt: "2026-11-13T00:00:00.000Z",
  closedAt: "2026-11-13T02:00:00.000Z",
  answeredAt: "2026-11-13T02:00:00.000Z",
  blocking: true,
  kind: "approve",
  notifiedAt: "2026-11-13T00:10:00.000Z",
  firstSeenAt: "2026-11-13T01:00:00.000Z",
  ...patch,
});
const done = "2026-11-14T00:00:00.000Z";
describe("ask latency", () => {
  it("splits each ask once and groups by blocking and kind", () => {
    const r = askLatencyRollup(
      [
        row(),
        row({ askId: "q2", blocking: false, kind: "input", firstSeenAt: null }),
        row({ askId: "q3", notifiedAt: null, firstSeenAt: "2026-11-13T01:30:00.000Z" }),
      ],
      "2026-11-13",
      done,
    );
    expect(r.sentToSeen).toMatchObject({
      count: 1,
      p50Ms: 50 * 60_000,
      p95Ms: 50 * 60_000,
      maxMs: 50 * 60_000,
    });
    expect(r.seenToAnswered).toMatchObject({
      count: 2,
      p50Ms: 30 * 60_000,
      p95Ms: 60 * 60_000,
      maxMs: 60 * 60_000,
    });
    expect(r.createdToAnswered).toMatchObject({ count: 3, p50Ms: 120 * 60_000 });
    expect(r.answeredWithoutSeen).toBe(1);
    expect(r.byBlocking.false?.answeredWithoutSeen).toBe(1);
    expect(r.byKind.approve?.createdToAnswered.count).toBe(2);
  });
  it("counts asks still open at day end even when they were answered later", () => {
    const r = askLatencyRollup(
      [
        row({ closedAt: null, answeredAt: null }),
        row({ closedAt: done, answeredAt: done }),
        row({ closedAt: null, answeredAt: null, createdAt: "2026-11-13T23:30:00.000Z" }),
        row({ closedAt: "2026-11-13T23:59:00.000Z", answeredAt: null }),
      ],
      "2026-11-13",
      done,
    );
    expect(r.openOver1hAtDayEnd).toBe(2);
    expect(r.createdToAnswered.count).toBe(0);
    expect(
      askLatencyRollup([], "2026-11-13", "2026-11-13T12:00:00.000Z").openOver1hAtDayEnd,
    ).toBeNull();
  });
  it("handles old, unnotified and invalid timing without fabricating split durations", () => {
    const r = askLatencyRollup(
      [
        row({
          createdAt: "2026-11-12T23:00:00.000Z",
          firstSeenAt: null,
          notifiedAt: null,
          kind: "custom private words",
        }),
        row({ firstSeenAt: "2026-11-13T03:00:00.000Z" }),
        row({ notifiedAt: "2026-11-13T01:30:00.000Z" }),
      ],
      "2026-11-13",
      done,
    );
    expect(r.createdToAnswered.count).toBe(3);
    expect(r.sentToSeen.count).toBe(0);
    expect(r.answeredWithoutSeen).toBe(2);
    expect(r.byKind.unknown?.createdToAnswered.count).toBe(1);
    expect(JSON.stringify(r)).not.toContain("private");
  });
  it("keeps the first receipt per surface and emits only metadata", () => {
    const ask: KanbanOwnerAsk = {
      id: "q1",
      at: row().createdAt,
      text: "private question",
      blocking: true,
      by: { _tag: "owner" },
      seq: null,
      closedAt: null,
      title: "private title",
      kind: "private kind",
      options: [{ id: "o1", label: "private option" }],
      batchKey: "private batch",
      timing: { openAsksAtCreation: 4, openNoticesAtCreation: 2 },
    };
    const web = markAskTiming(ask, "seen", "web", "2026-11-13T01:00:00.000Z");
    expect(markAskTiming(web, "seen", "web", "2026-11-13T01:01:00.000Z")).toBe(web);
    const mobile = markAskTiming(web, "seen", "mobile", "2026-11-13T01:30:00.000Z");
    const props = askTimingProps(mobile);
    expect(props).toMatchObject({
      askId: "q1",
      askKind: "pick",
      hasBatchKey: true,
      openAsksAtCreation: 4,
      openNoticesAtCreation: 2,
      firstSeenAt: "2026-11-13T01:00:00.000Z",
      firstSeenBySurface: { web: "2026-11-13T01:00:00.000Z", mobile: "2026-11-13T01:30:00.000Z" },
    });
    expect(JSON.stringify(props)).not.toContain("private");
    expect(askTimingProps({ ...ask, timing: undefined })).not.toHaveProperty(
      "openNoticesAtCreation",
    );
    expect(
      markAskTiming({ ...mobile, closedAt: done }, "seen", "desktop", done).timing?.firstSeen
        ?.desktop,
    ).toBeUndefined();
  });
});
