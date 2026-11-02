import { assert, it } from "@effect/vitest";
import {
  KanbanBoardId,
  KanbanCardId,
  KanbanPool,
  ProjectId,
  type KanbanBoard,
  type KanbanCard,
  type ModelSelection,
} from "@t3tools/contracts";

import * as Rules from "../kanban/engine/rules.ts";
import { planBoard, type BoardSnapshot } from "./boardPlan.ts";

const sel = (model: string, level?: string): ModelSelection =>
  ({
    instanceId: "opencode",
    model,
    ...(level === undefined ? {} : { options: [{ id: "variant", value: level }] }),
  }) as ModelSelection;

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
  assert.deepStrictEqual(
    pools.map((entry) => entry.slots).sort(),
    [1, 3].sort(),
  );
});

it("keeps a card's occupancy on the pool it runs in", () => {
  const oldPool = pool(sel("opus/claude-opus-5-5", "max"), 2);
  const plan = planBoard(
    snapshot({
      pools: [oldPool],
      cards: [card({ activePool: oldPool.key, stage: "work" })],
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
