// @effect-diagnostics nodeBuiltinImport:off - run.ts reads the plan file before any layer exists.
import {
  LaneId,
  MilestoneId,
  SubMissionId,
  type MissionId,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MissionService } from "../MissionService.ts";
import { MissionStore } from "../store/MissionStore.ts";
import type { KindDiff } from "./apply.ts";
import type { ImportPlan } from "./mapping.ts";

/**
 * The optional `--plan <json>` of the coord import: sub-missions, their
 * milestones, and which imported lane sits in which sub-mission. The schema is
 * written up in the import notes; in short:
 *
 *   { "mission"?: "crpko",
 *     "subMissions": [{ "key", "title", "intent"?, "fillIdleCapacity"?, "notes"?,
 *                       "milestones"?: [{ "key", "title", "due"? }],
 *                       "lanes"?: ["cell-tc", "backfill:latency-budgets"] }],
 *     "unplaced"?: [{ "lane", "reason" }],
 *     "notes"?: "..." }
 *
 * A lane is named by its import id, with or without the `<mission>:lane:`
 * prefix. `due` needs a time and an offset. Every problem is reported with the
 * line it is on, all at once (a JSON syntax error stops at the first), before
 * the target is touched.
 *
 * Like the rest of the import, applying creates only what is missing, through
 * the same MissionService writes the owner uses, so the feed shows
 * `sub-mission.created`, `milestone.created` and `lane.moved`. A sub-mission or
 * milestone that exists with other content is left alone, and a lane is only
 * placed while nobody has ever set its sub-mission, so a second apply writes
 * nothing and the master's later moves stand. A sub-mission the owner closed
 * (or merged away) counts as changed, and nothing new goes into it.
 */

export const PLAN_SOURCE = "mission plan";

export const subMissionIdFor = (missionId: string, key: string) =>
  SubMissionId.make(`${missionId}:sub:${key}`);
export const milestoneIdFor = (missionId: string, key: string) =>
  MilestoneId.make(`${missionId}:milestone:${key}`);

export interface PlannedSubMission {
  readonly id: SubMissionId;
  readonly title: string;
  readonly intent: string;
  readonly fillIdleCapacity: boolean;
}

export interface PlannedMilestone {
  readonly id: MilestoneId;
  readonly subMissionId: SubMissionId;
  readonly title: string;
  /** UTC ISO time, or null when the plan gives no due date. */
  readonly targetAt: string | null;
}

export interface PlannedPlacement {
  readonly laneId: LaneId;
  readonly subMissionId: SubMissionId;
}

export interface MissionPlan {
  readonly file: string;
  readonly subMissions: ReadonlyArray<PlannedSubMission>;
  readonly milestones: ReadonlyArray<PlannedMilestone>;
  readonly placements: ReadonlyArray<PlannedPlacement>;
  readonly unplaced: ReadonlyArray<{ readonly laneId: LaneId; readonly reason: string }>;
  /** Import lanes the plan neither places nor lists as unplaced. */
  readonly missing: ReadonlyArray<LaneId>;
}

export type PlanParse =
  | { readonly _tag: "ok"; readonly plan: MissionPlan }
  | { readonly _tag: "invalid"; readonly errors: ReadonlyArray<string> };

// --- a JSON reader that remembers lines ------------------------------------------

type Node =
  | { readonly kind: "object"; readonly line: number; readonly entries: ReadonlyArray<Entry> }
  | { readonly kind: "array"; readonly line: number; readonly items: ReadonlyArray<Node> }
  | { readonly kind: "string"; readonly line: number; readonly value: string }
  | { readonly kind: "number"; readonly line: number; readonly value: number }
  | { readonly kind: "boolean"; readonly line: number; readonly value: boolean }
  | { readonly kind: "null"; readonly line: number };

interface Entry {
  readonly key: string;
  readonly line: number;
  readonly value: Node;
}

class SyntaxProblem {
  readonly line: number;
  readonly message: string;
  constructor(line: number, message: string) {
    this.line = line;
    this.message = message;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 64;

const readJson = (text: string): Node => {
  let i = 0;
  let line = 1;
  let depth = 0;
  const fail = (message: string, at = line): never => {
    throw new SyntaxProblem(at, message);
  };
  const space = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") line++;
      else if (c !== " " && c !== "\t" && c !== "\r") return;
      i++;
    }
  };
  const string = (): string => {
    const start = i++;
    while (text[i] !== '"') {
      if (i >= text.length || text[i] === "\n") fail("unterminated string");
      i += text[i] === "\\" ? 2 : 1;
    }
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail("control character or bad escape in string");
    }
  };
  // After a comma: a closing bracket here is a trailing comma, reported on the comma's line.
  const noTrailingComma = (close: string, commaLine: number) => {
    space();
    if (text[i] === close) fail("trailing comma", commaLine);
  };
  const value = (): Node => {
    space();
    const at = line;
    const c = text[i];
    if ((c === "{" || c === "[") && ++depth > MAX_DEPTH) fail("nested too deeply");
    if (c === "{") {
      i++;
      const entries: Array<Entry> = [];
      space();
      if (text[i] === "}") {
        i++;
        depth--;
        return { kind: "object", line: at, entries };
      }
      for (;;) {
        space();
        if (text[i] !== '"') fail("expected a quoted key");
        const keyLine = line;
        const key = string();
        if (entries.some((e) => e.key === key)) fail(`duplicate key "${key}"`, keyLine);
        space();
        if (text[i] !== ":") fail(`expected ":" after "${key}"`);
        i++;
        entries.push({ key, line: keyLine, value: value() });
        space();
        if (text[i] === ",") {
          i++;
          noTrailingComma("}", line);
        } else if (text[i] === "}") {
          i++;
          depth--;
          return { kind: "object", line: at, entries };
        } else fail('expected "," or "}"');
      }
    }
    if (c === "[") {
      i++;
      const items: Array<Node> = [];
      space();
      if (text[i] === "]") {
        i++;
        depth--;
        return { kind: "array", line: at, items };
      }
      for (;;) {
        items.push(value());
        space();
        if (text[i] === ",") {
          i++;
          noTrailingComma("]", line);
        } else if (text[i] === "]") {
          i++;
          depth--;
          return { kind: "array", line: at, items };
        } else fail('expected "," or "]"');
      }
    }
    if (c === '"') return { kind: "string", line: at, value: string() };
    for (const [word, node] of [
      ["true", { kind: "boolean", line: at, value: true }],
      ["false", { kind: "boolean", line: at, value: false }],
      ["null", { kind: "null", line: at }],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return node;
      }
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number !== null) {
      i += number[0].length;
      return { kind: "number", line: at, value: Number(number[0]) };
    }
    return fail(c === undefined ? "unexpected end of file" : `unexpected ${JSON.stringify(c)}`);
  };
  const root = value();
  space();
  if (i < text.length) fail("unexpected text after the plan");
  return root;
};

// --- validation -------------------------------------------------------------------

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const DUE =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/** Parses and checks a plan file against the lanes this import plans. */
export const parsePlan = (text: string, file: string, importPlan: ImportPlan): PlanParse => {
  let root: Node;
  try {
    root = readJson(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (error) {
    if (error instanceof SyntaxProblem)
      return { _tag: "invalid", errors: [`${file}:${error.line}: ${error.message}`] };
    throw error;
  }

  const errors: Array<{ readonly line: number; readonly text: string }> = [];
  const problem = (node: { readonly line: number }, path: string, message: string) => {
    errors.push({ line: node.line, text: `${file}:${node.line}: ${path}: ${message}` });
  };

  const fields = (
    node: Node,
    path: string,
    known: ReadonlyArray<string>,
    required: ReadonlyArray<string>,
  ): ReadonlyMap<string, Node> | null => {
    if (node.kind !== "object") {
      problem(node, path, "expected an object");
      return null;
    }
    const map = new Map<string, Node>();
    for (const e of node.entries) {
      if (known.includes(e.key)) map.set(e.key, e.value);
      else problem(e, `${path}.${e.key}`, `unknown field (known: ${known.join(", ")})`);
    }
    for (const key of required) if (!map.has(key)) problem(node, path, `missing "${key}"`);
    return map;
  };
  const text$ = (node: Node | undefined, path: string, fallback?: string): string | null => {
    if (node === undefined) return fallback ?? null;
    if (node.kind !== "string") {
      problem(node, path, "expected a string");
      return null;
    }
    return node.value;
  };
  const title$ = (node: Node | undefined, path: string): string | null => {
    const value = text$(node, path);
    if (value === null || node === undefined) return null;
    if (value.trim() === "" || value !== value.trim()) {
      problem(node, path, "needs non-blank text without surrounding spaces");
      return null;
    }
    return value;
  };
  const key$ = (node: Node | undefined, path: string, seen: Set<string>): string | null => {
    const value = text$(node, path);
    if (value === null || node === undefined) return null;
    if (!KEY.test(value)) {
      problem(node, path, `"${value}" is not a key (lowercase letters, digits and dashes)`);
      return null;
    }
    if (seen.has(value)) {
      problem(node, path, `key "${value}" is used twice`);
      return null;
    }
    seen.add(value);
    return value;
  };
  const array$ = (node: Node | undefined, path: string): ReadonlyArray<Node> => {
    if (node === undefined) return [];
    if (node.kind !== "array") {
      problem(node, path, "expected an array");
      return [];
    }
    return node.items;
  };

  const missionId = importPlan.missionId;
  const laneIds = new Set<string>(importPlan.core.lanes.map((l) => l.id));
  const lanePrefix = `${missionId}:lane:`;
  const placedAt = new Map<string, string>();
  const lane$ = (node: Node | undefined, path: string): LaneId | null => {
    const ref = text$(node, path);
    if (ref === null || node === undefined) return null;
    const id = ref.startsWith(lanePrefix) ? ref : `${lanePrefix}${ref}`;
    if (!laneIds.has(id)) {
      problem(
        node,
        path,
        `unknown lane "${ref}": not one of the ${laneIds.size} lanes this import plans`,
      );
      return null;
    }
    const before = placedAt.get(id);
    if (before !== undefined) {
      problem(node, path, `lane "${ref}" is already listed at ${before}`);
      return null;
    }
    placedAt.set(id, `line ${node.line}`);
    return LaneId.make(id);
  };

  const subMissions: Array<PlannedSubMission> = [];
  const milestones: Array<PlannedMilestone> = [];
  const placements: Array<PlannedPlacement> = [];
  const unplaced: Array<{ readonly laneId: LaneId; readonly reason: string }> = [];
  const subKeys = new Set<string>();
  const milestoneKeys = new Set<string>();

  const top = fields(
    root,
    "plan",
    ["mission", "subMissions", "unplaced", "notes"],
    ["subMissions"],
  );
  if (top !== null) {
    const mission = text$(top.get("mission"), "mission");
    if (mission !== null && mission !== missionId)
      problem(
        top.get("mission")!,
        "mission",
        `plan is for "${mission}", the import is for "${missionId}"`,
      );
    text$(top.get("notes"), "notes");

    array$(top.get("subMissions"), "subMissions").forEach((node, i) => {
      const path = `subMissions[${i}]`;
      const f = fields(
        node,
        path,
        ["key", "title", "intent", "fillIdleCapacity", "milestones", "lanes", "notes"],
        ["key", "title"],
      );
      if (f === null) return;
      const key = key$(f.get("key"), `${path}.key`, subKeys);
      const title = title$(f.get("title"), `${path}.title`);
      const intent = text$(f.get("intent"), `${path}.intent`, "");
      text$(f.get("notes"), `${path}.notes`);
      const fill = f.get("fillIdleCapacity");
      if (fill !== undefined && fill.kind !== "boolean")
        problem(fill, `${path}.fillIdleCapacity`, "expected true or false");
      const id = key === null ? null : subMissionIdFor(missionId, key);
      if (id !== null && title !== null && intent !== null)
        subMissions.push({
          id,
          title,
          intent,
          fillIdleCapacity: fill?.kind === "boolean" ? fill.value : false,
        });

      array$(f.get("milestones"), `${path}.milestones`).forEach((m, j) => {
        const mPath = `${path}.milestones[${j}]`;
        const mf = fields(m, mPath, ["key", "title", "due"], ["key", "title"]);
        if (mf === null) return;
        const mKey = key$(mf.get("key"), `${mPath}.key`, milestoneKeys);
        const mTitle = title$(mf.get("title"), `${mPath}.title`);
        const dueNode = mf.get("due");
        let targetAt: string | null = null;
        let dueOk = true;
        if (dueNode !== undefined && dueNode.kind !== "null") {
          const due = text$(dueNode, `${mPath}.due`);
          const parts = due === null ? null : DUE.exec(due);
          const time = due === null ? Number.NaN : Date.parse(due);
          const [, y, mo, d] = parts ?? [];
          // A day past the month's end rolls over to the next month, so it reads back different.
          const realDay =
            parts !== null &&
            !Number.isNaN(time) &&
            iso(Date.UTC(Number(y), Number(mo) - 1, Number(d))).startsWith(`${y}-${mo}-${d}`);
          if (!realDay) {
            dueOk = false;
            if (due !== null)
              problem(
                dueNode,
                `${mPath}.due`,
                `"${due}" is not a date and time with an offset, e.g. 2026-10-19T18:00:00+04:00`,
              );
          } else targetAt = iso(time);
        }
        if (id !== null && mKey !== null && mTitle !== null && dueOk)
          milestones.push({
            id: milestoneIdFor(missionId, mKey),
            subMissionId: id,
            title: mTitle,
            targetAt,
          });
      });

      array$(f.get("lanes"), `${path}.lanes`).forEach((l, j) => {
        const laneId = lane$(l, `${path}.lanes[${j}]`);
        if (laneId !== null && id !== null) placements.push({ laneId, subMissionId: id });
      });
    });

    array$(top.get("unplaced"), "unplaced").forEach((node, i) => {
      const path = `unplaced[${i}]`;
      const f = fields(node, path, ["lane", "reason"], ["lane", "reason"]);
      if (f === null) return;
      const laneId = lane$(f.get("lane"), `${path}.lane`);
      const reason = title$(f.get("reason"), `${path}.reason`);
      if (laneId !== null && reason !== null) unplaced.push({ laneId, reason });
    });
  }

  if (errors.length > 0)
    return {
      _tag: "invalid",
      errors: errors.toSorted((a, b) => a.line - b.line).map((e) => e.text),
    };
  return {
    _tag: "ok",
    plan: {
      file,
      subMissions,
      milestones,
      placements,
      unplaced,
      missing: importPlan.core.lanes.filter((l) => !placedAt.has(l.id)).map((l) => l.id),
    },
  };
};

/** `parsePlan` on a file; an unreadable file is one more problem, not a crash. */
export const readPlanFile = (file: string, importPlan: ImportPlan): PlanParse => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { _tag: "invalid", errors: [`${file}: can't read the plan: ${reason}`] };
  }
  return parsePlan(text, file, importPlan);
};

// --- diff and apply ---------------------------------------------------------------

export type PlanItemState = "create" | "same" | "differs";

export interface PlanState {
  /** `sub-mission`, `milestone` and `lane-placement` rows for the diff table. */
  readonly kinds: ReadonlyArray<KindDiff>;
  readonly subMissions: ReadonlyMap<string, PlanItemState>;
  readonly milestones: ReadonlyMap<string, PlanItemState>;
  /** Per placed lane, with the sub-mission it sits in now (null when none or not yet imported). */
  readonly placements: ReadonlyMap<
    string,
    { readonly state: PlanItemState; readonly current: string | null }
  >;
  /**
   * Milestones and lanes left out only because their sub-mission is closed or
   * another mission's (they count as `differs`).
   */
  readonly blocked: ReadonlySet<string>;
}

const tally = (
  kind: string,
  states: ReadonlyMap<string, PlanItemState | { readonly state: PlanItemState }>,
): KindDiff => {
  const entries = [...states].map(([id, s]) => [id, typeof s === "string" ? s : s.state] as const);
  const differIds = entries.filter(([, s]) => s === "differs").map(([id]) => id);
  return {
    kind,
    planned: entries.length,
    create: entries.filter(([, s]) => s === "create").length,
    unchanged: entries.filter(([, s]) => s === "same").length,
    differs: differIds.length,
    close: 0,
    differIds,
  };
};

const listIn = (payload: unknown, field: string): ReadonlyArray<unknown> => {
  if (typeof payload !== "object" || payload === null) return [];
  const value = (payload as Record<string, unknown>)[field];
  return Array.isArray(value) ? value : [];
};

/**
 * Lanes whose sub-mission someone has set before: any lane event that changed
 * `subMissionId` (a park or retire can carry one). The plan leaves those be,
 * even when they sit in none now. A merge only moves lanes that already had a
 * sub-mission, so its `laneIds` are a safety net, not a separate source.
 */
const placedLanes = (missionId: MissionId) =>
  Effect.gen(function* () {
    const store = yield* MissionStore;
    const placed = new Set<string>();
    let after = 0;
    for (;;) {
      const page = yield* store.eventsSince(missionId, after);
      if (page.length === 0) break;
      for (const e of page) {
        if (e.subject?.kind === "lane" && listIn(e.payload, "changed").includes("subMissionId"))
          placed.add(e.subject.id);
        if (e.kind === "sub-mission.merged")
          for (const id of listIn(e.payload, "laneIds")) if (typeof id === "string") placed.add(id);
      }
      after = page.at(-1)!.seq;
    }
    return placed;
  });

const sameTime = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

export const diffPlan = (plan: MissionPlan, missionId: MissionId) =>
  Effect.gen(function* () {
    const store = yield* MissionStore;
    const subMissions = new Map<string, PlanItemState>();
    // Sub-missions a milestone or lane may still go into: new ones, and open ones of this mission.
    const open = new Set<string>();
    for (const s of plan.subMissions) {
      const current = yield* store.get("sub-mission", s.id);
      if (Option.isNone(current)) {
        subMissions.set(s.id, "create");
        open.add(s.id);
        continue;
      }
      const usable = current.value.missionId === missionId && current.value.status !== "closed";
      if (usable) open.add(s.id);
      subMissions.set(
        s.id,
        usable &&
          current.value.title === s.title &&
          current.value.intent === s.intent &&
          current.value.fillIdleCapacity === s.fillIdleCapacity
          ? "same"
          : "differs",
      );
    }
    const blocked = new Set<string>();
    const milestones = new Map<string, PlanItemState>();
    for (const m of plan.milestones) {
      const current = yield* store.get("milestone", m.id);
      if (Option.isNone(current) && !open.has(m.subMissionId)) blocked.add(m.id);
      milestones.set(
        m.id,
        Option.isNone(current)
          ? open.has(m.subMissionId)
            ? "create"
            : "differs"
          : current.value.missionId === missionId &&
              current.value.subMissionId === m.subMissionId &&
              current.value.title === m.title &&
              sameTime(current.value.targetAt, m.targetAt)
            ? "same"
            : "differs",
      );
    }
    const placed = plan.placements.length === 0 ? new Set<string>() : yield* placedLanes(missionId);
    const placements = new Map<string, { state: PlanItemState; current: string | null }>();
    for (const p of plan.placements) {
      const lane = yield* store.get("lane", p.laneId);
      const current = Option.isSome(lane) ? lane.value.subMissionId : null;
      if (current === null && !placed.has(p.laneId) && !open.has(p.subMissionId))
        blocked.add(p.laneId);
      placements.set(p.laneId, {
        current,
        state:
          current === p.subMissionId
            ? "same"
            : current === null && !placed.has(p.laneId) && open.has(p.subMissionId)
              ? "create"
              : "differs",
      });
    }
    return {
      kinds: [
        tally("sub-mission", subMissions),
        tally("milestone", milestones),
        tally("lane-placement", placements),
      ],
      subMissions,
      milestones,
      placements,
      blocked,
    } satisfies PlanState;
  });

/**
 * Creates the missing sub-missions and milestones and places never-moved lanes.
 * Run after `applyImport`: it needs the mission and the lanes.
 */
export const applyPlan = (plan: MissionPlan, missionId: MissionId) =>
  Effect.gen(function* () {
    const service = yield* MissionService;
    const state = yield* diffPlan(plan, missionId);
    const provenance: MissionProvenance = { _tag: "import", source: PLAN_SOURCE };
    const created = { "sub-mission": 0, milestone: 0, "lane-placement": 0 };
    for (const s of plan.subMissions) {
      if (state.subMissions.get(s.id) !== "create") continue;
      yield* service.upsertSubMission(provenance, {
        missionId,
        subMissionId: s.id,
        title: s.title,
        intent: s.intent,
        fillIdleCapacity: s.fillIdleCapacity,
      });
      created["sub-mission"]++;
    }
    for (const m of plan.milestones) {
      if (state.milestones.get(m.id) !== "create") continue;
      yield* service.upsertMilestone(provenance, {
        missionId,
        milestoneId: m.id,
        subMissionId: m.subMissionId,
        title: m.title,
        targetAt: m.targetAt,
      });
      created.milestone++;
    }
    for (const p of plan.placements) {
      if (state.placements.get(p.laneId)?.state !== "create") continue;
      yield* service.upsertLane(provenance, {
        missionId,
        laneId: p.laneId,
        subMissionId: p.subMissionId,
      });
      created["lane-placement"]++;
    }
    return {
      state,
      created,
      commits: created["sub-mission"] + created.milestone + created["lane-placement"],
    };
  });

// --- report -----------------------------------------------------------------------

/** The report's Plan section: what each sub-mission, milestone and placement would do. */
export const renderPlan = (
  plan: MissionPlan,
  state: PlanState | undefined,
  laneName: (id: string) => string,
): ReadonlyArray<string> => {
  const pad = (text: string, width: number) => text.padEnd(width);
  const label = (s: PlanItemState | undefined) => s ?? "planned";
  const blocked = (id: string) => state?.blocked.has(id) === true;
  const SHUT = "sub-mission closed or another mission's";
  const out: Array<string> = [];
  out.push(
    `Plan (${plan.file}; ${plan.subMissions.length} sub-missions, ${plan.milestones.length} milestones, ` +
      `${plan.placements.length} lanes placed, ${plan.unplaced.length} unplaced, ${plan.missing.length} not in plan; import provenance ${PLAN_SOURCE})`,
  );
  for (const s of plan.subMissions) {
    const lanes = plan.placements.filter((p) => p.subMissionId === s.id);
    out.push(
      `  ${pad(label(state?.subMissions.get(s.id)), 8)} ${pad(s.title, 40)} ${s.id}, ${lanes.length} lanes${s.fillIdleCapacity ? ", fills idle capacity" : ""}`,
    );
    for (const m of plan.milestones.filter((x) => x.subMissionId === s.id))
      out.push(
        `    milestone ${pad(label(state?.milestones.get(m.id)), 8)} ${m.title} (due ${m.targetAt ?? "none"})${blocked(m.id) ? ` (${SHUT}; not created)` : ""}`,
      );
    for (const p of lanes) {
      const placement = state?.placements.get(p.laneId);
      const why =
        placement?.state !== "differs"
          ? ""
          : blocked(p.laneId)
            ? ` (${SHUT}; not placed)`
            : ` (now in ${placement.current ?? "no sub-mission"}; kept)`;
      out.push(`    lane ${pad(label(placement?.state), 8)} ${laneName(p.laneId)}${why}`);
    }
  }
  for (const u of plan.unplaced) out.push(`  unplaced ${laneName(u.laneId)}: ${u.reason}`);
  for (const id of plan.missing) out.push(`  not in plan ${laneName(id)}`);
  return out;
};
