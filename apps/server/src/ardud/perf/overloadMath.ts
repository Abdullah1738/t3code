export const utilisation = (
  start: { active: number; idle: number },
  end: { active: number; idle: number },
  gcMs: number,
) => {
  const activeMs = end.active - start.active;
  const idleMs = end.idle - start.idle;
  const wallMs = activeMs + idleMs;
  if (activeMs < 0 || idleMs < 0 || gcMs < 0 || wallMs <= 0)
    throw new Error("Invalid measurement interval");
  return {
    activeMs,
    idleMs,
    wallMs,
    busy: activeMs / wallMs,
    gcOfWall: gcMs / wallMs,
    gcOfBusy: activeMs === 0 ? 0 : gcMs / activeMs,
  };
};

export const gcOverlapMs = (
  entries: ReadonlyArray<{ startTime: number; duration: number }>,
  start: number,
  end: number,
) =>
  entries.reduce(
    (sum, entry) =>
      sum +
      Math.max(
        0,
        Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime),
      ),
    0,
  );

export const slope = (samples: ReadonlyArray<{ seconds: number; value: number }>) => {
  if (samples.length < 2) throw new Error("Backlog slope needs at least two samples");
  const n = samples.length;
  const sx = samples.reduce((sum, p) => sum + p.seconds, 0);
  const sy = samples.reduce((sum, p) => sum + p.value, 0);
  const denominator = n * samples.reduce((sum, p) => sum + p.seconds ** 2, 0) - sx ** 2;
  if (denominator === 0) throw new Error("Backlog timestamps must differ");
  return (n * samples.reduce((sum, p) => sum + p.seconds * p.value, 0) - sx * sy) / denominator;
};

export const equivalent = (
  base: Readonly<Record<string, number>>,
  candidate: Readonly<Record<string, number>>,
  tolerance = 0.1,
) =>
  [...new Set([...Object.keys(base), ...Object.keys(candidate)])].every((key) => {
    const a = base[key];
    const b = candidate[key];
    return (
      a !== undefined &&
      b !== undefined &&
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(b - a) <= Math.abs(a) * tolerance
    );
  });

export const calibrationFailures = (
  run: { busy: number; gcOfBusy: number; rates: Record<string, number> },
  targets: Readonly<Record<string, number>>,
) => [
  ...(Number.isFinite(run.busy) && run.busy >= 0.55 ? [] : ["busy below 55%"]),
  ...(Number.isFinite(run.gcOfBusy) && run.gcOfBusy >= 0.2 ? [] : ["GC below 20% of busy"]),
  ...(equivalent(targets, run.rates, 0.25) ? [] : ["work rates outside ±25% of trace targets"]),
];

export const candidateFailures = (
  run: {
    busy: number;
    gcOfWall: number;
    p99Ms: number;
    stalls: number;
    logical: Readonly<Record<string, number>>;
    resultSizes: Readonly<Record<string, number>>;
    pending: Readonly<Record<string, number>>;
    slopes: Readonly<Record<string, number>>;
  },
  base: {
    logical: Readonly<Record<string, number>>;
    resultSizes: Readonly<Record<string, number>>;
    pending: Readonly<Record<string, number>>;
  },
) => [
  ...(Number.isFinite(run.busy) && run.busy <= 0.3 ? [] : ["busy above 30%"]),
  ...(Number.isFinite(run.gcOfWall) && run.gcOfWall <= 0.1 ? [] : ["GC above 10% of wall"]),
  ...(Number.isFinite(run.p99Ms) && run.p99Ms <= 100 ? [] : ["p99 above 100 ms"]),
  ...(run.stalls === 0 ? [] : ["stall ≥1 second"]),
  ...(equivalent(base.logical, run.logical) ? [] : ["logical work outside ±10% of base"]),
  ...(equivalent(base.resultSizes, run.resultSizes, 0)
    ? []
    : ["poller logical result size changed"]),
  ...Object.entries(base.pending).flatMap(([key, value]) =>
    Number.isFinite(run.pending[key]) && run.pending[key]! <= value * 1.1 && run.pending[key]! >= 0
      ? []
      : [`${key} backlog exceeds base +10%`],
  ),
  ...Object.entries(run.slopes).flatMap(([key, value]) =>
    Number.isFinite(value) && value <= 0 ? [] : [`${key} backlog has upward slope`],
  ),
];
