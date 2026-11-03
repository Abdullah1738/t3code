import {
  MessageId,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { splitBufferedAssistantText } from "./assistantStreaming.ts";

type ItemType = "reasoning" | "assistant_message" | "command_execution" | "dynamic_tool";
type Group = {
  readonly type: ItemType;
  readonly firstBytes: number;
  readonly lastBytes: number;
  readonly updates: ReadonlyArray<readonly [count: number, items: number]>;
};

// C3, 2026-11-02, aggregate cross-tab of item subtype, update-count bucket,
// last payload-size bucket: number of items, first/last mean UTF-8 payload
// bytes, and exact update-count histogram within each bucket. Calculated from
// the retained size/count metadata, not from any production event content.
// This is the persisted-update distribution, not the unobserved adapter input
// distribution. Replaying it as input is a sensitivity experiment, not a
// reconstruction of C3 or a production savings forecast.
const GROUPS: ReadonlyArray<Group> = [
  { type: "reasoning", firstBytes: 1538, lastBytes: 1538, updates: [[1, 49]] },
  { type: "reasoning", firstBytes: 1931, lastBytes: 1967, updates: [[2, 491]] },
  {
    type: "reasoning",
    firstBytes: 5416,
    lastBytes: 5553,
    updates: [
      [2, 30],
      [3, 4],
    ],
  },
  { type: "reasoning", firstBytes: 49745, lastBytes: 49770, updates: [[2, 1]] },
  {
    type: "reasoning",
    firstBytes: 1600,
    lastBytes: 2660,
    updates: [
      [4, 1],
      [5, 3],
    ],
  },
  {
    type: "reasoning",
    firstBytes: 6835,
    lastBytes: 9713,
    updates: [
      [4, 1],
      [6, 1],
      [7, 3],
      [8, 3],
      [10, 1],
    ],
  },
  { type: "reasoning", firstBytes: 15379, lastBytes: 18113, updates: [[7, 1]] },
  {
    type: "reasoning",
    firstBytes: 2896,
    lastBytes: 11349,
    updates: [
      [11, 1],
      [12, 1],
      [14, 1],
      [15, 2],
      [16, 2],
      [20, 1],
      [21, 1],
      [22, 4],
      [24, 2],
      [26, 3],
      [28, 1],
      [31, 1],
      [35, 1],
      [37, 1],
      [38, 1],
    ],
  },
  {
    type: "reasoning",
    firstBytes: 7905,
    lastBytes: 20528,
    updates: [
      [15, 1],
      [20, 1],
      [24, 1],
      [28, 1],
      [29, 1],
      [30, 3],
      [31, 1],
      [33, 1],
      [35, 2],
      [36, 1],
      [38, 3],
    ],
  },
  { type: "reasoning", firstBytes: 57605, lastBytes: 67950, updates: [[21, 1]] },
  {
    type: "reasoning",
    firstBytes: 1702,
    lastBytes: 11807,
    updates: [
      [42, 1],
      [48, 1],
    ],
  },
  {
    type: "reasoning",
    firstBytes: 4336,
    lastBytes: 33594,
    updates: [
      [41, 2],
      [42, 3],
      [43, 1],
      [45, 2],
      [46, 1],
      [47, 1],
      [48, 1],
      [51, 1],
      [53, 1],
      [54, 1],
      [56, 3],
      [60, 1],
      [62, 1],
      [63, 2],
      [64, 1],
      [66, 1],
      [67, 2],
      [72, 1],
      [76, 1],
      [79, 1],
      [81, 1],
      [87, 1],
      [94, 1],
      [100, 1],
      [106, 1],
      [110, 1],
      [114, 1],
      [138, 1],
      [143, 2],
      [160, 1],
      [165, 1],
      [187, 1],
    ],
  },
  {
    type: "reasoning",
    firstBytes: 1724,
    lastBytes: 66034,
    updates: [
      [137, 1],
      [148, 1],
    ],
  },
  { type: "assistant_message", firstBytes: 1658, lastBytes: 1658, updates: [[1, 129]] },
  {
    type: "assistant_message",
    firstBytes: 2159,
    lastBytes: 2499,
    updates: [
      [2, 39],
      [3, 3],
    ],
  },
  { type: "assistant_message", firstBytes: 3523, lastBytes: 4683, updates: [[3, 1]] },
  {
    type: "assistant_message",
    firstBytes: 1739,
    lastBytes: 2763,
    updates: [
      [4, 1],
      [5, 5],
      [6, 2],
      [8, 1],
    ],
  },
  {
    type: "assistant_message",
    firstBytes: 2881,
    lastBytes: 5019,
    updates: [
      [4, 1],
      [5, 1],
      [6, 2],
      [9, 1],
    ],
  },
  {
    type: "assistant_message",
    firstBytes: 3157,
    lastBytes: 7787,
    updates: [
      [11, 1],
      [17, 1],
      [30, 1],
    ],
  },
  { type: "assistant_message", firstBytes: 1246, lastBytes: 10790, updates: [[42, 1]] },
  { type: "command_execution", firstBytes: 2183, lastBytes: 2183, updates: [[1, 9]] },
  { type: "command_execution", firstBytes: 6883, lastBytes: 6883, updates: [[1, 1]] },
  { type: "command_execution", firstBytes: 33907, lastBytes: 33907, updates: [[1, 1]] },
  {
    type: "command_execution",
    firstBytes: 1350,
    lastBytes: 2452,
    updates: [
      [2, 25],
      [3, 521],
    ],
  },
  { type: "command_execution", firstBytes: 1357, lastBytes: 7901, updates: [[3, 353]] },
  { type: "command_execution", firstBytes: 1355, lastBytes: 28595, updates: [[3, 97]] },
  { type: "dynamic_tool", firstBytes: 2357, lastBytes: 2357, updates: [[1, 3]] },
  {
    type: "dynamic_tool",
    firstBytes: 1348,
    lastBytes: 2495,
    updates: [
      [2, 8],
      [3, 255],
    ],
  },
  { type: "dynamic_tool", firstBytes: 1332, lastBytes: 8761, updates: [[3, 412]] },
  { type: "dynamic_tool", firstBytes: 1346, lastBytes: 27069, updates: [[3, 126]] },
];

export interface C3ReplayEntry {
  readonly at: number;
  readonly event: Extract<
    ProviderAdapter.ProviderAdapterV2Event,
    { readonly type: "turn_item.updated" }
  >;
}

const encodeTurnItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));

// Exact old implementation at 2b6343acd8d9: paragraph boundaries and 400 ms
// for both text item types. Kept independent from the new filter as an A/B
// control; assistant message.updated is not in this item-only synthetic mix.
export function makeBeforeCheckpointFilter() {
  const delivered = new Map<string, { text: string; at: number }>();
  return (entry: C3ReplayEntry): C3ReplayEntry["event"] | null => {
    const { event, at } = entry;
    const item = event.turnItem;
    if (item.type !== "assistant_message" && item.type !== "reasoning") return event;
    const key = `${event.type}:${item.id}`;
    if (!item.streaming) {
      delivered.delete(key);
      return event;
    }
    const previous = delivered.get(key);
    if (previous && at - previous.at < 400) return null;
    const { ready } = splitBufferedAssistantText(item.text);
    if (!ready || ready === previous?.text) return null;
    delivered.set(key, { text: ready, at });
    return { ...event, turnItem: { ...item, text: ready } };
  };
}

/** An entirely synthetic input stream built only from the C3 aggregates above. */
export function makeC3SyntheticReplay(threadId: ThreadId): ReadonlyArray<C3ReplayEntry> {
  const start = Date.parse("2026-11-02T12:11:19.075Z");
  const entries: Array<
    C3ReplayEntry & { readonly itemIndex: number; readonly updateIndex: number }
  > = [];
  let itemIndex = 0;
  for (const group of GROUPS) {
    for (const [count, itemCount] of group.updates) {
      for (let repeat = 0; repeat < itemCount; repeat++, itemIndex++) {
        const id = TurnItemId.make(`synthetic-c3-item-${String(itemIndex).padStart(4, "0")}`);
        // Synthetic scheduling: distribute starts over 800 s and vary gaps
        // 450..3850 ms; no per-item timing or original ordering is reused.
        const startsAt = start + ((itemIndex * 7_919) % 800_000);
        const gap = 450 + ((itemIndex * 997) % 3_401);
        const driver = ProviderDriverKind.make(["opencode", "claude", "codex"][itemIndex % 3]!);
        for (let updateIndex = 0; updateIndex < count; updateIndex++) {
          const at = startsAt + updateIndex * gap;
          const terminal = updateIndex === count - 1;
          const fraction = count === 1 ? 1 : updateIndex / (count - 1);
          const targetPayloadBytes = Math.round(
            group.firstBytes + fraction * (group.lastBytes - group.firstBytes),
          );
          const base = {
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: terminal ? ("completed" as const) : ("running" as const),
            title: null,
            startedAt: DateTime.makeUnsafe(startsAt),
            completedAt: terminal ? DateTime.makeUnsafe(at) : null,
            updatedAt: DateTime.makeUnsafe(at),
          };
          let turnItem: OrchestrationV2TurnItem =
            group.type === "reasoning"
              ? { ...base, type: "reasoning", text: "\n\n", streaming: !terminal }
              : group.type === "assistant_message"
                ? {
                    ...base,
                    type: "assistant_message",
                    messageId: MessageId.make(`synthetic-c3-message-${itemIndex}`),
                    text: "\n\n",
                    streaming: !terminal,
                  }
                : group.type === "command_execution"
                  ? { ...base, type: "command_execution", input: "synthetic command", output: "" }
                  : {
                      ...base,
                      type: "dynamic_tool",
                      toolName: "synthetic-tool",
                      input: {},
                      output: "",
                    };
          // Match the cross-tab's mean encoded payload sizes, not text sizes.
          // EventSink may add a few bytes when it assigns a multi-digit ordinal.
          const envelope = Buffer.byteLength(JSON.stringify(encodeTurnItem(turnItem)), "utf8");
          const body = "x".repeat(Math.max(0, targetPayloadBytes - envelope));
          switch (turnItem.type) {
            case "reasoning":
            case "assistant_message":
              turnItem = { ...turnItem, text: `${body}\n\n` };
              break;
            case "command_execution":
            case "dynamic_tool":
              turnItem = { ...turnItem, output: body };
              break;
          }
          entries.push({
            at,
            itemIndex,
            updateIndex,
            event: { type: "turn_item.updated", driver, turnItem },
          });
        }
      }
    }
  }
  return entries.sort(
    (a, b) => a.at - b.at || a.itemIndex - b.itemIndex || a.updateIndex - b.updateIndex,
  );
}
