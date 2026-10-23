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
  VIEW_PATHS,
  VIEW_SOURCE_LIMITS,
  ViewSectionId,
  ViewTemplateId,
  formatViewIssues,
  isOwnerProvenance,
  selectViewTemplate,
  viewMatchSubjectOf,
  viewPinnedStrip,
  VIEW_ASSET_LIMITS,
  type AddMissionAssetInput,
  type ApplyViewBundleInput,
  type MissionAsset,
  type RemoveMissionAssetInput,
  type DefineViewTemplateInput,
  type EditStarterLayoutInput,
  type EditViewLayoutInput,
  type Mission,
  type MissionActor,
  type MissionAssetSource,
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
  type ViewLongText,
  type ViewLongTextInput,
  type ViewPathScope,
  type ViewPreview,
  type ViewSection,
  type ViewSectionData,
  type ViewStarterLayout,
  type ViewStatus,
  type ViewTemplate,
  type RemoveViewSourceInput,
  type RestoreViewSourceInput,
  type RunViewSourceInput,
  type SetViewSourceInput,
  type ViewDataSource,
  ViewDataSourceId,
  type ViewSourceDefinition,
  type ViewSourceListing,
  type ViewSourceRunResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../../config.ts";
import { snoozedNow, waitsOnOwner } from "../asks/inboxMarks.ts";
import { standingOf } from "../asks/standing.ts";
import { castOf } from "../core/master.ts";
import { actorOf } from "../core/provenance.ts";
import * as MissionService from "../MissionService.ts";
import { ScribeStore } from "../scribe/ScribeStore.ts";
import * as MissionStore from "../store/MissionStore.ts";
import {
  assetFilePath,
  deleteAssetFile,
  readAssetSource,
  writeAssetFile,
  type AssetBytes,
} from "./assets.ts";
import { applyLayoutOps, insertInRegion } from "./layoutOps.ts";
import { sectionData } from "./sectionRows.ts";
import { SourceService } from "./sources/SourceService.ts";
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
    /** Templates and sections (own or copied from another mission) in one change. */
    readonly applyBundle: Write<ApplyViewBundleInput>;
    readonly addAsset: Write<AddMissionAssetInput>;
    /**
     * The images in an owner request message, about that request, all read
     * and checked before any is written. The same image already stored for
     * the request is reused; `created` names the ones this call wrote.
     */
    readonly addRequestImages: (
      provenance: MissionProvenance,
      input: {
        readonly missionId: MissionId;
        readonly requestId: string;
        readonly sources: ReadonlyArray<MissionAssetSource>;
      },
    ) => Effect.Effect<
      {
        readonly images: ReadonlyArray<{ readonly assetId: string; readonly path: string }>;
        readonly created: ReadonlyArray<string>;
      },
      MissionError
    >;
    /** Drops request images whose message never landed. Best effort. */
    readonly dropRequestImages: (
      missionId: MissionId,
      assetIds: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    readonly removeAsset: Write<RemoveMissionAssetInput>;
    /** An archived mission's images go: records expire and the copies are deleted. */
    readonly expireAssets: (missionId: MissionId) => Effect.Effect<void, MissionError>;
    /** Rows of the given query sections, as the snapshot carries them. */
    readonly sectionData: (
      missionId: MissionId,
      sections: ReadonlyArray<ViewSection>,
    ) => Effect.Effect<ReadonlyArray<ViewSectionData>, MissionError>;
    /** A row's `longtext` value, which the snapshot leaves out. */
    readonly longText: (input: ViewLongTextInput) => Effect.Effect<ViewLongText, MissionError>;
    /** Mission ids, published after the scribe saves a report. */
    readonly reportSaves: Effect.Effect<PubSub.Subscription<string>, never, Scope.Scope>;
    readonly setSource: Write<SetViewSourceInput>;
    readonly removeSource: Write<RemoveViewSourceInput>;
    readonly restoreSource: Write<RestoreViewSourceInput>;
    /** Runs a source now, for its owner or master, and returns what it produced. */
    readonly runSource: (
      provenance: MissionProvenance,
      input: RunViewSourceInput,
    ) => Effect.Effect<ViewSourceRunResult, MissionError>;
    /** Mission ids, published when one of their source runs starts or finishes. */
    readonly sourceChanges: Effect.Effect<PubSub.Subscription<MissionId>, never, Scope.Scope>;
    /** Someone still has the views open: starts runs for stale sources without waiting. */
    readonly touchSources: (missionId: MissionId) => Effect.Effect<void, MissionError>;
  }
>()("t3/ardud/missions/views/ViewService") {}

const sourceListing = (source: ViewDataSource): ViewSourceListing => {
  const { definition, ...meta } = source;
  return {
    ...meta,
    title: definition.title,
    runtime: definition.runtime,
    fields: definition.fields,
    refreshMinutes: definition.refreshMinutes,
    timeoutSeconds: definition.timeoutSeconds,
    enabled: definition.enabled,
  };
};

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
  /** The mission whose change budget the caller spends: the master's own; null for the owner. */
  readonly metered: MissionId | null;
}

const OWNER_CALLER = (provenance: MissionProvenance): ViewCaller => ({
  provenance,
  actor: { _tag: "owner" },
  by: "owner",
  metered: null,
});

const WHO: Record<ViewAuthor, string> = {
  owner: "The owner",
  master: "The master",
  agent: "An agent",
  system: "The system",
};
const who = (caller: ViewCaller) => WHO[caller.by];

const SYSTEM_CALLER: ViewCaller = {
  provenance: { _tag: "system", component: "missions-views" },
  actor: SEED_ACTOR,
  by: "system",
  metered: null,
};

const prefixed = (prefix: string, issues: ReadonlyArray<ViewIssue>): Array<ViewIssue> =>
  issues.map((issue) => ({ ...issue, path: `${prefix}.${issue.path}` }));

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
  const scribe = yield* ScribeStore;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const runs = yield* SourceService;
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
        metered: missionId,
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

  /**
   * The owner, or the master of any mission (the starter affects every new
   * mission). A master is found through the calling thread's live bindings,
   * so the cost doesn't grow with the number of missions.
   */
  const starterEditor = (provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) return OWNER_CALLER(provenance);
      if (provenance._tag === "agent") {
        const bindings = yield* store.list("role-binding", { status: ["bound"], limit: 5000 });
        const missionIds = new Set<MissionId>();
        for (const binding of bindings) {
          if (binding.threadId !== provenance.threadId) continue;
          const role = Option.getOrNull(yield* store.get("role", binding.roleId));
          if (role !== null) missionIds.add(role.missionId);
        }
        for (const missionId of missionIds) {
          const master = yield* masterCaller(missionId, provenance);
          if (master !== null) return master;
        }
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

  /**
   * The master's daily budget: the limit set on its own mission's layout,
   * counting only the master's changes (starter edits included). The owner
   * is never metered and his edits don't spend it. A change that only sets
   * limits always goes through, so the master can raise the budget itself up
   * to the hard ceiling.
   */
  const spendBudget = (caller: ViewCaller, limitsOnly = false) =>
    Effect.gen(function* () {
      const metered = caller.metered;
      if (metered === null || limitsOnly) return;
      const mission = yield* requireMission(metered);
      const { layout } = yield* currentLayout(mission);
      const limit = layout.layout.limits.changesPerDay;
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
      const used = yield* views.changesSince(metered, since);
      if (used >= limit) {
        return yield* fail(
          "invalid",
          `view change budget used today (${used} of ${limit}); raise it with a limits change on the mission layout`,
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
          (pending) =>
            views.write(pending.write, {
              counts: pending.counts,
              meteredMission: pending.counts ? input.caller.metered : null,
            }),
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
      // ardud missions: fix-p3 (snoozed items wait again only when the snooze ends)
      const snoozed = yield* snoozedNow(store, missionId, yield* nowIso);
      const asleep = [...snoozed.values()].filter((item) => waitsOnOwner(item.kind, item.record));
      const counts: ViewWaiting = {
        ownerWaiting: Math.max(0, decide + approve + knocks + suggestions - asleep.length),
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

  const allSectionData = Effect.fn("ViewService.allSectionData")(function* (
    missionId: MissionId,
    sections: ReadonlyArray<ViewSection>,
    sources: ReadonlyArray<ViewDataSource>,
  ) {
    const queried = yield* sectionData({ store, scribe }, missionId, sections);
    return [...queried, ...(yield* runs.sectionData(sections, sources))];
  });

  // Reading the views counts as someone looking, which is what lets a stale source run.
  const snapshot = (missionId: MissionId) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(missionId);
      const sources = yield* views.sources(mission.id);
      yield* runs.touch(mission.id, sources);
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
        sectionData: yield* allSectionData(mission.id, sections, sources),
        // Request images are part of the owner's words, which only the owner
        // and the master read, through the request itself.
        assets: (yield* views.assets(mission.id)).filter(
          (asset) => asset.status === "active" && asset.subject?.kind !== "owner-request",
        ),
        sources: sources.map(sourceListing),
        sourceRuns: yield* runs.runs(mission.id, sources),
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
        case "source": {
          const versions = (yield* views.sourceVersions(target.id)).filter(
            (version) => version.missionId === input.missionId,
          );
          if (versions.length === 0) {
            return yield* fail("not-found", `No view source ${target.id} in this mission.`);
          }
          const entries = versions.map((v) => historyEntry(v, v.status, v.definition));
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
        sources: yield* views.sources(mission.id),
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
        yield* spendBudget(caller);

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
        yield* spendBudget(caller);

        const templates = yield* views.templates(mission.id);
        const siblings = sections.filter((section) => section.id !== existing?.id);
        const check = checkSection(input.definition, {
          siblings,
          sources: yield* views.sources(mission.id),
        });
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
        const clash = entries.find(
          (entry) =>
            entry.key === input.definition.key &&
            !(entry.section._tag === "custom" && entry.section.sectionId === id),
        );
        if (placed === undefined && existing === undefined && clash !== undefined) {
          issues.push({
            path: "definition.key",
            code: "duplicate",
            detail: `the mission layout already has an entry keyed ${clash.key}; pick another key`,
          });
        }
        const moves = input.region !== undefined || input.index !== undefined;
        let nextEntries: ReadonlyArray<ViewLayoutEntry> = entries;
        // A new section joins the layout; an update only moves it when asked, so
        // an entry the layout removed stays off the page.
        if ((placed === undefined && existing === undefined) || moves) {
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
          yield* spendBudget(caller);
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
        yield* spendBudget(caller);
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
        yield* spendBudget(caller);
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
          yield* fence(existing.version, input.expectedVersion, "This card template");
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
        yield* fence(existing.version, input.expectedVersion, "This section");
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
        const check = checkSection(source.definition, {
          siblings,
          sources: yield* views.sources(mission.id),
        });
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
        yield* spendBudget(
          caller,
          input.ops.every((op) => op._tag === "limits"),
        );
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
        yield* fence(current.layout.version, input.expectedVersion, "The mission layout");
        yield* spendBudget(caller);
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
        yield* spendBudget(caller);
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
        yield* fence(current.version, input.expectedVersion, "The starter layout");
        yield* spendBudget(caller);
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
        yield* views.write(
          { scope: "layout", value: seed },
          { counts: false, meteredMission: null },
        );
      }),
    );

  // --- bundles ---

  /** Another mission's active templates and sections, by key. */
  const copiesFrom = (
    into: MissionId,
    from: NonNullable<ApplyViewBundleInput["copyFrom"]>,
    issues: Array<ViewIssue>,
  ) =>
    Effect.gen(function* () {
      if (from.missionId === into) {
        return yield* fail("invalid", "copyFrom names this mission; copy from another one");
      }
      const source = yield* requireMission(from.missionId);
      const templates = (yield* views.templates(source.id)).filter((t) => t.status === "active");
      const sections = (yield* views.sections(source.id)).filter((s) => s.status === "active");
      const pick = <T>(
        items: ReadonlyArray<T>,
        keys: ReadonlyArray<string> | undefined,
        keyOf: (item: T) => string,
        what: string,
      ) =>
        keys === undefined
          ? items
          : keys.flatMap((key) => {
              const found = items.find((item) => keyOf(item) === key);
              if (found === undefined) {
                issues.push({
                  path: `copyFrom.${what}Keys`,
                  code: "field",
                  detail: `${source.title} has no active ${what} keyed ${key}`,
                });
              }
              return found === undefined ? [] : [found];
            });
      // Sections that name the source's own records, sub-missions or lanes mean
      // nothing here: skipped when copying everything, refused when named.
      const portable = (section: ViewSection) => {
        const definition = section.definition;
        if (definition.source._tag !== "query") return false;
        const where = definition.source.query.where;
        return (
          (definition.subMissionId ?? null) === null &&
          where?.subMissionId === undefined &&
          where?.laneId === undefined
        );
      };
      const pickedSections = pick(
        from.sectionKeys === undefined ? sections.filter(portable) : sections,
        from.sectionKeys,
        (section) => section.definition.key,
        "section",
      );
      for (const section of pickedSections) {
        if (!portable(section)) {
          issues.push({
            path: "copyFrom.sectionKeys",
            code: "field",
            detail: `section ${section.definition.key} points at ${source.title}'s own records`,
          });
        }
      }
      const local = (template: ViewTemplate) =>
        template.definition.match?.subMissionId !== undefined;
      const pickedTemplates = pick(
        from.templateKeys === undefined ? templates.filter((t) => !local(t)) : templates,
        from.templateKeys,
        (template) => template.definition.key,
        "template",
      );
      for (const template of pickedTemplates) {
        if (local(template)) {
          issues.push({
            path: "copyFrom.templateKeys",
            code: "field",
            detail: `template ${template.definition.key} matches ${source.title}'s own sub-missions`,
          });
        }
      }
      return {
        title: source.title,
        templates: pickedTemplates.map((template) => ({ definition: template.definition })),
        sections: pickedSections.map((section) => ({ definition: section.definition })),
      };
    });

  const applyBundle: Write<ApplyViewBundleInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const issues: Array<ViewIssue> = [];
        const copied =
          input.copyFrom === undefined
            ? null
            : yield* copiesFrom(mission.id, input.copyFrom, issues);
        const wantedTemplates = [...(copied?.templates ?? []), ...input.templates];
        const wantedSections = [...(copied?.sections ?? []), ...input.sections];
        if (wantedTemplates.length === 0 && wantedSections.length === 0) {
          return yield* fail("invalid", "a bundle needs at least one template or section");
        }
        const current = yield* currentLayout(mission);
        const limits = current.layout.layout.limits;
        yield* spendBudget(caller);
        const now = yield* nowIso;
        const templates = yield* views.templates(mission.id);
        const sections = yield* views.sections(mission.id);

        let nextTemplates: Array<ViewTemplate> = [...templates];
        const templateChanges: Array<{ before: ViewTemplate | null; after: ViewTemplate }> = [];
        wantedTemplates.forEach((item, index) => {
          const at = `templates[${index}]`;
          const templateId = "templateId" in item ? item.templateId : undefined;
          if (templateId?.startsWith(BUILTIN_VIEW_TEMPLATE_PREFIX) === true) {
            issues.push({ path: at, code: "guard", detail: "built-in templates can't be edited" });
            return;
          }
          const existing =
            templateId !== undefined
              ? templates.find((template) => template.id === templateId)
              : templates.find((template) => template.definition.key === item.definition.key);
          if (existing?.status === "removed") {
            issues.push({
              path: at,
              code: "guard",
              detail: `${existing.definition.name} is removed; restore it first`,
            });
            return;
          }
          const siblings = nextTemplates.filter((template) => template.id !== existing?.id);
          issues.push(...prefixed(at, checkTemplate(item.definition, { siblings }).issues));
          const after: ViewTemplate = {
            id: existing?.id ?? templateId ?? ViewTemplateId.make(newId("view-template")),
            missionId: mission.id,
            definition: item.definition,
            ...changeMeta(caller, (existing?.version ?? 0) + 1, now, input.changeNote),
            catalogVersion: VIEW_CATALOG_VERSION,
            status: "active",
            createdAt: existing?.createdAt ?? now,
            createdBy: existing?.createdBy ?? caller.by,
          };
          nextTemplates = [...siblings, after];
          templateChanges.push({ before: existing ?? null, after });
        });

        let nextSections: Array<ViewSection> = [...sections];
        const bundleSources = yield* views.sources(mission.id);
        let entries = current.layout.layout.entries;
        const sectionChanges: Array<{ before: ViewSection | null; after: ViewSection }> = [];
        wantedSections.forEach((item, index) => {
          const at = `sections[${index}]`;
          const sectionId = "sectionId" in item ? item.sectionId : undefined;
          const region = "region" in item ? item.region : undefined;
          const existing =
            sectionId !== undefined
              ? sections.find((section) => section.id === sectionId)
              : sections.find((section) => section.definition.key === item.definition.key);
          if (existing?.status === "removed") {
            issues.push({
              path: at,
              code: "guard",
              detail: `${existing.definition.title} is removed; restore it first`,
            });
            return;
          }
          const siblings = nextSections.filter((section) => section.id !== existing?.id);
          issues.push(
            ...prefixed(
              at,
              checkSection(item.definition, { siblings, sources: bundleSources }).issues,
            ),
          );
          const id = existing?.id ?? sectionId ?? ViewSectionId.make(newId("view-section"));
          const placed = entries.find(
            (entry) => entry.section._tag === "custom" && entry.section.sectionId === id,
          );
          if (placed === undefined && existing === undefined) {
            if (entries.some((entry) => entry.key === item.definition.key)) {
              issues.push({
                path: `${at}.definition.key`,
                code: "duplicate",
                detail: `the mission layout already has an entry keyed ${item.definition.key}`,
              });
            }
            entries = insertInRegion(
              entries,
              {
                key: item.definition.key,
                section: { _tag: "custom", sectionId: id },
                region: region ?? "main",
                hidden: false,
                title: null,
              },
              undefined,
            );
          } else if (placed !== undefined && region !== undefined && placed.region !== region) {
            entries = insertInRegion(
              entries.filter((entry) => entry !== placed),
              { ...placed, region },
              undefined,
            );
          }
          const after: ViewSection = {
            id,
            missionId: mission.id,
            definition: item.definition,
            ...changeMeta(caller, (existing?.version ?? 0) + 1, now, input.changeNote),
            catalogVersion: VIEW_CATALOG_VERSION,
            status: "active",
            createdAt: existing?.createdAt ?? now,
            createdBy: existing?.createdBy ?? caller.by,
          };
          nextSections = [...siblings, after];
          sectionChanges.push({ before: existing ?? null, after });
        });

        const activeTemplates = nextTemplates.filter((template) => template.status === "active");
        const activeSections = nextSections.filter((section) => section.status === "active");
        if (activeTemplates.length > limits.templates) {
          issues.push({
            path: "templates",
            code: "limit",
            detail: `this mission would have ${activeTemplates.length} of ${limits.templates} card templates`,
          });
        }
        if (activeSections.length > limits.sections) {
          issues.push({
            path: "sections",
            code: "limit",
            detail: `this mission would have ${activeSections.length} of ${limits.sections} sections`,
          });
        }
        const bytes = missionBytesIssue(activeTemplates, activeSections, null, 0);
        if (bytes !== null) issues.push(bytes);
        const nextLayout: ViewLayoutDefinition = { entries, limits };
        const moved = entries !== current.layout.layout.entries;
        if (moved) {
          issues.push(
            ...checkLayout(nextLayout, {
              sectionIds: new Set(nextSections.map((section) => section.id)),
            }),
          );
        }
        if (issues.length > 0) return yield* refuse(issues);

        // One change against the budget, however many records it writes.
        const writes: Array<PendingWrite> = [
          ...templateChanges.map((change) => ({
            write: { scope: "template" as const, value: change.after },
            counts: false,
          })),
          ...sectionChanges.map((change) => ({
            write: { scope: "section" as const, value: change.after },
            counts: false,
          })),
        ];
        if (moved) {
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
        writes[0] = { ...writes[0]!, counts: true };
        const parts = [
          ...(templateChanges.length === 0
            ? []
            : [
                `${templateChanges.length} card template${templateChanges.length === 1 ? "" : "s"}`,
              ]),
          ...(sectionChanges.length === 0
            ? []
            : [`${sectionChanges.length} section${sectionChanges.length === 1 ? "" : "s"}`]),
        ];
        const from = copied === null ? "" : ` from ${copied.title}`;
        return yield* commit({
          missionId: mission.id,
          kind: "view.bundle-applied",
          caller,
          summary: `${who(caller)} applied ${parts.join(" and ")}${from}`,
          subject: layoutRef(mission.id),
          payload: {
            templates: templateChanges,
            sections: sectionChanges,
            copyFrom: input.copyFrom ?? null,
          },
          writes,
        });
      }),
    );

  // --- assets ---

  /** The owner, the master, or an agent holding a role or lane in the mission. */
  const memberCaller = (missionId: MissionId, provenance: MissionProvenance) =>
    Effect.gen(function* () {
      if (isOwnerProvenance(provenance)) return OWNER_CALLER(provenance);
      if (provenance._tag !== "agent") return null;
      const cast = yield* castOf(store, missionId);
      if (cast.mission === null) return null;
      const standing = standingOf(cast, provenance);
      if (!standing.isMaster && standing.roles.length === 0 && standing.lanes.length === 0) {
        return null;
      }
      const caller: ViewCaller = {
        provenance: standing.caller.provenance,
        actor: actorOf(standing.caller.provenance),
        by: standing.isMaster ? "master" : "agent",
        metered: null,
      };
      return caller;
    });

  const sameActor = (left: MissionActor, right: MissionActor) =>
    JSON.stringify(left) === JSON.stringify(right);

  const assetRef = (asset: Pick<MissionAsset, "id" | "name">): MissionRecordRef => ({
    kind: "view-asset",
    id: asset.id,
    label: asset.name,
  });

  const requestImage = (asset: Pick<MissionAsset, "subject">) =>
    asset.subject?.kind === "owner-request";

  // Every reader sees mission events, and an attachment id is enough to fetch the
  // file, so events about his request images never carry their ids.
  const assetEvent = (asset: MissionAsset) =>
    requestImage(asset)
      ? {
          subject: { kind: "mission", id: asset.missionId } satisfies MissionRecordRef,
          payload: { kind: asset.kind, sizeBytes: asset.sizeBytes },
        }
      : {
          subject: assetRef(asset),
          payload: { assetId: asset.id, kind: asset.kind, sizeBytes: asset.sizeBytes },
        };

  /** The live mission and a caller allowed to add images to it. */
  const assetCaller = Effect.fn("ViewService.assetCaller")(function* (
    missionId: MissionId,
    provenance: MissionProvenance,
  ) {
    const mission = yield* requireMission(missionId);
    if (mission.status === "archived") {
      return yield* fail("invalid", "This mission is archived.");
    }
    const caller = yield* memberCaller(mission.id, provenance);
    if (caller === null) {
      return yield* fail("forbidden", "Only the owner and the mission's agents can add images.");
    }
    return { mission, caller };
  });

  const saveAsset = Effect.fn("ViewService.saveAsset")(function* (
    missionId: MissionId,
    caller: ViewCaller,
    read: AssetBytes,
    subject: MissionRecordRef | null,
    summary: string = `${who(caller)} added image ${read.name}`,
  ) {
    const stored = (yield* views.assets(missionId)).filter((asset) => asset.status === "active");
    const used = stored.reduce((sum, asset) => sum + asset.sizeBytes, 0);
    if (used + read.bytes.byteLength > VIEW_ASSET_LIMITS.missionBytes) {
      return yield* fail("invalid", "This mission's images would pass its 2 GiB limit.");
    }
    const now = yield* nowIso;
    const asset: MissionAsset = {
      id: `mission-${NodeCrypto.randomUUID()}`,
      missionId,
      subject,
      kind: "image",
      mimeType: read.mimeType,
      sizeBytes: read.bytes.byteLength,
      width: read.width,
      height: read.height,
      name: read.name,
      sha256: read.sha256,
      addedBy: caller.actor,
      status: "active",
      version: 1,
      createdAt: now,
      changedAt: now,
    };
    const path = assetFilePath(attachmentsDir, asset);
    yield* writeAssetFile(path, read.bytes);
    const event = assetEvent(asset);
    const result = yield* commit({
      missionId,
      kind: "view.asset-added",
      caller,
      summary,
      subject: event.subject,
      payload: requestImage(asset) ? event.payload : { ...event.payload, subject: asset.subject },
      writes: [{ write: { scope: "asset", value: asset }, counts: false }],
    }).pipe(Effect.onError(() => deleteAssetFile(path)));
    return { asset, path, result };
  });

  const addAsset: Write<AddMissionAssetInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const { mission, caller } = yield* assetCaller(input.missionId, provenance);
        const read = yield* readAssetSource({
          attachmentsDir,
          source: input.source,
          provenance,
          name: input.name,
        });
        const saved = yield* saveAsset(mission.id, caller, read, input.subject ?? null);
        return saved.result;
      }),
    );

  /** Marks request images removed and deletes their copies, under the lock. */
  const dropRequestImagesLocked = Effect.fn("ViewService.dropRequestImages")(function* (
    missionId: MissionId,
    assetIds: ReadonlyArray<string>,
  ) {
    if (assetIds.length === 0) return;
    const drop = new Set(assetIds);
    const gone = (yield* views.assets(missionId)).filter(
      (asset) => drop.has(asset.id) && asset.status === "active" && requestImage(asset),
    );
    if (gone.length === 0) return;
    const now = yield* nowIso;
    yield* commit({
      missionId,
      kind: "view.asset-removed",
      caller: SYSTEM_CALLER,
      summary: `${gone.length} request image${gone.length === 1 ? "" : "s"} dropped with an unsent message`,
      subject: { kind: "mission", id: missionId },
      payload: { kind: "image", count: gone.length },
      writes: gone.map((asset) => ({
        write: {
          scope: "asset" as const,
          value: {
            ...asset,
            status: "removed" as const,
            version: asset.version + 1,
            changedAt: now,
          },
        },
        counts: false,
      })),
    });
    yield* Effect.forEach(gone, (asset) => deleteAssetFile(assetFilePath(attachmentsDir, asset)), {
      discard: true,
    });
  });

  const dropRequestImages: ViewService["Service"]["dropRequestImages"] = (missionId, assetIds) =>
    serial(dropRequestImagesLocked(missionId, assetIds)).pipe(Effect.ignore);

  const addRequestImages: ViewService["Service"]["addRequestImages"] = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const { mission, caller } = yield* assetCaller(input.missionId, provenance);
        // The app sends uploads; server paths come from the iMessage desk and agents.
        if (
          provenance._tag === "owner-app" &&
          input.sources.some((source) => source._tag === "file")
        ) {
          return yield* fail("invalid", "Attach images from the app as uploads, not server paths.");
        }
        // Every image is read and checked first, so a bad one stores none.
        // His file names can say as much as his words, so the copies go unnamed.
        const reads = yield* Effect.forEach(input.sources, (source) =>
          readAssetSource({ attachmentsDir, source, provenance, name: "Request image" }),
        );
        const subject: MissionRecordRef = { kind: "owner-request", id: input.requestId };
        const stored = (yield* views.assets(mission.id)).filter(
          (asset) => asset.status === "active",
        );
        // A retried message stores nothing new, so it writes the same text.
        const sameAs = (sha256: string) =>
          stored.find(
            (asset) =>
              asset.sha256 === sha256 &&
              asset.subject?.kind === subject.kind &&
              asset.subject.id === subject.id,
          );
        const fresh = new Map<string, AssetBytes>();
        for (const read of reads) {
          if (sameAs(read.sha256) === undefined) fresh.set(read.sha256, read);
        }
        const used = stored.reduce((sum, asset) => sum + asset.sizeBytes, 0);
        const adding = [...fresh.values()].reduce((sum, read) => sum + read.bytes.byteLength, 0);
        if (used + adding > VIEW_ASSET_LIMITS.missionBytes) {
          return yield* fail("invalid", "This mission's images would pass its 2 GiB limit.");
        }
        const created: Array<string> = [];
        const saved = new Map<string, { assetId: string; path: string }>();
        yield* Effect.forEach(
          fresh.values(),
          (read) =>
            Effect.map(
              saveAsset(
                mission.id,
                caller,
                read,
                subject,
                `${who(caller)} attached an image to a request`,
              ),
              (each) => {
                created.push(each.asset.id);
                saved.set(read.sha256, { assetId: each.asset.id, path: each.path });
              },
            ),
          { discard: true },
        ).pipe(
          Effect.onError(() => dropRequestImagesLocked(mission.id, created).pipe(Effect.ignore)),
        );
        const images = reads.map((read) => {
          const same = sameAs(read.sha256);
          return same === undefined
            ? saved.get(read.sha256)!
            : { assetId: same.id, path: assetFilePath(attachmentsDir, same) };
        });
        return { images, created };
      }),
    );

  const removeAsset: Write<RemoveMissionAssetInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const asset = (yield* views.assets(mission.id)).find((a) => a.id === input.assetId);
        if (asset === undefined || asset.status !== "active") {
          return yield* fail("not-found", `No image ${input.assetId} in this mission.`);
        }
        const member = yield* memberCaller(mission.id, provenance);
        if (member === null || (member.by === "agent" && !sameActor(member.actor, asset.addedBy))) {
          return yield* fail(
            "forbidden",
            "Only the owner, the master or whoever added it can remove an image.",
          );
        }
        const now = yield* nowIso;
        const removed: MissionAsset = {
          ...asset,
          status: "removed",
          version: asset.version + 1,
          changedAt: now,
        };
        const note = input.reason === undefined ? "" : `: ${input.reason}`;
        const event = assetEvent(asset);
        const result = yield* commit({
          missionId: mission.id,
          kind: "view.asset-removed",
          caller: member,
          summary: `${who(member)} removed image ${asset.name}${note}`,
          subject: event.subject,
          payload: event.payload,
          writes: [{ write: { scope: "asset", value: removed }, counts: false }],
        });
        yield* deleteAssetFile(assetFilePath(attachmentsDir, asset));
        return result;
      }),
    );

  const expireAssets = (missionId: MissionId) =>
    serial(
      Effect.gen(function* () {
        const active = (yield* views.assets(missionId)).filter(
          (asset) => asset.status === "active",
        );
        if (active.length === 0) return;
        const now = yield* nowIso;
        yield* commit({
          missionId,
          kind: "view.assets-expired",
          caller: SYSTEM_CALLER,
          summary: `${active.length} image${active.length === 1 ? "" : "s"} expired with the mission`,
          subject: { kind: "mission", id: missionId },
          payload: {
            assetIds: active.filter((asset) => !requestImage(asset)).map((asset) => asset.id),
          },
          writes: active.map((asset) => ({
            write: {
              scope: "asset" as const,
              value: {
                ...asset,
                status: "expired" as const,
                version: asset.version + 1,
                changedAt: now,
              },
            },
            counts: false,
          })),
        });
        yield* Effect.forEach(
          active,
          (asset) => deleteAssetFile(assetFilePath(attachmentsDir, asset)),
          { discard: true },
        );
      }),
    );

  const longText = Effect.fn("ViewService.longText")(function* (input: ViewLongTextInput) {
    const mission = yield* requireMission(input.missionId);
    const scope = input.ref.kind as ViewPathScope;
    const kind = Object.hasOwn(VIEW_PATHS, scope) ? VIEW_PATHS[scope][input.path] : undefined;
    if (kind !== "longtext") {
      return yield* fail("invalid", `${input.ref.kind} rows have no long text ${input.path}`);
    }
    const max = VIEW_HARD_LIMITS.longTextChars;
    // Reports are the only rows with long text today.
    const found = yield* scribe.reportText(mission.id, input.ref.id, max).pipe(Effect.orDie);
    if (found === null)
      return yield* fail("not-found", `No report ${input.ref.id} in this mission.`);
    const result: ViewLongText = {
      ref: input.ref,
      path: input.path,
      text: found.text,
      size: found.size,
      truncated: found.size > max,
    };
    return result;
  });

  const findSource = Effect.fn("ViewService.findSource")(function* (
    missionId: MissionId,
    sourceId: ViewDataSourceId,
  ) {
    const sources = yield* views.sources(missionId);
    const existing = sources.find((source) => source.id === sourceId);
    if (existing === undefined) {
      return yield* fail("not-found", `No view source ${sourceId} in this mission.`);
    }
    return { existing, sources };
  });

  const activeSourceLimit = (sources: ReadonlyArray<ViewDataSource>) =>
    sources.filter((source) => source.status === "active").length >=
    VIEW_SOURCE_LIMITS.sourcesPerMission
      ? fail("invalid", `A mission holds at most ${VIEW_SOURCE_LIMITS.sourcesPerMission} sources.`)
      : Effect.void;

  const sourceWrite = (source: ViewDataSource): PendingWrite => ({
    write: { scope: "source", value: source },
    counts: true,
  });

  const setSource: Write<SetViewSourceInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const found =
          input.sourceId === undefined ? null : yield* findSource(mission.id, input.sourceId);
        const existing = found?.existing;
        const sources = found?.sources ?? (yield* views.sources(mission.id));
        if (existing?.status === "removed") {
          return yield* fail(
            "conflict",
            `Source ${existing.definition.title} is removed; restore it before changing it.`,
          );
        }
        if (existing === undefined) yield* activeSourceLimit(sources);
        const title = input.title ?? existing?.definition.title;
        const runtime = input.runtime ?? existing?.definition.runtime;
        const code = input.code ?? existing?.definition.code;
        const fields = input.fields ?? existing?.definition.fields;
        if (
          title === undefined ||
          runtime === undefined ||
          code === undefined ||
          fields === undefined
        ) {
          return yield* fail("invalid", "A new source needs title, runtime, code and fields.");
        }
        if (Object.hasOwn(fields, "id")) {
          return yield* fail(
            "invalid",
            "Every row has an id already; don't declare it as a field.",
          );
        }
        yield* fence(existing?.version ?? 0, input.expectedVersion, "This source");
        yield* spendBudget(caller);
        const definition: ViewSourceDefinition = {
          title,
          runtime,
          code,
          fields,
          refreshMinutes: input.refreshMinutes ?? existing?.definition.refreshMinutes ?? 15,
          timeoutSeconds: input.timeoutSeconds ?? existing?.definition.timeoutSeconds ?? 30,
          enabled: input.enabled ?? existing?.definition.enabled ?? true,
        };
        const now = yield* nowIso;
        const id = existing?.id ?? ViewDataSourceId.make(newId("view-source"));
        const source: ViewDataSource = {
          id,
          missionId: mission.id,
          definition,
          ...changeMeta(caller, (existing?.version ?? 0) + 1, now, input.changeNote),
          catalogVersion: VIEW_CATALOG_VERSION,
          status: "active",
          createdAt: existing?.createdAt ?? now,
          createdBy: existing?.createdBy ?? caller.by,
        };
        const verb = existing === undefined ? "added" : "updated";
        return yield* commit({
          missionId: mission.id,
          kind: "view.source-set",
          caller,
          summary: `${who(caller)} ${verb} view source ${title} (v${source.version})`,
          subject: { kind: "view-source", id, label: title },
          // The code stays out of the timeline; history has it.
          payload: {
            before: existing === undefined ? null : sourceListing(existing),
            after: sourceListing(source),
            codeChanged: existing !== undefined && existing.definition.code !== code,
          },
          writes: [sourceWrite(source)],
        });
      }),
    );

  const removeSource: Write<RemoveViewSourceInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const { existing } = yield* findSource(mission.id, input.sourceId);
        const title = existing.definition.title;
        if (existing.status === "removed") {
          return yield* fail("conflict", `Source ${title} is already removed.`);
        }
        yield* fence(existing.version, input.expectedVersion, "This source");
        yield* spendBudget(caller);
        const now = yield* nowIso;
        const next: ViewDataSource = {
          ...existing,
          ...changeMeta(caller, existing.version + 1, now, input.reason),
          status: "removed",
        };
        return yield* commit({
          missionId: mission.id,
          kind: "view.source-removed",
          caller,
          summary: `${who(caller)} removed view source ${title}`,
          subject: { kind: "view-source", id: existing.id, label: title },
          payload: { version: next.version, reason: input.reason ?? null },
          writes: [sourceWrite(next)],
        });
      }),
    );

  const restoreSource: Write<RestoreViewSourceInput> = (provenance, input) =>
    serial(
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        const caller = yield* editorOf(mission.id, provenance);
        const { existing, sources } = yield* findSource(mission.id, input.sourceId);
        const title = existing.definition.title;
        const from =
          input.toVersion === undefined
            ? existing
            : (yield* views.sourceVersions(existing.id)).find(
                (version) => version.version === input.toVersion,
              );
        if (from === undefined) {
          return yield* fail("not-found", `Source ${title} has no version ${input.toVersion}.`);
        }
        if (input.toVersion === undefined && existing.status === "active") {
          return yield* fail(
            "invalid",
            `Source ${title} is active; pass toVersion to roll it back.`,
          );
        }
        if (existing.status === "removed") yield* activeSourceLimit(sources);
        yield* fence(existing.version, input.expectedVersion, "This source");
        yield* spendBudget(caller);
        const now = yield* nowIso;
        const note =
          input.changeNote ??
          (input.toVersion === undefined ? "Restored." : `Restored version ${from.version}.`);
        const next: ViewDataSource = {
          ...existing,
          definition: from.definition,
          ...changeMeta(caller, existing.version + 1, now, note),
          status: "active",
        };
        return yield* commit({
          missionId: mission.id,
          kind: "view.source-restored",
          caller,
          summary: `${who(caller)} restored view source ${next.definition.title}${input.toVersion === undefined ? "" : ` to version ${from.version}`}`,
          subject: { kind: "view-source", id: existing.id, label: next.definition.title },
          payload: { version: next.version, fromVersion: from.version },
          writes: [sourceWrite(next)],
        });
      }),
    );

  // Not under `serial`: a run can take a minute and must not hold up view edits.
  const runSource = Effect.fn("ViewService.runSource")(function* (
    provenance: MissionProvenance,
    input: RunViewSourceInput,
  ) {
    const mission = yield* requireMission(input.missionId);
    yield* editorOf(mission.id, provenance);
    const { existing } = yield* findSource(mission.id, input.sourceId);
    const title = existing.definition.title;
    if (existing.status === "removed") {
      return yield* fail("conflict", `Source ${title} is removed; restore it first.`);
    }
    if (!existing.definition.enabled) {
      return yield* fail("invalid", `Source ${title} is disabled; enable it first.`);
    }
    return yield* runs.run(existing, "manual");
  });

  return ViewService.of({
    snapshot,
    sectionData: (missionId, sections) =>
      Effect.flatMap(views.sources(missionId), (sources) =>
        allSectionData(missionId, sections, sources),
      ),
    setSource,
    removeSource,
    restoreSource,
    runSource,
    sourceChanges: runs.changes,
    touchSources: (missionId) =>
      Effect.flatMap(views.sources(missionId), (sources) => runs.touch(missionId, sources)),
    longText,
    reportSaves: scribe.reportSaves,
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
    applyBundle,
    addAsset,
    addRequestImages,
    dropRequestImages,
    removeAsset,
    expireAssets,
  });
});

export const layer = Layer.effect(ViewService, make);
