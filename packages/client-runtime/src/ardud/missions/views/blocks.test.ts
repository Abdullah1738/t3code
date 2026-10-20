import {
  Approval,
  Ask,
  Draft,
  MissionId,
  RoleId,
  ViewSectionId,
  type AnswerAskInput,
  type AskId,
  type MissionAsset,
  type ViewSection,
  type ViewSectionDefinition,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  assetFeedback,
  markAsset,
  viewCard,
  viewSection,
  viewSectionData,
  withAssetFeedback,
  type ViewBlock,
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
