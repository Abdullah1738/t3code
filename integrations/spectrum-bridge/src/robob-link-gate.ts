/** A gate refusal is uncertainty, never evidence that a prompt is absent. */
export class RobobLinkDown extends Error {
  constructor(readonly firstAtSite: (site: string) => boolean) {
    super("Robob link is down");
    this.name = "RobobLinkDown";
  }
}

export type LinkGateClock = {
  schedule: (action: () => Promise<void>, delay: number) => { unref?: () => void };
  random: () => number;
};

export class RobobLinkGate {
  private failures = 0;
  private delay = 1_000;
  private probing = false;
  private down = false;
  private probe?: () => Promise<unknown>;
  constructor(private readonly hooks: {
    skip: (site: string) => void;
    firstAtSite: (site: string) => boolean;
    persistedDown: () => boolean;
  }, private readonly clock: LinkGateClock = { schedule: (fn, ms) => setTimeout(fn, ms), random: Math.random }) {}

  get available(): boolean { return !this.down; }

  guard(site: string): void {
    if (!this.down) return;
    this.hooks.skip(site);
    throw new RobobLinkDown(this.hooks.firstAtSite);
  }

  outcome(ok: boolean, linkFailure: boolean, probe: () => Promise<unknown>, isProbe: boolean): void {
    // A request already in flight when the gate closed cannot recover it.
    if (ok && (!this.down || isProbe)) {
      this.down = false; this.failures = 0; this.delay = 1_000;
    } else if (linkFailure && !this.down) {
      if (++this.failures >= 3 || this.hooks.persistedDown()) {
        this.down = true;
        this.probe = probe;
        this.schedule();
      }
    } else if (!this.down) this.failures = 0;
  }

  private schedule(): void {
    // The capped step also stays inside the hard 30 s ceiling.
    const wait = Math.round(Math.min(30_000, this.delay * (0.8 + this.clock.random() * 0.4)));
    this.clock.schedule(() => this.runProbe(), wait).unref?.();
  }

  private async runProbe(): Promise<void> {
    if (!this.down || this.probing) return;
    this.probing = true;
    try { await this.probe!(); }
    catch { /* The request layer records the failed probe once. */ }
    finally {
      this.probing = false;
      if (this.down) { this.delay = Math.min(30_000, this.delay * 2); this.schedule(); }
    }
  }
}
