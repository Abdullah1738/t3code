// card-check reply: is this chat reply structured data that has to go out as a card?
// Owner rule (23 Oct): "Any structured data should come as images always!" Door codes,
// Wi-Fi, flight details, addresses with times, field lists and tables go as a designed card
// plus a one-line takeaway; one or two plain facts stay text. Flight, stay and transfer
// items for a trip both of them take go to the owner+Moni group, not a 1:1 chat.

export const GROUP = "group-sb_gro";
const ONE_TO_ONE = new Set(["abdullah", "owner", "moni"]);

const CODE = /\b(door|gate|entry|entrance|access|building|lobby|lock|key ?box|lockbox|garage|alarm|pin)\s*(code|pin|password|no\.?|number)?\s*(is|[:#=-])?\s*\d{3,8}\b|\b(code|pin)\s*(is|[:#=-])\s*\d{3,8}\b/i;
const WIFI = /\b(wi-?fi|ssid)\b/i;
// A credential, not Wi-Fi talk: "password sunset26", "Wi-Fi: Lake_5G", "Wi-Fi TWGast / 1234".
const WIFI_DETAIL = /\b(pass(word)?|pw|pwd|wpa key)\b\s*(is|[:=-])?\s*\S{4,}|\b(wi-?fi|ssid)\b\s*(name\s*)?(is\s*|[:=-]\s*)[\w.@-]{3,}|\b(wi-?fi|ssid)\b\s*[\w.@-]{3,}\s*\/\s*\S{4,}/i;
const FLIGHT_NO = /\b(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{2,4}[A-Z]?\b/;
const FLIGHT_WORD = /\b(flight|gate|seat|terminal|boarding|board(s|ing)? at|departs?|departure|arrives?|arrival|lands?|landing|baggage|belt|check-?in counter)\b/gi;
const FLIGHT_FIELD = [/\bgate\s*[A-Z]?\d{1,3}\b/i, /\bseat\s*\d{1,2}[A-K]\b/i, /\bterminal\s*\d\b/i, /\bT\d\b/, /\b(boarding|board(s)?|departs?|departure|lands?|arrives?)\b[^.\n]{0,20}\d{1,2}[:.]\d{2}/i, /\bbelt\s*\d+\b/i];
// A street address: a unit or street word with its number ("Villa 12", "Flat 2104", "4 Al Wasl Road").
const ADDRESS = /\b(flat|apt|apartment|villa|unit|suite|floor|building|bldg|street|st|road|rd|avenue|ave|plot|makani|p\.?\s?o\.?\s?box)\.?\s*(no\.?\s*)?\d+[a-z]?\b|\b\d+[a-z]?,?\s+(?:[A-Z][\w'-]*\s+){1,3}(street|st|road|rd|avenue|ave|boulevard|blvd|lane|strasse|straße)\b/i;
const TIME = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(am|pm)\b/i;
const PHONE = /(\+\d[\d\s-]{7,}\d)|\b0\d{1,2}[\s-]?\d{3}[\s-]?\d{4}\b/;
const FIELD_LINE = /^\s*(?:[-*•]\s*)?[A-Za-z][\w ./&'()-]{0,28}:\s*\S/;
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/;
const BULLET_MARK = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
const SHORT_ITEM = 50;
const TABLE = /^\s*\|.*\|\s*$/;
const TRIP = /\b(flight|boarding|gate|terminal|check-?in|check-?out|hotel|stay|airbnb|villa|lodge|resort|transfer|pickup|pick-up|itinerary|trip|booking|reservation)\b/i;

const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
const hit = (re, text) => {
  const m = text.match(re);
  return m ? clip(m[0].trim()) : null;
};

/** Findings for one reply: FAIL structured (send a card), WARN group/address. */
export function checkReply(text, { chat = null } = {}) {
  const findings = [];
  const body = String(text ?? "");
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  const fail = (rule, detail, sample) => findings.push({ level: "FAIL", rule, detail, ...(sample ? { text: sample } : {}) });
  const warn = (rule, detail, sample) => findings.push({ level: "WARN", rule, detail, ...(sample ? { text: sample } : {}) });

  const code = hit(CODE, body);
  if (code) fail("structured", "door/access code: send it on a card with the value big", code);
  if (WIFI.test(body) && WIFI_DETAIL.test(body)) fail("structured", "Wi-Fi details: send them on a card", hit(WIFI, body));

  const flightFields = FLIGHT_FIELD.filter((re) => re.test(body)).length;
  const flightNo = FLIGHT_NO.test(body) && (body.match(FLIGHT_WORD) || []).length > 0;
  if (flightFields + (flightNo ? 1 : 0) >= 2) fail("structured", "flight details (flight, gate, seat, times): send a boarding-pass card", hit(FLIGHT_NO, body) || hit(FLIGHT_FIELD.find((re) => re.test(body)), body));

  const address = ADDRESS.test(body);
  const extras = [TIME, PHONE, CODE].filter((re) => re.test(body)).length;
  if (address && extras) fail("structured", "an address with times, phone or codes: send a card", hit(ADDRESS, body));
  else if (address) warn("address", "a lone address can stay text; with anything else alongside it, send a card", hit(ADDRESS, body));

  // "Check-in: Fri 3pm" is a field; "- Flight: its ETA moved around a lot, then ..." is a sentence.
  const fields = lines.filter((l) => FIELD_LINE.test(l) && l.trim().length <= 80 && !/^\s*https?:/i.test(l));
  if (fields.length >= 3) fail("structured", `${fields.length} label: value lines: send a card`, clip(fields[0].trim()));
  // A list of short facts (items, times, names) is a card; a catch-up in sentences stays text.
  const bullets = lines.filter((l) => BULLET.test(l));
  const short = bullets.filter((l) => l.replace(BULLET_MARK, "").trim().length <= SHORT_ITEM);
  if (bullets.length >= 3 && short.length * 2 > bullets.length) {
    fail("structured", `a ${bullets.length}-item list of short facts: send a card`, clip(bullets[0].trim()));
  }
  if (lines.filter((l) => TABLE.test(l)).length >= 2) fail("structured", "a table: send a card", null);

  if (chat && ONE_TO_ONE.has(chat) && TRIP.test(body)) {
    warn("group", `trip item in a 1:1 chat: if both of them are on this trip, send it to ${GROUP}`, hit(TRIP, body));
  }
  // One finding per rule+detail is enough to act on.
  const seen = new Set();
  return findings.filter((f) => !seen.has(`${f.rule}|${f.detail}`) && seen.add(`${f.rule}|${f.detail}`));
}
