import { describe, expect, it } from "vite-plus/test";
import { AnalyticsIngestInput, KANBAN_WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  createAnalyticsCollector,
  sanitizeAnalyticsEvent,
  type ClientAnalyticsEvent,
  analyticsForLongTask,
  registerEnvironmentAnalytics,
  setActiveAnalyticsEnvironment,
} from "./analytics.ts";

const decodeIngest = Schema.decodeUnknownSync(AnalyticsIngestInput);

function fixture(surface: "web" | "desktop" | "mobile" = "desktop") {
  let time = Date.parse("2026-11-14T12:00:00.000Z");
  const events: ClientAnalyticsEvent[] = [];
  const collector = createAnalyticsCollector({
    surface,
    now: () => time,
    send: async (batch) => {
      events.push(...batch);
    },
  });
  collector.setRoute({ route: "board", boardId: "private-board" });
  return {
    collector,
    events,
    at: (ms: number) => {
      time = Date.parse("2026-11-14T12:00:00.000Z") + ms;
    },
    task: (duration: number, start = time) =>
      collector.recordLongTask({ duration, startedAt: start }),
    now: () => time,
  };
}
const ofKind = (events: ClientAnalyticsEvent[], kind: string) =>
  events.filter((event) => event.kind === `performance.${kind}`);

describe("long task analytics", () => {
  it("summarizes every task once per minute and route, even after the sample cap", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 100; i++) f.task(301 + i);
      f.task(300);
      f.task(50);
      f.at(30_000);
      f.collector.setRoute({ route: "needs-owner" });
      f.task(500);
      await f.collector.flush();
      expect(ofKind(f.events, "long-task")).toHaveLength(20);
      expect(ofKind(f.events, "long-task-summary")).toHaveLength(0);
      f.at(60_000);
      await f.collector.flush();
      const summaries = ofKind(f.events, "long-task-summary");
      expect(summaries).toHaveLength(2);
      expect(summaries[0]).toMatchObject({
        route: "board",
        props: { count: 102, totalMs: 35_400, maxMs: 400, wallTimeMs: 30_000 },
      });
      expect(summaries[0]!.props!.p95Ms).toBeGreaterThanOrEqual(394);
      expect(summaries[0]!.props!.p95Ms).toBeLessThanOrEqual(400);
      expect(summaries[1]).toMatchObject({
        route: "needs-owner",
        props: { count: 1, totalMs: 500, maxMs: 500, wallTimeMs: 30_000 },
      });
      f.task(501);
      await f.collector.flush();
      expect(ofKind(f.events, "long-task")).toHaveLength(20);
      expect(ofKind(f.events, "long-task-summary")).toHaveLength(2);
    } finally {
      f.collector.dispose();
    }
  });

  it("uses the context and 1s subscription / 2s action windows at task start, not observer delivery", async () => {
    const f = fixture();
    try {
      f.collector.trackLongTaskView({
        screen: "board",
        visibleCardCount: 42,
        visibleThreadCount: 3,
      });
      f.collector.record("owner.action", { props: { method: KANBAN_WS_METHODS.cardPatch } });
      f.at(1000);
      f.collector.receivedRpc("orchestration.subscribeThread", {}, 800, undefined, true);
      f.collector.receivedRpc("orchestration.subscribeShell", {}, 500, undefined, true);
      f.collector.receivedRpc("orchestration.subscribeThread", {}, 200, undefined, true);
      f.collector.receivedRpc("orchestration.subscribeThread", {}, 0, "RpcClientError", true);
      f.at(2000);
      const startedAt = f.now();
      f.at(2100);
      f.collector.setRoute({ route: "thread", threadId: "private-thread" });
      f.collector.receivedRpc("orchestration.subscribeShell", {}, 99_999, undefined, true);
      f.at(2600);
      f.task(600, startedAt);
      await f.collector.flush();
      expect(ofKind(f.events, "long-task")[0]).toMatchObject({
        route: "board",
        props: {
          screen: "board",
          visibleCardCount: 42,
          visibleThreadCount: 3,
          subscriptionBytes: 1500,
          subscriptionMessages: 3,
          method: "orchestration.subscribeThread",
          ownerAction: KANBAN_WS_METHODS.cardPatch,
        },
      });
      f.at(4001);
      f.task(400);
      await f.collector.flush();
      const props = ofKind(f.events, "long-task")[1]!.props!;
      expect(props.subscriptionBytes).toBe(0);
      expect(props.subscriptionMessages).toBe(0);
      expect(props.ownerAction).toBeUndefined();
      expect(props.method).toBeUndefined();
    } finally {
      f.collector.dispose();
    }
  });

  it.each(["web", "desktop", "mobile"] as const)(
    "keeps content out of %s samples and summaries",
    async (surface) => {
      const f = fixture(surface);
      try {
        f.collector.setRoute({
          route: "board",
          cardId: "secret-content",
          props: { key: "secret-content", poolKey: "secret-content" },
        });
        f.collector.trackLongTaskView({ screen: "secret-content", visibleCardCount: 5 });
        f.collector.record("owner.action", {
          props: { method: "secret-content", key: "secret-content" },
        });
        f.collector.recordLongTask({
          duration: 500,
          startedAt: f.now(),
          attribution: [{ containerType: "iframe", containerName: "secret-content" }],
        });
        f.at(60_000);
        await f.collector.flush();
        const events = f.events.filter((event) => event.kind.startsWith("performance.long-task"));
        expect(events).toHaveLength(2);
        expect(() => decodeIngest({ events })).not.toThrow();
        expect(JSON.stringify(events)).not.toContain("secret-content");
        expect(events[0]).toMatchObject({
          props: {
            containerType: "iframe",
            containerName: "redacted",
            screen: "other",
            ownerAction: "owner.action",
          },
        });
        for (const event of events) {
          expect(event.cardId).toBeUndefined();
          expect(event.boardId).toBeUndefined();
          expect(event.threadId).toBeUndefined();
        }
        expect(
          sanitizeAnalyticsEvent({
            ...events[0],
            cardId: "secret-content",
            props: {
              key: "secret-content",
              containerName: "secret-content",
              screen: "secret-content",
              ownerAction: "secret-content",
              histogram: [[0, "secret-content"]],
            },
          })!.props,
        ).toBeUndefined();
      } finally {
        f.collector.dispose();
      }
    },
  );

  it("flushes partial windows on background and excludes background time", async () => {
    const f = fixture();
    try {
      f.task(500);
      f.at(10_000);
      await f.collector.background("background");
      f.at(120_000);
      f.collector.foreground();
      f.task(400);
      f.at(130_000);
      await f.collector.background("close");
      expect(ofKind(f.events, "long-task-summary").map((event) => event.props!.wallTimeMs)).toEqual(
        [10_000, 10_000],
      );
    } finally {
      f.collector.dispose();
    }
  });

  it("keeps measuring when foreground returns before a background flush finishes", async () => {
    const f = fixture();
    try {
      f.task(500);
      f.at(1000);
      const background = f.collector.background("background");
      f.at(2000);
      f.collector.foreground();
      await background;
      f.task(400);
      f.at(60_000);
      await f.collector.flush();
      const summaries = ofKind(f.events, "long-task-summary");
      expect(summaries.reduce((n, event) => n + event.props!.count!, 0)).toBe(2);
      expect(summaries.reduce((n, event) => n + event.props!.wallTimeMs!, 0)).toBe(59_000);
    } finally {
      f.collector.dispose();
    }
  });

  it("caps delayed samples by task minute rather than callback minute", async () => {
    const f = fixture();
    try {
      f.at(59_900);
      const previousMinute = f.now();
      f.at(46 * 60_000);
      for (let i = 0; i < 30; i++) f.task(400, previousMinute);
      f.task(400);
      for (let i = 0; i < 30; i++) f.task(400, previousMinute);
      f.task(400);
      f.task(400);
      await f.collector.flush();
      const samples = ofKind(f.events, "long-task");
      expect(samples).toHaveLength(23);
      expect(
        samples.filter(
          (event) => event.ts === DateTime.formatIso(DateTime.makeUnsafe(previousMinute)),
        ),
      ).toHaveLength(20);
      expect(
        samples.filter((event) => event.ts === DateTime.formatIso(DateTime.makeUnsafe(f.now()))),
      ).toHaveLength(3);
      expect(ofKind(f.events, "long-task-summary")[0]!.props!.count).toBe(60);
    } finally {
      f.collector.dispose();
    }
  });

  it("does not emit unsupported long-task measurements without an observer", async () => {
    const f = fixture("mobile");
    try {
      f.at(60_000);
      await f.collector.flush();
      expect(ofKind(f.events, "long-task-summary")).toEqual([]);
    } finally {
      f.collector.dispose();
    }
  });

  it.each([false, true])("excludes hidden routes (previously hidden=%s)", async (wasHidden) => {
    const f = fixture();
    try {
      f.collector.enableLongTasks();
      if (wasHidden) await f.collector.background("background");
      f.collector.setRoute({ route: "thread" }, false);
      f.at(1000);
      f.task(500);
      f.at(60_000);
      await f.collector.flush();
      expect(ofKind(f.events, "long-task")).toHaveLength(0);
      expect(ofKind(f.events, "long-task-summary")).toHaveLength(0);
      f.collector.foreground();
      f.task(500);
      f.at(120_000);
      await f.collector.flush();
      expect(ofKind(f.events, "long-task-summary")[0]).toMatchObject({
        props: { count: 1, wallTimeMs: 60_000 },
      });
    } finally {
      f.collector.dispose();
    }
  });

  it.each([false, true])(
    "keeps the task's environment across a switch (destination visited=%s)",
    async (visited) => {
      const a = fixture(),
        b = fixture();
      const stopA = registerEnvironmentAnalytics("long-task-a", a.collector);
      const stopB = registerEnvironmentAnalytics("long-task-b", b.collector);
      try {
        if (visited) b.collector.endRoute();
        setActiveAnalyticsEnvironment("long-task-a", a.now());
        a.at(500);
        const startedAt = a.now();
        a.at(1000);
        b.at(1000);
        a.collector.endRoute();
        setActiveAnalyticsEnvironment("long-task-b", b.now());
        b.collector.setRoute({ route: "thread" });
        a.at(1500);
        b.at(1500);
        analyticsForLongTask(startedAt)?.recordLongTask({ duration: 1000, startedAt });
        a.at(60_000);
        b.at(60_000);
        await Promise.all([a.collector.flush(), b.collector.flush()]);
        expect(ofKind(a.events, "long-task")).toHaveLength(1);
        expect(ofKind(b.events, "long-task")).toHaveLength(0);
        expect(ofKind(a.events, "long-task-summary")[0]).toMatchObject({
          route: "board",
          props: { count: 1, totalMs: 1000 },
        });
      } finally {
        setActiveAnalyticsEnvironment(null);
        stopA();
        stopB();
      }
    },
  );

  it.each([
    { name: "same minute", start: 1000, delivered: 1600, background: false },
    { name: "next minute", start: 59_900, delivered: 60_500, background: false },
    { name: "after background", start: 1000, delivered: 1600, background: true },
    { name: "midnight", start: 43_199_900, delivered: 43_200_500, background: false },
  ])("attributes a delayed task to its start ($name)", async ({ start, delivered, background }) => {
    const f = fixture();
    try {
      f.collector.enableLongTasks();
      f.at(start);
      const startedAt = f.now();
      f.at(delivered);
      if (background) await f.collector.background("background");
      f.task(600, startedAt);
      f.at(Math.ceil((delivered + 1) / 60_000) * 60_000);
      await f.collector.flush();
      const sample = ofKind(f.events, "long-task")[0]!;
      expect(sample.ts).toBe(DateTime.formatIso(DateTime.makeUnsafe(startedAt)));
      const summaries = ofKind(f.events, "long-task-summary").filter((event) => event.props!.count);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.ts).toBe(
        DateTime.formatIso(DateTime.makeUnsafe(Math.floor(startedAt / 60_000) * 60_000)),
      );
      expect(summaries[0]!.props!.count).toBe(1);
      expect(summaries[0]!.props!.totalMs).toBe(600);
    } finally {
      f.collector.dispose();
    }
  });

  it("includes quiet foreground time when the host supports long tasks", async () => {
    const f = fixture();
    try {
      f.collector.enableLongTasks();
      f.at(60_000);
      await f.collector.flush();
      f.task(500);
      f.at(180_000);
      await f.collector.flush();
      await f.collector.background("close");
      const summaries = ofKind(f.events, "long-task-summary");
      expect(summaries.reduce((n, event) => n + event.props!.wallTimeMs!, 0)).toBe(180_000);
      expect(summaries.reduce((n, event) => n + event.props!.count!, 0)).toBe(1);
    } finally {
      f.collector.dispose();
    }
  });

  it.each([
    { duration: 100, samples: 0 },
    { duration: 300, samples: 0 },
    { duration: 301, samples: 51 },
    { duration: 522, samples: 51 },
  ])("bounds 37,766 tasks at $duration ms over eight hours", async ({ duration, samples }) => {
    const f = fixture();
    try {
      let index = 0;
      for (let minute = 0; minute < 480; minute++) {
        while (index < 37_766 && Math.floor((index * 480) / 37_766) === minute) {
          f.at(Math.floor((index * 28_800_000) / 37_766));
          f.task(duration);
          index++;
        }
        f.at((minute + 1) * 60_000);
        await f.collector.flush();
      }
      const tasks = ofKind(f.events, "long-task");
      expect(tasks).toHaveLength(samples);
      const summaries = ofKind(f.events, "long-task-summary");
      expect(summaries).toHaveLength(480);
      expect(summaries.reduce((n, event) => n + event.props!.count!, 0)).toBe(37_766);
      expect(summaries.reduce((n, event) => n + event.props!.totalMs!, 0)).toBe(37_766 * duration);
      expect(
        summaries.reduce(
          (n, event) => n + event.props!.histogram!.reduce((n, [, count]) => n + count, 0),
          0,
        ),
      ).toBe(37_766);
      expect(summaries.reduce((n, event) => n + event.props!.wallTimeMs!, 0)).toBe(28_800_000);
      expect(tasks.length + summaries.length).toBeLessThanOrEqual(600);
      expect(
        summaries.every(
          (event) => event.props!.maxMs === duration && event.props!.p95Ms === duration,
        ),
      ).toBe(true);
      const perMinute = new Map<string, number>();
      for (const task of tasks) {
        const minute = task.ts.slice(0, 16);
        perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
      }
      expect([...perMinute.values()].every((count) => count <= 20)).toBe(true);
    } finally {
      f.collector.dispose();
    }
  });

  it.each([
    { elapsed: 60_000, samples: 0 },
    { elapsed: 15 * 60_000 - 1, samples: 0 },
    { elapsed: 15 * 60_000, samples: 1 },
    { elapsed: 24 * 60 * 60_000, samples: 20 },
  ])(
    "refills the broader sample budget after $elapsed ms (samples=$samples)",
    async ({ elapsed, samples }) => {
      const f = fixture();
      try {
        for (let i = 0; i < 20; i++) f.task(522);
        await f.collector.background("background");
        f.at(elapsed);
        f.collector.foreground();
        for (let i = 0; i < 30; i++) f.task(522);
        await f.collector.background("close");
        expect(ofKind(f.events, "long-task")).toHaveLength(20 + samples);
        const summaries = ofKind(f.events, "long-task-summary");
        expect(summaries.reduce((n, event) => n + event.props!.count!, 0)).toBe(50);
        expect(summaries.reduce((n, event) => n + event.props!.totalMs!, 0)).toBe(50 * 522);
      } finally {
        f.collector.dispose();
      }
    },
  );
});
