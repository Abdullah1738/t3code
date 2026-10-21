import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BUILTIN_VIEW_TEMPLATES,
  DEFAULT_STARTER_LAYOUT,
  selectViewTemplate,
  SetViewSourceInput,
  STOCK_VIEW_TEMPLATES,
  ViewBind,
  ViewNode,
  ViewSectionDefinition,
  ViewSourceDefinition,
  ViewStarterLayout,
  ViewTemplate,
  ViewTemplateDefinition,
  viewLayoutPinsStrip,
  viewPinnedStrip,
  viewMatchesOverlap,
  VIEW_ACTIONS,
  VIEW_CATALOG,
  VIEW_PATHS,
  viewActionAllowed,
} from "./missionsViews.ts";

const decodeNode = Schema.decodeUnknownExit(ViewNode);
const decodeSection = Schema.decodeUnknownExit(ViewSectionDefinition);
const decodeDefinition = Schema.decodeUnknownExit(ViewTemplateDefinition);
const decodeStarter = Schema.decodeUnknownExit(ViewStarterLayout);
const decodeTemplate = Schema.decodeUnknownSync(ViewTemplate);
const decodeSourceDefinition = Schema.decodeUnknownExit(ViewSourceDefinition);
const decodeSetSource = Schema.decodeUnknownExit(SetViewSourceInput);
const isBind = Schema.is(ViewBind);

const template = (id: string, definition: Partial<ViewTemplateDefinition>, status = "active") =>
  decodeTemplate({
    id,
    missionId: "m-1",
    definition: {
      key: id,
      name: id,
      backing: "approval",
      body: [],
      actions: ["approve"],
      ...definition,
    },
    version: 1,
    changedBy: { _tag: "owner" },
    by: "owner",
    changedAt: "2026-10-18T00:00:00.000Z",
    changeNote: null,
    catalogVersion: 1,
    status,
    createdAt: "2026-10-18T00:00:00.000Z",
    createdBy: "owner",
  });

describe("mission views catalog", () => {
  it("ships built-ins that decode and only use allowed actions", () => {
    expect(BUILTIN_VIEW_TEMPLATES.map((builtin) => builtin.id)).toContain("builtin:approval");
    for (const builtin of BUILTIN_VIEW_TEMPLATES) {
      expect(decodeDefinition(builtin.definition)._tag).toBe("Success");
      for (const node of builtin.definition.body) expect(decodeNode(node)._tag).toBe("Success");
      for (const action of builtin.definition.actions) {
        expect(viewActionAllowed(action, builtin.definition.backing)).toBe(true);
      }
    }
  });

  it("decodes the default starter layout", () => {
    expect(decodeStarter(DEFAULT_STARTER_LAYOUT)._tag).toBe("Success");
  });

  it("refuses unknown nodes, deep URLs and over-long groups", () => {
    expect(decodeNode({ _tag: "iframe", src: "https://x" })._tag).toBe("Failure");
    expect(decodeNode({ _tag: "label", text: "x".repeat(61) })._tag).toBe("Failure");
    const leaf = { _tag: "label", text: "a" };
    expect(
      decodeNode({
        _tag: "group",
        direction: "row",
        children: Array.from({ length: 7 }, () => leaf),
      })._tag,
    ).toBe("Failure");
    expect(isBind("field.our-side")).toBe(true);
    expect(isBind("record.links[0].url")).toBe(false);
  });

  it("decodes table, meter and gallery nodes within their limits", () => {
    const column = { label: "PR", bind: "row.pullRequest", as: "link" };
    expect(decodeNode({ _tag: "table", columns: [column] })._tag).toBe("Success");
    expect(
      decodeNode({ _tag: "table", columns: Array.from({ length: 6 }, () => column) })._tag,
    ).toBe("Failure");
    expect(decodeNode({ _tag: "table", columns: [{ ...column, as: "chart" }] })._tag).toBe(
      "Failure",
    );
    expect(decodeNode({ _tag: "meter", value: "row.count", max: "row.total" })._tag).toBe(
      "Success",
    );
    expect(decodeNode({ _tag: "gallery", bind: "field.screens", review: "per-asset" })._tag).toBe(
      "Success",
    );
    expect(decodeNode({ _tag: "gallery", bind: "field.screens", review: "pins" })._tag).toBe(
      "Failure",
    );
  });

  it("keeps action labels and kinds in one table", () => {
    expect(VIEW_ACTIONS.send.label).toBe("Approve");
    expect(viewActionAllowed("answer", "approval")).toBe(false);
    expect(viewActionAllowed("discuss", "knock")).toBe(true);
  });

  it("decodes collapsible containers, markdown and report sections", () => {
    const markdown = { _tag: "markdown", bind: "row.text" };
    const folded = {
      _tag: "collapsible",
      title: "row.title",
      meta: ["row.period", "row.size"],
      open: "first",
      children: [markdown],
    };
    expect(decodeNode(folded)._tag).toBe("Success");
    expect(decodeNode({ ...folded, title: null, label: "Notes" })._tag).toBe("Success");
    expect(
      decodeNode({
        ...folded,
        children: [{ _tag: "group", direction: "row", children: [markdown] }],
      })._tag,
    ).toBe("Success");
    expect(decodeNode({ ...folded, children: [] })._tag).toBe("Failure");
    expect(
      decodeNode({ ...folded, children: Array.from({ length: 7 }, () => markdown) })._tag,
    ).toBe("Failure");
    expect(decodeNode({ ...folded, open: "all" })._tag).toBe("Failure");
    expect(decodeNode({ ...folded, meta: ["row.a", "row.b", "row.c", "row.d"] })._tag).toBe(
      "Failure",
    );
    expect(decodeNode({ ...markdown, maxLines: 41 })._tag).toBe("Failure");
    const section = (where: unknown) =>
      decodeSection({
        key: "updates",
        title: "Updates",
        source: { _tag: "query", query: { kind: "report", where, sort: "created-desc", limit: 8 } },
        body: [folded],
      })._tag;
    expect(section({ reportKind: ["update"] })).toBe("Success");
    expect(section({ reportKind: ["weekly"] })).toBe("Failure");
    expect(VIEW_PATHS.report.text).toBe("longtext");
    expect(VIEW_CATALOG.queries?.filters.reportKind).toEqual(["report"]);
    expect(VIEW_CATALOG.nodes.map((node) => node.tag)).toEqual(
      expect.arrayContaining(["collapsible", "markdown"]),
    );
  });

  it("decodes view sources, source sections and the catalog examples", () => {
    const definition = {
      title: "Open PRs",
      runtime: "bash",
      code: "gh pr list --json number",
      fields: { title: "text", updated: "time" },
      refreshMinutes: 15,
      timeoutSeconds: 30,
      enabled: true,
    };
    expect(decodeSourceDefinition(definition)._tag).toBe("Success");
    expect(decodeSourceDefinition({ ...definition, timeoutSeconds: 61 })._tag).toBe("Failure");
    expect(decodeSourceDefinition({ ...definition, refreshMinutes: 4 })._tag).toBe("Failure");
    expect(decodeSourceDefinition({ ...definition, runtime: "ruby" })._tag).toBe("Failure");
    expect(decodeSourceDefinition({ ...definition, fields: {} })._tag).toBe("Failure");
    expect(decodeSourceDefinition({ ...definition, fields: { burn: "series" } })._tag).toBe(
      "Success",
    );
    expect(decodeSourceDefinition({ ...definition, fields: { title: "bool" } })._tag).toBe(
      "Failure",
    );
    expect(decodeSourceDefinition({ ...definition, code: "x".repeat(20_001) })._tag).toBe(
      "Failure",
    );
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "text"]));
    expect(decodeSourceDefinition({ ...definition, fields: tooMany })._tag).toBe("Failure");
    const section = (source: unknown) =>
      decodeSection({ key: "prs", title: "PRs", source, body: [] })._tag;
    expect(
      section({
        _tag: "source",
        sourceId: "vsrc-1",
        where: { state: ["open", "draft"] },
        sort: { field: "updated", dir: "desc" },
        limit: 10,
      }),
    ).toBe("Success");
    expect(section({ _tag: "source", sourceId: "vsrc-1", limit: 21 })).toBe("Failure");
    for (const example of VIEW_CATALOG.sources?.examples ?? []) {
      expect(decodeSetSource({ missionId: "m-1", ...(example.source as object) })._tag).toBe(
        "Success",
      );
      expect(decodeSection(example.section)._tag).toBe("Success");
    }
    expect(VIEW_CATALOG.sources?.examples).toHaveLength(2);
  });

  it("decodes stat, chart, timeline, callout and code nodes within their limits", () => {
    const stat = { _tag: "stat", value: "row.count", label: "Open PRs" };
    expect(decodeNode(stat)._tag).toBe("Success");
    expect(decodeNode({ ...stat, delta: "row.delta", tone: "row.health", unit: "$" })._tag).toBe(
      "Success",
    );
    expect(decodeNode({ ...stat, label: "A label that runs past the kicker size" })._tag).toBe(
      "Failure",
    );
    expect(decodeNode({ ...stat, unit: "too-long-unit" })._tag).toBe("Failure");
    expect(decodeNode({ _tag: "chart", type: "bar", y: "row.count" })._tag).toBe("Success");
    expect(decodeNode({ _tag: "chart", type: "line", x: "row.day", y: "row.burn" })._tag).toBe(
      "Success",
    );
    expect(decodeNode({ _tag: "chart", type: "pie", y: "row.count" })._tag).toBe("Failure");
    const timeline = { _tag: "timeline", at: "row.at", title: "row.title", meta: ["row.by"] };
    expect(decodeNode(timeline)._tag).toBe("Success");
    expect(decodeNode({ ...timeline, meta: ["row.a", "row.b", "row.c"] })._tag).toBe("Failure");
    expect(
      decodeNode({ _tag: "callout", tone: "warn", text: null, label: "Budget at 4x" })._tag,
    ).toBe("Success");
    expect(decodeNode({ _tag: "callout", tone: "loud", text: "row.note" })._tag).toBe("Failure");
    expect(decodeNode({ _tag: "code", bind: "row.log", label: "Tail" })._tag).toBe("Success");
    expect(decodeNode({ _tag: "code", label: "Tail" })._tag).toBe("Failure");
    expect(VIEW_CATALOG.hardLimits.chartPoints).toBe(60);
    expect(VIEW_CATALOG.tones?.good).toContain("passed");
    expect(VIEW_CATALOG.nodes.map((node) => node.tag)).toEqual(
      expect.arrayContaining(["stat", "chart", "timeline", "callout", "code"]),
    );
  });
});

describe("template selection", () => {
  const crwMerge = template("crw-merge", {
    match: { approvalKind: ["merge"], requestedBy: ["crw"] },
  });
  const anyMerge = template("any-merge", { match: { approvalKind: ["merge"] } });
  const pinned = template("pinned", { match: null });
  const removed = template(
    "old",
    { match: { approvalKind: ["merge"], requestedBy: ["crw"], flag: "x" } },
    "removed",
  );

  it("prefers an explicit id, then the most specific match, then the built-in", () => {
    const templates = [anyMerge, crwMerge, pinned, removed];
    const subject = {
      kind: "approval" as const,
      approvalKind: "merge",
      requestedBy: "crw",
      flags: ["x"],
    };
    expect(selectViewTemplate({ ...subject, templateId: "pinned" }, templates).id).toBe("pinned");
    expect(selectViewTemplate(subject, templates).id).toBe("crw-merge");
    expect(selectViewTemplate({ ...subject, requestedBy: "astra" }, templates).id).toBe(
      "any-merge",
    );
    const deploy = selectViewTemplate({ ...subject, approvalKind: "deploy" }, templates);
    expect(deploy.source).toBe("builtin");
    expect(deploy.id).toBe("builtin:approval");
  });

  it("falls back when an explicit template is removed", () => {
    expect(
      selectViewTemplate({ kind: "approval", templateId: "old", approvalKind: "deploy" }, [removed])
        .source,
    ).toBe("builtin");
  });

  it("draws release approvals and named UI reviews from the stock templates", () => {
    for (const stock of STOCK_VIEW_TEMPLATES) {
      expect(decodeDefinition(stock.definition)._tag).toBe("Success");
      for (const node of stock.definition.body) expect(decodeNode(node)._tag).toBe("Success");
    }
    const release = selectViewTemplate({ kind: "approval", approvalKind: "release" }, []);
    expect([release.source, release.id]).toEqual(["match", "builtin:release"]);
    expect(selectViewTemplate({ kind: "approval", approvalKind: "deploy" }, []).id).toBe(
      "builtin:approval",
    );
    const review = selectViewTemplate({ kind: "ask", templateId: "builtin:ui-review" }, []);
    expect([review.source, review.definition.key]).toEqual(["explicit", "ui-review"]);
    // A stored template with the stock key replaces it, for matches and names alike.
    const own = template("own-release", { key: "release", match: { approvalKind: ["release"] } });
    expect(selectViewTemplate({ kind: "approval", approvalKind: "release" }, [own]).id).toBe(
      "own-release",
    );
    const ownReview = template("own-review", { key: "ui-review", backing: "ask", actions: [] });
    expect(
      selectViewTemplate({ kind: "ask", templateId: "builtin:ui-review" }, [ownReview]).id,
    ).toBe("own-review");
  });

  it("detects overlapping matches", () => {
    expect(viewMatchesOverlap({ channel: ["github"] }, { channel: ["github", "linear"] })).toBe(
      true,
    );
    expect(viewMatchesOverlap({ channel: ["github"] }, { channel: ["linear"] })).toBe(false);
    expect(viewMatchesOverlap({ requestedBy: ["crw"] }, { channel: ["linear"] })).toBe(true);
  });
});

describe("pinned strip", () => {
  const layout = DEFAULT_STARTER_LAYOUT.layout;
  const hidden = {
    ...layout,
    entries: layout.entries.map((entry) =>
      entry.key === "needs-you" ? { ...entry, hidden: true } : entry,
    ),
  };
  it("pins only when Needs you is off the overview and the owner has items waiting", () => {
    expect(viewLayoutPinsStrip(layout, 3)).toBe(false);
    expect(viewLayoutPinsStrip(hidden, 0)).toBe(false);
    expect(viewLayoutPinsStrip(hidden, 2)).toBe(true);
  });

  it("pins unread answered requests only when Your requests is off the overview", () => {
    const keys = layout.entries.map((entry) => entry.key);
    expect(keys.indexOf("your-requests")).toBe(keys.indexOf("needs-you") + 1);
    expect(layout.entries.find((entry) => entry.key === "your-requests")?.region).toBe("main");
    expect(viewPinnedStrip(layout, { ownerWaiting: 2, requestsUnread: 2 })).toEqual({
      needsYou: false,
      requests: false,
    });
    const noRequests = {
      ...layout,
      entries: layout.entries.map((entry) =>
        entry.key === "your-requests" ? { ...entry, hidden: true } : entry,
      ),
    };
    expect(viewPinnedStrip(noRequests, { ownerWaiting: 0, requestsUnread: 0 }).requests).toBe(
      false,
    );
    expect(viewPinnedStrip(noRequests, { ownerWaiting: 0, requestsUnread: 1 })).toEqual({
      needsYou: false,
      requests: true,
    });
  });
});
