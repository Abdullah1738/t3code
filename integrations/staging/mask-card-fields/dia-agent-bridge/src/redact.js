// Masks card numbers, CVC/CVV and expiry before tool output reaches an agent.
// Mirrors android-phone/scripts/ph.py redact(): keep the two rule sets in step.

const CARD_RUN = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const CVC_LABEL = /(\b(?:cvc|cvv|csc|cvn|security\s*code)\b)([^\d\n]{0,12}?)(\d{3,4})(?!\d)/gi;
const EXP_LABEL = /(\b(?:exp|expiry|expires?|expiration|valid\s*thru|valid\s*through|mm\s*\/\s*yy(?:yy)?)\b)([^\d\n]{0,12}?)(\d{1,2}\s*[\/-]\s*(?:\d{4}|\d{2}))(?!\d)/gi;
const SECRET_KEY = /cvc|cvv|csc|securitycode|card.?number|cardnumber|cc-?number|cc-?csc|cc-?exp|expiry|expiration/i;

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

export function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) && item !== null && typeof item !== "object" ? "[redacted]" : redactValue(item);
    }
    return out;
  }
  return value;
}
