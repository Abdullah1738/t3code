import { describe, expect, it } from "vite-plus/test";
import { KanbanBoard, KanbanCard } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import shape from "../../../../../scripts/overload-harness/shape.json" with { type: "json" };
import { boardShapes, syntheticCards } from "./overloadShape.ts";

const decodeCard = Schema.decodeUnknownSync(KanbanCard);
const board = Schema.decodeUnknownSync(KanbanBoard)({
  id: "load-board-0",
  slug: "load-0",
  name: "Load",
  defaultProjectId: null,
  managerModel: { instanceId: "opencode", model: "opus/cx/gpt-6.1-sol" },
  evaluatorModel: { instanceId: "opencode", model: "opus/cx/gpt-6.1-sol" },
  defaultCardModel: { instanceId: "opencode", model: "opus/cx/gpt-6.1-sol" },
  reviewChains: [],
  defaultReviewChain: null,
  instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
  createdAt: "2026-11-13T00:00:00.000Z",
  archivedAt: null,
});

describe("synthetic overload shape", () => {
  it("keeps the prescribed cardinalities and exact open/settled split", () => {
    const specs = boardShapes();
    expect(specs).toHaveLength(17);
    expect(specs.reduce((sum, board) => sum + board.poolSlots, 0)).toBe(67);
    expect(specs[0]).toMatchObject({ cards: 4290, open: 3900, settled: 390, discussions: 3224 });
    expect(specs[1]?.cards).toBe(1320);
    const rows = syntheticCards(board, 0, 1794528000000);
    expect(rows).toHaveLength(shape.syntheticLoad.largeBoards[0]!.cards);
    expect(rows.filter((row) => row.settledAt === null)).toHaveLength(3900);
    expect(rows.filter((row) => row.settledAt !== null)).toHaveLength(390);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of [rows[0]!, rows[2000]!, rows.at(-1)!])
      expect(() => decodeCard(row)).not.toThrow();
    const bytes = rows.map((row) => JSON.stringify(row).length).sort((a, b) => a - b);
    expect(
      Math.abs(bytes[Math.floor(rows.length / 2)]! - shape.boardRanks[0]!.jsonBytes.p50),
    ).toBeLessThan(100);
    expect(rows.some((row) => row.asks.some((ask) => ask.closedAt === null))).toBe(true);
    expect(rows.some((row) => row.asks.some((ask) => ask.closedAt !== null))).toBe(true);
    expect(rows.filter((row) => row.activeThreadId !== null)).toHaveLength(19);
    expect(
      rows.filter(
        (row) => row.activeThreadId !== null || (row.stage === "todo" && row.workThreadId !== null),
      ),
    ).toHaveLength(33);
    expect(
      rows.filter((row) => row.stage === "in_review" && row.activeThreadId === null),
    ).toHaveLength(95);
    expect(boardShapes(260)).toHaveLength(260);
  });
});
