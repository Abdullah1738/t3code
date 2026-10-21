/**
 * Read-only data providers a guest grant can switch on. Each one turns a small, fixed slice of
 * the owner's data into prompt text for the tool-less guest model; nothing else of his reaches
 * it. To add one: write a GuestProvider, add it to PROVIDERS, and (if it needs the owner to have
 * said something specific) give it an `ownerWords` pattern the desk checks against his evidence.
 */
import { applecalBusy, DEFAULT_HOURS, fmt, freeWindows, HORIZON_DAYS, type Busy, type FreeWindow, type WorkingHours } from "./guest-calendar.ts";
import { describeFlight, FLIGHT_SPEC, findFlight, flightyDb, flightGrantEnd, flightKey, type FlightRow, type FlightSource } from "./guest-flight.ts";
import type { GuestGrant } from "./guests.ts";

export const PROVIDER_KINDS = ["meeting", "create-hold", "flight-status", "flight-updates"] as const;
export type ProviderKind = typeof PROVIDER_KINDS[number];
export type ProviderSpec = { kind: ProviderKind; arg?: string };

export type ProviderDeps = {
  timezone: string;
  now: () => number;
  busy?: (from: number, to: number) => Promise<Busy[] | "unavailable">;
  hours?: WorkingHours;
  flights?: FlightSource;
};

/** What a provider adds to one model call. `windows` is set by the meeting provider for the book check. */
export type ProviderView = { prompt: string; windows?: FreeWindow[] | "unavailable" };

export type GuestProvider = {
  kind: ProviderKind;
  /** Other providers it needs; the desk adds them. */
  implies?: ProviderKind[];
  /** What the owner must have said (in any evidence message) for this provider to be granted. */
  ownerWords?: RegExp;
  /** Only msgs: evidence is checked against ownerWords; the owner typing to the line is enough. */
  ownerWordsArchiveOnly?: boolean;
  /** Validates and pins the argument at grant time (e.g. resolves "next flight" to EK57@2026-10-23). */
  resolve?: (arg: string | undefined, deps: ProviderDeps) => { arg?: string; expiresAt?: number } | { error: string };
  /** One line for the owner's scope notice. */
  summary: (arg: string | undefined) => string;
  view?: (arg: string | undefined, grant: GuestGrant, deps: ProviderDeps) => Promise<ProviderView>;
};

const FLIGHT_WORDS = /\b(flights?|fly|flying|land(s|ing|ed)?|arriv(e|es|al|ing)|airport|terminal|pick(ing)? (me )?up|pickup|collect)\b/i;
/** Calendar writes need the owner to have said so in calendar words; "book a meeting" alone is not enough. */
export const HOLD_WORDS = /\b(calendar|put (it|that|them) in|(add|block|hold) (it|that|the time|time)|send (an|the) invite)\b/i;

const resolveFlight = (arg: string | undefined, deps: ProviderDeps): { arg?: string; expiresAt?: number } | { error: string } => {
  if (arg !== undefined && !FLIGHT_SPEC.test(arg)) return { error: "Flight like EK57 or EK57@2026-10-23" };
  const source = deps.flights ?? flightyDb();
  const row = findFlight(source, arg, deps.now());
  if (row === "unavailable") return { error: "Flighty can't be read right now" };
  if (!row) return { error: arg ? `No upcoming flight ${arg} in Flighty` : "No upcoming flight in Flighty" };
  return { arg: flightKey(row), expiresAt: flightGrantEnd(row) };
};

const flightRow = (arg: string | undefined, deps: ProviderDeps): FlightRow | undefined | "unavailable" =>
  findFlight(deps.flights ?? flightyDb(), arg, deps.now());

export const PROVIDERS: Record<ProviderKind, GuestProvider> = {
  meeting: {
    kind: "meeting",
    summary: () => "your free/busy times (no titles) to propose a meeting",
    view: async (_arg, _grant, deps) => {
      const now = deps.now();
      const busy = await (deps.busy ?? applecalBusy)(now, now + HORIZON_DAYS * 86_400_000).catch(() => "unavailable" as const);
      const windows = busy === "unavailable" ? "unavailable" : freeWindows(busy, now, deps.timezone, deps.hours ?? DEFAULT_HOURS);
      const prompt = windows === "unavailable" ? "Calendar: it can't be read right now. Don't propose times; say you'll check with Abdullah and use action escalate."
        : windows.length === 0 ? "Calendar: Abdullah has no free time in the next two weeks within working hours. Say you'll check with him and use action escalate."
        : `Calendar: Abdullah's free windows (${deps.timezone}), the only times you may offer:\n${windows.slice(0, 40).map(window => `- ${new Date(window.start).toISOString()} to ${new Date(window.end).toISOString()} (${fmt(window.start, deps.timezone)} to ${fmt(window.end, deps.timezone).split(", ").pop()})`).join("\n")}\nWhen they pick a time that fits inside one free window (at most 2 hours), use action book with that exact slot.`;
      return { prompt, windows };
    },
  },
  "create-hold": {
    kind: "create-hold", implies: ["meeting"], ownerWords: HOLD_WORDS, ownerWordsArchiveOnly: true,
    summary: () => "put a tentative hold on your calendar for a time they pick",
    view: async () => ({ prompt: "A booked slot is held on Abdullah's calendar by the bridge after it checks it." }),
  },
  "flight-status": {
    kind: "flight-status", ownerWords: FLIGHT_WORDS, resolve: resolveFlight,
    summary: arg => `status of your flight ${arg ?? "(next)"} only: times, delay, terminal/gate/belt, landed/cancelled`,
    view: async (arg, _grant, deps) => {
      const row = flightRow(arg, deps);
      if (row === "unavailable") return { prompt: "Flight: the flight data can't be read right now. Say you'll check and use action escalate." };
      if (!row) return { prompt: "Flight: no data for this flight any more. Say you'll check with Abdullah and use action escalate." };
      return { prompt: `Abdullah's flight (the only flight you know about; you may share these details with this person):\n${describeFlight(row, deps.flights?.lastSync?.())}` };
    },
  },
  "flight-updates": {
    kind: "flight-updates", implies: ["flight-status"], ownerWords: FLIGHT_WORDS, resolve: resolveFlight,
    summary: arg => `texts them when flight ${arg ?? "(next)"} is delayed, takes off, lands, or gets a terminal/gate/belt`,
    view: async () => ({ prompt: "The bridge also texts this person automatic updates when the flight changes; you don't need to promise more." }),
  },
};

/** "flight-status:EK57" -> spec; legacy --action names map straight onto providers. */
export function parseProviderSpec(value: string): ProviderSpec | undefined {
  const [kind, arg, extra] = value.trim().split(":");
  if (extra !== undefined || !(PROVIDER_KINDS as readonly string[]).includes(kind!)) return undefined;
  return { kind: kind as ProviderKind, ...(arg ? { arg } : {}) };
}

export const specText = (spec: ProviderSpec) => spec.arg ? `${spec.kind}:${spec.arg}` : spec.kind;
