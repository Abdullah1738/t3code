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

import { ShellLoadJournal } from "../ardud/shellLoadJournal.ts";
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

/**
 * Ask the server to leave out subagents idle for a week with no live descendant. Only clients
 * whose screens never list such rows (the web sidebar) turn it on; they stay readable by id.
 */
export const OmitIdleSubagents = Context.Reference<boolean>(
  "@t3tools/client-runtime/state/shellSnapshotHttp/OmitIdleSubagents",
  { defaultValue: () => false },
);

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
  /** The body of each page that leaves the load unfinished, numbered from the load's start. */
  readonly onPageBody?: (page: {
    readonly index: number;
    readonly body: string;
    readonly nextAfter: string;
    readonly updatedAt: number;
  }) => Effect.Effect<void>;
  readonly pageAttempts?: number;
  readonly omitIdleSubagents?: boolean;
}) {
  const baseTimeoutMs = input.timeoutMs ?? DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS;
  const query = (after: string | undefined) => ({
    paged: "true",
    // The first page is then the most recently updated threads; the cursor it returns
    // starts the full walk. A server that does not know the option pages by id as before.
    recentFirst: "true",
    ...(after === undefined ? {} : { after }),
    ...(input.omitIdleSubagents === true ? { omitIdleSubagents: "true" } : {}),
  });
  const fetchPageOnce = (after: string | undefined, timeoutMs: number) =>
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "orchestration",
      method: "GET",
      url: (urls) => urls.shellSnapshot({ query: query(after) }),
      timeoutMs,
      request: ({ client, headers }) =>
        client
          .shellSnapshot({
            query: query(after),
            headers: withOrchestrationProtocolHeader(headers),
            responseMode: "response-only",
          })
          .pipe(Effect.flatMap(decodeShellSnapshotResponseWithBody)),
    });
  const attempts = Math.max(1, input.pageAttempts ?? SHELL_PAGE_ATTEMPTS);
  const fetchPage = (after?: string) => {
    const attempt = (n: number): ReturnType<typeof fetchPageOnce> =>
      n + 1 >= attempts
        ? fetchPageOnce(after, baseTimeoutMs * (n + 1))
        : fetchPageOnce(after, baseTimeoutMs * (n + 1)).pipe(
            // Only a timeout says "busy, ask again"; other failures repeat themselves.
            Effect.catchTags({ RemoteEnvironmentAuthTimeoutError: () => attempt(n + 1) }),
          );
    return attempt(0);
  };
  // Rows merge into one map as pages land, so a page costs its own rows plus one list of
  // the rows so far; merging every page again on each page grew with the square of the list.
  const merged = makeShellPageAccumulator(input.resume?.pages ?? []);
  const seen = new Set<string>(input.resume === undefined ? [] : [input.resume.nextAfter]);
  let { snapshot, body } = yield* fetchPage(input.resume?.nextAfter);
  merged.add(snapshot);
  while (snapshot.page?.nextAfter != null) {
    const after = snapshot.page.nextAfter;
    const updatedAt = yield* Clock.currentTimeMillis;
    if (input.onPageBody)
      yield* input.onPageBody({ index: merged.pages.length - 1, body, nextAfter: after, updatedAt });
    if (input.onProgress)
      yield* input.onProgress({ pages: [...merged.pages], nextAfter: after, updatedAt });
    if (input.onPage) yield* input.onPage(merged.snapshot());
    if (seen.has(after))
      return yield* Effect.die(new Error("Shell snapshot cursor did not advance."));
    seen.add(after);
    ({ snapshot, body } = yield* fetchPage(after));
    merged.add(snapshot);
  }
  return merged.snapshot();
});

/**
 * Merges pages one at a time into what `mergeHttpShellPages` returns for all of them. Page
 * bodies are not kept: each page keeps only its decoded rows and its deferred links.
 */
function makeShellPageAccumulator(initial: ReadonlyArray<DeferredShellSnapshot>) {
  const pages: DeferredShellSnapshot[] = [];
  const rows = new Map<ThreadId, DeferredShellSnapshot["threads"][number]>();
  let snapshotSequence = Number.POSITIVE_INFINITY;
  const add = (page: DeferredShellSnapshot) => {
    pages.push(page);
    // A later page's copy of a row wins and keeps the first copy's place, as in
    // mergeHttpShellPages.
    for (const thread of page.threads) rows.set(thread.id, thread);
    snapshotSequence = Math.min(snapshotSequence, page.snapshotSequence);
  };
  for (const page of initial) add(page);
  return {
    pages: pages as ReadonlyArray<DeferredShellSnapshot>,
    add,
    snapshot: (): DeferredShellSnapshot => {
      const first = pages[0]!;
      const last = pages[pages.length - 1]!;
      const { page: _page, ...base } = first;
      const loaders = pages.map((page) => page.loadPullRequests);
      return {
        ...base,
        ...(last.page ? { page: { ...last.page, after: null } } : {}),
        threads: [...rows.values()],
        snapshotSequence,
        loadPullRequests: Effect.suspend(() =>
          Effect.forEach(
            loaders,
            (load) =>
              load ?? Effect.succeed(new Map<ThreadId, ReadonlyArray<ThreadPullRequestLink>>()),
            { concurrency: 1 },
          ),
        ).pipe(Effect.map((maps) => new Map(maps.flatMap((map) => [...map])))),
      };
    },
  };
}

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

/** Decodes a shell page and keeps its body text for a ShellLoadJournal. */
const decodeShellSnapshotResponseWithBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  { readonly snapshot: DeferredShellSnapshot; readonly body: string },
  HttpClientError.HttpClientError | Schema.SchemaError | EnvironmentHttpCommonError
> => {
  if (response.status === 200) {
    // `json` parses the text `text` already read; the body is fetched once.
    return response.text.pipe(
      Effect.flatMap((body) =>
        response.json.pipe(
          Effect.flatMap(decodeShellSnapshotDeferringPullRequests),
          Effect.map((snapshot) => ({ snapshot, body })),
        ),
      ),
    );
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

export interface ShellLoadOptions {
  /**
   * The build of the server the session reached. Saved progress is only reused on the same
   * build: an upgrade can rewrite projections without new events. Primary connections have
   * no verified descriptor, so the session's config is the only place this is known.
   */
  readonly serverVersion?: string;
}

export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      onPage?: (snapshot: DeferredShellSnapshot) => Effect.Effect<void>,
      options?: ShellLoadOptions,
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
    // ardud: pages on disk too, so a client that died mid-load resumes (shellLoadJournal.ts).
    const journal = yield* Effect.serviceOption(ShellLoadJournal);
    // Survives a session change or a failed load, so the next load continues from the
    // last delivered cursor instead of page one. Keyed by server build: an upgrade can
    // rewrite projections without new events, so its pages must be read again.
    const progressByConnection = new Map<
      string,
      { readonly progress: ShellLoadProgress; readonly loadId: string }
    >();
    const serverVersionOf = (prepared: PreparedConnection, options: ShellLoadOptions | undefined) =>
      options?.serverVersion ?? prepared.verifiedDescriptor?.descriptor.serverVersion ?? "";
    const progressKey = (
      prepared: PreparedConnection,
      omitIdleSubagents: boolean,
      serverVersion: string,
    ) =>
      [
        prepared.environmentId,
        prepared.httpBaseUrl,
        serverVersion,
        omitIdleSubagents ? "omit-idle-subagents" : "",
      ].join("\u001f");
    const newLoadId = Effect.map(
      Clock.currentTimeMillis,
      (now) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    );
    // A journal from an earlier client: same key, still fresh, every page readable, and the
    // last page's cursor is the one recorded. Anything else starts over.
    const resumeFromJournal = Effect.fnUntraced(function* (
      prepared: PreparedConnection,
      key: string,
      serverVersion: string,
      now: number,
    ) {
      if (Option.isNone(journal)) return undefined;
      // Without a known server build, an upgrade could hand back pages it rewrote.
      if (serverVersion === "") return undefined;
      const stored = yield* journal.value.read(prepared.environmentId);
      if (Option.isNone(stored)) return undefined;
      const { value } = stored;
      if (value.key !== key || now - value.updatedAt > SHELL_LOAD_RESUME_MAX_AGE_MS) {
        yield* journal.value.clear(prepared.environmentId);
        return undefined;
      }
      const pages = yield* Effect.forEach(value.bodies, (body) =>
        Effect.try({ try: () => JSON.parse(body) as unknown, catch: (cause) => cause }).pipe(
          Effect.flatMap(decodeShellSnapshotDeferringPullRequests),
        ),
      ).pipe(Effect.option);
      if (
        Option.isNone(pages) ||
        pages.value[pages.value.length - 1]?.page?.nextAfter !== value.nextAfter
      ) {
        yield* journal.value.clear(prepared.environmentId);
        return undefined;
      }
      return {
        progress: { pages: pages.value, nextAfter: value.nextAfter, updatedAt: value.updatedAt },
        loadId: value.loadId,
      };
    });
    return ShellSnapshotLoader.of({
      load: Effect.fnUntraced(function* (prepared: PreparedConnection, onPage, options) {
        const omitIdleSubagents = yield* OmitIdleSubagents;
        const serverVersion = serverVersionOf(prepared, options);
        const key = progressKey(prepared, omitIdleSubagents, serverVersion);
        const saved = progressByConnection.get(key);
        const now = yield* Clock.currentTimeMillis;
        const inMemory =
          saved !== undefined && now - saved.progress.updatedAt <= SHELL_LOAD_RESUME_MAX_AGE_MS
            ? saved
            : undefined;
        // Valid progress stays until the load finishes or newer progress replaces it, so a
        // resumed load that fails before its next page still resumes next time.
        if (saved !== undefined && inMemory === undefined) progressByConnection.delete(key);
        const resumed = inMemory ?? (yield* resumeFromJournal(prepared, key, serverVersion, now));
        const resume = resumed?.progress;
        const loadId = resumed?.loadId ?? (yield* newLoadId);
        return yield* fetchEnvironmentShellSnapshot({
          prepared,
          signer,
          remoteAuthorization,
          ...(omitIdleSubagents ? { omitIdleSubagents } : {}),
          ...(onPage ? { onPage } : {}),
          ...(resume ? { resume } : {}),
          onProgress: (progress) =>
            Effect.sync(() => {
              progressByConnection.set(key, { progress, loadId });
            }),
          ...(Option.isSome(journal)
            ? {
                onPageBody: (page: {
                  readonly index: number;
                  readonly body: string;
                  readonly nextAfter: string;
                  readonly updatedAt: number;
                }) => journal.value.append(prepared.environmentId, { key, loadId, ...page }),
              }
            : {}),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              progressByConnection.delete(key);
            }).pipe(
              Effect.andThen(
                Option.isSome(journal) ? journal.value.clear(prepared.environmentId) : Effect.void,
              ),
            ),
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
