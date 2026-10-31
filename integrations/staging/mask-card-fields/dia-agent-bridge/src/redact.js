// Masks card numbers, CVC/CVV and expiry before tool output reaches an agent.
// Mirrors android-phone/scripts/ph.py redact()/node_texts(): keep the two rule sets in step.

const CARD_RUN = /(?<!\d)\d(?:[ -]*\d){12,18}(?!\d)/g;
const CVC_LABEL = /(\b(?:cvc|cvv|csc|cvn|security\s*code)\b)(\D{0,12}?)(\d{3,4})(?!\d)/gi;
const EXP_LABEL = /(\b(?:exp|expiry|expires?|expiration|valid\s*thru|valid\s*through|mm\s*\/\s*yy(?:yy)?)\b)(\D{0,12}?)(\d{1,2}\s*[\/-]\s*(?:\d{4}|\d{2}))(?!\d)/gi;
const SECRET_KEY = /cvc|cvv|csc|securitycode|card.?number|cardnumber|cc-?number|cc-?csc|cc-?exp|expiry|expiration/i;
const SENSITIVE_FIELD = /(?<![a-z])(cvc|cvv|csc|cvn|security[\s_-]*code|card[\s_-]*number|cardnumber|cc[-_]?number|cc[-_]?csc|cc[-_]?exp|expir\w*|valid[\s_-]*thru|exp)(?![a-z])/i;
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

// A sensitive field's value. CDP RemoteObjects nest it as {type, value, description, unserializableValue}.
const REMOTE_VALUE_KEYS = ["value", "description", "unserializableValue"];
function maskSecret(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const out = { ...item };
    for (const k of REMOTE_VALUE_KEYS) if (k in out && out[k] !== undefined && out[k] !== null) out[k] = "[redacted]";
    return out;
  }
  return "[redacted]";
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
      if (SECRET_KEY.test(key) && item !== null && typeof item !== "object") out[key] = "[redacted]";
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
