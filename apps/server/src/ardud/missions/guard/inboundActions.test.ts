/**
 * The shared iMessage ledger (Sol boundary 4, Q1 and Q4): who may redeem an
 * inbound, and how one inbound drives each write at most once, whichever
 * route carries it.
 */
import { describe, expect, it } from "@effect/vitest";
import type { MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Inbound from "../asks/inbound.ts";
import type { InboundMessage } from "../asks/provenance.ts";
import { inboundLedger, type InboundAttempt } from "./inboundActions.ts";

const cli: MissionProvenance = { _tag: "system", component: "mission-cli" };
const bridge: MissionProvenance = { _tag: "system", component: "spectrum-bridge" };
const telegram: MissionProvenance = { _tag: "system", component: "telegram-bridge" };
const control: MissionProvenance = { _tag: "system", component: "control-api" };

const typed = (id: string, text: string): InboundMessage => ({
  id,
  chat: "owner",
  text,
  receivedAt: Date.parse("2026-10-19T10:00:00.000Z"),
  typed: true,
});

const harness = (inbox: ReadonlyArray<InboundMessage>) => {
  const lookedUp: string[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      Inbound.InboundLookup,
      Inbound.InboundLookup.of({
        find: (id) => {
          lookedUp.push(id);
          return Effect.succeed(inbox.find((message) => message.id === id) ?? null);
        },
      }),
    ),
    Sqlite.layerMemory,
  );
  return { lookedUp, layer };
};

const attempt = (overrides: Partial<InboundAttempt> = {}): InboundAttempt => ({
  caller: cli,
  inboundId: "in-1",
  subject: "ask:ask-1",
  action: "answer",
  payload: { optionId: "a" },
  what: "Answering an ask",
  notBefore: () => Effect.succeed({ at: "2026-10-19T09:00:00.000Z" }),
  ...overrides,
});

const codeOf = <A, E extends { readonly code: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "ok" }));

describe("inbound ledger", () => {
  it.effect("Q1: only the bridge and the mission CLI redeem, and others before any lookup", () => {
    const h = harness([typed("in-1", "go with a")]);
    return Effect.gen(function* () {
      const ledger = yield* inboundLedger;
      for (const caller of [telegram, control, { _tag: "agent", threadId: "t-1" } as never]) {
        expect(yield* codeOf(ledger.redeem(attempt({ caller })))).toBe("forbidden");
      }
      expect(h.lookedUp).toEqual([]);
      const redeemed = yield* ledger.redeem(attempt({ caller: bridge }));
      expect(redeemed).toMatchObject({
        _tag: "fresh",
        provenance: {
          _tag: "owner-imessage",
          chat: "owner",
          inboundId: "in-1",
          quote: "go with a",
        },
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("Q4: one write per inbound and record, replayed on any route, others refused", () => {
    const h = harness([typed("in-1", "approve both")]);
    return Effect.gen(function* () {
      const ledger = yield* inboundLedger;
      let runs = 0;
      const write = (overrides: Partial<InboundAttempt> = {}) =>
        ledger.once(attempt(overrides), (owner) =>
          Effect.sync(() => {
            runs += 1;
            return { ok: true, run: runs, by: owner.inboundId };
          }),
        );
      const first = yield* write();
      expect(first).toEqual({ ok: true, run: 1, by: "in-1" });
      // The bridge's credential retrying the same write gets the same answer, nothing runs.
      expect(yield* write({ caller: bridge })).toEqual(first);
      expect(runs).toBe(1);
      // The same inbound cannot do something else to that record.
      expect(yield* codeOf(write({ payload: { optionId: "b" } }))).toBe("conflict");
      // "Approve both": the same message drives one write on another record.
      expect(
        yield* write({ subject: "draft:d-1", action: "decide", payload: { action: "approve" } }),
      ).toEqual({
        ok: true,
        run: 2,
        by: "in-1",
      });
      // A replay-only attempt (a record that changed state) never claims anew.
      expect(yield* codeOf(write({ subject: "draft:d-2", replayOnly: true }))).toBe("conflict");
      expect(runs).toBe(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a failed run gives the claim back, so the next attempt may run", () => {
    const h = harness([typed("in-1", "go with a")]);
    return Effect.gen(function* () {
      const ledger = yield* inboundLedger;
      const failed = yield* codeOf(
        ledger.once(attempt(), () => Effect.fail({ code: "conflict-elsewhere" } as const)),
      );
      expect(failed).toBe("conflict-elsewhere");
      expect(yield* ledger.once(attempt(), () => Effect.succeed({ ok: true }))).toEqual({
        ok: true,
      });
    }).pipe(Effect.provide(h.layer));
  });

  // Live clock: the claim's age is judged against now.
  it.live("an unfinished claim holds a minute, then a retry takes it over", () => {
    const h = harness([typed("in-1", "go with a")]);
    return Effect.gen(function* () {
      const ledger = yield* inboundLedger;
      const sql = yield* SqlClient.SqlClient;
      const held = yield* ledger.redeem(attempt());
      expect(held._tag).toBe("fresh");
      expect(yield* codeOf(ledger.once(attempt(), () => Effect.succeed("again")))).toBe("conflict");
      // Age the claim past the minute, as if the run that took it died.
      yield* sql`
        UPDATE ardud_mission_guard_inbound_actions SET claimed_at = '2026-01-01T00:00:00.000Z'
      `;
      expect(yield* ledger.once(attempt(), () => Effect.succeed("again"))).toBe("again");
      expect(yield* ledger.once(attempt(), () => Effect.succeed("third"))).toBe("again");
    }).pipe(Effect.provide(h.layer));
  });
});
