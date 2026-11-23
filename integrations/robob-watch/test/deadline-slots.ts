import { CheckSlots, type SlotRequest } from "../src/host.ts";

/** Replay-only option 2 experiment; keep production's admissions, overflow and borrowing unchanged. */
export class DeadlineSlots extends CheckSlots {
  override drain(): void {
    // Reorder only private slow waiter positions, avoiding a second implementation of slot accounting.
    const { waiters } = this as unknown as { waiters: { lane: string; at: number; request: SlotRequest }[] };
    const slow = waiters.filter(waiter => waiter.lane === "slow");
    const deadline = (waiter: typeof slow[number]) => Math.min(
      (waiter.request.dueAt ?? waiter.at) + (waiter.request.intervalMs ?? 900_000),
      waiter.at + 900_000,
    );
    slow.sort((a, b) => deadline(a) - deadline(b));
    let index = 0;
    for (let i = 0; i < waiters.length; i++) if (waiters[i]!.lane === "slow") waiters[i] = slow[index++]!;
    super.drain();
  }
}
