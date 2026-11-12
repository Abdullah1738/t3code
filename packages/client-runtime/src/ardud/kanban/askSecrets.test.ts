import type { KanbanOwnerAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { askFormFor, buildAskAnswer } from "./askAnswer.ts";
import {
  askBodyWithoutSecrets,
  askFormWithSecrets,
  askSecretAnswerInput,
  askSecretFailure,
  askSecretFieldIds,
} from "./askSecrets.ts";

const ask = {
  id: "q1",
  text: "Cliq token",
  blocking: true,
  by: { _tag: "owner" },
  at: "2026-11-10T10:00:00.000Z",
  seq: null,
  closedAt: null,
  kind: "secret",
  respond: {
    fields: [
      { id: "token", label: "Token", type: "secret", required: true },
      { id: "scope", label: "Scope", type: "text" },
    ],
  },
} as unknown as KanbanOwnerAsk;

describe("ask secrets", () => {
  it("checks a required secret without putting its value in the form", () => {
    const form = { ...askFormFor(ask), values: { scope: "chat" } };
    const missing = buildAskAnswer(ask, askFormWithSecrets(ask, form, {}), "primary", 0);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.first).toBe("field:token");

    const withSecret = askFormWithSecrets(ask, form, { token: "s3cret" });
    expect(JSON.stringify(withSecret)).not.toContain("s3cret");
    expect(buildAskAnswer(ask, withSecret, "primary", 0).ok).toBe(true);
  });

  it("builds one call: the answer without the secret field, the value beside it", () => {
    const form = askFormWithSecrets(
      ask,
      { ...askFormFor(ask), values: { scope: "chat" } },
      { token: "s3cret" },
    );
    const built = buildAskAnswer(ask, form, "primary", 2);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const input = askSecretAnswerInput("card-1", ask, built.body, { token: "s3cret" });
    expect(input).toEqual({
      cardId: "card-1",
      askId: "q1",
      answer: { verdict: "answered", values: { scope: "chat" }, revision: 2 },
      secrets: { token: "s3cret" },
    });
    expect(JSON.stringify(input?.answer)).not.toContain("s3cret");
  });

  it("sends an answer with no secret typed the usual way", () => {
    expect(askSecretFieldIds(ask)).toEqual(["token"]);
    expect(
      askSecretAnswerInput("card-1", ask, { verdict: "answered" }, { token: "  " }),
    ).toBeNull();
    expect(
      askBodyWithoutSecrets(ask, { verdict: "answered", values: { token: { secret: true } } }),
    ).toEqual({ verdict: "answered" });
  });

  it("words each refusal, and never from the request", () => {
    // A component's or a hand-issued token: the server's own message, and no device to pair.
    expect(askSecretFailure({ _tag: "EnvironmentAuthorizationError", message: "no" })).toEqual({
      message: "no",
      stale: false,
      field: null,
      notOwner: { device: false },
    });
    expect(
      askSecretFailure({
        _tag: "KanbanError",
        code: "denied",
        detail: "This device isn't paired as yours.",
        reason: "not_owner_device",
      }),
    ).toEqual({
      message: "This device isn't paired as yours.",
      stale: false,
      field: null,
      notOwner: { device: true },
    });
    expect(
      askSecretFailure({ _tag: "KanbanError", code: "denied", detail: "Only the owner does this." })
        .notOwner,
    ).toEqual({ device: false });
    expect(
      askSecretFailure({
        _tag: "KanbanError",
        code: "invalid",
        detail: "q1 on card #4 needs the revision you are answering.",
        revision: 3,
      }).stale,
    ).toBe(true);
    // The words alone do not make it stale: the revision is read from its field.
    expect(
      askSecretFailure({
        _tag: "KanbanError",
        code: "invalid",
        detail: "It is at revision 3",
      }).stale,
    ).toBe(false);
    expect(askSecretFailure({ _tag: "KanbanError", code: "conflict", detail: "x" }).stale).toBe(
      true,
    );
    expect(
      askSecretFailure({
        _tag: "KanbanError",
        code: "invalid",
        detail: 'secret field "token" is empty',
      }),
    ).toEqual({ message: 'Secret field "token" is empty.', stale: false, field: "token" });
    expect(askSecretFailure(new Error("s3cret")).message).toBe("Not sent. Type the secret again.");
  });
});
