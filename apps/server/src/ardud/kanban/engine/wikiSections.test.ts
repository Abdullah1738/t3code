import { describe, expect, it } from "vite-plus/test";
import { wikiOutline, wikiSection } from "./wikiSections.ts";

describe("wiki headings", () => {
  it("preserves section bytes and includes nested headings", () => {
    const section = "## Deploy\r\ntext 𐐀\r\n### Child\r\nchild\r\n";
    const body = `# Root\r\n${section}## Next\r\nnext`;
    expect(wikiSection(body, " DEPLOY ")).toEqual({ found: true, body: section });
    expect(wikiSection(body, "Next")).toEqual({ found: true, body: "## Next\r\nnext" });
    expect(wikiOutline(body)).toBe(`0: # Root\n8: ## Deploy\n28: ### Child\n46: ## Next`);
  });

  it.each([
    ["```md", "```"],
    ["````", "````"],
    ["~~~markdown", "~~~"],
    ["   ```", "   ```"],
  ])("ignores headings inside %s fences", (open, close) => {
    const body = `# Start\n${open}\n# Hidden\n## Hidden too\n${close}\n# End`;
    expect(wikiSection(body, "Start")).toEqual({
      found: true,
      body: body.slice(0, body.indexOf("# End")),
    });
    expect(wikiSection(body, "Hidden")).toEqual({ found: false, headings: ["Start", "End"] });
  });

  it("requires a matching fence marker and length, with no trailing content", () => {
    const body = "````md\n```\n# Short\n~~~~\n# Other\n```` no\n# Content\n````\n# Real";
    expect(wikiOutline(body)).toBe(`${body.indexOf("# Real")}: # Real`);
    expect(wikiOutline("```\n# Unclosed")).toBe("");
  });

  const containers = [
    { name: "dash bullet", open: "- ", indent: "  " },
    { name: "plus bullet", open: "+ ", indent: "  " },
    { name: "star bullet", open: "* ", indent: "  " },
    { name: "number dot", open: "1. ", indent: "   " },
    { name: "number parenthesis", open: "1) ", indent: "   " },
    { name: "wide number", open: "123456789. ", indent: "           " },
    { name: "indented list", open: "   - ", indent: "     " },
    { name: "tab padding", open: "-\t", indent: "\t" },
    { name: "nested bullets", open: "- - ", indent: "    " },
    { name: "nested ordered list", open: "- 1. ", indent: "     " },
    { name: "quote", open: "> ", indent: "> " },
    { name: "nested quote", open: "> > ", indent: "> > " },
    { name: "list in quote", open: "> - ", indent: ">   " },
    { name: "quote in list", open: "- > ", indent: "  > " },
  ];

  it.each(
    containers.flatMap((container) => ["```", "~~~"].map((marker) => ({ ...container, marker }))),
  )("ignores $marker fences in $name containers", ({ open, indent, marker }) => {
    const body = `# Start\n${open}${marker}md\n${indent}# Hidden\n${indent}${marker}\n# End`;
    expect(wikiOutline(body)).toBe(`0: # Start\n${body.indexOf("# End")}: # End`);
    expect(wikiSection(body, "Start")).toEqual({
      found: true,
      body: body.slice(0, body.indexOf("# End")),
    });
    expect(wikiSection(body, "Hidden")).toEqual({ found: false, headings: ["Start", "End"] });
  });

  it.each(["- ", "1. ", "> "])("ends an unclosed fence when its %s container ends", (open) => {
    const marker = "```";
    const body = `# Start\n${open}${marker}\n# End`;
    expect(wikiOutline(body)).toBe(`0: # Start\n${body.indexOf("# End")}: # End`);
  });

  it("matches ATX headings with optional closing hashes and up to three spaces", () => {
    const body =
      "#No space\n####### Too deep\n    # Indented\n  ## Two ###  \n###### Six\n#\n# hash#";
    expect(wikiSection(body, "Two")).toEqual({
      found: true,
      body: "  ## Two ###  \n###### Six\n",
    });
    expect(wikiSection(body, "hash#")).toEqual({ found: true, body: "# hash#" });
  });

  it("returns the first duplicate with a note and caps missing heading suggestions", () => {
    expect(wikiSection("## Same\na\n## SAME\nb", "same")).toEqual({
      found: true,
      body: "## Same\na\n",
      note: "2 headings match; returned the first",
    });
    expect(
      wikiSection(Array.from({ length: 45 }, (_, i) => `# H${i}`).join("\n"), "missing"),
    ).toEqual({ found: false, headings: Array.from({ length: 40 }, (_, i) => `H${i}`) });
  });
});
