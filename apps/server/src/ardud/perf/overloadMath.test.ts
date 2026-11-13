import { describe, expect, it } from "vite-plus/test";
import {
  calibrationFailures,
  gcOverlapMs,
  candidateFailures,
  equivalent,
  slope,
  utilisation,
} from "./overloadMath.ts";

describe("overload result math", () => {
  it("clips collections to the measured interval regardless of observer delivery", () => {
    expect(
      gcOverlapMs(
        [
          { startTime: 50, duration: 100 },
          { startTime: 200, duration: 30 },
          { startTime: 290, duration: 40 },
          { startTime: 400, duration: 20 },
        ],
        100,
        300,
      ),
    ).toBe(90);
  });
  it("uses interval deltas and distinguishes GC wall from busy share", () => {
    expect(utilisation({ active: 200, idle: 800 }, { active: 800, idle: 1200 }, 150)).toEqual({
      activeMs: 600,
      idleMs: 400,
      wallMs: 1000,
      busy: 0.6,
      gcOfWall: 0.15,
      gcOfBusy: 0.25,
    });
    expect(() => utilisation({ active: 0, idle: 0 }, { active: 0, idle: 0 }, 0)).toThrow();
  });
  it("rejects missing work, zero-to-nonzero work and counter resets", () => {
    expect(equivalent({ events: 100, errors: 0 }, { events: 90, errors: 0 })).toBe(true);
    expect(equivalent({ events: 100, errors: 0 }, { events: 89, errors: 0 })).toBe(false);
    expect(equivalent({ errors: 0 }, { errors: 1 })).toBe(false);
    expect(equivalent({ events: 100 }, {})).toBe(false);
    expect(() => utilisation({ active: 1, idle: 0 }, { active: 0, idle: 1 }, 0)).toThrow();
  });
  it("detects growing queues even when the endpoint is small", () => {
    expect(
      slope([
        { seconds: 0, value: 0 },
        { seconds: 60, value: 3 },
        { seconds: 120, value: 6 },
      ]),
    ).toBe(0.05);
    expect(
      slope([
        { seconds: 0, value: 4 },
        { seconds: 60, value: 2 },
        { seconds: 120, value: 0 },
      ]),
    ).toBeLessThan(0);
  });
  it("applies the inclusive line and rejects dropped work or growing backlog", () => {
    const base = {
      logical: { events: 100 },
      resultSizes: { cards: 3900 },
      pending: { commands: 0 },
    };
    const pass = {
      busy: 0.3,
      gcOfWall: 0.1,
      p99Ms: 100,
      stalls: 0,
      ...base,
      slopes: { commands: 0 },
    };
    expect(candidateFailures(pass, base)).toEqual([]);
    expect(candidateFailures({ ...pass, logical: { events: 89 } }, base)).toContain(
      "logical work outside ±10% of base",
    );
    expect(candidateFailures({ ...pass, pending: { commands: 1 } }, base)).toContain(
      "commands backlog exceeds base +10%",
    );
    expect(candidateFailures({ ...pass, slopes: { commands: 0.01 } }, base)).toContain(
      "commands backlog has upward slope",
    );
    expect(
      calibrationFailures({ busy: 0.55, gcOfBusy: 0.2, rates: { ticks: 12.5 } }, { ticks: 10 }),
    ).toEqual([]);
    expect(
      calibrationFailures({ busy: 0.54, gcOfBusy: 0.19, rates: { ticks: 10 } }, { ticks: 10 }),
    ).toHaveLength(2);
  });
});
