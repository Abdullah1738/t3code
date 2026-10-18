import {
  AskId,
  LaneId,
  MissionId,
  RoleId,
  ThreadId,
  type Ask,
  type MissionProvenance,
  type OpenAskInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  answerAsk,
  asksHolding,
  holdIndex,
  openAsk,
  recommendationFollowRate,
  rejectAskDefaults,
  reopenAsk,
  supersedeAsk,
  waitingOn,
  withdrawAsk,
  type OpenAskCommand,
} from "./askModel.ts";
import type { MissionCaller } from "./shared.ts";

const missionId = MissionId.make("m1");
const masterRole = RoleId.make("role-master");
const masterThread = ThreadId.make("thread-master");
const now = "2026-10-17T10:00:00.000Z";

const master: MissionCaller = {
  provenance: { _tag: "agent", threadId: masterThread, roleId: masterRole },
  actors: [
    { _tag: "thread", threadId: masterThread },
    { _tag: "role", roleId: masterRole },
  ],
};
const ownerApp: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s1" };
const owner: MissionCaller = { provenance: ownerApp, actors: [{ _tag: "owner" }] };

const input = (overrides: Partial<OpenAskInput> = {}): OpenAskInput => ({
  missionId,
  question: "Ship the ledger migration before the API change?",
  context: "Both touch the balances table.",
  options: [
    { id: "a", label: "Migration first", detail: "Safer rollback." },
    { id: "b", label: "API first", detail: "Unblocks mobile." },
  ],
  recommendation: { optionId: "a", reason: "Rollback is simpler." },
  blocks: [
    { kind: "work-item", id: "wi-1" },
    { kind: "lane", id: "lane-api" },
  ],
  costOfWaiting: "The API lane idles.",
  ...overrides,
});

const command = (overrides: Partial<OpenAskCommand> = {}): OpenAskCommand => ({
  id: AskId.make("ask-1"),
  input: input(),
  caller: master,
  askedBy: { _tag: "role", roleId: masterRole },
  existing: [],
  now,
  ...overrides,
});

const opened = (overrides: Partial<OpenAskCommand> = {}): Ask =>
  Result.getOrThrow(openAsk(command(overrides))).record;

const errorCode = (outcome: Result.Result<unknown, { readonly code: string }>) =>
  Result.isFailure(outcome) ? outcome.failure.code : "ok";

describe("open ask", () => {
  it("opens with exactly the declared blocks and no default", () => {
    const outcome = Result.getOrThrow(openAsk(command()));
    expect(outcome.record.status).toBe("open");
    expect(outcome.record.answer).toBeNull();
    expect(outcome.record.blocks.map((ref) => ref.id)).toEqual(["wi-1", "lane-api"]);
    expect(Object.keys(outcome.record)).not.toContain("default");
    expect(outcome.events.map((event) => event.kind)).toEqual(["ask.opened"]);
  });

  it("refuses any default, deadline or auto-answer field in the raw command", () => {
    for (const raw of [
      { ...input(), default: "a" },
      { ...input(), defaultOptionId: "a" },
      { ...input(), deadline: "2026-10-18T00:00:00Z" },
      { ...input(), timeoutMs: 60_000 },
      { ...input(), recommendation: { optionId: "a", reason: "x", isDefault: true } },
      { ...input(), options: [{ id: "a", label: "A", detail: "", default: true }] },
    ]) {
      expect(errorCode(rejectAskDefaults(raw))).toBe("invalid");
    }
    expect(errorCode(rejectAskDefaults(input()))).toBe("ok");
  });

  it("refuses wording that turns silence into an answer", () => {
    const outcome = openAsk(
      command({ input: input({ costOfWaiting: "I'll go with A unless you say otherwise." }) }),
    );
    expect(errorCode(outcome)).toBe("invalid");
    const phrased = openAsk(
      command({ input: input({ context: "If I don't hear back by noon I will pick B." }) }),
    );
    expect(errorCode(phrased)).toBe("invalid");
  });

  it("requires named blocks and refuses holding the whole mission", () => {
    expect(errorCode(openAsk(command({ input: input({ blocks: [] }) })))).toBe("invalid");
    expect(
      errorCode(openAsk(command({ input: input({ blocks: [{ kind: "mission", id: "m1" }] }) }))),
    ).toBe("invalid");
  });

  it("checks options and the recommendation", () => {
    const duplicate = input({
      options: [
        { id: "a", label: "A", detail: "" },
        { id: "a", label: "B", detail: "" },
      ],
    });
    expect(errorCode(openAsk(command({ input: duplicate })))).toBe("invalid");
    const stray = input({ recommendation: { optionId: "z", reason: "" } });
    expect(errorCode(openAsk(command({ input: stray })))).toBe("invalid");
  });

  // Sol N8: he answers by naming an option, so two options one reply could
  // name are refused when the ask opens.
  it("N8: refuses options that read the same once case and lead words are set aside", () => {
    const withOptions = (options: OpenAskInput["options"]) =>
      openAsk(
        command({
          input: input({ options, recommendation: { optionId: options[0]!.id, reason: "" } }),
        }),
      );
    expect(
      errorCode(
        withOptions([
          { id: "a", label: "Postgres", detail: "" },
          { id: "b", label: "postgres", detail: "" },
        ]),
      ),
    ).toBe("invalid");
    expect(
      errorCode(
        withOptions([
          { id: "b", label: "Plan A", detail: "" },
          { id: "c", label: "B", detail: "" },
        ]),
      ),
    ).toBe("invalid");
    expect(
      errorCode(
        withOptions([
          { id: "cached", label: "Use cache", detail: "" },
          { id: "plain", label: "Cache", detail: "" },
        ]),
      ),
    ).toBe("invalid");
    expect(
      errorCode(
        withOptions([
          { id: "minus", label: "Pay -100", detail: "" },
          { id: "plus", label: "Pay +100", detail: "" },
        ]),
      ),
    ).toBe("ok");
  });

  it("refuses asking as an identity the caller does not hold, and refuses the owner asking", () => {
    const other = command({ askedBy: { _tag: "lane", laneId: LaneId.make("lane-x") } });
    expect(errorCode(openAsk(other))).toBe("forbidden");
    expect(errorCode(openAsk(command({ caller: owner })))).toBe("forbidden");
  });

  it("does not re-ask an open question and links a prior answer", () => {
    const first = opened();
    const again = command({ id: AskId.make("ask-2"), existing: [first] });
    expect(errorCode(openAsk(again))).toBe("conflict");
    const answered: Ask = {
      ...first,
      status: "answered",
      answer: { optionId: "a", text: "", provenance: ownerApp, answeredAt: now },
    };
    const relinked = Result.getOrThrow(
      openAsk(command({ id: AskId.make("ask-3"), existing: [answered] })),
    );
    expect(relinked.events[0]?.payload).toMatchObject({
      priorAnswers: [{ askId: "ask-1" }],
    });
  });
});

describe("answer ask", () => {
  const ask = opened();

  it("lets the owner answer from the app and releases the blocks", () => {
    const outcome = Result.getOrThrow(
      answerAsk({
        ask,
        input: { askId: ask.id, optionId: "a", text: "" },
        provenance: ownerApp,
        asks: [ask],
        now,
      }),
    );
    expect(outcome.record.status).toBe("answered");
    expect(outcome.record.answer?.provenance).toEqual(ownerApp);
    expect(outcome.released.map((ref) => ref.id)).toEqual(["wi-1", "lane-api"]);
    expect(outcome.events[0]?.payload).toMatchObject({ followedRecommendation: true });
  });

  it("never accepts an agent, system or import answer", () => {
    for (const provenance of [
      master.provenance,
      { _tag: "system", component: "governor" },
      { _tag: "import", source: "coord.db" },
    ] satisfies MissionProvenance[]) {
      const outcome = answerAsk({
        ask,
        input: { askId: ask.id, optionId: "a", text: "" },
        provenance,
        asks: [ask],
        now,
      });
      expect(errorCode(outcome)).toBe("provenance-required");
    }
  });

  it("accepts a verified iMessage answer only for the inbound it names", () => {
    const provenance: MissionProvenance = {
      _tag: "owner-imessage",
      chat: "moni",
      inboundId: "in-1",
    };
    const ok = answerAsk({
      ask,
      input: { askId: ask.id, optionId: null, text: "Migration first", inboundId: "in-1" },
      provenance,
      asks: [ask],
      now,
    });
    expect(Result.isSuccess(ok)).toBe(true);
    const mismatched = answerAsk({
      ask,
      input: { askId: ask.id, optionId: null, text: "Migration first", inboundId: "in-2" },
      provenance,
      asks: [ask],
      now,
    });
    expect(errorCode(mismatched)).toBe("provenance-invalid");
  });

  it("refuses answering twice, unknown options and empty answers", () => {
    const answered: Ask = { ...ask, status: "answered" };
    const base = { provenance: ownerApp, asks: [ask], now };
    expect(
      errorCode(
        answerAsk({ ...base, ask: answered, input: { askId: ask.id, optionId: "a", text: "" } }),
      ),
    ).toBe("conflict");
    expect(
      errorCode(answerAsk({ ...base, ask, input: { askId: ask.id, optionId: "q", text: "" } })),
    ).toBe("invalid");
    expect(
      errorCode(answerAsk({ ...base, ask, input: { askId: ask.id, optionId: null, text: "  " } })),
    ).toBe("invalid");
  });
});

describe("holds", () => {
  it("only the declared blocks wait; another open ask keeps its shared hold", () => {
    const first = opened();
    const second = opened({
      id: AskId.make("ask-2"),
      input: input({ question: "Which region?", blocks: [{ kind: "lane", id: "lane-api" }] }),
    });
    const asks = [first, second];
    expect(waitingOn({ kind: "work-item", id: "wi-1" }, asks)).toContain("ask-1");
    expect(waitingOn({ kind: "work-item", id: "wi-other" }, asks)).toBeNull();
    expect(waitingOn({ kind: "lane", id: "lane-web" }, asks)).toBeNull();
    expect(asksHolding({ kind: "lane", id: "lane-api" }, asks).map((ask) => ask.id)).toEqual([
      "ask-1",
      "ask-2",
    ]);
    expect(holdIndex(asks).get("lane:lane-api")).toEqual(["ask-1", "ask-2"]);

    const answer = Result.getOrThrow(
      answerAsk({
        ask: first,
        input: { askId: first.id, optionId: "b", text: "" },
        provenance: ownerApp,
        asks,
        now,
      }),
    );
    expect(answer.released.map((ref) => ref.id)).toEqual(["wi-1"]);
    expect(waitingOn({ kind: "lane", id: "lane-api" }, [answer.record, second])).toContain("ask-2");
  });
});

describe("reverse states", () => {
  it("withdraw by the asker releases the holds; strangers cannot withdraw", () => {
    const ask = opened();
    const withdrawn = Result.getOrThrow(
      withdrawAsk({ ask, caller: master, reason: "Decided myself", asks: [ask], now }),
    );
    expect(withdrawn.record.status).toBe("withdrawn");
    expect(withdrawn.released).toHaveLength(2);
    const stranger: MissionCaller = {
      provenance: { _tag: "agent", threadId: ThreadId.make("t-x"), roleId: null },
      actors: [{ _tag: "thread", threadId: ThreadId.make("t-x") }],
    };
    expect(errorCode(withdrawAsk({ ask, caller: stranger, reason: "", asks: [ask], now }))).toBe(
      "forbidden",
    );
  });

  it("supersede hands every hold to the replacement without a gap", () => {
    const ask = opened();
    const outcome = Result.getOrThrow(
      supersedeAsk({
        ask,
        replacement: command({
          id: AskId.make("ask-2"),
          input: input({
            question: "Ship migration first, given the new index?",
            blocks: [{ kind: "work-item", id: "wi-2" }],
          }),
          existing: [ask],
        }),
      }),
    );
    expect(outcome.superseded.record.status).toBe("superseded");
    expect(outcome.replacement.record.blocks.map((ref) => ref.id)).toEqual([
      "wi-1",
      "lane-api",
      "wi-2",
    ]);
    expect(outcome.superseded.events[0]?.kind).toBe("ask.superseded");
    expect(outcome.superseded.events[0]?.payload).toMatchObject({ supersededBy: "ask-2" });
  });

  it("only the owner reopens an answered ask, and it holds again", () => {
    const ask = opened();
    const answered = Result.getOrThrow(
      answerAsk({
        ask,
        input: { askId: ask.id, optionId: "a", text: "" },
        provenance: ownerApp,
        asks: [ask],
        now,
      }),
    ).record;
    expect(
      errorCode(reopenAsk({ ask: answered, provenance: master.provenance, reason: "", now })),
    ).toBe("provenance-required");
    const reopened = Result.getOrThrow(
      reopenAsk({ ask: answered, provenance: ownerApp, reason: "Changed my mind", now }),
    );
    expect(reopened.record.status).toBe("open");
    expect(reopened.events[0]?.kind).toBe("ask.reopened");
    expect(waitingOn({ kind: "work-item", id: "wi-1" }, [reopened.record])).not.toBeNull();
  });

  it("N9: a reopen starts a new epoch and spends the iMessage that answered the old one", () => {
    const ask = opened();
    const imessage: MissionProvenance = {
      _tag: "owner-imessage",
      chat: "owner",
      inboundId: "in-1",
    };
    const answerWith = (target: Ask, inboundId: string) =>
      answerAsk({
        ask: target,
        input: { askId: target.id, optionId: "a", text: "", inboundId },
        provenance: { ...imessage, inboundId },
        asks: [target],
        now,
      });
    const answered = Result.getOrThrow(answerWith(ask, "in-1")).record;
    const later = "2026-10-17T11:00:00.000Z";
    const reopened = Result.getOrThrow(
      reopenAsk({ ask: answered, provenance: ownerApp, reason: "", now: later }),
    ).record;
    expect(reopened.revision).toBe(1);
    expect(reopened.revisedAt).toBe(later);
    expect(reopened.spentInboundIds).toEqual(["in-1"]);
    expect(errorCode(answerWith(reopened, "in-1"))).toBe("provenance-invalid");
    const second = Result.getOrThrow(answerWith(reopened, "in-2")).record;
    const twice = Result.getOrThrow(
      reopenAsk({ ask: second, provenance: ownerApp, reason: "", now: later }),
    ).record;
    expect(twice.revision).toBe(2);
    expect(twice.spentInboundIds).toEqual(["in-1", "in-2"]);
  });
});

describe("recommendation follow rate", () => {
  it("counts only answered asks that carried a recommended option", () => {
    const ask = opened();
    const answer = (optionId: string): Ask => ({
      ...ask,
      status: "answered",
      answer: { optionId, text: "", provenance: ownerApp, answeredAt: now },
    });
    expect(recommendationFollowRate([answer("a"), answer("a"), answer("b"), ask])).toEqual({
      answered: 3,
      followed: 2,
    });
  });
});
