import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";

const decode = Schema.decodeSync(OrchestrationSearchThreadsResult);
const isResult = Schema.is(OrchestrationSearchThreadsResult);
const decodeInput = Schema.decodeSync(OrchestrationSearchThreadsInput);

it("accepts older search responses and preserves partial metadata over the wire", () => {
  expect(decode({ matches: [] })).toEqual({ matches: [] });
  const partial = { matches: [], complete: false, searchedBackTo: "2026-11-11T16:05:00.000Z" };
  expect(decode(partial)).toEqual(partial);
  expect(
    isResult({ ...partial, searchedBackTo: 42 }),
  ).toBe(false);
  expect(decodeInput({ query: "needle" })).toEqual({
    query: "needle",
  });
});
