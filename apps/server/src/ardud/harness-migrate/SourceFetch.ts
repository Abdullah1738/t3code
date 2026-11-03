/**
 * Reads one OpenCode session's context and reports what would block a migration.
 *
 * Reads only: no write, no cancel, no prompt. The context records go to the pure
 * SourceSnapshot reader. Blockers stop a migration before anything is staged:
 * a busy session, pending inbox or form work, or a live child. A failed read is
 * a typed error, never an empty snapshot, because an empty snapshot would look
 * like a valid migration with nothing to carry over.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { OpenCodeHttpError, type OpenCodeConnection } from "../opencode-import/OpenCodeHttp.ts";
import { buildSourceSnapshot, type SourceSnapshot } from "./SourceSnapshot.ts";

/**
 * One authenticated GET, typed by the caller's decoder. Kept here instead of
 * `getJson` in OpenCodeHttp.ts because that helper always provides the real fetch
 * client, so a test couldn't substitute the transport. Same status and error
 * behaviour: any non-2xx is an OpenCodeHttpError.
 */
const getJson = <A>(
  connection: OpenCodeConnection,
  path: string,
  operation: string,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${connection.baseUrl}${path}`).pipe(
        HttpClientRequest.setHeader("authorization", connection.authorization),
        HttpClientRequest.acceptJson,
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenCodeHttpError({ operation, status: response.status });
    }
    return yield* decode(yield* response.json);
  }).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.fail(new OpenCodeHttpError({ operation: `${operation} (timed out)` })),
    }),
    Effect.mapError((cause) =>
      isOpenCodeHttpError(cause) ? cause : new OpenCodeHttpError({ operation, cause }),
    ),
  );

const ContextPage = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const ListPage = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const ActivePage = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) });
const SessionPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
  cursor: Schema.Struct({ next: Schema.optional(Schema.String) }),
});

const decodeContext = Schema.decodeUnknownEffect(ContextPage);
const decodeList = Schema.decodeUnknownEffect(ListPage);
const decodeActive = Schema.decodeUnknownEffect(ActivePage);
const decodeSessions = Schema.decodeUnknownEffect(SessionPage);

export interface SourceFetchResult {
  readonly records: ReadonlyArray<unknown>;
  readonly snapshot: SourceSnapshot;
  /** Each reason a migration of this session must wait. Empty means it may proceed. */
  readonly blockers: ReadonlyArray<string>;
}

/**
 * Fetches a session's context and the state that would block its migration.
 * Fails with OpenCodeHttpError if any read fails; never returns a partial result.
 */
const isOpenCodeHttpError = Schema.is(OpenCodeHttpError);

export const fetchSource = (connection: OpenCodeConnection, sessionId: string) =>
  Effect.gen(function* () {
    const session = encodeURIComponent(sessionId);
    const context = yield* getJson(
      connection,
      `/api/session/${session}/context`,
      "read session context",
      (input) => decodeContext(input),
    );
    const inbox = yield* getJson(
      connection,
      `/api/session/${session}/inbox`,
      "read session inbox",
      (input) => decodeList(input),
    );
    const forms = yield* getJson(
      connection,
      `/api/session/${session}/form`,
      "read session forms",
      (input) => decodeList(input),
    );
    const active = yield* getJson(
      connection,
      "/api/session/active",
      "read active sessions",
      (input) => decodeActive(input),
    );
    const children: Array<{ readonly id: string }> = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      // The opaque cursor carries the original parent filter.
      const query =
        cursor === undefined
          ? `parentID=${encodeURIComponent(sessionId)}&limit=100`
          : `limit=100&cursor=${encodeURIComponent(cursor)}`;
      const page = yield* getJson(
        connection,
        `/api/session?${query}`,
        "read child sessions",
        (input) => decodeSessions(input),
      );
      children.push(...page.data);
      const next = page.cursor.next;
      if (next === undefined) break;
      if (next.trim().length === 0 || page.data.length === 0 || seenCursors.has(next)) {
        return yield* new OpenCodeHttpError({ operation: "read child sessions (invalid cursor)" });
      }
      seenCursors.add(next);
      cursor = next;
    }

    const blockers: Array<string> = [];
    if (Object.prototype.hasOwnProperty.call(active.data, sessionId)) {
      blockers.push("opencode session busy");
    }
    if (inbox.data.length > 0) {
      blockers.push("inbox not empty");
    }
    if (forms.data.length > 0) {
      blockers.push("form pending");
    }
    // A child that is still listed as active is live work. Children that are
    // inactive have finished, so they don't block.
    for (const child of children) {
      if (Object.prototype.hasOwnProperty.call(active.data, child.id)) {
        blockers.push(`live child ${child.id}`);
      }
    }

    const snapshot = buildSourceSnapshot({ records: context.data });
    return { records: context.data, snapshot, blockers } satisfies SourceFetchResult;
  }).pipe(
    Effect.mapError((cause) =>
      isOpenCodeHttpError(cause)
        ? cause
        : new OpenCodeHttpError({ operation: "fetch source", cause }),
    ),
  );
