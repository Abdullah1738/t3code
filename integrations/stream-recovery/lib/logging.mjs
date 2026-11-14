const { emit, observed } = await import('../../router-logging/toollog.mjs').catch(() => ({ emit: () => {}, observed: (_c, _n, work) => work() }));
export { emit, observed };
const operations = new Set(['sendToThread', 'interruptThread', 'dispatchCommand', 'ocInterrupt']);
const wrapped = new WeakSet();
// Wrap only mutations. Message bodies and arbitrary server responses never enter logs.
export function recoveryIo(io) {
  const result = { ...io };
  for (const key of [...operations, 'telegram']) {
    const value = io[key];
    if (typeof value !== 'function' || wrapped.has(value)) continue;
    const work = (...args) => {
      if (key !== 'telegram') return observed('stream-recovery', `recovery.${key}`, () => value.apply(io, args));
      const start = performance.now();
      try {
        const reply = value.apply(io, args);
        emit('stream-recovery', 'recovery.telegram', {kind:'perf',ok:true,durationMs:performance.now()-start});
        return reply;
      } catch (error) {
        emit('stream-recovery', 'recovery.telegram', {kind:'error',ok:false,durationMs:performance.now()-start,error:{tag:'notification_failed'}});
        throw error;
      }
    };
    wrapped.add(work);
    result[key] = work;
  }
  return result;
}
