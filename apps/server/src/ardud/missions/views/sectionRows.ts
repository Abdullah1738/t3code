/**
 * Section queries run here, on the server. Each query section gets its rows
 * projected down to the paths its body binds, so clients never receive whole
 * records they did not ask to show.
 */
import {
  type MissionId,
  type MissionRecordRef,
  type ViewQuery,
  type ViewQueryKind,
  type ViewSection,
  type ViewSectionData,
  type ViewSectionRow,
  ViewNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ReportKind } from "../scribe/reports.ts";
import { reportPeriod, reportTitle, reportZone } from "../scribe/reportTime.ts";
import type { ReportSummary, ScribeStore } from "../scribe/ScribeStore.ts";
import type * as MissionStore from "../store/MissionStore.ts";

const decodeNode = Schema.decodeUnknownOption(ViewNode);

/** Record fields the derived row paths read. */
const DERIVED_SOURCES: Record<string, ReadonlyArray<string>> = {
  age: ["createdAt"],
  by: ["decidedBy", "heldBy", "author", "requestedBy", "fromTitle"],
  approver: ["approver", "acceptor", "status"],
};

const optional = (bind: string | undefined): ReadonlyArray<string> =>
  bind === undefined ? [] : [bind];

export const nodeBinds = (node: ViewNode): ReadonlyArray<string> => {
  switch (node._tag) {
    case "text":
    case "flags":
    case "links":
    case "refs":
    case "gallery":
    case "markdown":
      return [node.bind];
    case "facts":
      return node.rows.map((row) => row.bind);
    case "list":
      return [node.title, ...node.meta, ...(node.status === null ? [] : [node.status])];
    case "table":
      return node.columns.map((column) => column.bind);
    case "meter":
      return [node.value, node.max];
    case "collapsible":
      return [
        ...(node.title === null ? [] : [node.title]),
        ...node.meta,
        ...node.children.flatMap(nodeBinds),
      ];
    case "group":
      return node.children.flatMap(nodeBinds);
    // --- blocks additions ---
    case "stat":
      return [node.value, ...optional(node.delta), ...optional(node.tone)];
    case "chart":
      return [...optional(node.x), node.y];
    case "timeline":
      return [node.at, node.title, ...node.meta, ...optional(node.tone)];
    case "callout":
      return node.text === null ? [] : [node.text];
    case "code":
      return [node.bind];
    // --- end blocks additions ---
    case "label":
    case "draft":
    case "choice":
      return [];
  }
};

/** The record fields a section body reads through `row.*`. */
export const rowFields = (body: ReadonlyArray<unknown>): ReadonlySet<string> => {
  const fields = new Set<string>();
  for (const raw of body) {
    const node = decodeNode(raw);
    if (Option.isNone(node)) continue;
    for (const bind of nodeBinds(node.value)) {
      if (!bind.startsWith("row.")) continue;
      const path = bind.slice(4);
      for (const field of DERIVED_SOURCES[path] ?? [path]) fields.add(field);
    }
  }
  return fields;
};

type Fields = Readonly<Record<string, unknown>>;

const has = (values: ReadonlyArray<string> | undefined, value: unknown) =>
  values === undefined || (typeof value === "string" && values.includes(value));

const matches = (query: ViewQuery, record: Fields): boolean => {
  const where = query.where;
  if (where === undefined) return true;
  if (where.subMissionId !== undefined && record.subMissionId !== where.subMissionId) return false;
  if (where.laneId !== undefined && record.laneId !== where.laneId) return false;
  if (query.kind === "work-item" && !has(where.workKind, record.kind)) return false;
  if (query.kind === "approval" && !has(where.approvalKind, record.kind)) return false;
  if (!has(where.channel, record.channel)) return false;
  if (where.requestedBy !== undefined && record.requestedBy !== where.requestedBy) return false;
  if (where.flag !== undefined) {
    const flags = Array.isArray(record.flags) ? record.flags : [];
    if (!flags.includes(where.flag)) return false;
  }
  return true;
};

/** The store's status column: stage for work, type for notes. */
const statusFilter = (query: ViewQuery): ReadonlyArray<string> | undefined => {
  switch (query.kind) {
    case "work-item":
      return query.where?.stage;
    case "note":
      return query.where?.noteType;
    case "call":
      return undefined;
    default:
      return query.where?.status;
  }
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const touchedAt = (record: Fields) =>
  text(record.updatedAt) || text(record.decidedAt) || text(record.at) || text(record.createdAt);

const compare = (query: ViewQuery) => (left: Fields, right: Fields) => {
  switch (query.sort) {
    case "updated-desc":
      return touchedAt(right).localeCompare(touchedAt(left));
    case "created-desc":
      return text(right.createdAt).localeCompare(text(left.createdAt));
    case "rank":
      return Number(left.order ?? 0) - Number(right.order ?? 0);
    case "due": {
      const a = text(left.targetAt);
      const b = text(right.targetAt);
      if (a === b) return text(left.createdAt).localeCompare(text(right.createdAt));
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    }
  }
};

const labelOf = (record: Fields) =>
  text(record.title) || text(record.question) || text(record.summary) || text(record.id);

const rowOf = (
  kind: ViewQueryKind,
  record: Fields,
  fields: ReadonlySet<string>,
): ViewSectionRow => {
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    if (record[field] !== undefined) value[field] = record[field];
  }
  const ref: MissionRecordRef = { kind, id: text(record.id), label: labelOf(record) };
  return { ref, value };
};

// Report rows come from the scribe's own table and never carry the text itself.
const REPORT_KINDS: ReadonlyArray<ReportKind> = ["daily", "update"];

/** "850 chars", "22k chars". */
export const reportSize = (chars: number): string =>
  chars < 1000 ? `${chars} chars` : `${Math.round(chars / 1000)}k chars`;

const reportRow = (
  report: ReportSummary,
  fields: ReadonlySet<string>,
  zone: DateTime.TimeZone | null,
): ViewSectionRow => {
  const title = reportTitle(report);
  const all: Fields = {
    title,
    kind: report.kind,
    period: reportPeriod(report.coversFrom, report.coversTo, zone),
    size: reportSize(report.size),
    coversFrom: report.coversFrom,
    coversTo: report.coversTo,
    createdAt: report.createdAt,
  };
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    if (all[field] !== undefined) value[field] = all[field];
  }
  return { ref: { kind: "report", id: report.reportId, label: title }, value };
};

export interface SectionSources {
  readonly store: MissionStore.MissionStore["Service"];
  readonly scribe: ScribeStore["Service"];
}

/** Rows for one query section, or null for a refs section. */
export const sectionRows = (
  { store, scribe }: SectionSources,
  missionId: MissionId,
  section: ViewSection,
) =>
  Effect.gen(function* () {
    const source = section.definition.source;
    if (source._tag !== "query") return null;
    const query = source.query;
    const fields = rowFields(section.definition.body);
    if (query.kind === "report") {
      const listed = yield* scribe
        .listReports(missionId, query.where?.reportKind ?? REPORT_KINDS, query.limit)
        .pipe(Effect.orDie);
      const zone = reportZone(Option.getOrNull(yield* store.get("mission", missionId)));
      const data: ViewSectionData = {
        sectionId: section.id,
        rows: listed.rows.map((report) => reportRow(report, fields, zone)),
        total: listed.total,
      };
      return data;
    }
    const all = yield* store.listAllInMission(query.kind, missionId, statusFilter(query));
    const matched = (all as ReadonlyArray<Fields>).filter((record) => matches(query, record));
    const rows = matched
      .toSorted(compare(query))
      .slice(0, query.limit)
      .map((record) => rowOf(query.kind, record, fields));
    const data: ViewSectionData = { sectionId: section.id, rows, total: matched.length };
    return data;
  });

/** Rows for every active query section of a mission. */
export const sectionData = (
  sources: SectionSources,
  missionId: MissionId,
  sections: ReadonlyArray<ViewSection>,
) =>
  Effect.forEach(
    sections.filter((section) => section.status === "active"),
    (section) => sectionRows(sources, missionId, section),
  ).pipe(Effect.map((all) => all.filter((data): data is ViewSectionData => data !== null)));

/** Record kinds an active section queries; a commit touching one refreshes rows. */
export const queriedKinds = (sections: ReadonlyArray<ViewSection>): ReadonlySet<string> =>
  new Set(
    sections.flatMap((section) =>
      section.status === "active" && section.definition.source._tag === "query"
        ? [section.definition.source.query.kind]
        : [],
    ),
  );
