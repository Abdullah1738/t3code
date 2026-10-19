import {
  AskId,
  DraftChannel,
  DraftId,
  MissionId,
  MissionLink,
  MissionRecordRef,
  OpenAskInput,
  SubMissionId,
  SuggestionTargetKind,
  TrimmedNonEmptyString,
  WorkItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Agent-side commands for asks, calls, drafts and suggestions. Owner-side
 * inputs live in the contracts; these are what masters, lanes, writers and
 * the scribe/editor send through MCP and the CLI. Identity never comes from
 * here: the service resolves it from the calling thread.
 */

/** Open an ask, optionally replacing an open one the caller asked. */
export const OpenAskRequest = Schema.Struct({
  ...OpenAskInput.fields,
  supersedes: Schema.optional(AskId),
});
export type OpenAskRequest = typeof OpenAskRequest.Type;

/** A master's own decision, shown to the owner in the direction check. */
export const MakeCallInput = Schema.Struct({
  missionId: MissionId,
  subMissionId: Schema.optional(SubMissionId),
  title: TrimmedNonEmptyString,
  decision: TrimmedNonEmptyString,
  reason: Schema.String,
  alternatives: Schema.optional(Schema.Array(Schema.String)),
  reversible: Schema.optional(Schema.Boolean),
  subject: Schema.optional(MissionRecordRef),
});
export type MakeCallInput = typeof MakeCallInput.Type;

/** Outward text for the owner to approve. Nothing is sent from here. */
export const SubmitDraftInput = Schema.Struct({
  missionId: MissionId,
  audience: TrimmedNonEmptyString,
  channel: DraftChannel,
  target: MissionLink,
  text: TrimmedNonEmptyString,
  /** The sub-mission it is about; defaults to the work item's, then the writer's lane's. */
  subMissionId: Schema.optional(SubMissionId),
  /** The work item it is about. */
  workItemId: Schema.optional(WorkItemId),
});
export type SubmitDraftInput = typeof SubmitDraftInput.Type;

/** The writer's answer to a rewrite request. */
export const ReviseDraftInput = Schema.Struct({
  draftId: DraftId,
  text: TrimmedNonEmptyString,
});
export type ReviseDraftInput = typeof ReviseDraftInput.Type;

/** The notes and approved examples a writer loads before drafting. */
export const DraftGuideInput = Schema.Struct({
  missionId: MissionId,
  channel: DraftChannel,
  audience: TrimmedNonEmptyString,
});
export type DraftGuideInput = typeof DraftGuideInput.Type;

/** A proposed change; the author is resolved from the caller. */
export const ProposeSuggestionInput = Schema.Struct({
  missionId: Schema.NullOr(MissionId),
  targetKind: SuggestionTargetKind,
  target: Schema.optional(Schema.NullOr(MissionRecordRef)),
  title: TrimmedNonEmptyString,
  before: Schema.optional(Schema.Unknown),
  after: Schema.Unknown,
  diffText: Schema.String,
  why: TrimmedNonEmptyString,
  evidence: Schema.Array(Schema.Union([MissionRecordRef, MissionLink])),
  acceptor: Schema.optional(Schema.Literals(["owner", "master"])),
});
export type ProposeSuggestionInput = typeof ProposeSuggestionInput.Type;
