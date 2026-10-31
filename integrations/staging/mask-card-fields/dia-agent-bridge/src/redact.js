// Masks card numbers, CVC/CVV and expiry before tool output reaches an agent.
// Mirrors android-phone/scripts/ph.py redact(): keep the two rule sets in step.

const CARD_RUN = /(?<!\d)\d(?:[ -]*\d){12,18}(?!\d)/g;
// Between a label and its value: up to three words, each side padded by up to six punctuation or
// whitespace characters (':', '=', '-', quotes, brackets, commas, newlines). Covers 'CVC for card is 123',
// JSON '"cvc":"123"' and 'CVV (123)'. Bounded, so unrelated text after the label is not reached.
const GAP = String.raw`((?:[\s:=\-"'(\[{,]{0,6}(?:[A-Za-z]{1,20}[\s:=\-"'(\[{,]{0,6}){0,3}))`;
const CVC_LABEL = new RegExp(String.raw`(\b(?:cvc|cvv|csc|cvn|security\s*code)\b)` + GAP + String.raw`(\d{3,4})(?!\d)`, "gi");
const EXP_LABEL = new RegExp(String.raw`(\b(?:exp|expiry|expires?|expiration|valid\s*thru|valid\s*through|mm\s*\/\s*yy(?:yy)?)\b)` + GAP + String.raw`(\d{1,2}\s*[\/-]\s*(?:\d{4}|\d{2}))(?!\d)`, "gi");
const SECRET_KEY = /cvc|cvv|ccv|cvn|csc|security.?code|card.?number|cc[-_]?number|cc[-_]?csc|cc[-_]?exp|exp[-_]?(?:date|month|year)|expiry|expiration/i;
// Keys like "exp" or "expires" also hold cookie and token timestamps, so mask them only when the value looks like a card expiry.
const EXP_KEY = /^exp/i;
const EXP_VALUE = /^\s*\d{1,2}\s*[\/-]\s*(?:\d{4}|\d{2})\s*$/;
const SENSITIVE_FIELD = /(?<![a-z])(cvc|cvv|csc|cvn|security[\s_-]*code|card[\s_-]*number|cardnumber|cc[-_]?number|cc[-_]?csc|cc[-_]?exp|expir\w*|valid[\s_-]*thru|exp|mm\s*\/\s*yy(?:yy)?)(?![a-z])/i;
// Attribute names whose values describe a field (CDP attribute lists and field descriptor objects).
const FIELD_ATTRS = new Set(["name", "id", "autocomplete", "placeholder", "aria-label", "label", "title"]);

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(CARD_RUN, (match) => {
      const digits = match.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? `•••• ${digits.slice(-4)}` : match;
    })
    .replace(CVC_LABEL, (_, label, gap) => `${label}${gap}•••`)
    .replace(EXP_LABEL, (_, label, gap) => `${label}${gap}••/••`);
}

function isSensitiveField(values) {
  return values.some(v => typeof v === "string" && SENSITIVE_FIELD.test(v));
}

// Everything under a sensitive value is secret, including CDP previews that nest the real value
// (preview.properties[].value). Only RemoteObject type names survive.
const SAFE_TYPE_KEYS = new Set(["type", "subtype"]);
const SAFE_TYPE_VALUE = /^[A-Za-z]{1,20}$/;
function maskSecret(item) {
  if (Array.isArray(item)) return item.map(maskSecret);
  if (item && typeof item === "object") {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
      out[k] = SAFE_TYPE_KEYS.has(k) && typeof v === "string" && SAFE_TYPE_VALUE.test(v) ? v : maskSecret(v);
    }
    return out;
  }
  return item === null || item === undefined ? item : "[redacted]";
}

function redactArray(arr) {
  const isPairs = arr.length >= 2 && arr.length % 2 === 0 && arr.every(x => typeof x === "string");
  if (!isPairs) return arr.map(redactValue);
  const sensitive = isSensitiveField(arr.filter((_, i) => i % 2 === 1 && FIELD_ATTRS.has(arr[i - 1])));
  return arr.map((item, i) => (sensitive && i % 2 === 1 && arr[i - 1] === "value" ? maskSecret(item) : redactValue(item)));
}

export function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return redactArray(value);
  if (value && typeof value === "object") {
    const sensitive = isSensitiveField(Object.entries(value).filter(([k]) => FIELD_ATTRS.has(k)).map(([, v]) => v));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) out[key] = maskSecret(item);
      else if (EXP_KEY.test(key) && typeof item === "string" && EXP_VALUE.test(item)) out[key] = "[redacted]";
      else if (sensitive && key === "value") out[key] = maskSecret(item);
      else out[key] = redactValue(item);
    }
    return out;
  }
  return value;
}

export function safeErrorMessage(error) {
  return redactText(error?.message || String(error));
}
