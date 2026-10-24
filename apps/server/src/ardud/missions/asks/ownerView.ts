import type {
  Approval,
  Draft,
  MissionLink,
  MissionOverview,
  WorkItem,
  WorkStage,
} from "@t3tools/contracts";

/**
 * Shapes for the owner's full view over the desk (his iMessage agent reads
 * these through the `mission` CLI). Pure: the routes read the records.
 */

/** Something from a draft the agent can put in the chat: a URL to fetch, or a file path. */
export interface DraftAttachment {
  readonly kind: MissionLink["kind"];
  readonly label: string;
  readonly url: string | null;
  readonly path: string | null;
  readonly from: "target" | "reply" | "view" | "sent";
}

/** "Mon 19 Oct 14:05" in Dubai time, where the owner reads. */
const replyTime = (at: string): string => {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Dubai",
  })
    .format(ms)
    .replace(",", "");
};

/**
 * What a draft replies to as plain text for the owner's chat, or null when the
 * writer gave none. The agent sends it above the draft text.
 */
export const replyingToText = (draft: Pick<Draft, "inReplyTo">): string | null => {
  const reply = draft.inReplyTo ?? null;
  if (reply === null) return null;
  const who = [reply.author, reply.at === undefined ? undefined : replyTime(reply.at)]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ");
  const lines = [who === "" ? "Replying to:" : `Replying to ${who}:`];
  if (reply.quote !== undefined) {
    lines.push(...reply.quote.split("\n").map((line) => `> ${line}`));
  }
  lines.push(reply.summary);
  const link = reply.link?.url ?? reply.link?.ref ?? null;
  if (link !== null) lines.push(link);
  return lines.join("\n");
};

/** Drafts for the owner's reads, each with `replyingTo` text when it has a reply context. */
export const withReplyingTo = <D extends Pick<Draft, "inReplyTo">>(
  drafts: ReadonlyArray<D>,
): ReadonlyArray<D & { readonly replyingTo?: string }> =>
  drafts.map((draft) => {
    const replyingTo = replyingToText(draft);
    return replyingTo === null ? draft : { ...draft, replyingTo };
  });

/** Every link a draft carries (its target, what it replies to, link fields on its card, where it was sent), once each. */
export const draftAttachments = (draft: Draft): ReadonlyArray<DraftAttachment> => {
  const seen = new Set<string>();
  const out: DraftAttachment[] = [];
  const add = (link: MissionLink, from: DraftAttachment["from"]) => {
    if (link.url === null && link.ref === null) return;
    const key = `${link.url ?? ""}\u0000${link.ref ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: link.kind, label: link.label, url: link.url, path: link.ref, from });
  };
  add(draft.target, "target");
  if (draft.inReplyTo?.link !== undefined) add(draft.inReplyTo.link, "reply");
  for (const field of Object.values(draft.view?.fields ?? {})) {
    if (field._tag === "links") for (const link of field.value) add(link, "view");
  }
  if (draft.sentLink !== undefined && draft.sentLink !== null) add(draft.sentLink, "sent");
  return out;
};

/** Pending approvals plus the most recent decided ones (approvals come newest first). */
export const pendingAndRecent = (
  approvals: ReadonlyArray<Approval>,
  recent: number,
): ReadonlyArray<Approval> => {
  const pending = approvals.filter((approval) => approval.status === "pending");
  const decided = approvals.filter((approval) => approval.status !== "pending").slice(0, recent);
  return [...pending, ...decided];
};

type StageCounts = Partial<Record<WorkStage, number>>;

const countStages = (items: ReadonlyArray<WorkItem>): StageCounts => {
  const counts: StageCounts = {};
  for (const item of items) counts[item.stage] = (counts[item.stage] ?? 0) + 1;
  return counts;
};

/** Progress per sub-mission and milestone: item counts by stage and how many are done. */
export const progressOf = (overview: MissionOverview, items: ReadonlyArray<WorkItem>) => {
  const done = (list: ReadonlyArray<WorkItem>) =>
    list.filter((item) => item.stage === "done").length;
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    missionId: overview.mission.id,
    title: overview.mission.title,
    status: overview.mission.status,
    health: overview.mission.health,
    bottomLine: overview.bottomLine,
    items: { total: items.length, done: done(items), byStage: countStages(items) },
    subMissions: overview.subMissions.map((sub) => {
      const own = items.filter((item) => item.subMissionId === sub.id);
      return {
        id: sub.id,
        title: sub.title,
        status: sub.status,
        health: sub.health,
        items: { total: own.length, done: done(own), byStage: countStages(own) },
      };
    }),
    milestones: overview.milestones.map((milestone) => {
      const own = milestone.itemIds.flatMap((id) => {
        const item = byId.get(id);
        return item === undefined ? [] : [item];
      });
      return {
        id: milestone.id,
        subMissionId: milestone.subMissionId,
        title: milestone.title,
        status: milestone.status,
        statusNote: milestone.statusNote,
        targetAt: milestone.targetAt,
        items: { total: milestone.itemIds.length, done: done(own) },
      };
    }),
  };
};
