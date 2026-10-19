import {
  VIEW_HARD_LIMITS,
  type MissionRecordRef,
  type ViewNode,
  type ViewNodeTag,
  type ViewPathScope,
  type ViewSection,
} from "@t3tools/contracts";

import { refLabel } from "../viewModel.ts";
import { resolveViewBind, viewValueText, type ViewBindContext } from "./bindings.ts";
import { viewBlock, type ViewBlock, type ViewListRow } from "./cards.ts";
import { decodeViewBody } from "./decode.ts";

// A custom section is a title and a short body over rows: a query the server
// answers, or a fixed list of refs. Rows for query sections come from the
// caller (the server computes them in a later round); refs sections carry
// their rows.

export interface ViewSectionRow {
  /** `refs` rows read title, kind and status only. */
  readonly scope: ViewPathScope | "refs";
  readonly value: object;
  readonly ref: MissionRecordRef | null;
}

export interface ViewSectionView {
  readonly id: string;
  readonly title: string;
  readonly blocks: ReadonlyArray<ViewBlock>;
  /** Sections with no rows and nothing else to show are hidden. */
  readonly empty: boolean;
  readonly dropped: number;
  readonly madeBy: "master" | null;
}

const SECTION_NODES: ReadonlySet<ViewNodeTag> = new Set([
  "text",
  "label",
  "facts",
  "list",
  "group",
]);

export const viewSectionAllows = (tag: ViewNodeTag): boolean => SECTION_NODES.has(tag);

/** A refs section's rows, straight from its definition. */
export function viewRefRows(section: ViewSection): ReadonlyArray<ViewSectionRow> {
  const source = section.definition.source;
  if (source._tag !== "refs") return [];
  return source.refs.map((ref) => ({
    scope: "refs",
    value: { ...ref, title: refLabel(ref) },
    ref,
  }));
}

const rowKey = (row: ViewSectionRow, index: number): string =>
  row.ref === null ? String(index) : `${row.ref.kind}:${row.ref.id}`;

export interface ViewSectionOptions {
  readonly nowMs: number;
  readonly masterRoleId?: string | null;
  /** Rows for query sections; refs sections fall back to their own refs. */
  readonly rows?: ReadonlyArray<ViewSectionRow>;
  /** Rows the query matched before its limit; defaults to the row count. */
  readonly total?: number;
}

export function viewSection(section: ViewSection, options: ViewSectionOptions): ViewSectionView {
  const rows = options.rows ?? viewRefRows(section);
  const context: ViewBindContext = {
    scope: null,
    record: null,
    section: { count: rows.length, total: options.total ?? rows.length },
    nowMs: options.nowMs,
    masterRoleId: options.masterRoleId ?? null,
  };
  const listRows = (node: Extract<ViewNode, { _tag: "list" }>): ReadonlyArray<ViewListRow> =>
    rows.slice(0, 20).flatMap((row, index) => {
      const rowContext: ViewBindContext = {
        ...context,
        row: { scope: row.scope, value: row.value },
      };
      const title = viewValueText(resolveViewBind(node.title, rowContext));
      if (title === null) return [];
      return [
        {
          key: rowKey(row, index),
          title,
          meta: node.meta.flatMap((bind) => {
            const value = viewValueText(resolveViewBind(bind, rowContext));
            return value === null ? [] : [value];
          }),
          status:
            node.status === null ? null : viewValueText(resolveViewBind(node.status, rowContext)),
          ref: row.ref,
        },
      ];
    });
  const decoded = decodeViewBody(section.definition.body, {
    maxTop: VIEW_HARD_LIMITS.sectionBody,
    allows: viewSectionAllows,
  });
  const blocks = decoded.nodes.flatMap((node) => {
    const block = viewBlock(node, context, null, listRows);
    return block === null ? [] : [block];
  });
  return {
    id: section.id,
    title: section.definition.title,
    blocks,
    empty: rows.length === 0 || blocks.length === 0,
    dropped: decoded.dropped,
    madeBy: section.createdBy === "master" ? "master" : null,
  };
}
