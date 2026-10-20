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
