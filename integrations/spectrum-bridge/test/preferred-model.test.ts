import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlModelFields, imessagePreferences, preferredModel, stripJsonc } from "../src/preferred-model.ts";

let directory: string;
const directories: string[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "preferred-model-"));
  directories.push(directory);
});

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("stripJsonc", () => {
  test("strips line and block comments and trailing commas outside strings", () => {
    const text = `{
  // provider default
  "model": "a/b", /* block
  comment */ "imessage": {
    "model": "surplus/glm-5.3",
    "variant": "max", // trailing comment
  },
}`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ model: "a/b", imessage: { model: "surplus/glm-5.3", variant: "max" } });
  });

  test("leaves comment-like and comma-like sequences inside strings untouched", () => {
    const text = `{
  "url": "https://example.com/#x", // real comment
  "text": "keep , } and /* this */ and // that",
  "escaped": "quote \\" then // still string",
}`;
    expect(JSON.parse(stripJsonc(text)).url).toBe("https://example.com/#x");
    expect(JSON.parse(stripJsonc(text)).text).toBe("keep , } and /* this */ and // that");
    expect(JSON.parse(stripJsonc(text)).escaped).toBe('quote " then // still string');
  });

  test("survives unterminated comments and strings without throwing", () => {
    expect(typeof stripJsonc("{\"a\": 1, /* never closed")).toBe("string");
    expect(typeof stripJsonc("{ \"a\": \"unterminated")).toBe("string");
  });
});

describe("preferredModel", () => {
  test("reads the imessage preference from opencode.jsonc", async () => {
    await writeFile(join(directory, "opencode.jsonc"), `{
  "model": "inferhub/gpt-5.6-sol",
  // comments are fine
  "imessage": { "model": "surplus/glm-5.3", "variant": "max" },
}`);
    expect(await preferredModel(directory)).toEqual({ providerID: "surplus", modelID: "glm-5.3", variant: "max", instanceId: "opencode" });
  });

  test("falls back to opencode.json and requires no variant", async () => {
    await writeFile(join(directory, "opencode.json"), JSON.stringify({
      model: "inferhub/gpt-5.6-sol",
      imessage: { model: "surplus/glm-5.3" },
    }));
    expect(await preferredModel(directory)).toEqual({ providerID: "surplus", modelID: "glm-5.3", instanceId: "opencode" });
  });

  test("prefers opencode.jsonc over opencode.json", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: { model: "first/one" } }));
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ imessage: { model: "second/two" } }));
    expect(await preferredModel(directory)).toEqual({ providerID: "first", modelID: "one", instanceId: "opencode" });
  });

  test("missing files, missing key, or no preference resolves to undefined", async () => {
    expect(await preferredModel(directory)).toBeUndefined();
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ model: "inferhub/gpt-5.6-sol" }));
    expect(await preferredModel(directory)).toBeUndefined();
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: { variant: "max" } }));
    expect(await preferredModel(directory)).toBeUndefined();
  });

  test.each([
    { imessage: { model: "noslash" } },
    { imessage: { model: "/leading" } },
    { imessage: { model: "trailing/" } },
    { imessage: { model: "two/slashes/here" } },
    { imessage: { model: "" } },
    { imessage: { model: "p/m\x00" } },
    { imessage: { model: "p/" + "m".repeat(129) } },
    { imessage: { model: "p".repeat(65) + "/m" } },
    { imessage: { model: 42 } },
    { imessage: [] },
    { imessage: "surplus/glm-5.3" },
    { imessage: { model: "surplus/glm-5.3", variant: "" } },
    { imessage: { model: "surplus/glm-5.3", variant: 7 } },
    { imessage: { model: "surplus/glm-5.3", variant: "x".repeat(65) } },
    { imessage: { model: "surplus/glm-5.3", variant: "bad\nvariant" } },
    { imessage: { model: "noslash", instanceId: "opencode" } },
    { imessage: { model: "claude-opus-5-5", instanceId: 7 } },
    { imessage: { model: "claude-opus-5-5", instanceId: "" } },
    { imessage: { model: "claude-opus-5-5", instanceId: "bad id" } },
    { imessage: { model: "claude opus", instanceId: "claudeAgent" } },
    { imessage: { model: "a/b/c", instanceId: "claudeAgent" } },
  ])("rejects malformed imessage shape %j", async value => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: value.imessage }));
    expect(await preferredModel(directory)).toBeUndefined();
  });

  test("an explicit non-OpenCode instance takes its own slashless model id verbatim", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
      imessage: { instanceId: "claudeAgent", model: "claude-opus-5-5", variant: "high" },
    }));
    const model = await preferredModel(directory);
    expect(model).toEqual({ providerID: "", modelID: "claude-opus-5-5", variant: "high", instanceId: "claudeAgent" });
    expect(controlModelFields(model!)).toEqual({ model: "claude-opus-5-5", variant: "high", providerInstanceId: "claudeAgent" });
  });

  test("an explicit opencode instance keeps provider/model, and the fields carry it", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
      imessage: { instanceId: "opencode", model: "opus/claude-opus-5-5", variant: "high" },
    }));
    const model = await preferredModel(directory);
    expect(model).toEqual({ providerID: "opus", modelID: "claude-opus-5-5", variant: "high", instanceId: "opencode" });
    expect(controlModelFields(model!)).toEqual({ model: "opus/claude-opus-5-5", variant: "high", providerInstanceId: "opencode" });
    // A ref from before instanceId existed still goes to OpenCode.
    expect(controlModelFields({ providerID: "surplus", modelID: "glm-5.3" })).toEqual({ model: "surplus/glm-5.3", providerInstanceId: "opencode" });
  });

  test("accepts provider and model ids at the length boundary", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
      imessage: { model: "p".repeat(64) + "/" + "m".repeat(127), variant: "v".repeat(64) },
    }));
    expect(await preferredModel(directory)).toEqual({
      providerID: "p".repeat(64), modelID: "m".repeat(127), variant: "v".repeat(64), instanceId: "opencode",
    });
  });

  test("refuses symlinks, directories, oversized files, and unreadable JSONC", async () => {
    const real = join(directory, "opencode.jsonc");
    await mkdir(join(directory, "subdir-config"));
    // Symlinked config is refused like every other config the bridge reads.
    await symlink(join(directory, "subdir-config"), join(directory, "linkdir"));
    await writeFile(real, JSON.stringify({ imessage: { model: "surplus/glm-5.3" } }));
    const linked = mkdtempSync(join(tmpdir(), "preferred-model-link-"));
    directories.push(linked);
    await symlink(real, join(linked, "opencode.jsonc"));
    expect(await preferredModel(linked)).toBeUndefined();
    await rm(real);
    // Directory instead of file, then garbage, then oversize.
    await mkdir(real);
    expect(await preferredModel(directory)).toBeUndefined();
    await rm(real, { recursive: true });
    await writeFile(real, "{not json}");
    expect(await preferredModel(directory)).toBeUndefined();
    await writeFile(real, JSON.stringify({ imessage: { model: "surplus/glm-5.3" } }) + " ".repeat(0));
    // Oversized: pad past the 1 MiB cap with valid JSONC content plus comments.
    await writeFile(real, `/*${"x".repeat(1_000_000)}*/{"imessage":{"model":"surplus/glm-5.3"}}`);
    expect(await preferredModel(directory)).toBeUndefined();
  });

  test("rejects a non-absolute or control-character config root", async () => {
    expect(await preferredModel("relative/path")).toBeUndefined();
    expect(await preferredModel("/bad\nroot")).toBeUndefined();
  });
});

describe("imessagePreferences", () => {
  test("reads the replacement guidance prompt alongside the model, trimmed", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
      imessage: { model: "surplus/kimi-k3", variant: "max", prompt: "  Text like a human assistant. No Markdown.  " },
    }));
    expect(await imessagePreferences(directory)).toEqual({
      model: { providerID: "surplus", modelID: "kimi-k3", variant: "max", instanceId: "opencode" },
      prompt: "Text like a human assistant. No Markdown.",
    });
  });

  test("resolves to empty preferences with no config, key, or fields", async () => {
    expect(await imessagePreferences(directory)).toEqual({});
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ model: "inferhub/gpt-5.6-sol" }));
    expect(await imessagePreferences(directory)).toEqual({});
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: { prompt: "Only guidance." } }));
    expect(await imessagePreferences(directory)).toEqual({ prompt: "Only guidance." });
  });

  test("a malformed prompt never discards a valid model", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
      imessage: { model: "surplus/glm-5.3", variant: "max", prompt: "\t" },
    }));
    expect(await imessagePreferences(directory)).toEqual({ model: { providerID: "surplus", modelID: "glm-5.3", variant: "max", instanceId: "opencode" } });
  });

  test.each([
    { prompt: 42 },
    { prompt: true },
    { prompt: [] },
    { prompt: "" },
    { prompt: "   " },
    { prompt: "p\x00q" },
    { prompt: "p\tq" },
    { prompt: "x".repeat(2001) },
  ])("rejects malformed prompt %j", async value => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: value }));
    expect(await imessagePreferences(directory)).toEqual({});
  });

  test("accepts newlines and the length boundary", async () => {
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: { prompt: "line one\nline two" } }));
    expect(await imessagePreferences(directory)).toEqual({ prompt: "line one\nline two" });
    await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({ imessage: { prompt: "x".repeat(2000) } }));
    expect(await imessagePreferences(directory)).toEqual({ prompt: "x".repeat(2000) });
  });
});
