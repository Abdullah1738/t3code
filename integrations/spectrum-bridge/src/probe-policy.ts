import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";

export const probeDeferred = Symbol("probeDeferred");
type Backoff = { delay: number; nextAt: number; aliases?: string[]; token?: string };

/** The owner store is shared by all chat routers, including after a restart. */
export class ProbeBudget {
  constructor(private readonly store: Store) {}

  take(now = Date.now()): boolean {
    return this.store.db.transaction(() => {
      const starts = (this.store.get<number[]>("replay-probe-starts") ?? []).filter(at => at > now - 60_000);
      if (starts.length >= 60) return false;
      this.store.set("replay-probe-starts", [...starts, now]);
      return true;
    }).immediate();
  }

  refund(at: number): void {
    this.store.db.transaction(() => {
      const starts = this.store.get<number[]>("replay-probe-starts") ?? [];
      const index = starts.indexOf(at);
      if (index < 0) return;
      starts.splice(index, 1);
      this.store.set("replay-probe-starts", starts);
    }).immediate();
  }
}

export class ProbeBackoff {
  constructor(private readonly store: Store) {}

  get(leader: string) { return this.store.get<Backoff | null>(`replay-probe-backoff:${leader}`); }
  private steps(leader: string) {
    const own = this.get(leader);
    return [own, ...own?.aliases?.map(alias => this.get(alias)) ?? []];
  }
  cooling(leader: string) { return this.steps(leader).some(step => Date.now() < (step?.nextAt ?? 0)); }
  retry(leader: string) { return this.steps(leader).some(step => (step?.delay ?? 0) > 0); }
  split(leader: string, members: readonly string[]) {
    this.store.db.transaction(() => {
      const backoff = this.get(leader);
      if (!backoff) return;
      for (const member of members) {
        const prior = this.get(member);
        // The split owns independent leases. Reads started under the old seal cannot settle them.
        this.store.set(`replay-probe-backoff:${member}`, {
          delay: Math.max(backoff.delay, prior?.delay ?? 0),
          nextAt: Math.max(backoff.nextAt, prior?.nextAt ?? 0),
          aliases: [...new Set([...backoff.aliases ?? [], ...prior?.aliases ?? []])],
          token: randomUUID(),
        } satisfies Backoff);
      }
    }).immediate();
  }
  reserve(leader: string, alias?: string) {
    const prior = this.get(leader);
    // Batches can change leader. Retain shared prompt aliases so a later failed read fences every owner.
    const aliases = [...new Set([...prior?.aliases ?? [], ...alias ? [alias] : []])];
    // A crash during a read leaves uncertainty too. Reserve before starting I/O.
    const lease = { delay: prior?.delay ?? 0, nextAt: Date.now() + 60_000, aliases, token: randomUUID() };
    this.store.set(`replay-probe-backoff:${leader}`, lease);
    return lease;
  }
  failed(leader: string) {
    const delay = Math.min((this.get(leader)?.delay || 30_000) * 2, 600_000);
    const backoff = { ...this.get(leader), delay, nextAt: Date.now() + delay };
    this.store.set(`replay-probe-backoff:${leader}`, backoff);
    return backoff;
  }
  // A negative id does not settle its leader's other attempts; only admission resets failure history.
  release(leader: string) {
    this.store.set(`replay-probe-backoff:${leader}`, { ...this.get(leader), delay: this.get(leader)?.delay ?? 0, nextAt: 0 });
  }
  clear(leader: string) { this.store.set(`replay-probe-backoff:${leader}`, null); }
}
