import { describe, expect, it } from "@effect/vitest";

import {
  crwBudgetWindow,
  crwReviewsQuery,
  parseCoordClaims,
  parseCrwReviews,
  parseOffboxSpend,
  parseQuota,
  sourceBackend,
} from "./sources.ts";

const coordSource = {
  _tag: "coord-claims" as const,
  command: "coord",
  resourcePrefix: "env:dev",
  env: null,
};

describe("pool sources", () => {
  it("maps every source to the backend it observes", () => {
    expect(sourceBackend(coordSource)).toBe("coord-claim");
    expect(sourceBackend({ _tag: "crw-reviews", configPath: "c", dbPath: "d" })).toBe("crw-config");
    expect(sourceBackend({ _tag: "quota", script: "q", provider: "claude" })).toBe("9router");
    expect(sourceBackend({ _tag: "offbox-spend", command: "offbox" })).toBe("offbox");
  });

  it("counts active and reconcile-required coord claims under the prefix", () => {
    const stdout = JSON.stringify({
      ok: true,
      claims: [
        { resource: "env:dev", state: "active", env: "dev", fence: 4 },
        { resource: "env:dev:qa", state: "reconcile_required", env: "dev" },
        { resource: "env:dev", state: "released", env: "dev" },
        { resource: "svc:broker", state: "active", env: "dev" },
      ],
    });
    expect(parseCoordClaims(stdout, coordSource).used).toBe(2);
    expect(
      parseCoordClaims(stdout, { ...coordSource, resourcePrefix: "svc:", env: "prod" }).used,
    ).toBe(0);
  });

  it("refuses coord output it does not understand", () => {
    expect(() => parseCoordClaims("not json", coordSource)).toThrow(/did not print JSON/);
    expect(() => parseCoordClaims(JSON.stringify({ ok: false, claims: [] }), coordSource)).toThrow(
      /not understood/,
    );
  });

  it("uses crw's own review budget window", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const recent = crwBudgetWindow(
      JSON.stringify({ max_reviews_per_day: 200, review_budget_since: "2026-10-17T06:00:00Z" }),
      now,
    );
    expect(recent.capacity).toBe(200);
    expect(recent.since).toBe(Date.parse("2026-10-17T06:00:00Z") / 1000);

    const old = crwBudgetWindow(
      JSON.stringify({ review_budget_since: "2026-01-01T00:00:00Z" }),
      now,
    );
    expect(old.capacity).toBeNull();
    expect(old.since).toBe(now / 1000 - 86_400);
    expect(crwReviewsQuery(old.since)).toContain(`requested_at > ${now / 1000 - 86_400}`);

    expect(parseCrwReviews('[{"sent":7}]', recent)).toMatchObject({
      used: 7,
      capacity: 200,
      window: "day",
    });
    expect(parseCrwReviews("", recent).used).toBe(0);
  });

  it("reads the quota pool line for the right provider", () => {
    const stdout = [
      "claude | fund | 5h 40% reset 2h | 7d 61% reset 50h",
      "POOL claude: 9/12 usable now: a, b",
      "POOL codex: 1/5 usable now: c",
    ].join("\n");
    expect(parseQuota(stdout, { _tag: "quota", script: "q", provider: "claude" })).toMatchObject({
      used: 3,
      capacity: 12,
      window: "5h",
    });
    expect(parseQuota(stdout, { _tag: "quota", script: "q", provider: "codex" }).used).toBe(4);
    expect(() => parseQuota("nothing", { _tag: "quota", script: "q", provider: "codex" })).toThrow(
      /no codex pool line/,
    );
  });

  it("reads offbox spend against the monthly cap", () => {
    const stdout = JSON.stringify({
      spend: 58.77,
      cap: 500,
      period_end: "2026-11-01T00:00:00Z",
      limits: {},
    });
    expect(parseOffboxSpend(stdout)).toEqual({
      used: 58.77,
      capacity: 500,
      window: "month",
      resetsAt: "2026-11-01T00:00:00Z",
      runOutAt: null,
    });
  });
});
