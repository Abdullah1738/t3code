import {
  AddMissionAssetInput,
  ApplyViewBundleInput,
  RemoveMissionAssetInput,
  DefineViewTemplateInput,
  EditStarterLayoutInput,
  EditViewLayoutInput,
  MissionError,
  MissionId,
  MissionMutationResult,
  MissionViewsSnapshot,
  OrchestratorMcpFailure,
  PlaceViewSectionInput,
  PreviewViewInput,
  RemoveViewInput,
  RestoreStarterLayoutInput,
  RestoreViewInput,
  RestoreViewLayoutInput,
  ViewCatalog,
  ViewHistory,
  ViewHistoryInput,
  ViewPreview,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { callerProvenance } from "../tools/handlers.ts";
import { ViewService } from "./ViewService.ts";

/**
 * Mission view tools: card templates, sections, the mission layout and the
 * starter layout new missions start from. Any caller can read and preview;
 * changes need the owner or the mission's master (any mission's master for the
 * starter). The caller comes from the invocation, never from parameters.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ViewService,
];

const tool = <Name extends string, P extends Schema.Constraint, S extends Schema.Constraint>(
  name: Name,
  description: string,
  parameters: P,
  success: S,
) =>
  Tool.make(name, {
    description,
    parameters,
    success,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  });

const ViewsTool = tool(
  "mission_views",
  "A mission's card templates, sections and layout (every section entry: built-in, tab or custom, with region, order, hidden and title), the starter layout new missions start from, items waiting on the owner and whether the pinned strip shows. catalog:true adds the node catalog: node signatures, bindable paths per record kind (report rows included), which query filters and sorts each kind takes, the action table, limits, the enum values each tone reads and the built-in templates.",
  Schema.Struct({ missionId: MissionId, catalog: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ views: MissionViewsSnapshot, catalog: Schema.NullOr(ViewCatalog) }),
);

const HistoryTool = tool(
  "mission_view_history",
  "Every version of a card template, section, the mission layout or the starter layout, newest first, with who changed it. Pass a version to mission_view_restore, mission_view_layout_restore or mission_view_starter_restore to go back.",
  ViewHistoryInput,
  ViewHistory,
);

const PreviewTool = tool(
  "mission_view_preview",
  "Run the define-time checks on a card template or section without storing anything. Returns every issue (path: code detail), the node count and the encoded size.",
  PreviewViewInput,
  ViewPreview,
);

const TemplateTool = tool(
  "mission_view_template",
  "Owner or master. Define a card template, or update one (same templateId or key; expectedVersion fences concurrent edits). Body nodes come from the catalog and bind record.<path>, field.<key> or derived paths; actions come from the action table for the backing kind. Cards take stat, callout and code nodes too; chart and timeline need rows, so they live in sections. match picks records automatically (most specific wins; an empty match replaces the built-in for its kind). Refused with every issue when a check fails; nothing is stored.",
  DefineViewTemplateInput,
  MissionMutationResult,
);

const SectionTool = tool(
  "mission_view_section",
  'Owner or master. Place a section (query or pinned refs, rows rendered by list, table or collapsible nodes) or update one by sectionId or key. A new section joins the mission layout in region (default main) at index; passing region or index on an update moves it. A collapsible folds one row per item under a header (title, meta) and holds up to 6 child nodes that bind that row. Query kind "report" lists the scribe\'s saved reports newest first (where.reportKind: daily|update); rows bind row.title, row.period, row.size, row.kind, row.coversTo, and row.text (the whole report, longtext) only in a markdown node inside a collapsible, which loads it when opened. Example, latest daily report open: {key:"daily-report", title:"Daily report", source:{_tag:"query", query:{kind:"report", where:{reportKind:["daily"]}, sort:"created-desc", limit:1}}, body:[{_tag:"collapsible", title:"row.title", meta:["row.period","row.size"], open:"first", children:[{_tag:"markdown", bind:"row.text"}]}]}. The last 8 updates: the same with key "updates", reportKind ["update"], limit 8, open "none". Rows also feed stat (one tile per row, or one tile for value row.count or row.total), chart (y a number across rows labelled by x, or a series field drawn per row; last 60 points), timeline (one entry per row: at, title, up to 2 meta, tone) and callout (one note per row, falling back to its label) nodes; tone binds an enum (good/ok/passed, warn/amber, bad/failed/red, info). code shows monospace text folded past 12 lines with a copy button. Example: {_tag:"stat", value:"row.count", label:"Open PRs"}.',
  PlaceViewSectionInput,
  MissionMutationResult,
);

const RemoveTool = tool(
  "mission_view_remove",
  "Owner or master. Remove a card template (its cards fall back to the next match or the built-in) or a section. Removal is logged and can be undone with mission_view_restore.",
  RemoveViewInput,
  MissionMutationResult,
);

const RestoreTool = tool(
  "mission_view_restore",
  "Owner or master. Bring a removed card template or section back, or roll an active one back to toVersion (see mission_view_history).",
  RestoreViewInput,
  MissionMutationResult,
);

const LayoutTool = tool(
  "mission_view_layout",
  "Owner or master. Change the mission layout with ops: hide, show, move (region, index within the region), rename (null title resets), remove, add, replace, limits (templates, sections, daily change budget), set (rebuild) or reset (copy the current starter). Hiding Needs you or Your requests while items wait on the owner moves them to the pinned strip.",
  EditViewLayoutInput,
  MissionMutationResult,
);

const LayoutRestoreTool = tool(
  "mission_view_layout_restore",
  "Owner or master. Roll the mission layout back to an earlier version (see mission_view_history).",
  RestoreViewLayoutInput,
  MissionMutationResult,
);

const StarterTool = tool(
  "mission_view_starter",
  "Owner or any mission's master. Change the recommended starter layout new missions start from (built-in sections and tabs only). Takes effect for missions created afterwards, with no restart; existing missions keep their layout. To offer the new starter to an existing mission, a master calls mission_suggest with targetKind layout, target {kind: view-layout, id: <missionId>} and after: <starter version>; accepting resets that mission's layout to the starter and keeps its own sections.",
  EditStarterLayoutInput,
  MissionMutationResult,
);

const ApplyTool = tool(
  "mission_views_apply",
  "Owner or the mission's master. Define card templates and place sections in one change: all of them or none. copyFrom takes another mission's active templates and sections by key (all of them when no keys are named; sections tied to its own sub-missions, lanes or records are skipped). Counts as one change against the daily budget.",
  ApplyViewBundleInput,
  MissionMutationResult,
);

const AssetAddTool = tool(
  "mission_asset_add",
  "Owner or any agent with a role or lane in the mission. Copy an image (PNG, JPEG, WebP or GIF, up to 10 MiB) into the mission so a card can show it: an attachment of your own thread, or an absolute file path on the server. ref.id of the result is the asset id to put in an assets field, e.g. the screens field of a ui-review ask (templateId builtin:ui-review). The copy stays until the mission is archived.",
  AddMissionAssetInput,
  MissionMutationResult,
);

const AssetRemoveTool = tool(
  "mission_asset_remove",
  "Owner, the mission's master, or the agent that added it. Remove a mission image; cards that bind it stop showing it.",
  RemoveMissionAssetInput,
  MissionMutationResult,
);

const StarterRestoreTool = tool(
  "mission_view_starter_restore",
  "Owner or any mission's master. Roll the starter layout back to an earlier version (see mission_view_history with target starter).",
  RestoreStarterLayoutInput,
  MissionMutationResult,
);

interface ToolConfig {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
}

const annotated = <Name extends string, Config extends ToolConfig, R>(
  tool: Tool.Tool<Name, Config, R>,
  title: string,
  readonly: boolean,
) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, readonly)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, readonly)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

export const ViewsToolkit = Toolkit.make(
  annotated(ViewsTool, "Mission views", true),
  annotated(HistoryTool, "Mission view history", true),
  annotated(PreviewTool, "Preview a mission view", true),
  annotated(TemplateTool, "Define a card template", false),
  annotated(SectionTool, "Place a mission section", false),
  annotated(RemoveTool, "Remove a mission view", false),
  annotated(RestoreTool, "Restore a mission view", false),
  annotated(LayoutTool, "Change the mission layout", false),
  annotated(LayoutRestoreTool, "Restore the mission layout", false),
  annotated(StarterTool, "Change the starter layout", false),
  annotated(StarterRestoreTool, "Restore the starter layout", false),
  annotated(ApplyTool, "Apply a views bundle", false),
  annotated(AssetAddTool, "Add a mission image", false),
  annotated(AssetRemoveTool, "Remove a mission image", false),
);

const REFUSALS: ReadonlySet<MissionError["code"]> = new Set([
  "forbidden",
  "provenance-required",
  "provenance-invalid",
  "locked",
]);

const toolFailure = (error: MissionError) =>
  new OrchestratorMcpFailure({
    code: REFUSALS.has(error.code) ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const withViews = <A>(
  run: (
    views: ViewService["Service"],
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, MissionError>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const views = yield* ViewService;
    return yield* run(views, scope);
  }).pipe(Effect.catchTags({ MissionError: (error) => Effect.fail(toolFailure(error)) }));

const handlers = {
  mission_views: McpToolAccess.reads((input) =>
    withViews((views) =>
      Effect.gen(function* () {
        const snapshot = yield* views.snapshot(input.missionId);
        const catalog = input.catalog === true ? yield* views.catalog : null;
        return { views: snapshot, catalog };
      }),
    ),
  ),
  mission_view_history: McpToolAccess.reads((input) => withViews((views) => views.history(input))),
  mission_view_preview: McpToolAccess.reads((input) => withViews((views) => views.preview(input))),
  mission_view_template: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.defineTemplate(callerProvenance(scope), input)),
  ),
  mission_view_section: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.placeSection(callerProvenance(scope), input)),
  ),
  mission_view_remove: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.remove(callerProvenance(scope), input)),
  ),
  mission_view_restore: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.restore(callerProvenance(scope), input)),
  ),
  mission_view_layout: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.editLayout(callerProvenance(scope), input)),
  ),
  mission_view_layout_restore: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.restoreLayout(callerProvenance(scope), input)),
  ),
  mission_view_starter: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.editStarter(callerProvenance(scope), input)),
  ),
  mission_view_starter_restore: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.restoreStarter(callerProvenance(scope), input)),
  ),
  mission_views_apply: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.applyBundle(callerProvenance(scope), input)),
  ),
  mission_asset_add: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.addAsset(callerProvenance(scope), input)),
  ),
  mission_asset_remove: McpToolAccess.actsAsCaller((input) =>
    withViews((views, scope) => views.removeAsset(callerProvenance(scope), input)),
  ),
} satisfies McpToolAccess.Handlers<typeof ViewsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ViewsToolkit, handlers);
