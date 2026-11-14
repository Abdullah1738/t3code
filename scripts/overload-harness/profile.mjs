/** Weighted V8 samples, using the same self/inclusive/file accounting as the live prof.py. */
export function profileShares(profile, limit = 30) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const weights = new Map();
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index];
    const weight = Math.max(0, profile.timeDeltas[index] ?? 0);
    weights.set(id, (weights.get(id) ?? 0) + weight);
  }
  const self = new Map();
  const inclusive = new Map();
  const files = new Map();
  const frame = (id) => {
    const value = nodes.get(id)?.callFrame;
    if (!value) throw new Error(`Missing CPU profile node ${id}`);
    return {
      name: value.functionName || "(anonymous)",
      file: value.url || "",
      line: value.lineNumber ?? 0,
    };
  };
  const key = (value) => `${value.name} ${value.file}:${value.line}`;
  const add = (map, name, weight) => map.set(name, (map.get(name) ?? 0) + weight);
  let totalUs = 0;
  let idleUs = 0;
  for (const [id, weight] of weights) {
    const value = frame(id);
    totalUs += weight;
    if (value.name === "(idle)") idleUs += weight;
    else {
      add(self, key(value), weight);
      add(files, value.file || value.name, weight);
    }
    let current = id;
    const visited = new Set();
    const seenFrames = new Set();
    while (current !== undefined) {
      if (visited.has(current)) throw new Error("Cycle in CPU profile tree");
      visited.add(current);
      const name = key(frame(current));
      if (!seenFrames.has(name)) {
        add(inclusive, name, weight);
        seenFrames.add(name);
      }
      current = parents.get(current);
    }
  }
  const busyUs = totalUs - idleUs;
  if (busyUs <= 0) throw new Error("CPU profile contains no busy samples");
  const sorted = (map) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([frame, microseconds]) => ({
        frame,
        microseconds,
        shareOfBusy: microseconds / busyUs,
      }));
  const noise =
    /^(\(|runLoop |evaluate |runSync |run |next |anonymous |processTicksAndRejections |listOnTimeout |processTimers |processImmediate |emit |callbackTrampoline )/;
  return {
    totalUs,
    busyUs,
    busyOfWall: busyUs / totalUs,
    self: sorted(self),
    inclusive: sorted(new Map([...inclusive].filter(([name]) => !noise.test(name)))),
    files: sorted(files),
  };
}

export function profileMarkdown(profile) {
  const shares = profileShares(profile);
  const table = (title, rows) => [
    `### ${title}`,
    "",
    "| Frame | Share of busy |",
    "|---|---:|",
    ...rows.map(
      (row) => `| ${row.frame.replaceAll("|", "\\|")} | ${(row.shareOfBusy * 100).toFixed(1)}% |`,
    ),
    "",
  ];
  return [
    `CPU profile: ${(shares.totalUs / 1e6).toFixed(2)} s sampled; ${(shares.busyOfWall * 100).toFixed(1)}% non-idle. Inclusive rows overlap and must not be summed.`,
    "",
    ...table("Self time", shares.self),
    ...table("Inclusive time, named functions", shares.inclusive),
    ...table("Self time by file", shares.files),
  ].join("\n");
}
