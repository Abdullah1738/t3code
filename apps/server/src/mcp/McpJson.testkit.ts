import { expect } from "@effect/vitest";

export function expectJsonRoundTrip(value: unknown) {
  const undefinedPaths: string[] = [];
  const visit = (entry: unknown, path: string) => {
    if (entry === undefined) undefinedPaths.push(path);
    else if (entry !== null && typeof entry === "object")
      for (const [key, child] of Object.entries(entry)) visit(child, `${path}.${key}`);
  };
  visit(value, "$structuredContent");
  expect(undefinedPaths, "undefined fields in structuredContent").toEqual([]);
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}
