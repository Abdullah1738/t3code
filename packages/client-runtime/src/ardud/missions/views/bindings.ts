import {
  VIEW_DERIVED_PATHS,
  VIEW_PATHS,
  VIEW_REF_ROW_PATHS,
  VIEW_SECTION_PATHS,
  type AskOption,
  type MissionActor,
  type MissionId,
  type MissionLink,
  type MissionRecordRef,
  type ViewFieldValue,
  type ViewLongTextInput,
  type ViewPathScope,
  type ViewValueKind,
} from "@t3tools/contracts";

import { actorLabel, formatRelative } from "../viewModel.ts";

// Bindings name a record path, a template field or a section row. They resolve
// to plain values the card blocks render; anything missing resolves to null
// and its block is left out.

export type ViewValue =
  /** `number` is set when the value is a number (counts, meters). */
  | { readonly kind: "text"; readonly text: string; readonly number?: number }
  | { readonly kind: "flags"; readonly flags: ReadonlyArray<string> }
  | { readonly kind: "links"; readonly links: ReadonlyArray<MissionLink> }
  | { readonly kind: "refs"; readonly refs: ReadonlyArray<MissionRecordRef> }
  | { readonly kind: "options"; readonly options: ReadonlyArray<AskOption> }
  | { readonly kind: "assets"; readonly assetIds: ReadonlyArray<string> }
  // --- blocks additions ---
  | { readonly kind: "series"; readonly points: ReadonlyArray<number> };
// --- end blocks additions ---

export interface ViewBindContext {
  /** What `record.<path>` reads; its paths follow the scope's table. */
  readonly scope: ViewPathScope | null;
  readonly record: object | null;
  /** Values for `field.<key>`, from the record's `view.fields`. */
  readonly fields?: Readonly<Record<string, ViewFieldValue>>;
  /** What `row.<path>` reads inside a section list; `ref` is the row's record. */
  readonly row?: {
    readonly scope: ViewPathScope | "refs";
    readonly value: object;
    readonly ref?: MissionRecordRef | null;
  } | null;
  /** Section-level `row.count` / `row.total`. */
  readonly section?: { readonly count: number; readonly total: number };
  readonly nowMs: number;
  readonly masterRoleId?: string | null;
  /** Where long row values load from. */
  readonly missionId?: MissionId | null;
}

const text = (value: string | null | undefined): ViewValue | null =>
  typeof value === "string" && value.trim() !== "" ? { kind: "text", text: value } : null;

const isActor = (value: unknown): value is MissionActor =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { _tag?: unknown })._tag === "string";

const isLink = (value: unknown): value is MissionLink =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === "string" &&
  typeof (value as { label?: unknown }).label === "string";

const isRef = (value: unknown): value is MissionRecordRef =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { kind?: unknown }).kind === "string" &&
  typeof (value as { id?: unknown }).id === "string" &&
  ["string", "undefined"].includes(typeof (value as { label?: unknown }).label);

const isOption = (value: unknown): value is AskOption =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { label?: unknown }).label === "string";

const field = (value: object, key: string): unknown =>
  Object.hasOwn(value, key) ? (value as Readonly<Record<string, unknown>>)[key] : undefined;

/** "merge-ready" reads "merge ready"; booleans read yes/no. */
export function viewEnumLabel(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value.replaceAll("-", " ");
}

const numberText = (value: number, path: string): string => {
  if (path === "confidence" && value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const numberValue = (value: number, path: string): ViewValue => ({
  kind: "text",
  text: numberText(value, path),
  number: value,
});

/** Text for object-shaped `text` paths (recommendation, writtenBy, deferral). */
const objectText = (value: object): string | null => {
  for (const key of ["reason", "what", "model", "roleId", "label", "title"]) {
    const part = field(value, key);
    if (typeof part === "string" && part.trim() !== "") return part.split("\n")[0] ?? part;
  }
  return null;
};

const coerce = (
  raw: unknown,
  kind: ViewValueKind,
  path: string,
  context: ViewBindContext,
): ViewValue | null => {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case "text":
      if (typeof raw === "string") return text(raw);
      if (typeof raw === "number") return numberValue(raw, path);
      return typeof raw === "object" ? text(objectText(raw)) : null;
    case "number":
      return typeof raw === "number" ? numberValue(raw, path) : null;
    case "time":
      return typeof raw === "string" ? text(formatRelative(raw, context.nowMs)) : null;
    case "actor":
      return isActor(raw) ? text(actorLabel(raw, context.masterRoleId ?? null)) : null;
    case "enum":
      return typeof raw === "string" || typeof raw === "boolean" ? text(viewEnumLabel(raw)) : null;
    case "link":
      return isLink(raw) ? { kind: "links", links: [raw] } : null;
    case "pr": {
      if (typeof raw !== "object") return null;
      const repository = field(raw, "repository");
      const number = field(raw, "number");
      return typeof repository === "string" && typeof number === "number"
        ? text(`${repository}#${number}`)
        : null;
    }
    case "flags":
      return Array.isArray(raw)
        ? { kind: "flags", flags: raw.filter((flag): flag is string => typeof flag === "string") }
        : null;
    case "links":
      return Array.isArray(raw) ? { kind: "links", links: raw.filter(isLink) } : null;
    case "refs":
      if (isRef(raw)) return { kind: "refs", refs: [raw] };
      return Array.isArray(raw) ? { kind: "refs", refs: raw.filter(isRef) } : null;
    case "options":
      return Array.isArray(raw) ? { kind: "options", options: raw.filter(isOption) } : null;
    case "assets":
      return Array.isArray(raw)
        ? { kind: "assets", assetIds: raw.filter((id): id is string => typeof id === "string") }
        : null;
    // Long values stay off the snapshot; a markdown block loads them on open.
    case "longtext":
      return typeof raw === "string" ? text(raw) : null;
    case "facts": {
      if (typeof raw !== "object") return null;
      const parts = Object.entries(raw).flatMap(([key, value]) =>
        typeof value === "string" && value !== "" ? [`${key}: ${value}`] : [],
      );
      return text(parts.join(" · "));
    }
    // --- blocks additions ---
    case "series":
      return Array.isArray(raw)
        ? {
            kind: "series",
            points: raw.filter(
              (point): point is number => typeof point === "number" && Number.isFinite(point),
            ),
          }
        : null;
    // --- end blocks additions ---
  }
};

/** Who made the record, for the derived `by` path. */
const authorOf = (record: object): unknown => {
  for (const key of ["decidedBy", "heldBy", "author", "requestedBy", "fromTitle"]) {
    const value = field(record, key);
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
};

const derived = (record: object, path: string, context: ViewBindContext): ViewValue | null => {
  switch (path) {
    case "age":
      return coerce(field(record, "createdAt"), "time", path, context);
    case "by": {
      const author = authorOf(record);
      if (isActor(author)) return coerce(author, "actor", path, context);
      return typeof author === "string" ? text(viewEnumLabel(author)) : null;
    }
    case "approver": {
      const approver = field(record, "approver") ?? field(record, "acceptor");
      if (typeof approver === "string") return text(approver);
      // Approvals and drafts written before routing are the owner's.
      return field(record, "status") !== undefined &&
        (context.scope === "approval" || context.scope === "draft")
        ? text("owner")
        : null;
    }
    default:
      return null;
  }
};

const lookup = (table: Readonly<Record<string, ViewValueKind>>, path: string) =>
  Object.hasOwn(table, path) ? table[path] : undefined;

const resolvePath = (
  scope: ViewPathScope | "refs",
  value: object,
  path: string,
  context: ViewBindContext,
): ViewValue | null => {
  const table = scope === "refs" ? VIEW_REF_ROW_PATHS : VIEW_PATHS[scope];
  const kind = lookup(table, path);
  if (kind !== undefined) {
    // A refs row's title is the ref's label.
    const raw =
      scope === "refs" && path === "title"
        ? (field(value, "label") ?? field(value, "id"))
        : field(value, path);
    return coerce(raw, kind, path, context);
  }
  return lookup(VIEW_DERIVED_PATHS, path) === undefined ? null : derived(value, path, context);
};

const fieldValue = (value: ViewFieldValue): ViewValue | null => {
  switch (value._tag) {
    case "short":
    case "text":
    case "choice":
      return text(value.value);
    case "number":
      return numberValue(value.value, "");
    case "flags":
      return { kind: "flags", flags: value.value };
    case "links":
      return { kind: "links", links: value.value };
    case "refs":
      return { kind: "refs", refs: value.value };
    case "assets":
      return { kind: "assets", assetIds: value.value };
  }
};

/** Resolves `record.<path>`, `field.<key>` or `row.<path>`; null when there is nothing to show. */
export function resolveViewBind(bind: string, context: ViewBindContext): ViewValue | null {
  const dot = bind.indexOf(".");
  if (dot < 0) return null;
  const scope = bind.slice(0, dot);
  const path = bind.slice(dot + 1);
  switch (scope) {
    case "record":
      return context.scope === null || context.record === null
        ? null
        : resolvePath(context.scope, context.record, path, context);
    case "field": {
      const fields = context.fields;
      if (fields === undefined || !Object.hasOwn(fields, path)) return null;
      const value = fields[path];
      return value === undefined ? null : fieldValue(value);
    }
    case "row": {
      if (context.row) return resolvePath(context.row.scope, context.row.value, path, context);
      if (context.section && lookup(VIEW_SECTION_PATHS, path) !== undefined) {
        return numberValue(path === "count" ? context.section.count : context.section.total, path);
      }
      return null;
    }
    default:
      return null;
  }
}

/** Where a row's `longtext` value loads from; null for any other bind. */
export function viewLongTextSource(
  bind: string,
  context: ViewBindContext,
): ViewLongTextInput | null {
  const row = context.row;
  if (!bind.startsWith("row.") || !row?.ref || row.scope === "refs" || !context.missionId) {
    return null;
  }
  const path = bind.slice("row.".length);
  return lookup(VIEW_PATHS[row.scope], path) === "longtext"
    ? { missionId: context.missionId, ref: row.ref, path }
    : null;
}

/** A value as one line of text, for titles, text blocks and fact rows. */
export function viewValueText(value: ViewValue | null): string | null {
  if (value === null) return null;
  switch (value.kind) {
    case "text":
      return value.text;
    case "flags":
      return value.flags.length === 0 ? null : value.flags.join(", ");
    case "links":
      return value.links.length === 0 ? null : value.links.map((link) => link.label).join(", ");
    case "refs":
      return value.refs.length === 0
        ? null
        : value.refs.map((ref) => ref.label?.trim() || ref.id).join(", ");
    case "options":
      return value.options.length === 0
        ? null
        : value.options.map((option) => option.label).join(", ");
    case "assets":
      return value.assetIds.length === 0
        ? null
        : `${value.assetIds.length} ${value.assetIds.length === 1 ? "image" : "images"}`;
    // --- blocks additions ---
    case "series": {
      const last = value.points.at(-1);
      return last === undefined ? null : numberText(last, "");
    }
    // --- end blocks additions ---
  }
}

/** A value as a number: the number itself, or how many items a list holds. */
export function viewValueCount(value: ViewValue | null): number | null {
  if (value === null) return null;
  switch (value.kind) {
    case "text":
      return value.number ?? null;
    case "flags":
      return value.flags.length;
    case "links":
      return value.links.length;
    case "refs":
      return value.refs.length;
    case "options":
      return value.options.length;
    case "assets":
      return value.assetIds.length;
    // --- blocks additions ---
    case "series":
      return value.points.at(-1) ?? null;
    // --- end blocks additions ---
  }
}
