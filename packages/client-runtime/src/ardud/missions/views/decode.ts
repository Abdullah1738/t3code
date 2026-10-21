import {
  VIEW_HARD_LIMITS,
  ViewCollapsibleHead,
  ViewLeafNode,
  type ViewNode,
  type ViewNodeTag,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// View bodies travel as unknown JSON so one bad or newer block never takes a
// card down. Each node decodes alone; what fails is dropped and counted.

const decodeLeaf = Schema.decodeUnknownOption(ViewLeafNode);
const decodeCollapsibleHead = Schema.decodeUnknownOption(ViewCollapsibleHead);

const GROUP_DIRECTIONS: ReadonlySet<unknown> = new Set(["column", "row"]);
const GROUP_CHILDREN_MAX = 6;

export interface DecodedViewBody {
  readonly nodes: ReadonlyArray<ViewNode>;
  /** Nodes dropped: unknown, malformed, not allowed here, too deep or over the limits. */
  readonly dropped: number;
}

export interface DecodeViewBodyOptions {
  /** Top-level blocks kept; templates take 8, sections 6. */
  readonly maxTop?: number;
  /** Refuses a node kind in this place, e.g. `choice` outside ask cards. */
  readonly allows?: (tag: ViewNodeTag) => boolean;
}

interface Walk {
  kept: number;
  dropped: number;
}

const tagOf = (raw: unknown): unknown =>
  typeof raw === "object" && raw !== null ? (raw as { readonly _tag?: unknown })._tag : undefined;

/** Lists, tables and nested collapsibles iterate rows; a collapsible is already one row. */
const FOLDED_OUT: ReadonlySet<ViewNodeTag> = new Set([
  "list",
  "table",
  "collapsible",
  // --- blocks additions ---
  "chart",
  "timeline",
  // --- end blocks additions ---
]);

const decodeAt = (
  raw: unknown,
  depth: number,
  walk: Walk,
  allows: (tag: ViewNodeTag) => boolean,
): ViewNode | null => {
  const drop = () => {
    walk.dropped += 1;
    return null;
  };
  if (depth > VIEW_HARD_LIMITS.depth || walk.kept >= VIEW_HARD_LIMITS.nodesPerDefinition) {
    return drop();
  }
  const tag = tagOf(raw);
  if (tag === "group" || tag === "collapsible") {
    const container = raw as { readonly direction?: unknown; readonly children?: unknown };
    const head = tag === "collapsible" ? decodeCollapsibleHead(raw) : Option.none();
    if (!allows(tag) || !Array.isArray(container.children)) return drop();
    if (tag === "group" ? !GROUP_DIRECTIONS.has(container.direction) : Option.isNone(head)) {
      return drop();
    }
    walk.kept += 1;
    const inner =
      tag === "collapsible"
        ? (child: ViewNodeTag) => allows(child) && !FOLDED_OUT.has(child)
        : allows;
    const children: Array<ViewNode> = [];
    for (const child of container.children) {
      if (children.length >= GROUP_CHILDREN_MAX) {
        walk.dropped += 1;
        continue;
      }
      const decoded = decodeAt(child, depth + 1, walk, inner);
      if (decoded !== null) children.push(decoded);
    }
    if (children.length === 0) {
      walk.kept -= 1;
      return drop();
    }
    if (Option.isSome(head)) return { _tag: "collapsible", ...head.value, children };
    return {
      _tag: "group",
      direction: container.direction === "row" ? "row" : "column",
      children,
    };
  }
  const leaf = decodeLeaf(raw);
  if (Option.isNone(leaf) || !allows(leaf.value._tag)) return drop();
  walk.kept += 1;
  return leaf.value;
};

/** Decodes a wire body node by node, keeping what is valid in this place. */
export function decodeViewBody(
  body: ReadonlyArray<unknown>,
  options: DecodeViewBodyOptions = {},
): DecodedViewBody {
  const maxTop = options.maxTop ?? VIEW_HARD_LIMITS.templateBody;
  const allows = options.allows ?? (() => true);
  const walk: Walk = { kept: 0, dropped: 0 };
  const nodes: Array<ViewNode> = [];
  for (const raw of body) {
    if (nodes.length >= maxTop) {
      walk.dropped += 1;
      continue;
    }
    const node = decodeAt(raw, 1, walk, allows);
    if (node !== null) nodes.push(node);
  }
  return { nodes, dropped: walk.dropped };
}
