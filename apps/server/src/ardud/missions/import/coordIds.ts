import {
  LaneId,
  MissionMessageId,
  RoleId,
  RoomId,
  type MissionActor,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * How coord names map onto mission records. The import and the coord forward
 * shim both use these, so a coord actor, channel or seq always lands on the
 * same record id.
 *
 * - channel `control` -> room `<mission>:room:control`
 * - event seq 42 -> message `<mission>:coord:42` (message seq stays 42)
 * - actor `master` -> role `<mission>:master`
 * - actors `release`, `arch-author` -> custom roles `<mission>:custom:<actor>`
 * - any other thread actor `cell-x` -> lane `<mission>:lane:cell-x` led by role
 *   `<mission>:lane-lead:<mission>:lane:cell-x`
 * - process actors (crw) -> system actor `{ component: <actor> }`
 */

export const IMPORT_COMPONENT = "coord-import";

/** Thread actors that are mission-wide roles rather than lanes. */
export const SPECIAL_ROLES = {
  master: { kind: "master", name: "Master", laneActor: null },
  release: { kind: "custom", name: "Release owner", laneActor: null },
  "arch-author": { kind: "custom", name: "Architecture author", laneActor: "arch" },
} as const;
type SpecialActor = keyof typeof SPECIAL_ROLES;

const isSpecial = (actor: string): actor is SpecialActor => Object.hasOwn(SPECIAL_ROLES, actor);

export const roomIdFor = (missionId: string, channel: string) =>
  RoomId.make(`${missionId}:room:${channel}`);

export const messageIdFor = (missionId: string, seq: number) =>
  MissionMessageId.make(`${missionId}:coord:${seq}`);

export const laneIdFor = (missionId: string, actor: string) =>
  LaneId.make(`${missionId}:lane:${actor}`);

/** Role id of a thread actor (master, custom roles, or its lane's lead). */
export const roleIdFor = (missionId: string, actor: string) => {
  if (actor === "master") return RoleId.make(`${missionId}:master`);
  if (isSpecial(actor)) return RoleId.make(`${missionId}:custom:${actor}`);
  return RoleId.make(`${missionId}:lane-lead:${laneIdFor(missionId, actor)}`);
};

export const isLaneActor = (actor: string) => !isSpecial(actor);

/** The mission actor a coord actor speaks as. Unknown actors become a person. */
export const missionActorFor = (
  missionId: string,
  actor: { readonly id: string; readonly kind: string } | undefined,
  id: string,
): MissionActor => {
  if (actor === undefined) return { _tag: "person", name: id };
  if (actor.kind !== "thread") return { _tag: "system", component: id };
  return { _tag: "role", roleId: roleIdFor(missionId, id) };
};

/** Inverse of `missionActorFor` for the shim: the coord actor a mission actor maps to. */
export const coordActorFor = (missionId: string, actor: MissionActor): string | null => {
  switch (actor._tag) {
    case "system":
      return actor.component;
    case "person":
      return actor.name;
    case "role": {
      const id: string = actor.roleId;
      if (id === `${missionId}:master`) return "master";
      const custom = `${missionId}:custom:`;
      if (id.startsWith(custom)) return id.slice(custom.length);
      const lead = `${missionId}:lane-lead:${missionId}:lane:`;
      if (id.startsWith(lead)) return id.slice(lead.length);
      return null;
    }
    case "lane": {
      const prefix = `${missionId}:lane:`;
      return actor.laneId.startsWith(prefix) ? actor.laneId.slice(prefix.length) : null;
    }
    default:
      return null;
  }
};

/** Stable key for a mission actor, for ids and lookups. */
export const actorKey = (actor: MissionActor): string => {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "role":
      return `role:${actor.roleId}`;
    case "lane":
      return `lane:${actor.laneId}`;
    case "thread":
      return `thread:${actor.threadId}`;
    case "system":
      return `system:${actor.component}`;
    case "person":
      return `person:${actor.name}`;
  }
};

const opencode = (model: string, variant: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("opencode"),
  model,
  options: [{ id: "variant", value: variant }],
});

/** Standing rule 98: Haiku lanes run Haiku 5.5 xhigh, everything else Opus xhigh. */
export const OPUS_XHIGH = opencode("opus/claude-opus-5-5", "xhigh");
export const HAIKU_XHIGH = opencode("opus/cc/claude-haiku-5-5", "xhigh");

// Message summaries are capped at 400 characters; the full text moves to the body.
const SUMMARY_MAX = 400;
const FENCE_OPEN = "```json\n";
const FENCE_CLOSE = "\n```";
const BODY_SEPARATOR = "\n\n";

export const listSummary = (summary: string): { readonly text: string; readonly cut: boolean } => {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return { text: "(no summary)", cut: summary.length > 0 };
  if (trimmed === summary && trimmed.length <= SUMMARY_MAX) return { text: trimmed, cut: false };
  return {
    text: trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 1)}…`,
    cut: true,
  };
};

/**
 * Body text of a coord event: the full summary when the list summary had to be
 * cut, then the coord body as a fenced JSON block. `null` when neither exists.
 */
export const coordBodyText = (summary: string, bodyJson: string | null): string | null => {
  const { cut } = listSummary(summary);
  const parts: Array<string> = [];
  if (cut) parts.push(summary);
  if (bodyJson !== null)
    parts.push(`${FENCE_OPEN}${JSON.stringify(JSON.parse(bodyJson), null, 2)}${FENCE_CLOSE}`);
  return parts.length === 0 ? null : parts.join(BODY_SEPARATOR);
};

/** Inverse of `coordBodyText`: the coord summary and body a message carries. */
export const parseCoordBodyText = (
  summary: string,
  body: string | null,
): { readonly summary: string; readonly body: unknown } => {
  if (body === null) return { summary, body: null };
  if (body.endsWith(FENCE_CLOSE)) {
    const at = body.startsWith(FENCE_OPEN) ? 0 : body.lastIndexOf(`${BODY_SEPARATOR}${FENCE_OPEN}`);
    if (at >= 0) {
      const head = at === 0 ? null : body.slice(0, at);
      const start = at === 0 ? FENCE_OPEN.length : at + BODY_SEPARATOR.length + FENCE_OPEN.length;
      const json = body.slice(start, body.length - FENCE_CLOSE.length);
      try {
        return { summary: head ?? summary, body: JSON.parse(json) };
      } catch {
        // Not a coord body block after all; treat the whole text as the summary.
      }
    }
  }
  return { summary: body, body: null };
};
