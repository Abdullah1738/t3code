import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { TestClock } from "effect/testing";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as ShellSnapshotHttp from "../state/shellSnapshotHttp.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import {
  ShellLoadJournal,
  makeKeyValueShellLoadJournal,
  shellLoadPageKey,
  shellLoadRecordKey,
  type ShellLoadKeyValue,
} from "./shellLoadJournal.ts";

const ENVIRONMENT = EnvironmentId.make("environment-journal");

function memoryStore(options: { readonly failPuts?: () => boolean } = {}) {
  const values = new Map<string, string>();
  const store: ShellLoadKeyValue<string> = {
    get: (key) => Effect.sync(() => values.get(key)),
    put: (key, value) =>
      options.failPuts?.() === true
        ? Effect.fail("quota")
        : Effect.sync(() => {
            values.set(key, value);
          }),
    removeRange: (from, to) =>
      Effect.sync(() => {
        for (const key of values.keys()) if (key >= from && key <= to) values.delete(key);
      }),
  };
  return { values, store };
}

const entry = (index: number, loadId = "load-a") => ({
  key: "key",
  loadId,
  index,
  body: `{"page":${index}}`,
  nextAfter: `cursor-${index}`,
  updatedAt: 1_000 + index,
});

describe("shell load journal", () => {
  it.effect("reads back every appended page in order with the last cursor", () =>
    Effect.gen(function* () {
      const journal = makeKeyValueShellLoadJournal(memoryStore().store);
      yield* journal.append(ENVIRONMENT, entry(0));
      yield* journal.append(ENVIRONMENT, entry(1));
      const stored = Option.getOrThrow(yield* journal.read(ENVIRONMENT));
      expect(stored.bodies).toEqual(['{"page":0}', '{"page":1}']);
      expect(stored.nextAfter).toBe("cursor-1");
      expect(stored.loadId).toBe("load-a");
      yield* journal.clear(ENVIRONMENT);
      expect(Option.isNone(yield* journal.read(ENVIRONMENT))).toBe(true);
    }),
  );

  it.effect("drops an older load's pages when a new load starts", () =>
    Effect.gen(function* () {
      const { values, store } = memoryStore();
      const journal = makeKeyValueShellLoadJournal(store);
      yield* journal.append(ENVIRONMENT, entry(0, "old"));
      yield* journal.append(ENVIRONMENT, entry(1, "old"));
      yield* journal.append(ENVIRONMENT, entry(0, "new"));
      expect([...values.keys()].filter((key) => key.includes("old"))).toEqual([]);
      expect(Option.getOrThrow(yield* journal.read(ENVIRONMENT)).bodies).toHaveLength(1);
    }),
  );

  it.effect("starts over when a named page is missing and never fails on store errors", () =>
    Effect.gen(function* () {
      let fail = false;
      const { values, store } = memoryStore({ failPuts: () => fail });
      const journal = makeKeyValueShellLoadJournal(store);
      yield* journal.append(ENVIRONMENT, entry(0));
      values.delete(shellLoadPageKey(ENVIRONMENT, "load-a", 0));
      expect(Option.isNone(yield* journal.read(ENVIRONMENT))).toBe(true);
      // A failed page write leaves the record where it was.
      fail = true;
      yield* journal.append(ENVIRONMENT, entry(1));
      expect(JSON.parse(values.get(shellLoadRecordKey(ENVIRONMENT))!).pages).toBe(1);
      // Unreadable records are ignored.
      values.set(shellLoadRecordKey(ENVIRONMENT), "not json");
      expect(Option.isNone(yield* journal.read(ENVIRONMENT))).toBe(true);
    }),
  );

  it("keeps journal keys apart from the environment's own shell key", () => {
    expect(shellLoadRecordKey(ENVIRONMENT)).not.toBe(ENVIRONMENT);
    expect(shellLoadPageKey(ENVIRONMENT, "a", 2) > shellLoadRecordKey(ENVIRONMENT)).toBe(true);
    expect(shellLoadPageKey(ENVIRONMENT, "a", 10) > shellLoadPageKey(ENVIRONMENT, "a", 9)).toBe(
      true,
    );
  });
});

const encodeRow = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadShell));
const row = (id: string) => encodeRow({ ...v2ThreadShell, id: ThreadId.make(id) });

const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT,
  label: "Journal",
  httpBaseUrl: "https://journal.example.test",
  wsBaseUrl: "wss://journal.example.test",
});
const prepared = (serverVersion: string | null): PreparedConnection => ({
  environmentId: ENVIRONMENT,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
  ...(serverVersion === null
    ? {}
    : {
        verifiedDescriptor: {
          httpBaseUrl: TARGET.httpBaseUrl,
          descriptor: { serverVersion } as never,
        },
      }),
});

// Three pages: recent-first page, then two walk pages; `fail` names request numbers that 502.
function shellServer(fail: ReadonlySet<number> = new Set()) {
  const afters: Array<string | null> = [];
  const fetchFn: typeof fetch = async (request) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    const after = url.searchParams.get("after");
    afters.push(after);
    if (fail.has(afters.length)) return Response.json({ error: "bad_gateway" }, { status: 502 });
    const [threads, nextAfter, snapshotSequence] =
      after === null
        ? [[row("c")], "walk:0", 10]
        : after === "walk:0"
          ? [[row("a"), row("b")], "walk:1", 11]
          : [[row("c"), row("d")], null, 12];
    return Response.json({
      schemaVersion: 1,
      snapshotSequence,
      projects: [],
      threads,
      archivedThreads: [],
      page: { after, nextAfter },
    });
  };
  return { afters, fetchFn };
}

const makeLoader = (fetchFn: typeof fetch, journal: ShellLoadJournal["Service"]) =>
  ShellSnapshotHttp.ShellSnapshotLoader.pipe(
    Effect.provide(
      ShellSnapshotHttp.layer.pipe(
        Layer.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
        Layer.provide(Layer.succeed(ShellLoadJournal, journal)),
      ),
    ),
  );

const ids = (snapshot: OrchestrationV2ShellSnapshot) => snapshot.threads.map((t) => t.id);

describe("shell loader with a journal", () => {
  it.effect("a new client goes on from the page the previous one stored", () =>
    Effect.gen(function* () {
      const { values, store } = memoryStore();
      const journal = makeKeyValueShellLoadJournal(store);
      // The first client gets two pages, then its third request fails (a crash stands in).
      const first = shellServer(new Set([3]));
      const crashed = yield* (yield* makeLoader(first.fetchFn, journal)).load(prepared("1.0.0"));
      expect(Option.isNone(crashed)).toBe(true);
      expect(Option.getOrThrow(yield* journal.read(ENVIRONMENT)).bodies).toHaveLength(2);

      // A fresh loader (a new renderer) asks only for the page after the stored cursor.
      const second = shellServer();
      const loaded = Option.getOrThrow(
        yield* (yield* makeLoader(second.fetchFn, journal)).load(prepared("1.0.0")),
      );
      expect(second.afters).toEqual(["walk:1"]);
      // Same rows and replay boundary as an uninterrupted load; row "c" keeps its first place.
      expect(ids(loaded)).toEqual(["c", "a", "b", "d"]);
      expect(loaded.snapshotSequence).toBe(10);
      expect(loaded.page).toEqual({ after: null, nextAfter: null });
      // A finished load leaves no journal behind.
      expect([...values.keys()]).toEqual([]);
    }),
  );

  it.effect("takes the build from the session when the connection has no descriptor", () =>
    Effect.gen(function* () {
      const journal = makeKeyValueShellLoadJournal(memoryStore().store);
      const session = { serverVersion: "1.0.0" };
      const first = shellServer(new Set([3]));
      yield* (yield* makeLoader(first.fetchFn, journal)).load(prepared(null), undefined, session);
      const second = shellServer();
      const loaded = yield* (yield* makeLoader(second.fetchFn, journal)).load(
        prepared(null),
        undefined,
        session,
      );
      expect(second.afters).toEqual(["walk:1"]);
      expect(ids(Option.getOrThrow(loaded))).toEqual(["c", "a", "b", "d"]);
    }),
  );

  it.effect("starts over for another server build, an unknown build, or a stale journal", () =>
    Effect.gen(function* () {
      const journal = makeKeyValueShellLoadJournal(memoryStore().store);
      const failing = shellServer(new Set([3]));
      yield* (yield* makeLoader(failing.fetchFn, journal)).load(prepared("1.0.0"));

      const upgraded = shellServer();
      yield* (yield* makeLoader(upgraded.fetchFn, journal)).load(prepared("1.0.1"));
      expect(upgraded.afters[0]).toBeNull();

      const unknownFirst = shellServer(new Set([3]));
      yield* (yield* makeLoader(unknownFirst.fetchFn, journal)).load(prepared(null));
      const unknown = shellServer();
      yield* (yield* makeLoader(unknown.fetchFn, journal)).load(prepared(null));
      expect(unknown.afters[0]).toBeNull();

      const staleFirst = shellServer(new Set([3]));
      yield* (yield* makeLoader(staleFirst.fetchFn, journal)).load(prepared("1.0.0"));
      yield* TestClock.adjust(ShellSnapshotHttp.SHELL_LOAD_RESUME_MAX_AGE_MS + 1);
      const stale = shellServer();
      yield* (yield* makeLoader(stale.fetchFn, journal)).load(prepared("1.0.0"));
      expect(stale.afters[0]).toBeNull();
    }),
  );

  it.effect("merges pages one at a time into what merging them all at once gives", () =>
    Effect.gen(function* () {
      const journal = makeKeyValueShellLoadJournal(memoryStore().store);
      const server = shellServer();
      const pages: OrchestrationV2ShellSnapshot[] = [];
      const loaded = Option.getOrThrow(
        yield* (yield* makeLoader(server.fetchFn, journal)).load(prepared("1.0.0"), (page) =>
          Effect.sync(() => {
            pages.push(page);
          }),
        ),
      );
      expect(pages.map(ids)).toEqual([["c"], ["c", "a", "b"]]);
      expect(pages.map((page) => page.page)).toEqual([
        { after: null, nextAfter: "walk:0" },
        { after: null, nextAfter: "walk:1" },
      ]);
      expect(ids(loaded)).toEqual(["c", "a", "b", "d"]);
    }),
  );
});
