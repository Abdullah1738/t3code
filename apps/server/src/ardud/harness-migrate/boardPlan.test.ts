import { assert, it } from "@effect/vitest";
import {
  KanbanBoardId,
  KanbanCardId,
  KanbanPool,
  ProjectId,
  ProviderInstanceId,
  type KanbanBoard,
  type KanbanCard,
  type ModelSelection,
} from "@t3tools/contracts";

import * as Rules from "../kanban/engine/rules.ts";
import { planBoard, type BoardSnapshot } from "./boardPlan.ts";

const sel = (model: string, level?: string): ModelSelection =>
  ({
    instanceId: ProviderInstanceId.make("opencode"),
    model,
    ...(level === undefined ? {} : { options: [{ id: "variant", value: level }] }),
  }) as unknown as ModelSelection;

const pool = (model: ModelSelection, slots: number): KanbanPool =>
  ({
    key: Rules.poolKey(model),
    model,
    slots,
  }) as unknown as KanbanPool;

/** A board with the defaults a fresh board has. Tests override only what they exercise. */
const board = (overrides: Partial<KanbanBoard> = {}): KanbanBoard =>
  ({
    id: KanbanBoardId.make("board-1"),
    slug: "board-1",
    name: "Board 1",
    defaultProjectId: ProjectId.make("project-1"),
    managerModel: sel("opus/cc/claude-haiku-5-5", "xhigh"),
    evaluatorModel: sel("opus/claude-opus-5-5", "xhigh"),
    defaultCardModel: sel("opus/claude-opus-5-5", "xhigh"),
    reviewChains: [],
    instructions: { modelRouting: "", reviewerRouting: "", escalation: "" },
    ...overrides,
  }) as unknown as KanbanBoard;

const card = (overrides: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: KanbanCardId.make("card-1"),
    number: 1,
    stage: "todo",
    settledAt: null,
    model: sel("opus/claude-opus-5-5", "xhigh"),
    models: [],
    activePool: null,
    ...overrides,
  }) as unknown as KanbanCard;

const snapshot = (overrides: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  board: board(),
  pools: [],
  cards: [],
  openLinks: [],
  ...overrides,
});

it("maps a board's pools to Claude Code and keeps each slot count", () => {
  const plan = planBoard(
    snapshot({
      pools: [
        pool(sel("opus/cc/claude-haiku-5-5", "max"), 3),
        pool(sel("opus/cc/claude-haiku-5-5", "xhigh"), 1),
      ],
    }),
  );
  assert.strictEqual(plan.conflicts.length, 0);
  assert.strictEqual(plan.collisions.length, 0);
  assert.strictEqual(plan.changed, true);
  assert.isNotNull(plan.next);
  const pools = plan.next?.pools ?? [];
  assert.strictEqual(pools.length, 2);
  assert.isTrue(pools.every((entry) => entry.model.instanceId === "claudeAgent"));
  assert.deepStrictEqual(pools.map((entry) => entry.slots).sort(), [1, 3].sort());
});

it("keeps a card's occupancy on the pool it runs in", () => {
  const oldPool = pool(sel("opus/claude-opus-5-5", "max"), 2);
  const plan = planBoard(
    snapshot({
      pools: [oldPool],
      cards: [card({ activePool: oldPool.key, stage: "working" })],
    }),
  );
  assert.strictEqual(plan.collisions.length, 0);
  const migratedCard = plan.next?.cards[0];
  assert.isNotNull(migratedCard);
  // Occupancy follows the pool to its new key, so the card still holds a slot on the migrated pool.
  const newKey = plan.next?.pools[0]?.key;
  assert.isNotNull(newKey);
  assert.strictEqual(migratedCard?.activePool, newKey);
  assert.notStrictEqual(migratedCard?.activePool, oldPool.key);
});

it("keeps card weights and rewrites only the model", () => {
  const plan = planBoard(
    snapshot({
      cards: [card({ model: sel("opus/claude-opus-5-5", "xhigh") })],
    }),
  );
  const migrated = plan.next?.cards[0];
  assert.isNotNull(migrated);
  assert.strictEqual(migrated?.model.instanceId, "claudeAgent");
  assert.strictEqual(migrated?.model.model, "claude-opus-5-5");
});

it("blocks the whole board when two old pools land on one new key", () => {
  // Two OpenCode pools that differ only in instance name map onto one Claude Code pool.
  const first = pool(sel("opus/claude-opus-5-5", "max"), 2);
  const second = pool(
    { instanceId: "opencode", model: "opus/claude-opus-5-5#max" } as ModelSelection,
    3,
  );
  const plan = planBoard(snapshot({ pools: [first, second] }));
  // It must be the collision that blocks the board, not an unrelated conflict.
  assert.strictEqual(plan.collisions.length, 1);
  assert.strictEqual(plan.collisions[0]?.oldKeys.length, 2);
  assert.isFalse(plan.changed);
  assert.isNull(plan.next);
});

it("review: a card-only conflict blocks the entire board", () => {
  const plan = planBoard(
    snapshot({
      cards: [card({ model: sel("opus/claude-opus-5-5#xhigh", "high") })],
    }),
  );
  assert.strictEqual(plan.conflicts.length, 1);
  assert.isNull(plan.next, "allowConflicts must skip a conflicted board, not partially migrate it");
});

it("maps pinned models on done and settled cards without reopening them", () => {
  const cards = [
    card({ stage: "completed" }),
    card({ stage: "verified", settledAt: "2026-11-05T00:00:00.000Z" }),
    card({ stage: "deployed" }),
  ].map((entry, index) => ({
    ...entry,
    id: KanbanCardId.make(`done-${index}`),
    models: [
      { model: sel("opus/claude-opus-5-5", "xhigh"), weight: 7 },
      { model: sel("opus/cx/gpt-6.1-sol", "xhigh"), weight: 2 },
    ],
  }));
  const plan = planBoard(snapshot({ cards }));
  assert.isNotNull(plan.next);
  for (const [index, migrated] of (plan.next?.cards ?? []).entries()) {
    assert.strictEqual(migrated.model.instanceId, "claudeAgent");
    assert.deepStrictEqual(
      migrated.models.map((entry) => entry.model.instanceId),
      ["claudeAgent", "codex"],
    );
    assert.deepStrictEqual(
      migrated.models.map((entry) => entry.weight),
      [7, 2],
    );
    assert.strictEqual(migrated.stage, cards[index]?.stage);
    assert.strictEqual(migrated.settledAt, cards[index]?.settledAt);
  }
  assert.strictEqual(plan.changes.filter((change) => change.ref.startsWith("card:")).length, 3);
});

it("a conflicting pinned model on a settled card blocks the board", () => {
  const plan = planBoard(
    snapshot({
      cards: [
        card({
          stage: "verified",
          settledAt: "2026-11-05T00:00:00.000Z",
          model: sel("opus/claude-opus-5-5#xhigh", "high"),
        }),
      ],
    }),
  );
  assert.strictEqual(plan.conflicts.length, 1);
  assert.isNull(plan.next);
});

it("puts converted reviewer instructions in the same board change as the native selections", () => {
  const before = board({
    instructions: {
      modelRouting: "Keep worker weights.",
      reviewerRouting: "One crpko-reviewer on opus/cx/gpt-6.1-sol#xhigh, exact head only.",
      escalation: "Ask before a merge.",
    },
  });
  const plan = planBoard(snapshot({ board: before }));
  assert.strictEqual(plan.conflicts.length, 0);
  assert.isTrue(plan.changed);
  assert.isNotNull(plan.next);
  assert.notInclude(plan.next!.board.instructions.reviewerRouting, "crpko-reviewer");
  assert.include(plan.next!.board.instructions.reviewerRouting, "Read-only Crpko review role");
  const change = plan.changes.find((entry) => entry.ref === `board:${before.id}`);
  assert.deepStrictEqual(change?.before, before);
  assert.deepStrictEqual(change?.after, plan.next!.board);
  assert.strictEqual(plan.next!.board.instructions.escalation, before.instructions.escalation);
});

it("blocks the entire board for an unsupported reviewer without writing partial model changes", () => {
  const plan = planBoard(
    snapshot({
      board: board({
        instructions: {
          modelRouting: "",
          reviewerRouting: "Use agent: private-auditor.",
          escalation: "",
        },
      }),
    }),
  );
  assert.isFalse(plan.changed);
  assert.isNull(plan.next);
  assert.strictEqual(plan.conflicts[0]?.field, "instructions.reviewerRouting");
});
