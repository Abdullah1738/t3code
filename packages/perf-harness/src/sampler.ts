// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
const path = process.env.ROBOB_PERF_SAMPLE_FILE;
if (path && isMainThread) {
  let active = false;
  const sqlTimes = new Map<string, { count: number; totalMs: number; maxMs: number; stalls: { startMs: number; ms: number }[] }>();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    for (const method of ["all", "run", "get"] as const) {
      const original = statement[method];
      Object.defineProperty(statement, method, { value: function(...args: unknown[]) {
        const startMs = performance.now();
        try { return Reflect.apply(original, statement, args); }
        finally {
          if (active) try {
            const ms = performance.now() - startMs;
            const key = sql.slice(0, 4000);
            if (sqlTimes.has(key) || sqlTimes.size < 2000) {
              const entry = sqlTimes.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, stalls: [] };
              entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
              if (ms >= 50 && entry.stalls.length < 100) entry.stalls.push({ startMs, ms });
              sqlTimes.set(key, entry);
            }
          } catch { /* Probe failures cannot change SQL results. */ }
        }
      }});
    }
    return statement;
  };
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let peakRss = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const session = new Session();
  session.connect();
  const post = (method: string) => new Promise<any>((ok, fail) =>
    session.post(method, (error, result) => error ? fail(error) : ok(result)));
  const handleMessage = async (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "perf-start") {
      await post("Profiler.enable");
      await post("Profiler.start");
      process.send?.({ type: "perf-started" });
      histogram.enable();
      histogram.reset();
      sqlTimes.clear();
      active = true;
      timer = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 50);
      timer.unref();
    }
    if (message.type === "perf-stop") {
      active = false;
      if (timer) clearInterval(timer);
      histogram.disable();
      const rssBytes = Math.max(peakRss, process.memoryUsage().rss);
      const eventLoopP99Ms = histogram.percentile(99) / 1e6;
      const eventLoopMaxMs = histogram.max / 1e6;
      const samples = {
        rssBytes, eventLoopP99Ms, eventLoopMaxMs,
        synchronousSql: [...sqlTimes].map(([sql, timing]) => ({ sql, ...timing })).sort((a,b) => b.totalMs - a.totalMs),
        statementStatusAvailable: false,
        profileError: undefined as string | undefined,
      };
      writeFileSync(path, JSON.stringify(samples));
      try {
        const { profile } = await post("Profiler.stop");
        writeFileSync(path + ".cpuprofile", JSON.stringify(profile));
      } catch (error) {
        samples.profileError = String(error);
        writeFileSync(path, JSON.stringify(samples));
      } finally { session.disconnect(); }
      process.send?.({ type: "perf-stopped" });
    }
  };
  process.on("message", message => {
    void handleMessage(message).catch(error => process.send?.({ type: "perf-failed", error: String(error) }));
  });
}
// The measurement control channel must not keep an otherwise stopped server alive.
process.channel?.unref();
