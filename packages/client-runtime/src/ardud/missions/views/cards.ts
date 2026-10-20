import {
  VIEW_ACTIONS,
  VIEW_HARD_LIMITS,
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
  type ViewNode,
  type ViewNodeTag,
  type ViewTableCellKind,
  type ViewTemplate,
  type ViewTemplateDefinition,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  resolveViewBind,
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
    };

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

/** Node kinds a card of this kind renders. Lists and tables belong to sections. */
export const viewCardAllows =
  (kind: ViewBackingKind) =>
  (tag: ViewNodeTag): boolean => {
    if (tag === "list" || tag === "table") return false;
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
