/** What the owner gives back on an ask: response parts, field values, presets and open kinds. */
import {
  KANBAN_ASK_ANSWER_FIELD,
  KanbanCardId,
  KanbanOwnerAsk,
  ThreadId,
  kanbanAskChanges,
  kanbanAskIsNotice,
  kanbanAskKind,
  kanbanAskResponse,
  type KanbanActor,
  type KanbanAskAnswer,
  type KanbanCard,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";

import * as Asks from "./asks.ts";

const owner: KanbanActor = { _tag: "owner" };
const worker: KanbanActor = { _tag: "thread", threadId: ThreadId.make("thread-1") };
const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T11:00:00.000Z";

const fieldsOf = (input: Asks.AskFieldsInput, blocking = false) => {
  const typed = Asks.askFields(input, { blocking });
  if (Asks.isAskProblem(typed)) throw new Error(typed.detail);
  return typed;
};

const ask = (input: Asks.AskFieldsInput = {}, text = "Ship it?"): KanbanOwnerAsk => ({
  id: "q1",
  text,
  blocking: false,
  by: worker,
  at: AT as never,
  seq: 3,
  closedAt: null,
  ...fieldsOf(input),
});

const card = (asks: ReadonlyArray<KanbanOwnerAsk>) =>
  ({
    id: KanbanCardId.make("card-1"),
    number: 12,
    title: "Ship",
    stage: "working",
    asks,
  }) as unknown as KanbanCard;

const problem = (value: unknown) => {
  if (!Asks.isAskProblem(value)) throw new Error("expected a problem");
  return value.detail;
};
const refused = (input: Asks.AskFieldsInput, blocking = false) =>
  problem(Asks.askFields(input, { blocking }));

const answer = (on: KanbanOwnerAsk, input: Asks.AskAnswerInput) => {
  const stored = Asks.answerFor(card([on]), on, input, owner, LATER);
  if (Asks.isAskProblem(stored)) throw new Error(stored.detail);
  return stored;
};
const rejected = (on: KanbanOwnerAsk, input: Asks.AskAnswerInput) =>
  problem(Asks.answerFor(card([on]), on, input, owner, LATER));
const wake = (on: KanbanOwnerAsk, stored: KanbanAskAnswer) =>
  Asks.answerText(card([on]), on, stored, (file) => `/files/${file.name}`);

const decode = Schema.decodeUnknownSync(KanbanOwnerAsk);
const encode = Schema.encodeSync(KanbanOwnerAsk);
const roundTrips = (value: KanbanOwnerAsk) => assert.deepStrictEqual(decode(encode(value)), value);

describe("response parts", () => {
  it("the first five kinds imply their parts and store none", () => {
    const question = ask();
    assert.isUndefined(question.respond);
    assert.deepStrictEqual(kanbanAskResponse(question), {
      verdict: null,
      choose: null,
      fields: [
        { id: KANBAN_ASK_ANSWER_FIELD, label: "Your answer", type: "longtext", required: true },
      ],
      edit: null,
      task: null,
      ack: false,
    });

    const decision = kanbanAskResponse(ask({ options: ["A", "B", "C"], multi: true }));
    assert.deepStrictEqual(
      [decision.verdict, decision.choose?.multi, decision.choose?.min, decision.choose?.max],
      [null, true, 1, 3],
    );
    assert.deepStrictEqual(decision.fields, []);

    const draft = kanbanAskResponse(ask({ draft: { text: "Hello." } }));
    assert.deepStrictEqual(
      [draft.verdict, draft.edit, draft.choose, draft.fields],
      [{ approve: "Approve", reject: "Reject" }, "draft", null, []],
    );
    const action = kanbanAskResponse(ask({ action: { summary: "Deploy" } }));
    assert.deepStrictEqual(
      [action.verdict, action.edit],
      [{ approve: "Approve", reject: "Reject" }, null],
    );
    const change = ask({ change: { label: "Rule", before: "old", after: "new" } });
    assert.isUndefined(change.respond);
    assert.deepStrictEqual(kanbanAskResponse(change).verdict, {
      approve: "Approve",
      reject: "Reject",
    });
  });

  it("the other presets fill respond by name, with no branch beyond that", () => {
    const signoff = ask({ kind: "signoff" });
    assert.deepStrictEqual(signoff.respond, { verdict: { approve: "Passes", reject: "Fails" } });

    const notice = ask({ kind: "notice" });
    assert.deepStrictEqual(notice.respond, { ack: true });
    assert.isTrue(kanbanAskIsNotice(notice));
    assert.deepStrictEqual(Asks.verdictsFor(kanbanAskResponse(notice)), ["acknowledged"]);

    const task = ask({ kind: "task", respond: { task: { steps: ["Open the app", "Tap Pay"] } } });
    assert.deepStrictEqual(task.respond, {
      task: { steps: [{ text: "Open the app" }, { text: "Tap Pay" }] },
    });

    const file = ask({ kind: "file", title: "The signed PDF" });
    assert.deepStrictEqual(file.respond, {
      fields: [{ id: "file", label: "The signed PDF", type: "file", required: true }],
    });

    const rank = ask({ kind: "rank", options: ["Speed", "Cost", "Polish"] });
    assert.isUndefined(rank.options);
    assert.deepStrictEqual(rank.respond?.fields, [
      {
        id: "rank",
        label: "Order",
        type: "rank",
        required: true,
        options: [
          { id: "o1", label: "Speed" },
          { id: "o2", label: "Cost" },
          { id: "o3", label: "Polish" },
        ],
      },
    ]);

    const input = ask({ respond: { fields: [{ label: "Budget", type: "number" }] } });
    assert.strictEqual(kanbanAskKind(input), "input");
    assert.include(refused({ kind: "input" }), "respond: { fields }");
    assert.include(refused({ kind: "rank", options: ["Only"] }), "at least two");
  });

  it("given parts add to the implied ones, and false drops one", () => {
    const combined = ask({
      action: { summary: "Deploy build 42", command: "make deploy" },
      respond: {
        verdict: { approve: "Deploy", reject: "Don't deploy" },
        fields: [{ id: "when", label: "When", type: "select", options: ["Now", "Tonight"] }],
      },
    });
    assert.strictEqual(kanbanAskKind(combined), "action");
    const response = kanbanAskResponse(combined);
    assert.deepStrictEqual(response.verdict, { approve: "Deploy", reject: "Don't deploy" });
    assert.deepStrictEqual(
      response.fields.map((field) => [field.id, field.type]),
      [["when", "select"]],
    );

    // A draft keeps edit + verdict when a field is added; edit: false makes it read-only.
    const draft = ask({
      draft: { text: "Hello." },
      respond: { fields: [{ label: "Post at", type: "datetime" }] },
    });
    assert.deepStrictEqual(draft.respond, {
      verdict: {},
      fields: [{ id: "f1", label: "Post at", type: "datetime" }],
      edit: "draft",
    });
    const fixed = kanbanAskResponse(ask({ draft: { text: "Hello." }, respond: { edit: false } }));
    assert.deepStrictEqual([fixed.edit, fixed.verdict?.approve], [null, "Approve"]);

    const limited = ask({
      options: ["A", "B", "C", "D"],
      respond: { choose: { multi: true, min: 2, max: 3 } },
    });
    assert.strictEqual(limited.multi, true);
    const choose = kanbanAskResponse(limited).choose!;
    assert.deepStrictEqual([choose.multi, choose.min, choose.max], [true, 2, 3]);
  });

  it("keeps an ask one thing: caps, a lone notice, and clear refusals", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ label: `Field ${index}` }));
    assert.include(refused({ respond: { fields: many } }), "at most 8 fields");
    assert.include(
      refused({ respond: { task: { steps: Array.from({ length: 9 }, () => "Do") } } }),
      "at most 8 steps",
    );
    assert.include(
      refused({ respond: { ack: true, fields: [{ label: "Why" }] } }),
      "a notice takes nothing back",
    );
    assert.include(refused({ kind: "notice" }, true), "a notice can't block");
    assert.include(refused({ respond: { choose: true } }), "choose needs options");
    assert.include(refused({ respond: { edit: true } }), "edit needs a draft");
    assert.include(
      refused({ options: ["A", "B"], respond: { choose: { max: 2 } } }),
      "max above 1 needs multi",
    );
    assert.include(
      refused({ respond: { fields: [{ label: "X", type: "colour" }] } }),
      'type "colour" is not one of text, longtext',
    );
    assert.include(
      refused({
        respond: {
          fields: [
            { id: "a", label: "X" },
            { id: "a", label: "Y" },
          ],
        },
      }),
      'field id "a" is used twice',
    );
    assert.include(
      refused({ respond: { fields: [{ label: "Pick", type: "select", options: ["One"] }] } }),
      "at least two options",
    );
    assert.include(
      refused({ respond: { fields: [{ label: "N", type: "number", min: 5, max: 1 }] } }),
      "min is above max",
    );
    assert.include(
      refused({ respond: { fields: [{ label: "N", type: "number", default: "seven" }] } }),
      "default: is not a number",
    );
    assert.include(
      refused({ respond: { task: { steps: ["Do"], proof: "shot" } } }),
      'task proof "shot" is not one of the ask\'s fields',
    );
    assert.include(refused({ to: "moni" }), 'goes to "owner" (the default) or "evaluator"');
    assert.include(refused({ kind: "x".repeat(41) }), "kind is a short label");
    assert.include(
      refused({
        changes: Array.from({ length: 9 }, (_, index) => ({
          label: `f${index}`,
          before: "a",
          after: "b",
        })),
      }),
      "at most 8 changes",
    );
  });

  it("a secret field is refused with where to ask instead", () => {
    const detail = refused({ respond: { fields: [{ label: "API key", type: "secret" }] } });
    assert.include(detail, "request_secret");
    assert.include(refused({ kind: "secret", title: "Stripe key" }), "request_secret");
  });

  it("options carry a consequence and the block that shows them; several changes are one ask", () => {
    const picture = ask({
      options: [
        { label: "Dark", consequence: "Ships tonight", block: 0 },
        { label: "Light", detail: "The current look", block: 1 },
      ],
      blocks: [
        { _tag: "image", url: "https://example.com/dark.png", alt: "Dark" },
        { _tag: "html", html: "<p>light</p>", title: "Light", height: 200 },
      ],
    });
    assert.deepStrictEqual(picture.options, [
      { id: "o1", label: "Dark", consequence: "Ships tonight", block: 0 },
      { id: "o2", label: "Light", detail: "The current look", block: 1 },
    ]);
    assert.include(Asks.askDetail(picture), "- **Dark** Then: Ships tonight");
    assert.include(
      refused({ options: [{ label: "A", block: 2 }, "B"], blocks: [{ _tag: "md", text: "x" }] }),
      "block 2 is not in blocks",
    );
    roundTrips(picture);

    const multi = ask({
      changes: [
        { label: "a.ts", before: "1", after: "2" },
        { label: "b.ts", before: "x", after: "y", format: "text" },
      ],
    });
    assert.strictEqual(kanbanAskKind(multi), "change");
    assert.isUndefined(multi.change);
    assert.deepStrictEqual(
      kanbanAskChanges(multi).map((change) => [change.label, change.format]),
      [
        ["a.ts", "markdown"],
        ["b.ts", "text"],
      ],
    );
    assert.include(Asks.askDetail(multi), "**Change: b.ts**");
    // The single change stored before `changes` existed still reads.
    const single = decode({
      ...encode(ask()),
      kind: "change",
      change: { label: "Rule", before: "old", after: "new", format: "markdown" },
    });
    assert.deepStrictEqual(
      kanbanAskChanges(single).map((change) => change.label),
      ["Rule"],
    );
    assert.deepStrictEqual(kanbanAskResponse(single).verdict, {
      approve: "Approve",
      reject: "Reject",
    });
  });
});

describe("field values", () => {
  const form = ask({
    kind: "input",
    title: "Launch settings",
    respond: {
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "why", label: "Why", type: "longtext" },
        { id: "budget", label: "Budget", type: "number", unit: "AED", min: 10, max: 500 },
        { id: "day", label: "Day", type: "date" },
        { id: "at", label: "At", type: "datetime" },
        { id: "beta", label: "Beta", type: "toggle" },
        { id: "tier", label: "Tier", type: "select", options: ["Free", "Pro"] },
        {
          id: "tags",
          label: "Tags",
          type: "select",
          multi: true,
          options: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
          ],
        },
      ],
    },
  });

  it("every type validates, normalizes, round-trips and reads back as label: value", () => {
    const stored = answer(form, {
      verdict: "answered",
      note: "Go.",
      values: {
        name: "Orion",
        why: "Because.",
        budget: 250,
        day: "2026-11-12",
        at: "2026-11-12T09:00:00+04:00",
        beta: false,
        tier: "o2",
        tags: ["b", "a", "b"],
      },
    });
    assert.deepStrictEqual(stored.values, {
      name: "Orion",
      why: "Because.",
      budget: 250,
      day: "2026-11-12",
      at: "2026-11-12T05:00:00.000Z",
      beta: false,
      tier: "o2",
      tags: ["b", "a"],
    });
    roundTrips({ ...form, closedAt: LATER as never, answer: stored });
    assert.strictEqual(
      wake(form, stored),
      [
        'The owner ANSWERED q1 on card #12: "Launch settings".',
        "Owner's note, read this before you act:\nGo.",
        [
          "Name: Orion",
          "Why: Because.",
          "Budget: 250 AED",
          "Day: 2026-11-12",
          "At: 2026-11-12T05:00:00.000Z",
          "Beta: no",
          "Tier: Pro",
          "Tags: Beta; Alpha",
        ].join("\n"),
      ].join("\n\n"),
    );
    roundTrips(form);
  });

  it("refuses a missing required field, a wrong type, a number out of range and an unknown option", () => {
    const base = { name: "Orion" };
    assert.include(
      rejected(form, { verdict: "answered", values: { budget: 20 } }),
      'field "name" (Name) is required',
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, budget: 501 } }),
      'field "budget" (Budget) is above 500 AED',
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, budget: 9 } }),
      "is below 10 AED",
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, budget: "250" } }),
      "is not a number",
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, day: "12 Nov" } }),
      "is not a date (YYYY-MM-DD)",
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, at: "soon" } }),
      "is not a time",
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, beta: "yes" } }),
      "is not true or false",
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, tier: "o9" } }),
      'field "tier" (Tier) takes one of o1, o2',
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, tier: ["o1", "o2"] } }),
      "takes one option",
    );
    assert.include(
      rejected(form, { verdict: "answered", values: { ...base, nope: 1 } }),
      'has no field "nope"',
    );
    assert.include(rejected(form, { verdict: "approved" }), 'takes answered (got "approved")');
  });

  it("rank takes every item once, in order", () => {
    const rank = ask({ kind: "rank", options: ["Speed", "Cost", "Polish"] });
    const stored = answer(rank, { verdict: "answered", values: { rank: ["o3", "o1", "o2"] } });
    assert.include(wake(rank, stored), "Order: 1. Polish, 2. Speed, 3. Cost");
    assert.include(
      rejected(rank, { verdict: "answered", values: { rank: ["o3", "o1"] } }),
      "takes every one of o1, o2, o3 once, in order",
    );
    assert.include(
      rejected(rank, { verdict: "answered", values: { rank: ["o3", "o1", "o1"] } }),
      "once, in order",
    );
  });

  it("a file field takes uploads it accepts, up to its count", () => {
    const upload = ask({
      respond: {
        fields: [
          {
            id: "scan",
            label: "Scan",
            type: "file",
            required: true,
            accepts: ["application/pdf", "image/*", ".csv"],
            maxFiles: 2,
          },
        ],
      },
    });
    const pdf = {
      type: "file",
      id: "pending-1.pdf",
      name: "scan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    };
    const stored = answer(upload, { verdict: "answered", values: { scan: pdf } });
    assert.deepStrictEqual(stored.values, { scan: [pdf] });
    assert.deepStrictEqual(Asks.answerFiles(upload, stored), [
      { fieldId: "scan", files: [pdf as never] },
    ]);
    assert.include(wake(upload, stored), "Scan: scan.pdf (/files/scan.pdf)");
    const zip = { ...pdf, name: "a.zip", mimeType: "application/zip" };
    assert.include(
      rejected(upload, { verdict: "answered", values: { scan: [zip] } }),
      "takes application/pdf, image/*, .csv (got application/zip)",
    );
    assert.include(
      rejected(upload, { verdict: "answered", values: { scan: [pdf, pdf, pdf] } }),
      "takes at most 2 files",
    );
    assert.include(
      rejected(upload, { verdict: "answered", values: { scan: "scan.pdf" } }),
      "takes the uploaded files",
    );
  });

  it("a custom field holds the JSON its html block produced, under a size cap", () => {
    const blocks = [{ _tag: "html" as const, html: "<p>picker</p>", title: "Pick", height: 200 }];
    const custom = ask({
      blocks,
      respond: { fields: [{ id: "area", label: "Area", type: "custom", block: 0 }] },
    });
    assert.deepStrictEqual(custom.respond?.fields, [
      { id: "area", label: "Area", type: "custom", block: 0 },
    ]);
    const stored = answer(custom, {
      verdict: "answered",
      values: { area: { x: 1, y: [2, 3] } },
    });
    assert.deepStrictEqual(stored.values, { area: { x: 1, y: [2, 3] } });
    assert.include(wake(custom, stored), 'Area: {"x":1,"y":[2,3]}');
    roundTrips({ ...custom, closedAt: LATER as never, answer: stored });
    assert.include(
      rejected(custom, { verdict: "answered", values: { area: "x".repeat(9_000) } }),
      "is at most 8 KB of JSON",
    );
    assert.include(
      refused({ respond: { fields: [{ label: "Area", type: "custom", block: 0 }] } }),
      "a custom field needs block",
    );
    assert.include(
      refused({
        blocks: [{ _tag: "md", text: "x" }],
        respond: { fields: [{ label: "Area", type: "custom", block: 0 }] },
      }),
      "the html page that produces its value",
    );
  });
});

describe("answers by part", () => {
  it("a pick is held to min and max", () => {
    const limited = ask({
      options: ["A", "B", "C", "D"],
      respond: { choose: { multi: true, min: 2, max: 3 } },
    });
    assert.include(
      rejected(limited, { verdict: "picked", optionIds: ["o1"] }),
      "takes at least 2 options",
    );
    assert.include(
      rejected(limited, { verdict: "picked", optionIds: ["o1", "o2", "o3", "o4"] }),
      "takes at most 3 options",
    );
    assert.include(
      rejected(limited, { verdict: "picked", optionIds: ["o1", "zz"] }),
      'no option "zz"',
    );
    const stored = answer(limited, { verdict: "picked", optionIds: ["o2", "o4"] });
    assert.include(wake(limited, stored), "Picked: B; D");
  });

  it("a task is done or couldn't, with its proof when done", () => {
    const task = ask(
      {
        kind: "task",
        title: "Authorize Stripe",
        respond: {
          task: {
            steps: [{ text: "Open the link", link: "https://example.com/oauth" }, "Press Allow"],
            proof: "shot",
          },
          fields: [{ id: "shot", label: "Screenshot", type: "file" }],
        },
      },
      "Can you authorize Stripe?",
    );
    assert.include(
      Asks.askDetail(task),
      "1. Open the link (https://example.com/oauth)\n2. Press Allow",
    );
    assert.deepStrictEqual(Asks.verdictsFor(kanbanAskResponse(task)), ["done", "cant", "answered"]);
    assert.include(rejected(task, { verdict: "done" }), 'field "shot" (Screenshot) is required');
    const shot = {
      type: "image",
      id: "pending-2.png",
      name: "ok.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const done = answer(task, { verdict: "done", values: { shot: [shot] } });
    assert.strictEqual(
      wake(task, done),
      'The owner has DONE q1 on card #12: "Authorize Stripe".\n\nScreenshot: ok.png (/files/ok.png)',
    );
    const cant = answer(task, { verdict: "cant", note: "No admin rights on that account." });
    assert.strictEqual(
      wake(task, cant),
      [
        'The owner COULD NOT DO q1 on card #12: "Authorize Stripe".',
        "Don't count on it being done.",
        "Owner's note, read this before you act:\nNo admin rights on that account.",
      ].join("\n\n"),
    );
  });

  it("a notice is acknowledged and takes nothing else", () => {
    const notice = ask({ kind: "notice", title: "Deploy finished" }, "Build 42 is live.");
    const seen = answer(notice, { verdict: "acknowledged" });
    assert.strictEqual(seen.verdict, "acknowledged");
    assert.strictEqual(wake(notice, seen), 'The owner has SEEN q1 on card #12: "Deploy finished".');
    assert.include(
      rejected(notice, { verdict: "approved" }),
      'takes acknowledged (got "approved")',
    );
  });

  it("an action with a field: the verdict under its label, his note, then the value", () => {
    const deploy = ask({
      title: "Deploy build 42",
      action: { summary: "Deploy build 42", command: "make deploy" },
      respond: {
        verdict: { approve: "Deploy", reject: "Don't deploy" },
        fields: [
          {
            id: "when",
            label: "When",
            type: "select",
            required: true,
            options: ["Now", "Tonight"],
          },
        ],
      },
    });
    assert.include(rejected(deploy, { verdict: "approved" }), 'field "when" (When) is required');
    const stored = answer(deploy, {
      verdict: "approved",
      note: "Watch the error rate.",
      values: { when: "o2" },
    });
    assert.strictEqual(
      wake(deploy, stored),
      [
        'The owner APPROVED q1 on card #12: "Deploy build 42". He chose "Deploy".',
        "Owner's note, read this before you act:\nWatch the error rate.",
        "When: Tonight",
      ].join("\n\n"),
    );
    // A rejection needs no values.
    const no = answer(deploy, { verdict: "rejected" });
    assert.include(
      wake(deploy, no),
      'REJECTED q1 on card #12: "Deploy build 42". He chose "Don\'t deploy".',
    );
    // The pick block an old client shows carries the same labels, and its ids answer it.
    assert.deepStrictEqual(
      Asks.pickOptions(deploy).map((option) => [option.id, option.label]),
      [
        ["approve", "Deploy"],
        ["reject", "Don't deploy"],
      ],
    );
    assert.strictEqual(
      answer(ask({ action: { summary: "Deploy" } }), { verdict: "picked", optionIds: ["approve"] })
        .verdict,
      "approved",
    );
  });

  it("an edited draft comes last in the wake text, after the values", () => {
    const draft = ask({
      title: "PR comment",
      draft: { text: "Hello." },
      respond: { fields: [{ id: "where", label: "Where", type: "text" }] },
    });
    const stored = answer(draft, {
      verdict: "approved",
      finalDraft: "Hello, and thanks.",
      values: { where: "PR #9" },
    });
    assert.strictEqual(
      wake(draft, stored),
      [
        'The owner APPROVED q1 on card #12: "PR comment".',
        "Where: PR #9",
        "Post exactly this text (the owner edited your draft):\nHello, and thanks.",
      ].join("\n\n"),
    );
    const fixed = ask({ draft: { text: "Hello." }, respond: { edit: false } });
    assert.include(
      rejected(fixed, { verdict: "approved", finalDraft: "Changed." }),
      "is not his to edit",
    );
  });
});

describe("open kinds", () => {
  it("any kind decodes, renders from its parts and answers", () => {
    const custom = ask({ kind: "legal-review", title: "Terms v3" }, "Anything missing?");
    assert.strictEqual(kanbanAskKind(custom), "legal-review");
    assert.isUndefined(custom.respond);
    assert.strictEqual(kanbanAskResponse(custom).fields[0]?.id, KANBAN_ASK_ANSWER_FIELD);
    const stored = answer(custom, { verdict: "answered", text: "Add the refund clause." });
    assert.include(wake(custom, stored), "His answer:\nAdd the refund clause.");

    // What a newer build might write: a kind, a verdict, a field type and a part this one doesn't know.
    const future = decode({
      id: "q9",
      text: "Sign?",
      blocking: false,
      by: { _tag: "owner" },
      at: AT,
      seq: null,
      closedAt: LATER,
      kind: "notarize",
      respond: { fields: [{ id: "sig", label: "Signature", type: "signature" }] },
      answer: { verdict: "notarized", by: { _tag: "owner" }, at: LATER },
    });
    assert.strictEqual(kanbanAskKind(future), "notarize");
    assert.strictEqual(future.answer?.verdict, "notarized");
    assert.strictEqual(kanbanAskResponse(future).fields[0]?.type, "signature");
    // An unknown field type takes text.
    const open = { ...future, closedAt: null, answer: undefined } as KanbanOwnerAsk;
    assert.deepStrictEqual(
      answer(open, { verdict: "answered", values: { sig: "A. Rangoonwala" } }).values,
      { sig: "A. Rangoonwala" },
    );
  });

  it("a plain question's one field is the answer text, whichever way it is sent", () => {
    const plain = ask();
    const byText = answer(plain, { verdict: "answered", text: "Yes." });
    const byValue = answer(plain, {
      verdict: "answered",
      values: { [KANBAN_ASK_ANSWER_FIELD]: "Yes." },
    });
    assert.deepStrictEqual(byValue, byText);
    assert.isUndefined(byText.values);
    assert.include(rejected(plain, { verdict: "answered" }), "needs text");
  });

  it("one answer fits several asks only when they take the same thing back", () => {
    assert.strictEqual(Asks.batchShape(ask()), "text");
    assert.strictEqual(Asks.batchShape(ask({ action: { summary: "Deploy" } })), "verdict");
    assert.strictEqual(Asks.batchShape(ask({ kind: "signoff" })), "verdict");
    assert.strictEqual(Asks.batchShape(ask({ kind: "notice" })), "ack");
    assert.strictEqual(
      Asks.batchShape(ask({ options: ["A", "B"] })),
      Asks.batchShape(ask({ options: ["A", "B"], title: "Other" })),
    );
    assert.notStrictEqual(
      Asks.batchShape(ask({ options: ["A", "B"] })),
      Asks.batchShape(ask({ options: ["A", "C"] })),
    );
    assert.isNull(Asks.batchShape(ask({ draft: { text: "Hi" } })));
    assert.isNull(Asks.batchShape(ask({ respond: { fields: [{ label: "Budget" }] } })));
    assert.isNull(Asks.batchShape(ask({ kind: "task" })));
  });

  it("an edit to a new kind or body drops the old response parts unless it gives new ones", () => {
    const signoff = ask({ kind: "signoff" });
    const asAction = Asks.reviseAsk(signoff, { action: { summary: "Deploy" } }, LATER);
    if (Asks.isAskProblem(asAction)) throw new Error(asAction.detail);
    assert.strictEqual(asAction.kind, "action");
    assert.isUndefined(asAction.respond);
    // A plain edit keeps them.
    const retitled = Asks.reviseAsk(signoff, { title: "Check the build" }, LATER);
    if (Asks.isAskProblem(retitled)) throw new Error(retitled.detail);
    assert.deepStrictEqual(retitled.respond, signoff.respond);
    // A blocking ask can't be edited into a notice.
    assert.include(
      problem(Asks.reviseAsk({ ...ask(), blocking: true }, { kind: "notice" }, LATER)),
      "a notice can't block",
    );
  });
});
