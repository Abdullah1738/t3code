import {
  VIEW_ACTIONS,
  VIEW_HARD_LIMITS,
  VIEW_TONE_VALUES,
  approverOf,
  builtinViewTemplate,
  selectViewTemplate,
  viewActionAllowed,
  viewMatchSubjectOf,
  ViewFieldValue,
  type Approver,
  type MissionAsset,
  type MissionLink,
  type MissionRecordRef,
  type ViewActionKey,
  type ViewBackedRecord,
  type ViewBackingKind,
  type ViewLongTextInput,
  type ViewNode,
  type ViewNodeTag,
  type ViewTableCellKind,
  type ViewTemplate,
  type ViewTemplateDefinition,
  type ViewTone,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  resolveViewBind,
  viewLongTextSource,
  viewValueCount,
  viewValueText,
  type ViewBindContext,
  type ViewValue,
} from "./bindings.ts";
import { decodeViewBody } from "./decode.ts";

// A card is a fixed frame (kicker, by-master marker, title, age, approver,
// actions) around a body the template describes. These are the props the
// card frame and its blocks render; nothing here is React.

export type ViewBlock =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly tone: "body" | "meta";
      readonly maxLines: number;
    }
  | { readonly kind: "label"; readonly text: string }
  | {
      readonly kind: "facts";
      readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    }
  | { readonly kind: "flags"; readonly flags: ReadonlyArray<string> }
  | { readonly kind: "links"; readonly links: ReadonlyArray<MissionLink> }
  | { readonly kind: "refs"; readonly refs: ReadonlyArray<MissionRecordRef> }
  | {
      readonly kind: "draft";
      readonly editable: boolean;
      /** Show a diff against `previousText` when there is one. */
      readonly diff: boolean;
      readonly text: string;
      readonly previousText: string | null;
      readonly channel: string | null;
      readonly audience: string | null;
      readonly target: MissionLink | null;
    }
  | {
      readonly kind: "choice";
      readonly options: ReadonlyArray<ViewChoiceOption>;
      readonly recommendation: string | null;
    }
  | {
      readonly kind: "list";
      readonly rows: ReadonlyArray<ViewListRow>;
    }
  | {
      readonly kind: "table";
      readonly columns: ReadonlyArray<{ readonly label: string; readonly as: ViewTableCellKind }>;
      readonly rows: ReadonlyArray<ViewTableRow>;
    }
  | { readonly kind: "meter"; readonly value: number; readonly max: number }
  | {
      readonly kind: "gallery";
      /** The owner marks each image ok or to change, with a note and a pin. */
      readonly review: boolean;
      readonly assets: ReadonlyArray<ViewGalleryAsset>;
    }
  | {
      readonly kind: "group";
      readonly direction: "column" | "row";
      readonly children: ReadonlyArray<ViewBlock>;
    }
  // --- views additions ---
  | {
      readonly kind: "markdown";
      /** Null while the text waits on `source`. */
      readonly text: string | null;
      /** Set for long values left off the snapshot: load them when the block shows. */
      readonly source: ViewLongTextInput | null;
      readonly maxLines: number | null;
    }
  | {
      readonly kind: "collapsible";
      /** `first` starts the first item open. */
      readonly open: "none" | "first";
      readonly items: ReadonlyArray<ViewCollapsibleItem>;
    }
  // --- end views additions ---
  // --- blocks additions ---
  | { readonly kind: "stat"; readonly label: string; readonly tiles: ReadonlyArray<ViewStatTile> }
  | {
      readonly kind: "chart";
      readonly type: "line" | "bar";
      readonly charts: ReadonlyArray<ViewChart>;
    }
  | { readonly kind: "timeline"; readonly entries: ReadonlyArray<ViewTimelineEntry> }
  | { readonly kind: "callout"; readonly tone: ViewTone; readonly texts: ReadonlyArray<string> }
  | {
      readonly kind: "code";
      readonly label: string | null;
      /** Null while the text waits on `source`. */
      readonly text: string | null;
      readonly source: ViewLongTextInput | null;
    };

export interface ViewStatTile {
  readonly key: string;
  /** Compact past 999: 1.4k, 2.1M. */
  readonly value: string;
  readonly prefix: string | null;
  readonly suffix: string | null;
  /** Signed when the delta is a number. */
  readonly delta: string | null;
  readonly tone: ViewTone | null;
}

export interface ViewChartPoint {
  readonly label: string | null;
  readonly value: number;
}

export interface ViewChart {
  readonly key: string;
  /** Names a per-row series chart; null for a chart across rows. */
  readonly title: string | null;
  readonly points: ReadonlyArray<ViewChartPoint>;
}

export interface ViewTimelineEntry {
  readonly key: string;
  readonly at: string | null;
  readonly title: string;
  readonly meta: ReadonlyArray<string>;
  readonly tone: ViewTone | null;
  readonly ref: MissionRecordRef | null;
}
// --- end blocks additions ---

// --- views additions ---
/** One folded item: a section row, or the card itself. Children render only when open. */
export interface ViewCollapsibleItem {
  readonly key: string;
  readonly title: string;
  readonly meta: ReadonlyArray<string>;
  readonly children: ReadonlyArray<ViewBlock>;
}
// --- end views additions ---

export interface ViewChoiceOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly recommended: boolean;
}

export interface ViewListRow {
  readonly key: string;
  readonly title: string;
  readonly meta: ReadonlyArray<string>;
  readonly status: string | null;
  /** What tapping the row opens. */
  readonly ref: MissionRecordRef | null;
}

export interface ViewTableCell {
  readonly text: string | null;
  /** Set on `link` cells that resolve to a link. */
  readonly link: MissionLink | null;
}

export interface ViewTableRow {
  readonly key: string;
  readonly cells: ReadonlyArray<ViewTableCell>;
  readonly ref: MissionRecordRef | null;
}

export interface ViewGalleryAsset {
  /** Served as an `attachment` asset resource under this id. */
  readonly id: string;
  readonly name: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** One section row, resolved: what list and table blocks iterate. */
export interface ViewRowContext {
  readonly key: string;
  readonly ref: MissionRecordRef | null;
  readonly context: ViewBindContext;
}

export interface ViewCardAction {
  readonly key: ViewActionKey;
  readonly label: string;
  readonly primary: boolean;
  /** The owner's WS method; null for client navigation (`open`) and Discuss. */
  readonly ownerMethod: string | null;
}

export interface ViewCardView {
  readonly kind: ViewBackingKind;
  readonly templateId: string;
  readonly source: "explicit" | "match" | "builtin";
  readonly kicker: string | null;
  /** The by-master hexagon: only on templates a master made. */
  readonly madeBy: "master" | null;
  readonly title: string;
  /** ISO time the age reads from. */
  readonly since: string | null;
  readonly approver: Approver | null;
  readonly blocks: ReadonlyArray<ViewBlock>;
  readonly actions: ReadonlyArray<ViewCardAction>;
  /** Body nodes dropped while decoding (unknown, malformed or not allowed). */
  readonly dropped: number;
}

export interface ViewCardOptions {
  readonly nowMs: number;
  readonly masterRoleId?: string | null;
  /** The mission's active images; gallery blocks show only these. */
  readonly assets?: ReadonlyArray<MissionAsset>;
}

/** Blocks that iterate section rows; cards have none. */
const ROWS_ONLY: ReadonlySet<ViewNodeTag> = new Set([
  "list",
  "table",
  // --- blocks additions ---
  "chart",
  "timeline",
  // --- end blocks additions ---
]);

/** Node kinds a card of this kind renders. Lists, tables, charts and timelines belong to sections. */
export const viewCardAllows =
  (kind: ViewBackingKind) =>
  (tag: ViewNodeTag): boolean => {
    if (ROWS_ONLY.has(tag)) return false;
    if (tag === "draft") return kind === "draft";
    if (tag === "choice") return kind === "ask";
    return true;
  };

const recordField = (record: object, key: string): unknown =>
  Object.hasOwn(record, key) ? (record as Readonly<Record<string, unknown>>)[key] : undefined;

const stringOr = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const decodeFieldValue = Schema.decodeUnknownOption(ViewFieldValue);

/** Template field values, once records carry `view.fields`; malformed values are dropped. */
const viewFieldsOf = (record: object): Readonly<Record<string, ViewFieldValue>> => {
  const view = recordField(record, "view");
  if (typeof view !== "object" || view === null) return {};
  const fields = recordField(view, "fields");
  if (typeof fields !== "object" || fields === null) return {};
  const decoded: Record<string, ViewFieldValue> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = decodeFieldValue(raw);
    if (Option.isSome(value)) decoded[key] = value.value;
  }
  return decoded;
};

const draftBlock = (
  backed: ViewBackedRecord,
  node: Extract<ViewNode, { _tag: "draft" }>,
): ViewBlock | null => {
  if (backed.kind !== "draft") return null;
  const draft = backed.record;
  return {
    kind: "draft",
    editable: node.editable,
    diff: node.diff,
    text: draft.text,
    // Draft.previousText arrives with the asks round; read it when present.
    previousText: stringOr(recordField(draft, "previousText")),
    channel: draft.channel,
    audience: draft.audience,
    target: draft.target,
  };
};

const choiceBlock = (backed: ViewBackedRecord): ViewBlock | null => {
  if (backed.kind !== "ask") return null;
  const ask = backed.record;
  if (ask.options.length === 0) return null;
  const recommended = ask.recommendation?.optionId ?? null;
  return {
    kind: "choice",
    options: ask.options.map((option) => ({
      id: option.id,
      label: option.label,
      detail: option.detail,
      recommended: option.id === recommended,
    })),
    recommendation: stringOr(ask.recommendation?.reason),
  };
};

const tableCell = (value: ViewValue | null, as: ViewTableCellKind): ViewTableCell => {
  if (as === "count") {
    const count = viewValueCount(value);
    return { text: count === null ? null : String(count), link: null };
  }
  if (as === "link" && value?.kind === "links") {
    const link = value.links[0] ?? null;
    return { text: link?.label ?? null, link };
  }
  return { text: viewValueText(value), link: null };
};

const listRow = (
  node: Extract<ViewNode, { _tag: "list" }>,
  row: ViewRowContext,
): ViewListRow | null => {
  const title = viewValueText(resolveViewBind(node.title, row.context));
  if (title === null) return null;
  return {
    key: row.key,
    title,
    meta: node.meta.flatMap((bind) => {
      const value = viewValueText(resolveViewBind(bind, row.context));
      return value === null ? [] : [value];
    }),
    status: node.status === null ? null : viewValueText(resolveViewBind(node.status, row.context)),
    ref: row.ref,
  };
};

const galleryBlock = (
  node: Extract<ViewNode, { _tag: "gallery" }>,
  context: ViewBindContext,
  backed: ViewBackedRecord | null,
  assets: ReadonlyArray<MissionAsset> | undefined,
): ViewBlock | null => {
  const value = resolveViewBind(node.bind, context);
  if (value?.kind !== "assets") return null;
  const known = new Map((assets ?? []).map((asset) => [asset.id as string, asset]));
  const shown = value.assetIds.flatMap((id): ViewGalleryAsset[] => {
    const asset = known.get(id);
    // Removed and expired images, and ones this client hasn't loaded, are left out.
    if (asset === undefined) return [];
    return [{ id, name: asset.name, width: asset.width, height: asset.height }];
  });
  if (shown.length === 0) return null;
  // Per-image marks are an answer, so only open asks take them.
  const review =
    node.review === "per-asset" && backed?.kind === "ask" && backed.record.status === "open";
  return { kind: "gallery", review, assets: shown };
};

// --- views additions ---
const collapsibleItem = (
  node: Extract<ViewNode, { _tag: "collapsible" }>,
  key: string,
  context: ViewBindContext,
  backed: ViewBackedRecord | null,
  assets: ReadonlyArray<MissionAsset> | undefined,
): ViewCollapsibleItem | null => {
  const title =
    (node.title === null ? null : viewValueText(resolveViewBind(node.title, context))) ??
    node.label ??
    null;
  if (title === null) return null;
  const children = node.children.flatMap((child) => {
    const block = viewBlock(child, context, backed, assets === undefined ? {} : { assets });
    return block === null ? [] : [block];
  });
  if (children.length === 0) return null;
  return {
    key,
    title,
    meta: node.meta.flatMap((bind) => {
      const value = viewValueText(resolveViewBind(bind, context));
      return value === null ? [] : [value];
    }),
    children,
  };
};
// --- end views additions ---

// --- blocks additions ---
const PREFIX_UNITS: ReadonlySet<string> = new Set(["$", "€", "£", "¥"]);
const COMPACT_STEPS = [
  { size: 1e3, suffix: "k" },
  { size: 1e6, suffix: "M" },
  { size: 1e9, suffix: "B" },
] as const;

/** 1400 reads 1.4k; below a thousand the value's own text stands (it knows percentages). */
const compactNumber = (value: number): string | null => {
  const abs = Math.abs(value);
  if (abs < 1000) return null;
  for (const step of COMPACT_STEPS) {
    const scaled = abs / step.size;
    const digits = scaled >= 100 ? 0 : 1;
    const rounded = Number(scaled.toFixed(digits));
    if (rounded < 1000 || step.suffix === "B") {
      return `${value < 0 ? "-" : ""}${String(rounded)}${step.suffix}`;
    }
  }
  return null;
};

const statNumber = (value: ViewValue | null): string | null => {
  if (value?.kind === "text" && value.number !== undefined) {
    return compactNumber(value.number) ?? value.text;
  }
  return viewValueText(value);
};

const toneOf = (bind: string | undefined, context: ViewBindContext): ViewTone | null => {
  if (bind === undefined) return null;
  // Enum text reads "at risk"; the tone table keeps the raw "at-risk".
  const text = viewValueText(resolveViewBind(bind, context))
    ?.trim()
    .toLowerCase()
    .replaceAll(" ", "-");
  if (text === undefined) return null;
  for (const [tone, values] of Object.entries(VIEW_TONE_VALUES)) {
    if (values.includes(text)) return tone as ViewTone;
  }
  return null;
};

const statTile = (
  node: Extract<ViewNode, { _tag: "stat" }>,
  key: string,
  context: ViewBindContext,
): ViewStatTile | null => {
  const value = statNumber(resolveViewBind(node.value, context));
  if (value === null) return null;
  const unit = node.unit ?? null;
  const prefix = unit !== null && PREFIX_UNITS.has(unit) ? unit : null;
  let delta: string | null = null;
  if (node.delta !== undefined) {
    const raw = resolveViewBind(node.delta, context);
    const number = raw?.kind === "text" ? raw.number : undefined;
    const text = statNumber(raw);
    delta = number !== undefined && number > 0 && text !== null ? `+${text}` : text;
  }
  return {
    key,
    value,
    prefix,
    suffix: prefix === null ? unit : null,
    delta,
    tone: toneOf(node.tone, context),
  };
};

const statBlock = (
  node: Extract<ViewNode, { _tag: "stat" }>,
  context: ViewBindContext,
  rows: ReadonlyArray<ViewRowContext> | undefined,
): ViewBlock | null => {
  // row.count and row.total read the section, so they make one tile for all of it.
  const perRow = rows !== undefined && node.value !== "row.count" && node.value !== "row.total";
  const tiles = (perRow ? rows : [{ key: "one", context }]).flatMap((row) => {
    const tile = statTile(node, row.key, row.context);
    return tile === null ? [] : [tile];
  });
  return tiles.length === 0 ? null : { kind: "stat", label: node.label, tiles };
};

const lastPoints = <A>(points: ReadonlyArray<A>): ReadonlyArray<A> =>
  points.slice(Math.max(0, points.length - VIEW_HARD_LIMITS.chartPoints));

const chartBlock = (
  node: Extract<ViewNode, { _tag: "chart" }>,
  rows: ReadonlyArray<ViewRowContext>,
): ViewBlock | null => {
  const across: Array<ViewChartPoint> = [];
  const perRow: Array<ViewChart> = [];
  for (const row of rows) {
    const y = resolveViewBind(node.y, row.context);
    const label = node.x === undefined ? null : viewValueText(resolveViewBind(node.x, row.context));
    if (y?.kind === "series") {
      const points = lastPoints(y.points).map((value) => ({ label: null, value }));
      if (points.length > 0) perRow.push({ key: row.key, title: label, points });
      continue;
    }
    const value = viewValueCount(y);
    if (value !== null && Number.isFinite(value)) across.push({ label, value });
  }
  const charts: Array<ViewChart> =
    across.length === 0
      ? perRow
      : [{ key: "rows", title: null, points: lastPoints(across) }, ...perRow];
  return charts.length === 0 ? null : { kind: "chart", type: node.type, charts };
};

const timelineBlock = (
  node: Extract<ViewNode, { _tag: "timeline" }>,
  rows: ReadonlyArray<ViewRowContext>,
): ViewBlock | null => {
  const entries = rows.flatMap((row): ViewTimelineEntry[] => {
    const title = viewValueText(resolveViewBind(node.title, row.context));
    if (title === null) return [];
    return [
      {
        key: row.key,
        at: viewValueText(resolveViewBind(node.at, row.context)),
        title,
        meta: node.meta.flatMap((bind) => {
          const value = viewValueText(resolveViewBind(bind, row.context));
          return value === null ? [] : [value];
        }),
        tone: toneOf(node.tone, row.context),
        ref: row.ref,
      },
    ];
  });
  return entries.length === 0 ? null : { kind: "timeline", entries };
};

const calloutBlock = (
  node: Extract<ViewNode, { _tag: "callout" }>,
  context: ViewBindContext,
  rows: ReadonlyArray<ViewRowContext> | undefined,
): ViewBlock | null => {
  const bind = node.text;
  const texts =
    bind === null
      ? []
      : (rows ?? [{ context }]).flatMap((row) => {
          const value = viewValueText(resolveViewBind(bind, row.context));
          return value === null ? [] : [value];
        });
  const shown = texts.length > 0 ? texts : node.label === undefined ? [] : [node.label];
  return shown.length === 0 ? null : { kind: "callout", tone: node.tone, texts: shown };
};

export interface ViewChartScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: ReadonlyArray<{ readonly value: number; readonly label: string }>;
}

const chartLabel = (value: number): string =>
  compactNumber(value) ?? String(Number(value.toFixed(2)));

/** Three steps cover the data; rounding out at both ends can add one more. */
const CHART_TICKS_MAX = 6;

/** Round y ticks that always include zero, so bars stand on a real baseline. */
export function viewChartScale(points: ReadonlyArray<ViewChartPoint>): ViewChartScale {
  const values = points.map((point) => point.value).filter(Number.isFinite);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = high - low || 1;
  const rough = span / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.max(Math.ceil(high / step) * step, min + step);
  // Values near Number.MAX_VALUE overflow the rounded bounds (or the span) to
  // Infinity, and a denormal span rounds the step to 0; the plot then spans
  // the raw values (high > low here) with no ticks between.
  const raw: ViewChartScale = {
    min: low,
    max: high,
    ticks: [low, high].map((value) => ({ value, label: chartLabel(value) })),
  };
  if (!([span, step, min, max].every(Number.isFinite) && step > 0)) return raw;
  // Divided first, so bounds near ±MAX_VALUE don't overflow the count.
  const count = Math.min(CHART_TICKS_MAX, Math.round(max / step - min / step) + 1);
  const ticks = Array.from({ length: count }, (_, slot) => {
    const clean = Number((min + slot * step).toPrecision(12));
    return { value: clean, label: chartLabel(clean) };
  });
  return ticks.every((tick) => Number.isFinite(tick.value)) ? { min, max, ticks } : raw;
}

/** How high a value sits on the scale, 0 at the bottom and 1 at the top. */
export function viewChartFraction(scale: ViewChartScale, value: number): number {
  const span = scale.max - scale.min;
  if (Number.isFinite(span)) return (value - scale.min) / span;
  // A scale from -MAX_VALUE to MAX_VALUE spans Infinity; halved it fits.
  return (value / 2 - scale.min / 2) / (scale.max / 2 - scale.min / 2);
}

/** Up to `count` evenly spaced x labels, first and last included; a phone fits about four. */
export function viewChartLabels(
  points: ReadonlyArray<ViewChartPoint>,
  count = 4,
): ReadonlyArray<{ readonly index: number; readonly label: string }> {
  if (points.length === 0) return [];
  const slots = Math.min(count, points.length);
  const indexes = new Set(
    Array.from({ length: slots }, (_, slot) =>
      slots === 1 ? 0 : Math.round((slot * (points.length - 1)) / (slots - 1)),
    ),
  );
  return [...indexes].flatMap((index) => {
    const label = points[index]?.label ?? null;
    return label === null ? [] : [{ index, label }];
  });
}
// --- end blocks additions ---

/** What a body resolves against besides its own record: section rows and mission images. */
export interface ViewBlockSources {
  readonly rows?: ReadonlyArray<ViewRowContext>;
  readonly assets?: ReadonlyArray<MissionAsset>;
}

/** Resolves one decoded node to a block; null when it has nothing to show. */
export function viewBlock(
  node: ViewNode,
  context: ViewBindContext,
  backed: ViewBackedRecord | null,
  sources: ViewBlockSources = {},
): ViewBlock | null {
  switch (node._tag) {
    case "text": {
      const value = viewValueText(resolveViewBind(node.bind, context));
      return value === null
        ? null
        : { kind: "text", text: value, tone: node.style, maxLines: node.maxLines };
    }
    case "label":
      return { kind: "label", text: node.text };
    case "facts": {
      const rows = node.rows.flatMap((row) => {
        const value = viewValueText(resolveViewBind(row.bind, context));
        return value === null ? [] : [{ label: row.label, value }];
      });
      return rows.length === 0 ? null : { kind: "facts", rows };
    }
    case "flags": {
      const value = resolveViewBind(node.bind, context);
      if (value?.kind !== "flags" || value.flags.length === 0) return null;
      return { kind: "flags", flags: value.flags };
    }
    case "links": {
      const value = resolveViewBind(node.bind, context);
      if (value?.kind !== "links" || value.links.length === 0) return null;
      return { kind: "links", links: value.links };
    }
    case "refs": {
      const value = resolveViewBind(node.bind, context);
      if (value?.kind !== "refs" || value.refs.length === 0) return null;
      return { kind: "refs", refs: value.refs };
    }
    case "draft":
      return backed === null ? null : draftBlock(backed, node);
    case "choice":
      return backed === null ? null : choiceBlock(backed);
    case "list": {
      const rows = (sources.rows ?? []).flatMap((row) => {
        const resolved = listRow(node, row);
        return resolved === null ? [] : [resolved];
      });
      return rows.length === 0 ? null : { kind: "list", rows };
    }
    case "table": {
      const rows = (sources.rows ?? []).map((row) => ({
        key: row.key,
        ref: row.ref,
        cells: node.columns.map((column) =>
          tableCell(resolveViewBind(column.bind, row.context), column.as),
        ),
      }));
      // Rows whose every cell is empty say nothing.
      const shown = rows.filter((row) => row.cells.some((cell) => cell.text !== null));
      if (shown.length === 0) return null;
      return {
        kind: "table",
        columns: node.columns.map((column) => ({ label: column.label, as: column.as })),
        rows: shown,
      };
    }
    case "meter": {
      const value = viewValueCount(resolveViewBind(node.value, context));
      const max = viewValueCount(resolveViewBind(node.max, context));
      if (value === null || max === null || max <= 0) return null;
      return { kind: "meter", value: Math.min(Math.max(value, 0), max), max };
    }
    case "gallery":
      return galleryBlock(node, context, backed, sources.assets);
    case "group": {
      const children = node.children.flatMap((child) => {
        const block = viewBlock(child, context, backed, sources);
        return block === null ? [] : [block];
      });
      return children.length === 0 ? null : { kind: "group", direction: node.direction, children };
    }
    // --- views additions ---
    case "markdown": {
      const maxLines = node.maxLines ?? null;
      const source = viewLongTextSource(node.bind, context);
      if (source !== null) return { kind: "markdown", text: null, source, maxLines };
      const text = viewValueText(resolveViewBind(node.bind, context));
      return text === null ? null : { kind: "markdown", text, source: null, maxLines };
    }
    case "collapsible": {
      // In a section each row folds on its own; on a card the card is the one item.
      const items =
        sources.rows === undefined
          ? [collapsibleItem(node, "card", context, backed, sources.assets)]
          : sources.rows.map((row) =>
              collapsibleItem(node, row.key, row.context, backed, sources.assets),
            );
      const shown = items.filter((item): item is ViewCollapsibleItem => item !== null);
      return shown.length === 0 ? null : { kind: "collapsible", open: node.open, items: shown };
    }
    // --- end views additions ---
    // --- blocks additions ---
    case "stat":
      return statBlock(node, context, sources.rows);
    case "chart":
      return chartBlock(node, sources.rows ?? []);
    case "timeline":
      return timelineBlock(node, sources.rows ?? []);
    case "callout":
      return calloutBlock(node, context, sources.rows);
    case "code": {
      const label = node.label ?? null;
      const source = viewLongTextSource(node.bind, context);
      if (source !== null) return { kind: "code", label, text: null, source };
      const text = viewValueText(resolveViewBind(node.bind, context));
      return text === null ? null : { kind: "code", label, text, source: null };
    }
    // --- end blocks additions ---
  }
}

const actionsOf = (
  definition: ViewTemplateDefinition,
  fallback: ViewTemplateDefinition,
): ReadonlyArray<ViewCardAction> => {
  const kind = definition.backing;
  const seen = new Set<string>();
  const keys = definition.actions.filter((key) => {
    // A newer server's action this client doesn't know is left out.
    if (!Object.hasOwn(VIEW_ACTIONS, key) || !viewActionAllowed(key, kind) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const primary =
    definition.primary === undefined ? (fallback.primary ?? null) : definition.primary;
  const labels = new Map(
    (definition.actionLabels ?? []).map((entry) => [entry.action, entry.label]),
  );
  return keys.map((key) => ({
    key,
    label: labels.get(key) ?? VIEW_ACTIONS[key].label,
    primary: key === primary,
    ownerMethod: VIEW_ACTIONS[key].owner,
  }));
};

const approverFor = (backed: ViewBackedRecord): Approver | null => {
  switch (backed.kind) {
    case "approval":
    case "draft":
      return approverOf(backed.record);
    case "suggestion":
      return backed.record.acceptor;
    default:
      return null;
  }
};

const FALLBACK_TITLE: { readonly [K in ViewBackingKind]: string } = {
  ask: "Decision",
  approval: "Approval",
  draft: "Draft",
  "work-item": "Work item",
  note: "Note",
  knock: "Knock",
  suggestion: "Suggestion",
  "owner-request": "Your request",
};

/**
 * The card for a record: the template it selects (explicit id, then the most
 * specific match, then the built-in), resolved against the record.
 */
export function viewCard(
  backed: ViewBackedRecord,
  templates: ReadonlyArray<ViewTemplate>,
  options: ViewCardOptions,
): ViewCardView {
  const selected = selectViewTemplate(viewMatchSubjectOf(backed), templates);
  const builtin = builtinViewTemplate(backed.kind).definition;
  const definition = selected.definition;
  const record = backed.record as object;
  const context: ViewBindContext = {
    scope: backed.kind,
    record,
    fields: viewFieldsOf(record),
    nowMs: options.nowMs,
    masterRoleId: options.masterRoleId ?? null,
  };

  const allows = viewCardAllows(backed.kind);
  let decoded = decodeViewBody(definition.body, { maxTop: VIEW_HARD_LIMITS.templateBody, allows });
  // A body that decodes to nothing falls back to the built-in body.
  if (decoded.nodes.length === 0 && selected.source !== "builtin") {
    const fallback = decodeViewBody(builtin.body, { allows });
    decoded = { nodes: fallback.nodes, dropped: decoded.dropped };
  }
  const blocks = decoded.nodes.flatMap((node) => {
    const block = viewBlock(node, context, backed, { assets: options.assets ?? [] });
    return block === null ? [] : [block];
  });

  const titleBind = definition.title ?? builtin.title ?? null;
  const title =
    (titleBind === null ? null : viewValueText(resolveViewBind(titleBind, context))) ??
    (builtin.title ? viewValueText(resolveViewBind(builtin.title, context)) : null) ??
    FALLBACK_TITLE[backed.kind];

  return {
    kind: backed.kind,
    templateId: selected.id,
    source: selected.source,
    kicker: definition.kicker === undefined ? (builtin.kicker ?? null) : definition.kicker,
    madeBy: selected.template?.createdBy === "master" ? "master" : null,
    title,
    since: stringOr(recordField(record, "createdAt")),
    approver: approverFor(backed),
    blocks,
    actions: actionsOf(definition, builtin),
    dropped: decoded.dropped,
  };
}
