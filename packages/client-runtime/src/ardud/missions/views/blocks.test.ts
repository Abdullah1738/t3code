import {
  Approval,
  Ask,
  Draft,
  MissionId,
  RoleId,
  ViewDataSourceId,
  ViewSectionId,
  type AnswerAskInput,
  type AskId,
  type MissionAsset,
  type ViewSection,
  type ViewSectionDefinition,
  type ViewSourceListing,
  type ViewSourceRun,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { formatDayLabel, formatTimeOfDay } from "../viewModel.ts";
import {
  assetFeedback,
  createViewLongTexts,
  markAsset,
  viewCard,
  viewSection,
  viewLongTextKey,
  viewSectionData,
  viewSectionSource,
  viewSourceNotice,
  withAssetFeedback,
  type ViewBlock,
  type ViewSectionSource,
  // --- blocks additions ---
  viewChartLabels,
  viewChartScale,
  // --- end blocks additions ---
  viewChartFraction,
} from "./index.ts";

const decodeAsk = Schema.decodeUnknownSync(Ask);
const decodeApproval = Schema.decodeUnknownSync(Approval);
const decodeDraft = Schema.decodeUnknownSync(Draft);

const T0 = "2026-10-19T08:00:00.000Z";
const NOW = Date.parse("2026-10-19T10:00:00.000Z");
const missionId = MissionId.make("m-1");
const SHOT_A = "mission-00000000-0000-4000-8000-00000000000a";
const SHOT_B = "mission-00000000-0000-4000-8000-00000000000b";
const SHOT_GONE = "mission-00000000-0000-4000-8000-00000000000c";

const asset = (id: string, name: string): MissionAsset =>
  ({
    id,
    missionId,
    subject: null,
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 10,
    width: 1280,
    height: 800,
    name,
    sha256: "x",
    addedBy: { _tag: "role", roleId: RoleId.make("role-writer") },
    status: "active",
    version: 1,
    createdAt: T0,
    changedAt: T0,
  }) as MissionAsset;

const ASSETS = [asset(SHOT_A, "home.png"), asset(SHOT_B, "settings.png")];

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

const section = (id: string, definition: Omit<ViewSectionDefinition, "key">): ViewSection => ({
  id: ViewSectionId.make(id),
  missionId,
  definition: { key: id, ...definition },
  ...meta,
});

const kinds = (blocks: ReadonlyArray<ViewBlock>) => blocks.map((block) => block.kind);

describe("section rows from the server", () => {
  const queue = section("sec-q", {
    title: "Review queue",
    source: {
      _tag: "query",
      query: { kind: "work-item", where: { workKind: ["pr"] }, sort: "updated-desc", limit: 10 },
    },
    body: [
      {
        _tag: "table",
        columns: [
          { label: "PR", bind: "row.pullRequest", as: "text" },
          { label: "Stage", bind: "row.stage", as: "status" },
          { label: "Held by", bind: "row.heldBy", as: "person" },
          { label: "Age", bind: "row.age", as: "age" },
          { label: "Links", bind: "row.links", as: "count" },
        ],
      },
      { _tag: "meter", value: "row.count", max: "row.total" },
    ],
  });
  const data = {
    sectionId: ViewSectionId.make("sec-q"),
    total: 4,
    rows: [
      {
        ref: { kind: "work-item" as const, id: "wi-1", label: "risk#124" },
        value: {
          pullRequest: { repository: "risk", number: 124 },
          stage: "merge-ready",
          heldBy: { _tag: "owner" },
          createdAt: T0,
          links: [{ kind: "url", label: "a", url: null, ref: null }],
        },
      },
      {
        ref: { kind: "work-item" as const, id: "wi-2" },
        value: { stage: "review", links: [] },
      },
    ],
  };

  it("renders tables and meters over the rows the snapshot carries", () => {
    const view = viewSection(queue, {
      nowMs: NOW,
      data: viewSectionData({ sectionData: [data] }, "sec-q"),
    });
    expect(view.empty).toBe(false);
    expect(kinds(view.blocks)).toEqual(["table", "meter"]);
    const table = view.blocks[0];
    expect(table?.kind === "table" && table.columns.map((column) => column.label)).toEqual([
      "PR",
      "Stage",
      "Held by",
      "Age",
      "Links",
    ]);
    expect(
      table?.kind === "table" && table.rows.map((row) => row.cells.map((cell) => cell.text)),
    ).toEqual([
      ["risk#124", "merge ready", "you", "2h ago", "1"],
      [null, "review", null, null, "0"],
    ]);
    // Two rows shown out of four matched.
    expect(view.blocks[1]).toEqual({ kind: "meter", value: 2, max: 4 });
  });

  it("hides a query section the server has no rows for", () => {
    expect(viewSection(queue, { nowMs: NOW }).empty).toBe(true);
    const none = { ...data, rows: [], total: 0 };
    expect(viewSection(queue, { nowMs: NOW, data: none }).empty).toBe(true);
  });
});

describe("script source sections", () => {
  const sourceId = ViewDataSourceId.make("src-ci");
  const builds = section("sec-s", {
    title: "Builds",
    source: { _tag: "source", sourceId, limit: 10 },
    body: [
      {
        _tag: "table",
        columns: [
          { label: "Job", bind: "row.id", as: "text" },
          { label: "Result", bind: "row.result", as: "status" },
          { label: "By", bind: "row.by", as: "person" },
          { label: "Took", bind: "row.secs", as: "text" },
          { label: "Finished", bind: "row.at", as: "age" },
        ],
      },
      { _tag: "table", columns: [{ label: "Stage", bind: "row.stage", as: "text" }] },
      { _tag: "meter", value: "row.count", max: "row.total" },
    ],
  });
  const listing: ViewSourceListing = {
    id: sourceId,
    missionId,
    title: "CI builds",
    runtime: "bash",
    fields: { result: "enum", by: "actor", secs: "number", at: "time" },
    refreshMinutes: 15,
    timeoutSeconds: 30,
    enabled: true,
    ...meta,
  };
  const run: ViewSourceRun = {
    sourceId,
    okAt: "2026-10-19T09:30:00.000Z",
    rows: 3,
    ranAt: "2026-10-19T09:30:00.000Z",
    durationMs: 800,
    error: null,
    running: false,
  };
  const data = {
    sectionId: ViewSectionId.make("sec-s"),
    total: 3,
    rows: [
      {
        ref: { kind: "source-row" as const, id: "b-7" },
        value: {
          id: "b-7",
          result: "failed",
          by: { _tag: "person", name: "pavan" },
          secs: 42,
          at: T0,
          stage: "build",
        },
      },
      { ref: { kind: "source-row" as const, id: "b-6" }, value: { id: "b-6", result: true } },
    ],
  };
  const cells = (block: ViewBlock | undefined) =>
    block?.kind === "table" ? block.rows.map((row) => row.cells.map((cell) => cell.text)) : null;

  it("binds rows through the source's declared field kinds", () => {
    const view = viewSection(builds, {
      nowMs: NOW,
      data: viewSectionData({ sectionData: [data] }, "sec-s"),
      source: viewSectionSource({ sources: [listing], sourceRuns: [run] }, builds),
    });
    expect(view.empty).toBe(false);
    expect(view.notice).toBeNull();
    expect(cells(view.blocks[0])).toEqual([
      ["b-7", "failed", "pavan", "42", "2h ago"],
      ["b-6", "yes", null, null, null],
    ]);
    // `stage` isn't declared, so its table has nothing to show even though rows carry it.
    expect(kinds(view.blocks)).toEqual(["table", "meter"]);
    expect(view.blocks[1]).toEqual({ kind: "meter", value: 2, max: 3 });
  });

  it("shows no rows without the source listing", () => {
    expect(viewSection(builds, { nowMs: NOW, data }).empty).toBe(true);
    expect(viewSectionSource({ sources: [], sourceRuns: [] }, builds)).toBeNull();
    const refs = section("sec-r", {
      ...builds.definition,
      source: { _tag: "refs", refs: [{ kind: "work-item", id: "wi-1" }] },
    });
    expect(viewSectionSource({ sources: [listing] }, refs)).toBeNull();
  });

  it("says when the source is off or its last run failed", () => {
    const notice = (next: ViewSectionSource, nowMs = NOW) => viewSourceNotice(next, nowMs);
    expect(notice({ listing: { ...listing, enabled: false }, run })).toBe("Source off");
    expect(notice({ listing: { ...listing, status: "removed" }, run })).toBe("Source off");
    expect(notice({ listing, run: null })).toBeNull();
    const failed = { ...run, ranAt: "2026-10-19T09:45:00.000Z", error: "exit 1" };
    expect(notice({ listing, run: failed })).toBe(
      `Couldn't refresh, showing ${formatTimeOfDay(run.okAt ?? "")} rows`,
    );
    expect(notice({ listing, run: failed }, NOW + 2 * 24 * 60 * 60 * 1000)).toBe(
      `Couldn't refresh, showing ${formatDayLabel(run.okAt ?? "")} rows`,
    );
    expect(notice({ listing, run: { ...failed, okAt: null } })).toBe("Couldn't refresh");
  });

  it("keeps a section with a notice even when no rows show", () => {
    const view = viewSection(builds, {
      nowMs: NOW,
      source: { listing: { ...listing, enabled: false }, run },
    });
    expect(view.empty).toBe(false);
    expect(view.notice).toBe("Source off");
  });
});

describe("report sections", () => {
  const reports = section("sec-r", {
    title: "Updates",
    source: {
      _tag: "query",
      query: { kind: "report", where: { reportKind: ["update"] }, sort: "created-desc", limit: 8 },
    },
    body: [
      {
        _tag: "collapsible",
        title: "row.title",
        meta: ["row.period", "row.size"],
        open: "first",
        children: [
          { _tag: "markdown", bind: "row.text" },
          // A list can't fold inside a row; it is dropped, the rest stays.
          { _tag: "list", title: "row.title", meta: [], status: null },
        ],
      },
    ],
  });
  const row = (id: string, title: string) => ({
    ref: { kind: "report" as const, id, label: title },
    value: { title, period: "21 Oct 00:00–04:00 UTC", size: "22k chars" },
  });
  const data = {
    sectionId: ViewSectionId.make("sec-r"),
    total: 9,
    rows: [row("crpko|update|b", "04:00 update"), row("crpko|update|a", "00:00 update")],
  };

  it("folds each report under its header and loads the text only from its source", () => {
    const view = viewSection(reports, { nowMs: NOW, data });
    expect(view.dropped).toBe(1);
    expect(view.blocks).toEqual([
      {
        kind: "collapsible",
        open: "first",
        items: ["crpko|update|b", "crpko|update|a"].map((id, index) => ({
          key: `report:${id}`,
          title: index === 0 ? "04:00 update" : "00:00 update",
          meta: ["21 Oct 00:00–04:00 UTC", "22k chars"],
          children: [
            {
              kind: "markdown",
              text: null,
              maxLines: null,
              source: { missionId, ref: data.rows[index]?.ref, path: "text" },
            },
          ],
        })),
      },
    ]);
  });

  it("drops a markdown block whose short text is empty and keeps a card's fold", () => {
    const notes = section("sec-n", {
      title: "Notes",
      source: { _tag: "query", query: { kind: "note", sort: "created-desc", limit: 5 } },
      body: [
        {
          _tag: "collapsible",
          title: null,
          label: "Details",
          meta: [],
          open: "none",
          children: [{ _tag: "markdown", bind: "row.summary", maxLines: 4 }],
        },
      ],
    });
    const view = viewSection(notes, {
      nowMs: NOW,
      data: {
        sectionId: ViewSectionId.make("sec-n"),
        total: 2,
        rows: [
          { ref: { kind: "note", id: "n-1" }, value: { summary: "**Bold** call" } },
          { ref: { kind: "note", id: "n-2" }, value: { summary: "  " } },
        ],
      },
    });
    expect(view.blocks).toEqual([
      {
        kind: "collapsible",
        open: "none",
        items: [
          {
            key: "note:n-1",
            title: "Details",
            meta: [],
            children: [{ kind: "markdown", text: "**Bold** call", source: null, maxLines: 4 }],
          },
        ],
      },
    ]);
  });
});

describe("long texts", () => {
  const input = (id: string) => ({
    missionId,
    ref: { kind: "report" as const, id },
    path: "text",
  });
  const answer = (id: string) => ({
    ref: { kind: "report" as const, id },
    path: "text",
    text: `# ${id}`,
    size: id.length + 2,
    truncated: false,
  });
  // The store's own handlers attach first, so these settle after its state moved.
  const pending: Array<Promise<unknown>> = [];
  const settled = () => Promise.allSettled(pending);

  it("asks the server once per text, keeps the newest few and retries a failure on request", async () => {
    const asked: Array<string> = [];
    let failNext = true;
    const texts = createViewLongTexts((request) => {
      asked.push(request.ref.id);
      const reply =
        request.ref.id === "flaky" && failNext
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(answer(request.ref.id));
      if (request.ref.id === "flaky") failNext = false;
      pending.push(reply);
      return reply;
    }, 2);
    let changes = 0;
    texts.subscribe(() => (changes += 1));
    const state = (id: string) => texts.get(viewLongTextKey(input(id)));

    texts.request(input("a"));
    texts.request(input("a"));
    expect(state("a")).toEqual({ status: "loading" });
    await settled();
    expect(state("a")).toEqual({ status: "loaded", value: answer("a") });
    texts.request(input("b"));
    texts.request(input("c"));
    await settled();
    expect(state("a")).toBeUndefined();
    expect(state("c")).toEqual({ status: "loaded", value: answer("c") });

    texts.request(input("flaky"));
    await settled();
    expect(state("flaky")?.status).toBe("failed");
    texts.request(input("flaky"));
    expect(state("flaky")?.status).toBe("failed");
    texts.request(input("flaky"), { retry: true });
    await settled();
    expect(state("flaky")).toEqual({ status: "loaded", value: answer("flaky") });
    expect(asked).toEqual(["a", "b", "c", "flaky", "flaky"]);
    expect(changes).toBe(10);
  });
});

describe("stock templates", () => {
  const ask = decodeAsk({
    id: "ask-ui",
    missionId: "m-1",
    subMissionId: null,
    askedBy: { _tag: "role", roleId: "role-writer" },
    question: "Does the new board read right?",
    context: "Desk restyle of the mission board.",
    options: [
      { id: "right", label: "Looks right", detail: "" },
      { id: "change", label: "Needs changes", detail: "" },
    ],
    recommendation: null,
    blocks: [],
    costOfWaiting: "",
    urgency: "normal",
    status: "open",
    answer: null,
    createdAt: T0,
    updatedAt: T0,
    view: {
      templateId: "builtin:ui-review",
      fields: {
        screens: { _tag: "assets", value: [SHOT_A, SHOT_GONE, SHOT_B] },
        where: {
          _tag: "links",
          value: [{ kind: "url", label: "Preview", url: "https://x", ref: null }],
        },
      },
    },
  });

  it("shows a UI review's screens for per-image marks, leaving out images that are gone", () => {
    const card = viewCard({ kind: "ask", record: ask }, [], { nowMs: NOW, assets: ASSETS });
    expect(card.templateId).toBe("builtin:ui-review");
    expect(card.kicker).toBe("UI review");
    expect(kinds(card.blocks)).toEqual(["text", "gallery", "choice", "links"]);
    const gallery = card.blocks[1];
    expect(gallery?.kind === "gallery" && gallery.review).toBe(true);
    expect(gallery?.kind === "gallery" && gallery.assets.map((shot) => shot.name)).toEqual([
      "home.png",
      "settings.png",
    ]);
    // Answered asks show the screens without marks.
    const answered = viewCard({ kind: "ask", record: { ...ask, status: "answered" } }, [], {
      nowMs: NOW,
      assets: ASSETS,
    });
    const shown = answered.blocks.find((block) => block.kind === "gallery");
    expect(shown?.kind === "gallery" && shown.review).toBe(false);
  });

  it("draws release approvals with their version, environment and PRs", () => {
    const approval = decodeApproval({
      id: "ap-r",
      missionId: "m-1",
      kind: "release",
      title: "Release r004",
      detail: "",
      requestedBy: "crw",
      links: [],
      status: "pending",
      staleReason: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: T0,
      view: {
        templateId: null,
        fields: {
          version: { _tag: "short", value: "r004" },
          env: { _tag: "short", value: "prod" },
          changes: { _tag: "text", value: "Fees fix and the new board." },
        },
      },
    });
    const card = viewCard({ kind: "approval", record: approval }, [], { nowMs: NOW });
    expect(card.templateId).toBe("builtin:release");
    expect(card.blocks[0]).toEqual({
      kind: "facts",
      rows: [
        { label: "Version", value: "r004" },
        { label: "Environment", value: "prod" },
      ],
    });
    expect(card.actions.map((action) => action.key)).toEqual(["approve", "reject", "discuss"]);
  });
});

describe("withdrawn drafts", () => {
  it("show the master's withdraw note", () => {
    const draft = decodeDraft({
      id: "dr-w",
      missionId: "m-1",
      audience: "Pavan",
      channel: "github",
      target: { kind: "pull-request", label: "risk#124", url: null, ref: null },
      text: "Please rebase.",
      approvedText: null,
      writerRoleId: "role-master",
      source: { kind: "master", ref: null },
      appliedNoteIds: [],
      status: "dropped",
      rewriteNote: null,
      decidedBy: null,
      decidedAt: null,
      sentAt: null,
      createdAt: T0,
      withdrawNote: "Pavan already rebased.",
    });
    const card = viewCard({ kind: "draft", record: draft }, [], { nowMs: NOW });
    expect(card.blocks.at(-1)).toEqual({
      kind: "text",
      text: "Pavan already rebased.",
      tone: "meta",
      maxLines: 2,
    });
  });
});

describe("per-image review", () => {
  it("sends every mark with the answer, readable in the room", () => {
    let review = markAsset({}, SHOT_A, { verdict: "ok" });
    review = markAsset(review, SHOT_B, {
      verdict: "change",
      note: "Logo too big",
      pin: { x: 0.4, y: 1.3 },
    });
    review = markAsset(review, SHOT_GONE, { verdict: "ok" });
    // Clearing a mark drops it.
    review = markAsset(review, SHOT_GONE, { verdict: null });
    expect(Object.keys(review)).toEqual([SHOT_A, SHOT_B]);

    const shots = [
      { id: SHOT_A, name: "home.png" },
      { id: SHOT_B, name: "settings.png" },
    ];
    expect(assetFeedback(review, shots).map((item) => [item.verdict, item.pin])).toEqual([
      ["ok", null],
      ["change", { x: 0.4, y: 1 }],
    ]);
    const input = { askId: "ask-ui" as AskId, optionId: "change", text: "Close" } as AnswerAskInput;
    const answer = withAssetFeedback(input, review, shots);
    expect(answer.feedback).toHaveLength(2);
    expect(answer.text).toBe(
      "Close\n\nhome.png: looks right\nsettings.png: change. Logo too big (at 40%, 100%)",
    );
    expect(withAssetFeedback(input, {}, shots)).toBe(input);
  });
});

describe("stat, chart, timeline, callout and code blocks", () => {
  const notes = section("sec-notes", {
    title: "Findings",
    source: { _tag: "query", query: { kind: "note", sort: "created-desc", limit: 5 } },
    body: [
      { _tag: "stat", value: "row.count", label: "Findings" },
      { _tag: "chart", type: "line", x: "row.createdAt", y: "row.confidence" },
      {
        _tag: "timeline",
        at: "row.createdAt",
        title: "row.summary",
        meta: ["row.type"],
        tone: "row.severity",
      },
      { _tag: "callout", tone: "warn", text: "row.summary", label: "Nothing flagged" },
    ],
  });
  const note = (id: string, summary: string, severity: string, confidence: number) => ({
    ref: { kind: "note" as const, id },
    value: { summary, severity, confidence, type: "risk", createdAt: T0 },
  });

  it("draws one tile for the section, a point and an entry per row", () => {
    const view = viewSection(notes, {
      nowMs: NOW,
      data: {
        sectionId: ViewSectionId.make("sec-notes"),
        total: 7,
        rows: [note("n-1", "Lock contention", "critical", 0.8), note("n-2", "Slow CI", "low", 0.5)],
      },
    });
    expect(view.blocks).toEqual([
      {
        kind: "stat",
        label: "Findings",
        tiles: [{ key: "one", value: "2", prefix: null, suffix: null, delta: null, tone: null }],
      },
      {
        kind: "chart",
        type: "line",
        charts: [
          {
            key: "rows",
            title: null,
            points: [
              { label: "2h ago", value: 0.8 },
              { label: "2h ago", value: 0.5 },
            ],
          },
        ],
      },
      {
        kind: "timeline",
        entries: [
          {
            key: "note:n-1",
            at: "2h ago",
            title: "Lock contention",
            meta: ["risk"],
            tone: "bad",
            ref: { kind: "note", id: "n-1" },
          },
          {
            key: "note:n-2",
            at: "2h ago",
            title: "Slow CI",
            meta: ["risk"],
            tone: null,
            ref: { kind: "note", id: "n-2" },
          },
        ],
      },
      { kind: "callout", tone: "warn", texts: ["Lock contention", "Slow CI"] },
    ]);
  });

  it("falls back to a callout's label and hides row blocks with no rows", () => {
    const view = viewSection(notes, {
      nowMs: NOW,
      data: { sectionId: ViewSectionId.make("sec-notes"), total: 0, rows: [] },
    });
    expect(view.blocks).toEqual([
      {
        kind: "stat",
        label: "Findings",
        tiles: [{ key: "one", value: "0", prefix: null, suffix: null, delta: null, tone: null }],
      },
      { kind: "callout", tone: "warn", texts: ["Nothing flagged"] },
    ]);
  });

  it("compacts big numbers, signs deltas and reads tones from enum values", () => {
    const spend = section("sec-spend", {
      title: "Spend",
      source: { _tag: "query", query: { kind: "sub-mission", sort: "rank", limit: 5 } },
      body: [
        {
          _tag: "stat",
          value: "row.order",
          label: "Spend",
          delta: "row.order",
          tone: "row.health",
          unit: "$",
        },
        { _tag: "stat", value: "row.order", label: "Tokens", unit: "tok" },
      ],
    });
    const view = viewSection(spend, {
      nowMs: NOW,
      data: {
        sectionId: ViewSectionId.make("sec-spend"),
        total: 2,
        rows: [
          { ref: { kind: "sub-mission", id: "s-1" }, value: { order: 1400, health: "amber" } },
          { ref: { kind: "sub-mission", id: "s-2" }, value: { order: 12, health: "unknown" } },
        ],
      },
    });
    expect(view.blocks).toEqual([
      {
        kind: "stat",
        label: "Spend",
        tiles: [
          {
            key: "sub-mission:s-1",
            value: "1.4k",
            prefix: "$",
            suffix: null,
            delta: "+1.4k",
            tone: "warn",
          },
          {
            key: "sub-mission:s-2",
            value: "12",
            prefix: "$",
            suffix: null,
            delta: "+12",
            tone: null,
          },
        ],
      },
      {
        kind: "stat",
        label: "Tokens",
        tiles: [
          {
            key: "sub-mission:s-1",
            value: "1.4k",
            prefix: null,
            suffix: "tok",
            delta: null,
            tone: null,
          },
          {
            key: "sub-mission:s-2",
            value: "12",
            prefix: null,
            suffix: "tok",
            delta: null,
            tone: null,
          },
        ],
      },
    ]);
  });

  it("shows code and long code from their sources", () => {
    const reports = section("sec-logs", {
      title: "Logs",
      source: { _tag: "query", query: { kind: "report", sort: "created-desc", limit: 2 } },
      body: [
        {
          _tag: "collapsible",
          title: "row.title",
          meta: [],
          open: "none",
          children: [
            { _tag: "code", bind: "row.text", label: "Tail" },
            { _tag: "code", bind: "row.title" },
          ],
        },
      ],
    });
    const ref = { kind: "report" as const, id: "crpko|update|a" };
    const view = viewSection(reports, {
      nowMs: NOW,
      data: {
        sectionId: ViewSectionId.make("sec-logs"),
        total: 1,
        rows: [{ ref, value: { title: "panic: nil map" } }],
      },
    });
    expect(view.blocks).toEqual([
      {
        kind: "collapsible",
        open: "none",
        items: [
          {
            key: "report:crpko|update|a",
            title: "panic: nil map",
            meta: [],
            children: [
              { kind: "code", label: "Tail", text: null, source: { missionId, ref, path: "text" } },
              { kind: "code", label: null, text: "panic: nil map", source: null },
            ],
          },
        ],
      },
    ]);
  });
});

// --- blocks additions ---
describe("chart axes", () => {
  const points = (values: ReadonlyArray<number>) =>
    values.map((value, index) => ({ label: `d${index + 1}`, value }));
  const ticks = (values: ReadonlyArray<number>) =>
    viewChartScale(points(values)).ticks.map((tick) => tick.label);

  it("steps the y axis in round numbers from zero past the top value", () => {
    expect(ticks([3, 7, 12])).toEqual(["0", "5", "10", "15"]);
    expect(ticks([-4, 6])).toEqual(["-5", "0", "5", "10"]);
    expect(ticks([1400, 2600])).toEqual(["0", "1k", "2k", "3k"]);
    expect(ticks([0.25, 0.8])).toEqual(["0", "0.5", "1"]);
    expect(ticks([])).toEqual(["0", "0.5"]);
  });

  it("keeps a finite scale for values whose rounded bounds overflow", () => {
    for (const values of [
      [Number.MAX_VALUE],
      [-Number.MAX_VALUE],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
      [1, Number.MAX_VALUE],
      [Number.MIN_VALUE],
    ]) {
      const scale = viewChartScale(points(values));
      expect(Number.isFinite(scale.min) && Number.isFinite(scale.max)).toBe(true);
      expect(scale.max).toBeGreaterThan(scale.min);
      expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
      expect(scale.ticks.length).toBeLessThanOrEqual(6);
      expect(scale.ticks.every((tick) => Number.isFinite(tick.value))).toBe(true);
      for (const value of [...values, 0]) {
        const fraction = viewChartFraction(scale, value);
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
      }
    }
    const widest = viewChartScale(points([-Number.MAX_VALUE, Number.MAX_VALUE]));
    expect(viewChartFraction(widest, 0)).toBe(0.5);
  });

  it("labels the first, last and evenly spaced points between", () => {
    const ten = points([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(viewChartLabels(ten).map((tick) => tick.label)).toEqual(["d1", "d4", "d7", "d10"]);
    expect(viewChartLabels(ten.slice(0, 2)).map((tick) => tick.index)).toEqual([0, 1]);
    const unnamed = ten.map((point, index) => (index === 3 ? { ...point, label: null } : point));
    expect(viewChartLabels(unnamed).map((tick) => tick.index)).toEqual([0, 6, 9]);
  });
});
// --- end blocks additions ---
