import { assert, it } from "@effect/vitest";
import type { KanbanMessage } from "@t3tools/contracts";

import { fitNewest, listPage, pageLimit, stubBlock } from "./messagePages.ts";

const message = (seq: number, text: string): KanbanMessage =>
  ({
    discussionId: "d",
    seq,
    author: { _tag: "owner" },
    authorName: "You",
    blocks: [{ _tag: "md", text }],
    answers: [],
    createdAt: "2026-11-04T00:00:00.000Z",
  }) as never;

it("keeps the newest message even when it alone is past the budget", () => {
  const page = fitNewest([message(1, "a"), message(2, "b".repeat(2_000))], 100);
  assert.deepStrictEqual(
    page.map((entry) => entry.seq),
    [2],
  );
});

it("takes the newest run that fits, oldest first", () => {
  const all = Array.from({ length: 10 }, (_, index) => message(index + 1, "x".repeat(100)));
  const size = JSON.stringify(all[0]).length;
  const page = fitNewest(all, size * 3 + 1);
  assert.deepStrictEqual(
    page.map((entry) => entry.seq),
    [8, 9, 10],
  );
});

it("stubs only big md and html, keeping the tag", () => {
  assert.deepStrictEqual(stubBlock({ _tag: "md", text: "small" }), { _tag: "md", text: "small" });
  const md = stubBlock({ _tag: "md", text: "é".repeat(40_000) });
  assert.isTrue(md._tag === "md" && md.truncated === true && md.fullBytes === 80_000);
  const html = stubBlock({
    _tag: "html",
    html: "<p>".repeat(30_000),
    title: "<b>Deck</b>",
    height: 400,
  });
  assert.isTrue(html._tag === "html" && html.truncated === true && html.height === 400);
  assert.include(html._tag === "html" ? html.html : "", "&#60;b&#62;Deck");
  // A list page never holds a block past the stub size.
  const page = listPage([message(1, "y".repeat(500_000))]);
  assert.isBelow(JSON.stringify(page).length, 3_000);
});

it("holds the count to 200 and defaults to 50", () => {
  assert.strictEqual(pageLimit(undefined), 50);
  assert.strictEqual(pageLimit(0), 50);
  assert.strictEqual(pageLimit(500), 200);
  assert.strictEqual(pageLimit(undefined, 200), 200);
});
