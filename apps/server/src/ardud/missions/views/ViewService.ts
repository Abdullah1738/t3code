// @effect-diagnostics nodeBuiltinImport:off - view ids only need a random UUID.
/**
 * Card templates, sections and layouts for each mission, plus the global
 * starter layout new missions start from.
 *
 * Nothing here is owner-only: the owner and the mission's master make the same
 * changes through the same methods, and every change is a timeline event with
 * actor and provenance that can be restored. Definitions are checked against
 * the catalog before anything is stored. The starter layout is a stored,
 * versioned record (not code), so changing what we recommend needs no restart;
 * it only affects missions created after the change.
 */
import * as NodeCrypto from "node:crypto";

import {
  BUILTIN_VIEW_TEMPLATE_PREFIX,
  MissionError,
  MissionId,
  VIEW_CATALOG,
  VIEW_CATALOG_VERSION,
  VIEW_HARD_LIMITS,
  ViewSectionId,
  ViewTemplateId,
  formatViewIssues,
  isOwnerProvenance,
  selectViewTemplate,
  viewMatchSubjectOf,
  viewPinnedStrip,
  type DefineViewTemplateInput,
  type EditStarterLayoutInput,
  type EditViewLayoutInput,
  type Mission,
  type MissionActor,
  type MissionEventKind,
  type MissionMutationResult,
  type MissionProvenance,
  type MissionRecordRef,
  type MissionViewsSnapshot,
  type PlaceViewSectionInput,
  type PreviewViewInput,
  type RemoveViewInput,
  type RestoreStarterLayoutInput,
  type RestoreViewInput,
  type RestoreViewLayoutInput,
  type SelectedViewTemplate,
  type ViewAuthor,
  type ViewBackedRecord,
  type ViewCatalog,
  type ViewChangeMeta,
  type ViewHistory,
  type ViewHistoryEntry,
  type ViewHistoryInput,
  type ViewIssue,
  type ViewLayout,
  type ViewLayoutDefinition,
  type ViewLayoutEntry,
  type ViewLimits,
  type ViewPreview,
  type ViewSection,
  type ViewStarterLayout,
  type ViewStatus,
  type ViewTemplate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { standingOf } from "../asks/standing.ts";
import { castOf } from "../core/master.ts";
import { actorOf } from "../core/provenance.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { applyLayoutOps, insertInRegion } from "./layoutOps.ts";
import { byteSize, checkLayout, checkSection, checkTemplate } from "./validate.ts";
import * as ViewStore from "./ViewStore.ts";

type Write<I> = (
  provenance: MissionProvenance,
  input: I,
) => Effect.Effect<MissionMutationResult, MissionError>;

/** Owner-waiting and unread-request counts that drive the pinned strip. */
export interface ViewWaiting {
  readonly ownerWaiting: number;
  readonly requestsUnread: number;
}

export class ViewService extends Context.Service<
  ViewService,
  {
    readonly snapshot: (missionId: MissionId) => Effect.Effect<MissionViewsSnapshot, MissionError>;
    readonly catalog: Effect.Effect<ViewCatalog>;
    readonly history: (input: ViewHistoryInput) => Effect.Effect<ViewHistory, MissionError>;
    /** Runs the define-time checks and stores nothing. */
    readonly preview: (input: PreviewViewInput) => Effect.Effect<ViewPreview, MissionError>;
    /** The template a record renders with: explicit, then best match, then built-in. */
    readonly resolveTemplate: (
      missionId: MissionId,
      backed: ViewBackedRecord,
    ) => Effect.Effect<SelectedViewTemplate, MissionError>;
    readonly waiting: (missionId: MissionId) => Effect.Effect<ViewWaiting, MissionError>;
    readonly defineTemplate: Write<DefineViewTemplateInput>;
    readonly placeSection: Write<PlaceViewSectionInput>;
    readonly remove: Write<RemoveViewInput>;
    readonly restore: Write<RestoreViewInput>;
    readonly editLayout: Write<EditViewLayoutInput>;
    readonly restoreLayout: Write<RestoreViewLayoutInput>;
    readonly editStarter: Write<EditStarterLayoutInput>;
    readonly restoreStarter: Write<RestoreStarterLayoutInput>;
    /** Stores a new mission's layout from the starter in force; no-op when it has one. */
    readonly seedLayout: (missionId: MissionId) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/views/ViewService") {}

/** The starter layout's changes go on the missions-wide timeline. */
export const GLOBAL_TIMELINE = MissionId.make(ViewStore.STARTER_MISSION);

const SEED_ACTOR: MissionActor = { _tag: "system", component: "missions-views" };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const newId = (prefix: string): string => `${prefix}-${NodeCrypto.randomUUID()}`;

const refuse = (issues: ReadonlyArray<ViewIssue>) =>
  new MissionError({ code: "invalid", detail: formatViewIssues(issues) });

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

/** Who is changing views, as the event and the record's change marker show it. */
interface ViewCaller {
  readonly provenance: MissionProvenance;
  readonly actor: MissionActor;
  readonly by: ViewAuthor;
}

const OWNER_CALLER = (provenance: MissionProvenance): ViewCaller => ({
  provenance,
  actor: { _tag: "owner" },
  by: "owner",
});

const who = (caller: ViewCaller) => (caller.by === "owner" ? "The owner" : "The master");

interface PendingWrite {
  readonly write: ViewStore.ViewWrite;
  readonly counts: boolean;
}

const changeMeta = (
  caller: ViewCaller,
  version: number,
  changedAt: string,
  changeNote: string | undefined,
): ViewChangeMeta => ({
  version,
  changedBy: caller.actor,
  by: caller.by,
  changedAt,
  changeNote: changeNote ?? null,
});

const historyEntry = (
  meta: ViewChangeMeta,
  status: ViewStatus | null,
  value: unknown,
): ViewHistoryEntry => ({
  version: meta.version,
  changedBy: meta.changedBy,
  by: meta.by,
  changedAt: meta.changedAt,
  changeNote: meta.changeNote,
  status,
  value,
});

/** The layout a mission starts with: the starter that was in force when it was created. */
export const seededLayout = (
  mission: Pick<Mission, "id" | "createdAt">,
  starters: ReadonlyArray<ViewStarterLayout>,
): ViewLayout => {
  const starter = ViewStore.starterAt(starters, mission.createdAt);
  return {
    missionId: mission.id,
    layout: starter.layout,
    version: 1,
    changedBy: SEED_ACTOR,
    by: "system",
    changedAt: mission.createdAt,
    changeNote: `Started from the recommended starter layout (v${starter.version}).`,
    seededFrom: starter.version,
  };
};

const make = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const missions = yield* MissionService.MissionService;
  const views = yield* ViewStore.ViewStore;
  const lock = yield* Semaphore.make(1);
  const serial = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermit(effect);

  const requireMission = (missionId: MissionId) =>
    Effect.flatMap(store.get("mission", missionId), (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : fail("not-found", `Mission ${missionId} does not exist.`),
    );

  const masterCaller = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (provenance._tag !== "agent") return null;
      const cast = yield* castOf(store, missionId);
      if (cast.mission === null) return null;
      const standing = standingOf(cast, provenance);
      if (!standing.isMaster) return null;
      const caller: ViewCaller = {
        provenance: standing.caller.provenance,
        actor: actorOf(standing.caller.provenance),
        by: "master",
      };
      return caller;
    });

  /** The owner, or the master of this mission. */
  const editorOf = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) return OWNER_CALLER(provenance);
      const master = yield* masterCaller(missionId, provenance);
      if (master !== null) return master;
      return yield* fail(
        "forbidden",
        "Only the owner or the mission's master can change its views.",
      );
    });

  /** The owner, or the master of any mission (the starter affects every new mission). */
  const starterEditor = (provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) return OWNER_CALLER(provenance);
      for (const mission of yield* store.list("mission", {})) {
        const master = yield* masterCaller(mission.id, provenance);
        if (master !== null) return master;
      }
      return yield* fail(
        "forbidden",
        "Only the owner or a mission's master can change the starter layout.",
      );
    });

  const fence = (current: number, expected: number | undefined, what: string) =>
    expected === undefined || expected === current
      ? Effect.void
      : fail(
          "conflict",
          `${what} is at version ${current}, not ${expected}. Reload and try again.`,
        );

  const currentLayout = (mission: Pick<Mission, "id" | "createdAt">) =>
    Effect.gen(function* () {
      const stored = yield* views.layout(mission.id);
      if (stored !== null) return { layout: stored, stored: true };
      return { layout: seededLayout(mission, yield* views.starters), stored: false };
    });

  /** The writes for a new layout version, storing the seed first when it never was. */
  const layoutWrites = (
    current: { readonly layout: ViewLayout; readonly stored: boolean },
    next: ViewLayout,
    counts: boolean,
  ): Array<PendingWrite> => [
    ...(current.stored
      ? []
      : [{ write: { scope: "layout" as const, value: current.layout }, counts: false }]),
    { write: { scope: "layout", value: next }, counts },
  ];

  /** The master's daily budget; the owner is never metered. */
  const spendBudget = (caller: ViewCaller, missionId: MissionId, limits: ViewLimits) =>
    caller.by !== "master"
      ? Effect.void
      : Effect.gen(function* () {
          const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
          const used = yield* views.changesSince(missionId, since);
          if (used >= limits.changesPerDay) {
            return yield* fail(
              "invalid",
              `view change budget used today (${used} of ${limits.changesPerDay}); the owner can raise it in the layout limits`,
            );
          }
        });

  const missionBytesIssue = (
    templates: ReadonlyArray<ViewTemplate>,
    sections: ReadonlyArray<ViewSection>,
    replacing: string | null,
    bytes: number,
  ): ViewIssue | null => {
    const others =
      templates
        .filter((template) => template.status === "active" && template.id !== replacing)
        .reduce((sum, template) => sum + byteSize(template.definition), 0) +
      sections
        .filter((section) => section.status === "active" && section.id !== replacing)
        .reduce((sum, section) => sum + byteSize(section.definition), 0);
    return others + bytes > VIEW_HARD_LIMITS.bytesPerMission
      ? {
          path: "definition",
          code: "limit",
          detail: `this mission's views would pass ${VIEW_HARD_LIMITS.bytesPerMission} bytes`,
        }
      : null;
  };

  const commit = (input: {
    readonly missionId: MissionId;
    readonly kind: MissionEventKind;
    readonly caller: ViewCaller;
    readonly summary: string;
    readonly subject: MissionRecordRef;
    readonly payload: unknown;
    readonly writes: ReadonlyArray<PendingWrite>;
  }) =>
    store
      .commit({
        event: {
          missionId: input.missionId,
          kind: input.kind,
          actor: input.caller.actor,
          provenance: input.caller.provenance,
          summary: input.summary,
          subject: input.subject,
          payload: input.payload,
        },
        alongside: Effect.forEach(
          input.writes,
          (pending) => views.write(pending.write, { counts: pending.counts }),
          { discard: true },
        ),
      })
      .pipe(
        Effect.map((result): MissionMutationResult => ({ seq: result.seq, ref: input.subject })),
      );

  const waiting = (missionId: MissionId) =>
    Effect.gen(function* () {
      const inbox = yield* missions.inbox(missionId);
      const { decide, approve, knocks, suggestions } = inbox.counts;
      const requestsUnread = yield* views.requestsAnswered(missionId);
      const counts: ViewWaiting = {
        ownerWaiting: decide + approve + knocks + suggestions,
        requestsUnread,
      };
      return counts;
    });

  const pinnedNote = (layout: ViewLayoutDefinition, counts: ViewWaiting) => {
    const pinned = viewPinnedStrip(layout, counts);
    const parts = [
      ...(pinned.needsYou ? [`${counts.ownerWaiting} waiting on the owner`] : []),
      ...(pinned.requests ? [`${counts.requestsUnread} answered requests`] : []),
    ];
    return {
      pinned,
      note: parts.length === 0 ? "" : `; the pinned strip shows ${parts.join(" and ")}`,
    };
  };

  // --- reads ---

  const snapshot = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(missionId);
      const templates = yield* views.templates(mission.id);
      const sections = yield* views.sections(mission.id);
      const { layout } = yield* currentLayout(mission);
      const starter = ViewStore.currentStarter(yield* views.starters);
      const counts = yield* waiting(mission.id);
      const pinned = viewPinnedStrip(layout.layout, counts);
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
      const result: MissionViewsSnapshot = {
        missionId: mission.id,
        catalogVersion: VIEW_CATALOG_VERSION,
        revision: yield* views.revision(mission.id),
        templates,
        sections,
        layout,
        starter,
        ownerWaiting: counts.ownerWaiting,
        requestsUnread: counts.requestsUnread,
        pinnedStrip: pinned.needsYou || pinned.requests,
        pinned,
        changesToday: yield* views.changesSince(mission.id, since),
      };
      return result;
    });

  const history = (input: ViewHistoryInput) =>
    Effect.gen(function* () {
      const target = input.target;
      const newestFirst = (entries: ReadonlyArray<ViewHistoryEntry>) =>
        [...entries].sort((a, b) => b.version - a.version);
      switch (target._tag) {
        case "template": {
          const versions = (yield* views.templateVersions(target.id)).filter(
            (version) => version.missionId === input.missionId,
          );
          if (versions.length === 0) {
            return yield* fail("not-found", `No card template ${target.id} in this mission.`);
          }
          const entries = versions.map((v) => historyEntry(v, v.status, v.definition));
          const result: ViewHistory = { target, entries: newestFirst(entries) };
          return result;
        }
        case "section": {
          const versions = (yield* views.sectionVersions(target.id)).filter(
            (version) => version.missionId === input.missionId,
          );
          if (versions.length === 0) {
            return yield* fail("not-found", `No section ${target.id} in this mission.`);
          }
          const entries = versions.map((v) => historyEntry(v, v.status, v.definition));
          const result: ViewHistory = { target, entries: newestFirst(entries) };
          return result;
        }
        case "layout": {
          const mission = yield* requireMission(input.missionId);
          const stored = yield* views.layoutVersions(mission.id);
          const versions =
            stored.length > 0 ? stored : [seededLayout(mission, yield* views.starters)];
          const entries = versions.map((v) => historyEntry(v, null, v.layout));
          const result: ViewHistory = { target, entries: newestFirst(entries) };
          return result;
        }
        case "starter": {
          const versions = ViewStore.starterHistory(yield* views.starters);
          const entries = versions.map((v) => historyEntry(v, null, v.layout));
          const result: ViewHistory = { target, entries: newestFirst(entries) };
          return result;
        }
      }
    });

  const preview = (input: PreviewViewInput) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(input.missionId);
      const proposal = input.definition;
      if (proposal._tag === "template") {
        const templates = yield* views.templates(mission.id);
        const replacing =
          proposal.templateId ??
          templates.find((template) => template.definition.key === proposal.definition.key)?.id;
        const check = checkTemplate(proposal.definition, {
          siblings: templates.filter((template) => template.id !== replacing),
        });
        const result: ViewPreview = { ok: check.issues.length === 0, ...check };
        return result;
      }
      const sections = yield* views.sections(mission.id);
      const replacing =
        proposal.sectionId ??
        sections.find((section) => section.definition.key === proposal.definition.key)?.id;
      const check = checkSection(proposal.definition, {
        siblings: sections.filter((section) => section.id !== replacing),
      });
      const result: ViewPreview = { ok: check.issues.length === 0, ...check };
      return result;
    });

  const resolveTemplate = (missionId: MissionId, backed: ViewBackedRecord) =>
    Effect.map(views.templates(missionId), (templates) =>
      selectViewTemplate(viewMatchSubjectOf(backed), templates),
    );

  // --- templates ---

  const defineTemplate: Write<DefineViewTemplateInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        if (input.templateId?.startsWith(BUILTIN_VIEW_TEMPLATE_PREFIX) === true) {
          return yield* fail(
            "invalid",
            "built-in templates can't be edited; define your own (an empty match replaces the built-in for its kind)",
          );
        }
        const templates = yield* views.templates(mission.id);
        const existing =
          input.templateId !== undefined
            ? templates.find((template) => template.id === input.templateId)
            : templates.find((template) => template.definition.key === input.definition.key);
        if (existing?.status === "removed") {
          return yield* fail(
            "conflict",
            `Card template ${existing.definition.name} is removed; restore it before changing it.`,
          );
        }
        yield* fence(existing?.version ?? 0, input.expectedVersion, "This card template");
        const { layout } = yield* currentLayout(mission);
        yield* spendBudget(caller, mission.id, layout.layout.limits);

        const sections = yield* views.sections(mission.id);
        const siblings = templates.filter((template) => template.id !== existing?.id);
        const check = checkTemplate(input.definition, { siblings });
        const issues = [...check.issues];
        const active = siblings.filter((template) => template.status === "active").length;
        if (existing === undefined && active >= layout.layout.limits.templates) {
          issues.push({
            path: "definition",
            code: "limit",
            detail: `this mission already has ${active} of ${layout.layout.limits.templates} card templates`,
          });
        }
        const bytes = missionBytesIssue(templates, sections, existing?.id ?? null, check.bytes);
        if (bytes !== null) issues.push(bytes);
        if (issues.length > 0) return yield* refuse(issues);

        const now = yield* nowIso;
        const id = existing?.id ?? input.templateId ?? ViewTemplateId.make(newId("view-template"));
        const template: ViewTemplate = {
          id,
          missionId: mission.id,
          definition: input.definition,
          ...changeMeta(caller, (existing?.version ?? 0) + 1, now, input.changeNote),
          catalogVersion: VIEW_CATALOG_VERSION,
          status: "active",
          createdAt: existing?.createdAt ?? now,
          createdBy: existing?.createdBy ?? caller.by,
        };
        const verb = existing === undefined ? "defined" : "updated";
        return yield* commit({
          missionId: mission.id,
          kind: existing === undefined ? "view.template-defined" : "view.template-updated",
          caller,
          summary: `${who(caller)} ${verb} card template ${input.definition.name} (v${template.version})`,
          subject: { kind: "view-template", id, label: input.definition.name },
          payload: { before: existing ?? null, after: template },
          writes: [{ write: { scope: "template", value: template }, counts: true }],
        });
      }),
    );

  // --- sections ---

  const placeSection: Write<PlaceViewSectionInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const sections = yield* views.sections(mission.id);
        const existing =
          input.sectionId !== undefined
            ? sections.find((section) => section.id === input.sectionId)
            : sections.find((section) => section.definition.key === input.definition.key);
        if (existing?.status === "removed") {
          return yield* fail(
            "conflict",
            `Section ${existing.definition.title} is removed; restore it before changing it.`,
          );
        }
        yield* fence(existing?.version ?? 0, input.expectedVersion, "This section");
        const current = yield* currentLayout(mission);
        const limits = current.layout.layout.limits;
        yield* spendBudget(caller, mission.id, limits);

        const templates = yield* views.templates(mission.id);
        const siblings = sections.filter((section) => section.id !== existing?.id);
        const check = checkSection(input.definition, { siblings });
        const issues = [...check.issues];
        const active = siblings.filter((section) => section.status === "active").length;
        if (existing === undefined && active >= limits.sections) {
          issues.push({
            path: "definition",
            code: "limit",
            detail: `this mission already has ${active} of ${limits.sections} sections`,
          });
        }
        const bytes = missionBytesIssue(templates, sections, existing?.id ?? null, check.bytes);
        if (bytes !== null) issues.push(bytes);

        const now = yield* nowIso;
        const id = existing?.id ?? input.sectionId ?? ViewSectionId.make(newId("view-section"));
        const entries = current.layout.layout.entries;
        const placed = entries.find(
          (entry) => entry.section._tag === "custom" && entry.section.sectionId === id,
        );
        const moves = input.region !== undefined || input.index !== undefined;
        let nextEntries: ReadonlyArray<ViewLayoutEntry> = entries;
        if (placed === undefined || moves) {
          const entry: ViewLayoutEntry = placed
            ? { ...placed, region: input.region ?? placed.region }
            : {
                key: input.definition.key,
                section: { _tag: "custom", sectionId: id },
                region: input.region ?? "main",
                hidden: false,
                title: null,
              };
          nextEntries = insertInRegion(
            entries.filter((other) => other !== placed),
            entry,
            input.index,
          );
        }
        const nextLayout: ViewLayoutDefinition = { entries: nextEntries, limits };
        if (nextEntries !== entries) {
          issues.push(
            ...checkLayout(nextLayout, {
              sectionIds: new Set([...sections.map((section) => section.id), id]),
            }),
          );
        }
        if (issues.length > 0) return yield* refuse(issues);

        const section: ViewSection = {
          id,
          missionId: mission.id,
          definition: input.definition,
          ...changeMeta(caller, (existing?.version ?? 0) + 1, now, input.changeNote),
          catalogVersion: VIEW_CATALOG_VERSION,
          status: "active",
          createdAt: existing?.createdAt ?? now,
          createdBy: existing?.createdBy ?? caller.by,
        };
        const writes: Array<PendingWrite> = [
          { write: { scope: "section", value: section }, counts: true },
        ];
        if (nextEntries !== entries) {
          writes.push(
            ...layoutWrites(
              current,
              {
                ...current.layout,
                layout: nextLayout,
                ...changeMeta(caller, current.layout.version + 1, now, input.changeNote),
              },
              false,
            ),
          );
        }
        const verb = existing === undefined ? "placed" : "updated";
        return yield* commit({
          missionId: mission.id,
          kind: existing === undefined ? "view.section-placed" : "view.section-updated",
          caller,
          summary: `${who(caller)} ${verb} section ${input.definition.title} (v${section.version})`,
          subject: { kind: "view-section", id, label: input.definition.title },
          payload: { before: existing ?? null, after: section, moved: nextEntries !== entries },
          writes,
        });
      }),
    );

  // --- remove / restore ---

  const remove: Write<RemoveViewInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const { layout } = yield* currentLayout(mission);
        const now = yield* nowIso;
        if (input.ref.kind === "view-template") {
          if (input.ref.id.startsWith(BUILTIN_VIEW_TEMPLATE_PREFIX)) {
            return yield* fail(
              "invalid",
              "built-in templates can't be removed; define your own (an empty match replaces the built-in for its kind)",
            );
          }
          const existing = (yield* views.templates(mission.id)).find(
            (template) => template.id === input.ref.id,
          );
          if (existing === undefined) {
            return yield* fail("not-found", `No card template ${input.ref.id} in this mission.`);
          }
          if (existing.status === "removed") {
            return yield* fail(
              "conflict",
              `Card template ${existing.definition.name} is already removed.`,
            );
          }
          yield* fence(existing.version, input.expectedVersion, "This card template");
          yield* spendBudget(caller, mission.id, layout.layout.limits);
          const next: ViewTemplate = {
            ...existing,
            ...changeMeta(caller, existing.version + 1, now, input.reason),
            status: "removed",
          };
          return yield* commit({
            missionId: mission.id,
            kind: "view.template-removed",
            caller,
            summary: `${who(caller)} removed card template ${existing.definition.name}; its cards fall back to the next match or the built-in`,
            subject: { kind: "view-template", id: existing.id, label: existing.definition.name },
            payload: { version: next.version, reason: input.reason ?? null },
            writes: [{ write: { scope: "template", value: next }, counts: true }],
          });
        }
        const existing = (yield* views.sections(mission.id)).find(
          (section) => section.id === input.ref.id,
        );
        if (existing === undefined) {
          return yield* fail("not-found", `No section ${input.ref.id} in this mission.`);
        }
        if (existing.status === "removed") {
          return yield* fail(
            "conflict",
            `Section ${existing.definition.title} is already removed.`,
          );
        }
        yield* fence(existing.version, input.expectedVersion, "This section");
        yield* spendBudget(caller, mission.id, layout.layout.limits);
        const next: ViewSection = {
          ...existing,
          ...changeMeta(caller, existing.version + 1, now, input.reason),
          status: "removed",
        };
        return yield* commit({
          missionId: mission.id,
          kind: "view.section-removed",
          caller,
          summary: `${who(caller)} removed section ${existing.definition.title}`,
          subject: { kind: "view-section", id: existing.id, label: existing.definition.title },
          payload: { version: next.version, reason: input.reason ?? null },
          writes: [{ write: { scope: "section", value: next }, counts: true }],
        });
      }),
    );

  const restore: Write<RestoreViewInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const { layout } = yield* currentLayout(mission);
        const limits = layout.layout.limits;
        yield* spendBudget(caller, mission.id, limits);
        const templates = yield* views.templates(mission.id);
        const sections = yield* views.sections(mission.id);
        const now = yield* nowIso;
        const note = (fromVersion: number) =>
          input.changeNote ??
          (input.toVersion === undefined ? "Restored." : `Restored version ${fromVersion}.`);

        if (input.ref.kind === "view-template") {
          const existing = templates.find((template) => template.id === input.ref.id);
          if (existing === undefined) {
            return yield* fail("not-found", `No card template ${input.ref.id} in this mission.`);
          }
          const source =
            input.toVersion === undefined
              ? existing
              : (yield* views.templateVersions(existing.id)).find(
                  (version) => version.version === input.toVersion,
                );
          if (source === undefined) {
            return yield* fail(
              "not-found",
              `Card template ${existing.definition.name} has no version ${input.toVersion}.`,
            );
          }
          if (input.toVersion === undefined && existing.status === "active") {
            return yield* fail(
              "invalid",
              `Card template ${existing.definition.name} is active; pass toVersion to roll it back.`,
            );
          }
          const siblings = templates.filter((template) => template.id !== existing.id);
          const check = checkTemplate(source.definition, { siblings });
          const issues = [...check.issues];
          const active = siblings.filter((template) => template.status === "active").length;
          if (existing.status === "removed" && active >= limits.templates) {
            issues.push({
              path: "definition",
              code: "limit",
              detail: `this mission already has ${active} of ${limits.templates} card templates`,
            });
          }
          const bytes = missionBytesIssue(templates, sections, existing.id, check.bytes);
          if (bytes !== null) issues.push(bytes);
          if (issues.length > 0) return yield* refuse(issues);
          const next: ViewTemplate = {
            ...existing,
            definition: source.definition,
            ...changeMeta(caller, existing.version + 1, now, note(source.version)),
            catalogVersion: VIEW_CATALOG_VERSION,
            status: "active",
          };
          return yield* commit({
            missionId: mission.id,
            kind: "view.template-restored",
            caller,
            summary: `${who(caller)} restored card template ${next.definition.name}${input.toVersion === undefined ? "" : ` to version ${source.version}`}`,
            subject: { kind: "view-template", id: next.id, label: next.definition.name },
            payload: {
              version: next.version,
              fromVersion: source.version,
              before: existing,
              after: next,
            },
            writes: [{ write: { scope: "template", value: next }, counts: true }],
          });
        }

        const existing = sections.find((section) => section.id === input.ref.id);
        if (existing === undefined) {
          return yield* fail("not-found", `No section ${input.ref.id} in this mission.`);
        }
        const source =
          input.toVersion === undefined
            ? existing
            : (yield* views.sectionVersions(existing.id)).find(
                (version) => version.version === input.toVersion,
              );
        if (source === undefined) {
          return yield* fail(
            "not-found",
            `Section ${existing.definition.title} has no version ${input.toVersion}.`,
          );
        }
        if (input.toVersion === undefined && existing.status === "active") {
          return yield* fail(
            "invalid",
            `Section ${existing.definition.title} is active; pass toVersion to roll it back.`,
          );
        }
        const siblings = sections.filter((section) => section.id !== existing.id);
        const check = checkSection(source.definition, { siblings });
        const issues = [...check.issues];
        const active = siblings.filter((section) => section.status === "active").length;
        if (existing.status === "removed" && active >= limits.sections) {
          issues.push({
            path: "definition",
            code: "limit",
            detail: `this mission already has ${active} of ${limits.sections} sections`,
          });
        }
        const bytes = missionBytesIssue(templates, sections, existing.id, check.bytes);
        if (bytes !== null) issues.push(bytes);
        if (issues.length > 0) return yield* refuse(issues);
        const next: ViewSection = {
          ...existing,
          definition: source.definition,
          ...changeMeta(caller, existing.version + 1, now, note(source.version)),
          catalogVersion: VIEW_CATALOG_VERSION,
          status: "active",
        };
        return yield* commit({
          missionId: mission.id,
          kind: "view.section-restored",
          caller,
          summary: `${who(caller)} restored section ${next.definition.title}${input.toVersion === undefined ? "" : ` to version ${source.version}`}`,
          subject: { kind: "view-section", id: next.id, label: next.definition.title },
          payload: {
            version: next.version,
            fromVersion: source.version,
            before: existing,
            after: next,
          },
          writes: [{ write: { scope: "section", value: next }, counts: true }],
        });
      }),
    );

  // --- mission layout ---

  const layoutRef = (missionId: MissionId): MissionRecordRef => ({
    kind: "view-layout",
    id: missionId,
    label: "Mission layout",
  });

  const editLayout: Write<EditViewLayoutInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const current = yield* currentLayout(mission);
        yield* fence(current.layout.version, input.expectedVersion, "The mission layout");
        yield* spendBudget(caller, mission.id, current.layout.layout.limits);
        const starter = ViewStore.currentStarter(yield* views.starters);
        const sections = yield* views.sections(mission.id);
        const applied = applyLayoutOps(current.layout.layout, input.ops, {
          starter: starter.layout,
          sectionTitle: (id) => sections.find((section) => section.id === id)?.definition.title,
        });
        const issues = [
          ...applied.issues,
          ...checkLayout(applied.layout, {
            sectionIds: new Set(sections.map((section) => section.id)),
          }),
        ];
        if (issues.length > 0) return yield* refuse(issues);

        const now = yield* nowIso;
        const reset = input.ops.some((op) => op._tag === "reset");
        const next: ViewLayout = {
          missionId: mission.id,
          layout: applied.layout,
          ...changeMeta(caller, current.layout.version + 1, now, input.changeNote),
          seededFrom: reset ? starter.version : current.layout.seededFrom,
        };
        const { pinned, note } = pinnedNote(next.layout, yield* waiting(mission.id));
        return yield* commit({
          missionId: mission.id,
          kind: "view.layout-changed",
          caller,
          summary: `${who(caller)} ${applied.changes.join(", ")}${note}`,
          subject: layoutRef(mission.id),
          payload: { before: current.layout, after: next, changes: applied.changes, pinned },
          writes: layoutWrites(current, next, true),
        });
      }),
    );

  const restoreLayout: Write<RestoreViewLayoutInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const current = yield* currentLayout(mission);
        yield* spendBudget(caller, mission.id, current.layout.layout.limits);
        const stored = yield* views.layoutVersions(mission.id);
        const versions = stored.length > 0 ? stored : [current.layout];
        const source = versions.find((version) => version.version === input.toVersion);
        if (source === undefined) {
          return yield* fail("not-found", `The mission layout has no version ${input.toVersion}.`);
        }
        if (source.version === current.layout.version) {
          return yield* fail(
            "invalid",
            `The mission layout is already at version ${source.version}.`,
          );
        }
        const sections = yield* views.sections(mission.id);
        const issues = checkLayout(source.layout, {
          sectionIds: new Set(sections.map((section) => section.id)),
        });
        if (issues.length > 0) return yield* refuse(issues);
        const now = yield* nowIso;
        const next: ViewLayout = {
          missionId: mission.id,
          layout: source.layout,
          ...changeMeta(
            caller,
            current.layout.version + 1,
            now,
            input.changeNote ?? `Restored version ${source.version}.`,
          ),
          seededFrom: source.seededFrom,
        };
        const { pinned, note } = pinnedNote(next.layout, yield* waiting(mission.id));
        return yield* commit({
          missionId: mission.id,
          kind: "view.layout-restored",
          caller,
          summary: `${who(caller)} restored the mission layout to version ${source.version}${note}`,
          subject: layoutRef(mission.id),
          payload: {
            version: next.version,
            fromVersion: source.version,
            before: current.layout,
            after: next,
            pinned,
          },
          writes: layoutWrites(current, next, true),
        });
      }),
    );

  // --- starter layout ---

  const starterRef: MissionRecordRef = {
    kind: "view-starter-layout",
    id: ViewStore.STARTER_ID,
    label: "Starter layout",
  };

  const editStarter: Write<EditStarterLayoutInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const caller = yield* starterEditor(provenance);
        const current = ViewStore.currentStarter(yield* views.starters);
        yield* fence(current.version, input.expectedVersion, "The starter layout");
        const applied = applyLayoutOps(current.layout, input.ops, {
          starter: null,
          sectionTitle: () => undefined,
        });
        const issues = [...applied.issues, ...checkLayout(applied.layout, { sectionIds: null })];
        if (issues.length > 0) return yield* refuse(issues);
        const now = yield* nowIso;
        const next: ViewStarterLayout = {
          layout: applied.layout,
          ...changeMeta(caller, current.version + 1, now, input.changeNote),
        };
        return yield* commit({
          missionId: GLOBAL_TIMELINE,
          kind: "view.starter-layout-changed",
          caller,
          summary: `${who(caller)} changed the starter layout for new missions: ${applied.changes.join(", ")}`,
          subject: starterRef,
          payload: { before: current, after: next, changes: applied.changes },
          writes: [{ write: { scope: "starter", value: next }, counts: true }],
        });
      }),
    );

  const restoreStarter: Write<RestoreStarterLayoutInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const caller = yield* starterEditor(provenance);
        const stored = yield* views.starters;
        const current = ViewStore.currentStarter(stored);
        const source = ViewStore.starterHistory(stored).find(
          (version) => version.version === input.toVersion,
        );
        if (source === undefined) {
          return yield* fail("not-found", `The starter layout has no version ${input.toVersion}.`);
        }
        if (source.version === current.version) {
          return yield* fail(
            "invalid",
            `The starter layout is already at version ${source.version}.`,
          );
        }
        const now = yield* nowIso;
        const next: ViewStarterLayout = {
          layout: source.layout,
          ...changeMeta(
            caller,
            current.version + 1,
            now,
            input.changeNote ?? `Restored version ${source.version}.`,
          ),
        };
        return yield* commit({
          missionId: GLOBAL_TIMELINE,
          kind: "view.starter-layout-restored",
          caller,
          summary: `${who(caller)} restored the starter layout for new missions to version ${source.version}`,
          subject: starterRef,
          payload: {
            version: next.version,
            fromVersion: source.version,
            before: current,
            after: next,
          },
          writes: [{ write: { scope: "starter", value: next }, counts: true }],
        });
      }),
    );

  const seedLayout = (missionId: MissionId) =>
    serial(
      Effect.gen(function* () {
        const mission = Option.getOrNull(yield* store.get("mission", missionId));
        if (mission === null || (yield* views.layout(missionId)) !== null) return;
        const seed = seededLayout(mission, yield* views.starters);
        yield* views.write({ scope: "layout", value: seed }, { counts: false });
      }),
    );

  return ViewService.of({
    snapshot,
    catalog: Effect.succeed(VIEW_CATALOG),
    history,
    preview,
    resolveTemplate,
    waiting,
    defineTemplate,
    placeSection,
    remove,
    restore,
    editLayout,
    restoreLayout,
    editStarter,
    restoreStarter,
    seedLayout,
  });
});

export const layer = Layer.effect(ViewService, make);
