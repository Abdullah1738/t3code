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
  answerCheck,
  consentCheck,
  draftDecisionCheck,
  type InboundBinding,
  optionCollision,
  recordHandle,
  type ReplyCheck,
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

const verify = (
  inbound: InboundMessage | null,
  check: ReplyCheck,
  id = "spc-msg-1",
  binding: InboundBinding = { _tag: "tied" },
) => verifyInbound({ inboundId: id, inbound, binding, check, notBefore: opened, what: "Answer" });

const code = (result: ReturnType<typeof verify>) =>
  Result.isFailure(result) ? result.failure.code : "ok";

const picks = (optionId: string | null, text = "", options = OPTIONS) => {
  const check = answerCheck({ options, optionId, text });
  return (reply: string) => code(verify(owner(reply), check)) === "ok";
};

const decides = (input: Parameters<typeof draftDecisionCheck>[0]) => {
  const check = draftDecisionCheck(input);
  return (reply: string) => code(verify(owner(reply), check)) === "ok";
};

describe("iMessage provenance", () => {
  it("accepts a real owner or Moni message that carries the answer", () => {
    const ok = verify(
      owner("Go with Postgres"),
      answerCheck({ options: OPTIONS, optionId: "pg", text: "" }),
    );
    expect(Result.getOrThrow(ok)).toEqual({
      _tag: "owner-imessage",
      chat: "owner",
      inboundId: "spc-msg-1",
    });
    const moni = verify(
      { ...owner("Yes ship it!"), chat: "moni" },
      draftDecisionCheck({ action: "approve" }),
    );
    expect(Result.getOrThrow(moni).chat).toBe("moni");
  });

  it("refuses bridge wakes, secrets and resets even when the text matches", () => {
    for (const id of ["wake:abc", "secret:abc", "reset:abc"]) {
      expect(
        code(
          verify(
            owner("postgres", id),
            answerCheck({ options: OPTIONS, optionId: "pg", text: "" }),
            id,
          ),
        ),
      ).toBe("provenance-invalid");
    }
  });

  // Sol P6: a poll vote (or anything else the bridge composed) is never text
  // the owner typed, whatever it says and whoever asks.
  it("P6: refuses poll votes and rows the bridge composed", () => {
    const yes = consentCheck("yes");
    expect(code(verify(owner("yes", "poll-vote:guid-1:1"), yes, "poll-vote:guid-1:1"))).toBe(
      "provenance-invalid",
    );
    expect(code(verify({ ...owner("yes", "spc-msg-9"), typed: false }, yes, "spc-msg-9"))).toBe(
      "provenance-invalid",
    );
    expect(code(verify(owner("yes"), yes))).toBe("ok");
  });

  // Sol P3: a yes or no is short and exact. A question, a negation, a
  // qualifier or anything more decides nothing.
  it("P3: consent replies use the short exact grammar", () => {
    const says = (answer: "yes" | "no") => (reply: string) =>
      code(verify(owner(reply), consentCheck(answer))) === "ok";
    const yes = says("yes");
    for (const reply of [
      "yes",
      "Yes!",
      "approve",
      "approved",
      "ok",
      "go",
      "send it",
      "Ship it.",
      "yes please",
      "ok thanks",
      "approve, thank you",
    ]) {
      expect([reply, yes(reply)]).toEqual([reply, true]);
    }
    for (const reply of [
      "yes?",
      "allow?",
      "is that ok?",
      "is that ok",
      "yes but not now",
      "don't",
      "dont",
      "ok？",
      "yes؟",
      "¿ok",
      "ok 🤔",
      "yes❓",
      "yes 🙄",
      "yes 2",
      "please",
      "thanks",
      "sure",
      "yeah",
      "allow",
      "yes if the tests pass",
      "not yet",
      "ok go ahead and also delete the branch",
    ]) {
      expect([reply, yes(reply)]).toEqual([reply, false]);
    }
    const no = says("no");
    for (const reply of ["no", "No.", "deny", "reject", "decline", "no thanks"]) {
      expect([reply, no(reply)]).toEqual([reply, true]);
    }
    for (const reply of ["no?", "don't", "no, yes", "not now", "no but ask me later"]) {
      expect([reply, no(reply)]).toEqual([reply, false]);
    }
    // A draft approval uses the same grammar.
    const approve = decides({ action: "approve" });
    expect(approve("ship it")).toBe(true);
    expect(approve("is that ok?")).toBe(false);
    expect(approve("lgtm")).toBe(false);
  });

  // Sol P1: an ask or draft answered by iMessage must name it: the reply
  // starts with the record's short handle, and the rest is the answer.
  it("P1: a handle binding needs the record's handle first", () => {
    const handle = recordHandle("ask-3F9c2b1e-0000");
    expect(handle).toBe("3f9c");
    const pg = answerCheck({ options: OPTIONS, optionId: "pg", text: "" });
    const bound = (reply: string) =>
      code(verify(owner(reply), pg, "spc-msg-1", { _tag: "handle", handle }));
    expect(bound("3f9c postgres")).toBe("ok");
    expect(bound("#3F9C: postgres")).toBe("ok");
    expect(bound("3f9c - Postgres")).toBe("ok");
    expect(bound("postgres")).toBe("provenance-invalid");
    expect(bound("3f9d postgres")).toBe("provenance-invalid");
    expect(bound("3f9cpostgres")).toBe("provenance-invalid");
    expect(bound("3f9c")).toBe("provenance-invalid");
    expect(bound("postgres 3f9c")).toBe("provenance-invalid");
  });

  it("refuses unknown ids, text that does not match, and messages older than the ask", () => {
    const pg = answerCheck({ options: OPTIONS, optionId: "pg", text: "" });
    expect(code(verify(null, pg))).toBe("provenance-invalid");
    expect(code(verify(owner("use sqlite"), pg))).toBe("provenance-invalid");
    expect(code(verify(owner("postgresql"), pg))).toBe("provenance-invalid");
    expect(
      code(verify({ ...owner("postgres"), receivedAt: Date.parse(opened) - 10 * 60_000 }, pg)),
    ).toBe("provenance-invalid");
    expect(code(verify(owner("postgres"), pg, " "))).toBe("provenance-required");
  });

  it("allows no clock skew before a revision epoch when asked to", () => {
    const check = draftDecisionCheck({ action: "approve" });
    const early = { ...owner("ok send it"), receivedAt: Date.parse(opened) - 30_000 };
    const loose = verifyInbound({
      inboundId: "spc-msg-1",
      inbound: early,
      binding: { _tag: "tied" },
      check,
      notBefore: opened,
      what: "Approval",
    });
    expect(code(loose)).toBe("ok");
    const strict = verifyInbound({
      inboundId: "spc-msg-1",
      inbound: early,
      binding: { _tag: "tied" },
      check,
      notBefore: opened,
      skewMs: 0,
      what: "Approval",
    });
    expect(code(strict)).toBe("provenance-invalid");
  });

  // Sol H8: free text cannot stand in for a different option, and a negated
  // or contradictory reply never picks the option it mentions.
  it("H8: an answer by iMessage must name the chosen option and nothing against it", () => {
    const deploy = picks("deploy", "", [
      { id: "deploy", label: "Deploy" },
      { id: "hold", label: "Hold" },
    ]);
    expect(deploy("deploy")).toBe(true);
    expect(deploy("go deploy please")).toBe(true);
    expect(deploy("do not deploy")).toBe(false);
    expect(deploy("deploy? no, hold")).toBe(false);
    expect(deploy("deploy not yet")).toBe(false);
    expect(deploy("hold")).toBe(false);
    expect(deploy("keep it safe")).toBe(false);
    // An option by iMessage is the option and nothing else: no extra words
    // (they could say anything about it) and no question.
    expect(
      picks("deploy", "keep it safe", [{ id: "deploy", label: "Deploy" }])("keep it safe"),
    ).toBe(false);
    expect(picks("pg", "keep it simple")("postgres keep it simple")).toBe(false);
    expect(picks("pg", "just kidding")("postgres just kidding")).toBe(false);
    expect(deploy("Deploy would be a disaster")).toBe(false);
    expect(deploy("deploy isn't safe")).toBe(false);
    expect(deploy("Deploy?")).toBe(false);
    expect(deploy("deploy, thanks")).toBe(true);
    // One-letter ids count only as the whole reply.
    const letter = picks("a", "", [
      { id: "a", label: "Online" },
      { id: "b", label: "Offline window" },
    ]);
    expect(letter("A")).toBe(true);
    expect(letter("go online")).toBe(true);
    expect(letter("take a break first")).toBe(false);
    expect(letter("online or offline window")).toBe(false);
    // Free-text answers are his whole reply as typed (spacing aside), so a
    // relay can't change a symbol or a sign on the way.
    expect(picks(null, "Ship Friday!")("Ship  Friday!")).toBe(true);
    expect(picks(null, "ship friday")("Ship Friday!")).toBe(false);
    expect(picks(null, "budget 100")("budget -100")).toBe(false);
    expect(picks(null, "ship friday")("dont ship friday")).toBe(false);
  });

  // Sol N8: an option is compared as typed, so signs, currency, percentages
  // and URLs count, and a reply that could name two options names neither.
  it("N8: an option keeps its symbols and an ambiguous reply picks nothing", () => {
    const pay = [
      { id: "minus", label: "Pay -100" },
      { id: "plus", label: "Pay +100" },
    ];
    expect(picks("plus", "", pay)("Pay +100")).toBe(true);
    expect(picks("plus", "", pay)("go with pay +100, thanks")).toBe(true);
    expect(picks("minus", "", pay)("Pay -100")).toBe(true);
    expect(picks("plus", "", pay)("Pay -100")).toBe(false);
    expect(picks("minus", "", pay)("Pay +100")).toBe(false);
    expect(picks("minus", "", pay)("pay 100")).toBe(false);
    const money = [
      { id: "usd", label: "$100" },
      { id: "pct", label: "100%" },
    ];
    expect(picks("pct", "", money)("100%")).toBe(true);
    expect(picks("usd", "", money)("100%")).toBe(false);
    expect(picks("usd", "", money)("100")).toBe(false);
    const hosts = [
      { id: "dot", label: "evil.example.com" },
      { id: "dash", label: "evil-example.com" },
    ];
    expect(picks("dash", "", hosts)("evil-example.com")).toBe(true);
    expect(picks("dot", "", hosts)("evil-example.com")).toBe(false);
    // Two labels, a label and an id, or two ids that read the same: no tie-break.
    const labels = [
      { id: "x", label: "Postgres" },
      { id: "y", label: "postgres" },
    ];
    expect(picks("x", "", labels)("postgres")).toBe(false);
    expect(picks("y", "", labels)("postgres")).toBe(false);
    const labelVsId = [
      { id: "b", label: "Plan A" },
      { id: "c", label: "b" },
    ];
    expect(picks("b", "", labelVsId)("b")).toBe(false);
    expect(picks("c", "", labelVsId)("b")).toBe(false);
    expect(picks("b", "", labelVsId)("plan a")).toBe(true);
    const ids = [
      { id: "A", label: "First" },
      { id: "a", label: "Second" },
    ];
    expect(picks("A", "", ids)("a")).toBe(false);
    expect(picks("A", "", ids)("first")).toBe(true);
    // A lead word inside one label can make a reply name two options.
    const lead = [
      { id: "cached", label: "Use cache" },
      { id: "plain", label: "Cache" },
    ];
    expect(picks("plain", "", lead)("use cache")).toBe(false);
    expect(picks("cached", "", lead)("use cache")).toBe(false);
  });

  it("N8: option sets that one reply could read two ways are named at creation", () => {
    expect(
      optionCollision([
        { id: "minus", label: "Pay -100" },
        { id: "plus", label: "Pay +100" },
      ]),
    ).toBeNull();
    expect(optionCollision(OPTIONS)).toBeNull();
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

  // Review of N8: a lead or courtesy word can itself be an option, so "yes,
  // no" names both options and records neither.
  it("N8: a lead or courtesy word that is itself an option makes the reply ambiguous", () => {
    const yesNo = [
      { id: "y", label: "Yes" },
      { id: "n", label: "No" },
    ];
    expect(optionCollision(yesNo)).toBeNull();
    expect(picks("y", "", yesNo)("yes")).toBe(true);
    expect(picks("n", "", yesNo)("No.")).toBe(true);
    expect(picks("n", "", yesNo)("yes, no")).toBe(false);
    expect(picks("n", "", yesNo)("Yes. No.")).toBe(false);
    expect(picks("y", "", yesNo)("yes, no")).toBe(false);
    const goStop = [
      { id: "g", label: "Go" },
      { id: "s", label: "Stop" },
    ];
    expect(picks("g", "", goStop)("go")).toBe(true);
    expect(picks("s", "", goStop)("go, stop")).toBe(false);
    const byId = [
      { id: "go", label: "Rollback" },
      { id: "ship", label: "Ship" },
    ];
    expect(optionCollision(byId)).toBeNull();
    expect(picks("ship", "", byId)("ship")).toBe(true);
    expect(picks("ship", "", byId)("go ship")).toBe(false);
  });

  // Review of N8: quotes, brackets and an approving emoji around an option
  // don't change it; a sign or a disapproving emoji still does.
  it("N8: an option may be quoted, bracketed or closed with an approving emoji", () => {
    expect(picks("pg")("Postgres 👍")).toBe(true);
    expect(picks("pg")("Postgres thx 🙏")).toBe(true);
    expect(picks("pg")('"Postgres"')).toBe(true);
    expect(picks("pg")("\u201CPostgres\u201D")).toBe(true);
    expect(picks("pg")("Postgres 👎")).toBe(false);
    const letters = [
      { id: "a", label: "Online" },
      { id: "b", label: "Offline window" },
    ];
    expect(picks("b", "", letters)("(b)")).toBe(true);
    expect(picks("b", "", letters)("B)")).toBe(true);
    const pay = [
      { id: "minus", label: "Pay -100" },
      { id: "plain", label: "Pay 100" },
    ];
    expect(picks("minus", "", pay)("Pay -100 👍🏽")).toBe(true);
    // "(100)" can be a negative amount, so brackets around digits stay.
    expect(picks("plain", "", pay)("Pay (100)")).toBe(false);
  });

  // Review of N8: the checks run inside the asks lock, so long labels must
  // stay cheap.
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
    expect(picks("g3", "", leads)(`${"go ".repeat(300)}3 ${"thanks ".repeat(300)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  // Sol H9: approval needs approval words and nothing else; an edit needs the
  // edited text after them. No substring or OR of approval words.
  it("H9: a draft decision by iMessage must say exactly that decision", () => {
    const approve = decides({ action: "approve" });
    expect(approve("ok send it")).toBe(true);
    expect(approve("Approve")).toBe(true);
    expect(approve("do not approve")).toBe(false);
    expect(approve("ok actually dont send")).toBe(false);
    expect(approve("yes but change the second line")).toBe(false);
    const edited = decides({ action: "approve", editedText: "hello world" });
    expect(edited("approve: hello world")).toBe(true);
    expect(edited("ok send it\nhello world")).toBe(true);
    expect(edited("ok send it with hello world")).toBe(false);
    expect(edited("Do not send the line hello world.")).toBe(false);
    expect(edited("hello world")).toBe(false);
    expect(edited("approve")).toBe(false);
    expect(edited("approve?: hello world")).toBe(false);
    // The edit is compared as typed, so a relay can't swap symbols in it.
    expect(
      decides({ action: "approve", editedText: "see evil.example.com" })(
        "ok: see evil-example.com",
      ),
    ).toBe(false);
    expect(decides({ action: "approve", editedText: "pay -100" })("ok: pay 100")).toBe(false);
    expect(decides({ action: "approve", editedText: "pay -100" })("ok: pay -100")).toBe(true);
    // An approval prefix can't carry a refusal or nothing as the edit.
    expect(decides({ action: "approve", editedText: "don't send it" })("ok: don't send it")).toBe(
      false,
    );
    expect(decides({ action: "approve", editedText: "no wait" })("yes: no wait")).toBe(false);
    expect(decides({ action: "approve", editedText: "it" })("ok send it")).toBe(false);
    expect(decides({ action: "approve", editedText: "!!!" })("ok: !!!")).toBe(false);
    const rewrite = decides({ action: "rewrite", rewriteNote: "shorter please" });
    expect(rewrite("rewrite: shorter please")).toBe(true);
    expect(rewrite("rewrite shorter please")).toBe(false);
    expect(rewrite("shorter please")).toBe(false);
    expect(rewrite("send it: shorter please")).toBe(false);
    const drop = decides({ action: "drop" });
    expect(drop("drop it")).toBe(true);
    expect(drop("dont send")).toBe(true);
    expect(drop("dont drop it")).toBe(false);
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
        typed: true,
        replyTo: "guid-notice-1",
        receivedAt: after,
      });
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
