import {
  KanbanCardId,
  KanbanWait,
  ThreadId,
  type KanbanBoard,
  type KanbanLink,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import shape from "../../../../../scripts/overload-harness/shape.json" with { type: "json" };
import { poolKey } from "../kanban/engine/rules.ts";
import { soakCards, soakRandom } from "../kanban/engine/soakBoard.ts";

const decodeWait = Schema.decodeUnknownSync(KanbanWait);

type Distribution = {
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

/** Inverse CDF interpolation keeps tails; median-sized padding hides the GC working set. */
export const quantileValue = (distribution: Distribution, q: number) => {
  const points = [
    [0, distribution.min],
    [0.25, distribution.p25],
    [0.5, distribution.p50],
    [0.75, distribution.p75],
    [0.9, distribution.p90],
    [0.95, distribution.p95],
    [0.99, distribution.p99],
    [1, distribution.max],
  ] as const;
  for (let i = 1; i < points.length; i++) {
    const [highQ, high] = points[i]!;
    const [lowQ, low] = points[i - 1]!;
    if (q <= highQ) return Math.round(low + ((high - low) * (q - lowQ)) / (highQ - lowQ));
  }
  return distribution.max;
};

export const boardShapes = (boards = shape.syntheticLoad.boards) =>
  Array.from({ length: boards }, (_, rank) => {
    const stats = shape.boardRanks[Math.min(rank, 2 + (rank % 2))]!;
    const cards = rank < 2 ? shape.syntheticLoad.largeBoards[rank]!.cards : stats.count;
    const open =
      rank < 2
        ? shape.syntheticLoad.largeBoards[rank]!.openCards!
        : Math.round((cards * stats.open) / stats.count);
    return {
      rank,
      cards,
      open,
      settled: cards - open,
      discussions: rank === 0 ? 3224 : Math.round((cards * stats.discussions) / stats.count),
      poolSlots:
        rank === 0
          ? 18
          : rank === 1
            ? 33
            : rank % 2 === 0
              ? Math.floor((rank - 2) / 2) < 3
                ? 2
                : 1
              : Math.floor((rank - 2) / 2) < 5
                ? 1
                : 0,
      stats,
    };
  });

export const syntheticCards = (board: KanbanBoard, rank: number, nowMs: number) => {
  const specification = boardShapes(Math.max(shape.syntheticLoad.boards, rank + 1))[rank]!;
  const stats = specification.stats;
  const random = soakRandom(shape.syntheticLoad.seed + rank);
  const original = soakCards({
    board,
    cards: specification.cards,
    seed: shape.syntheticLoad.seed + rank,
    nowMs,
    workModels: [{ model: board.defaultCardModel, share: 1 }],
    chains: ["Load"],
  });
  const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  const stageWeights = Object.entries(stats.stages) as Array<[KanbanCard["stage"], number]>;
  const totalStages = stageWeights.reduce((sum, [, n]) => sum + n, 0);
  const stageOf = (q: number) => {
    let left = q * totalStages;
    for (const [stage, n] of stageWeights) {
      left -= n;
      if (left < 0) return stage;
    }
    return "todo" as const;
  };
  const openAsks = Math.round((specification.cards * stats.openAsksPerCard.sum) / stats.count);
  return original.map((original, index): KanbanCard => {
    const id = KanbanCardId.make(`load-card-${rank}-${index}`);
    const threadId = ThreadId.make(`load-thread-${rank}-${index}`);
    const settled = index >= specification.open;
    const stage = settled ? "verified" : stageOf(random.next());
    const parked = index < (shape.syntheticLoad.parkedPerBoardByRank[rank] ?? 0);
    const tickShape = shape.syntheticLoad.traceTickShapes[rank]?.maxStepCounts;
    const activeCount = tickShape?.missingThread ?? 0;
    const reviewCount = tickShape?.reviewerBackstop ?? 0;
    const parkedCount = shape.syntheticLoad.parkedPerBoardByRank[rank] ?? 0;
    const active = !settled && index >= parkedCount && index < parkedCount + activeCount;
    const activeReview = active && index < parkedCount + reviewCount;
    const landing =
      !settled &&
      index >= parkedCount + activeCount &&
      index < parkedCount + activeCount + (tickShape?.landing ?? 0);
    const detachedCount = Math.max(0, (tickShape?.silentRunBackstop ?? activeCount) - activeCount);
    const detached =
      !settled &&
      index >= parkedCount + activeCount + (tickShape?.landing ?? 0) &&
      index < parkedCount + activeCount + (tickShape?.landing ?? 0) + detachedCount;
    const shapedStage = settled
      ? "verified"
      : parked
        ? "todo"
        : active
          ? activeReview
            ? "in_review"
            : "working"
          : landing
            ? "in_review"
            : detached
              ? "todo"
              : stage === "working" || stage === "in_review"
                ? "todo"
                : stage;
    const subtasks = Array.from(
      { length: quantileValue(stats.subtasksPerCard, random.next()) },
      (_, i) => ({
        id: `s${i + 1}`,
        step: i + 1,
        text:
          `Task ${rank}/${index}/${i} ` +
          "t".repeat(quantileValue(stats.subtaskTextBytes, random.next())),
        owner: "work" as const,
        state: "open" as const,
        note: "n".repeat(quantileValue(stats.subtaskNoteBytes, random.next())),
        doneBy: null,
        doneAt: null,
      }),
    );
    const links: Array<KanbanLink> = Array.from(
      { length: quantileValue(stats.linksPerCard, random.next()) },
      (_, i) => ({
        kind: "url" as const,
        url:
          `https://example.invalid/${rank}/${index}/${i}/` +
          "u".repeat(Math.max(0, quantileValue(stats.linkUrlBytes, random.next()) - 40)),
        label: "l".repeat(quantileValue(stats.linkLabelBytes, random.next())),
        state: null,
        checkedAt: null,
      }),
    );
    if (landing || activeReview)
      links[0] = {
        kind: "pr",
        url: `https://example.invalid/load/${rank}/${index}/pull/1`,
        label: "Synthetic PR",
        state: "open",
        checkedAt: at,
      };
    const card: KanbanCard = {
      ...original,
      id,
      stage: shapedStage,
      settledAt: settled ? at : null,
      title:
        `Card ${rank}/${index} ` +
        "t".repeat(Math.max(0, quantileValue(stats.titleBytes, random.next()) - 20)),
      prompt: "",
      description: "d".repeat(quantileValue(stats.descriptionBytes, random.next())),
      subtasks,
      subtaskSeq: subtasks.length,
      reviewStep: landing ? 1 : original.reviewStep,
      links,
      asks: Array.from(
        {
          length: Math.max(
            index < openAsks ? 1 : 0,
            quantileValue(
              stats.asksPerCard,
              (((index * 37) % specification.cards) + 0.5) / specification.cards,
            ),
          ),
        },
        (_, askIndex) => ({
          id: `q${askIndex + 1}`,
          text:
            `Question ${rank}/${index}/${askIndex} ` +
            "q".repeat(quantileValue(stats.askTextBytes, random.next())),
          blocking: false,
          by: { _tag: "owner" as const },
          at,
          seq: null,
          closedAt: index < openAsks && askIndex === 0 ? null : at,
        }),
      ),
      blockedBy: [],
      ...(parked
        ? {
            wait: decodeWait({
              on: "time",
              until: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 86400000)),
              note: "Synthetic time wait",
              by: { _tag: "owner" },
              at,
            }),
          }
        : {}),
      activeThreadId: active ? threadId : null,
      activeRole: active ? (activeReview ? "review" : "work") : null,
      activePool: active ? poolKey(board.defaultCardModel) : null,
      workThreadId: shapedStage === "todo" && !detached ? null : threadId,
      reviewThreadId: shapedStage === "in_review" ? threadId : null,
      createdAt: at,
      movedAt: at,
      updatedAt: at,
    };
    // Distinct text per row prevents V8 sharing one backing string across the whole synthetic board.
    const target = quantileValue(stats.jsonBytes, (index + 0.5) / specification.cards);
    const resizeText = (share: number): KanbanCard => ({
      ...card,
      description: card.description.slice(0, Math.floor(card.description.length * share)),
      subtasks: card.subtasks.map((task) => ({
        ...task,
        text: task.text.slice(0, Math.floor(task.text.length * share)),
        note: task.note?.slice(0, Math.floor(task.note.length * share)) ?? null,
      })),
      asks: card.asks.map((ask) => ({
        ...ask,
        text: ask.text.slice(0, Math.floor(ask.text.length * share)),
      })),
      links: card.links.map((link) => ({
        ...link,
        label: link.label?.slice(0, Math.floor(link.label.length * share)) ?? null,
      })),
    });
    const bytes = JSON.stringify(card).length;
    const emptyBytes = JSON.stringify(resizeText(0)).length;
    // Marginal quantiles do not preserve correlations: cap nested text to the sampled row budget.
    const packed =
      bytes > target ? resizeText(Math.max(0, (target - emptyBytes) / (bytes - emptyBytes))) : card;
    const padding = Math.max(0, target - JSON.stringify(packed).length);
    return {
      ...packed,
      prompt: `${rank}/${index}:` + "x".repeat(Math.max(0, padding - `${rank}/${index}:`.length)),
    };
  });
};
