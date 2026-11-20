import type { PollRecord, Store } from "./store.ts";

/**
 * A retried poll send can come back from Photon as a duplicate with no poll
 * GUID. The poll still exists on the phone, and Photon replays its creation as
 * our own `poll.changed` event. Pairing the two by their exact option texts
 * registers the poll after all, so votes on it keep counting.
 */
type Unmatched = Omit<PollRecord, "options"> & { choices: string[] };
type Seen = { options: PollRecord["options"]; at: number };

const WINDOW = 10 * 60_000;
const key = (options: readonly string[]) => JSON.stringify(options.map(option => option.trim()).sort());

function entries<T>(store: Store, prefix: string): { key: string; value: T }[] {
  return (store.db.query("SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY rowid")
    .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`) as { key: string; value: string }[])
    .map(row => ({ key: row.key, value: JSON.parse(row.value) as T }));
}

function drop(store: Store, name: string): void {
  store.db.query("DELETE FROM kv WHERE key = ?").run(name);
}

function prune(store: Store, now: number): void {
  for (const row of entries<Unmatched>(store, "poll-unmatched:")) if (now - row.value.createdAt > WINDOW) drop(store, row.key);
  for (const row of entries<Seen>(store, "poll-seen:")) if (now - row.value.at > WINDOW) drop(store, row.key);
}

function register(store: Store, guid: string, seen: Seen, unmatched: Unmatched): void {
  if (store.get(`poll:${guid}`)) return;
  const { choices: _, ...record } = unmatched;
  store.set(`poll:${guid}`, { ...record, options: seen.options } satisfies PollRecord);
}

/** Delivery got a duplicate without a GUID. Call inside the delivery transaction. */
export function rememberUnmatchedPoll(store: Store, unmatched: Unmatched, now = Date.now()): void {
  prune(store, now);
  const wanted = key(unmatched.choices);
  const candidates = entries<Seen>(store, "poll-seen:").filter(row => {
    // A normally registered poll may leave a seen row behind; it is not a candidate.
    if (store.get(`poll:${row.key.slice("poll-seen:".length)}`)) { drop(store, row.key); return false; }
    return key(row.value.options.map(option => option.text)) === wanted;
  });
  // Two same-option polls in flight cannot be told apart; typed answers still work.
  const seen = candidates.length === 1 ? candidates[0] : undefined;
  if (seen) {
    register(store, seen.key.slice("poll-seen:".length), seen.value, unmatched);
    drop(store, seen.key);
    return;
  }
  store.set(`poll-unmatched:${unmatched.operationId}`, unmatched);
}

/** Ingress saw one of our own polls created. Call inside the ingress transaction. */
export function seenOwnPoll(store: Store, guid: string, options: readonly { optionIdentifier: string; text: string }[], now = Date.now()): void {
  if (store.get(`poll:${guid}`) || !options.length) return;
  prune(store, now);
  const wanted = key(options.map(option => option.text));
  const candidates = entries<Unmatched>(store, "poll-unmatched:").filter(row => key(row.value.choices) === wanted);
  const unmatched = candidates.length === 1 ? candidates[0] : undefined;
  const seen = { options: options.map(({ optionIdentifier, text }) => ({ optionIdentifier, text })), at: now };
  if (unmatched) {
    register(store, guid, seen, unmatched.value);
    drop(store, unmatched.key);
    return;
  }
  store.set(`poll-seen:${guid}`, seen);
}
