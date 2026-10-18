import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BUILTIN_VIEW_TEMPLATES,
  DEFAULT_STARTER_LAYOUT,
  selectViewTemplate,
  ViewBind,
  ViewNode,
  ViewStarterLayout,
  ViewTemplate,
  ViewTemplateDefinition,
  viewLayoutPinsStrip,
  viewMatchesOverlap,
  VIEW_ACTIONS,
  viewActionAllowed,
} from "./missionsViews.ts";

const decodeNode = Schema.decodeUnknownExit(ViewNode);
const decodeDefinition = Schema.decodeUnknownExit(ViewTemplateDefinition);
const decodeStarter = Schema.decodeUnknownExit(ViewStarterLayout);
const decodeTemplate = Schema.decodeUnknownSync(ViewTemplate);
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

  it("keeps action labels and kinds in one table", () => {
    expect(VIEW_ACTIONS.send.label).toBe("Approve");
    expect(viewActionAllowed("answer", "approval")).toBe(false);
    expect(viewActionAllowed("discuss", "knock")).toBe(true);
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
});
