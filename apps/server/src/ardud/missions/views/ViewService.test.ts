import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_STARTER_LAYOUT,
  MissionId,
  RoleId,
  ViewSectionId,
  ViewTemplateId,
  builtinViewTemplateId,
  type Approval,
  type ApprovalId,
  type Ask,
  type AskId,
  type ViewLayoutOp,
  type ViewTemplateDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  agent,
  at,
  failureCode,
  harness,
  masterThread,
  missionId,
  otherMasterThread,
  ownerApp,
  seed,
  seedOther,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { ViewsLive } from "./layer.ts";
import { ViewService } from "./ViewService.ts";

/** A fresh database per test: each one seeds mission m-1. */
const fresh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(ViewsLive.pipe(Layer.provideMerge(harness().layer))));

const crwMerge: ViewTemplateDefinition = {
  key: "crw-merge",
  name: "Crw merge",
  backing: "approval",
  kicker: "Merge",
  title: "record.title",
  body: [
    { _tag: "text", bind: "record.summary", style: "body", maxLines: 2 },
    { _tag: "flags", bind: "record.flags" },
    { _tag: "links", bind: "record.links" },
  ],
  actions: ["approve", "reject", "discuss"],
  primary: "approve",
  match: { approvalKind: ["merge"], requestedBy: ["crw"] },
};

const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({
  id: id as ApprovalId,
  missionId,
  kind: "merge",
  title: "Merge #12",
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

const ask = (id: string): Ask => ({
  id: id as AskId,
  missionId,
  subMissionId: null,
  askedBy: { _tag: "role", roleId: RoleId.make("role-master") },
  question: "Ship today?",
  context: "",
  options: [],
  recommendation: null,
  blocks: [],
  costOfWaiting: "",
  urgency: "normal",
  status: "open",
  answer: null,
  createdAt: at,
  updatedAt: at,
});

const openAsk = (id: string) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    yield* store.commit({
      event: {
        missionId,
        kind: "ask.opened",
        actor: { _tag: "system", component: "test" },
        provenance: { _tag: "system", component: "test" },
        summary: "ask",
        subject: { kind: "ask", id },
      },
      upserts: [{ _tag: "ask", record: ask(id) }],
    });
  });

const ops = (...list: ReadonlyArray<ViewLayoutOp>) => ({ missionId, ops: list });

describe("ViewService", () => {
  it.effect("refuses invalid definitions with every issue and stores nothing", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const bad = {
          ...crwMerge,
          body: [
            { _tag: "gallery", bind: "record.assets" },
            { _tag: "text", bind: "record.nope", style: "body", maxLines: 2 },
            { _tag: "flags", bind: "record.title" },
            { _tag: "choice" },
          ],
          actions: ["approve", "answer"],
        } as unknown as ViewTemplateDefinition;
        const error = yield* Effect.flip(
          views.defineTemplate(ownerApp, { missionId, definition: bad }),
        );
        assert.equal(error.code, "invalid");
        for (const code of [
          "unknown-node",
          "bad-binding",
          "binding-kind",
          "node-not-allowed",
          "action-not-allowed",
        ]) {
          assert.include(error.detail, code);
        }
        const snapshot = yield* views.snapshot(missionId);
        assert.equal(snapshot.templates.length, 0);
        assert.equal(snapshot.revision, 0);

        const preview = yield* views.preview({
          missionId,
          definition: { _tag: "template", definition: bad },
        });
        assert.isFalse(preview.ok);
        assert.isAbove(preview.issues.length, 3);
        const good = yield* views.preview({
          missionId,
          definition: { _tag: "template", definition: crwMerge },
        });
        assert.isTrue(good.ok);
        assert.equal((yield* views.snapshot(missionId)).templates.length, 0);
      }),
    ),
  );

  it.effect("versions every change, fences stale writes and restores earlier versions", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const created = yield* views.defineTemplate(ownerApp, { missionId, definition: crwMerge });
        const id = ViewTemplateId.make(created.ref.id);
        yield* views.defineTemplate(ownerApp, {
          missionId,
          templateId: id,
          definition: { ...crwMerge, kicker: "Ship it" },
          expectedVersion: 1,
        });
        assert.equal(
          yield* failureCode(
            views.defineTemplate(ownerApp, {
              missionId,
              templateId: id,
              definition: crwMerge,
              expectedVersion: 1,
            }),
          ),
          "conflict",
        );
        yield* views.remove(ownerApp, { missionId, ref: { kind: "view-template", id } });
        let snapshot = yield* views.snapshot(missionId);
        assert.equal(snapshot.templates[0]?.status, "removed");
        assert.equal(snapshot.templates[0]?.version, 3);

        yield* views.restore(ownerApp, {
          missionId,
          ref: { kind: "view-template", id },
          toVersion: 1,
        });
        snapshot = yield* views.snapshot(missionId);
        const restored = snapshot.templates[0];
        assert.equal(restored?.status, "active");
        assert.equal(restored?.version, 4);
        assert.equal(restored?.definition.kicker, "Merge");

        const history = yield* views.history({ missionId, target: { _tag: "template", id } });
        assert.deepEqual(
          history.entries.map((entry) => [entry.version, entry.status]),
          [
            [4, "active"],
            [3, "removed"],
            [2, "active"],
            [1, "active"],
          ],
        );
        const store = yield* MissionStore.MissionStore;
        const kinds = (yield* store.eventsSince(missionId, 0)).map((event) => event.kind);
        assert.includeMembers(kinds, [
          "view.template-defined",
          "view.template-updated",
          "view.template-removed",
          "view.template-restored",
        ]);
        assert.equal(snapshot.revision, 4);
        // Only the master's changes spend the daily budget.
        assert.equal(snapshot.changesToday, 0);
      }),
    ),
  );

  it.effect("resolves templates explicit, then most specific match, then built-in", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const backed = (record: Approval) => ({ kind: "approval" as const, record });
        const before = yield* views.resolveTemplate(missionId, backed(approval("a-1")));
        assert.equal(before.source, "builtin");
        assert.equal(before.id, builtinViewTemplateId("approval"));

        const crw = yield* views.defineTemplate(ownerApp, { missionId, definition: crwMerge });
        yield* views.defineTemplate(ownerApp, {
          missionId,
          definition: {
            ...crwMerge,
            key: "any-merge",
            name: "Any merge",
            match: { approvalKind: ["merge"] },
          },
        });
        const deploy = yield* views.defineTemplate(ownerApp, {
          missionId,
          definition: { ...crwMerge, key: "pinned", name: "Pinned", match: null },
        });

        const matched = yield* views.resolveTemplate(missionId, backed(approval("a-1")));
        assert.equal(matched.source, "match");
        assert.equal(matched.id, crw.ref.id);
        const other = yield* views.resolveTemplate(
          missionId,
          backed(approval("a-2", { requestedBy: "lane" })),
        );
        assert.equal(other.definition.key, "any-merge");
        const explicit = yield* views.resolveTemplate(missionId, {
          kind: "approval",
          record: { ...approval("a-3"), view: { templateId: deploy.ref.id } } as Approval,
        });
        assert.equal(explicit.source, "explicit");
        assert.equal(explicit.id, deploy.ref.id);

        // Identical specificity for overlapping records is refused at define time.
        const clash = yield* Effect.flip(
          views.defineTemplate(ownerApp, {
            missionId,
            definition: { ...crwMerge, key: "crw-merge-2", name: "Crw merge 2" },
          }),
        );
        assert.include(clash.detail, "match-conflict");

        // Removing the crw template falls back to the next match.
        yield* views.remove(ownerApp, {
          missionId,
          ref: { kind: "view-template", id: crw.ref.id },
        });
        const fallback = yield* views.resolveTemplate(missionId, backed(approval("a-1")));
        assert.equal(fallback.definition.key, "any-merge");
      }),
    ),
  );

  it.effect("built-in templates are not editable or removable", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const id = builtinViewTemplateId("ask");
        assert.equal(
          yield* failureCode(
            views.remove(ownerApp, { missionId, ref: { kind: "view-template", id } }),
          ),
          "invalid",
        );
        assert.equal(
          yield* failureCode(
            views.defineTemplate(ownerApp, {
              missionId,
              templateId: ViewTemplateId.make(id),
              definition: crwMerge,
            }),
          ),
          "invalid",
        );
      }),
    ),
  );

  it.effect("seeds new missions from the starter in force, without a restart", () =>
    fresh(
      Effect.gen(function* () {
        // it.effect runs on the test clock; start after the seeded mission was created.
        yield* TestClock.setTime(Date.parse("2026-10-19T08:00:00.000Z"));
        const views = yield* ViewService;
        const missions = yield* MissionService.MissionService;
        yield* seed;
        // m-1 predates any view: reads compute its layout lazily from the built-in starter.
        const lazy = yield* views.snapshot(missionId);
        assert.equal(lazy.layout.seededFrom, 1);
        assert.deepEqual(lazy.layout.layout, DEFAULT_STARTER_LAYOUT.layout);

        yield* views.editStarter(ownerApp, {
          ops: [{ _tag: "hide", key: "since-last-looked" }],
          changeNote: "Quieter overview.",
        });
        const starter = (yield* views.snapshot(missionId)).starter;
        assert.equal(starter.version, 2);
        assert.equal(starter.by, "owner");

        // The existing mission keeps its own layout.
        const existing = yield* views.snapshot(missionId);
        assert.equal(existing.layout.seededFrom, 1);
        assert.isFalse(
          existing.layout.layout.entries.find((e) => e.key === "since-last-looked")?.hidden,
        );

        // A mission created now starts from starter v2.
        const created = yield* missions.createMission(ownerApp, { slug: "fresh", title: "Fresh" });
        const fresh = MissionId.make(created.ref.id);
        yield* views.seedLayout(fresh);
        const seeded = yield* views.snapshot(fresh);
        assert.equal(seeded.layout.seededFrom, 2);
        assert.isTrue(
          seeded.layout.layout.entries.find((e) => e.key === "since-last-looked")?.hidden,
        );

        // The starter holds built-in sections and tabs only.
        assert.equal(
          yield* failureCode(
            views.editStarter(ownerApp, {
              ops: [
                {
                  _tag: "add",
                  entry: {
                    key: "release",
                    section: { _tag: "custom", sectionId: "s-1" as never },
                    region: "main",
                    hidden: false,
                    title: null,
                  },
                },
              ],
            }),
          ),
          "invalid",
        );

        yield* views.restoreStarter(ownerApp, { toVersion: 1 });
        const back = (yield* views.snapshot(missionId)).starter;
        assert.equal(back.version, 3);
        assert.deepEqual(back.layout, DEFAULT_STARTER_LAYOUT.layout);
        const store = yield* MissionStore.MissionStore;
        const global = (yield* store.eventsSince(MissionId.make("missions-global"), 0)).map(
          (e) => e.kind,
        );
        assert.includeMembers(global, [
          "view.starter-layout-changed",
          "view.starter-layout-restored",
        ]);
      }),
    ),
  );

  it.effect(
    "hiding Needs you while items wait pins the strip; nothing waiting, nothing pinned",
    () =>
      fresh(
        Effect.gen(function* () {
          yield* seed;
          const views = yield* ViewService;
          yield* views.editLayout(ownerApp, ops({ _tag: "hide", key: "needs-you" }));
          let snapshot = yield* views.snapshot(missionId);
          assert.equal(snapshot.ownerWaiting, 0);
          assert.isFalse(snapshot.pinnedStrip);

          yield* openAsk("ask-1");
          snapshot = yield* views.snapshot(missionId);
          assert.equal(snapshot.ownerWaiting, 1);
          assert.isTrue(snapshot.pinned.needsYou);
          assert.isTrue(snapshot.pinnedStrip);

          // Moving it to a tab-only region is refused; showing it again unpins.
          assert.equal(
            yield* failureCode(
              views.editLayout(
                ownerApp,
                ops({ _tag: "move", key: "needs-you", region: "tabs", index: 0 }),
              ),
            ),
            "invalid",
          );
          yield* views.editLayout(ownerApp, ops({ _tag: "show", key: "needs-you" }));
          assert.isFalse((yield* views.snapshot(missionId)).pinnedStrip);

          // Hiding the Overview tab hides Needs you with it, so the strip pins again.
          const result = yield* views.editLayout(
            ownerApp,
            ops({ _tag: "hide", key: "tab-overview" }),
          );
          assert.isTrue((yield* views.snapshot(missionId)).pinned.needsYou);
          const store = yield* MissionStore.MissionStore;
          const event = (yield* store.eventsSince(missionId, result.seq - 1)).find(
            (e) => e.seq === result.seq,
          );
          assert.include(event?.summary ?? "", "pinned strip");

          // Restore any earlier layout version.
          yield* views.restoreLayout(ownerApp, { missionId, toVersion: 1 });
          const layout = (yield* views.snapshot(missionId)).layout;
          assert.deepEqual(layout.layout, DEFAULT_STARTER_LAYOUT.layout);
          // v1 is the seed stored on the first change; four changes and the restore follow.
          assert.equal(layout.version, 5);
        }),
      ),
  );

  it.effect("the master changes anything the owner can; others are refused", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        yield* seedOther;
        const views = yield* ViewService;
        const master = agent(masterThread);
        const made = yield* views.defineTemplate(master, { missionId, definition: crwMerge });
        const snapshot = yield* views.snapshot(missionId);
        assert.equal(snapshot.templates[0]?.by, "master");
        assert.deepEqual(snapshot.templates[0]?.changedBy, {
          _tag: "role",
          roleId: RoleId.make("role-master"),
        });
        yield* views.editLayout(
          master,
          ops({ _tag: "rename", key: "sub-missions", title: "Workstreams" }),
        );
        yield* views.remove(master, { missionId, ref: { kind: "view-template", id: made.ref.id } });

        // A writer and another mission's master can't change this mission's views.
        assert.equal(
          yield* failureCode(
            views.defineTemplate(agent(writerThread), { missionId, definition: crwMerge }),
          ),
          "forbidden",
        );
        assert.equal(
          yield* failureCode(
            views.editLayout(agent(otherMasterThread), ops({ _tag: "hide", key: "sub-missions" })),
          ),
          "forbidden",
        );
        // Any mission's master can edit the starter; a writer can't.
        yield* views.editStarter(agent(otherMasterThread), {
          ops: [{ _tag: "hide", key: "tab-calls" }],
        });
        assert.equal(
          yield* failureCode(
            views.editStarter(agent(writerThread), { ops: [{ _tag: "show", key: "tab-calls" }] }),
          ),
          "forbidden",
        );
      }),
    ),
  );

  it.effect("places sections into the layout and enforces the section limit", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        yield* views.editLayout(
          ownerApp,
          ops({ _tag: "limits", limits: { templates: 24, sections: 1, changesPerDay: 40 } }),
        );
        const placed = yield* views.placeSection(ownerApp, {
          missionId,
          definition: {
            key: "release-train",
            title: "Release train",
            source: {
              _tag: "query",
              query: {
                kind: "work-item",
                where: { stage: ["deploy"] },
                sort: "updated-desc",
                limit: 5,
              },
            },
            body: [{ _tag: "list", title: "row.title", meta: ["row.stage"], status: null }],
          },
          region: "main",
          index: 0,
        });
        const snapshot = yield* views.snapshot(missionId);
        const top = snapshot.layout.layout.entries.find((entry) => entry.region === "main");
        assert.equal(top?.key, "release-train");
        assert.deepEqual(top?.section, {
          _tag: "custom",
          sectionId: ViewSectionId.make(placed.ref.id),
        });

        const second = yield* Effect.flip(
          views.placeSection(ownerApp, {
            missionId,
            definition: {
              key: "other",
              title: "Other",
              source: { _tag: "refs", refs: [{ kind: "work-item", id: "wi-held" }] },
              body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
            },
          }),
        );
        assert.equal(second.code, "invalid");
        assert.include(second.detail, "limit");

        // A section key can't take a layout key a built-in already holds.
        yield* views.editLayout(
          ownerApp,
          ops({ _tag: "limits", limits: { templates: 24, sections: 4, changesPerDay: 40 } }),
        );
        const clash = yield* Effect.flip(
          views.placeSection(ownerApp, {
            missionId,
            definition: {
              key: "needs-you",
              title: "Mine",
              source: { _tag: "refs", refs: [{ kind: "work-item", id: "wi-held" }] },
              body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
            },
          }),
        );
        assert.include(clash.detail, "already has an entry keyed needs-you");

        // An update doesn't bring back an entry the layout removed.
        yield* views.editLayout(ownerApp, ops({ _tag: "remove", key: "release-train" }));
        yield* views.placeSection(ownerApp, {
          missionId,
          sectionId: ViewSectionId.make(placed.ref.id),
          definition: {
            key: "release-train",
            title: "Release train (deploys)",
            source: { _tag: "refs", refs: [{ kind: "work-item", id: "wi-held" }] },
            body: [{ _tag: "list", title: "row.title", meta: [], status: null }],
          },
        });
        const after = yield* views.snapshot(missionId);
        assert.isFalse(after.layout.layout.entries.some((entry) => entry.key === "release-train"));
      }),
    ),
  );

  it.effect("meters only the master's own changes, and limits always go through", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const master = agent(masterThread);
        yield* views.editLayout(
          ownerApp,
          ops({ _tag: "limits", limits: { templates: 24, sections: 8, changesPerDay: 2 } }),
        );
        // The owner's edits don't spend the master's budget.
        for (const key of ["sub-missions", "since-last-looked", "with-the-master"]) {
          yield* views.editLayout(ownerApp, ops({ _tag: "hide", key }));
        }
        yield* views.editLayout(master, ops({ _tag: "show", key: "sub-missions" }));
        yield* views.editStarter(master, { ops: [{ _tag: "hide", key: "tab-calls" }] });
        const spent = yield* Effect.flip(
          views.editLayout(master, ops({ _tag: "show", key: "with-the-master" })),
        );
        assert.include(spent.detail, "view change budget used today (2 of 2)");
        // The master can raise its own budget, then carry on.
        yield* views.editLayout(
          master,
          ops({ _tag: "limits", limits: { templates: 24, sections: 8, changesPerDay: 10 } }),
        );
        yield* views.editLayout(master, ops({ _tag: "show", key: "with-the-master" }));
        assert.equal((yield* views.snapshot(missionId)).changesToday, 4);
      }),
    ),
  );

  it.effect("Needs you in the header doesn't count as shown", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        yield* openAsk("ask-1");
        yield* views.editLayout(
          ownerApp,
          ops({ _tag: "move", key: "needs-you", region: "header", index: 1 }),
        );
        assert.isTrue((yield* views.snapshot(missionId)).pinned.needsYou);
      }),
    ),
  );
});
