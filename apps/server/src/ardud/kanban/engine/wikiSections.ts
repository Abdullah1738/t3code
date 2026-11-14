import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";

interface MarkdownNode {
  readonly type: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: ReadonlyArray<MarkdownNode> | undefined;
}

interface Heading {
  readonly text: string;
  readonly line: string;
  readonly level: number;
  readonly offset: number;
}

const headings = (body: string): Heading[] => {
  const result: Heading[] = [];
  const code: Array<{ start: number; end: number }> = [];
  // The existing Markdown parser handles fence boundaries inside list and quote containers.
  const visit = (node: MarkdownNode) => {
    if (node.type === "code") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) code.push({ start, end });
    } else node.children?.forEach(visit);
  };
  visit(parseMarkdownWithMath(body));
  let codeIndex = 0;
  // Keep offsets in the original string, including CRLF and surrogate pairs.
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    while (code[codeIndex] !== undefined && code[codeIndex]!.end <= match.index) codeIndex++;
    if (code[codeIndex] !== undefined && match.index >= code[codeIndex]!.start) continue;
    const line = match[0].replace(/[\r\n]+$/, "");
    const heading = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|$)/.exec(line);
    if (heading !== null) {
      result.push({
        text: (heading[2] ?? "").replace(/(?:^|[\t ]+)#+[\t ]*$/, "").trim(),
        line,
        level: heading[1]!.length,
        offset: match.index,
      });
    }
  }
  return result;
};

export const wikiOutline = (body: string): string =>
  headings(body)
    .map((heading) => `${heading.offset}: ${heading.line}`)
    .join("\n");

export const wikiSection = (body: string, section: string) => {
  const all = headings(body);
  const matches = all.filter(
    (heading) => heading.text.toLowerCase() === section.trim().toLowerCase(),
  );
  const first = matches[0];
  if (first === undefined)
    return { found: false as const, headings: all.slice(0, 40).map((h) => h.text) };
  const end = all.find((heading) => heading.offset > first.offset && heading.level <= first.level);
  return {
    found: true as const,
    body: body.slice(first.offset, end?.offset),
    ...(matches.length > 1 ? { note: `${matches.length} headings match; returned the first` } : {}),
  };
};
