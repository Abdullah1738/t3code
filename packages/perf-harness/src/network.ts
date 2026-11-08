// @effect-diagnostics globalTimers:off
export const mobileLink = { mbps: 10, rttMs: 100 };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Driver-side delivery simulation. It paces consumption of the real response;
// it does not claim TCP congestion, native decoding or device rendering costs.
export async function shapedFetch(fetchResponse: () => Promise<Response>) {
  const start = performance.now();
  await pause(mobileLink.rttMs / 2);
  const response = await fetchResponse();
  await pause(mobileLink.rttMs / 2);
  if (!response.ok) throw new Error(`Shaped fetch: HTTP ${response.status}`);
  let bytes = 0;
  if (response.body) for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    await pause(chunk.byteLength * 8 / (mobileLink.mbps * 1000));
  }
  return { bytes, ms: performance.now() - start };
}
