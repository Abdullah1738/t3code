import {
  kanbanAskResponse,
  type AnalyticsEvent,
  type AnalyticsRollup,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import { addDuration, durations, summarize } from "./rollup.ts";

export type AskSurface = "web" | "desktop" | "mobile";
export type AskChannel = "in_app" | "telegram" | "push";
function definedTimes<Key extends string>(
  values: Readonly<Partial<Record<Key, string | undefined>>>,
) {
  const result: Partial<Record<Key, string>> = {};
  for (const key of Object.keys(values) as Key[]) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
export const askKind = (
  ask: Parameters<typeof kanbanAskResponse>[0],
): NonNullable<NonNullable<KanbanOwnerAsk["timing"]>["kind"]> => {
  const response = kanbanAskResponse(ask);
  return response.edit
    ? "draft"
    : ask.action || response.task
      ? "action"
      : response.choose
        ? "pick"
        : response.verdict
          ? "approve"
          : response.ack
            ? "notice"
            : "input";
};

export function markAskTiming(
  ask: KanbanOwnerAsk,
  type: "seen" | "notified",
  key: AskSurface | AskChannel,
  at: string,
): KanbanOwnerAsk {
  const field = type === "seen" ? "firstSeen" : "notified";
  const entries: Readonly<Record<string, string | undefined>> = ask.timing?.[field] ?? {};
  if (
    entries[key] !== undefined ||
    (ask.closedAt !== null && (type === "seen" ? at >= ask.closedAt : at > ask.closedAt))
  )
    return ask;
  return { ...ask, timing: { ...ask.timing, [field]: { ...entries, [key]: at } } };
}

export function askTimingProps(ask: KanbanOwnerAsk): NonNullable<AnalyticsEvent["props"]> {
  const notified = definedTimes(ask.timing?.notified ?? {});
  const firstSeenBySurface = definedTimes(ask.timing?.firstSeen ?? {});
  const notifiedAt = Object.values(notified)
    .filter((at): at is string => at !== undefined)
    .sort()[0];
  const firstSeenAt = Object.values(firstSeenBySurface)
    .filter((at): at is string => at !== undefined)
    .sort()[0];
  return {
    askId: ask.id,
    createdAt: ask.at,
    blocking: ask.blocking,
    askKind: askKind(ask),
    hasBatchKey: Boolean(ask.batchKey),
    notificationChannels: Object.keys(notified) as AskChannel[],
    notifiedByChannel: notified,
    ...(notifiedAt === undefined ? {} : { notifiedAt }),
    ...(firstSeenAt === undefined ? {} : { firstSeenAt, firstSeenBySurface }),
    ...(ask.answer === undefined ? {} : { answeredAt: ask.answer.at }),
    ...(ask.timing?.openNoticesAtCreation === undefined
      ? {}
      : { openNoticesAtCreation: ask.timing.openNoticesAtCreation }),
    ...(ask.timing?.openAsksAtCreation === undefined
      ? {}
      : { openAsksAtCreation: ask.timing.openAsksAtCreation }),
    ...(ask.timing?.answeredVia === undefined ? {} : { answeredVia: ask.timing.answeredVia }),
  };
}

export interface AskTimingRow {
  readonly boardId: string;
  readonly cardId: string;
  readonly askId: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly answeredAt: string | null;
  readonly blocking: boolean;
  readonly kind: string;
  readonly notifiedAt: string | null;
  readonly firstSeenAt: string | null;
}

// One stored row per ask, independent of how many clients saw it or how often a receipt was retried.
export function askLatencyRollup(
  rows: ReadonlyArray<AskTimingRow>,
  day: string,
  generatedAt: string,
): AnalyticsRollup["askLatency"] {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + 86_400_000;
  const effectiveEnd = Math.min(end, Date.parse(generatedAt));
  const overall = makeSplit();
  const blocking = new Map<string, ReturnType<typeof makeSplit>>();
  const kinds = new Map<string, ReturnType<typeof makeSplit>>();
  let openOver1hAtDayEnd = 0;
  for (const ask of rows) {
    const created = Date.parse(ask.createdAt);
    if (!Number.isFinite(created)) continue;
    if (
      created < effectiveEnd - 3_600_000 &&
      (ask.closedAt === null || Date.parse(ask.closedAt) >= effectiveEnd)
    )
      openOver1hAtDayEnd++;
    const answered = ask.answeredAt === null ? NaN : Date.parse(ask.answeredAt);
    if (
      answered < start ||
      answered >= effectiveEnd ||
      !Number.isFinite(answered) ||
      answered < created
    )
      continue;
    const b = String(ask.blocking);
    const k = ["approve", "pick", "draft", "action", "input", "notice"].includes(ask.kind)
      ? ask.kind
      : "unknown";
    if (!blocking.has(b)) blocking.set(b, makeSplit());
    if (!kinds.has(k)) kinds.set(k, makeSplit());
    const seen = ask.firstSeenAt === null ? NaN : Date.parse(ask.firstSeenAt);
    const sent = ask.notifiedAt === null ? NaN : Date.parse(ask.notifiedAt);
    for (const group of [overall, blocking.get(b)!, kinds.get(k)!]) {
      group.add("createdToAnswered", answered - created);
      if (seen >= created && seen <= answered) {
        group.add("seenToAnswered", answered - seen);
        if (sent >= created && sent <= seen) group.add("sentToSeen", seen - sent);
      } else group.unseen++;
    }
  }
  return {
    source: "stored-asks",
    ...overall.finish(),
    openOver1hAtDayEnd: Date.parse(generatedAt) >= end ? openOver1hAtDayEnd : null,
    byBlocking: Object.fromEntries([...blocking].map(([key, value]) => [key, value.finish()])),
    byKind: Object.fromEntries([...kinds].map(([key, value]) => [key, value.finish()])),
  };
}

function makeSplit() {
  const values = {
    sentToSeen: durations(),
    seenToAnswered: durations(),
    createdToAnswered: durations(),
  };
  return {
    unseen: 0,
    add(key: keyof typeof values, durationMs: number) {
      addDuration(values[key], durationMs);
    },
    finish() {
      const summary = (key: keyof typeof values) => summarize(values[key]);
      return {
        sentToSeen: summary("sentToSeen"),
        seenToAnswered: summary("seenToAnswered"),
        createdToAnswered: summary("createdToAnswered"),
        answeredWithoutSeen: this.unseen,
      };
    },
  };
}
