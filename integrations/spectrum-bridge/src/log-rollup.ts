import { emptyPromptProbe, cleanPromptProbe, mergePromptProbe, summarizePromptProbe, type PromptProbeStats } from "./log-prompt-probes.ts";
import type { LogLine } from "./toollog.ts";
import { callName, percentiles } from "./log-calls.ts";
import { createRobobLinkAggregation } from "./log-robob-link.ts";
import { createChainAggregation } from "./log-chains.ts";
import { FETCH_CAUSES, cleanRenderCardId } from "./log-card-fetch.ts";

export async function summarizeLog(lines: AsyncIterable<LogLine>, laterLines?: AsyncIterable<LogLine>, renderLines: LogLine[] = [], requestedDay?: string) {
  const countsByName: Record<string, number> = Object.create(null);
  const countsByKind: Record<string, number> = { event: 0, perf: 0, error: 0 };
  const durations = new Map<string, Map<number, number>>();
  const components = new Map<string, Map<string, { count: number; ok: number; failed: number; histogram: Map<number, number> }>>();
  const errors = new Map<string, { tag: string; name: string; count: number; sampleId?: string; site?: string; causeKinds?: Record<string, number> }>();
  const causes = new Map<string, { tag: string; causeKey: string; count: number }>();
  const probeRows = new Map<string, Map<string, number>>();
  function probeCause(key: string, row: string) {
    const rows = probeRows.get(key) ?? new Map<string, number>();
    rows.set(row, (rows.get(row) ?? 0) + 1);
    probeRows.set(key, rows);
  }
  const renderFailures = new Map<string, number>();
  const renderFetchFailures = new Map<string, { failureCode: string; fetchCause: string; httpStatus?: number; count: number; cardIds: Set<string> }>();
  const represented = new Set<string>();
  const representedSingleFailures = new Set<string>();
  const individualCalls: LogLine[] = [];
  const probeFailureKinds = new Map<string, string>();
  const chainAggregation = createChainAggregation();
  const promptProbe = emptyPromptProbe();
  const probeHours = new Map<string, PromptProbeStats>();
  const robobLink = createRobobLinkAggregation();
  let day = requestedDay;
  const firstReplies = new Map<number, number>();
  const alerts = new Set<string>();
  let overdue = 0, requeued_by_watchdog = 0, answered_late = 0;
  let total = 0, ok = 0, failed = 0, recordedRows = 0, failedCalls = 0;
  let dedupedFailures = 0, countedErrors = 0;
  function observeError(line: LogLine) {
    if (line.alreadyLogged === true) {
      const kind = line.props?.causeKind;
      const requestId = line.ids?.requestId;
      if (line.error?.tag === "router.catch1" && typeof requestId === "string" && requestId
        && typeof kind === "string" && ["timeout", "http", "transport"].includes(kind)) {
        probeFailureKinds.set(requestId, kind);
      }
      return;
    }
    if (line.ids?.outageId && line.props?.linkGated === true) return;
    // Legacy request diagnostics are owned by control.catch1/2, including in mixed-version days.
    const requestFailure = line.component === "robob" && line.name === "turn.robob_call" && line.kind === "perf" && line.ok === false;
    if (requestFailure && line.props?.failureFormat === "single"
      && (!line.ids?.callBatchId || !representedSingleFailures.has(`${line.ids.callBatchId}\0${callName(line)}`))) failedCalls++;
    if (requestFailure && line.props?.failureFormat !== "single" && line.error?.tag === "control.request_failed") return;
    if (!line.error) return;
    if (line.error.causeKey) {
      const key = `${line.error.tag}\0${line.error.causeKey}`;
      const item = causes.get(key) ?? { tag: line.error.tag, causeKey: line.error.causeKey, count: 0 };
      item.count++; causes.set(key, item);
    }
    const name = line.error.name;
    const key = `${line.error.tag}\0${name}`;
    const item: { tag: string; name: string; count: number; sampleId?: string; site?: string; causeKinds?: Record<string, number> } = errors.get(key) ?? { tag: line.error.tag, name, count: 0,
      sampleId: line.ids?.messageId ?? line.ids?.operationId ?? line.ids?.threadId ?? line.ids?.formId ?? line.ids?.runId,
      ...(line.site ? { site: line.site } : {}) };
    // Request details are observed after catches, so enrich their owner without recounting the catch.
    const kind = line.props?.causeKind ?? (requestFailure ? probeFailureKinds.get(line.ids?.requestId ?? "") : undefined);
    if (typeof kind === "string" && ["timeout", "http", "transport"].includes(kind)) {
      item.causeKinds ??= {}; item.causeKinds[kind] = (item.causeKinds[kind] ?? 0) + 1;
    }
    item.count++; errors.set(key, item);
  }
  function merge(target: Map<number, number>, values: Iterable<[number, number]>) {
    for (const [ms, count] of values) target.set(ms, (target.get(ms) ?? 0) + count);
  }
  function component(component: string, name: string, count: number, oks: number, failures: number, histogram: Iterable<[number, number]>) {
    const names = components.get(component) ?? new Map();
    const stats = names.get(name) ?? { count: 0, ok: 0, failed: 0, histogram: new Map<number, number>() };
    stats.count += count; stats.ok += oks; stats.failed += failures; merge(stats.histogram, histogram);
    names.set(name, stats); components.set(component, names);
  }
  function consume(line: LogLine, count = 1, oks = Number(line.ok === true), failures = Number(line.ok === false), histogram?: Iterable<[number, number]>) {
    if (line.name === "router.prompt_probes" && line.component === "router" && line.kind === "perf") {
      const stats = cleanPromptProbe(line.promptProbe);
      if (stats) {
        mergePromptProbe(promptProbe, stats);
        const hour = line.ts.slice(11, 13);
        const hourly = probeHours.get(hour) ?? emptyPromptProbe();
        mergePromptProbe(hourly, stats); probeHours.set(hour, hourly);
      }
    }
    if (line.alreadyLogged === true) {
      if (line.kind === "error" || failures > 0) dedupedFailures += count;
      failures = 0;
    } else if (line.kind === "error") countedErrors += count;
    total += count; ok += oks; failed += failures;
    countsByName[line.name] = (countsByName[line.name] ?? 0) + count;
    countsByKind[line.kind] += count;
    const values = histogram ? [...histogram] : line.durationMs === undefined ? [] : [[Math.round(line.durationMs), 1] as [number, number]];
    if (values.length) {
      const all = durations.get(line.name) ?? new Map<number, number>();
      merge(all, values); durations.set(line.name, all);
    }
    component(line.component, line.name, count, oks, failures, values);
    if (line.name === "turn.robob_call") {
      const name = callName(line);
      if (name) component("robob", name, count, oks, failures, values);
    }
    if (line.name === "card.render" && line.ok === false && typeof line.props?.failureCode === "string") {
      const code = line.props.failureCode;
      renderFailures.set(code, (renderFailures.get(code) ?? 0) + count);
      if (["page_fetch", "page_http", "page_body", "page_type"].includes(code)) {
        const cause = FETCH_CAUSES.find(cause => cause === line.props?.fetchCause) ?? "unknown";
        const status = line.props?.httpStatus;
        const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
        const key = `${code}\0${cause}\0${httpStatus ?? ""}`;
        const item = renderFetchFailures.get(key) ?? { failureCode: code, fetchCause: cause,
          ...(httpStatus !== undefined ? { httpStatus } : {}), count: 0, cardIds: new Set<string>() };
        item.count += count;
        const cardId = line.ids?.cardId;
        if (cleanRenderCardId(cardId)) item.cardIds.add(cardId);
        renderFetchFailures.set(key, item);
      }
    }
    observeError(line);
  }
  for await (const line of lines) {
    day ??= line.ts.slice(0, 10);
    recordedRows++;
    const probeRow = line.ids?.inboundId;
    if (probeRow && /^row_[a-f0-9]{16}$/.test(probeRow)) {
      if (line.name === "router.probe_backoff") {
        const key = "router.probe_backoff\0admission_read_failed";
        const item = causes.get(key) ?? { tag: "router.probe_backoff", causeKey: "admission_read_failed", count: 0 };
        item.count++; causes.set(key, item); probeCause(key, probeRow);
      } else if (line.error?.tag === "router.catch1" && line.error.name !== "RobobLinkDown") {
        // Keep row concentration visible even when the request layer owns the failure count.
        const key = "router.catch1\0admission_read_failed";
        const item = causes.get(key) ?? { tag: "router.catch1", causeKey: "admission_read_failed", count: 0 };
        item.count++; causes.set(key, item); probeCause(key, probeRow);
      }
    }
    if (line.name === "robob.link_down" && line.link) {
      const key = "robob.link_down\0robob_unavailable";
      const item = causes.get(key) ?? { tag: "robob.link_down", causeKey: "robob_unavailable", count: 0 };
      item.count++; causes.set(key, item);
    }
    robobLink.accept(line);
    chainAggregation.accept(line);
    if (line.name === "inbound.overdue") overdue++;
    if (line.name === "inbound.watchdog_requeued") requeued_by_watchdog++;
    if (["inbound.overdue_notice", "inbound.unanswered_alert", "unanswered.alert"].includes(line.name) && line.ids?.inboundId) alerts.add(`${line.ids.chat}:${line.ids.inboundId}`);
    if (line.name === "inbound.answered_late") answered_late++;
    if (line.name === "inbound.answered" && line.durationMs !== undefined && ["owner", "moni"].includes(line.ids?.chat ?? "")) {
      const ms = Math.round(line.durationMs); firstReplies.set(ms, (firstReplies.get(ms) ?? 0) + 1);
    }
    if (line.name === "card.renders" && line.renders) {
      consume({ ...line, name: "card.render", renders: undefined }, line.renders.count, line.renders.count, 0, line.renders.histogram);
    } else if (line.name === "turn.robob_calls" && line.calls) {
      for (const [name, stats] of Object.entries(line.calls)) {
        if (line.ids?.callBatchId) represented.add(`${line.ids.callBatchId}\0${name}`);
        if (stats.singleFailures !== undefined) {
          failedCalls += stats.singleFailures;
          if (line.ids?.callBatchId) representedSingleFailures.add(`${line.ids.callBatchId}\0${name}`);
        }
        consume({ ...line, name: "turn.robob_call", calls: undefined }, stats.count, stats.ok, stats.failed, stats.histogram);
        component("robob", name, stats.count, stats.ok, stats.failed, stats.histogram);
      }
    } else if (line.name === "turn.robob_call" && line.kind === "perf") individualCalls.push(line);
    else consume(line);
  }
  // Shared counters represent fast renders without adding one NDJSON row per CLI process.
  for (const line of renderLines) if (line.renders) {
    consume({ ...line, name: "card.render", renders: undefined }, line.renders.count, line.renders.count, 0, line.renders.histogram);
  }
  // Later days complete this day's receipts without moving their event counts into this day.
  if (laterLines) for await (const line of laterLines) { chainAggregation.accept(line, true); robobLink.accept(line); }
  // Slow/failed rows remain readable, but their batch histogram already counts them.
  for (const line of individualCalls) {
    if (!line.ids?.callBatchId || !represented.has(`${line.ids.callBatchId}\0${callName(line)}`)) consume(line);
    else observeError(line);
  }
  const durationMs: Record<string, ReturnType<typeof percentiles>> = Object.create(null);
  for (const [name, histogram] of durations) durationMs[name] = percentiles(histogram);
  const byComponent: Record<string, Record<string, { count: number; ok: number; failed: number; errorRate: number; durationMs?: ReturnType<typeof percentiles> }>> = Object.create(null);
  for (const [component, names] of components) {
    byComponent[component] = Object.create(null);
    for (const [name, stats] of names) byComponent[component]![name] = {
      count: stats.count, ok: stats.ok, failed: stats.failed, errorRate: stats.count ? stats.failed / stats.count : 0,
      ...(stats.histogram.size ? { durationMs: percentiles(stats.histogram) } : {}),
    };
  }
  return { robob_link: robobLink.summary(day), overdue, requeued_by_watchdog, unanswered_alerts: alerts.size, answered_late, first_reply_latency_ms: percentiles(firstReplies), total, recordedRows, countsByName, countsByKind, ok, failed,
    dedupedFailures, okRate: ok + failed ? ok / (ok + failed) : 0, errorRate: total ? (countedErrors + failedCalls) / total : 0,
    promptProbe: { ...summarizePromptProbe(promptProbe), byHour: Object.fromEntries([...probeHours].sort().map(([hour, stats]) => [hour, summarizePromptProbe(stats)])) },
    durationMs, byComponent, cardRenderFailures: Object.fromEntries(renderFailures),
    cardRenderFetchFailures: [...renderFetchFailures.values()].sort((a, b) => b.count - a.count || a.failureCode.localeCompare(b.failureCode) || a.fetchCause.localeCompare(b.fetchCause) || (a.httpStatus ?? 0) - (b.httpStatus ?? 0))
      .map(item => ({ ...item, cardIds: [...item.cardIds].sort() })),
    topCauses: [...causes.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag) || a.causeKey.localeCompare(b.causeKey)).slice(0, 20).map(item => {
      const rows = probeRows.get(`${item.tag}\0${item.causeKey}`);
      return rows ? { ...item, distinctInboundIds: rows.size, topInboundIds: [...rows].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14).map(([inboundId, count]) => ({ inboundId, count })) } : item;
    }), chains: chainAggregation.summary(),
    topErrorTags: [...errors.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag) || a.name.localeCompare(b.name)).slice(0, 20) };
}
