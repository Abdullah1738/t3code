// maxFiles counts backups; gzip and the plain active file share the on-disk budget.
export const DEFAULT_TRACE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TRACE_MAX_FILES = 128;
export const DEFAULT_TRACE_FILE_MIN_DURATION_MS = 2;
export const TRACE_RETENTION_MAX_BYTES = 1_000_000_000;

/** Raw rotation size and backup count are independent of the compressed on-disk byte cap. */
export function boundedTraceRetention(maxBytes: number, maxFiles: number) {
  const bytes =
    Number.isFinite(maxBytes) && maxBytes >= 1 ? Math.floor(maxBytes) : DEFAULT_TRACE_MAX_BYTES;
  const files =
    Number.isFinite(maxFiles) && maxFiles >= 1 ? Math.floor(maxFiles) : DEFAULT_TRACE_MAX_FILES;
  return {
    // Reserve room for active + source + gzip scratch, including incompressible gzip expansion.
    maxBytes: Math.min(bytes, Math.floor(TRACE_RETENTION_MAX_BYTES / 4)),
    maxFiles: Math.min(files, 256),
    maxTotalBytes: TRACE_RETENTION_MAX_BYTES,
  };
}
