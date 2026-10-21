/**
 * One of the owner's flights, read-only from the Flighty DB, cut down to what someone meeting him
 * needs: number, airports, times, delay, terminal/gate/belt and status. Seats, PNRs, other
 * flights, companions and anything else in Flighty never leave this file.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FLIGHTY_DB = join(homedir(), "Library/Containers/com.flightyapp.flighty/Data/Documents/MainFlightyDatabase.db");
/** Abdullah's Flighty user id (flighty skill). */
export const FLIGHTY_OWNER = "e7e365be-bff7-4b60-81ce-a048008855eb";

/** Exactly the columns we read; nothing else is selected from the DB. */
export type FlightRow = {
  airline: string | null; number: string;
  depIata: string; depCity: string | null; depTz: string;
  arrIata: string; arrCity: string | null; arrTz: string;
  schedArrIata: string; schedArrCity: string | null;
  depTerminal: string | null; depGate: string | null;
  arrTerminal: string | null; arrGate: string | null; belt: string | null;
  depSched: number | null; depEst: number | null; depActual: number | null; depRunway: number | null;
  arrSched: number | null; arrEst: number | null; arrActual: number | null; arrRunway: number | null;
  lastDep: number; lastArr: number;
  cancelled: number | null; boarding: string | null;
};

export type FlightSource = {
  /** Owner's own flights arriving at or after `since` (unix seconds), earliest departure first. */
  flights(since: number): FlightRow[] | "unavailable";
  /** Unix seconds of Flighty's last sync, if known. */
  lastSync?(): number | undefined;
};

const SQL = `
SELECT al.iata airline, f.number number,
  d.iata depIata, d.city depCity, d.timeZoneIdentifier depTz,
  a.iata arrIata, a.city arrCity, a.timeZoneIdentifier arrTz,
  s.iata schedArrIata, s.city schedArrCity,
  f.departureTerminal depTerminal, f.departureGate depGate,
  f.arrivalTerminal arrTerminal, f.arrivalGate arrGate, f.arrivalBaggageBelt belt,
  f.departureScheduleGateOriginal depSched, f.departureScheduleGateEstimated depEst,
  f.departureScheduleGateActual depActual, f.departureScheduleRunwayActual depRunway,
  f.arrivalScheduleGateOriginal arrSched, f.arrivalScheduleGateEstimated arrEst,
  f.arrivalScheduleGateActual arrActual, f.arrivalScheduleRunwayActual arrRunway,
  f.lastKnownDepartureDate lastDep, f.lastKnownArrivalDate lastArr,
  f.isCancelled cancelled, f.departureBoardingStatus boarding
FROM UserFlight uf
JOIN Flight f ON f.id = uf.flightId
JOIN Airport d ON d.id = f.departureAirportId
JOIN Airport a ON a.id = f.actualArrivalAirportId
JOIN Airport s ON s.id = f.scheduledArrivalAirportId
LEFT JOIN Airline al ON al.id = f.airlineId
WHERE uf.deleted IS NULL AND f.deleted IS NULL AND uf.isMyFlight = 1 AND uf.userId = ? AND f.lastKnownArrivalDate >= ?
ORDER BY f.lastKnownDepartureDate`;

export function flightyDb(path = FLIGHTY_DB, user = FLIGHTY_OWNER): FlightSource {
  const read = <T>(work: (db: Database) => T): T | "unavailable" => {
    if (!existsSync(path)) return "unavailable";
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });
      db.exec("PRAGMA busy_timeout = 3000");
      return work(db);
    } catch { return "unavailable"; } finally { db?.close(); }
  };
  return {
    flights: since => read(db => db.query<FlightRow, [string, number]>(SQL).all(user, since)),
    lastSync: () => {
      const value = read(db => db.query<{ t: number | null }, []>("SELECT max(lastSync) t FROM SyncInfo").get()?.t ?? undefined);
      return value === "unavailable" ? undefined : value;
    },
  };
}

export const flightCode = (row: Pick<FlightRow, "airline" | "number">) => `${row.airline ?? ""}${row.number}`.toUpperCase();

function localDate(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000));
}

/** "EK57@2026-10-23": the flight code and its local departure date. */
export const flightKey = (row: FlightRow) => `${flightCode(row)}@${localDate(row.depSched ?? row.lastDep, row.depTz)}`;

/** "EK57" or "EK57@2026-10-23" -> the matching flight; no spec -> the owner's next flight. */
export function findFlight(source: FlightSource, spec: string | undefined, nowMs: number): FlightRow | undefined | "unavailable" {
  const rows = source.flights(Math.floor(nowMs / 1000) - 6 * 3600);
  if (rows === "unavailable") return rows;
  if (!spec) return rows[0];
  const [code, date] = spec.toUpperCase().split("@");
  return rows.find(row => flightCode(row) === code && (!date || flightKey(row).endsWith(`@${date}`)));
}

export const FLIGHT_SPEC = /^[A-Z0-9]{2}\d{1,4}(?:@\d{4}-\d{2}-\d{2})?$/i;

export type FlightStatus = "scheduled" | "boarding" | "gate closed" | "pushed back" | "in the air" | "landed" | "at the gate" | "cancelled";

export type FlightSnapshot = {
  key: string; status: FlightStatus; diverted?: string;
  depEst: number | null; arrEst: number | null;
  arrTerminal: string; arrGate: string; belt: string; depTerminal: string; depGate: string;
};

export function flightStatus(row: FlightRow): FlightStatus {
  if (row.cancelled) return "cancelled";
  if (row.arrActual) return "at the gate";
  if (row.arrRunway) return "landed";
  if (row.depRunway) return "in the air";
  if (row.depActual) return "pushed back";
  if (row.boarding === "gateClosed") return "gate closed";
  if (row.boarding === "boarding" || row.boarding === "finalCall") return "boarding";
  return "scheduled";
}

export function snapshot(row: FlightRow): FlightSnapshot {
  return {
    key: flightKey(row), status: flightStatus(row),
    ...(row.schedArrIata !== row.arrIata ? { diverted: `${row.arrCity ?? row.arrIata} (${row.arrIata})` } : {}),
    depEst: row.depActual ?? row.depEst ?? row.lastDep, arrEst: row.arrActual ?? row.arrEst ?? row.lastArr,
    arrTerminal: row.arrTerminal ?? "", arrGate: row.arrGate ?? "", belt: row.belt ?? "",
    depTerminal: row.depTerminal ?? "", depGate: row.depGate ?? "",
  };
}

const clock = (ts: number | null, tz: string) => ts ? new Date(ts * 1000).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "unknown";
const late = (est: number | null, sched: number | null) => {
  if (!est || !sched) return "";
  const minutes = Math.round((est - sched) / 60);
  return minutes >= 5 ? `, ${minutes} min late` : minutes <= -5 ? `, ${-minutes} min early` : ", on time";
};
const where = (...parts: [string, string | null][]) => parts.filter(([, value]) => value).map(([label, value]) => `${label} ${value}`).join(", ");

/** The only flight text the guest model ever sees. */
export function describeFlight(row: FlightRow, lastSync?: number): string {
  const snap = snapshot(row);
  const dep = where(["terminal", row.depTerminal], ["gate", row.depGate]);
  const arr = where(["terminal", row.arrTerminal], ["gate", row.arrGate], ["baggage belt", row.belt]);
  return [
    `Flight ${flightCode(row)}, ${row.depCity ?? row.depIata} (${row.depIata}) to ${row.schedArrCity ?? row.schedArrIata} (${row.schedArrIata}).`,
    `Status: ${snap.status}${snap.diverted ? `, DIVERTED to ${snap.diverted}` : ""}.`,
    `Departure (${row.depIata} local time): scheduled ${clock(row.depSched ?? row.lastDep, row.depTz)}; ${row.depActual ? "left the gate" : "expected"} ${clock(snap.depEst, row.depTz)}${late(snap.depEst, row.depSched)}.${dep ? ` ${dep}.` : ""}`,
    `Arrival (${row.arrIata} local time): scheduled ${clock(row.arrSched ?? row.lastArr, row.arrTz)}; ${row.arrActual ? "arrived at the gate" : row.arrRunway ? "landed" : "expected"} ${clock(snap.arrEst, row.arrTz)}${late(snap.arrEst, row.arrSched)}.${arr ? ` ${arr}.` : ""}`,
    ...(lastSync ? [`Flight data last updated ${Math.max(0, Math.round((Date.now() / 1000 - lastSync) / 60))} min ago.`] : []),
  ].join("\n");
}

const MOVE_MIN = 10;

/** Plain update lines for a proactive guest notice; empty when nothing a pickup cares about changed. */
export function flightChanges(old: FlightSnapshot, now: FlightSnapshot, row: FlightRow): string[] {
  const out: string[] = [];
  if (now.status !== old.status && !["boarding", "gate closed", "pushed back", "scheduled"].includes(now.status)) {
    out.push(now.status === "in the air" ? `took off, expected at ${clock(now.arrEst, row.arrTz)} local`
      : now.status === "landed" ? `landed at ${clock(now.arrEst, row.arrTz)} local`
      : now.status === "at the gate" ? "is at the arrival gate"
      : "has been CANCELLED");
  }
  if (now.diverted && now.diverted !== old.diverted) out.push(`has been DIVERTED to ${now.diverted}`);
  if (now.status !== "cancelled" && !["landed", "at the gate"].includes(now.status) && now.arrEst && old.arrEst && Math.abs(now.arrEst - old.arrEst) >= MOVE_MIN * 60) {
    out.push(`now expected at ${clock(now.arrEst, row.arrTz)} local${late(now.arrEst, row.arrSched)}`);
  }
  if (now.arrTerminal && now.arrTerminal !== old.arrTerminal) out.push(`arrives at terminal ${now.arrTerminal}`);
  if (now.arrGate && now.arrGate !== old.arrGate) out.push(`arrival gate ${now.arrGate}`);
  if (now.belt && now.belt !== old.belt) out.push(`baggage belt ${now.belt}`);
  return out;
}

/** Arrival + 6 h, the default end of a flight grant (ms). */
export const flightGrantEnd = (row: FlightRow) => ((row.arrActual ?? row.arrEst ?? row.lastArr) + 6 * 3600) * 1000;
