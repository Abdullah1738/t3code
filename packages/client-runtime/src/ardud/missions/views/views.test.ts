import {
  Approval,
  Ask,
  DEFAULT_STARTER_LAYOUT,
  Draft,
  MissionId,
  RoleId,
  ViewSectionId,
  ViewTemplateId,
  type MissionViewsSnapshot,
  type ViewLayoutDefinition,
  type ViewSection,
  type ViewTemplate,
  type ViewTemplateDefinition,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeViewBody,
  resolveViewLayout,
  resolveViewSnapshotLayout,
  viewCard,
  viewSection,
  viewSectionRequest,
} from "./index.ts";

const T0 = "2026-10-19T08:00:00.000Z";
const NOW = Date.parse("2026-10-19T10:00:00.000Z");
const missionId = MissionId.make("m-1");

const decodeAsk = Schema.decodeUnknownSync(Ask);
const decodeApproval = Schema.decodeUnknownSync(Approval);
const decodeDraft = Schema.decodeUnknownSync(Draft);

const ask = decodeAsk({
  id: "ask-1",
  missionId: "m-1",
  subMissionId: null,
  askedBy: { _tag: "role", roleId: "role-master" },
  question: "Stamp r004 now?",
  context: "Release train leaves Monday.",
  options: [
    { id: "now", label: "Stamp now", detail: "" },
    { id: "hold", label: "Hold", detail: "" },
  ],
  recommendation: { optionId: "hold", reason: "Not needed for Monday." },
  blocks: [{ kind: "work-item", id: "CRP-1", label: "CRP-1 release" }],
  costOfWaiting: "",
  urgency: "normal",
  status: "open",
  answer: null,
  createdAt: T0,
  updatedAt: T0,
});

const approval = decodeApproval({
  id: "ap-1",
  missionId: "m-1",
  kind: "merge",
  title: "Merge risk#124",
  detail: "Two files.",
  requestedBy: "crw",
  links: [{ kind: "pull-request", label: "risk#124", url: null, ref: null }],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: T0,
  summary: "Clean review, CI green.",
  flags: ["touches auth"],
  approver: "master",
});

const draft = decodeDraft({
  id: "dr-1",
  missionId: "m-1",
  audience: "Pavan",
  channel: "github",
  target: { kind: "pull-request", label: "risk#124", url: null, ref: null },
  text: "Please rebase.",
  approvedText: null,
  writerRoleId: "role-master",
  source: { kind: "master", ref: null },
  appliedNoteIds: [],
  status: "pending",
  rewriteNote: null,
  decidedBy: null,
  decidedAt: null,
  sentAt: null,
  createdAt: T0,
  requestedBy: "crw",
});

const meta = {
  version: 1,
  changedBy: { _tag: "role", roleId: RoleId.make("role-master") },
  by: "master",
  changedAt: T0,
  changeNote: null,
  catalogVersion: 1,
  status: "active",
  createdAt: T0,
  createdBy: "master",
} as const;

const template = (
  id: string,
  definition: Partial<ViewTemplateDefinition> & Pick<ViewTemplateDefinition, "backing">,
  status: "active" | "removed" = "active",
): ViewTemplate => ({
  id: ViewTemplateId.make(id),
  missionId,
  definition: { key: id, name: id, body: [], actions: [], ...definition },
  ...meta,
  status,
});

describe("decodeViewBody", () => {
  it("drops unknown, malformed and disallowed nodes one by one", () => {
    const decoded = decodeViewBody(
      [
        { _tag: "text", bind: "record.summary", style: "body", maxLines: 2 },
        { _tag: "audio", bind: "record.assets" },
        { _tag: "text", bind: "record.summary", style: "loud", maxLines: 2 },
        { _tag: "choice" },
        {
          _tag: "group",
          direction: "row",
          children: [{ _tag: "label", text: "Ours" }, { _tag: "video" }],
        },
      ],
      { allows: (tag) => tag !== "choice" },
    );
    expect(decoded.nodes.map((node) => node._tag)).toEqual(["text", "group"]);
    expect(decoded.dropped).toBe(4);
  });

  it("drops nodes nested past the depth limit and groups left empty", () => {
    const deep = {
      _tag: "group",
      direction: "column",
      children: [
        {
          _tag: "group",
          direction: "column",
          children: [
            { _tag: "group", direction: "column", children: [{ _tag: "label", text: "x" }] },
          ],
        },
      ],
    };
    const decoded = decodeViewBody([deep, { _tag: "label", text: "kept" }]);
    expect(decoded.nodes).toEqual([{ _tag: "label", text: "kept" }]);
    expect(decoded.dropped).toBeGreaterThan(0);
  });
});

describe("viewCard", () => {
  it("renders today's cards from the built-ins", () => {
    const card = viewCard({ kind: "ask", record: ask }, [], { nowMs: NOW });
    expect(card.source).toBe("builtin");
    expect(card.kicker).toBe("Decision");
    expect(card.title).toBe("Stamp r004 now?");
    expect(card.madeBy).toBeNull();
    expect(card.blocks.map((block) => block.kind)).toEqual(["text", "choice", "refs"]);
    const choice = card.blocks.find((block) => block.kind === "choice");
    expect(choice?.kind === "choice" && choice.options.find((o) => o.recommended)?.id).toBe("hold");
    expect(card.actions.map((action) => [action.key, action.primary])).toEqual([
      ["answer", true],
      ["comment", false],
      ["discuss", false],
    ]);

    const approvalCard = viewCard({ kind: "approval", record: approval }, [], { nowMs: NOW });
    expect(approvalCard.approver).toBe("master");
    expect(approvalCard.blocks.find((block) => block.kind === "flags")).toEqual({
      kind: "flags",
      flags: ["touches auth"],
    });
  });

  it("picks the most specific matching template, then an explicit one", () => {
    const crwMerge = template("crw-merge", {
      backing: "approval",
      kicker: "Merge",
      match: { approvalKind: ["merge"], requestedBy: ["crw"] },
      body: [{ _tag: "text", bind: "record.summary", style: "body", maxLines: 2 }],
      actions: ["approve", "reject", "discuss", "answer"],
      primary: "approve",
      actionLabels: [{ action: "approve", label: "Merge it" }],
    });
    const anyMerge = template("any-merge", {
      backing: "approval",
      match: { approvalKind: ["merge"] },
      body: [{ _tag: "label", text: "Merge" }],
      actions: ["approve"],
    });
    const card = viewCard({ kind: "approval", record: approval }, [anyMerge, crwMerge], {
      nowMs: NOW,
    });
    expect(card.templateId).toBe("crw-merge");
    expect(card.madeBy).toBe("master");
    expect(card.kicker).toBe("Merge");
    expect(card.title).toBe("Merge risk#124");
    // `answer` is not an approval action: left out.
    expect(card.actions.map((action) => action.label)).toEqual(["Merge it", "Reject", "Discuss"]);

    const pinned = viewCard(
      { kind: "approval", record: { ...approval, view: { templateId: "any-merge" } } as never },
      [anyMerge, crwMerge],
      { nowMs: NOW },
    );
    expect(pinned.source).toBe("explicit");
    expect(pinned.templateId).toBe("any-merge");
  });

  it("falls back to the built-in body when a template body decodes to nothing", () => {
    const broken = template("crw-feedback", {
      backing: "draft",
      match: { channel: ["github"] },
      body: [{ _tag: "hologram" }],
      actions: ["send", "rewrite", "drop"],
    });
    const card = viewCard({ kind: "draft", record: draft }, [broken], { nowMs: NOW });
    expect(card.templateId).toBe("crw-feedback");
    expect(card.dropped).toBe(1);
    const block = card.blocks.find((candidate) => candidate.kind === "draft");
    expect(block).toMatchObject({ kind: "draft", text: "Please rebase.", previousText: null });
    expect(card.actions.find((action) => action.key === "send")?.label).toBe("Approve");
  });

  it("drops malformed field values and inherited keys instead of throwing", () => {
    const fielded = template("fielded", {
      backing: "ask",
      match: {},
      body: [
        { _tag: "text", bind: "field.constructor", style: "body", maxLines: 2 },
        {
          _tag: "facts",
          rows: [
            { label: "Ours", bind: "field.our-side" },
            { label: "Count", bind: "field.count" },
            { label: "Tags", bind: "field.tags" },
          ],
        },
        { _tag: "refs", bind: "record.blocks" },
      ],
      actions: ["answer"],
    });
    const record = {
      ...ask,
      blocks: [{ kind: "work-item", id: "wi-1", label: 7 }],
      view: {
        templateId: null,
        fields: {
          "our-side": { _tag: "short", value: "green" },
          count: { _tag: "number", value: "1" },
          tags: { _tag: "flags", value: "x" },
          empty: null,
        },
      },
    } as never;
    const card = viewCard({ kind: "ask", record }, [fielded], { nowMs: NOW });
    expect(card.blocks).toEqual([{ kind: "facts", rows: [{ label: "Ours", value: "green" }] }]);
  });

  it("never shows who asked an ask", () => {
    const asker = template("asker", {
      backing: "ask",
      match: {},
      body: [
        { _tag: "facts", rows: [{ label: "Asked by", bind: "record.askedBy" }] },
        { _tag: "facts", rows: [{ label: "By", bind: "by" }] },
        { _tag: "facts", rows: [{ label: "Question", bind: "record.question" }] },
      ],
      actions: ["answer"],
    });
    const card = viewCard({ kind: "ask", record: ask }, [asker], { nowMs: NOW });
    expect(card.blocks).toEqual([
      { kind: "facts", rows: [{ label: "Question", value: "Stamp r004 now?" }] },
    ]);
  });

  it("ignores removed templates", () => {
    const removed = template("gone", { backing: "ask", body: [{ _tag: "choice" }] }, "removed");
    expect(viewCard({ kind: "ask", record: ask }, [removed], { nowMs: NOW }).source).toBe(
      "builtin",
    );
  });
});

const section = (id: string, status: "active" | "removed" = "active"): ViewSection => ({
  id: ViewSectionId.make(id),
  missionId,
  definition: {
    key: id,
    title: "Release train",
    source: {
      _tag: "refs",
      refs: [
        { kind: "work-item", id: "CRP-1", label: "Cut r004" },
        { kind: "approval", id: "ap-1" },
      ],
    },
    body: [
      { _tag: "label", text: "Monday" },
      { _tag: "list", title: "row.title", meta: ["row.kind"], status: null },
      { _tag: "choice" },
    ],
  },
  ...meta,
  status,
});

const custom = (key: string, id: string, region: "main" | "rail" = "main") => ({
  key,
  section: { _tag: "custom" as const, sectionId: ViewSectionId.make(id) },
  region,
  hidden: false,
  title: null,
});

const withEntries = (
  entries: ViewLayoutDefinition["entries"],
  base: ViewLayoutDefinition = DEFAULT_STARTER_LAYOUT.layout,
): ViewLayoutDefinition => ({ ...base, entries });

const layoutMeta = { version: 3, by: "owner", changedAt: T0 } as const;

describe("resolveViewLayout", () => {
  it("orders the starter layout into regions, Your requests under Needs you when stacked", () => {
    const resolved = resolveViewLayout(
      missionId,
      DEFAULT_STARTER_LAYOUT.layout,
      [],
      { ownerWaiting: 2, requestsUnread: 0 },
      layoutMeta,
    );
    expect(resolved.header.map((entry) => entry.kind)).toEqual(["header-stats"]);
    expect(resolved.main.map((entry) => entry.title)).toEqual([
      "Your requests",
      "Sub-missions",
      "Since you last looked",
    ]);
    expect(resolved.rail.map((entry) => entry.kind)).toEqual([
      "needs-you",
      "path-to-milestone",
      "with-the-master",
    ]);
    expect(resolved.stacked.slice(0, 2).map((entry) => entry.kind)).toEqual([
      "needs-you",
      "your-requests",
    ]);
    expect(resolved.tabs[0]?.tab).toBe("overview");
    expect(resolved.pinnedStrip).toBe(false);
  });

  it("pins what waits on the owner when Needs you or the overview is hidden", () => {
    const hidden = withEntries(
      DEFAULT_STARTER_LAYOUT.layout.entries.map((entry) =>
        entry.key === "needs-you" || entry.key === "your-requests"
          ? { ...entry, hidden: true }
          : entry,
      ),
    );
    const resolved = resolveViewLayout(
      missionId,
      hidden,
      [],
      { ownerWaiting: 1, requestsUnread: 1 },
      layoutMeta,
    );
    expect(resolved.pinned).toEqual({ needsYou: true, requests: true });
    expect(resolved.setAside.map((entry) => entry.key)).toEqual(["needs-you", "your-requests"]);
    expect(
      resolveViewLayout(missionId, hidden, [], { ownerWaiting: 0, requestsUnread: 0 }, layoutMeta)
        .pinnedStrip,
    ).toBe(false);

    const noOverview = withEntries(
      DEFAULT_STARTER_LAYOUT.layout.entries.map((entry) =>
        entry.key === "tab-overview" ? { ...entry, hidden: true } : entry,
      ),
    );
    const pinned = resolveViewLayout(
      missionId,
      noOverview,
      [],
      { ownerWaiting: 1, requestsUnread: 0 },
      layoutMeta,
    );
    expect(pinned.pinned.needsYou).toBe(true);
    // The overview tab comes back while the strip is pinned.
    expect(pinned.tabs[0]?.tab).toBe("overview");
  });

  it("resolves custom sections and sets aside removed ones and missing built-ins", () => {
    const entries = [
      ...DEFAULT_STARTER_LAYOUT.layout.entries.filter((entry) => entry.key !== "since-last-looked"),
      custom("release", "sec-1"),
      custom("old", "sec-2", "rail"),
    ];
    const resolved = resolveViewLayout(
      missionId,
      withEntries(entries),
      [section("sec-1"), section("sec-2", "removed")],
      { ownerWaiting: 0, requestsUnread: 0 },
      layoutMeta,
    );
    expect(resolved.main.at(-1)).toMatchObject({
      kind: "custom",
      title: "Release train",
      by: "master",
    });
    expect(resolved.setAside.map((entry) => [entry.key, entry.removed])).toEqual([
      ["old", true],
      ["since-last-looked", true],
    ]);
  });
});

describe("viewSection", () => {
  it("renders a refs section's rows and drops nodes sections can't hold", () => {
    const view = viewSection(section("sec-1"), { nowMs: NOW });
    expect(view.dropped).toBe(1);
    expect(view.empty).toBe(false);
    const list = view.blocks.find((block) => block.kind === "list");
    expect(list?.kind === "list" && list.rows.map((row) => [row.title, row.meta])).toEqual([
      ["Cut r004", ["work item"]],
      ["ap-1", ["approval"]],
    ]);
  });
});

describe("viewSectionRequest", () => {
  const snapshot = (entries: ViewLayoutDefinition["entries"], sections: ViewSection[] = []) =>
    ({
      missionId,
      sections,
      layout: {
        missionId,
        layout: withEntries(entries),
        version: 4,
        changedBy: { _tag: "owner" },
        by: "owner",
        changedAt: T0,
        changeNote: null,
        seededFrom: 1,
      },
    }) satisfies Pick<MissionViewsSnapshot, "missionId" | "layout" | "sections">;

  it("turns menu changes into fenced layout ops", () => {
    const base = snapshot(DEFAULT_STARTER_LAYOUT.layout.entries);
    expect(viewSectionRequest(base, "needs-you", { type: "hide" })).toEqual({
      method: "editLayout",
      input: { missionId, ops: [{ _tag: "hide", key: "needs-you" }], expectedVersion: 4 },
    });
    expect(viewSectionRequest(base, "needs-you", { type: "show" })).toBeNull();
    // Move to the top of the main column: before Your requests.
    const move = viewSectionRequest(base, "with-the-master", {
      type: "move",
      region: "main",
      index: 0,
    });
    expect(move?.method === "editLayout" && move.input.ops).toEqual([
      { _tag: "move", key: "with-the-master", region: "main", index: 0 },
    ]);
    // A removed built-in comes back where the starter puts it.
    const without = snapshot(
      DEFAULT_STARTER_LAYOUT.layout.entries.filter((entry) => entry.key !== "with-the-master"),
    );
    const restore = viewSectionRequest(without, "with-the-master", { type: "restore" });
    expect(restore?.method === "editLayout" && restore.input.ops[0]).toMatchObject({
      _tag: "add",
      entry: { key: "with-the-master", region: "rail" },
    });
  });

  it("removes and restores custom sections through their record", () => {
    const live = snapshot([custom("release", "sec-1")], [section("sec-1")]);
    expect(viewSectionRequest(live, "release", { type: "remove" })).toEqual({
      method: "remove",
      input: { missionId, ref: { kind: "view-section", id: "sec-1" }, expectedVersion: 1 },
    });
    const gone = snapshot([custom("release", "sec-1")], [section("sec-1", "removed")]);
    expect(viewSectionRequest(gone, "release", { type: "restore" })).toEqual({
      method: "restore",
      input: { missionId, ref: { kind: "view-section", id: "sec-1" } },
    });
  });

  it("resolves the layout a snapshot carries", () => {
    const resolved = resolveViewSnapshotLayout({
      ...snapshot(DEFAULT_STARTER_LAYOUT.layout.entries),
      ownerWaiting: 0,
      requestsUnread: 0,
    });
    expect(resolved.version).toBe(4);
  });
});
