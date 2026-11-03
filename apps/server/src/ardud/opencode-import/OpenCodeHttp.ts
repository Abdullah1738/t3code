/**
 * Access to the shared OpenCode 2 service over its HTTP API.
 * Lenient decoding, so fields an older or newer server adds or drops do not
 * break the import.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as ServerSettings from "../../serverSettings.ts";

export class OpenCodeHttpError extends Schema.TaggedError<OpenCodeHttpError>()(
  "OpenCodeHttpError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `OpenCode request failed: ${this.operation}.`
      : `OpenCode request failed: ${this.operation} (HTTP ${this.status}).`;
  }
}

const isOpenCodeHttpError = Schema.is(OpenCodeHttpError);

export interface OpenCodeConnection {
  readonly baseUrl: string;
  readonly authorization: string;
}

const Millis = Schema.Number;

const ModelRef = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: Schema.optional(Schema.String),
});

export const OpenCodeSession = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optional(Schema.NullOr(Schema.String)),
  projectID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  model: Schema.optional(ModelRef),
  time: Schema.Struct({
    created: Millis,
    updated: Millis,
    archived: Schema.optional(Millis),
  }),
  location: Schema.Struct({ directory: Schema.String }),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type OpenCodeSession = typeof OpenCodeSession.Type;

export const OpenCodeProject = Schema.Struct({
  id: Schema.String,
  canonical: Schema.String,
});
export type OpenCodeProject = typeof OpenCodeProject.Type;

const ToolState = Schema.Struct({
  status: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(
      Schema.Struct({ type: Schema.optional(Schema.String), text: Schema.optional(Schema.String) }),
    ),
  ),
  metadata: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

export const OpenCodePart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  state: Schema.optional(ToolState),
});
export type OpenCodePart = typeof OpenCodePart.Type;

export const OpenCodeMessage = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(OpenCodePart)),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  /** ardud: why an assistant turn ended, e.g. "stop" for a normal finish. */
  finish: Schema.optional(Schema.String),
  /** ardud: set once the turn has completed; a child result needs it. */
  time: Schema.Struct({ created: Millis, completed: Schema.optional(Millis) }),
  /** ardud: an idle message records how the run ended, e.g. "succeeded". */
  outcome: Schema.optional(Schema.String),
});
export type OpenCodeMessage = typeof OpenCodeMessage.Type;

const pageOf = <A extends Schema.Top>(item: A) =>
  Schema.Struct({
    data: Schema.Array(item),
    cursor: Schema.optional(
      Schema.NullOr(Schema.Struct({ next: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  });

const decodeServiceFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String, password: Schema.String })),
);
const decodeSessionPageSchema = Schema.decodeUnknownEffect(pageOf(OpenCodeSession));
const decodeMessagePageSchema = Schema.decodeUnknownEffect(pageOf(OpenCodeMessage));
const decodeProjectsSchema = Schema.decodeUnknownEffect(Schema.Array(OpenCodeProject));
const decodeSessionPage = (input: unknown) => decodeSessionPageSchema(input);
const decodeMessagePage = (input: unknown) => decodeMessagePageSchema(input);
const decodeProjects = (input: unknown) => decodeProjectsSchema(input);
const decodeModelsSchema = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Array(Schema.Struct({ id: Schema.String, providerID: Schema.String })),
  }),
);
const decodeModels = (input: unknown) => decodeModelsSchema(input);
const decodeActiveSchema = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeActive = (input: unknown) => decodeActiveSchema(input);

const basic = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

/**
 * Server URL and password of the opencode provider instance (the default
 * `opencode` slot first), when both are set. Instance config is driver-owned
 * and untyped here, so read it defensively.
 */
const openCodeServerConfig = (
  instances: Readonly<Record<string, { readonly driver: string; readonly config?: unknown }>>,
) => {
  const candidates = [
    instances["opencode"],
    ...Object.values(instances).filter((instance) => instance.driver === "opencode"),
  ];
  for (const instance of candidates) {
    if (instance === undefined || instance.driver !== "opencode") continue;
    const config = instance.config;
    if (config === null || typeof config !== "object") continue;
    const { serverUrl, serverPassword } = config as Record<string, unknown>;
    if (
      typeof serverUrl === "string" &&
      typeof serverPassword === "string" &&
      serverUrl.trim().length > 0 &&
      serverPassword.length > 0
    ) {
      return { serverUrl: serverUrl.trim(), serverPassword };
    }
  }
  return undefined;
};

/**
 * ardud: the OpenCode server the opencode provider is configured to use, when
 * it runs as its own service. A server Robob starts itself has none here.
 */
export type ConfiguredConnection =
  // ardud: confirmed local: settings read, no external OpenCode server configured.
  | { readonly kind: "local" }
  | { readonly kind: "external"; readonly connection: OpenCodeConnection }
  // ardud: settings unreadable, timed out, or an external URL without a password.
  | { readonly kind: "unknown" };

const SETTINGS_READ_TIMEOUT = "2 seconds";

export const configuredConnection = (
  settings: ServerSettings.ServerSettingsService["Service"],
  providerInstanceId?: string,
): Effect.Effect<ConfiguredConnection> =>
  settings.getSettings.pipe(
    Effect.timeoutOption(SETTINGS_READ_TIMEOUT),
    Effect.map((read): ConfiguredConnection => {
      if (read._tag === "None") return { kind: "unknown" };
      const allInstances: Readonly<
        Record<string, { readonly driver: string; readonly config?: unknown }>
      > = read.value.providerInstances;
      // ardud: an interrupt must target the instance that owns this session, not
      // whichever OpenCode server happens to be configured first.
      const instance =
        providerInstanceId === undefined ? undefined : allInstances[providerInstanceId];
      if (
        providerInstanceId !== undefined &&
        (instance === undefined || instance.driver !== "opencode")
      ) {
        return { kind: "unknown" };
      }
      const instances =
        providerInstanceId === undefined ? allInstances : { [providerInstanceId]: instance! };
      const opencode = openCodeServerConfig(instances);
      if (opencode !== undefined) {
        return {
          kind: "external",
          connection: {
            baseUrl: opencode.serverUrl.replace(/\/+$/, ""),
            authorization: basic(opencode.serverPassword),
          },
        };
      }
      const hasUrlWithoutPassword = Object.values(instances).some(
        (instance) =>
          instance.driver === "opencode" &&
          typeof (instance.config as Record<string, unknown> | undefined)?.serverUrl === "string",
      );
      return hasUrlWithoutPassword ? { kind: "unknown" } : { kind: "local" };
    }),
    Effect.orElseSucceed((): ConfiguredConnection => ({ kind: "unknown" })),
  );

/**
 * The OpenCode server to read: the opencode provider's configured server URL
 * and password, else the local shared service's `service.json`.
 */
export const resolveConnection = (input: {
  readonly settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
  readonly homeDir: string;
}) =>
  Effect.gen(function* () {
    if (Option.isSome(input.settings)) {
      const settings = yield* input.settings.value.getSettings.pipe(Effect.option);
      if (Option.isSome(settings)) {
        const opencode = openCodeServerConfig(settings.value.providerInstances);
        if (opencode !== undefined) {
          return {
            baseUrl: opencode.serverUrl.replace(/\/+$/, ""),
            authorization: basic(opencode.serverPassword),
          } satisfies OpenCodeConnection;
        }
      }
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(input.homeDir, ".local", "state", "opencode", "service.json");
    const service = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeServiceFile),
      Effect.mapError((cause) => new OpenCodeHttpError({ operation: "read service file", cause })),
    );
    return {
      baseUrl: service.url.replace(/\/+$/, ""),
      authorization: basic(service.password),
    } satisfies OpenCodeConnection;
  });

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
    Effect.provide(FetchHttpClient.layer),
  );

// ardud: abort only needs the status, not the response body.
const post = (connection: OpenCodeConnection, path: string, operation: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${connection.baseUrl}${path}`).pipe(
        HttpClientRequest.setHeader("authorization", connection.authorization),
        HttpClientRequest.acceptJson,
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenCodeHttpError({ operation, status: response.status });
    }
  }).pipe(
    Effect.mapError((cause) =>
      isOpenCodeHttpError(cause) ? cause : new OpenCodeHttpError({ operation, cause }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
};

// ardud: OpenCode 2 interrupts an execution by session ID, without a location query.
export const abortSession = (connection: OpenCodeConnection, sessionId: string) =>
  post(connection, `/api/session/${encodeURIComponent(sessionId)}/interrupt`, "interrupt session");

/**
 * Pages a list newest first. `keepGoing` sees each page and can stop early;
 * later requests send only the cursor, which carries the original filters.
 */
const pageNewestFirst = <A>(input: {
  readonly connection: OpenCodeConnection;
  readonly path: string;
  readonly first: Record<string, string | number | undefined>;
  readonly operation: string;
  readonly decode: (input: unknown) => Effect.Effect<
    {
      readonly data: ReadonlyArray<A>;
      readonly cursor?: { readonly next?: string | null | undefined } | null | undefined;
    },
    Schema.SchemaError
  >;
  readonly keepGoing: (page: ReadonlyArray<A>, collected: number) => boolean;
}) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = yield* getJson(
        input.connection,
        `${input.path}?${query(cursor === undefined ? input.first : { limit: input.first.limit, cursor })}`,
        input.operation,
        input.decode,
      );
      items.push(...page.data);
      cursor = page.cursor?.next ?? undefined;
      if (
        page.data.length === 0 ||
        cursor === undefined ||
        !input.keepGoing(page.data, items.length)
      ) {
        return items;
      }
    }
  });

/** Root sessions, newest first. `updatedSince` stops paging once pages get older. */
export const listRootSessions = (
  connection: OpenCodeConnection,
  options: { readonly updatedSince?: number } = {},
) =>
  pageNewestFirst({
    connection,
    path: "/api/session",
    first: { limit: 500, parentID: "null", order: "desc" },
    operation: "list sessions",
    decode: decodeSessionPage,
    keepGoing: (page) =>
      options.updatedSince === undefined ||
      page.some((session) => session.time.updated >= options.updatedSince!),
  }).pipe(
    Effect.map((sessions) =>
      sessions.filter(
        (session) =>
          (session.parentID === undefined || session.parentID === null) &&
          (options.updatedSince === undefined || session.time.updated >= options.updatedSince),
      ),
    ),
  );

/** ardud: ids of the sessions OpenCode is running a turn in right now. */
export const listActiveSessionIds = (connection: OpenCodeConnection) =>
  getJson(connection, "/api/session/active", "list active sessions", decodeActive).pipe(
    Effect.map((active) => new Set(Object.keys(active.data))),
  );

export const listProjects = (connection: OpenCodeConnection) =>
  getJson(connection, "/api/project", "list projects", decodeProjects);

/** `provider/model` slugs OpenCode can run now, as seen from `directory`. */
export const listModelSlugs = (connection: OpenCodeConnection, directory: string) =>
  getJson(
    connection,
    `/api/model?${query({ "location[directory]": directory })}`,
    "list models",
    decodeModels,
  ).pipe(Effect.map((models) => new Set(models.data.map((m) => `${m.providerID}/${m.id}`))));

/**
 * Up to `limit` of the session's newest messages, oldest first, stopping at
 * `afterId` when given. `truncated` means older messages were left out.
 */
export const listRecentMessages = (
  connection: OpenCodeConnection,
  sessionId: string,
  options: { readonly limit: number; readonly afterId?: string },
) =>
  Effect.gen(function* () {
    const fetched = yield* pageNewestFirst({
      connection,
      path: `/api/session/${encodeURIComponent(sessionId)}/message`,
      first: { limit: Math.min(100, options.limit + 1), order: "desc" },
      operation: "list messages",
      decode: decodeMessagePage,
      keepGoing: (page, collected) =>
        collected <= options.limit &&
        (options.afterId === undefined || !page.some((message) => message.id === options.afterId)),
    });
    const afterIndex =
      options.afterId === undefined
        ? -1
        : fetched.findIndex((message) => message.id === options.afterId);
    const newer = afterIndex >= 0 ? fetched.slice(0, afterIndex) : fetched;
    const kept = newer.slice(0, options.limit);
    return { messages: kept.toReversed(), truncated: newer.length > kept.length };
  });
