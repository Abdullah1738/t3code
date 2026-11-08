// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
const path = process.env.ROBOB_PERF_SAMPLE_FILE;
if (path) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let peakRss = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  process.on("message", (message) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "perf-start") {
      histogram.enable();
      histogram.reset();
      timer = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 50);
      timer.unref();
    }
    if (message.type === "perf-stop") {
      if (timer) clearInterval(timer);
      histogram.disable();
      writeFileSync(
        path,
        JSON.stringify({
          rssBytes: Math.max(peakRss, process.memoryUsage().rss),
          eventLoopP99Ms: histogram.percentile(99) / 1e6,
          eventLoopMaxMs: histogram.max / 1e6,
        }),
      );
      process.send?.({ type: "perf-stopped" });
    }
  });
}
// The measurement control channel must not keep an otherwise stopped server alive.
process.channel?.unref();
