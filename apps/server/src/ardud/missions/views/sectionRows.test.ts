import { assert, describe, it } from "@effect/vitest";
import {
  MISSIONS_VIEWS_WS_METHODS,
  type MissionViewsFeedItem,
  type PlaceViewSectionInput,
  type WorkItem,
  type WorkStage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { at, item, mission, missionId, ownerApp, seed } from "../asks/AsksService.testkit.ts";
import * as ScribeStore from "../scribe/ScribeStore.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { ViewService } from "./ViewService.ts";
import { fresh } from "./views.testkit.ts";
import { viewsWsHandlers } from "./ws.ts";

const work = (id: string, stage: WorkStage, kind: WorkItem["kind"], updatedAt: string) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    yield* store.commit({
      event: {
        missionId,
        kind: "work-item.updated",
        actor: { _tag: "system", component: "test" },
        provenance: { _tag: "system", component: "test" },
        summary: id,
        subject: { kind: "work-item", id },
      },
      upserts: [
        {
          _tag: "work-item",
          record: { ...item(id), title: `Deploy ${id}`, stage, kind, updatedAt },
        },
      ],
    });
  });

const releaseTrain: PlaceViewSectionInput = {
  missionId,
  definition: {
    key: "release-train",
    title: "Release train",
    source: {
      _tag: "query",
      query: {
        kind: "work-item",
        where: { workKind: ["deploy"], stage: ["merge", "deploy", "readback"] },
        sort: "updated-desc",
        limit: 2,
      },
    },
    body: [{ _tag: "list", title: "row.title", meta: ["row.stage", "row.age"], status: null }],
  },
  region: "rail",
};

const report = (kind: "daily" | "update", coversFrom: string, coversTo: string, text: string) =>
  Effect.gen(function* () {
    const scribe = yield* ScribeStore.ScribeStore;
    yield* scribe.saveReport({
      reportId: `${missionId}|${kind}|${coversTo}`,
      missionId,
      kind,
      coversFrom,
      coversTo,
      open: [],
      text,
      createdAt: coversTo,
    });
  });

const folded = {
  _tag: "collapsible",
  title: "row.title",
  meta: ["row.period", "row.size"],
  open: "first",
  children: [{ _tag: "markdown", bind: "row.text" }],
} as const;

const reportSection = (
  key: string,
  reportKind: ReadonlyArray<"daily" | "update">,
  limit: number,
): PlaceViewSectionInput => ({
  missionId,
  definition: {
    key,
    title: key,
    source: {
      _tag: "query",
      query: { kind: "report", where: { reportKind }, sort: "created-desc", limit },
    },
    body: [folded],
  },
});

const longUpdate = `### 2026-10-21 04:00 UTC\n\n${"Long body. ".repeat(2000)}`;

describe("report sections", () => {
  it.effect("lists reports newest first with title, period and size, never the text", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        yield* report(
          "daily",
          "2026-10-20T04:30:00.000Z",
          "2026-10-21T04:30:00.000Z",
          "# Crpko: daily summary, 21 Oct\n\nBottom line.",
        );
        for (const [from, to] of [
          ["2026-10-20T20:00:00.000Z", "2026-10-21T00:00:00.000Z"],
          ["2026-10-21T00:00:00.000Z", "2026-10-21T04:00:00.000Z"],
          ["2026-10-21T04:00:00.000Z", "2026-10-21T08:00:00.000Z"],
        ] as const) {
          yield* report("update", from, to, longUpdate);
        }
        const views = yield* ViewService;
        const daily = yield* views.placeSection(ownerApp, reportSection("daily", ["daily"], 1));
        const updates = yield* views.placeSection(
          ownerApp,
          reportSection("updates", ["update"], 2),
        );
        const snapshot = yield* views.snapshot(missionId);
        const dailyRows = snapshot.sectionData?.find((data) => data.sectionId === daily.ref.id);
        assert.equal(dailyRows?.total, 1);
        assert.deepEqual(dailyRows?.rows[0]?.ref, {
          kind: "report",
          id: `${missionId}|daily|2026-10-21T04:30:00.000Z`,
          label: "Crpko: daily summary, 21 Oct",
        });
        assert.deepEqual(dailyRows?.rows[0]?.value, {
          title: "Crpko: daily summary, 21 Oct",
          period: "20 Oct 04:30 – 21 Oct 04:30 UTC",
          size: "44 chars",
        });
        const updateRows = snapshot.sectionData?.find((data) => data.sectionId === updates.ref.id);
        assert.equal(updateRows?.total, 3);
        assert.deepEqual(
          updateRows?.rows.map((row) => row.value.period),
          ["21 Oct 04:00–08:00 UTC", "21 Oct 00:00–04:00 UTC"],
        );
        assert.equal(updateRows?.rows[0]?.value.size, "22k chars");
        assert.notInclude(JSON.stringify(snapshot.sectionData), "Long body.");

        const ref = updateRows?.rows[0]?.ref;
        assert.isDefined(ref);
        if (ref === undefined) return;
        const loaded = yield* views.longText({ missionId, ref, path: "text" });
        assert.equal(loaded.text, longUpdate);
        assert.equal(loaded.size, longUpdate.length);
        assert.isFalse(loaded.truncated);
        const wrongPath = yield* Effect.flip(views.longText({ missionId, ref, path: "title" }));
        assert.equal(wrongPath.code, "invalid");
        const missing = yield* Effect.flip(
          views.longText({ missionId, ref: { ...ref, id: "nope" }, path: "text" }),
        );
        assert.equal(missing.code, "not-found");
      }),
    ),
  );

  it.effect("labels periods in the mission's day zone and lists only current reports", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* MissionStore.MissionStore;
        yield* store.upsert(
          { _tag: "mission", record: { ...mission, reports: { dayBoundary: "Asia/Dubai" } } },
          {
            missionId,
            kind: "mission.updated",
            actor: { _tag: "system", component: "test" },
            provenance: { _tag: "system", component: "test" },
            summary: "day boundary",
            subject: null,
          },
        );
        // An old 04:30Z daily, then the Dubai-day daily that overlaps it.
        yield* report("daily", "2026-10-20T04:30:00.000Z", "2026-10-21T04:30:00.000Z", "# Old");
        yield* report("daily", "2026-10-20T20:00:00.000Z", "2026-10-21T20:00:00.000Z", "# Wed");
        yield* report("update", "2026-10-21T04:00:00.000Z", "2026-10-21T08:00:00.000Z", "# Up");
        const views = yield* ViewService;
        const daily = yield* views.placeSection(ownerApp, reportSection("daily", ["daily"], 5));
        const updates = yield* views.placeSection(
          ownerApp,
          reportSection("updates", ["update"], 5),
        );
        const snapshot = yield* views.snapshot(missionId);
        const dailyRows = snapshot.sectionData?.find((data) => data.sectionId === daily.ref.id);
        assert.equal(dailyRows?.total, 1);
        assert.deepEqual(
          dailyRows?.rows.map((row) => [row.value.title, row.value.period]),
          [["Wed", "Wed 21 Oct (Dubai day)"]],
        );
        const updateRows = snapshot.sectionData?.find((data) => data.sectionId === updates.ref.id);
        assert.equal(updateRows?.rows[0]?.value.period, "21 Oct 08:00–12:00 Dubai");
      }),
    ),
  );

  it.effect("refuses long text outside a collapsible body and report filters elsewhere", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const base = reportSection("bad", ["update"], 8).definition;
        const preview = yield* views.preview({
          missionId,
          definition: {
            _tag: "section",
            definition: {
              ...base,
              body: [
                { _tag: "list", title: "row.text", meta: [], status: null },
                { ...folded, title: null },
                { _tag: "markdown", bind: "row.text" },
                {
                  ...folded,
                  children: [{ _tag: "list", title: "row.title", meta: [], status: null }],
                },
              ],
            },
          },
        });
        assert.isFalse(preview.ok);
        assert.deepEqual(
          preview.issues.map((issue) => `${issue.path} ${issue.code}`),
          [
            "body[0].title binding-kind",
            "body[1].title shape",
            "body[2].bind bad-binding",
            "body[3].children[0] node-not-allowed",
          ],
        );
        const misplaced = yield* views.preview({
          missionId,
          definition: {
            _tag: "section",
            definition: {
              ...base,
              source: {
                _tag: "query",
                query: {
                  kind: "work-item",
                  where: { reportKind: ["daily"] },
                  sort: "updated-desc",
                  limit: 5,
                },
              },
              body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
            },
          },
        });
        assert.deepEqual(
          misplaced.issues.map((issue) => issue.path),
          ["source.query.where.reportKind"],
        );
        const good = yield* views.preview({
          missionId,
          definition: { _tag: "section", definition: base },
        });
        assert.isTrue(good.ok);
      }),
    ),
  );

  it.effect("a saved report resends the snapshot with the new row", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const placed = yield* views.placeSection(ownerApp, reportSection("updates", ["update"], 8));
        const app = yield* viewsWsHandlers({
          surface: "web",
          session: {
            sessionId: "session-app",
            subject: "one-time-token",
            origin: { _tag: "owner", source: "cli" },
          },
        });
        const items = yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(
              app[MISSIONS_VIEWS_WS_METHODS.subscribe]({ missionId }),
            );
            const seen: Array<MissionViewsFeedItem> = [...(yield* pull)];
            yield* report(
              "update",
              "2026-10-21T00:00:00.000Z",
              "2026-10-21T04:00:00.000Z",
              longUpdate,
            );
            while (seen.length < 2) seen.push(...(yield* pull));
            return seen;
          }),
        );
        const last = items[1];
        const rows =
          last?._tag === "snapshot"
            ? last.snapshot.sectionData?.find((data) => data.sectionId === placed.ref.id)?.rows
            : undefined;
        assert.equal(rows?.length, 1);
        assert.equal(rows?.[0]?.value.title, "2026-10-21 04:00 UTC");
      }),
    ),
  );

  it.effect("a new day boundary relabels the report rows of an open view", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        yield* report("daily", "2026-10-20T20:00:00.000Z", "2026-10-21T20:00:00.000Z", "# Wed");
        const views = yield* ViewService;
        const store = yield* MissionStore.MissionStore;
        const placed = yield* views.placeSection(ownerApp, reportSection("daily", ["daily"], 5));
        const app = yield* viewsWsHandlers({
          surface: "web",
          session: {
            sessionId: "session-app",
            subject: "one-time-token",
            origin: { _tag: "owner", source: "cli" },
          },
        });
        const periodOf = (item: MissionViewsFeedItem | undefined) =>
          item?._tag === "snapshot"
            ? item.snapshot.sectionData?.find((data) => data.sectionId === placed.ref.id)?.rows[0]
                ?.value.period
            : undefined;
        const items = yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(
              app[MISSIONS_VIEWS_WS_METHODS.subscribe]({ missionId }),
            );
            const seen: Array<MissionViewsFeedItem> = [...(yield* pull)];
            yield* store.upsert(
              { _tag: "mission", record: { ...mission, reports: { dayBoundary: "Asia/Dubai" } } },
              {
                missionId,
                kind: "mission.updated",
                actor: { _tag: "system", component: "test" },
                provenance: { _tag: "system", component: "test" },
                summary: "day boundary",
                subject: null,
              },
            );
            while (seen.length < 2) seen.push(...(yield* pull));
            return seen;
          }),
        );
        assert.equal(periodOf(items[0]), "20 Oct 20:00 – 21 Oct 20:00 UTC");
        assert.equal(periodOf(items[1]), "Wed 21 Oct (Dubai day)");
      }),
    ),
  );
});

describe("section rows", () => {
  it.effect("the server runs section queries and sends only the bound fields", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        yield* work("wi-a", "deploy", "deploy", "2026-10-17T09:00:00.000Z");
        yield* work("wi-b", "merge", "deploy", "2026-10-17T11:00:00.000Z");
        yield* work("wi-c", "readback", "deploy", "2026-10-17T10:00:00.000Z");
        yield* work("wi-d", "deploy", "ticket", "2026-10-17T12:00:00.000Z");
        yield* work("wi-e", "done", "deploy", "2026-10-17T13:00:00.000Z");
        const views = yield* ViewService;
        const placed = yield* views.placeSection(ownerApp, releaseTrain);
        yield* views.placeSection(ownerApp, {
          missionId,
          definition: {
            key: "review-queue",
            title: "Review queue",
            source: {
              _tag: "query",
              query: {
                kind: "work-item",
                where: { stage: ["pr"] },
                sort: "created-desc",
                limit: 10,
              },
            },
            body: [
              {
                _tag: "table",
                columns: [
                  { label: "Item", bind: "row.title", as: "text" },
                  { label: "Held by", bind: "row.heldBy", as: "person" },
                ],
              },
            ],
          },
        });

        const snapshot = yield* views.snapshot(missionId);
        const train = snapshot.sectionData?.find((data) => data.sectionId === placed.ref.id);
        assert.equal(train?.total, 3);
        assert.deepEqual(
          train?.rows.map((row) => row.ref.id),
          ["wi-b", "wi-c"],
        );
        // Bound paths only: title, stage and age's source.
        assert.deepEqual(Object.keys(train?.rows[0]?.value ?? {}).toSorted(), [
          "createdAt",
          "stage",
          "title",
        ]);
        assert.equal(train?.rows[0]?.value.createdAt, at);

        const queue = snapshot.sectionData?.find((data) => data.sectionId !== placed.ref.id);
        assert.equal(queue?.total, 2);
        assert.deepEqual(Object.keys(queue?.rows[0]?.value ?? {}).toSorted(), ["heldBy", "title"]);
      }),
    ),
  );

  it.effect("a record commit that changes a section's rows resends the snapshot", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const placed = yield* views.placeSection(ownerApp, releaseTrain);
        const app = yield* viewsWsHandlers({
          surface: "web",
          session: {
            sessionId: "session-app",
            subject: "one-time-token",
            origin: { _tag: "owner", source: "cli" },
          },
        });
        const items = yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(
              app[MISSIONS_VIEWS_WS_METHODS.subscribe]({ missionId }),
            );
            const seen: Array<MissionViewsFeedItem> = [...(yield* pull)];
            // A commit that touches no queried row keeps the feed quiet...
            yield* work("wi-x", "pr", "ticket", "2026-10-17T09:00:00.000Z");
            // ...one that does sends the new rows.
            yield* work("wi-y", "deploy", "deploy", "2026-10-17T09:00:00.000Z");
            while (seen.length < 2) seen.push(...(yield* pull));
            return seen;
          }),
        );
        assert.deepEqual(
          items.map((entry) => entry._tag),
          ["snapshot", "snapshot"],
        );
        const last = items[1];
        const rows =
          last?._tag === "snapshot"
            ? last.snapshot.sectionData?.find((data) => data.sectionId === placed.ref.id)?.rows
            : undefined;
        assert.deepEqual(
          rows?.map((row) => row.ref.id),
          ["wi-y"],
        );
      }),
    ),
  );
});

describe("block nodes", () => {
  const deploys = (body: PlaceViewSectionInput["definition"]["body"]) => ({
    ...releaseTrain.definition,
    body,
  });

  it.effect("checks stat, chart, timeline, callout and code binds", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const section = (body: PlaceViewSectionInput["definition"]["body"]) =>
          views.preview({ missionId, definition: { _tag: "section", definition: deploys(body) } });
        const good = yield* section([
          { _tag: "stat", value: "row.count", label: "Deploys" },
          {
            _tag: "timeline",
            at: "row.updatedAt",
            title: "row.title",
            meta: ["row.stage"],
            tone: "row.stage",
          },
          { _tag: "callout", tone: "warn", text: null, label: "Freeze after 18:00" },
          {
            _tag: "collapsible",
            title: "row.title",
            meta: [],
            open: "first",
            children: [{ _tag: "code", bind: "row.title", label: "Title" }],
          },
        ]);
        assert.deepEqual(good.issues, []);
        const notes = yield* views.preview({
          missionId,
          definition: {
            _tag: "section",
            definition: {
              key: "confidence",
              title: "Confidence",
              source: {
                _tag: "query",
                query: { kind: "note", sort: "created-desc", limit: 20 },
              },
              body: [
                { _tag: "chart", type: "line", x: "row.createdAt", y: "row.confidence" },
                {
                  _tag: "stat",
                  value: "row.confidence",
                  label: "Confidence",
                  tone: "row.severity",
                },
              ],
            },
          },
        });
        assert.deepEqual(notes.issues, []);
        const bad = yield* section([
          { _tag: "stat", value: "row.total", label: "Deploys", tone: "row.stage" },
          { _tag: "chart", type: "line", x: "row.heldBy", y: "row.title" },
          { _tag: "timeline", at: "row.title", title: "row.title", meta: [] },
          { _tag: "callout", tone: "info", text: null },
          { _tag: "code", bind: "row.title" },
          {
            _tag: "collapsible",
            title: "row.title",
            meta: [],
            open: "none",
            children: [{ _tag: "timeline", at: "row.updatedAt", title: "row.title", meta: [] }],
          },
        ]);
        assert.deepEqual(
          bad.issues.map((issue) => `${issue.path} ${issue.code}`),
          [
            "body[0] shape",
            "body[1].x binding-kind",
            "body[1].y binding-kind",
            "body[2].at binding-kind",
            "body[3].text shape",
            "body[4].bind bad-binding",
            "body[5].children[0] node-not-allowed",
          ],
        );
        const card = yield* views.preview({
          missionId,
          definition: {
            _tag: "template",
            definition: {
              key: "deploy-card",
              name: "Deploy card",
              backing: "approval",
              title: "record.title",
              body: [
                { _tag: "stat", value: "record.title", label: "Status", tone: "record.status" },
                { _tag: "timeline", at: "record.createdAt", title: "record.title", meta: [] },
              ],
              actions: ["approve"],
            },
          },
        });
        assert.deepEqual(
          card.issues.map((issue) => `${issue.path} ${issue.code}`),
          ["body[1] node-not-allowed"],
        );
      }),
    ),
  );

  it.effect("sends the fields a timeline binds", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        yield* work("wi-a", "deploy", "deploy", "2026-10-17T09:00:00.000Z");
        const views = yield* ViewService;
        const placed = yield* views.placeSection(ownerApp, {
          missionId,
          definition: deploys([
            {
              _tag: "timeline",
              at: "row.updatedAt",
              title: "row.title",
              meta: [],
              tone: "row.stage",
            },
          ]),
        });
        const snapshot = yield* views.snapshot(missionId);
        const rows = snapshot.sectionData?.find((data) => data.sectionId === placed.ref.id)?.rows;
        assert.deepEqual(Object.keys(rows?.[0]?.value ?? {}).toSorted(), [
          "stage",
          "title",
          "updatedAt",
        ]);
      }),
    ),
  );
});
