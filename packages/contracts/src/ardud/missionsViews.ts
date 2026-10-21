/**
 * Generative mission views, catalog version 1.
 *
 * The owner and the master compose card templates and sections from a fixed
 * catalog of blocks. Facts come only from records; templates and sections
 * hold static labels and bindings, never free text or URLs.
 *
 * Every mission keeps its own layout record: the ordered list of every page
 * section and tab (built in or custom), with region, hidden flag and title.
 * New missions copy the starter layout, a stored and versioned record the
 * owner and any master can edit at any time without a restart. Nothing here
 * is fixed: built-ins are only the recommended defaults.
 *
 * Bodies travel as `unknown[]`. The server validates every node strictly when
 * a definition is written; clients decode node by node so one bad node never
 * blanks a card.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import {
  Approval,
  type Ask,
  type Draft,
  DraftChannel,
  type Knock,
  LaneId,
  MissionActor,
  MissionAssetId,
  MissionId,
  MissionRecordRef,
  MissionSummaryText,
  type Note,
  NoteType,
  RecordView,
  SubMissionId,
  type Suggestion,
  ViewFields,
  ViewFieldValue,
  ViewKey,
  ViewKicker,
  ViewTemplateId,
  WorkItem,
  WorkStage,
} from "./missions.ts";

export const VIEW_CATALOG_VERSION = 1;

// ---------------------------------------------------------------------------
// Ids and scalars

const viewEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

// Record view schemas live in missions.ts (records carry them); re-exported here.
export { RecordView, ViewFields, ViewFieldValue, ViewKey, ViewKicker, ViewTemplateId };
export const ViewSectionId = viewEntityId("ViewSectionId");
export type ViewSectionId = typeof ViewSectionId.Type;

/** Built-in template ids are `builtin:<kind>`. Stored templates never use the prefix. */
export const BUILTIN_VIEW_TEMPLATE_PREFIX = "builtin:";

export const ViewLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
/** `record.<path>`, `field.<template field key>` or `row.<path>` (section lists). */
export const ViewBind = Schema.String.check(
  Schema.isPattern(/^(record|field|row)\.[a-zA-Z][a-zA-Z0-9-]{0,39}$/),
);
export type ViewBind = typeof ViewBind.Type;

export const ViewBackingKind = Schema.Literals([
  "ask",
  "approval",
  "draft",
  "work-item",
  "note",
  "knock",
  "suggestion",
  // Router's owner request record (kind `owner-request`), named by string so
  // views do not depend on the router contract block.
  "owner-request",
]);
export type ViewBackingKind = typeof ViewBackingKind.Type;

export const ViewApprovalKind = Approval.fields.kind;
export type ViewApprovalKind = typeof ViewApprovalKind.Type;
export const ViewWorkKind = WorkItem.fields.kind;
export type ViewWorkKind = typeof ViewWorkKind.Type;

// ---------------------------------------------------------------------------
// Actions: the fixed list a card frame can show, filtered by backing kind.

export const ViewActionKey = Schema.Literals([
  "answer",
  "approve",
  "reject",
  "send",
  "rewrite",
  "drop",
  "forward",
  "dismiss",
  "accept",
  "dismiss-suggestion",
  "ack",
  "comment",
  "discuss",
  "open",
  "reply",
  "settle",
  "reopen",
]);
export type ViewActionKey = typeof ViewActionKey.Type;

export interface ViewActionSpec {
  readonly label: string;
  readonly kinds: ReadonlyArray<ViewBackingKind>;
  /** Owner WS method behind the action; `null` for client navigation. */
  readonly owner: string | null;
  /** Master MCP tool behind the action; `null` for client navigation. */
  readonly master: string | null;
}

const ALL_KINDS = ViewBackingKind.literals;

export const VIEW_ACTIONS: { readonly [K in ViewActionKey]: ViewActionSpec } = {
  answer: {
    label: "Answer",
    kinds: ["ask"],
    owner: "missions.answerAsk",
    master: "mission_ask_answer",
  },
  approve: {
    label: "Approve",
    kinds: ["approval"],
    owner: "missions.decideApproval",
    master: "mission_approval_decide",
  },
  reject: {
    label: "Reject",
    kinds: ["approval"],
    owner: "missions.decideApproval",
    master: "mission_approval_decide",
  },
  send: {
    label: "Approve",
    kinds: ["draft"],
    owner: "missions.decideDraft",
    master: "mission_draft_approve",
  },
  rewrite: {
    label: "Rewrite",
    kinds: ["draft"],
    owner: "missions.decideDraft",
    master: "mission_draft_approve",
  },
  drop: {
    label: "Drop",
    kinds: ["draft"],
    owner: "missions.decideDraft",
    master: "mission_draft_approve",
  },
  forward: {
    label: "Forward",
    kinds: ["knock"],
    owner: "missions.decideKnock",
    master: "mission_knock_decide",
  },
  dismiss: {
    label: "Drop",
    kinds: ["knock"],
    owner: "missions.decideKnock",
    master: "mission_knock_decide",
  },
  accept: {
    label: "Accept",
    kinds: ["suggestion"],
    owner: "missions.decideSuggestion",
    master: "mission_suggestion_decide",
  },
  "dismiss-suggestion": {
    label: "Dismiss",
    kinds: ["suggestion"],
    owner: "missions.decideSuggestion",
    master: "mission_suggestion_decide",
  },
  ack: { label: "Got it", kinds: ["note"], owner: "missions.ackNote", master: "mission_note_ack" },
  comment: {
    label: "Comment",
    kinds: ["ask", "approval", "draft", "work-item", "note"],
    owner: "missions.postMessage",
    master: "mission_post",
  },
  // --- router additions ---
  // Discuss is a conversation with the master, never a fork: it opens (or adds
  // to) the owner request whose `subject` is the card's record.
  discuss: {
    label: "Discuss",
    // A request is never about a request.
    kinds: ALL_KINDS.filter((kind) => kind !== "owner-request"),
    owner: "missions.openOwnerRequest",
    master: null,
  },
  open: { label: "Open", kinds: ALL_KINDS, owner: null, master: null },
  // Owner requests: the WS methods and MCP tools router serves.
  reply: {
    label: "Reply",
    kinds: ["owner-request"],
    owner: "missions.replyOwnerRequest",
    master: "mission_request_reply",
  },
  settle: {
    label: "Settle",
    kinds: ["owner-request"],
    owner: "missions.settleOwnerRequest",
    master: "mission_request_settle",
  },
  reopen: {
    label: "Reopen",
    kinds: ["owner-request"],
    owner: "missions.reopenOwnerRequest",
    master: "mission_request_reopen",
  },
  // --- end router additions ---
};

export const viewActionAllowed = (action: ViewActionKey, kind: ViewBackingKind): boolean =>
  VIEW_ACTIONS[action].kinds.includes(kind);

// ---------------------------------------------------------------------------
// Nodes

export const ViewTextStyle = Schema.Literals(["body", "meta"]);
export const ViewTextNode = Schema.TaggedStruct("text", {
  bind: ViewBind,
  style: ViewTextStyle,
  maxLines: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
});
export const ViewLabelNode = Schema.TaggedStruct("label", { text: ViewLabel });
export const ViewFactRow = Schema.Struct({ label: ViewKicker, bind: ViewBind });
export const ViewFactsNode = Schema.TaggedStruct("facts", {
  rows: Schema.Array(ViewFactRow).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export const ViewFlagsNode = Schema.TaggedStruct("flags", { bind: ViewBind });
export const ViewLinksNode = Schema.TaggedStruct("links", { bind: ViewBind });
export const ViewRefsNode = Schema.TaggedStruct("refs", { bind: ViewBind });
/** Draft text, editable in place, with a diff against the previous revision. Draft-backed only. */
export const ViewDraftNode = Schema.TaggedStruct("draft", {
  editable: Schema.Boolean,
  diff: Schema.Boolean,
});
/** The ask's options with the recommendation. Ask-backed only. */
export const ViewChoiceNode = Schema.TaggedStruct("choice", {});
/** One line per section row. Sections only. */
export const ViewListNode = Schema.TaggedStruct("list", {
  title: ViewBind,
  meta: Schema.Array(ViewBind).check(Schema.isMaxLength(3)),
  status: Schema.NullOr(ViewBind),
});
// --- views additions ---
/** How a table cell draws its value. */
export const ViewTableCellKind = Schema.Literals([
  "text",
  "status",
  "age",
  "person",
  "link",
  "count",
]);
export type ViewTableCellKind = typeof ViewTableCellKind.Type;
export const ViewTableColumn = Schema.Struct({
  label: ViewKicker,
  bind: ViewBind,
  as: ViewTableCellKind,
});
/** One row per section row, up to five columns. Sections only; phones stack each row. */
export const ViewTableNode = Schema.TaggedStruct("table", {
  columns: Schema.Array(ViewTableColumn).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
/** A bar of value out of max, both numbers. */
export const ViewMeterNode = Schema.TaggedStruct("meter", { value: ViewBind, max: ViewBind });
/** Images from an `assets` field; `per-asset` lets the owner mark each one (ask cards). */
export const ViewGalleryNode = Schema.TaggedStruct("gallery", {
  bind: ViewBind,
  review: Schema.Literals(["none", "per-asset"]),
});
/** Markdown text. A `longtext` value only binds inside a collapsible, which loads it on open. */
export const ViewMarkdownNode = Schema.TaggedStruct("markdown", {
  bind: ViewBind,
  maxLines: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 }))),
});
/** A collapsible's header; its children decode on their own like a group's. */
export const ViewCollapsibleHead = Schema.Struct({
  /** Null shows `label`. */
  title: Schema.NullOr(ViewBind),
  label: Schema.optionalKey(ViewKicker),
  meta: Schema.Array(ViewBind).check(Schema.isMaxLength(3)),
  /** `first` opens the first item on load. */
  open: Schema.Literals(["none", "first"]),
});
export type ViewCollapsibleHead = typeof ViewCollapsibleHead.Type;
// --- end views additions ---

export const ViewLeafNode = Schema.Union([
  ViewTextNode,
  ViewLabelNode,
  ViewFactsNode,
  ViewFlagsNode,
  ViewLinksNode,
  ViewRefsNode,
  ViewDraftNode,
  ViewChoiceNode,
  ViewListNode,
  // --- views additions ---
  ViewTableNode,
  ViewMeterNode,
  ViewGalleryNode,
  ViewMarkdownNode,
  // --- end views additions ---
]);
export type ViewLeafNode = typeof ViewLeafNode.Type;

/** The only container. No border; children stack in a column or a row. */
export interface ViewGroupNode {
  readonly _tag: "group";
  readonly direction: "column" | "row";
  readonly children: ReadonlyArray<ViewNode>;
}
// --- views additions ---
/**
 * A header that opens to show its children. In a section there is one per
 * row and the children bind that row; a `longtext` value inside never rides
 * in the snapshot, the client loads it on open.
 */
export interface ViewCollapsibleNode extends ViewCollapsibleHead {
  readonly _tag: "collapsible";
  readonly children: ReadonlyArray<ViewNode>;
}
// --- end views additions ---
export type ViewNode =
  | ViewLeafNode
  | ViewGroupNode
  // --- views additions ---
  | ViewCollapsibleNode;
// --- end views additions ---
export type ViewNodeTag = ViewNode["_tag"];

const ViewChildren = Schema.Array(Schema.suspend((): Schema.Codec<ViewNode> => ViewNode)).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(6),
);
export const ViewGroupNode: Schema.Codec<ViewGroupNode> = Schema.Struct({
  _tag: Schema.tag("group"),
  direction: Schema.Literals(["column", "row"]),
  children: ViewChildren,
});
// --- views additions ---
export const ViewCollapsibleNode: Schema.Codec<ViewCollapsibleNode> = Schema.Struct({
  _tag: Schema.tag("collapsible"),
  ...ViewCollapsibleHead.fields,
  children: ViewChildren,
});
// --- end views additions ---
export const ViewNode: Schema.Codec<ViewNode> = Schema.Union([
  ViewLeafNode,
  ViewGroupNode,
  // --- views additions ---
  ViewCollapsibleNode,
  // --- end views additions ---
]);

export const VIEW_NODE_TAGS: ReadonlyArray<ViewNodeTag> = [
  "text",
  "label",
  "facts",
  "flags",
  "links",
  "refs",
  "draft",
  "choice",
  "list",
  "group",
  // --- views additions ---
  "table",
  "meter",
  "gallery",
  "collapsible",
  "markdown",
  // --- end views additions ---
];

/** Bodies on the wire: decode each node alone and drop what fails. */
export const ViewBodyWire = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(8));

// ---------------------------------------------------------------------------
// Template fields (values live on the record's `view.fields`)

export const ViewFieldType = Schema.Literals([
  "short",
  "text",
  "number",
  "choice",
  "flags",
  "links",
  "refs",
  // --- views additions ---
  "assets",
  // --- end views additions ---
]);
export type ViewFieldType = typeof ViewFieldType.Type;
export const ViewFieldSpec = Schema.Struct({
  key: ViewKey,
  label: ViewKicker,
  type: ViewFieldType,
  required: Schema.Boolean,
  editable: Schema.Boolean,
  choices: Schema.optionalKey(Schema.Array(ViewKicker).check(Schema.isMaxLength(8))),
});
export type ViewFieldSpec = typeof ViewFieldSpec.Type;

// ---------------------------------------------------------------------------
// Card templates

/**
 * Which records a template claims without naming it. Every criterion set
 * must fit; the template with the most criteria wins. Two active templates
 * of one kind that could both fit with the same count are refused.
 */
export const ViewMatch = Schema.Struct({
  channel: Schema.optionalKey(
    Schema.Array(DraftChannel).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  approvalKind: Schema.optionalKey(
    Schema.Array(ViewApprovalKind).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  ),
  requestedBy: Schema.optionalKey(
    Schema.Array(ViewKey).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  flag: Schema.optionalKey(ViewKicker),
  audience: Schema.optionalKey(ViewLabel),
  subMissionId: Schema.optionalKey(SubMissionId),
});
export type ViewMatch = typeof ViewMatch.Type;

export const ViewActionLabel = Schema.Struct({ action: ViewActionKey, label: ViewKicker });

export const ViewTemplateDefinition = Schema.Struct({
  key: ViewKey,
  name: ViewLabel,
  backing: ViewBackingKind,
  /** Static, at most 24 characters. Absent: the built-in kicker for the kind. */
  kicker: Schema.optionalKey(Schema.NullOr(ViewKicker)),
  /** Absent: the built-in title binding for the kind. */
  title: Schema.optionalKey(Schema.NullOr(ViewBind)),
  fields: Schema.optionalKey(Schema.Array(ViewFieldSpec).check(Schema.isMaxLength(12))),
  body: ViewBodyWire,
  /** Subset of the actions allowed for the kind, in display order. */
  actions: Schema.Array(ViewActionKey).check(Schema.isMaxLength(6)),
  primary: Schema.optionalKey(Schema.NullOr(ViewActionKey)),
  /** Short label overrides; the action, icon and colour stay fixed. */
  actionLabels: Schema.optionalKey(Schema.Array(ViewActionLabel).check(Schema.isMaxLength(6))),
  match: Schema.optionalKey(Schema.NullOr(ViewMatch)),
});
export type ViewTemplateDefinition = typeof ViewTemplateDefinition.Type;

export const ViewStatus = Schema.Literals(["active", "removed"]);
export type ViewStatus = typeof ViewStatus.Type;
/** Who made a change, for the quiet by-you / by-master marker. */
export const ViewAuthor = Schema.Literals(["owner", "master", "agent", "system"]);
export type ViewAuthor = typeof ViewAuthor.Type;

export const ViewChangeMeta = Schema.Struct({
  version: PositiveInt,
  changedBy: MissionActor,
  by: ViewAuthor,
  changedAt: IsoDateTime,
  changeNote: Schema.NullOr(MissionSummaryText),
});
export type ViewChangeMeta = typeof ViewChangeMeta.Type;

export const ViewMeta = Schema.Struct({
  ...ViewChangeMeta.fields,
  catalogVersion: PositiveInt,
  status: ViewStatus,
  createdAt: IsoDateTime,
  /** The by-master hexagon shows only when this is `master`. */
  createdBy: ViewAuthor,
});

export const ViewTemplate = Schema.Struct({
  id: ViewTemplateId,
  missionId: MissionId,
  definition: ViewTemplateDefinition,
  ...ViewMeta.fields,
});
export type ViewTemplate = typeof ViewTemplate.Type;

// ---------------------------------------------------------------------------
// Sections

export const ViewQueryKind = Schema.Literals([
  "work-item",
  "note",
  "approval",
  "draft",
  "ask",
  "milestone",
  "sub-mission",
  "call",
  // --- views additions ---
  /** The scribe's saved reports, newest first. */
  "report",
  // --- end views additions ---
]);
export type ViewQueryKind = typeof ViewQueryKind.Type;

export const ViewQueryWhere = Schema.Struct({
  subMissionId: Schema.optionalKey(SubMissionId),
  laneId: Schema.optionalKey(LaneId),
  status: Schema.optionalKey(
    Schema.Array(ViewKey).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  ),
  stage: Schema.optionalKey(Schema.Array(WorkStage).check(Schema.isMinLength(1))),
  workKind: Schema.optionalKey(Schema.Array(ViewWorkKind).check(Schema.isMinLength(1))),
  noteType: Schema.optionalKey(Schema.Array(NoteType).check(Schema.isMinLength(1))),
  approvalKind: Schema.optionalKey(Schema.Array(ViewApprovalKind).check(Schema.isMinLength(1))),
  channel: Schema.optionalKey(Schema.Array(DraftChannel).check(Schema.isMinLength(1))),
  flag: Schema.optionalKey(ViewKicker),
  requestedBy: Schema.optionalKey(ViewKey),
  // --- views additions ---
  reportKind: Schema.optionalKey(
    Schema.Array(Schema.Literals(["daily", "update"])).check(Schema.isMinLength(1)),
  ),
  // --- end views additions ---
});
export const ViewQuerySort = Schema.Literals(["updated-desc", "created-desc", "rank", "due"]);
export const ViewQuery = Schema.Struct({
  kind: ViewQueryKind,
  where: Schema.optionalKey(ViewQueryWhere),
  sort: ViewQuerySort,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});
export type ViewQuery = typeof ViewQuery.Type;

// --- sources additions ---
/** A script on the host that feeds rows to sections. */
export const ViewDataSourceId = viewEntityId("ViewDataSourceId");
export type ViewDataSourceId = typeof ViewDataSourceId.Type;

export const ViewSourceRuntime = Schema.Literals(["bash", "node", "python3"]);
export type ViewSourceRuntime = typeof ViewSourceRuntime.Type;

/** What a declared row field holds. `actor` is a plain name; links are https only. */
export const ViewSourceFieldKind = Schema.Literals([
  "text",
  "enum",
  "number",
  "time",
  "link",
  "links",
  "actor",
  "longtext",
]);
export type ViewSourceFieldKind = typeof ViewSourceFieldKind.Type;

export const ViewSourceFieldName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/),
);

export const VIEW_SOURCE_LIMITS = {
  sourcesPerMission: 12,
  codeChars: 20_000,
  fields: 16,
  rows: 500,
  outputBytes: 2_000_000,
  textChars: 2_000,
  longTextChars: 20_000,
  links: 10,
  maxTimeoutSeconds: 60,
  minRefreshMinutes: 5,
  maxRefreshMinutes: 1440,
  concurrentRuns: 2,
  whereFields: 4,
} as const;

/** Every row carries an implicit text `id`, so `id` is not declared here. */
export const ViewSourceFields = Schema.Record(ViewSourceFieldName, ViewSourceFieldKind).check(
  Schema.isMinProperties(1),
  Schema.isMaxProperties(VIEW_SOURCE_LIMITS.fields),
);
export type ViewSourceFields = typeof ViewSourceFields.Type;

export const ViewSourceCode = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(VIEW_SOURCE_LIMITS.codeChars),
);
export const ViewSourceRefreshMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: VIEW_SOURCE_LIMITS.minRefreshMinutes,
    maximum: VIEW_SOURCE_LIMITS.maxRefreshMinutes,
  }),
);
export const ViewSourceTimeoutSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: VIEW_SOURCE_LIMITS.maxTimeoutSeconds }),
);

export const ViewSourceDefinition = Schema.Struct({
  title: ViewLabel,
  runtime: ViewSourceRuntime,
  code: ViewSourceCode,
  fields: ViewSourceFields,
  refreshMinutes: ViewSourceRefreshMinutes,
  timeoutSeconds: ViewSourceTimeoutSeconds,
  enabled: Schema.Boolean,
});
export type ViewSourceDefinition = typeof ViewSourceDefinition.Type;

export const ViewDataSource = Schema.Struct({
  id: ViewDataSourceId,
  missionId: MissionId,
  definition: ViewSourceDefinition,
  ...ViewMeta.fields,
});
export type ViewDataSource = typeof ViewDataSource.Type;

/** A source without its code, for snapshots; the code reads through history. */
export const ViewSourceListing = Schema.Struct({
  id: ViewDataSourceId,
  missionId: MissionId,
  title: ViewLabel,
  runtime: ViewSourceRuntime,
  fields: ViewSourceFields,
  refreshMinutes: ViewSourceRefreshMinutes,
  timeoutSeconds: ViewSourceTimeoutSeconds,
  enabled: Schema.Boolean,
  ...ViewMeta.fields,
});
export type ViewSourceListing = typeof ViewSourceListing.Type;

/** The cached state of one source: the last good rows stay when a later run fails. */
export const ViewSourceRun = Schema.Struct({
  sourceId: ViewDataSourceId,
  /** When the cached rows were produced; null before the first good run. */
  okAt: Schema.NullOr(IsoDateTime),
  rows: NonNegativeInt,
  ranAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(NonNegativeInt),
  /** The latest run's first stderr line or output problem, when it failed. */
  error: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
});
export type ViewSourceRun = typeof ViewSourceRun.Type;

/** Equals on scalar fields; a list matches any of its values. */
export const ViewSourceWhereValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
]);
export const ViewSourceSort = Schema.Struct({
  field: ViewSourceFieldName,
  dir: Schema.Literals(["asc", "desc"]),
});
// --- end sources additions ---

export const ViewSource = Schema.Union([
  Schema.TaggedStruct("query", { query: ViewQuery }),
  Schema.TaggedStruct("refs", {
    refs: Schema.Array(MissionRecordRef).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  // --- sources additions ---
  Schema.TaggedStruct("source", {
    sourceId: ViewDataSourceId,
    where: Schema.optionalKey(
      Schema.Record(ViewSourceFieldName, ViewSourceWhereValue).check(
        Schema.isMaxProperties(VIEW_SOURCE_LIMITS.whereFields),
      ),
    ),
    sort: Schema.optionalKey(ViewSourceSort),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  }),
  // --- end sources additions ---
]);
export type ViewSource = typeof ViewSource.Type;

// --- views additions ---
/** Query filters each record kind can take. */
export const VIEW_QUERY_FILTERS = {
  subMissionId: ["work-item", "note", "approval", "draft", "ask", "milestone", "call"],
  laneId: ["work-item", "note"],
  status: ["approval", "draft", "ask", "milestone", "sub-mission"],
  stage: ["work-item"],
  workKind: ["work-item"],
  noteType: ["note"],
  approvalKind: ["approval"],
  channel: ["draft"],
  flag: ["approval", "draft"],
  requestedBy: ["approval", "draft"],
  reportKind: ["report"],
} as const satisfies Record<keyof typeof ViewQueryWhere.Type, ReadonlyArray<ViewQueryKind>>;

/** Sorts that only some kinds take; the rest sort every kind. Reports read newest first either way. */
export const VIEW_QUERY_SORTS = {
  rank: ["sub-mission"],
  due: ["milestone"],
} as const satisfies Partial<Record<typeof ViewQuerySort.Type, ReadonlyArray<ViewQueryKind>>>;
// --- end views additions ---

/** Where a section shows lives in the layout record, not here. */
export const ViewSectionDefinition = Schema.Struct({
  key: ViewKey,
  title: ViewLabel,
  subMissionId: Schema.optionalKey(Schema.NullOr(SubMissionId)),
  source: ViewSource,
  /** At most 6 nodes; `row.<path>` bindings live inside `list` nodes. */
  body: ViewBodyWire,
});
export type ViewSectionDefinition = typeof ViewSectionDefinition.Type;

export const ViewSection = Schema.Struct({
  id: ViewSectionId,
  missionId: MissionId,
  definition: ViewSectionDefinition,
  ...ViewMeta.fields,
});
export type ViewSection = typeof ViewSection.Type;

// ---------------------------------------------------------------------------
// Layout: every page section and tab is an entry. Order is array order.

export const ViewRegion = Schema.Literals(["header", "main", "rail", "tabs", "sub-mission"]);
export type ViewRegion = typeof ViewRegion.Type;

export const ViewBuiltinSectionKind = Schema.Literals([
  "header-stats",
  "needs-you",
  "path-to-milestone",
  "with-the-master",
  "sub-missions",
  "since-last-looked",
  "your-requests",
]);
export type ViewBuiltinSectionKind = typeof ViewBuiltinSectionKind.Type;

export const ViewTabKind = Schema.Literals([
  "overview",
  "board",
  "changes",
  "calls",
  "rooms",
  "lanes",
  "work",
  "rules",
  "roles",
  "timeline",
  "views",
]);
export type ViewTabKind = typeof ViewTabKind.Type;

export const ViewLayoutSection = Schema.Union([
  Schema.TaggedStruct("builtin", { kind: ViewBuiltinSectionKind }),
  Schema.TaggedStruct("tab", { tab: ViewTabKind }),
  Schema.TaggedStruct("custom", { sectionId: ViewSectionId }),
]);
export type ViewLayoutSection = typeof ViewLayoutSection.Type;

export const ViewLayoutEntry = Schema.Struct({
  key: ViewKey,
  section: ViewLayoutSection,
  region: ViewRegion,
  hidden: Schema.Boolean,
  /** Owner or master rename; `null` keeps the section's own title. */
  title: Schema.NullOr(ViewLabel),
});
export type ViewLayoutEntry = typeof ViewLayoutEntry.Type;

/** Hard catalog limits. Not adjustable. */
export const VIEW_HARD_LIMITS = {
  nodesPerDefinition: 40,
  depth: 3,
  bytesPerDefinition: 16 * 1024,
  bytesPerMission: 128 * 1024,
  templateBody: 8,
  sectionBody: 6,
  fieldsPerTemplate: 12,
  layoutEntries: 48,
  issues: 20,
  // --- views additions ---
  /** A `longtext` value loads at most this many characters. */
  longTextChars: 400_000,
  // --- end views additions ---
} as const;

/** Sane upper bounds for the adjustable limits below. */
export const VIEW_LIMIT_CEILINGS = { templates: 48, sections: 24, changesPerDay: 200 } as const;

/** Adjustable limits. Recommended defaults live on the starter layout. */
export const ViewLimits = Schema.Struct({
  templates: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: VIEW_LIMIT_CEILINGS.templates }),
  ),
  sections: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: VIEW_LIMIT_CEILINGS.sections }),
  ),
  changesPerDay: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: VIEW_LIMIT_CEILINGS.changesPerDay }),
  ),
});
export type ViewLimits = typeof ViewLimits.Type;

export const ViewLayoutDefinition = Schema.Struct({
  entries: Schema.Array(ViewLayoutEntry).check(Schema.isMaxLength(VIEW_HARD_LIMITS.layoutEntries)),
  limits: ViewLimits,
});
export type ViewLayoutDefinition = typeof ViewLayoutDefinition.Type;

export const ViewLayout = Schema.Struct({
  missionId: MissionId,
  layout: ViewLayoutDefinition,
  ...ViewChangeMeta.fields,
  /** Starter layout version this mission was seeded from. */
  seededFrom: PositiveInt,
});
export type ViewLayout = typeof ViewLayout.Type;

export const ViewStarterLayout = Schema.Struct({
  layout: ViewLayoutDefinition,
  ...ViewChangeMeta.fields,
});
export type ViewStarterLayout = typeof ViewStarterLayout.Type;

export const ViewLayoutOp = Schema.Union([
  Schema.TaggedStruct("hide", { key: ViewKey }),
  Schema.TaggedStruct("show", { key: ViewKey }),
  /** `index` counts entries within the target region. */
  Schema.TaggedStruct("move", {
    key: ViewKey,
    region: Schema.optionalKey(ViewRegion),
    index: NonNegativeInt,
  }),
  Schema.TaggedStruct("rename", { key: ViewKey, title: Schema.NullOr(ViewLabel) }),
  Schema.TaggedStruct("remove", { key: ViewKey }),
  Schema.TaggedStruct("add", { entry: ViewLayoutEntry, index: Schema.optionalKey(NonNegativeInt) }),
  Schema.TaggedStruct("replace", { key: ViewKey, section: ViewLayoutSection }),
  Schema.TaggedStruct("limits", { limits: ViewLimits }),
  /** Rebuild from scratch. */
  Schema.TaggedStruct("set", { layout: ViewLayoutDefinition }),
  /** Mission layouts only: copy the current starter layout. */
  Schema.TaggedStruct("reset", {}),
]);
export type ViewLayoutOp = typeof ViewLayoutOp.Type;

const DEFAULT_STARTER_AT = "2026-10-18T00:00:00.000Z";

const tabEntry = (tab: ViewTabKind): ViewLayoutEntry => ({
  key: `tab-${tab}`,
  section: { _tag: "tab", tab },
  region: "tabs",
  hidden: false,
  title: null,
});
const builtinEntry = (kind: ViewBuiltinSectionKind, region: ViewRegion): ViewLayoutEntry => ({
  key: kind,
  section: { _tag: "builtin", kind },
  region,
  hidden: false,
  title: null,
});

/** The recommended starter, used until the owner or a master edits the stored one. */
export const DEFAULT_STARTER_LAYOUT: ViewStarterLayout = {
  layout: {
    entries: [
      builtinEntry("header-stats", "header"),
      ...ViewTabKind.literals.map(tabEntry),
      // Stacked (one column) order is entry order: Needs you, then Your
      // requests directly under it. Side by side, Your requests tops the main
      // column next to Needs you at the top of the rail.
      builtinEntry("needs-you", "rail"),
      builtinEntry("your-requests", "main"),
      builtinEntry("sub-missions", "main"),
      builtinEntry("since-last-looked", "main"),
      builtinEntry("path-to-milestone", "rail"),
      builtinEntry("with-the-master", "rail"),
    ],
    limits: { templates: 24, sections: 8, changesPerDay: 40 },
  },
  version: 1,
  changedBy: { _tag: "system", component: "missions-views" },
  by: "system",
  changedAt: DEFAULT_STARTER_AT,
  changeNote: null,
};

/** Default titles; a layout entry's `title` overrides them. */
export const VIEW_BUILTIN_SECTION_TITLES: { readonly [K in ViewBuiltinSectionKind]: string } = {
  "header-stats": "Mission header",
  "needs-you": "Needs you",
  "path-to-milestone": "Path to milestone",
  "with-the-master": "With the master",
  "sub-missions": "Sub-missions",
  "since-last-looked": "Since you last looked",
  "your-requests": "Your requests",
};
export const VIEW_TAB_TITLES: { readonly [K in ViewTabKind]: string } = {
  overview: "Overview",
  board: "Board",
  changes: "Changes",
  calls: "Calls",
  rooms: "Rooms",
  lanes: "Lanes",
  work: "Work",
  rules: "Rules",
  roles: "Roles",
  timeline: "Timeline",
  views: "Views",
};

/** Regions where a built-in page section shows on the mission overview. */
/** Where Needs you and Your requests count as shown; the header carries stats only. */
const OVERVIEW_REGIONS: ReadonlySet<ViewRegion> = new Set(["main", "rail"]);

/** The overview page is gone when its tab is hidden or removed while other tabs remain. */
export const viewLayoutShowsOverview = (layout: ViewLayoutDefinition): boolean => {
  const tabs = layout.entries.filter((entry) => entry.section._tag === "tab");
  if (tabs.length === 0) return true;
  return tabs.some(
    (entry) => !entry.hidden && entry.section._tag === "tab" && entry.section.tab === "overview",
  );
};

const showsBuiltin = (layout: ViewLayoutDefinition, kind: ViewBuiltinSectionKind): boolean =>
  viewLayoutShowsOverview(layout) &&
  layout.entries.some(
    (entry) =>
      !entry.hidden &&
      entry.section._tag === "builtin" &&
      entry.section.kind === kind &&
      OVERVIEW_REGIONS.has(entry.region),
  );

/** Whether the layout shows Needs you on the overview. */
export const viewLayoutShowsNeedsYou = (layout: ViewLayoutDefinition): boolean =>
  showsBuiltin(layout, "needs-you");

/** Whether the layout shows Your requests on the overview. */
export const viewLayoutShowsYourRequests = (layout: ViewLayoutDefinition): boolean =>
  showsBuiltin(layout, "your-requests");

/**
 * Items waiting on the owner never disappear: when Needs you is hidden,
 * moved off the overview or replaced, a pinned strip carries them.
 */
export const viewLayoutPinsStrip = (layout: ViewLayoutDefinition, ownerWaiting: number): boolean =>
  ownerWaiting > 0 && !viewLayoutShowsNeedsYou(layout);

export const ViewPinned = Schema.Struct({
  /** Items waiting on the owner while Needs you is not on the overview. */
  needsYou: Schema.Boolean,
  /** Answered requests the owner has not read while Your requests is not on the overview. */
  requests: Schema.Boolean,
});
export type ViewPinned = typeof ViewPinned.Type;

/** What the pinned strip carries; it shows when either part is set. */
export const viewPinnedStrip = (
  layout: ViewLayoutDefinition,
  waiting: { readonly ownerWaiting: number; readonly requestsUnread: number },
): ViewPinned => ({
  needsYou: viewLayoutPinsStrip(layout, waiting.ownerWaiting),
  requests: waiting.requestsUnread > 0 && !viewLayoutShowsYourRequests(layout),
});

// ---------------------------------------------------------------------------
// Bindable paths

export const ViewValueKind = Schema.Literals([
  "text",
  "number",
  "time",
  "actor",
  "enum",
  "flags",
  "links",
  "link",
  "refs",
  "options",
  "pr",
  "facts",
  // --- views additions ---
  "assets",
  /** Too long for the snapshot; only a markdown block inside a collapsible binds it, loaded on open. */
  "longtext",
  // --- end views additions ---
]);
export type ViewValueKind = typeof ViewValueKind.Type;

export type ViewPathScope = ViewBackingKind | ViewQueryKind;
type PathTable = Readonly<Record<string, ViewValueKind>>;

/** Derived on every record: age since created, who made it, who approves. */
export const VIEW_DERIVED_PATHS: PathTable = { age: "time", by: "actor", approver: "enum" };

export const VIEW_PATHS: { readonly [K in ViewPathScope]: PathTable } = {
  ask: {
    question: "text",
    context: "text",
    options: "options",
    recommendation: "text",
    urgency: "enum",
    costOfWaiting: "text",
    blocks: "refs",
    status: "enum",
    createdAt: "time",
  },
  approval: {
    title: "text",
    detail: "text",
    summary: "text",
    flags: "flags",
    links: "links",
    kind: "enum",
    requestedBy: "text",
    status: "enum",
    decisionNote: "text",
    createdAt: "time",
  },
  draft: {
    audience: "text",
    channel: "enum",
    target: "link",
    text: "text",
    approvedText: "text",
    summary: "text",
    flags: "flags",
    writtenBy: "text",
    requestedBy: "text",
    revision: "number",
    head: "text",
    staleReason: "text",
    status: "enum",
    createdAt: "time",
    // --- views additions ---
    withdrawNote: "text",
    // --- end views additions ---
  },
  "work-item": {
    title: "text",
    kind: "enum",
    stage: "enum",
    heldBy: "actor",
    blockedBy: "refs",
    pullRequest: "pr",
    links: "links",
    facts: "facts",
    deferral: "text",
    createdAt: "time",
    updatedAt: "time",
  },
  note: {
    type: "enum",
    summary: "text",
    severity: "enum",
    confidence: "number",
    basis: "enum",
    evidenceLinks: "links",
    author: "enum",
    createdAt: "time",
  },
  knock: {
    fromTitle: "text",
    path: "text",
    summary: "text",
    body: "text",
    senderKind: "enum",
    status: "enum",
    createdAt: "time",
  },
  suggestion: {
    title: "text",
    targetKind: "enum",
    target: "refs",
    diffText: "text",
    why: "text",
    author: "enum",
    acceptor: "enum",
    status: "enum",
    createdAt: "time",
  },
  // Router round 4 record. `lastReply` is the newest message on the request,
  // whoever wrote it, one line (router round 5 keeps it on every post).
  "owner-request": {
    title: "text",
    status: "enum",
    lastReply: "text",
    lastOwnerAt: "time",
    lastMasterAt: "time",
    links: "refs",
    settledAt: "time",
    createdAt: "time",
  },
  milestone: {
    title: "text",
    status: "enum",
    targetAt: "time",
    statusNote: "text",
    createdAt: "time",
  },
  "sub-mission": { title: "text", intent: "text", status: "enum", health: "enum", order: "number" },
  call: {
    title: "text",
    decision: "text",
    reason: "text",
    decidedBy: "actor",
    reversible: "enum",
    createdAt: "time",
  },
  // --- views additions ---
  // `title` is the report's first heading; `period` and `size` are short
  // display text the server derives, so rows never carry the report body.
  report: {
    title: "text",
    kind: "enum",
    period: "text",
    size: "text",
    coversFrom: "time",
    coversTo: "time",
    createdAt: "time",
    text: "longtext",
  },
  // --- end views additions ---
};

/** Section-level values a section body may bind outside its list rows. */
export const VIEW_SECTION_PATHS: PathTable = { count: "number", total: "number" };

/** Row paths for `refs` sections, whose rows mix record kinds. */
export const VIEW_REF_ROW_PATHS: PathTable = { title: "text", kind: "enum", status: "enum" };

/** Value kinds each binding slot accepts. */
const SCALAR: ReadonlyArray<ViewValueKind> = [
  "text",
  "number",
  "time",
  "actor",
  "enum",
  "link",
  "pr",
];
export const VIEW_BIND_ACCEPTS = {
  title: ["text", "enum", "link", "pr"],
  text: SCALAR,
  fact: SCALAR,
  flags: ["flags"],
  links: ["links", "link"],
  refs: ["refs"],
  listTitle: ["text", "enum", "link", "pr"],
  listMeta: SCALAR,
  listStatus: ["enum"],
  // --- views additions ---
  meter: ["number"],
  gallery: ["assets"],
  cellText: SCALAR,
  cellStatus: ["enum"],
  cellAge: ["time"],
  cellPerson: ["actor", "text", "enum"],
  cellLink: ["link", "links", "pr"],
  cellCount: ["number", "refs", "flags", "links", "assets"],
  collapsibleTitle: ["text", "enum", "link", "pr"],
  collapsibleMeta: SCALAR,
  markdown: ["text", "longtext"],
  // --- end views additions ---
} as const satisfies Record<string, ReadonlyArray<ViewValueKind>>;
export type ViewBindSlot = keyof typeof VIEW_BIND_ACCEPTS;

export const VIEW_FIELD_VALUE_KIND: { readonly [K in ViewFieldType]: ViewValueKind } = {
  short: "text",
  text: "text",
  number: "number",
  choice: "enum",
  flags: "flags",
  links: "links",
  refs: "refs",
  // --- views additions ---
  assets: "assets",
  // --- end views additions ---
};

// --- views additions ---
/** The bind slot of each table cell kind. */
export const VIEW_TABLE_CELL_SLOT = {
  text: "cellText",
  status: "cellStatus",
  age: "cellAge",
  person: "cellPerson",
  link: "cellLink",
  count: "cellCount",
} as const satisfies Record<ViewTableCellKind, ViewBindSlot>;
// --- end views additions ---

// ---------------------------------------------------------------------------
// Built-in templates: today's cards, as data. A stored template overrides.

export interface ViewBuiltinTemplate {
  readonly id: string;
  readonly definition: ViewTemplateDefinition;
}

const text = (bind: string, style: "body" | "meta", maxLines: number): ViewNode => ({
  _tag: "text",
  bind,
  style,
  maxLines,
});
const facts = (...rows: ReadonlyArray<readonly [string, string]>): ViewNode => ({
  _tag: "facts",
  rows: rows.map(([label, bind]) => ({ label, bind })),
});

const BUILTIN_DEFINITIONS: { readonly [K in ViewBackingKind]: ViewTemplateDefinition } = {
  ask: {
    key: "decision",
    name: "Decision",
    backing: "ask",
    kicker: "Decision",
    title: "record.question",
    body: [
      text("record.context", "body", 4),
      { _tag: "choice" },
      facts(["Cost of waiting", "record.costOfWaiting"]),
      { _tag: "refs", bind: "record.blocks" },
    ],
    actions: ["answer", "comment", "discuss"],
    primary: "answer",
  },
  approval: {
    key: "approval",
    name: "Approval",
    backing: "approval",
    kicker: "Approval",
    title: "record.title",
    body: [
      text("record.summary", "body", 3),
      { _tag: "flags", bind: "record.flags" },
      text("record.detail", "meta", 3),
      { _tag: "links", bind: "record.links" },
      facts(["Kind", "record.kind"], ["Asked by", "record.requestedBy"]),
    ],
    actions: ["approve", "reject", "comment", "discuss"],
    primary: "approve",
  },
  // Covers crw review feedback too: summary, flags, the draft with its diff,
  // the target link, and who asked for it.
  draft: {
    key: "draft",
    name: "Draft",
    backing: "draft",
    kicker: "Draft",
    title: "record.target",
    body: [
      text("record.summary", "meta", 2),
      { _tag: "flags", bind: "record.flags" },
      { _tag: "draft", editable: true, diff: true },
      { _tag: "links", bind: "record.target" },
      facts(
        ["To", "record.audience"],
        ["Asked by", "record.requestedBy"],
        ["Revision", "record.revision"],
      ),
      text("record.withdrawNote", "meta", 2),
    ],
    actions: ["send", "rewrite", "drop", "comment", "discuss"],
    primary: "send",
  },
  "work-item": {
    key: "work",
    name: "Work",
    backing: "work-item",
    kicker: "Work",
    title: "record.title",
    body: [
      facts(["Stage", "record.stage"], ["Held by", "record.heldBy"]),
      { _tag: "links", bind: "record.links" },
    ],
    actions: ["comment", "discuss", "open"],
    primary: null,
  },
  note: {
    key: "note",
    name: "Note",
    backing: "note",
    kicker: "Note",
    title: "record.summary",
    body: [
      facts(
        ["Type", "record.type"],
        ["Severity", "record.severity"],
        ["Confidence", "record.confidence"],
      ),
      { _tag: "links", bind: "record.evidenceLinks" },
    ],
    actions: ["ack", "discuss"],
    primary: "ack",
  },
  knock: {
    key: "knock",
    name: "Knock",
    backing: "knock",
    kicker: "Knock",
    title: "record.fromTitle",
    body: [
      text("record.summary", "body", 2),
      text("record.body", "meta", 4),
      facts(["Path", "record.path"]),
    ],
    actions: ["forward", "dismiss", "discuss"],
    primary: "forward",
  },
  suggestion: {
    key: "suggestion",
    name: "Suggestion",
    backing: "suggestion",
    kicker: "Suggestion",
    title: "record.title",
    body: [
      text("record.why", "body", 3),
      text("record.diffText", "meta", 6),
      facts(["Changes", "record.targetKind"], ["From", "record.author"]),
    ],
    actions: ["accept", "dismiss-suggestion", "discuss"],
    primary: "accept",
  },
  "owner-request": {
    key: "request",
    name: "Your request",
    backing: "owner-request",
    kicker: "Your request",
    title: "record.title",
    body: [
      text("record.lastReply", "body", 4),
      facts(["Status", "record.status"], ["Replied", "record.lastMasterAt"]),
      { _tag: "refs", bind: "record.links" },
    ],
    actions: ["reply", "settle", "reopen", "open"],
    primary: "reply",
  },
};

export const builtinViewTemplateId = (kind: ViewBackingKind): string =>
  `${BUILTIN_VIEW_TEMPLATE_PREFIX}${kind}`;

export const BUILTIN_VIEW_TEMPLATES: ReadonlyArray<ViewBuiltinTemplate> =
  ViewBackingKind.literals.map((kind) => ({
    id: builtinViewTemplateId(kind),
    definition: BUILTIN_DEFINITIONS[kind],
  }));

export const builtinViewTemplate = (kind: ViewBackingKind): ViewBuiltinTemplate => ({
  id: builtinViewTemplateId(kind),
  definition: BUILTIN_DEFINITIONS[kind],
});

// --- views additions ---
/**
 * Stock templates every mission has besides the per-kind built-ins. A release
 * approval matches `release`; an ask names `builtin:ui-review` to show its
 * screens for per-image review. A stored template with the same key replaces one.
 */
export const STOCK_VIEW_TEMPLATES: ReadonlyArray<ViewBuiltinTemplate> = [
  {
    id: `${BUILTIN_VIEW_TEMPLATE_PREFIX}release`,
    definition: {
      key: "release",
      name: "Release",
      backing: "approval",
      kicker: "Release",
      title: "record.title",
      fields: [
        { key: "version", label: "Version", type: "short", required: false, editable: false },
        { key: "env", label: "Environment", type: "short", required: false, editable: false },
        { key: "changes", label: "Changes", type: "text", required: false, editable: false },
        { key: "prs", label: "PRs", type: "links", required: false, editable: false },
      ],
      body: [
        facts(["Version", "field.version"], ["Environment", "field.env"]),
        text("field.changes", "body", 6),
        { _tag: "links", bind: "field.prs" },
        { _tag: "flags", bind: "record.flags" },
        { _tag: "links", bind: "record.links" },
      ],
      actions: ["approve", "reject", "discuss"],
      primary: "approve",
      match: { approvalKind: ["release"] },
    },
  },
  {
    id: `${BUILTIN_VIEW_TEMPLATE_PREFIX}ui-review`,
    definition: {
      key: "ui-review",
      name: "UI review",
      backing: "ask",
      kicker: "UI review",
      title: "record.question",
      fields: [
        { key: "screens", label: "Screens", type: "assets", required: true, editable: false },
        { key: "where", label: "Where", type: "links", required: false, editable: false },
      ],
      body: [
        text("record.context", "body", 3),
        { _tag: "gallery", bind: "field.screens", review: "per-asset" },
        { _tag: "choice" },
        { _tag: "links", bind: "field.where" },
      ],
      actions: ["answer", "discuss"],
      primary: "answer",
    },
  },
];
// --- end views additions ---

// ---------------------------------------------------------------------------
// Template selection: explicit id > most specific match > built-in.

/** What matching reads from a backed record. */
export interface ViewMatchSubject {
  readonly kind: ViewBackingKind;
  readonly templateId?: string | null;
  readonly channel?: string | null;
  readonly approvalKind?: string | null;
  readonly requestedBy?: string | null;
  readonly flags?: ReadonlyArray<string>;
  readonly audience?: string | null;
  readonly subMissionId?: string | null;
}

export type ViewBackedRecord =
  | { readonly kind: "ask"; readonly record: Ask }
  | { readonly kind: "approval"; readonly record: Approval }
  | { readonly kind: "draft"; readonly record: Draft }
  | { readonly kind: "work-item"; readonly record: WorkItem }
  | { readonly kind: "note"; readonly record: Note }
  | { readonly kind: "knock"; readonly record: Knock }
  | { readonly kind: "suggestion"; readonly record: Suggestion }
  | { readonly kind: "owner-request"; readonly record: ViewOwnerRequestRecord };

/** The part of router's owner request record that views read. */
export interface ViewOwnerRequestRecord {
  readonly id: string;
  readonly status: string;
  readonly subMissionId?: string | null;
}

const explicitTemplateOf = (record: object): string | null => {
  const view = (record as { readonly view?: { readonly templateId?: unknown } }).view;
  return typeof view?.templateId === "string" ? view.templateId : null;
};

export const viewMatchSubjectOf = (backed: ViewBackedRecord): ViewMatchSubject => {
  const templateId = explicitTemplateOf(backed.record);
  switch (backed.kind) {
    case "approval":
      return {
        kind: "approval",
        templateId,
        approvalKind: backed.record.kind,
        requestedBy: backed.record.requestedBy,
        flags: backed.record.flags ?? [],
      };
    case "draft":
      return {
        kind: "draft",
        templateId,
        channel: backed.record.channel,
        requestedBy: backed.record.requestedBy ?? null,
        flags: backed.record.flags ?? [],
        audience: backed.record.audience,
      };
    case "ask":
    case "work-item":
    case "note":
      return { kind: backed.kind, templateId, subMissionId: backed.record.subMissionId };
    case "owner-request":
      return { kind: backed.kind, templateId, subMissionId: backed.record.subMissionId ?? null };
    case "knock":
    case "suggestion":
      return { kind: backed.kind, templateId };
  }
};

export const viewMatchSpecificity = (match: ViewMatch): number =>
  (match.channel === undefined ? 0 : 1) +
  (match.approvalKind === undefined ? 0 : 1) +
  (match.requestedBy === undefined ? 0 : 1) +
  (match.flag === undefined ? 0 : 1) +
  (match.audience === undefined ? 0 : 1) +
  (match.subMissionId === undefined ? 0 : 1);

const fitsList = (list: ReadonlyArray<string> | undefined, value: string | null | undefined) =>
  list === undefined || (value !== null && value !== undefined && list.includes(value));
const fitsValue = (expected: string | undefined, value: string | null | undefined) =>
  expected === undefined || expected === value;

export const viewMatchFits = (match: ViewMatch, subject: ViewMatchSubject): boolean =>
  fitsList(match.channel, subject.channel) &&
  fitsList(match.approvalKind, subject.approvalKind) &&
  fitsList(match.requestedBy, subject.requestedBy) &&
  (match.flag === undefined || (subject.flags ?? []).includes(match.flag)) &&
  fitsValue(match.audience, subject.audience) &&
  fitsValue(match.subMissionId, subject.subMissionId);

const listsMeet = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined) =>
  a === undefined || b === undefined || a.some((value) => b.includes(value));
const valuesMeet = (a: string | undefined, b: string | undefined) =>
  a === undefined || b === undefined || a === b;

/** Whether one record could fit both matches. */
export const viewMatchesOverlap = (a: ViewMatch, b: ViewMatch): boolean =>
  listsMeet(a.channel, b.channel) &&
  listsMeet(a.approvalKind, b.approvalKind) &&
  listsMeet(a.requestedBy, b.requestedBy) &&
  valuesMeet(a.audience, b.audience) &&
  valuesMeet(a.subMissionId, b.subMissionId);

export interface SelectedViewTemplate {
  readonly source: "explicit" | "match" | "builtin";
  readonly id: string;
  readonly definition: ViewTemplateDefinition;
  readonly template: ViewTemplate | null;
}

export const selectViewTemplate = (
  subject: ViewMatchSubject,
  templates: ReadonlyArray<ViewTemplate>,
): SelectedViewTemplate => {
  const usable = templates.filter(
    (template) => template.status === "active" && template.definition.backing === subject.kind,
  );
  // --- views additions ---
  const keyed = (key: string) => usable.find((template) => template.definition.key === key);
  const stock = STOCK_VIEW_TEMPLATES.filter(
    (entry) =>
      entry.definition.backing === subject.kind && keyed(entry.definition.key) === undefined,
  );
  const named = STOCK_VIEW_TEMPLATES.find((entry) => entry.id === subject.templateId);
  // --- end views additions ---
  const explicit =
    subject.templateId === null || subject.templateId === undefined
      ? undefined
      : (usable.find((template) => template.id === subject.templateId) ??
        (named === undefined ? undefined : keyed(named.definition.key)));
  if (explicit !== undefined) {
    return {
      source: "explicit",
      id: explicit.id,
      definition: explicit.definition,
      template: explicit,
    };
  }
  if (named !== undefined && stock.includes(named)) {
    return { source: "explicit", id: named.id, definition: named.definition, template: null };
  }
  let best: ViewTemplate | ViewBuiltinTemplate | undefined;
  let bestScore = -1;
  for (const template of [...usable, ...stock]) {
    const match = template.definition.match;
    if (match === null || match === undefined || !viewMatchFits(match, subject)) continue;
    const score = viewMatchSpecificity(match);
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }
  if (best !== undefined) {
    return {
      source: "match",
      id: best.id,
      definition: best.definition,
      template: "missionId" in best ? best : null,
    };
  }
  const builtin = builtinViewTemplate(subject.kind);
  return { source: "builtin", id: builtin.id, definition: builtin.definition, template: null };
};

// ---------------------------------------------------------------------------
// Inputs, issues, snapshots

export const ViewRefKind = Schema.Literals(["view-template", "view-section"]);
export const ViewRef = Schema.Struct({ kind: ViewRefKind, id: TrimmedNonEmptyString });
export type ViewRef = typeof ViewRef.Type;

/** Creates when `templateId` is new or absent (a template with the same key is updated). */
export const DefineViewTemplateInput = Schema.Struct({
  missionId: MissionId,
  templateId: Schema.optionalKey(ViewTemplateId),
  definition: ViewTemplateDefinition,
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type DefineViewTemplateInput = typeof DefineViewTemplateInput.Type;

/** Creates or updates a section; a new one joins the layout in `region` (default main). */
export const PlaceViewSectionInput = Schema.Struct({
  missionId: MissionId,
  sectionId: Schema.optionalKey(ViewSectionId),
  definition: ViewSectionDefinition,
  region: Schema.optionalKey(ViewRegion),
  index: Schema.optionalKey(NonNegativeInt),
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type PlaceViewSectionInput = typeof PlaceViewSectionInput.Type;

export const RemoveViewInput = Schema.Struct({
  missionId: MissionId,
  ref: ViewRef,
  expectedVersion: Schema.optionalKey(PositiveInt),
  reason: Schema.optionalKey(MissionSummaryText),
});
export type RemoveViewInput = typeof RemoveViewInput.Type;

/** Brings a removed definition back, or rolls an active one back to `toVersion`. */
export const RestoreViewInput = Schema.Struct({
  missionId: MissionId,
  ref: ViewRef,
  toVersion: Schema.optionalKey(PositiveInt),
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type RestoreViewInput = typeof RestoreViewInput.Type;

const LayoutOps = Schema.Array(ViewLayoutOp).check(Schema.isMinLength(1), Schema.isMaxLength(20));

export const EditViewLayoutInput = Schema.Struct({
  missionId: MissionId,
  ops: LayoutOps,
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type EditViewLayoutInput = typeof EditViewLayoutInput.Type;

export const RestoreViewLayoutInput = Schema.Struct({
  missionId: MissionId,
  toVersion: PositiveInt,
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type RestoreViewLayoutInput = typeof RestoreViewLayoutInput.Type;

/** Changes affect new missions only; existing missions keep their own layout. */
export const EditStarterLayoutInput = Schema.Struct({
  ops: LayoutOps,
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type EditStarterLayoutInput = typeof EditStarterLayoutInput.Type;

export const RestoreStarterLayoutInput = Schema.Struct({
  toVersion: PositiveInt,
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type RestoreStarterLayoutInput = typeof RestoreStarterLayoutInput.Type;

// --- views additions ---
/** Templates and sections written together, or nothing. Copies come from another mission. */
export const ApplyViewBundleInput = Schema.Struct({
  missionId: MissionId,
  templates: Schema.Array(
    Schema.Struct({
      templateId: Schema.optionalKey(ViewTemplateId),
      definition: ViewTemplateDefinition,
    }),
  ).check(Schema.isMaxLength(12)),
  sections: Schema.Array(
    Schema.Struct({
      sectionId: Schema.optionalKey(ViewSectionId),
      definition: ViewSectionDefinition,
      region: Schema.optionalKey(ViewRegion),
    }),
  ).check(Schema.isMaxLength(12)),
  /** Active templates and sections of another mission, by key (all when keys are absent). */
  copyFrom: Schema.optionalKey(
    Schema.Struct({
      missionId: MissionId,
      templateKeys: Schema.optionalKey(Schema.Array(ViewKey).check(Schema.isMaxLength(12))),
      sectionKeys: Schema.optionalKey(Schema.Array(ViewKey).check(Schema.isMaxLength(12))),
    }),
  ),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type ApplyViewBundleInput = typeof ApplyViewBundleInput.Type;

export const MissionAssetStatus = Schema.Literals(["active", "removed", "expired"]);
/** An image copied into the mission. Bytes live with attachments under the same id. */
export const MissionAsset = Schema.Struct({
  id: MissionAssetId,
  missionId: MissionId,
  /** The item it was attached for, when one was named. */
  subject: Schema.NullOr(MissionRecordRef),
  kind: Schema.Literal("image"),
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  sizeBytes: NonNegativeInt,
  width: Schema.NullOr(PositiveInt),
  height: Schema.NullOr(PositiveInt),
  name: Schema.String.check(Schema.isMaxLength(120)),
  sha256: Schema.String,
  addedBy: MissionActor,
  status: MissionAssetStatus,
  version: PositiveInt,
  createdAt: IsoDateTime,
  changedAt: IsoDateTime,
});
export type MissionAsset = typeof MissionAsset.Type;

/** An image from the caller's own thread attachments, or a file path on the server. */
export const MissionAssetSource = Schema.Union([
  Schema.TaggedStruct("attachment", { attachmentId: TrimmedNonEmptyString }),
  Schema.TaggedStruct("file", { path: TrimmedNonEmptyString }),
]);
export type MissionAssetSource = typeof MissionAssetSource.Type;

/** `ref.id` of the result is the asset id to put in an `assets` field. */
export const AddMissionAssetInput = Schema.Struct({
  missionId: MissionId,
  source: MissionAssetSource,
  subject: Schema.optionalKey(MissionRecordRef),
  name: Schema.optionalKey(ViewLabel),
});
export type AddMissionAssetInput = typeof AddMissionAssetInput.Type;

export const RemoveMissionAssetInput = Schema.Struct({
  missionId: MissionId,
  assetId: MissionAssetId,
  reason: Schema.optionalKey(MissionSummaryText),
});
export type RemoveMissionAssetInput = typeof RemoveMissionAssetInput.Type;

export const VIEW_ASSET_LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  missionBytes: 2 * 1024 * 1024 * 1024,
} as const;

/** A section's rows, computed on the server and cut to the paths its body binds. */
export const ViewSectionRow = Schema.Struct({
  ref: MissionRecordRef,
  value: Schema.Record(Schema.String, Schema.Unknown),
});
export type ViewSectionRow = typeof ViewSectionRow.Type;
export const ViewSectionData = Schema.Struct({
  sectionId: ViewSectionId,
  rows: Schema.Array(ViewSectionRow).check(Schema.isMaxLength(20)),
  total: NonNegativeInt,
});
export type ViewSectionData = typeof ViewSectionData.Type;

/** One `longtext` value of a row, loaded when its collapsible opens. */
export const ViewLongTextInput = Schema.Struct({
  missionId: MissionId,
  ref: MissionRecordRef,
  path: ViewKey,
});
export type ViewLongTextInput = typeof ViewLongTextInput.Type;
export const ViewLongText = Schema.Struct({
  ref: MissionRecordRef,
  path: Schema.String,
  text: Schema.String,
  /** Characters in the whole value. */
  size: NonNegativeInt,
  /** True when `text` stops at `VIEW_HARD_LIMITS.longTextChars`. */
  truncated: Schema.Boolean,
});
export type ViewLongText = typeof ViewLongText.Type;
// --- end views additions ---

// --- sources additions ---
/**
 * Creates a source when `sourceId` is absent (title, runtime, code and fields
 * required), otherwise patches the named keys.
 */
export const SetViewSourceInput = Schema.Struct({
  missionId: MissionId,
  sourceId: Schema.optionalKey(ViewDataSourceId),
  title: Schema.optionalKey(ViewLabel),
  runtime: Schema.optionalKey(ViewSourceRuntime),
  code: Schema.optionalKey(ViewSourceCode),
  fields: Schema.optionalKey(ViewSourceFields),
  refreshMinutes: Schema.optionalKey(ViewSourceRefreshMinutes),
  timeoutSeconds: Schema.optionalKey(ViewSourceTimeoutSeconds),
  enabled: Schema.optionalKey(Schema.Boolean),
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type SetViewSourceInput = typeof SetViewSourceInput.Type;

export const RunViewSourceInput = Schema.Struct({
  missionId: MissionId,
  sourceId: ViewDataSourceId,
});
export type RunViewSourceInput = typeof RunViewSourceInput.Type;

export const RemoveViewSourceInput = Schema.Struct({
  missionId: MissionId,
  sourceId: ViewDataSourceId,
  expectedVersion: Schema.optionalKey(PositiveInt),
  reason: Schema.optionalKey(MissionSummaryText),
});
export type RemoveViewSourceInput = typeof RemoveViewSourceInput.Type;

/** Brings a removed source back, or rolls an active one back to `toVersion`. */
export const RestoreViewSourceInput = Schema.Struct({
  missionId: MissionId,
  sourceId: ViewDataSourceId,
  toVersion: Schema.optionalKey(PositiveInt),
  expectedVersion: Schema.optionalKey(PositiveInt),
  changeNote: Schema.optionalKey(MissionSummaryText),
});
export type RestoreViewSourceInput = typeof RestoreViewSourceInput.Type;

export const ViewSourceRunResult = Schema.Struct({
  sourceId: ViewDataSourceId,
  ok: Schema.Boolean,
  ranAt: IsoDateTime,
  durationMs: NonNegativeInt,
  /** Rows the run produced; the cache keeps the previous rows when `ok` is false. */
  total: NonNegativeInt,
  /** The first 20 parsed rows. */
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(20)),
  /** Output problems, at most 20. */
  errors: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
  stderr: Schema.String,
});
export type ViewSourceRunResult = typeof ViewSourceRunResult.Type;
// --- end sources additions ---

export const ViewHistoryTarget = Schema.Union([
  Schema.TaggedStruct("template", { id: ViewTemplateId }),
  Schema.TaggedStruct("section", { id: ViewSectionId }),
  Schema.TaggedStruct("layout", {}),
  Schema.TaggedStruct("starter", {}),
  // --- sources additions ---
  Schema.TaggedStruct("source", { id: ViewDataSourceId }),
  // --- end sources additions ---
]);
export type ViewHistoryTarget = typeof ViewHistoryTarget.Type;

export const ViewHistoryInput = Schema.Struct({ missionId: MissionId, target: ViewHistoryTarget });
export type ViewHistoryInput = typeof ViewHistoryInput.Type;

export const ViewHistoryEntry = Schema.Struct({
  ...ViewChangeMeta.fields,
  status: Schema.NullOr(ViewStatus),
  /** The template or section definition, or the layout, as of this version. */
  value: Schema.Unknown,
});
export type ViewHistoryEntry = typeof ViewHistoryEntry.Type;

export const ViewHistory = Schema.Struct({
  target: ViewHistoryTarget,
  entries: Schema.Array(ViewHistoryEntry),
});
export type ViewHistory = typeof ViewHistory.Type;

export const PreviewViewInput = Schema.Struct({
  missionId: MissionId,
  definition: Schema.Union([
    Schema.TaggedStruct("template", {
      templateId: Schema.optionalKey(ViewTemplateId),
      definition: ViewTemplateDefinition,
    }),
    Schema.TaggedStruct("section", {
      sectionId: Schema.optionalKey(ViewSectionId),
      definition: ViewSectionDefinition,
    }),
  ]),
});
export type PreviewViewInput = typeof PreviewViewInput.Type;

export const ViewIssueCode = Schema.Literals([
  "shape",
  "unknown-node",
  "node-not-allowed",
  "duplicate",
  "bad-binding",
  "binding-kind",
  "action-not-allowed",
  "field",
  "match-conflict",
  "limit",
  "catalog-version",
  "guard",
]);
export type ViewIssueCode = typeof ViewIssueCode.Type;
export const ViewIssue = Schema.Struct({
  path: Schema.String,
  code: ViewIssueCode,
  detail: Schema.String,
});
export type ViewIssue = typeof ViewIssue.Type;

/** `path: code detail` lines, the way `MissionError invalid` carries them. */
export const formatViewIssues = (issues: ReadonlyArray<ViewIssue>): string =>
  issues
    .slice(0, VIEW_HARD_LIMITS.issues)
    .map((issue) => `${issue.path}: ${issue.code} ${issue.detail}`.trim())
    .join("; ");

/** Same checks as a write; stores nothing. */
export const ViewPreview = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(ViewIssue),
  nodes: NonNegativeInt,
  bytes: NonNegativeInt,
});
export type ViewPreview = typeof ViewPreview.Type;

export const MissionViewsInput = Schema.Struct({ missionId: MissionId });
export type MissionViewsInput = typeof MissionViewsInput.Type;

export const MissionViewsSnapshot = Schema.Struct({
  missionId: MissionId,
  catalogVersion: PositiveInt,
  /** Counts view changes to this mission and to the starter layout (0 before any). */
  revision: NonNegativeInt,
  templates: Schema.Array(ViewTemplate),
  sections: Schema.Array(ViewSection),
  layout: ViewLayout,
  starter: ViewStarterLayout,
  /** Items waiting on the owner (decide + approve + knocks + suggestions). */
  ownerWaiting: NonNegativeInt,
  /** Answered owner requests the owner has not read yet. */
  requestsUnread: NonNegativeInt,
  /** True when the pinned strip shows (either part of `pinned`). */
  pinnedStrip: Schema.Boolean,
  pinned: ViewPinned,
  /**
   * The master's view changes in the last 24 hours (starter edits included),
   * against `layout.layout.limits.changesPerDay`. The owner is never metered.
   */
  changesToday: NonNegativeInt,
  // --- views additions ---
  /** Rows of the mission's active query sections. */
  sectionData: Schema.optional(Schema.Array(ViewSectionData)),
  /** The mission's active images. */
  assets: Schema.optional(Schema.Array(MissionAsset)),
  // --- end views additions ---
  // --- sources additions ---
  /** Every source, removed ones included so their sections can say "source off". */
  sources: Schema.optional(Schema.Array(ViewSourceListing)),
  sourceRuns: Schema.optional(Schema.Array(ViewSourceRun)),
  // --- end sources additions ---
});
export type MissionViewsSnapshot = typeof MissionViewsSnapshot.Type;

/** What `catalog: true` returns: everything a writer needs to compose valid definitions. */
export const ViewCatalog = Schema.Struct({
  version: PositiveInt,
  nodes: Schema.Array(
    Schema.Struct({ tag: Schema.String, signature: Schema.String, where: Schema.String }),
  ),
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, ViewValueKind)),
  derivedPaths: Schema.Record(Schema.String, ViewValueKind),
  sectionPaths: Schema.Record(Schema.String, ViewValueKind),
  actions: Schema.Array(
    Schema.Struct({
      key: ViewActionKey,
      label: Schema.String,
      kinds: Schema.Array(ViewBackingKind),
    }),
  ),
  hardLimits: Schema.Record(Schema.String, Schema.Number),
  ceilings: Schema.Record(Schema.String, Schema.Number),
  builtins: Schema.Array(Schema.Struct({ id: Schema.String, definition: ViewTemplateDefinition })),
  // --- views additions ---
  /** Which query kinds each `where` filter and each restricted sort takes. */
  queries: Schema.optional(
    Schema.Struct({
      filters: Schema.Record(Schema.String, Schema.Array(ViewQueryKind)),
      sorts: Schema.Record(Schema.String, Schema.Array(ViewQueryKind)),
    }),
  ),
  // --- end views additions ---
  // --- sources additions ---
  sources: Schema.optional(
    Schema.Struct({
      runtimes: Schema.Array(ViewSourceRuntime),
      fieldKinds: Schema.Array(ViewSourceFieldKind),
      limits: Schema.Record(Schema.String, Schema.Number),
      rules: Schema.Array(Schema.String),
      examples: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          /** `mission_view_source_set` input without `missionId`. */
          source: Schema.Unknown,
          /** `mission_view_section` definition reading it. */
          section: Schema.Unknown,
        }),
      ),
    }),
  ),
  // --- end sources additions ---
});
export type ViewCatalog = typeof ViewCatalog.Type;

const NODE_SIGNATURES: ReadonlyArray<{ tag: ViewNodeTag; signature: string; where: string }> = [
  {
    tag: "text",
    signature: "{bind, style: body|meta, maxLines: 1..6}",
    where: "templates, sections",
  },
  { tag: "label", signature: "{text: ≤60 chars}", where: "templates, sections" },
  {
    tag: "facts",
    signature: "{rows: 1..8 of {label: ≤24 chars, bind}}",
    where: "templates, sections",
  },
  { tag: "flags", signature: "{bind: flags}", where: "templates" },
  { tag: "links", signature: "{bind: links}", where: "templates" },
  { tag: "refs", signature: "{bind: refs}", where: "templates" },
  { tag: "draft", signature: "{editable, diff}", where: "draft templates" },
  { tag: "choice", signature: "{}", where: "ask templates" },
  {
    tag: "list",
    signature: "{title: row bind, meta: ≤3 row binds, status: row bind|null}",
    where: "sections",
  },
  {
    tag: "group",
    signature: "{direction: column|row, children: 1..6 nodes}",
    where: "templates, sections",
  },
  // --- views additions ---
  {
    tag: "table",
    signature:
      "{columns: 1..5 of {label: ≤24 chars, bind: row bind, as: text|status|age|person|link|count}}",
    where: "sections",
  },
  {
    tag: "meter",
    signature: "{value: number bind, max: number bind}",
    where: "templates, sections",
  },
  {
    tag: "gallery",
    signature: "{bind: assets field, review: none|per-asset}",
    where: "templates (per-asset on ask templates)",
  },
  {
    tag: "collapsible",
    signature:
      "{title: text bind|null, label?: ≤24 chars, meta: ≤3 binds, open: none|first, children: 1..6 nodes}",
    where:
      "templates, sections (one per row; its children bind that row; no list, table or collapsible inside)",
  },
  {
    tag: "markdown",
    signature: "{bind: text|longtext, maxLines?: 1..40}",
    where: "templates, sections (longtext only inside a collapsible; it loads when that opens)",
  },
  // --- end views additions ---
];

export const VIEW_CATALOG: ViewCatalog = {
  version: VIEW_CATALOG_VERSION,
  nodes: NODE_SIGNATURES,
  paths: VIEW_PATHS,
  derivedPaths: VIEW_DERIVED_PATHS,
  sectionPaths: VIEW_SECTION_PATHS,
  actions: ViewActionKey.literals.map((key) => ({
    key,
    label: VIEW_ACTIONS[key].label,
    kinds: VIEW_ACTIONS[key].kinds,
  })),
  hardLimits: VIEW_HARD_LIMITS,
  ceilings: VIEW_LIMIT_CEILINGS,
  builtins: [...BUILTIN_VIEW_TEMPLATES, ...STOCK_VIEW_TEMPLATES],
  queries: { filters: VIEW_QUERY_FILTERS, sorts: VIEW_QUERY_SORTS },
  // --- sources additions ---
  sources: {
    runtimes: ViewSourceRuntime.literals,
    fieldKinds: ViewSourceFieldKind.literals,
    limits: VIEW_SOURCE_LIMITS,
    rules: [
      "Sources are read-only. Never write to GitHub, Linear, Cliq or anything else, never send messages, never print secrets or tokens.",
      'Print one JSON object to stdout: {"rows":[{"id":"...", <declared fields>}]}. At most 500 rows and 2 MB.',
      "Every row needs a unique string id. Undeclared keys are dropped and long strings are cut.",
      "Kinds: text/enum/longtext strings, number, time (ISO), actor (a plain name), link (an https url or {url, label?}), links (a list of those). null is fine.",
      "A wrong kind, a non-https link, a bad time or a non-zero exit fails the run; the section keeps the last good rows and says it couldn't refresh.",
      "Runs as the owner with the login PATH (gh, linctl, curl, jq), stdin closed, in a scratch directory, niced, within timeoutSeconds (max 60).",
      "Runs only when older than refreshMinutes and someone has the mission open, or on mission_view_source_run. Owner or master only.",
      'Sections read it with source {_tag:"source", sourceId, where?: {field: value}, sort?: {field, dir}, limit} and bind row.<field> or row.id.',
    ],
    examples: [
      {
        title: "Linear issues (linctl)",
        source: {
          title: "Open Linear issues",
          runtime: "bash",
          code: [
            "linctl issue list --team CRP --limit 50 --sort updated --json \\",
            "  | jq '{rows: [.[] | {id: .identifier, title, state: .state.name,",
            "      assignee: .assignee.name, priority: .priorityLabel,",
            "      issue: {url, label: .identifier}, updated: .updatedAt}]}'",
          ].join("\n"),
          fields: {
            title: "text",
            state: "enum",
            assignee: "actor",
            priority: "enum",
            issue: "link",
            updated: "time",
          },
          refreshMinutes: 15,
          timeoutSeconds: 30,
        },
        section: {
          key: "linear",
          title: "Linear",
          source: {
            _tag: "source",
            sourceId: "<id from mission_view_source_set>",
            sort: { field: "updated", dir: "desc" },
            limit: 10,
          },
          body: [
            {
              _tag: "table",
              columns: [
                { label: "Issue", bind: "row.issue", as: "link" },
                { label: "Title", bind: "row.title", as: "text" },
                { label: "State", bind: "row.state", as: "status" },
                { label: "Who", bind: "row.assignee", as: "person" },
                { label: "Updated", bind: "row.updated", as: "age" },
              ],
            },
          ],
        },
      },
      {
        title: "GitHub pull requests (gh)",
        source: {
          title: "Open PRs",
          runtime: "bash",
          code: [
            "gh pr list --repo OWNER/REPO --state open --limit 30 \\",
            "  --json number,title,author,url,updatedAt,isDraft,reviewDecision \\",
            "  | jq '{rows: [.[] | {id: (.number | tostring), title, author: .author.login,",
            '      pr: {url, label: ("#" + (.number | tostring))},',
            '      review: ((.reviewDecision // "none") | ascii_downcase),',
            '      draft: (if .isDraft then "draft" else "ready" end), updated: .updatedAt}]}\'',
          ].join("\n"),
          fields: {
            title: "text",
            author: "actor",
            pr: "link",
            review: "enum",
            draft: "enum",
            updated: "time",
          },
          refreshMinutes: 10,
          timeoutSeconds: 30,
        },
        section: {
          key: "open-prs",
          title: "Open PRs",
          source: {
            _tag: "source",
            sourceId: "<id from mission_view_source_set>",
            where: { draft: "ready" },
            sort: { field: "updated", dir: "desc" },
            limit: 8,
          },
          body: [
            {
              _tag: "list",
              title: "row.title",
              meta: ["row.pr", "row.author", "row.updated"],
              status: "row.review",
            },
          ],
        },
      },
    ],
  },
  // --- end sources additions ---
};
