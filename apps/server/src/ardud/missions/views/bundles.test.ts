import { assert, describe, it } from "@effect/vitest";
import {
  MissionId,
  STOCK_VIEW_TEMPLATES,
  type Approval,
  type ApprovalId,
  type ViewSectionDefinition,
  type ViewTemplateDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as AsksService from "../asks/AsksService.ts";
import {
  agent,
  at,
  failureCode,
  masterThread,
  missionId,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { ViewService } from "./ViewService.ts";
import { fresh } from "./views.testkit.ts";

const crwMerge: ViewTemplateDefinition = {
  key: "crw-merge",
  name: "Crw merge",
  backing: "approval",
  kicker: "Merge",
  title: "record.title",
  body: [{ _tag: "text", bind: "record.summary", style: "body", maxLines: 2 }],
  actions: ["approve", "reject", "discuss"],
  primary: "approve",
  match: { approvalKind: ["merge"], requestedBy: ["crw"] },
};

const reviewQueue: ViewSectionDefinition = {
  key: "review-queue",
  title: "Review queue",
  source: {
    _tag: "query",
    query: { kind: "work-item", where: { workKind: ["pr"] }, sort: "updated-desc", limit: 10 },
  },
  body: [
    {
      _tag: "table",
      columns: [
        { label: "PR", bind: "row.pullRequest", as: "link" },
        { label: "Stage", bind: "row.stage", as: "status" },
        { label: "Age", bind: "row.age", as: "age" },
      ],
    },
  ],
};

const laneSection: ViewSectionDefinition = {
  key: "api-lane",
  title: "API lane",
  source: {
    _tag: "query",
    query: {
      kind: "work-item",
      where: { laneId: "lane-api" as never },
      sort: "updated-desc",
      limit: 5,
    },
  },
  body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
};

const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({
  id: id as ApprovalId,
  missionId,
  kind: "release",
  title: "Release 1.4",
  detail: "",
  requestedBy: "crw",
  links: [],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: at,
  ...extra,
});

const eventKinds = (id: MissionId) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    return (yield* store.eventsSince(id, 0)).map((event) => event.kind);
  });

describe("view bundles", () => {
  it.effect("applies templates and sections as one change, one event, one budget step", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        yield* views.applyBundle(agent(masterThread), {
          missionId,
          templates: [{ definition: crwMerge }],
          sections: [
            { definition: reviewQueue, region: "main" },
            { definition: laneSection, region: "rail" },
          ],
          changeNote: "Crw review kit.",
        });
        const snapshot = yield* views.snapshot(missionId);
        assert.deepEqual(
          snapshot.templates.map((template) => template.definition.key),
          ["crw-merge"],
        );
        assert.deepEqual(snapshot.sections.map((section) => section.definition.key).toSorted(), [
          "api-lane",
          "review-queue",
        ]);
        const entries = snapshot.layout.layout.entries;
        assert.equal(entries.find((entry) => entry.key === "review-queue")?.region, "main");
        assert.equal(entries.find((entry) => entry.key === "api-lane")?.region, "rail");
        assert.equal(snapshot.changesToday, 1);
        const kinds = yield* eventKinds(missionId);
        assert.equal(kinds.filter((kind) => kind.startsWith("view.")).length, 1);
        assert.include(kinds, "view.bundle-applied");
      }),
    ),
  );

  it.effect("refuses the whole bundle when any part is wrong", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const error = yield* Effect.flip(
          views.applyBundle(ownerApp, {
            missionId,
            templates: [{ definition: crwMerge }],
            sections: [
              {
                definition: {
                  ...reviewQueue,
                  body: [{ _tag: "text", bind: "record.title", style: "body", maxLines: 2 }],
                },
              },
            ],
          }),
        );
        assert.equal(error.code, "invalid");
        assert.include(error.detail, "sections[0]");
        const snapshot = yield* views.snapshot(missionId);
        assert.equal(snapshot.templates.length, 0);
        assert.equal(snapshot.sections.length, 0);
        assert.equal(snapshot.revision, 0);
        assert.equal(
          yield* failureCode(
            views.applyBundle(ownerApp, { missionId, templates: [], sections: [] }),
          ),
          "invalid",
        );
      }),
    ),
  );

  it.effect("copies another mission's portable views; lane-bound ones stay home", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        yield* seedOther;
        const views = yield* ViewService;
        yield* views.applyBundle(ownerApp, {
          missionId,
          templates: [{ definition: crwMerge }],
          sections: [{ definition: reviewQueue }, { definition: laneSection }],
        });

        yield* views.applyBundle(ownerApp, {
          missionId: otherMissionId,
          templates: [],
          sections: [],
          copyFrom: { missionId },
        });
        const copied = yield* views.snapshot(otherMissionId);
        assert.deepEqual(
          copied.templates.map((template) => template.definition.key),
          ["crw-merge"],
        );
        assert.deepEqual(
          copied.sections.map((section) => section.definition.key),
          ["review-queue"],
        );
        assert.include(yield* eventKinds(otherMissionId), "view.bundle-applied");

        // Naming a lane-bound section, or a key that isn't there, is refused.
        const named = yield* Effect.flip(
          views.applyBundle(ownerApp, {
            missionId: MissionId.make(otherMissionId),
            templates: [],
            sections: [],
            copyFrom: { missionId, sectionKeys: ["api-lane", "nope"] },
          }),
        );
        assert.include(named.detail, "api-lane");
        assert.include(named.detail, "nope");
        assert.equal(
          yield* failureCode(
            views.applyBundle(ownerApp, {
              missionId,
              templates: [],
              sections: [],
              copyFrom: { missionId },
            }),
          ),
          "invalid",
        );
      }),
    ),
  );
});

describe("stock templates", () => {
  it.effect("release approvals and named UI reviews draw from the stock templates", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const release = yield* views.resolveTemplate(missionId, {
          kind: "approval",
          record: approval("a-1"),
        });
        assert.equal(release.source, "match");
        assert.equal(release.id, "builtin:release");
        const merge = yield* views.resolveTemplate(missionId, {
          kind: "approval",
          record: approval("a-2", { kind: "merge" }),
        });
        assert.equal(merge.source, "builtin");

        // A mission's own template with the same key takes over.
        const stock = STOCK_VIEW_TEMPLATES.find((entry) => entry.definition.key === "release")!;
        const own = yield* views.defineTemplate(ownerApp, {
          missionId,
          definition: { ...stock.definition, kicker: "Ship" },
        });
        const replaced = yield* views.resolveTemplate(missionId, {
          kind: "approval",
          record: approval("a-1"),
        });
        assert.equal(replaced.id, own.ref.id);
        assert.equal(replaced.definition.kicker, "Ship");
      }),
    ),
  );
});

describe("starter offers", () => {
  const offer = (version: number) =>
    Effect.gen(function* () {
      const asks = yield* AsksService.AsksService;
      return yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "layout",
          target: { kind: "view-layout", id: missionId },
          title: `Take the starter layout v${version}`,
          after: version,
          diffText: "Calls tab hidden",
          why: "The other missions run quieter without it.",
          evidence: [{ kind: "view-layout", id: missionId }],
        },
        agent(masterThread),
      );
    });

  it.effect("the master offers a newer starter; accepting it keeps the mission's sections", () =>
    fresh(
      Effect.gen(function* () {
        // Starter edits after the mission was created don't reach it on their own.
        yield* TestClock.setTime(Date.parse("2026-10-19T08:00:00.000Z"));
        yield* seed;
        const views = yield* ViewService;
        const asks = yield* AsksService.AsksService;
        yield* views.placeSection(ownerApp, { missionId, definition: reviewQueue });
        yield* views.editStarter(ownerApp, { ops: [{ _tag: "hide", key: "tab-calls" }] });

        const suggestion = yield* offer(2);
        assert.equal(suggestion.acceptor, "owner");
        const decided = yield* asks.decideSuggestion(
          { suggestionId: suggestion.id, action: "accept" },
          ownerApp,
        );
        assert.include(decided.outcome ?? "", "Applied");
        const layout = (yield* views.snapshot(missionId)).layout;
        assert.equal(layout.seededFrom, 2);
        assert.isTrue(layout.layout.entries.find((entry) => entry.key === "tab-calls")?.hidden);
        assert.isTrue(layout.layout.entries.some((entry) => entry.key === "review-queue"));
      }),
    ),
  );

  it.effect("an offer the starter moved past is not applied", () =>
    fresh(
      Effect.gen(function* () {
        // Starter edits after the mission was created don't reach it on their own.
        yield* TestClock.setTime(Date.parse("2026-10-19T08:00:00.000Z"));
        yield* seed;
        const views = yield* ViewService;
        const asks = yield* AsksService.AsksService;
        yield* views.editStarter(ownerApp, { ops: [{ _tag: "hide", key: "tab-calls" }] });
        const suggestion = yield* offer(2);
        yield* views.editStarter(ownerApp, { ops: [{ _tag: "show", key: "tab-calls" }] });
        const decided = yield* asks.decideSuggestion(
          { suggestionId: suggestion.id, action: "accept" },
          ownerApp,
        );
        assert.include(decided.outcome ?? "", "v3 now");
        assert.equal((yield* views.snapshot(missionId)).layout.seededFrom, 1);
      }),
    ),
  );
});
