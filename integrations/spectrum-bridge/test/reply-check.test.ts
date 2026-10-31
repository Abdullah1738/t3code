import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalCommand, parseLocalCommand } from "../src/cli.ts";
import { checkReply, editBans, mayBounce, noteBounce, noteSent, readReplyRules } from "../src/replyCheck.ts";
import { Store } from "../src/store.ts";

const owner = { slug: "owner", kind: "owner" };
const moni = { slug: "moni", kind: "dm" };
const rules = { moni: { banned: ["giardia", "noble vet"] } };
const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "reply-check-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("card-limit", () => {
  const limitText = "Your Marriott card's available limit is only AED 4,085, pay part of the 5542 balance first";

  test("blocks the limit excuse for the owner chat", () => {
    expect(checkReply(owner, limitText, {})?.rule).toBe("card-limit");
  });

  test("allows it when a real decline SMS is quoted", () => {
    expect(checkReply(owner, `${limitText}. The bank declined it, the SMS says so`, {})).toBeUndefined();
  });

  test("does not apply to other chats", () => {
    expect(checkReply(moni, limitText, {})).toBeUndefined();
  });

  test("blocks the limit excuse for card 2342", () => {
    const hit = checkReply(owner, "Card 2342's available limit is only AED 4,085, pay part of the balance first", {});
    expect(hit?.rule).toBe("card-limit");
    expect(hit?.reason).toContain("2342");
    expect(hit?.reason).not.toContain("5542");
  });

  test("ignores 2342 inside a longer number", () => {
    expect(checkReply(owner, "Your limit on the AED 12342 plan is fine", {})).toBeUndefined();
  });
});

describe("banned words", () => {
  test("match whole words in the moni chat, case and punctuation-insensitive", () => {
    expect(checkReply(moni, "Giardia again?", rules)?.rule).toBe("banned");
    expect(checkReply(moni, "Noble Vet's results", rules)?.rule).toBe("banned");
  });

  test("do not apply to the owner chat", () => {
    expect(checkReply(owner, "Giardia again?", rules)).toBeUndefined();
  });

  test("a missing rules file blocks nothing", async () => {
    const dir = await tempDir();
    expect(readReplyRules(join(dir, "missing.json"))).toEqual({});
    expect(checkReply(moni, "Giardia again?", readReplyRules(join(dir, "missing.json")))).toBeUndefined();
  });
});

describe("length rule", () => {
  test("moni: over 600 characters is held, 600 is fine, a lone URL is fine", () => {
    const words = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n).trimEnd();
    expect(words(601).length).toBe(601);
    expect(checkReply(moni, words(601), {})?.rule).toBe("length");
    expect(checkReply(moni, words(600), {})).toBeUndefined();
    expect(checkReply(moni, `https://example.com/${"x".repeat(700)}`, {})).toBeUndefined();
  });
});

describe("bounce loop guard", () => {
  test("mayBounce is false for the same turn right after a bounce, true for a new turn", () => {
    const store = new Store(":memory:");
    try {
      expect(mayBounce(store, "turn-a")).toBe(true);
      noteBounce(store, "turn-a");
      expect(mayBounce(store, "turn-a")).toBe(false);
      expect(mayBounce(store, "turn-b")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("noteSent records the texts of the current turn", () => {
    const store = new Store(":memory:");
    try {
      noteSent(store, "turn-a", "Hello there!");
      noteSent(store, "turn-a", "Second");
      expect(store.get<{ texts: string[] }>("turn-sends")?.texts).toEqual(["hellothere", "second"]);
      noteSent(store, "turn-b", "Fresh");
      expect(store.get<{ texts: string[] }>("turn-sends")?.texts).toEqual(["fresh"]);
    } finally {
      store.close();
    }
  });
});

describe("malformed rules files", () => {
  test("a string instead of an array is no rules, not one ban per letter", async () => {
    const dir = await tempDir();
    const path = join(dir, "r.json");
    await writeFile(path, JSON.stringify({ moni: { banned: "giardia" } }));
    expect(readReplyRules(path)).toEqual({});
    expect(checkReply(moni, "I can do that.", readReplyRules(path))).toBeUndefined();
  });

  test("null entries and other non-object shapes fall back to {} without throwing", async () => {
    const dir = await tempDir();
    for (const body of [{ moni: { banned: [null] } }, { moni: { banned: [""] } }, ["x"], "str", { moni: null }]) {
      const path = join(dir, `r-${JSON.stringify(body).length}.json`);
      await writeFile(path, JSON.stringify(body));
      expect(readReplyRules(path)).toEqual({});
    }
    await writeFile(join(dir, "bad.json"), "{not json");
    expect(readReplyRules(join(dir, "bad.json"))).toEqual({});
  });

  test("ban refuses to rewrite a malformed file, so other chats' bans are not wiped", async () => {
    const dir = await tempDir();
    const path = join(dir, "r.json");
    await writeFile(path, JSON.stringify({ moni: { banned: "giardia" }, owner: { banned: ["x"] } }));
    await expect(editBans(path, "owner", "ban", "y")).rejects.toThrow("malformed");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ moni: { banned: "giardia" }, owner: { banned: ["x"] } });
  });
});

describe("ban, unban and bans", () => {
  test("seeded mixed-case and punctuated entries are normalized, so unban clears them and ban does not duplicate them", async () => {
    const dir = await tempDir();
    const path = join(dir, "reply-rules.json");
    await writeFile(path, JSON.stringify({ moni: { banned: ["Noble Vet", "noble-vet", "Giardia"] } }));
    expect(readReplyRules(path)).toEqual({ moni: { banned: ["noble vet", "giardia"] } });
    await editBans(path, "moni", "ban", "GIARDIA!");
    expect(readReplyRules(path)).toEqual({ moni: { banned: ["noble vet", "giardia"] } });
    await editBans(path, "moni", "unban", "noble vet");
    expect(readReplyRules(path)).toEqual({ moni: { banned: ["giardia"] } });
    expect(checkReply(moni, "Noble-Vet results", readReplyRules(path))).toBeUndefined();
  });

  test("ban and unban work on a seeded file via the CLI runner", async () => {
    const dir = await tempDir();
    const rulesPath = join(dir, "reply-rules.json");
    await writeFile(rulesPath, JSON.stringify({ moni: { banned: ["Noble Vet", "noble-vet"] } }));
    const run = (args: string[]) => runLocalCommand(parseLocalCommand(args), { rulesPath });
    await run(["unban", "--chat", "moni", "--word", "noble vet"]);
    expect(await run(["bans", "--chat", "moni"])).toEqual({ moni: { banned: [] } });
  });
});

describe("ban, unban and bans (original)", () => {
  test("ban dedupes, unban removes, bans lists, and the file is mode 0600", async () => {
    const dir = await tempDir();
    const rulesPath = join(dir, "reply-rules.json");
    const run = (args: string[]) => runLocalCommand(parseLocalCommand(args), { rulesPath });
    await run(["ban", "--chat", "moni", "--word", "Giardia"]);
    await run(["ban", "--chat", "moni", "--word", "giardia"]);
    await run(["ban", "--chat", "moni", "--word", "Noble Vet"]);
    expect(await run(["bans", "--chat", "moni"])).toEqual({ moni: { banned: ["giardia", "noble vet"] } });
    expect((await stat(rulesPath)).mode & 0o777).toBe(0o600);
    await run(["unban", "--chat", "moni", "--word", "giardia"]);
    expect(await run(["bans"])).toEqual({ moni: { banned: ["noble vet"] } });
    expect(JSON.parse(await readFile(rulesPath, "utf8"))).toEqual({ moni: { banned: ["noble vet"] } });
  });

  test("editBans writes no temp file left behind", async () => {
    const dir = await tempDir();
    const rulesPath = join(dir, "reply-rules.json");
    await writeFile(rulesPath, "{}");
    await editBans(rulesPath, "moni", "ban", "Giardia");
    expect(readReplyRules(rulesPath)).toEqual({ moni: { banned: ["giardia"] } });
  });
});
