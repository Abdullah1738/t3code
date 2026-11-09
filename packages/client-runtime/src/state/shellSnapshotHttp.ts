import {
  EnvironmentHttpCommonError,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, type HttpClientResponse } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import {
  decodeShellSnapshotDeferringPullRequests,
  type DeferredShellSnapshot,
} from "./shellPullRequests.ts";

// On timeout the socket asks the same server for the same pages, so a
// short deadline only throws the first build away. The socket fallback is for
// setups where /api fails but /ws works, such as a proxy that blocks /api.
const DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS = 20_000;
// A page that times out is asked for again with a longer deadline: page time on a busy
// server is reader queueing, and throwing the load away restarted it from page one.
const SHELL_PAGE_ATTEMPTS = 3;
// Progress kept across reconnects is reused only while it is this fresh; replaying the
// events since an older first page costs about as much as a new load.
export const SHELL_LOAD_RESUME_MAX_AGE_MS = 5 * 60_000;

/** Pages a paged load has delivered so far, and the cursor to continue from. */
export interface ShellLoadProgress {
  readonly pages: ReadonlyArray<DeferredShellSnapshot>;
  readonly nextAfter: string;
  readonly updatedAt: number;
}

export const fetchEnvironmentShellSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentShellSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
  readonly onPage?: (snapshot: DeferredShellSnapshot) => Effect.Effect<void>;
  /** Continue an interrupted load from its last delivered cursor. */
  readonly resume?: ShellLoadProgress;
  /** Called after every page that leaves the load unfinished. */
  readonly onProgress?: (progress: ShellLoadProgress) => Effect.Effect<void>;
  readonly pageAttempts?: number;
}) {
  const baseTimeoutMs = input.timeoutMs ?? DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS;
  const fetchPageOnce = (after: string | undefined, timeoutMs: number) =>
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "orchestration",
      method: "GET",
      url: (urls) =>
        urls.shellSnapshot({ query: { paged: "true", ...(after === undefined ? {} : { after }) } }),
      timeoutMs,
      request: ({ client, headers }) =>
        client
          .shellSnapshot({
            query: { paged: "true", ...(after === undefined ? {} : { after }) },
            headers: withOrchestrationProtocolHeader(headers),
            responseMode: "response-only",
          })
          .pipe(Effect.flatMap(decodeShellSnapshotResponse)),
    });
  const attempts = Math.max(1, input.pageAttempts ?? SHELL_PAGE_ATTEMPTS);
  const fetchPage = (after?: string) => {
    const attempt = (n: number): ReturnType<typeof fetchPageOnce> =>
      n + 1 >= attempts
        ? fetchPageOnce(after, baseTimeoutMs * (n + 1))
        : fetchPageOnce(after, baseTimeoutMs * (n + 1)).pipe(
            // Only a timeout says "busy, ask again"; other failures repeat themselves.
            Effect.catchTag("RemoteEnvironmentAuthTimeoutError", () => attempt(n + 1)),
          );
    return attempt(0);
  };
  const pages: DeferredShellSnapshot[] = [...(input.resume?.pages ?? [])];
  const seen = new Set<string>(input.resume === undefined ? [] : [input.resume.nextAfter]);
  let snapshot = yield* fetchPage(input.resume?.nextAfter);
  pages.push(snapshot);
  while (snapshot.page?.nextAfter != null) {
    const after = snapshot.page.nextAfter;
    if (input.onProgress)
      yield* input.onProgress({
        pages: [...pages],
        nextAfter: after,
        updatedAt: yield* Clock.currentTimeMillis,
      });
    if (input.onPage) yield* input.onPage(mergeHttpShellPages(pages));
    if (seen.has(after))
      return yield* Effect.die(new Error("Shell snapshot cursor did not advance."));
    seen.add(after);
    snapshot = yield* fetchPage(after);
    pages.push(snapshot);
  }
  return mergeHttpShellPages(pages);
});

/**
 * The current server reads each page in a separate transaction. Keep the earliest
 * sequence for replay; M3 must pin pages to a server snapshot epoch/watermark.
 * page.nextAfter explicitly marks cumulative partial coverage until the final page.
 * Cumulative pages use after:null: each one restarts the reducer's page coverage, and the
 * complete result replaces stale cached membership (partial ones keep unreached rows).
 */
export function mergeHttpShellPages(
  pages: ReadonlyArray<DeferredShellSnapshot>,
): DeferredShellSnapshot {
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  const { page: _page, ...base } = first;
  return {
    ...base,
    ...(last.page ? { page: { ...last.page, after: null } } : {}),
    threads: [
      ...new Map(
        pages.flatMap((page) => page.threads.map((thread) => [thread.id, thread] as const)),
      ).values(),
    ],
    snapshotSequence: Math.min(...pages.map((page) => page.snapshotSequence)),
    loadPullRequests: Effect.all(
      pages.map(
        (page) =>
          page.loadPullRequests ??
          Effect.succeed(new Map<ThreadId, ReadonlyArray<ThreadPullRequestLink>>()),
      ),
      { concurrency: 1 },
    ).pipe(Effect.map((maps) => new Map(maps.flatMap((map) => [...map])))),
  };
}

const decodeEnvironmentHttpCommonError = Schema.decodeUnknownEffect(
  Schema.toCodecJson(EnvironmentHttpCommonError),
);

const decodeShellSnapshotResponse = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  DeferredShellSnapshot,
  HttpClientError.HttpClientError | Schema.SchemaError | EnvironmentHttpCommonError
> => {
  if (response.status === 200) {
    return response.json.pipe(Effect.flatMap(decodeShellSnapshotDeferringPullRequests));
  }
  const statusError = new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request: response.request, response }),
  });
  return response.json.pipe(
    Effect.flatMap(decodeEnvironmentHttpCommonError),
    Effect.matchEffect({
      onFailure: () => Effect.fail(statusError),
      onSuccess: Effect.fail,
    }),
  );
};

export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      onPage?: (snapshot: DeferredShellSnapshot) => Effect.Effect<void>,
    ) => Effect.Effect<Option.Option<DeferredShellSnapshot>>;
  }
>()("@t3tools/client-runtime/state/shellSnapshotHttp/ShellSnapshotLoader") {}

export const layer: Layer.Layer<ShellSnapshotLoader, never, HttpClient.HttpClient> = Layer.effect(
  ShellSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it.
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    // Survives a session change or a failed load, so the next load continues from the
    // last delivered cursor instead of page one. Keyed by server build: an upgrade can
    // rewrite projections without new events, so its pages must be read again.
    const progressByConnection = new Map<string, ShellLoadProgress>();
    const progressKey = (prepared: PreparedConnection) =>
      [
        prepared.environmentId,
        prepared.httpBaseUrl,
        prepared.verifiedDescriptor?.descriptor.serverVersion ?? "",
      ].join("\u001f");
    return ShellSnapshotLoader.of({
      load: Effect.fnUntraced(function* (prepared: PreparedConnection, onPage) {
        const key = progressKey(prepared);
        const saved = progressByConnection.get(key);
        const now = yield* Clock.currentTimeMillis;
        const resume =
          saved !== undefined && now - saved.updatedAt <= SHELL_LOAD_RESUME_MAX_AGE_MS
            ? saved
            : undefined;
        progressByConnection.delete(key);
        return yield* fetchEnvironmentShellSnapshot({
          prepared,
          signer,
          remoteAuthorization,
          ...(onPage ? { onPage } : {}),
          ...(resume ? { resume } : {}),
          onProgress: (progress) =>
            Effect.sync(() => {
              progressByConnection.set(key, progress);
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              progressByConnection.delete(key);
            }),
          ),
          Effect.map(Option.some<DeferredShellSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<DeferredShellSnapshot>()),
            ),
          ),
        );
      }),
    });
  }),
);
