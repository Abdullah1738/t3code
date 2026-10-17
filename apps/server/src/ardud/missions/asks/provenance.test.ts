// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway bridge database for the lookup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { findInImsgHistory, makeInboundLookup } from "./inbound.ts";
import {
  expectedForAnswer,
  expectedForDraftDecision,
  verifyInbound,
  type InboundMessage,
} from "./provenance.ts";

const opened = "2026-10-17T10:00:00.000Z";
const after = Date.parse(opened) + 60_000;

const owner = (text: string, id = "spc-msg-1"): InboundMessage => ({
  id,
  chat: "owner",
  text,
  receivedAt: after,
});

const verify = (
  inbound: InboundMessage | null,
  expected: ReadonlyArray<string>,
  id = "spc-msg-1",
) => verifyInbound({ inboundId: id, inbound, expected, notBefore: opened, what: "Answer" });

const code = (result: ReturnType<typeof verify>) =>
  Result.isFailure(result) ? result.failure.code : "ok";

describe("iMessage provenance", () => {
  it("accepts a real owner or Moni message that says the answer", () => {
    const ok = verify(owner("Go with Postgres, keep it simple"), ["go with postgres"]);
    expect(Result.getOrThrow(ok)).toEqual({
      _tag: "owner-imessage",
      chat: "owner",
      inboundId: "spc-msg-1",
    });
    const moni = verify({ ...owner("Yes ship it!"), chat: "moni" }, ["ship it"]);
    expect(Result.getOrThrow(moni).chat).toBe("moni");
  });

  it("refuses bridge wakes, secrets and resets even when the text matches", () => {
    for (const id of ["wake:abc", "secret:abc", "reset:abc"]) {
      expect(code(verify(owner("postgres", id), ["postgres"], id))).toBe("provenance-invalid");
    }
  });

  it("refuses unknown ids, text that does not match, and messages older than the ask", () => {
    expect(code(verify(null, ["postgres"]))).toBe("provenance-invalid");
    expect(code(verify(owner("use sqlite"), ["postgres"]))).toBe("provenance-invalid");
    expect(code(verify(owner("postgresql"), ["postgres"]))).toBe("provenance-invalid");
    expect(
      code(
        verify({ ...owner("postgres"), receivedAt: Date.parse(opened) - 10 * 60_000 }, [
          "postgres",
        ]),
      ),
    ).toBe("provenance-invalid");
    expect(code(verify(owner("postgres"), ["postgres"], " "))).toBe("provenance-required");
  });

  it("checks what each decision must say", () => {
    expect(
      expectedForAnswer({ text: "", option: { id: "pg", label: "Postgres" } }).expected,
    ).toEqual(["Postgres", "pg"]);
    const byLetter = expectedForAnswer({ text: "", option: { id: "a", label: "Online" } });
    const check = (text: string) =>
      Result.isSuccess(
        verifyInbound({
          inboundId: "spc-msg-1",
          inbound: owner(text),
          ...byLetter,
          notBefore: opened,
          what: "Answer",
        }),
      );
    expect(check("A")).toBe(true);
    expect(check("go online")).toBe(true);
    expect(check("take a break first")).toBe(false);
    const approve = expectedForDraftDecision({ action: "approve" });
    const ok = verifyInbound({
      inboundId: "spc-msg-1",
      inbound: owner("ok send it"),
      ...approve,
      notBefore: opened,
      what: "Approval",
    });
    expect(Result.isSuccess(ok)).toBe(true);
    const mixed = verifyInbound({
      inboundId: "spc-msg-1",
      inbound: owner("ok actually dont send"),
      ...approve,
      notBefore: opened,
      what: "Approval",
    });
    expect(code(mixed)).toBe("provenance-invalid");
    const edited = expectedForDraftDecision({ action: "approve", editedText: "Merged, thanks." });
    expect(edited.expected).toEqual(["Merged, thanks."]);
  });
});

describe("inbound lookup", () => {
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
      JSON.stringify({ id: "spc-msg-1", text: "go postgres", receivedAt: after }),
      "done",
    );
    insert.run(
      "wake:1",
      JSON.stringify({ id: "wake:1", text: "go postgres", receivedAt: after }),
      "done",
    );
    db.close();
    return file;
  };

  it.effect("finds owner messages in the bridge store and never synthetic rows", () =>
    Effect.gen(function* () {
      const lookup = makeInboundLookup({
        bridgeDatabase: makeBridge(),
        runImsg: null,
        moniChatId: 45,
      });
      const found = yield* lookup.find("spc-msg-1", opened);
      expect(found).toEqual({
        id: "spc-msg-1",
        chat: "owner",
        text: "go postgres",
        receivedAt: after,
      });
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
