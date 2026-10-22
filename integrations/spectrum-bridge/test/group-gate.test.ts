import { expect, test } from "bun:test";
import { appendObserved, classifyGroupMessage, MAX_OBSERVED_LINES } from "../src/group-gate.ts";

const cases: [string, Parameters<typeof classifyGroupMessage>[0], "addressed" | "observe"][] = [
  ["named request", { text: "Robob order moni a challenging puzzle" }, "addressed"],
  ["@ mention", { text: "@robob what time do we land?" }, "addressed"],
  ["hey robob", { text: "hey robob can you find a table for 4 tonight" }, "addressed"],
  ["name at the end", { text: "can you check the gate, Robob?" }, "addressed"],
  ["bare call", { text: "Robob?" }, "addressed"],
  ["swipe reply to Robob", { text: "is that final?", repliesToRobob: true }, "addressed"],
  ["follow-up mid-exchange", { text: "Look for a gem kit too", engaged: true }, "addressed"],
  ["short answer mid-exchange", { text: "yes", engaged: true }, "addressed"],
  ["chit-chat", { text: "Na middle is awful babe" }, "observe"],
  ["you to someone else", { text: "can you pick me up at 7?" }, "observe"],
  ["owner to Moni about Robob's app", { text: "Moni it's processing your registration" }, "observe"],
  ["thanks", { text: "Thanks Robob!" }, "addressed"],
  ["greeting", { text: "hi robob 👋" }, "addressed"],
  ["tapback", { text: "Laughed at \u201cShe's in the group ya numpty\u201d" }, "observe"],
  ["tapback on Robob mid-exchange", { text: "Loved \u201cEK57 tomorrow: gate B30\u201d", engaged: true, repliesToRobob: true }, "observe"],
  ["name inside a word", { text: "the robobot toy arrived" }, "observe"],
  ["vocative at the end", { text: "what time do we land, robob" }, "addressed"],
  ["name plus can you", { text: "moni wants pizza, can you sort it robob" }, "addressed"],
  ["talking about the robob app", { text: "Moni it's processing your registration, once it's done and you install the robob cards app" }, "addressed"],
  ["talking about him", { text: "Or robob" }, "addressed"],
  ["ask robob", { text: "just ask robob later" }, "addressed"],
  ["praise mid-sentence", { text: "Good work, Robob" }, "addressed"],
  ["name in the middle", { text: "lol robob is fast today" }, "addressed"],
  ["told to be quiet", { text: "Robob I am talking to moni not you stop it" }, "addressed"],
];

for (const [name, message, verdict] of cases) {
  test(`group gate: ${name}`, () => expect(classifyGroupMessage(message)).toBe(verdict));
}

test("observed context keeps the newest lines within its caps", () => {
  const lines = Array.from({ length: MAX_OBSERVED_LINES + 5 }, (_, i) => `line ${i}`);
  const kept = appendObserved([], lines);
  expect(kept).toHaveLength(MAX_OBSERVED_LINES);
  expect(kept.at(-1)).toBe(`line ${MAX_OBSERVED_LINES + 4}`);
  expect(appendObserved([], ["x".repeat(10_000)])).toHaveLength(1);
});
