/**
 * Named component credentials.
 *
 * Every integration used to share one admin control token, so the server
 * could not tell crw from the iMessage bridge, and the token could mint
 * pairing links. A component credential is a bearer session with only the
 * scopes that component uses and an origin row naming the component, written
 * before the token is printed. Missions code reads that row (never a header
 * or a body field) to act as `{_tag: "system", component}`.
 *
 * The shared control token keeps working until the owner swaps each caller
 * over (CUTOVER-NOTES, "Control token scope").
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { COMPONENT_SUBJECT_PREFIX, SessionOrigins } from "./SessionOrigins.ts";

export interface ComponentSpec {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly description: string;
}

const READ_OPERATE = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

/**
 * Every caller of the control API. None needs more than
 * orchestration read/operate, so none can mint pairing links or sessions.
 */
export const COMPONENTS: Readonly<Record<string, ComponentSpec>> = {
  "spectrum-bridge": {
    scopes: READ_OPERATE,
    description: "iMessage bridge: owner threads, sends, attachments.",
  },
  "telegram-bridge": {
    scopes: READ_OPERATE,
    description: "Telegram bridge: pending requests, answers.",
  },
  "stream-recovery": {
    scopes: READ_OPERATE,
    description: "Stalled-run recovery: sends, interrupts, queue over WS.",
  },
  crw: {
    scopes: READ_OPERATE,
    description: "PR review workflow: its own threads, review plans, records, holds, approvals.",
  },
  coord: { scopes: READ_OPERATE, description: "coord pump and forward mode." },
  "harness-hooks": {
    scopes: [AuthOrchestrationReadScope],
    description: "Claude Code/Codex hooks: identity and thread reads.",
  },
  memory: { scopes: READ_OPERATE, description: "memory-system session reaper." },
  rcsim: { scopes: READ_OPERATE, description: "Run Cloud sim monitor nudges." },
  offbox: { scopes: READ_OPERATE, description: "offbox-monitor load nudges." },
  watchers: {
    scopes: READ_OPERATE,
    description: "robob-watch watchers calling t3ctl (lane-pulse, codex-reset-announce).",
  },
  "device-enroll": { scopes: READ_OPERATE, description: "Device enrollment link sender." },
  "coord-guard": {
    scopes: [AuthOrchestrationReadScope],
    description: "coord-guard OpenCode plugin: thread reads.",
  },
  t3ctl: { scopes: READ_OPERATE, description: "Agents and scripts running t3ctl by hand." },
};

export const DEFAULT_COMPONENT_TOKEN_TTL = Duration.days(365);

export class UnknownComponentError extends Schema.TaggedError<UnknownComponentError>()(
  "UnknownComponentError",
  { component: Schema.String },
) {
  override get message(): string {
    return `Unknown component "${this.component}". Known: ${Object.keys(COMPONENTS).join(", ")}.`;
  }
}

export const componentSpec = (component: string): ComponentSpec | null =>
  Object.hasOwn(COMPONENTS, component) ? (COMPONENTS[component] ?? null) : null;

/**
 * Issues a component's bearer token. The origin row is written before the
 * token is returned, so the first request with it is already the component.
 */
export const issueComponentSession = (input: {
  readonly component: string;
  readonly ttl?: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const spec = componentSpec(input.component);
    if (spec === null) return yield* new UnknownComponentError({ component: input.component });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const origins = yield* SessionOrigins;
    const issued = yield* auth.issueSession({
      subject: `${COMPONENT_SUBJECT_PREFIX}${input.component}`,
      scopes: spec.scopes,
      label: `component ${input.component}`,
      ttl: input.ttl ?? DEFAULT_COMPONENT_TOKEN_TTL,
    });
    yield* origins.record(issued.sessionId, { _tag: "component", component: input.component }).pipe(
      // Without its row the token is a plain session; never hand that out.
      Effect.tapError(() => auth.revokeSession(issued.sessionId).pipe(Effect.ignore)),
    );
    return issued;
  });

/** Active component sessions, newest first. */
export const listComponentSessions = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const origins = yield* SessionOrigins;
  const active = new Map(
    (yield* auth.listSessions()).map((session) => [session.sessionId, session]),
  );
  return (yield* origins.componentSessions()).flatMap((row) => {
    const session = active.get(row.sessionId as EnvironmentAuth.AuthenticatedSession["sessionId"]);
    return session === undefined
      ? []
      : [
          {
            component: row.component,
            sessionId: session.sessionId,
            scopes: session.scopes,
            expiresAt: session.expiresAt,
            lastConnectedAt: session.lastConnectedAt,
          },
        ];
  });
});
