import { assert, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Analytics from "../analytics/Analytics.ts";
import { requireOwner, type OwnerGateSession } from "./ownerGate.ts";

it.effect("logs owner-gate denials with trusted origins while preserving the refusal", () => {
  const events: AnalyticsEvent[] = [];
  return Effect.gen(function* () {
    const cases: ReadonlyArray<OwnerGateSession> = [
      {
        sessionId: "private-session",
        subject: "private-subject",
        origin: { _tag: "component", component: "private-component" },
      },
      { sessionId: "private-session", subject: "private-subject" },
    ];
    for (const session of cases) {
      const error = yield* requireOwner(session).pipe(Effect.flip);
      assert.equal(error.code, "denied");
    }
    yield* requireOwner({
      sessionId: "owner",
      subject: "owner",
      origin: { _tag: "owner", source: "paired-client" },
    });
    assert.deepStrictEqual(
      events.map((event) => event.props?.originKind),
      ["component", "unknown"],
    );
    assert.isTrue(
      events.every(
        (event) => event.kind === "auth.denied" && event.props?.reason === "owner_session_required",
      ),
    );
    assert.isFalse(JSON.stringify(events).includes("private"));
  }).pipe(
    Effect.provide(
      Layer.mock(Analytics.Analytics)({
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
    ),
  );
});
