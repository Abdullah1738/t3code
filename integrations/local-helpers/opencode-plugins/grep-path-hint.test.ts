import { expect, test } from "bun:test";
import plugin, { type ContextEvent } from "./grep-path-hint";

async function contextHook() {
  let callback: ((event: ContextEvent) => void) | undefined;
  await plugin.setup({
    session: {
      async hook(name, handler) {
        expect(name).toBe("context");
        callback = handler;
      },
    },
  });
  if (!callback) throw new Error("Context hook was not registered");
  return callback;
}

test("only rewrites the built-in grep path description, repeatably", async () => {
  const hook = await contextHook();
  const event = {
    tools: {
      grep: {
        description: "Search file contents",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "File or directory to search. Defaults to the current working directory.",
            },
            include: { type: "string", description: "Glob pattern to filter files" },
            pattern: { type: "string", description: "Text to match" },
          },
          required: ["pattern"],
        },
      },
      glob: { input: { properties: { path: { description: "Directory to search" } } } },
      read: { input: { properties: { path: { description: "File to read" } } } },
      mcp_grep: { input: { properties: { path: { description: "MCP path" } } } },
    },
  };
  const expected = structuredClone(event);
  expected.tools.grep.input.properties.path.description =
    'A literal file or directory path (no glob or brace patterns). To search several files, pass their directory here and a pattern in include, e.g. include "{send,swap}.go".';

  hook(event);
  expect(event).toEqual(expected);
  hook(event);
  expect(event).toEqual(expected);
});

test("leaves absent or non-object grep path schemas untouched", async () => {
  const hook = await contextHook();
  const events: ContextEvent[] = [
    {},
    { tools: {} },
    { tools: { grep: {} } },
    { tools: { grep: { input: {} } } },
    { tools: { grep: { input: { properties: {} } } } },
    { tools: { grep: { input: { properties: { path: true } } } } },
    { tools: { grep: { input: { properties: { path: false } } } } },
    {
      tools: { read: { input: { properties: { path: { description: "File to read" } } } } },
    },
  ];

  for (const event of events) {
    const before = structuredClone(event);
    hook(event);
    expect(event).toEqual(before);
  }
});
