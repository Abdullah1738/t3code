/**
 * A source script's stdout, checked against the fields its source declares.
 * Anything off (shape, a missing id, a wrong kind, a plain-http link) fails
 * the whole run so the cache keeps the last good rows instead of half a list.
 */
import {
  type MissionLink,
  VIEW_HARD_LIMITS,
  VIEW_SOURCE_LIMITS,
  type ViewSourceFieldKind,
  type ViewSourceFields,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type SourceRow = Readonly<Record<string, unknown>> & { readonly id: string };

export type ParsedRows =
  | { readonly ok: true; readonly rows: ReadonlyArray<SourceRow> }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

const MAX_ERRORS = 20;
const ENUM_CHARS = 80;
const NAME_CHARS = 80;
const LABEL_CHARS = 200;

const LINK_KINDS: ReadonlySet<string> = new Set([
  "pull-request",
  "commit",
  "ci-run",
  "ticket",
  "deploy",
  "transcript",
  "file",
  "url",
]);

type Normalized = { readonly value: unknown } | { readonly error: string };

const cap = (text: string, chars: number) => (text.length > chars ? text.slice(0, chars) : text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const httpsUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

const linkOf = (raw: unknown): MissionLink | string => {
  const input = typeof raw === "string" ? { url: raw } : raw;
  if (!isRecord(input) || typeof input.url !== "string") return "not a link";
  const url = httpsUrl(input.url);
  if (url === null) return "links must be https URLs";
  const label =
    typeof input.label === "string" && input.label.trim() !== ""
      ? input.label.trim()
      : `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  const kind =
    typeof input.kind === "string" && LINK_KINDS.has(input.kind)
      ? (input.kind as MissionLink["kind"])
      : "url";
  return { kind, label: cap(label, LABEL_CHARS), url: url.href, ref: null };
};

const normalize = (raw: unknown, kind: ViewSourceFieldKind): Normalized => {
  switch (kind) {
    case "text":
      if (typeof raw === "string") return { value: cap(raw, VIEW_SOURCE_LIMITS.textChars) };
      if (typeof raw === "number" || typeof raw === "boolean") return { value: String(raw) };
      return { error: "not text" };
    case "longtext":
      if (typeof raw === "string") return { value: cap(raw, VIEW_SOURCE_LIMITS.longTextChars) };
      return { error: "not text" };
    case "enum":
      if (typeof raw === "string") return { value: cap(raw, ENUM_CHARS) };
      if (typeof raw === "boolean") return { value: raw };
      return { error: "not a string or boolean" };
    case "number":
      return typeof raw === "number" && Number.isFinite(raw)
        ? { value: raw }
        : { error: "not a number" };
    case "series": {
      if (!Array.isArray(raw)) return { error: "not a list of numbers" };
      if (!raw.every((point) => typeof point === "number" && Number.isFinite(point))) {
        return { error: "not a list of numbers" };
      }
      return { value: raw.slice(Math.max(0, raw.length - VIEW_HARD_LIMITS.chartPoints)) };
    }
    case "time": {
      if (typeof raw !== "string") return { error: "not an ISO time" };
      const at = DateTime.make(raw);
      return Option.isNone(at)
        ? { error: "not an ISO time" }
        : { value: DateTime.formatIso(at.value) };
    }
    case "actor": {
      const name = isRecord(raw) ? raw.name : raw;
      if (typeof name !== "string" || name.trim() === "") return { error: "not a name" };
      return { value: { _tag: "person", name: cap(name.trim(), NAME_CHARS) } };
    }
    case "link": {
      const link = linkOf(raw);
      return typeof link === "string" ? { error: link } : { value: link };
    }
    case "links": {
      if (!Array.isArray(raw)) return { error: "not a list of links" };
      const links: Array<MissionLink> = [];
      for (const item of raw.slice(0, VIEW_SOURCE_LIMITS.links)) {
        const link = linkOf(item);
        if (typeof link === "string") return { error: link };
        links.push(link);
      }
      return { value: links };
    }
  }
};

const rowId = (raw: unknown): string | null => {
  if (typeof raw === "string" && raw.trim() !== "") return cap(raw.trim(), 200);
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
};

/** Parses and checks a run's stdout. Unknown keys are dropped; null or missing fields are fine. */
export const parseSourceOutput = (stdout: string, fields: ViewSourceFields): ParsedRows => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, errors: [`stdout is not JSON: ${cap(reason, 200)}`] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) {
    return { ok: false, errors: ['stdout must be {"rows": [...]}'] };
  }
  if (parsed.rows.length > VIEW_SOURCE_LIMITS.rows) {
    return {
      ok: false,
      errors: [`${parsed.rows.length} rows; a source returns at most ${VIEW_SOURCE_LIMITS.rows}`],
    };
  }
  const errors: Array<string> = [];
  const report = (error: string) => {
    if (errors.length < MAX_ERRORS) errors.push(error);
  };
  const seen = new Set<string>();
  const rows: Array<SourceRow> = [];
  const declared = Object.entries(fields);
  parsed.rows.forEach((raw: unknown, index) => {
    if (!isRecord(raw)) return report(`rows[${index}]: not an object`);
    const id = rowId(raw.id);
    if (id === null) return report(`rows[${index}].id: missing`);
    if (seen.has(id)) return report(`rows[${index}].id: duplicate "${cap(id, 40)}"`);
    seen.add(id);
    const row: Record<string, unknown> = { id };
    for (const [name, kind] of declared) {
      const value = raw[name];
      if (value === undefined || value === null) continue;
      const normalized = normalize(value, kind);
      if ("error" in normalized) report(`rows[${index}].${name}: ${normalized.error}`);
      else row[name] = normalized.value;
    }
    rows.push(row as SourceRow);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
};
