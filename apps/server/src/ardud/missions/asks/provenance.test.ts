// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway bridge database for the lookup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { MissionProvenance } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { findInImsgHistory, makeInboundLookup, readBridgeIdentities } from "./inbound.ts";
import {
  canRedeemInbound,
  optionCollision,
  verifyInbound,
  type InboundMessage,
} from "./provenance.ts";

const opened = "2026-10-17T10:00:00.000Z";
const after = Date.parse(opened) + 60_000;

const owner = (text: string, id = "spc-msg-1"): InboundMessage => ({
  id,
  chat: "owner",
  text,
  typed: true,
  receivedAt: after,
});

const OPTIONS = [
  { id: "pg", label: "Postgres" },
  { id: "sqlite", label: "SQLite" },
];

const cli: MissionProvenance = { _tag: "system", component: "mission-cli" };

const verify = (
  inbound: InboundMessage | null,
  id = "spc-msg-1",
  caller: MissionProvenance = cli,
  skewMs?: number,
) =>
  verifyInbound({
    caller,
    inboundId: id,
    inbound,
    notBefore: opened,
    what: "Answer",
    ...(skewMs === undefined ? {} : { skewMs }),
  });

const code = (result: ReturnType<typeof verify>) =>
  Result.isFailure(result) ? result.failure.code : "ok";

describe("iMessage provenance", () => {
  it("takes any message he typed in his or Moni's chat and keeps his words as the quote", () => {
    expect(Result.getOrThrow(verify(owner("lets go with postgres i guess")))).toEqual({
      _tag: "owner-imessage",
      chat: "owner",
      inboundId: "spc-msg-1",
      quote: "lets go with postgres i guess",
    });
    const moni = verify({ ...owner("both are fine, send them"), chat: "moni" });
    expect(Result.getOrThrow(moni).chat).toBe("moni");
    const long = Result.getOrThrow(verify(owner("x".repeat(5000))));
    expect(long.quote?.length).toBeLessThanOrEqual(2000);
  });

  // Sol r4 Q1: only the iMessage bridge and the mission CLI credential may
  // turn an inbound into the owner's word; everyone else is refused first.
  it("Q1: refuses every caller but the bridge and the mission CLI, before anything else", () => {
    expect(canRedeemInbound({ _tag: "system", component: "spectrum-bridge" })).toBe(true);
    expect(canRedeemInbound(cli)).toBe(true);
    const others: Array<MissionProvenance> = [
      { _tag: "system", component: "telegram-bridge" },
      { _tag: "system", component: "control-api" },
      { _tag: "system", component: "crw" },
      { _tag: "agent", threadId: "t-master" } as MissionProvenance,
    ];
    for (const caller of others) {
      expect(canRedeemInbound(caller)).toBe(false);
      expect(code(verify(owner("yes"), "spc-msg-1", caller))).toBe("forbidden");
      expect(code(verify(null, " ", caller))).toBe("forbidden");
    }
  });

  it("refuses bridge wakes, secrets and resets", () => {
    for (const id of ["wake:abc", "secret:abc", "reset:abc"]) {
      expect(code(verify(owner("postgres", id), id))).toBe("provenance-invalid");
    }
  });

  // Sol P6: a poll vote (or anything else the bridge composed) is never text
  // the owner typed, whatever it says and whoever asks.
  it("P6: refuses poll votes and rows the bridge composed", () => {
    expect(code(verify(owner("yes", "poll-vote:guid-1:1"), "poll-vote:guid-1:1"))).toBe(
      "provenance-invalid",
    );
    expect(code(verify({ ...owner("yes", "spc-msg-9"), typed: false }, "spc-msg-9"))).toBe(
      "provenance-invalid",
    );
    expect(code(verify(owner("yes")))).toBe("ok");
  });

  it("refuses unknown ids, a blank id and messages older than the record", () => {
    expect(code(verify(null))).toBe("provenance-invalid");
    expect(code(verify(owner("postgres", "spc-msg-2")))).toBe("provenance-invalid");
    expect(
      code(verify({ ...owner("postgres"), receivedAt: Date.parse(opened) - 10 * 60_000 })),
    ).toBe("provenance-invalid");
    expect(code(verify(owner("postgres"), " "))).toBe("provenance-required");
  });

  it("allows no clock skew before a revision epoch when asked to", () => {
    const early = { ...owner("ok send it"), receivedAt: Date.parse(opened) - 30_000 };
    expect(code(verify(early))).toBe("ok");
    expect(code(verify(early, "spc-msg-1", cli, 0))).toBe("provenance-invalid");
  });

  // N8 still matters for the app: options a reader could confuse are named
  // when the ask opens.
  it("N8: option sets that one reply could read two ways are named at creation", () => {
    expect(
      optionCollision([
        { id: "minus", label: "Pay -100" },
        { id: "plus", label: "Pay +100" },
      ]),
    ).toBeNull();
    expect(optionCollision(OPTIONS)).toBeNull();
    expect(
      optionCollision([
        { id: "y", label: "Yes" },
        { id: "n", label: "No" },
      ]),
    ).toBeNull();
    for (const options of [
      [
        { id: "x", label: "Postgres" },
        { id: "y", label: "postgres" },
      ],
      [
        { id: "b", label: "Plan A" },
        { id: "c", label: "b" },
      ],
      [
        { id: "A", label: "First" },
        { id: "a", label: "Second" },
      ],
      [
        { id: "cached", label: "Use cache" },
        { id: "plain", label: "Cache" },
      ],
      [
        { id: "a", label: "Deploy." },
        { id: "b", label: "deploy" },
      ],
    ]) {
      expect(optionCollision(options)).not.toBeNull();
    }
  });

  it("N8: checking long option labels stays fast", () => {
    const long = (seed: number) =>
      Array.from({ length: 300 }, (_, index) => `w${seed}x${index}`).join(" ");
    const options = Array.from({ length: 20 }, (_, index) => ({
      id: `o${index}`,
      label: long(index),
    }));
    const leads = Array.from({ length: 20 }, (_, index) => ({
      id: `g${index}`,
      label: `${"go ".repeat(300)}${index}`,
    }));
    const started = performance.now();
    expect(optionCollision(options)).toBeNull();
    expect(optionCollision(leads)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("inbound lookup", () => {
  const HIS = "+971500000001";
  const MONI = ["+971500000002", "Moni@Example.com"];
  const STRANGER = "+971500000009";
  const identities = { owner: [HIS], moni: MONI };

  const makeStore = (file: string, rows: ReadonlyArray<Record<string, unknown>>) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(file);
    db.exec(
      "CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO inbound (id, payload, state) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(String(row.id), JSON.stringify(row), "done");
    db.close();
  };

  const makeBridge = () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "missions-inbound-"));
    const file = NodePath.join(dir, "state.sqlite");
    const db = new NodeSqlite.DatabaseSync(file);
    db.exec(
      "CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO inbound (id, payload, state) VALUES (?, ?, ?)");
    insert.run(
      "spc-msg-1",
      JSON.stringify({
        id: "spc-msg-1",
        text: "go postgres",
        source: "typed",
        replyTo: "guid-notice-1",
        receivedAt: after,
      }),
      "done",
    );
    insert.run(
      "wake:1",
      JSON.stringify({ id: "wake:1", text: "go postgres", receivedAt: after }),
      "done",
    );
    // A row from an older bridge (no source) and a composed one read as not typed.
    insert.run(
      "spc-msg-old",
      JSON.stringify({ id: "spc-msg-old", text: "go postgres", receivedAt: after }),
      "done",
    );
    insert.run(
      "spc-msg-vote",
      JSON.stringify({
        id: "spc-msg-vote",
        text: 'Voted for "Postgres" in the poll "Which db"',
        source: "composed",
        receivedAt: after,
      }),
      "done",
    );
    db.close();
    return file;
  };

  /**
   * A bridge home like `~/.config/spectrum-bridge`: his direct chat's store at
   * the root, and one store per other chat under `chats/`.
   */
  const makeBridgeHome = () => {
    const root = NodePath.dirname(makeBridge());
    const typed = (id: string, sender: string, text: string) => ({
      id,
      text,
      sender,
      source: "typed",
      receivedAt: after,
    });
    makeStore(NodePath.join(root, "chats", "group-x", "state.sqlite"), [
      typed("grp-his", ` ${HIS.toUpperCase()} `, "file a bug with the mission"),
      typed("grp-moni", MONI[0]!, "same from me"),
      typed("grp-stranger", STRANGER, "file a bug please"),
      // Untyped and composed rows never count, whoever the sender is.
      { id: "grp-untyped", text: "file a bug", sender: HIS, receivedAt: after },
      { id: "grp-composed", text: "Voted", sender: HIS, source: "composed", receivedAt: after },
      { id: "grp-nosender", text: "file a bug", source: "typed", receivedAt: after },
      { id: "wake:grp", text: "file a bug", sender: HIS, source: "typed", receivedAt: after },
    ]);
    makeStore(NodePath.join(root, "chats", "moni", "state.sqlite"), [
      typed("moni-1", "moni@example.com", "ship it"),
    ]);
    return {
      bridgeDatabase: NodePath.join(root, "state.sqlite"),
      chatsDirectory: NodePath.join(root, "chats"),
      root,
    };
  };

  const lookupOver = (
    home: ReturnType<typeof makeBridgeHome>,
    who: () => { owner: ReadonlyArray<string>; moni: ReadonlyArray<string> } = () => identities,
  ) =>
    makeInboundLookup({
      bridgeDatabase: home.bridgeDatabase,
      chatsDirectory: home.chatsDirectory,
      identities: who,
      runImsg: null,
      moniChatId: 45,
    });

  it.effect("his typed text in a group is his word, and the provenance names the group", () =>
    Effect.gen(function* () {
      const lookup = lookupOver(makeBridgeHome());
      const found = yield* lookup.find("grp-his", opened);
      expect(found).toEqual({
        id: "grp-his",
        chat: "owner",
        bridgeChat: "group-x",
        text: "file a bug with the mission",
        typed: true,
        receivedAt: after,
      });
      expect(Result.getOrThrow(verify(found, "grp-his"))).toEqual({
        _tag: "owner-imessage",
        chat: "owner",
        inboundId: "grp-his",
        quote: "file a bug with the mission",
        bridgeChat: "group-x",
      });
    }),
  );

  it.effect("Moni's typed text in a group or her own chat is Moni's", () =>
    Effect.gen(function* () {
      const lookup = lookupOver(makeBridgeHome());
      expect(yield* lookup.find("grp-moni", opened)).toMatchObject({
        chat: "moni",
        bridgeChat: "group-x",
        typed: true,
      });
      const hers = yield* lookup.find("moni-1", opened);
      expect(hers).toMatchObject({ chat: "moni", bridgeChat: "moni", text: "ship it" });
      expect(Result.getOrThrow(verify(hers, "moni-1")).chat).toBe("moni");
    }),
  );

  it.effect(
    "anyone else's text, untyped or composed rows and wakes in a chat store are refused",
    () =>
      Effect.gen(function* () {
        const lookup = lookupOver(makeBridgeHome());
        for (const id of [
          "grp-stranger",
          "grp-untyped",
          "grp-composed",
          "grp-nosender",
          "wake:grp",
        ]) {
          const found = yield* lookup.find(id, opened);
          expect(found).toBeNull();
          expect(code(verify(found, id))).toBe("provenance-invalid");
        }
      }),
  );

  it.effect("without the bridge's config or access file, chat-store rows match nobody", () =>
    Effect.gen(function* () {
      const home = makeBridgeHome();
      const missing = lookupOver(home, () =>
        readBridgeIdentities(
          NodePath.join(home.root, "config.json"),
          NodePath.join(home.root, "access.json"),
        ),
      );
      for (const id of ["grp-his", "grp-moni", "moni-1"]) {
        expect(yield* missing.find(id, opened)).toBeNull();
      }
      // His direct chat needs no sender, so it still works.
      expect((yield* missing.find("spc-msg-1", opened))?.chat).toBe("owner");

      // Written files are read on each lookup; a broken one fails closed too.
      NodeFS.writeFileSync(
        NodePath.join(home.root, "config.json"),
        JSON.stringify({ owner: ` ${HIS} ` }),
      );
      NodeFS.writeFileSync(NodePath.join(home.root, "access.json"), "{not json");
      expect((yield* missing.find("grp-his", opened))?.chat).toBe("owner");
      expect(yield* missing.find("grp-moni", opened)).toBeNull();
      NodeFS.writeFileSync(
        NodePath.join(home.root, "access.json"),
        JSON.stringify({
          people: [{ name: "MONI", role: "family", addresses: MONI }],
          groups: [],
        }),
      );
      expect((yield* missing.find("grp-moni", opened))?.chat).toBe("moni");
    }),
  );

  it.effect("his direct chat wins over a chat store holding the same id", () =>
    Effect.gen(function* () {
      const home = makeBridgeHome();
      makeStore(NodePath.join(home.chatsDirectory, "a-group", "state.sqlite"), [
        { id: "spc-msg-1", text: "copy", sender: HIS, source: "typed", receivedAt: after },
      ]);
      const found = yield* lookupOver(home).find("spc-msg-1", opened);
      expect(found).toMatchObject({ chat: "owner", text: "go postgres" });
      expect(found).not.toHaveProperty("bridgeChat");
    }),
  );

  it.effect("a sender listed as both him and Moni is him", () =>
    Effect.gen(function* () {
      const lookup = lookupOver(makeBridgeHome(), () => ({ owner: [HIS], moni: [HIS, ...MONI] }));
      expect((yield* lookup.find("grp-his", opened))?.chat).toBe("owner");
    }),
  );

  it.effect("a chat store it can't read refuses instead of guessing", () =>
    Effect.gen(function* () {
      const home = makeBridgeHome();
      NodeFS.mkdirSync(NodePath.join(home.chatsDirectory, "broken"));
      NodeFS.writeFileSync(NodePath.join(home.chatsDirectory, "broken", "state.sqlite"), "");
      const error = yield* Effect.flip(lookupOver(home).find("grp-his", opened));
      expect(error.code).toBe("provenance-invalid");
      expect(error.detail).toContain("bridge chat broken unreadable");
      // His direct chat is read first, so it still answers.
      expect((yield* lookupOver(home).find("spc-msg-1", opened))?.chat).toBe("owner");
    }),
  );

  it.effect("an id no chat store has still reaches Moni's Messages history", () =>
    Effect.gen(function* () {
      const home = makeBridgeHome();
      const rows = JSON.stringify({
        guid: "m-1",
        chat_id: 45,
        is_from_me: false,
        text: "yes ship it",
        created_at: "2026-10-17T10:05:00Z",
      });
      const lookup = makeInboundLookup({
        bridgeDatabase: home.bridgeDatabase,
        chatsDirectory: home.chatsDirectory,
        identities: () => identities,
        runImsg: async () => rows,
        moniChatId: 45,
      });
      const found = yield* lookup.find("m-1", opened);
      expect(found).toMatchObject({ chat: "moni", text: "yes ship it" });
      expect(found).not.toHaveProperty("bridgeChat");
    }),
  );

  it.effect("finds owner messages in his direct chat, unnamed, and never synthetic rows", () =>
    Effect.gen(function* () {
      const home = makeBridgeHome();
      const lookup = lookupOver(home);
      const found = yield* lookup.find("spc-msg-1", opened);
      expect(found).toEqual({
        id: "spc-msg-1",
        chat: "owner",
        text: "go postgres",
        typed: true,
        replyTo: "guid-notice-1",
        receivedAt: after,
      });
      expect(Result.getOrThrow(verify(found))).not.toHaveProperty("bridgeChat");
      expect((yield* lookup.find("spc-msg-old", opened))?.typed).toBe(false);
      expect((yield* lookup.find("spc-msg-vote", opened))?.typed).toBe(false);
      expect(yield* lookup.find("wake:1", opened)).toBeNull();
      expect(yield* lookup.find("spc-msg-2", opened)).toBeNull();
    }),
  );

  it.effect("finds Moni's messages only when she sent them in her chat", () =>
    Effect.gen(function* () {
      const rows = [
        {
          guid: "m-1",
          chat_id: 45,
          is_from_me: false,
          text: "yes ship it",
          created_at: "2026-10-17T10:05:00Z",
        },
        {
          guid: "m-2",
          chat_id: 45,
          is_from_me: true,
          text: "yes ship it",
          created_at: "2026-10-17T10:05:00Z",
        },
        {
          guid: "m-3",
          chat_id: 12,
          is_from_me: false,
          text: "yes ship it",
          created_at: "2026-10-17T10:05:00Z",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
      expect(findInImsgHistory(rows, "m-1", 45)?.chat).toBe("moni");
      expect(findInImsgHistory(rows, "m-2", 45)).toBeNull();
      expect(findInImsgHistory(rows, "m-3", 45)).toBeNull();
      const seen: Array<ReadonlyArray<string>> = [];
      const lookup = makeInboundLookup({
        bridgeDatabase: "/nonexistent/state.sqlite",
        chatsDirectory: "/nonexistent/chats",
        identities: () => identities,
        runImsg: async (args) => {
          seen.push(args);
          return rows;
        },
        moniChatId: 45,
      });
      const found = yield* lookup.find("m-1", opened);
      expect(found?.text).toBe("yes ship it");
      expect(seen[0]?.slice(0, 3)).toEqual(["history", "--chat-id", "45"]);
    }),
  );
});
