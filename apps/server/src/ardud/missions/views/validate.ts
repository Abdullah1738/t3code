/**
 * Define-time checks for view definitions. Pure: the service passes in the
 * mission's other templates/sections and stores nothing when any issue comes
 * back. Previews run the same checks.
 */
import {
  VIEW_BIND_ACCEPTS,
  VIEW_DERIVED_PATHS,
  VIEW_FIELD_VALUE_KIND,
  VIEW_HARD_LIMITS,
  VIEW_NODE_TAGS,
  VIEW_PATHS,
  VIEW_QUERY_FILTERS,
  VIEW_QUERY_SORTS,
  VIEW_REF_ROW_PATHS,
  VIEW_SECTION_PATHS,
  VIEW_TABLE_CELL_SLOT,
  ViewNode,
  viewActionAllowed,
  viewMatchesOverlap,
  viewMatchSpecificity,
  type ViewBackingKind,
  type ViewBindSlot,
  type ViewIssue,
  type ViewIssueCode,
  type ViewLayoutDefinition,
  type ViewNodeTag,
  type ViewQueryKind,
  type ViewRegion,
  type ViewSection,
  type ViewSectionDefinition,
  type ViewTemplate,
  type ViewTemplateDefinition,
  type ViewValueKind,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const decodeNode = Schema.decodeUnknownResult(ViewNode, {
  onExcessProperty: "error",
  errors: "all",
});
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const NODE_TAGS: ReadonlySet<string> = new Set(VIEW_NODE_TAGS);

export interface CheckResult {
  readonly issues: ReadonlyArray<ViewIssue>;
  readonly nodes: number;
  readonly bytes: number;
}

class Issues {
  readonly list: Array<ViewIssue> = [];
  add(path: string, code: ViewIssueCode, detail: string) {
    this.list.push({ path, code, detail });
  }
}

export const byteSize = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

type PathTable = Readonly<Record<string, ViewValueKind>>;

/** Resolves a binding to its value kind, or explains why it can't. */
type Binder = (
  bind: string,
  slot: ViewBindSlot,
) => { readonly kind: ViewValueKind } | { readonly code: ViewIssueCode; readonly detail: string };

const lookup = (table: PathTable, path: string): ViewValueKind | undefined =>
  Object.hasOwn(table, path) ? table[path] : undefined;

const splitBind = (bind: string) => {
  const dot = bind.indexOf(".");
  return { scope: bind.slice(0, dot), path: bind.slice(dot + 1) };
};

const checkBind = (
  issues: Issues,
  binder: Binder,
  bind: string,
  slot: ViewBindSlot,
  path: string,
) => {
  const resolved = binder(bind, slot);
  if ("code" in resolved) {
    issues.add(path, resolved.code, resolved.detail);
    return;
  }
  const accepts: ReadonlyArray<ViewValueKind> = VIEW_BIND_ACCEPTS[slot];
  if (!accepts.includes(resolved.kind)) {
    issues.add(
      path,
      "binding-kind",
      `${bind} is ${resolved.kind}; this slot takes ${accepts.join("|")}`,
    );
  }
};

interface NodeRules {
  readonly allowed: (tag: ViewNodeTag) => string | null;
  readonly binder: Binder;
  /** Ask cards collect a verdict per image. */
  readonly reviews?: boolean;
}

interface Walk {
  nodes: number;
}

const walkNode = (
  issues: Issues,
  rules: NodeRules,
  walk: Walk,
  node: ViewNode,
  path: string,
  depth: number,
) => {
  walk.nodes += 1;
  if (depth > VIEW_HARD_LIMITS.depth) {
    issues.add(path, "limit", `nested deeper than ${VIEW_HARD_LIMITS.depth} levels`);
  }
  const refusal = rules.allowed(node._tag);
  if (refusal !== null) issues.add(path, "node-not-allowed", refusal);
  switch (node._tag) {
    case "text":
      checkBind(issues, rules.binder, node.bind, "text", `${path}.bind`);
      return;
    case "facts":
      node.rows.forEach((row, index) =>
        checkBind(issues, rules.binder, row.bind, "fact", `${path}.rows[${index}].bind`),
      );
      return;
    case "flags":
    case "links":
    case "refs":
      checkBind(issues, rules.binder, node.bind, node._tag, `${path}.bind`);
      return;
    case "list":
      checkBind(issues, rules.binder, node.title, "listTitle", `${path}.title`);
      node.meta.forEach((bind, index) =>
        checkBind(issues, rules.binder, bind, "listMeta", `${path}.meta[${index}]`),
      );
      if (node.status !== null) {
        checkBind(issues, rules.binder, node.status, "listStatus", `${path}.status`);
      }
      return;
    case "group":
      node.children.forEach((child, index) =>
        walkNode(issues, rules, walk, child, `${path}.children[${index}]`, depth + 1),
      );
      return;
    case "table":
      node.columns.forEach((column, index) =>
        checkBind(
          issues,
          rules.binder,
          column.bind,
          VIEW_TABLE_CELL_SLOT[column.as],
          `${path}.columns[${index}].bind`,
        ),
      );
      return;
    case "meter":
      checkBind(issues, rules.binder, node.value, "meter", `${path}.value`);
      checkBind(issues, rules.binder, node.max, "meter", `${path}.max`);
      return;
    case "gallery":
      checkBind(issues, rules.binder, node.bind, "gallery", `${path}.bind`);
      if (node.review === "per-asset" && rules.reviews !== true) {
        issues.add(`${path}.review`, "node-not-allowed", "per-asset review needs an ask card");
      }
      return;
    case "collapsible":
      if (node.title === null && node.label === undefined) {
        issues.add(`${path}.title`, "shape", "a collapsible needs a title binding or a label");
      }
      if (node.title !== null) {
        checkBind(issues, rules.binder, node.title, "collapsibleTitle", `${path}.title`);
      }
      node.meta.forEach((bind, index) =>
        checkBind(issues, rules.binder, bind, "collapsibleMeta", `${path}.meta[${index}]`),
      );
      checkBind(issues, rules.binder, node.body, "collapsibleBody", `${path}.body`);
      return;
    case "label":
    case "draft":
    case "choice":
      return;
  }
};

const pathText = (segments: ReadonlyArray<unknown> | undefined): string =>
  (segments ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String((segment as { readonly key: PropertyKey }).key)
        : String(segment),
    )
    .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join("");

const checkBody = (
  issues: Issues,
  rules: NodeRules,
  body: ReadonlyArray<unknown>,
  maxNodes: number,
): number => {
  const walk: Walk = { nodes: 0 };
  if (body.length > maxNodes) {
    issues.add("body", "limit", `at most ${maxNodes} top-level blocks`);
  }
  body.forEach((raw, index) => {
    const path = `body[${index}]`;
    const tag =
      typeof raw === "object" && raw !== null
        ? (raw as { readonly _tag?: unknown })._tag
        : undefined;
    if (typeof tag !== "string" || !NODE_TAGS.has(tag)) {
      issues.add(path, "unknown-node", `not a catalog block (${String(tag)})`);
      return;
    }
    const decoded = decodeNode(raw);
    if (Result.isFailure(decoded)) {
      for (const issue of formatIssue(decoded.failure.issue).issues.slice(0, 4)) {
        issues.add(`${path}${pathText(issue.path)}`, "shape", issue.message);
      }
      return;
    }
    walkNode(issues, rules, walk, decoded.success, path, 1);
  });
  if (walk.nodes > VIEW_HARD_LIMITS.nodesPerDefinition) {
    issues.add("body", "limit", `at most ${VIEW_HARD_LIMITS.nodesPerDefinition} blocks in all`);
  }
  return walk.nodes;
};

const finish = (issues: Issues, nodes: number, value: unknown): CheckResult => {
  const bytes = byteSize(value);
  if (bytes > VIEW_HARD_LIMITS.bytesPerDefinition) {
    issues.add(
      "",
      "limit",
      `definition is ${bytes} bytes; at most ${VIEW_HARD_LIMITS.bytesPerDefinition}`,
    );
  }
  return { issues: issues.list.slice(0, VIEW_HARD_LIMITS.issues), nodes, bytes };
};

// ---------------------------------------------------------------------------
// Templates

/** Match criteria each backing kind can carry. */
const MATCH_KINDS = {
  channel: ["draft"],
  audience: ["draft"],
  approvalKind: ["approval"],
  requestedBy: ["approval", "draft"],
  flag: ["approval", "draft"],
  subMissionId: ["ask", "work-item", "note", "owner-request"],
} as const satisfies Record<string, ReadonlyArray<ViewBackingKind>>;

const templateBinder =
  (definition: ViewTemplateDefinition): Binder =>
  (bind) => {
    const { scope, path } = splitBind(bind);
    if (scope === "record") {
      const kind = lookup(VIEW_PATHS[definition.backing], path) ?? lookup(VIEW_DERIVED_PATHS, path);
      return kind === undefined
        ? { code: "bad-binding", detail: `${definition.backing} cards have no ${path}` }
        : { kind };
    }
    if (scope === "field") {
      const field = (definition.fields ?? []).find((spec) => spec.key === path);
      return field === undefined
        ? { code: "bad-binding", detail: `no template field ${path}` }
        : { kind: VIEW_FIELD_VALUE_KIND[field.type] };
    }
    return { code: "bad-binding", detail: "row bindings belong in sections" };
  };

const templateNodeRule =
  (backing: ViewBackingKind) =>
  (tag: ViewNodeTag): string | null => {
    if (tag === "list" || tag === "table") return `${tag} blocks belong in sections`;
    if (tag === "draft" && backing !== "draft") return "draft blocks need a draft-backed card";
    if (tag === "choice" && backing !== "ask") return "choice blocks need an ask-backed card";
    return null;
  };

export interface TemplateContext {
  /** Every other template of the mission, any status. */
  readonly siblings: ReadonlyArray<ViewTemplate>;
}

export const checkTemplate = (
  definition: ViewTemplateDefinition,
  context: TemplateContext,
): CheckResult => {
  const issues = new Issues();
  const binder = templateBinder(definition);
  if (definition.title !== null && definition.title !== undefined) {
    checkBind(issues, binder, definition.title, "title", "title");
  }

  const fieldKeys = new Set<string>();
  (definition.fields ?? []).forEach((field, index) => {
    const path = `fields[${index}]`;
    if (fieldKeys.has(field.key))
      issues.add(`${path}.key`, "duplicate", `field ${field.key} twice`);
    fieldKeys.add(field.key);
    const hasChoices = field.choices !== undefined && field.choices.length > 0;
    if (field.type === "choice" && !hasChoices) {
      issues.add(`${path}.choices`, "field", "choice fields need choices");
    }
    if (field.type !== "choice" && field.choices !== undefined) {
      issues.add(`${path}.choices`, "field", "only choice fields take choices");
    }
  });

  const nodes = checkBody(
    issues,
    {
      allowed: templateNodeRule(definition.backing),
      binder,
      reviews: definition.backing === "ask",
    },
    definition.body,
    VIEW_HARD_LIMITS.templateBody,
  );

  const actions = new Set<string>();
  definition.actions.forEach((action, index) => {
    if (actions.has(action)) issues.add(`actions[${index}]`, "duplicate", `${action} twice`);
    actions.add(action);
    if (!viewActionAllowed(action, definition.backing)) {
      issues.add(
        `actions[${index}]`,
        "action-not-allowed",
        `${action} on ${definition.backing} cards`,
      );
    }
  });
  if (
    definition.primary !== null &&
    definition.primary !== undefined &&
    !actions.has(definition.primary)
  ) {
    issues.add("primary", "action-not-allowed", `${definition.primary} is not among the actions`);
  }
  const labelled = new Set<string>();
  (definition.actionLabels ?? []).forEach((label, index) => {
    if (labelled.has(label.action)) {
      issues.add(`actionLabels[${index}]`, "duplicate", `${label.action} twice`);
    }
    labelled.add(label.action);
    if (!actions.has(label.action)) {
      issues.add(
        `actionLabels[${index}]`,
        "action-not-allowed",
        `${label.action} is not among the actions`,
      );
    }
  });

  if (context.siblings.some((other) => other.definition.key === definition.key)) {
    issues.add("key", "duplicate", `another template is keyed ${definition.key}`);
  }

  const match = definition.match;
  if (match !== null && match !== undefined) {
    for (const [criterion, kinds] of Object.entries(MATCH_KINDS)) {
      if (
        match[criterion as keyof typeof MATCH_KINDS] !== undefined &&
        !(kinds as ReadonlyArray<string>).includes(definition.backing)
      ) {
        issues.add(
          `match.${criterion}`,
          "match-conflict",
          `${definition.backing} cards have no ${criterion}`,
        );
      }
    }
    const score = viewMatchSpecificity(match);
    for (const other of context.siblings) {
      const otherMatch = other.definition.match;
      if (
        other.status !== "active" ||
        other.definition.backing !== definition.backing ||
        otherMatch === null ||
        otherMatch === undefined
      ) {
        continue;
      }
      if (viewMatchSpecificity(otherMatch) === score && viewMatchesOverlap(match, otherMatch)) {
        issues.add("match", "match-conflict", `same claim as template "${other.definition.name}"`);
      }
    }
  }

  return finish(issues, nodes, definition);
};

// ---------------------------------------------------------------------------
// Sections

const SECTION_NODES: ReadonlySet<ViewNodeTag> = new Set([
  "text",
  "label",
  "facts",
  "list",
  "group",
  "table",
  "meter",
  "collapsible",
]);

/** Slots read per row (list rows, table cells, collapsibles); the rest bind row.count / row.total. */
const ROW_SLOTS: ReadonlySet<ViewBindSlot> = new Set([
  "listTitle",
  "listMeta",
  "listStatus",
  "cellText",
  "cellStatus",
  "cellAge",
  "cellPerson",
  "cellLink",
  "cellCount",
  "collapsibleTitle",
  "collapsibleMeta",
  "collapsibleBody",
]);

const WHERE_KINDS: Readonly<Record<string, ReadonlyArray<ViewQueryKind>>> = VIEW_QUERY_FILTERS;
const SORT_KINDS: Readonly<Record<string, ReadonlyArray<ViewQueryKind>>> = VIEW_QUERY_SORTS;

const sectionBinder =
  (rowPaths: PathTable): Binder =>
  (bind, slot) => {
    const { scope, path } = splitBind(bind);
    if (scope !== "row") return { code: "bad-binding", detail: "sections bind row paths only" };
    const inList = ROW_SLOTS.has(slot);
    const kind = inList
      ? (lookup(rowPaths, path) ?? lookup(VIEW_DERIVED_PATHS, path))
      : lookup(VIEW_SECTION_PATHS, path);
    if (kind !== undefined) return { kind };
    return {
      code: "bad-binding",
      detail: inList ? `rows have no ${path}` : `outside a list only row.count and row.total bind`,
    };
  };

export interface SectionContext {
  /** Every other section of the mission, any status. */
  readonly siblings: ReadonlyArray<ViewSection>;
}

export const checkSection = (
  definition: ViewSectionDefinition,
  context: SectionContext,
): CheckResult => {
  const issues = new Issues();
  const source = definition.source;
  let rowPaths: PathTable = VIEW_REF_ROW_PATHS;
  if (source._tag === "query") {
    const query = source.query;
    rowPaths = VIEW_PATHS[query.kind];
    for (const [filter, kinds] of Object.entries(WHERE_KINDS)) {
      if (
        query.where?.[filter as keyof typeof VIEW_QUERY_FILTERS] !== undefined &&
        !kinds.includes(query.kind)
      ) {
        issues.add(`source.query.where.${filter}`, "field", `${query.kind} rows have no ${filter}`);
      }
    }
    const sortKinds = SORT_KINDS[query.sort];
    if (sortKinds !== undefined && !sortKinds.includes(query.kind)) {
      issues.add("source.query.sort", "field", `${query.sort} does not sort ${query.kind} rows`);
    }
  }
  const nodes = checkBody(
    issues,
    {
      allowed: (tag) => (SECTION_NODES.has(tag) ? null : `${tag} blocks belong on cards`),
      binder: sectionBinder(rowPaths),
    },
    definition.body,
    VIEW_HARD_LIMITS.sectionBody,
  );
  if (context.siblings.some((other) => other.definition.key === definition.key)) {
    issues.add("key", "duplicate", `another section is keyed ${definition.key}`);
  }
  return finish(issues, nodes, definition);
};

// ---------------------------------------------------------------------------
// Layouts

const BUILTIN_REGIONS: ReadonlySet<ViewRegion> = new Set(["header", "main", "rail", "sub-mission"]);
const CUSTOM_REGIONS: ReadonlySet<ViewRegion> = new Set(["main", "rail", "sub-mission"]);

export interface LayoutContext {
  /**
   * Ids of the mission's sections (any status) a custom entry may name.
   * Null for the starter layout, which holds built-ins and tabs only.
   */
  readonly sectionIds: ReadonlySet<string> | null;
}

export const checkLayout = (
  layout: ViewLayoutDefinition,
  context: LayoutContext,
): Array<ViewIssue> => {
  const issues = new Issues();
  if (layout.entries.length > VIEW_HARD_LIMITS.layoutEntries) {
    issues.add(
      "entries",
      "limit",
      `a layout holds at most ${VIEW_HARD_LIMITS.layoutEntries} entries (removed sections still count)`,
    );
  }
  const keys = new Set<string>();
  const targets = new Set<string>();
  layout.entries.forEach((entry, index) => {
    const path = `entries[${index}]`;
    if (keys.has(entry.key))
      issues.add(`${path}.key`, "duplicate", `layout key ${entry.key} twice`);
    keys.add(entry.key);
    const section = entry.section;
    const target =
      section._tag === "builtin"
        ? `builtin:${section.kind}`
        : section._tag === "tab"
          ? `tab:${section.tab}`
          : `custom:${section.sectionId}`;
    if (targets.has(target)) issues.add(`${path}.section`, "duplicate", `${target} placed twice`);
    targets.add(target);
    switch (section._tag) {
      case "tab":
        if (entry.region !== "tabs")
          issues.add(`${path}.region`, "shape", "tabs sit in the tabs region");
        break;
      case "builtin":
        if (!BUILTIN_REGIONS.has(entry.region)) {
          issues.add(
            `${path}.region`,
            "shape",
            "page sections sit in header, main, rail or sub-mission",
          );
        }
        break;
      case "custom":
        if (context.sectionIds === null) {
          issues.add(
            `${path}.section`,
            "shape",
            "the starter layout holds built-in sections and tabs only",
          );
        } else if (!context.sectionIds.has(section.sectionId)) {
          issues.add(`${path}.section`, "shape", `no section ${section.sectionId} in this mission`);
        }
        if (!CUSTOM_REGIONS.has(entry.region)) {
          issues.add(`${path}.region`, "shape", "custom sections sit in main, rail or sub-mission");
        }
        break;
    }
  });
  return issues.list.slice(0, VIEW_HARD_LIMITS.issues);
};
