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

import { at, item, missionId, ownerApp, seed } from "../asks/AsksService.testkit.ts";
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
