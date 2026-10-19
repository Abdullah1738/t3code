import {
  VIEW_HARD_LIMITS,
  ViewLeafNode,
  type ViewNode,
  type ViewNodeTag,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// View bodies travel as unknown JSON so one bad or newer block never takes a
// card down. Each node decodes alone; what fails is dropped and counted.

const decodeLeaf = Schema.decodeUnknownOption(ViewLeafNode);

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
  if (tagOf(raw) === "group") {
    const group = raw as { readonly direction?: unknown; readonly children?: unknown };
    if (!allows("group") || !GROUP_DIRECTIONS.has(group.direction)) return drop();
    if (!Array.isArray(group.children)) return drop();
    walk.kept += 1;
    const children: Array<ViewNode> = [];
    for (const child of group.children) {
      if (children.length >= GROUP_CHILDREN_MAX) {
        walk.dropped += 1;
        continue;
      }
      const decoded = decodeAt(child, depth + 1, walk, allows);
      if (decoded !== null) children.push(decoded);
    }
    if (children.length === 0) {
      walk.kept -= 1;
      return drop();
    }
    return {
      _tag: "group",
      direction: group.direction === "row" ? "row" : "column",
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
