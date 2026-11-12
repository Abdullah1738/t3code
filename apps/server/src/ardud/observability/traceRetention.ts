// maxFiles counts backups; the active file consumes one more slot.
export const DEFAULT_TRACE_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_TRACE_MAX_FILES = 24;
export const TRACE_RETENTION_MAX_BYTES = 1_000_000_000;

/** Defaults retain over ten minutes at 1 MiB/s, including a partially filled active file. */
export function boundedTraceRetention(maxBytes: number, maxFiles: number) {
  const bytes =
    Number.isFinite(maxBytes) && maxBytes >= 1 ? Math.floor(maxBytes) : DEFAULT_TRACE_MAX_BYTES;
  const files =
    Number.isFinite(maxFiles) && maxFiles >= 1 ? Math.floor(maxFiles) : DEFAULT_TRACE_MAX_FILES;
  const boundedBytes = Math.min(bytes, Math.floor(TRACE_RETENTION_MAX_BYTES / 2));
  return {
    maxBytes: boundedBytes,
    maxFiles: Math.min(files, 64, Math.floor(TRACE_RETENTION_MAX_BYTES / boundedBytes) - 1),
  };
}
