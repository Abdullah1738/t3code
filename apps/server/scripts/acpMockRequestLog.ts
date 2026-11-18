export function frameRequestLog(pending: string, chunk: string) {
  const buffered = pending + chunk;
  const end = buffered.lastIndexOf("\n") + 1;
  return { write: buffered.slice(0, end), pending: buffered.slice(end) };
}
