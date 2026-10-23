import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  isOwnerProvenance,
  MissionError,
  MissionId,
  Note,
  Suggestion,
  type MissionActor,
  type MissionEvent,
  type MissionProvenance,
} from "@t3tools/contracts";

import { standingOf } from "../asks/standing.ts";
import { castOf } from "../core/master.ts";
import { actorOf } from "../core/provenance.ts";
import { MissionStore, type MissionCommit } from "../store/MissionStore.ts";
import { assembleBatch, type BatchStats, type ScribeBatchInput } from "./batch.ts";
import {
  buildEditorInput,
  checkEditorOutput,
  type EditorFeedItem,
  type EditorInput,
  type EditorState,
  type EditorSuggestionDraft,
  readEditorState,
} from "./editor.ts";
import { currentNotes, fyiScore, rankFyi } from "./notes.ts";
import { type BuiltReport, buildReport, type OpenItem, type ReportKind } from "./reports.ts";
import { dayWindow, reportPeriod, reportTitle, reportZone } from "./reportTime.ts";
import {
  REPORT_HEAD_CHARS,
  type ReportAuthor,
  reportIdOf,
  ScribeStore,
  type ScribeStoreError,
  toJson,
} from "./ScribeStore.ts";

/**
 * Server side of the scribe: hands the runner its lanes and cursors, checks
 * every posted batch (citations, claim evidence, `replaces`) and stores the
 * notes in core's record store. A batch at or behind the lane cursor is a
 * duplicate and writes nothing, so a retried post is harmless.
 *
 * A batch is one commit: its notes (verified and failed alike; failed ones
 * feed the pass rate and never reach FYI), one `note.recorded` event naming
 * the strongest verified note, the batch row and the new cursor. Either all
 * of it lands or none of it does. Ingests are serialized, and a batch that
 * reaches back behind the cursor only counts for its new events.
 */

const decodeNote = Schema.decodeUnknownEffect(Note);
const decodeSuggestion = Schema.decodeUnknownEffect(Suggestion);

export const SCRIBE_ACTOR: MissionActor = { _tag: "system", component: "scribe" };
export const SCRIBE_PROVENANCE: MissionProvenance = { _tag: "system", component: "scribe" };

const OPEN_NOTES_LIMIT = 30;

export interface ScribeLane {
  readonly name: string;
  readonly threadId: string;
  readonly missionId: string;
  readonly laneId: string | null;
  readonly subMissionId: string | null;
  readonly purpose: string;
  readonly missionTitle: string;
  readonly subMissionTitle: string | null;
  readonly cursor: number;
}

export interface OpenNoteLine {
  readonly id: string;
  readonly type: string;
  readonly severity: string;
  readonly summary: string;
}

export interface IngestResult {
  readonly duplicate: boolean;
  readonly accepted: number;
  readonly failed: number;
  readonly cursor: number;
  readonly stats: BatchStats | null;
}

export interface ScribeStats {
  readonly batches: number;
  readonly notes: number;
  readonly verified: number;
  readonly failed: number;
  /** Share of posted notes whose citation checked out; null before any note. */
  readonly citationPassRate: number | null;
  readonly mismatch: number;
  readonly dropped: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ScribeError = MissionError | ScribeStoreError;

export interface ReportRequest {
  readonly missionId: string;
  readonly kind: ReportKind;
  /**
   * End of the window; defaults to now. A daily for a mission with a day
   * boundary defaults to the last midnight there.
   */
  readonly to?: string | undefined;
  /**
   * Start of the window; defaults to the last report of this kind, else 4h/24h
   * back. A daily for a mission with a day boundary covers one day there.
   */
  readonly from?: string | undefined;
  /** Keep the report so the next one closes out what it left open. */
  readonly save: boolean;
}

/** A written report to keep, from the scribe's writer, the master or the owner. */
export interface ReportPut {
  readonly missionId: string;
  readonly kind: ReportKind;
  readonly coversFrom: string;
  readonly coversTo: string;
  /** Kept exactly as given. */
  readonly text: string;
  /** Items left open, for the next report to close out. */
  readonly open?: ReadonlyArray<OpenItem> | undefined;
  /** The facts the text was written from. */
  readonly facts?: unknown;
}

export interface ReportPutResult {
  readonly reportId: string;
  readonly kind: ReportKind;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly revision: number;
  readonly author: ReportAuthor;
  /** Characters in the text. */
  readonly size: number;
  /** False when this exact report was already the current one; nothing changed. */
  readonly saved: boolean;
  /** Reports this one hides from lists: older revisions and overlapping dailies. */
  readonly hides: ReadonlyArray<string>;
}

export interface EditorApply {
  readonly missionId: string;
  /** The `since` of the input the editor read; the server rebuilds that input to check against. */
  readonly since: string;
  readonly reply: unknown;
  readonly model: string | null;
  readonly usage: { readonly input: number; readonly output: number };
}

export interface EditorResult {
  readonly bottomLine: string | null;
  readonly fyi: number;
  readonly feed: number;
  readonly opened: ReadonlyArray<string>;
  readonly dropped: number;
  readonly rejected: ReadonlyArray<string>;
}

export interface EditorView {
  readonly bottomLine: string | null;
  readonly bottomLineAt: string;
  readonly fyiOrder: ReadonlyArray<string>;
  readonly feed: ReadonlyArray<EditorFeedItem>;
}

/**
 * Proposes one editor suggestion through asks (bars, dedupe, acceptor).
 * Returns the stored suggestion; an existing one with the draft's id comes
 * back as it is.
 */
export type EditorSuggestionSink = (
  missionId: MissionId,
  draft: EditorSuggestionDraft,
) => Effect.Effect<Suggestion, MissionError>;

export const EDITOR_ACTOR: MissionActor = { _tag: "system", component: "editor" };
export const EDITOR_PROVENANCE: MissionProvenance = { _tag: "system", component: "editor" };
/** How far back the editor reads notes, calls and shipped work. */
const EDITOR_WINDOW_HOURS = 24;

const WINDOW_HOURS: Record<ReportKind, number> = { update: 4, daily: 24 };
/** Longest report text kept; a daily aims for 25-45k characters. */
const REPORT_TEXT_MAX = 200_000;
/** Longest facts pack kept, as JSON. */
const REPORT_FACTS_MAX = 2_000_000;
/** Notes read for ranking and reports: the newest this many per mission. */
const NOTE_WINDOW = 5000;
/** Page size when reading the event log for a report window. */
const EVENT_PAGE = 500;
/** Hard stop for one report's event read (40 pages). */
const EVENT_PAGES_MAX = 40;
/** Longest `replaces` chain followed when validating a new note. */
const CHAIN_DEPTH = 50;

const clipLine = (text: string, max = 400): string => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

export const summarizeStats = (
  batches: ReadonlyArray<{
    readonly stats: BatchStats;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }>,
): ScribeStats => {
  const sum = (pick: (stats: BatchStats) => number) =>
    batches.reduce((total, batch) => total + pick(batch.stats), 0);
  const notes = sum((stats) => stats.notes);
  const verified = sum((stats) => stats.verified);
  return {
    batches: batches.length,
    notes,
    verified,
    failed: sum((stats) => stats.failed),
    citationPassRate: notes === 0 ? null : verified / notes,
    mismatch: sum((stats) => stats.mismatch),
    dropped: sum((stats) => stats.dropped),
    inputTokens: batches.reduce((total, batch) => total + batch.inputTokens, 0),
    outputTokens: batches.reduce((total, batch) => total + batch.outputTokens, 0),
  };
};

export class ScribeService extends Context.Service<
  ScribeService,
  {
    /** Lane threads (and the master's thread) the runner should read, with cursors. */
    readonly lanes: (missionId: string) => Effect.Effect<ReadonlyArray<ScribeLane>, ScribeError>;
    /** Current verified notes from one thread, newest first, for the scribe's running state. */
    readonly openNotes: (
      missionId: string,
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<OpenNoteLine>, ScribeError>;
    readonly ingest: (input: ScribeBatchInput) => Effect.Effect<IngestResult, ScribeError>;
    /** Ranked FYI notes (editor order first when the editor has run). */
    readonly fyi: (
      missionId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Note>, ScribeError>;
    readonly stats: (
      missionId: string,
      sinceIso: string | null,
    ) => Effect.Effect<ScribeStats, ScribeError>;
    /** Build the 4h update or the daily summary from mission data. */
    readonly report: (request: ReportRequest) => Effect.Effect<BuiltReport, ScribeError>;
    /**
     * Keep a written report, as the scribe, the owner or the mission's master.
     * The same window end again adds a revision and keeps the old text; the
     * same report again changes nothing. The scribe never replaces a report
     * the owner or the master wrote.
     */
    readonly putReport: (
      provenance: MissionProvenance,
      input: ReportPut,
    ) => Effect.Effect<ReportPutResult, ScribeError>;
    /** What the hourly editor pass reads. */
    readonly editorInput: (missionId: string) => Effect.Effect<EditorInput, ScribeError>;
    /** Check and store one editor reply; re-applying the same reply opens nothing new. */
    readonly applyEditor: (request: EditorApply) => Effect.Effect<EditorResult, ScribeError>;
    /** The editor's latest bottom line, FYI order and feed, for the overview. */
    readonly editorView: (missionId: string) => Effect.Effect<EditorView | null, ScribeError>;
    /**
     * Send editor suggestions through asks from now on. Until a sink is set
     * (tests, a server without asks) the editor writes them to the store.
     */
    readonly routeSuggestions: (sink: EditorSuggestionSink) => Effect.Effect<void>;
  }
>()("t3/ardud/missions/scribe/ScribeService") {}

const make = Effect.gen(function* () {
  const store = yield* MissionStore;
  const scribe = yield* ScribeStore;
  // One batch at a time, so the cursor check and the write see the same cursor.
  const ingestLock = yield* Semaphore.make(1);
  // One report save at a time, so the revision read and the insert agree.
  const reportLock = yield* Semaphore.make(1);
  const suggestionSink = yield* Ref.make<EditorSuggestionSink | null>(null);

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const requireMission = (missionId: string) =>
    store.get("mission", missionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new MissionError({ code: "not-found", detail: `mission ${missionId}` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const isoTime = (field: string, value: string) =>
    Option.match(DateTime.make(value), {
      onNone: () =>
        Effect.fail(
          new MissionError({ code: "invalid", detail: `${field} is not a time: ${value}` }),
        ),
      onSome: (time) => Effect.succeed(DateTime.formatIso(DateTime.toUtc(time))),
    });

  /**
   * Events from about `fromIso` on, oldest first. Event times mostly rise with
   * seq (imports may backdate a few), so binary search the start and back off
   * one page; the report filters to its window anyway.
   */
  const eventsFrom = (missionId: MissionId, fromIso: string) =>
    Effect.gen(function* () {
      let lo = 1;
      let hi = (yield* store.latestSeq(missionId)) + 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const [event] = yield* store.eventsSince(missionId, mid - 1, 1);
        if (event === undefined || event.at > fromIso) hi = mid;
        else lo = mid + 1;
      }
      const out: MissionEvent[] = [];
      let after = Math.max(0, lo - 1 - EVENT_PAGE);
      for (let page = 0; page < EVENT_PAGES_MAX; page += 1) {
        const events = yield* store.eventsSince(missionId, after, EVENT_PAGE);
        out.push(...events);
        const last = events.at(-1);
        if (events.length < EVENT_PAGE || last === undefined) break;
        after = last.seq;
      }
      return out;
    });

  const recentNotes = (missionId: string) =>
    store.list("note", { missionId: MissionId.make(missionId), limit: NOTE_WINDOW });

  /** The notes a batch touches: its own ids plus every `replaces` chain it points into. */
  const knownNotesFor = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const byId = new Map<string, Note>();
      let next = [...new Set(ids)];
      for (let depth = 0; next.length > 0 && depth < CHAIN_DEPTH; depth += 1) {
        const found = yield* store.list("note", { ids: next });
        for (const note of found) byId.set(note.id, note);
        next = found
          .map((note) => note.replacesNoteId)
          .filter((id): id is NonNullable<typeof id> => id !== null && !byId.has(id));
      }
      return byId;
    });

  const cursorFor = (missionId: string, threadId: string, startAt: string) =>
    scribe
      .cursor(missionId, threadId)
      .pipe(
        Effect.flatMap((stored) =>
          stored === null ? scribe.startCursor(threadId, startAt) : Effect.succeed(stored),
        ),
      );

  const lanes = (missionId: string) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(missionId);
      const id = MissionId.make(missionId);
      const subMissions = yield* store.list("sub-mission", { missionId: id });
      const titleOf = (id: string | null) =>
        id === null ? null : (subMissions.find((sub) => sub.id === id)?.title ?? null);
      const out: ScribeLane[] = [];
      const seen = new Set<string>();
      for (const lane of yield* store.list("lane", { missionId: id })) {
        if (lane.threadId === null || lane.status === "retired" || seen.has(lane.threadId))
          continue;
        seen.add(lane.threadId);
        out.push({
          name: lane.name,
          threadId: lane.threadId,
          missionId,
          laneId: lane.id,
          subMissionId: lane.subMissionId,
          purpose: lane.purpose,
          missionTitle: mission.title,
          subMissionTitle: titleOf(lane.subMissionId),
          cursor: yield* cursorFor(missionId, lane.threadId, lane.createdAt),
        });
      }
      // The master thread is read too: its decisions and owner messages matter most.
      if (mission.masterRoleId !== null) {
        const bindings = yield* store.list("role-binding", { status: ["bound"] });
        const master = bindings.find(
          (binding) => binding.roleId === mission.masterRoleId && binding.endedAt === null,
        );
        if (master !== undefined && !seen.has(master.threadId)) {
          out.push({
            name: "master",
            threadId: master.threadId,
            missionId,
            laneId: null,
            subMissionId: null,
            purpose: `Master coordinator of ${mission.title}`,
            missionTitle: mission.title,
            subMissionTitle: null,
            cursor: yield* cursorFor(missionId, master.threadId, master.boundAt),
          });
        }
      }
      return out;
    });

  const openNotes = (missionId: string, threadId: string) =>
    recentNotes(missionId).pipe(
      Effect.map((notes) =>
        currentNotes(notes)
          .filter(
            (note) =>
              note.citation === "verified" &&
              note.sources.some((source) => source.threadId === threadId),
          )
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, OPEN_NOTES_LIMIT)
          .map((note) => ({
            id: note.id,
            type: note.type,
            severity: note.severity,
            summary: note.summary,
          })),
      ),
    );

  const ingest = (posted: ScribeBatchInput) =>
    Effect.gen(function* () {
      if (!(posted.fromEvent <= posted.toEvent)) {
        return yield* new MissionError({
          code: "invalid",
          detail: `batch range ${posted.fromEvent}..${posted.toEvent}`,
        });
      }
      yield* requireMission(posted.missionId);
      const missionId = MissionId.make(posted.missionId);
      const cursor = (yield* scribe.cursor(posted.missionId, posted.threadId)) ?? 0;
      if (posted.toEvent <= cursor) {
        return { duplicate: true, accepted: 0, failed: 0, cursor, stats: null } as IngestResult;
      }
      // A batch that overlaps what is already noted only counts for the new
      // part: notes and candidates reaching back to or behind the cursor are
      // dropped, so two passes over the same events cannot note them twice.
      const start = Math.max(posted.fromEvent, cursor + 1);
      const notesAfter = posted.notes.filter(
        (note) => Math.min(note.fromEvent, note.event) >= start,
      );
      const candidatesAfter = posted.candidates.filter((candidate) => candidate.event >= start);
      const input: ScribeBatchInput = {
        ...posted,
        fromEvent: start,
        notes: notesAfter,
        candidates: candidatesAfter,
        droppedCount:
          posted.droppedCount +
          (posted.notes.length - notesAfter.length) +
          (posted.candidates.length - candidatesAfter.length),
      };
      const at = yield* now;
      const events = yield* scribe.transcript(input.threadId, input.fromEvent, input.toEvent);
      const pullRequests = yield* scribe.pullRequests(input.threadId);
      // First pass only to learn the ids and `replaces` targets this batch touches.
      const draftIds = assembleBatch(input, {
        events,
        pullRequests,
        knownNotes: new Map(),
        now: at,
      }).notes.map((note) => note.id as string);
      const replaces = input.notes.flatMap((note) =>
        note.replaces === null ? [] : [note.replaces],
      );
      const known = yield* knownNotesFor([...draftIds, ...replaces]);
      const assembled = assembleBatch(input, { events, pullRequests, knownNotes: known, now: at });

      const fresh: Note[] = [];
      for (const draft of assembled.notes) {
        if (known.has(draft.id)) continue;
        fresh.push(
          yield* decodeNote(draft).pipe(
            Effect.mapError(
              (cause) => new MissionError({ code: "invalid", detail: `note: ${cause.message}` }),
            ),
          ),
        );
      }

      const verified = fresh
        .filter((note) => note.citation === "verified")
        .toSorted((a, b) => fyiScore(b) - fyiScore(a));
      const failed = fresh.filter((note) => note.citation !== "verified");
      const strongest = verified[0];
      const lane = input.laneId ?? input.threadId;
      const summary =
        strongest === undefined
          ? `Scribe kept ${failed.length} note(s) from ${lane} whose quote did not match the transcript; they stay out of FYI.`
          : verified.length === 1
            ? `${strongest.type}: ${strongest.summary}`
            : `${verified.length} notes from ${lane}. Strongest: ${strongest.type}: ${strongest.summary}`;

      const batchWrite = scribe
        .writeBatch({
          batch: {
            batchId: `${input.missionId}|${input.threadId}|${input.fromEvent}|${input.toEvent}`,
            missionId: input.missionId,
            threadId: input.threadId,
            fromEvent: input.fromEvent,
            toEvent: input.toEvent,
            model: input.model,
            inputTokens: input.usage.input,
            outputTokens: input.usage.output,
            stats: assembled.stats,
            createdAt: at,
          },
          candidates: assembled.candidates,
          cursor: input.toEvent,
        })
        // Same contract as core's store: storage faults are defects.
        .pipe(Effect.orDie);
      // The cursor must not have moved since this batch was checked; if it
      // did, the whole commit rolls back and the runner re-reads its lanes.
      const guardedWrite = Effect.gen(function* () {
        const current =
          (yield* scribe.cursor(input.missionId, input.threadId).pipe(Effect.orDie)) ?? 0;
        if (current !== cursor) {
          return yield* new MissionError({
            code: "conflict",
            detail: `lane cursor moved from ${cursor} to ${current} while the batch was checked`,
          });
        }
        yield* batchWrite;
      });

      if (fresh.length === 0) {
        yield* guardedWrite;
      } else {
        const commit: MissionCommit = {
          event: {
            missionId,
            kind: "note.recorded",
            actor: SCRIBE_ACTOR,
            provenance: SCRIBE_PROVENANCE,
            summary: clipLine(summary),
            subject: strongest === undefined ? null : { kind: "note", id: strongest.id },
            payload: {
              laneId: input.laneId,
              threadId: input.threadId,
              fromEvent: input.fromEvent,
              toEvent: input.toEvent,
              noteIds: verified.map((note) => note.id),
              failedNoteIds: failed.map((note) => note.id),
            },
            at,
          },
          upserts: fresh.map((note) => ({ _tag: "note" as const, record: note })),
          alongside: guardedWrite,
        };
        yield* store.commit(commit);
      }

      return {
        duplicate: false,
        accepted: assembled.stats.verified,
        failed: assembled.stats.failed,
        cursor: input.toEvent,
        stats: assembled.stats,
      } as IngestResult;
    }).pipe(ingestLock.withPermit);

  const fyi = (missionId: string, limit: number) =>
    Effect.gen(function* () {
      const notes = yield* recentNotes(missionId);
      const editor = yield* editorStateOf(missionId);
      // The editor decides what reaches the owner. Padding the list with every
      // open note buried his few real items under lane housekeeping.
      return editor === null
        ? rankFyi(
            notes.filter((note) => note.type === "owner-must-know"),
            { limit },
          )
        : rankFyi(notes, { limit, editorOrder: editor.state.fyiOrder, picksOnly: true });
    });

  const stats = (missionId: string, sinceIso: string | null) =>
    scribe.batches(missionId, sinceIso).pipe(Effect.map(summarizeStats));

  const report = (request: ReportRequest) =>
    Effect.gen(function* () {
      const { missionId, kind } = request;
      const mission = yield* requireMission(missionId);
      // A daily for a mission with a day boundary covers one whole day there.
      const zone = kind === "daily" ? reportZone(mission) : null;
      // Windows are compared as strings below and in SQL, so every bound is
      // normalized to the same ISO form first.
      const nowIso = yield* now;
      const to =
        request.to !== undefined
          ? yield* isoTime("to", request.to)
          : zone !== null
            ? dayWindow(zone, { nowIso }).to
            : nowIso;
      const id = MissionId.make(missionId);
      // The report before this window closes out what it left open. Looking
      // strictly before `to` keeps a retry of a saved report from finding itself.
      const previous = yield* scribe.lastReport(missionId, kind, to);
      // A retry keeps the window its report was saved with.
      const slot =
        request.from === undefined && zone === null
          ? yield* scribe.latestRevision(missionId, kind, to)
          : null;
      const from =
        request.from !== undefined
          ? yield* isoTime("from", request.from)
          : zone !== null
            ? dayWindow(zone, { toIso: to, nowIso: to }).from
            : (slot?.report.coversFrom ??
              previous?.coversTo ??
              DateTime.formatIso(
                DateTime.subtract(DateTime.makeUnsafe(to), { hours: WINDOW_HOURS[kind] }),
              ));
      if (from >= to) {
        return yield* new MissionError({
          code: "invalid",
          detail: `report window ${from} to ${to}`,
        });
      }
      const [subMissions, milestones, lanes, asks, calls, approvals, workItems, notes] =
        yield* Effect.all([
          store.list("sub-mission", { missionId: id }),
          store.list("milestone", { missionId: id }),
          store.list("lane", { missionId: id }),
          store.list("ask", { missionId: id }),
          store.list("call", { missionId: id }),
          store.list("approval", { missionId: id }),
          store.list("work-item", { missionId: id }),
          recentNotes(missionId),
        ]);
      const suggestions = yield* store.list("suggestion", { missionId: id });
      // "You asked" needs every owner message in the window, so page the log.
      const events = yield* eventsFrom(id, from);
      const editor = (yield* editorStateOf(missionId))?.state ?? null;
      const batches = yield* scribe.batches(missionId, from);
      const usage = batches.length === 0 ? null : summarizeStats(batches);
      const updates =
        kind === "daily" ? yield* scribe.reportsBetween(missionId, "update", from, to) : [];
      const built = buildReport({
        kind,
        from,
        to,
        mission,
        subMissions,
        milestones,
        lanes,
        asks,
        calls,
        approvals,
        workItems,
        notes,
        suggestions,
        events,
        previous,
        updates,
        bottomLine:
          editor?.bottomLine != null && editor.bottomLineAt !== null
            ? { text: editor.bottomLine, at: editor.bottomLineAt }
            : null,
        usage,
      });
      if (request.save) {
        yield* keepReport(mission, "scribe", SCRIBE_PROVENANCE, {
          missionId,
          kind,
          coversFrom: from,
          coversTo: to,
          text: built.text,
          open: built.open,
        });
      }
      return built;
    });

  /** Who may keep a report, and the provenance its event carries. */
  const reportAuthorOf = Effect.fn("ScribeService.reportAuthorOf")(function* (
    missionId: string,
    provenance: MissionProvenance,
  ) {
    if (provenance._tag === "system" && provenance.component === "scribe") {
      return { author: "scribe" as const, provenance };
    }
    if (isOwnerProvenance(provenance)) return { author: "owner" as const, provenance };
    if (provenance._tag === "agent") {
      const cast = yield* castOf(store, MissionId.make(missionId));
      const standing = cast.mission === null ? null : standingOf(cast, provenance);
      if (standing?.isMaster === true) {
        return { author: "master" as const, provenance: standing.caller.provenance };
      }
    }
    return yield* new MissionError({
      code: "forbidden",
      detail: `Only the scribe, the owner or mission ${missionId}'s master saves its reports.`,
    });
  });

  const sameJson = (left: unknown, right: unknown) =>
    toJson(left ?? null) === toJson(right ?? null);

  const keepReport = Effect.fn("ScribeService.keepReport")(function* (
    mission: { readonly reports?: { readonly dayBoundary?: string | undefined } | undefined },
    author: ReportAuthor,
    provenance: MissionProvenance,
    input: ReportPut,
  ) {
    const { missionId, kind, text } = input;
    const coversFrom = yield* isoTime("coversFrom", input.coversFrom);
    const coversTo = yield* isoTime("coversTo", input.coversTo);
    const invalid = (detail: string) => Effect.fail(new MissionError({ code: "invalid", detail }));
    if (coversFrom >= coversTo) {
      return yield* invalid(`report window ${coversFrom} to ${coversTo}`);
    }
    if (text.trim().length === 0) return yield* invalid("report text is empty");
    if (text.length > REPORT_TEXT_MAX) {
      return yield* invalid(
        `report text is ${text.length} characters; the limit is ${REPORT_TEXT_MAX}`,
      );
    }
    const open = input.open ?? [];
    const facts = input.facts ?? null;
    const factsSize = yield* Effect.try({
      try: () => toJson(facts).length,
      catch: () => new MissionError({ code: "invalid", detail: "report facts are not JSON" }),
    });
    if (factsSize > REPORT_FACTS_MAX) {
      return yield* invalid(
        `report facts are ${factsSize} characters as JSON; the limit is ${REPORT_FACTS_MAX}`,
      );
    }
    const latest = yield* scribe.latestRevision(missionId, kind, coversTo);
    // A retry matches the slot's newest revision even when a newer daily has
    // hidden it since, so a retried save never brings an old window back.
    const unchanged =
      latest !== null &&
      latest.report.author === author &&
      latest.report.coversFrom === coversFrom &&
      latest.report.text === text &&
      sameJson(latest.report.open, open) &&
      sameJson(latest.report.facts, facts);
    if (unchanged) {
      return {
        reportId: latest.report.reportId,
        kind,
        coversFrom,
        coversTo,
        revision: latest.report.revision,
        author,
        size: text.length,
        saved: false,
        hides: [],
      } satisfies ReportPutResult;
    }
    const hidden = yield* scribe.reportsHiddenBy(missionId, kind, coversFrom, coversTo);
    // The slot itself counts too: a written report stays the master's or the
    // owner's even after another daily hides it.
    const written = [...(latest === null ? [] : [latest.report]), ...hidden].find(
      (report) => report.author !== "scribe",
    );
    if (author === "scribe" && written !== undefined) {
      return yield* new MissionError({
        code: "conflict",
        detail: `report ${written.reportId} was written by the ${written.author}; the scribe does not replace it`,
      });
    }
    const revision = (latest?.report.revision ?? 0) + 1;
    const reportId = reportIdOf(missionId, kind, coversTo, revision);
    const hides = hidden.map((report) => report.reportId);
    const at = yield* now;
    const title = reportTitle({ kind, head: text.slice(0, REPORT_HEAD_CHARS) });
    const period = reportPeriod(coversFrom, coversTo, reportZone(mission));
    const who = author === "scribe" ? "Scribe" : author === "owner" ? "Owner" : "Master";
    yield* store.commit({
      event: {
        missionId: MissionId.make(missionId),
        kind: "report.saved",
        actor: actorOf(provenance),
        provenance,
        summary: clipLine(
          `${who} saved ${kind === "daily" ? "daily" : "update"} "${title}" for ${period}${revision > 1 ? `, revision ${revision}` : ""}`,
        ),
        subject: { kind: "report", id: reportId, label: title },
        payload: {
          reportId,
          kind,
          coversFrom,
          coversTo,
          revision,
          author,
          size: text.length,
          hides,
        },
        at,
      },
      alongside: scribe
        .writeReport({
          reportId,
          missionId,
          kind,
          coversFrom,
          coversTo,
          open,
          text,
          createdAt: at,
          author,
          revision,
          facts,
        })
        .pipe(Effect.orDie),
    });
    yield* scribe.announceReport(missionId);
    return {
      reportId,
      kind,
      coversFrom,
      coversTo,
      revision,
      author,
      size: text.length,
      saved: true,
      hides,
    } satisfies ReportPutResult;
  }, reportLock.withPermit);

  const putReport = Effect.fn("ScribeService.putReport")(function* (
    provenance: MissionProvenance,
    input: ReportPut,
  ) {
    const mission = yield* requireMission(input.missionId);
    const caller = yield* reportAuthorOf(input.missionId, provenance);
    return yield* keepReport(mission, caller.author, caller.provenance, input);
  });

  const editorStateOf = (missionId: string) =>
    scribe
      .editorState(missionId)
      .pipe(
        Effect.map((row) =>
          row === null ? null : { state: readEditorState(row.payload), updatedAt: row.updatedAt },
        ),
      );

  /** Rebuild exactly what the editor reads for a window starting at `since`. */
  const editorInputSince = (missionId: string, since: string, at: string) =>
    Effect.gen(function* () {
      const mission = yield* requireMission(missionId);
      const id = MissionId.make(missionId);
      const [
        lanes,
        asks,
        approvals,
        calls,
        workItems,
        milestones,
        notes,
        suggestions,
        rules,
        roles,
      ] = yield* Effect.all([
        store.list("lane", { missionId: id }),
        store.list("ask", { missionId: id }),
        store.list("approval", { missionId: id }),
        store.list("call", { missionId: id }),
        store.list("work-item", { missionId: id }),
        store.list("milestone", { missionId: id }),
        recentNotes(missionId),
        store.list("suggestion", { missionId: id }),
        store.list("rule", { missionId: id }),
        store.list("role", { missionId: id }),
      ]);
      const candidates = yield* scribe.candidates(missionId, "open");
      const previous = yield* editorStateOf(missionId);
      return buildEditorInput({
        mission,
        now: at,
        since,
        previousBottomLine: previous?.state.bottomLine ?? null,
        lanes,
        asks,
        approvals,
        calls,
        workItems,
        milestones,
        notes,
        candidates: candidates.map((row) => row.candidate),
        suggestions,
        rules,
        roles,
      });
    });

  const editorInput = (missionId: string) =>
    Effect.gen(function* () {
      const at = yield* now;
      const since = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(at), { hours: EDITOR_WINDOW_HOURS }),
      );
      return yield* editorInputSince(missionId, since, at);
    });

  const applyEditor = (request: EditorApply) =>
    Effect.gen(function* () {
      const { missionId } = request;
      const at = yield* now;
      const input = yield* editorInputSince(missionId, request.since, at);
      const plan = checkEditorOutput(request.reply, input);
      const id = MissionId.make(missionId);

      const opened: string[] = [];
      const refused: string[] = [];
      const sink = yield* Ref.get(suggestionSink);
      for (const draft of plan.suggestions) {
        // Ids come from target and title, so a replayed reply finds its own suggestion.
        if (Option.isSome(yield* store.get("suggestion", draft.id))) continue;
        if (sink !== null) {
          const proposed = yield* sink(id, draft).pipe(
            Effect.map((suggestion) => suggestion.id),
            Effect.catch((error: MissionError) => {
              refused.push(`suggestion: ${draft.title} refused (${error.detail})`);
              return Effect.succeed(null);
            }),
          );
          if (proposed === null) continue;
          yield* Effect.forEach(
            draft.candidateIds,
            (candidateId) => scribe.setCandidateStatus(candidateId, "merged", proposed, at),
            { discard: true },
          );
          opened.push(proposed);
          continue;
        }
        const record = yield* decodeSuggestion({
          id: draft.id,
          missionId,
          targetKind: draft.targetKind,
          target: draft.target,
          title: draft.title,
          before: null,
          after: draft.after,
          diffText: draft.diffText,
          why: draft.why,
          evidence: draft.evidence,
          author: "editor",
          acceptor: draft.acceptor,
          status: "open",
          dismissReason: null,
          outcome: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: at,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new MissionError({ code: "invalid", detail: `suggestion: ${cause.message}` }),
          ),
        );
        const merge = Effect.forEach(
          draft.candidateIds,
          (candidateId) => scribe.setCandidateStatus(candidateId, "merged", draft.id, at),
          { discard: true },
        ).pipe(Effect.orDie);
        yield* store.commit({
          event: {
            missionId: id,
            kind: "suggestion.opened",
            actor: EDITOR_ACTOR,
            provenance: EDITOR_PROVENANCE,
            summary: clipLine(`Suggestion (editor): ${draft.title}`),
            subject: { kind: "suggestion", id: draft.id, label: draft.title },
            payload: {
              author: "editor",
              targetKind: draft.targetKind,
              acceptor: draft.acceptor,
              candidateIds: draft.candidateIds,
            },
            at,
          },
          upserts: [{ _tag: "suggestion", record }],
          alongside: merge,
        });
        opened.push(draft.id);
      }
      for (const drop of plan.droppedCandidates) {
        yield* scribe.setCandidateStatus(drop.id, "dropped", null, at);
      }

      const rejected = [...plan.rejected, ...refused];
      const previous = (yield* editorStateOf(missionId))?.state ?? null;
      const state: EditorState = {
        bottomLine: plan.bottomLine ?? previous?.bottomLine ?? null,
        bottomLineAt: plan.bottomLine === null ? (previous?.bottomLineAt ?? null) : at,
        fyiOrder: plan.fyiOrder,
        feed: plan.feed,
        since: request.since,
        model: request.model,
        rejected,
      };
      const changed =
        previous === null ||
        opened.length > 0 ||
        previous.bottomLine !== state.bottomLine ||
        toJson(previous.fyiOrder) !== toJson(state.fyiOrder) ||
        toJson(previous.feed) !== toJson(state.feed);
      if (changed) {
        yield* store.commit({
          event: {
            missionId: id,
            kind: "editor.updated",
            actor: EDITOR_ACTOR,
            provenance: EDITOR_PROVENANCE,
            summary: clipLine(
              plan.bottomLine === null
                ? "Editor pass kept the previous bottom line."
                : `Bottom line: ${plan.bottomLine}`,
            ),
            subject: null,
            payload: {
              fyi: plan.fyiOrder.length,
              feed: plan.feed.length,
              opened,
              dropped: plan.droppedCandidates.length,
              rejected: plan.rejected.length,
              model: request.model,
              usage: request.usage,
            },
            at,
          },
          alongside: scribe.saveEditorState(missionId, state, at).pipe(Effect.orDie),
        });
      }
      return {
        bottomLine: state.bottomLine,
        fyi: plan.fyiOrder.length,
        feed: plan.feed.length,
        opened,
        dropped: plan.droppedCandidates.length,
        rejected,
      } satisfies EditorResult;
    });

  const editorView = (missionId: string) =>
    editorStateOf(missionId).pipe(
      Effect.map((row) =>
        row === null
          ? null
          : ({
              bottomLine: row.state.bottomLine,
              bottomLineAt: row.state.bottomLineAt ?? row.updatedAt,
              fyiOrder: row.state.fyiOrder,
              feed: row.state.feed,
            } satisfies EditorView),
      ),
    );

  return ScribeService.of({
    lanes,
    openNotes,
    ingest,
    fyi,
    stats,
    report,
    putReport,
    editorInput,
    applyEditor,
    editorView,
    routeSuggestions: (sink) => Ref.set(suggestionSink, sink),
  });
});

export const layer = Layer.effect(ScribeService, make);
