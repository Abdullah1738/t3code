import { describe, expect, it } from "vite-plus/test";
import { resolveByIdRouteState } from "./ThreadRouteState";

const initial = {
  status: "empty",
  error: false,
  exists: false,
  deleted: false,
  archived: false,
  timedOut: false,
};
describe("thread route by id", () => {
  it.each([
    [{}, "loading"],
    [{ exists: true }, "ready"],
    [{ exists: true, archived: true }, "archived"],
    [{ status: "deleted" }, "deleted"],
    [{ status: "not-found" }, "not-found"],
    [{ status: "not-found", timedOut: true }, "not-found"],
    [{ status: "not-found", deleted: true }, "deleted"],
    [{ status: "synchronizing", timedOut: false }, "loading"],
    [{ exists: true, deleted: true }, "deleted"],
    [{ status: "no-access", exists: true }, "no-access"],
    [{ error: true }, "unavailable"],
    [{ timedOut: true }, "unavailable"],
    [{ exists: true, timedOut: true }, "ready"],
  ])("resolves %j to %s without using list coverage", (patch, expected) => {
    expect(resolveByIdRouteState({ ...initial, ...patch })).toBe(expected);
  });
});
