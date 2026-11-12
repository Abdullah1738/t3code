import type { KanbanOwnerAsk } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  askBatchShape,
  askFieldProblem,
  askFormCarried,
  askFormFor,
  askPrimaryLabel,
  askRefusal,
  askWordsForReply,
  buildAskAnswer,
  planAskBatch,
  type AskForm,
} from "./askAnswer.ts";
import { kanbanAskResponse } from "@t3tools/contracts";

const ask = (patch: Partial<KanbanOwnerAsk> = {}): KanbanOwnerAsk =>
  ({
    id: "q1",
    text: "Question",
    blocking: false,
    by: { _tag: "owner" },
    at: "2026-11-10T10:00:00.000Z",
    seq: null,
    closedAt: null,
    ...patch,
  }) as KanbanOwnerAsk;

const field = (patch: Record<string, unknown>) =>
  ({ id: "f", label: "Field", type: "text", ...patch }) as never;

const filled = (base: KanbanOwnerAsk, patch: Partial<AskForm>): AskForm => ({
  ...askFormFor(base),
  ...patch,
});

const ACTION = { summary: "Deploy the bridge", command: "deploy.zsh bridge" };
const OPTIONS = [
  { id: "now", label: "Now" },
  { id: "night", label: "Tonight", recommended: true },
] as never;

describe("buildAskAnswer", () => {
  it("answers a plain old ask with its free text, and refuses an empty one", () => {
    const plain = ask();
    const empty = buildAskAnswer(plain, askFormFor(plain), "primary", 0);
    expect(empty).toMatchObject({ ok: false, first: "field:answer" });
    const sent = buildAskAnswer(
      plain,
      filled(plain, { values: { answer: " Ship it " } }),
      "primary",
      0,
    );
    expect(sent).toEqual({
      ok: true,
      body: { verdict: "answered", text: "Ship it", revision: 0 },
      label: "Answer sent",
    });
  });

  it("approves and rejects a verdict ask, carrying the note", () => {
    const action = ask({ kind: "action", action: ACTION });
    expect(
      buildAskAnswer(action, filled(action, { note: " next time just do it " }), "primary", 3),
    ).toEqual({
      ok: true,
      body: { verdict: "approved", note: "next time just do it", revision: 3 },
      label: "Approved",
    });
    expect(buildAskAnswer(action, askFormFor(action), "refuse")).toEqual({
      ok: true,
      body: { verdict: "rejected" },
      label: "Rejected",
    });
  });

  it("uses the asker's own labels", () => {
    const signoff = ask({
      kind: "signoff",
      respond: { verdict: { approve: "Passes", reject: "Fails" } },
    });
    expect(askPrimaryLabel(signoff, askFormFor(signoff))).toBe("Passes");
    expect(buildAskAnswer(signoff, askFormFor(signoff), "primary")).toMatchObject({
      ok: true,
      label: "Passes",
    });
    expect(askRefusal(kanbanAskResponse(signoff))).toEqual({
      label: "Fails",
      why: "optional",
      prompt: "What's wrong?",
    });
    expect(
      buildAskAnswer(
        signoff,
        filled(signoff, { refusing: true, why: "Send button overlaps" }),
        "refuse",
      ),
    ).toEqual({
      ok: true,
      body: { verdict: "rejected", text: "Send button overlaps" },
      label: "Fails",
    });
  });

  it("picks the recommended option when nothing is picked on a single choice", () => {
    const decision = ask({ kind: "decision", options: OPTIONS });
    expect(askPrimaryLabel(decision, askFormFor(decision))).toBe("Accept recommendation");
    expect(buildAskAnswer(decision, askFormFor(decision), "primary")).toMatchObject({
      ok: true,
      body: { verdict: "picked", optionIds: ["night"] },
    });
    expect(
      buildAskAnswer(decision, filled(decision, { optionIds: ["now"] }), "primary"),
    ).toMatchObject({
      ok: true,
      body: { verdict: "picked", optionIds: ["now"] },
    });
  });

  it("takes his own words in place of a pick he may leave empty", () => {
    const decision = ask({ kind: "decision", options: OPTIONS, respond: { choose: { min: 0 } } });
    const typed = filled(decision, { ownWords: "Neither, wait a week" });
    expect(buildAskAnswer(decision, typed, "primary")).toEqual({
      ok: true,
      body: { verdict: "answered", text: "Neither, wait a week" },
      label: "Answer sent",
    });
    expect(askWordsForReply(decision, typed)).toBeNull();
    expect(askPrimaryLabel(decision, typed)).toBe("Send answer");
  });

  it("never sends words alone as the answer to a pick he has to make", () => {
    const decision = ask({ kind: "decision", options: OPTIONS });
    const typed = filled(decision, { ownWords: " Neither, wait a week " });
    expect(buildAskAnswer(decision, typed, "primary")).toMatchObject({
      ok: false,
      first: "choose",
    });
    expect(askWordsForReply(decision, typed)).toBe("Neither, wait a week");
    expect(askPrimaryLabel(decision, typed)).toBe("Send as a reply");
    // A pick with words beside it is an answer, and so is a pick alone.
    expect(askWordsForReply(decision, filled(decision, { optionIds: ["now"] }))).toBeNull();
    expect(askWordsForReply(decision, askFormFor(decision))).toBeNull();
  });

  it("keeps words on an approval with its verdict, not as a reply", () => {
    const approval = ask({ kind: "action", action: ACTION });
    expect(askWordsForReply(approval, filled(approval, { note: "careful" }))).toBeNull();
  });

  it("asks for a pick when there is no recommendation", () => {
    const decision = ask({
      kind: "decision",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ] as never,
    });
    expect(buildAskAnswer(decision, askFormFor(decision), "primary")).toEqual({
      ok: false,
      problems: { choose: "Pick one first" },
      first: "choose",
    });
  });

  it("sends an approval with the option picked on an action with a choice", () => {
    const combo = ask({
      kind: "action",
      action: ACTION,
      options: OPTIONS,
      respond: { verdict: { approve: "Deploy", reject: "Don't deploy" }, choose: {} },
    });
    expect(buildAskAnswer(combo, filled(combo, { optionIds: ["now"] }), "primary", 1)).toEqual({
      ok: true,
      body: { verdict: "approved", optionIds: ["now"], revision: 1 },
      label: "Deploy",
    });
  });

  it("honours min and max on a multi choice", () => {
    const multi = ask({
      kind: "flake-triage",
      multi: true,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ] as never,
      respond: { choose: { min: 1, max: 2 } },
    });
    expect(buildAskAnswer(multi, askFormFor(multi), "primary")).toMatchObject({
      ok: false,
      problems: { choose: "Pick one first" },
    });
    expect(
      buildAskAnswer(multi, filled(multi, { optionIds: ["a", "b", "c"] }), "primary"),
    ).toMatchObject({
      ok: false,
      problems: { choose: "Pick at most 2" },
    });
    expect(
      buildAskAnswer(multi, filled(multi, { optionIds: ["a", "c"] }), "primary"),
    ).toMatchObject({
      ok: true,
      body: { verdict: "picked", optionIds: ["a", "c"] },
    });
  });

  it("checks every field and converts values for the wire", () => {
    const form = ask({
      kind: "input",
      respond: {
        fields: [
          field({ id: "cap", type: "number", unit: "USD", min: 1, max: 200, required: true }),
          field({ id: "by", type: "date", required: true }),
          field({ id: "stop", type: "toggle", default: true }),
          field({ id: "at", type: "datetime" }),
          field({ id: "size", type: "select", options: [{ id: "l", label: "Large" }] }),
          field({ id: "why", type: "longtext" }),
        ],
      },
    });
    const start = askFormFor(form);
    expect(start.values).toMatchObject({ cap: "", by: "", stop: true, size: "" });
    const bad = buildAskAnswer(
      form,
      filled(form, { values: { ...start.values, cap: "950" } }),
      "primary",
    );
    expect(bad).toEqual({
      ok: false,
      problems: { "field:cap": "Enter 1 to 200 USD", "field:by": "Fill this in first" },
      first: "field:cap",
    });
    const good = buildAskAnswer(
      form,
      filled(form, {
        values: {
          ...start.values,
          cap: " 25 ",
          by: "2026-11-20",
          at: "2026-11-20T09:30",
          size: "l",
        },
      }),
      "primary",
      2,
    );
    expect(good).toMatchObject({
      ok: true,
      body: {
        verdict: "answered",
        values: { cap: 25, by: "2026-11-20", stop: true, size: "l" },
        revision: 2,
      },
    });
    if (good.ok) {
      expect(Date.parse(String(good.body.values?.at))).toBe(Date.parse("2026-11-20T09:30"));
      expect(good.body.values).not.toHaveProperty("why");
    }
  });

  it("sends the edited draft, and no draft when it is untouched", () => {
    const draft = ask({ kind: "draft", draft: { text: "Hello there", format: "text" } });
    expect(buildAskAnswer(draft, askFormFor(draft), "primary")).toEqual({
      ok: true,
      body: { verdict: "approved" },
      label: "Approved",
    });
    const edited = filled(draft, { draft: "Hello, all" });
    expect(askPrimaryLabel(draft, edited)).toBe("Send your text");
    expect(buildAskAnswer(draft, edited, "primary")).toEqual({
      ok: true,
      body: { verdict: "approved", finalDraft: "Hello, all" },
      label: "Approved with your edits",
    });
    expect(buildAskAnswer(draft, filled(draft, { draft: "  " }), "primary")).toMatchObject({
      ok: false,
      first: "draft",
    });
  });

  it("requires the proof for done and a reason for couldn't on a task", () => {
    const task = ask({
      kind: "task",
      respond: {
        task: { steps: [{ text: "Open the page" }], proof: "shot" },
        fields: [field({ id: "shot", type: "file", label: "Proof" })],
      },
    });
    expect(askPrimaryLabel(task, askFormFor(task))).toBe("Done");
    expect(buildAskAnswer(task, askFormFor(task), "primary")).toMatchObject({
      ok: false,
      problems: { "field:shot": "Add the file first" },
    });
    const file = {
      type: "image",
      id: "att-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    expect(buildAskAnswer(task, filled(task, { values: { shot: [file] } }), "primary")).toEqual({
      ok: true,
      body: { verdict: "done", values: { shot: [file] } },
      label: "Done",
    });
    expect(buildAskAnswer(task, askFormFor(task), "refuse")).toMatchObject({
      ok: false,
      first: "why",
    });
    expect(buildAskAnswer(task, filled(task, { why: "No access" }), "refuse")).toEqual({
      ok: true,
      body: { verdict: "cant", text: "No access" },
      label: "Couldn't",
    });
  });

  it("marks a notice seen and never sends a note with it", () => {
    const notice = ask({ kind: "notice", respond: { ack: true } });
    expect(askPrimaryLabel(notice, askFormFor(notice))).toBe("Seen");
    expect(buildAskAnswer(notice, filled(notice, { note: "ok" }), "primary", 0)).toEqual({
      ok: true,
      body: { verdict: "acknowledged", revision: 0 },
      label: "Seen",
    });
    expect(askRefusal(kanbanAskResponse(notice))).toBeNull();
  });

  it("holds back a required secret until the private channel has taken it", () => {
    const secret = ask({
      kind: "secret",
      respond: { fields: [field({ id: "key", type: "secret", required: true })] },
    });
    expect(buildAskAnswer(secret, askFormFor(secret), "primary")).toMatchObject({
      ok: false,
      problems: { "field:key": "Paste it first" },
    });
    expect(
      buildAskAnswer(secret, filled(secret, { values: { key: { secret: true } } }), "primary"),
    ).toMatchObject({ ok: true, body: { values: { key: { secret: true } } } });
  });

  it("treats an unknown field type as text and an unknown kind like any other", () => {
    const odd = ask({
      kind: "never-seen",
      respond: { fields: [field({ id: "x", type: "colour", required: true })] },
    });
    expect(buildAskAnswer(odd, askFormFor(odd), "primary")).toMatchObject({
      ok: false,
      problems: { "field:x": "Fill this in first" },
    });
    expect(buildAskAnswer(odd, filled(odd, { values: { x: "teal" } }), "primary")).toMatchObject({
      ok: true,
      body: { verdict: "answered", values: { x: "teal" } },
    });
  });
});

describe("askFieldProblem", () => {
  it("names the limit that was passed", () => {
    expect(askFieldProblem(field({ type: "number", min: 0 }), "-1")).toBe("Enter 0 or more");
    expect(askFieldProblem(field({ type: "number", max: 5, unit: "tries" }), "9")).toBe(
      "Enter 5 tries or less",
    );
    expect(askFieldProblem(field({ type: "number" }), "abc")).toBe("Enter a number");
    expect(askFieldProblem(field({ type: "number" }), "")).toBeNull();
  });

  it("checks files against what the field accepts", () => {
    const pdf = { type: "file", id: "1", name: "c.pdf", mimeType: "application/pdf", sizeBytes: 1 };
    const zip = { type: "file", id: "2", name: "c.zip", mimeType: "application/zip", sizeBytes: 1 };
    const accepts = field({
      type: "file",
      accepts: ["application/pdf", "image/*", ".csv"],
      maxFiles: 1,
    });
    expect(askFieldProblem(accepts, [pdf])).toBeNull();
    expect(askFieldProblem(accepts, [zip])).toBe("c.zip is not application/pdf, image/*, .csv");
    expect(askFieldProblem(accepts, [pdf, pdf])).toBe("One file only");
  });

  it("caps a custom value at 8 KB of JSON", () => {
    const custom = field({ type: "custom", required: true });
    expect(askFieldProblem(custom, undefined)).toBe("Pick a value above first");
    expect(askFieldProblem(custom, 4)).toBeNull();
    expect(askFieldProblem(custom, "x".repeat(9000))).toBe("That value is too large to send");
  });
});

describe("askFormCarried", () => {
  it("keeps what he typed where the edited ask still has a place for it", () => {
    const before = ask({ kind: "decision", options: OPTIONS });
    const typed = filled(before, { optionIds: ["now"], note: "careful", ownWords: "" });
    const after = ask({
      kind: "decision",
      revision: 1,
      options: [
        { id: "night", label: "Tonight" },
        { id: "weekend", label: "Weekend" },
      ] as never,
    });
    const carried = askFormCarried(after, typed);
    expect(carried.optionIds).toEqual([]);
    expect(carried.note).toBe("careful");
  });
});

describe("planAskBatch", () => {
  const item = (id: string, patch: Partial<KanbanOwnerAsk> = {}, expired = false) => ({
    id,
    ask: ask({ id, kind: "action", action: ACTION, ...patch }),
    expired,
  });

  it("matches the server's shapes", () => {
    expect(askBatchShape(ask())).toBe("text");
    expect(askBatchShape(ask({ kind: "action", action: ACTION }))).toBe("verdict");
    expect(askBatchShape(ask({ respond: { ack: true } }))).toBe("ack");
    expect(askBatchShape(ask({ kind: "draft", draft: { text: "x", format: "text" } }))).toBeNull();
    expect(askBatchShape(ask({ options: OPTIONS }))?.startsWith("choose:false:1:1:")).toBe(true);
  });

  it("leaves out asks that take more, and says why", () => {
    const plan = planAskBatch([
      item("a"),
      item("b"),
      item("c", { options: OPTIONS, respond: { verdict: {}, choose: {} } }),
      item("d", {}, true),
      item("e", { action: undefined, kind: undefined }),
    ]);
    expect(plan.shape).toBe("verdict");
    expect(plan.included.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(plan.skipped.map((entry) => [entry.item.id, entry.why])).toEqual([
      ["c", "It also asks you to choose."],
      ["d", "The facts changed. It needs a refresh first."],
      ["e", "It takes a different answer from the rest."],
    ]);
  });
});
