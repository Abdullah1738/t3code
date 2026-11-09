// Pure decisions for catalog-guard. No I/O here so the tests can drive them.

// Models whose absence means Robob's OpenCode catalog went partial. Robob
// refuses delegation to any model missing from it.
export const DEFAULT_REQUIRED = ['opus/claude-opus-5-5', 'opus/cx/gpt-6.1-sol'];
export const DEFAULT_PREFIX = 'opus/';
export const RETAINED_REQUIRED = ['surplus/glm-5.3-flash'];
const departing = (slug) => /(?:^|\/)(?:claude-|gpt-|o[1-9](?:-|$))/i.test(slug);

export function watchPolicy(cutover, { required, prefix } = {}) {
  if (cutover.active || cutover.completed) {
    return { required: (cutover.retainedOpenCodeModels ?? required ?? RETAINED_REQUIRED).filter((s) => !departing(s)),
      prefix: null, excludeDeparting: true };
  }
  return { required: required ?? DEFAULT_REQUIRED, prefix: prefix ?? DEFAULT_PREFIX };
}
export const MIN_REFRESH_GAP_MS = 5 * 60_000;
// Robob may be in the middle of its own re-read right after it wrote the cache.
export const SETTLE_MS = 30_000;

export function cachedSlugs(cache) {
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return new Set(models.map((m) => m?.slug).filter((s) => typeof s === 'string'));
}

/**
 * Pure cache assessment; the caller supplies the current cutover watch policy.
 * next: 'ok' (complete), 'skip' (nothing to judge), 'settling' (just written),
 * 'check-service' (looks partial; confirm against the OpenCode service).
 */
export function assessCache(cache, { now, required = DEFAULT_REQUIRED, prefix = DEFAULT_PREFIX, settleMs = SETTLE_MS } = {}) {
  if (!cache || typeof cache !== 'object') return { next: 'skip', reason: 'cache unreadable' };
  if (cache.enabled === false) return { next: 'skip', reason: 'provider disabled' };
  const slugs = cachedSlugs(cache);
  const missingRequired = required.filter((s) => !slugs.has(s));
  const hasPrefix = prefix == null || [...slugs].some((s) => s.startsWith(prefix));
  if (missingRequired.length === 0 && hasPrefix) return { next: 'ok', reason: 'complete', count: slugs.size };
  const checkedMs = Date.parse(cache.checkedAt ?? '');
  if (Number.isFinite(checkedMs) && now - checkedMs < settleMs) {
    return { next: 'settling', reason: `cache written ${Math.round((now - checkedMs) / 1000)}s ago`, count: slugs.size };
  }
  return {
    next: 'check-service',
    reason: hasPrefix ? `missing ${missingRequired.join(', ')}` : `no ${prefix}* models`,
    count: slugs.size,
  };
}

/** Watched models the service lists that the cache lacks. */
export function missingFromCache(cache, serviceSlugs, { required = DEFAULT_REQUIRED, prefix = DEFAULT_PREFIX, excludeDeparting = false } = {}) {
  const slugs = cachedSlugs(cache);
  return serviceSlugs.filter((s) => (!excludeDeparting || !departing(s))
    && ((prefix != null && s.startsWith(prefix)) || required.includes(s)) && !slugs.has(s)).toSorted();
}

/**
 * action: 'refresh', 'rate-limited' (refreshed too recently) or
 * 'service-lacks' (the service does not list them either, so a refresh can't help).
 */
export function planRefresh({ cache, serviceSlugs, lastRefreshAt = 0, now, minGapMs = MIN_REFRESH_GAP_MS, required, prefix, excludeDeparting }) {
  const missing = missingFromCache(cache, serviceSlugs, { required, prefix, excludeDeparting });
  if (missing.length === 0) return { action: 'service-lacks', missing };
  if (now - lastRefreshAt < minGapMs) {
    return { action: 'rate-limited', missing, waitMs: minGapMs - (now - lastRefreshAt) };
  }
  return { action: 'refresh', missing };
}

export function summarize(slugs, max = 4) {
  const list = [...slugs];
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max} more`;
}
