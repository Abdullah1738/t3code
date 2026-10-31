import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue, safeErrorMessage } from "../src/redact.js";

test("Luhn-valid card number is masked to its last four digits", () => {
  assert.equal(redactText("card 4111 1111 1111 1111 saved"), "card •••• 1111 saved");
  assert.equal(redactText("4111-1111-1111-1111"), "•••• 1111");
  assert.equal(redactText("4111111111111111"), "•••• 1111");
});

test("16-digit non-Luhn order id is left untouched", () => {
  assert.equal(redactText("Order 1234 5678 9012 3456 placed"), "Order 1234 5678 9012 3456 placed");
});

test("CVC/CVV labels keep the label and mask the digits", () => {
  assert.equal(redactText("cvc=123"), "cvc=•••");
  assert.equal(redactText("CVV: 1234"), "CVV: •••");
});

test("object keys with card fields are redacted", () => {
  assert.deepEqual(
    redactValue({ cardNumber: "4111111111111111", cvc: "123", name: "Abdullah" }),
    { cardNumber: "[redacted]", cvc: "[redacted]", name: "Abdullah" },
  );
});

test("page text with security code and expiry is masked", () => {
  assert.equal(redactText("Security code 123 Expires 12/29"), "Security code ••• Expires ••/••");
});

test("nested arrays and objects are walked", () => {
  const value = { items: [{ text: "cvv: 987" }, { inner: [{ cardNumber: "4111111111111111" }] }] };
  assert.deepEqual(redactValue(value), {
    items: [{ text: "cvv: •••" }, { inner: [{ cardNumber: "[redacted]" }] }],
  });
});

test("repeated spaces or dashes still form a card number", () => {
  assert.equal(redactText("4111  1111  1111  1111"), "•••• 1111");
  assert.equal(redactText("4111--1111 1111-1111"), "•••• 1111");
});

test("labels split from their value by a newline are masked", () => {
  assert.equal(redactText("Security code\n123"), "Security code\n•••");
  assert.equal(redactText("Expiry\n12/29"), "Expiry\n••/••");
});

test("CDP attribute pairs for a sensitive field redact its value", () => {
  assert.deepEqual(redactValue({ attributes: ["name", "cvc", "value", "123"] }).attributes, ["name", "cvc", "value", "[redacted]"]);
  assert.deepEqual(redactValue(["autocomplete", "cc-exp", "value", "12/29"]), ["autocomplete", "cc-exp", "value", "[redacted]"]);
  assert.deepEqual(redactValue(["name", "email", "value", "a@b.co"]), ["name", "email", "value", "a@b.co"]);
});

test("field descriptor objects with a sensitive name redact their value", () => {
  assert.deepEqual(redactValue({ name: "cvc", value: "123" }), { name: "cvc", value: "[redacted]" });
});

test("error text from a failed tool call is redacted", () => {
  assert.equal(
    safeErrorMessage(new Error("Security code 123 Expires 12/29; card 4111 1111 1111 1111")),
    "Security code ••• Expires ••/••; card •••• 1111",
  );
});

test("CDP RemoteObject descriptors redact nested values for cvc and expiry", () => {
  assert.deepEqual(
    redactValue({ name: "cvc", value: { type: "string", value: "123" } }),
    { name: "cvc", value: { type: "string", value: "[redacted]" } },
  );
  assert.deepEqual(
    redactValue({ name: "expiry", value: { type: "string", value: "12/29" } }),
    { name: "expiry", value: { type: "string", value: "[redacted]" } },
  );
  assert.deepEqual(
    redactValue([{ name: "cvc", value: { type: "string", value: "123" } }, { name: "email", value: { type: "string", value: "a@b.co" } }]),
    [{ name: "cvc", value: { type: "string", value: "[redacted]" } }, { name: "email", value: { type: "string", value: "a@b.co" } }],
  );
});

test("MM/YY and MM/YYYY format labels mark an expiry value", () => {
  assert.deepEqual(redactValue({ placeholder: "MM/YY", value: "12/29" }), { placeholder: "MM/YY", value: "[redacted]" });
  assert.deepEqual(
    redactValue(["placeholder", "MM/YYYY", "value", "12/2029"]),
    ["placeholder", "MM/YYYY", "value", "[redacted]"],
  );
});

test("nested CDP preview values under a sensitive wrapper are fully masked", () => {
  const value = {
    name: "cvc",
    value: { type: "object", subtype: "node", preview: { type: "object", properties: [{ name: "cardNumber", type: "string", value: "4111111111111111" }, { name: "cvc", type: "string", value: "123" }] } },
  };
  const out = JSON.stringify(redactValue(value));
  assert.ok(!out.includes("4111111111111111"));
  assert.ok(!out.includes('"123"'));
  assert.ok(out.includes('"type":"object"'));
});

test("CVC label up to three words before the value is masked", () => {
  assert.equal(redactText("CVC for card is 123"), "CVC for card is •••");
  assert.equal(redactText("CVC for card is one two three 123"), "CVC for card is one two three 123");
});

test("JSON-stringified CVC and expiry fields are masked", () => {
  assert.equal(
    redactText(JSON.stringify({ cvc: "123", expiry: "12/29" })),
    '{"cvc":"•••","expiry":"••/••"}',
  );
});

test("parenthesised CVC and expiry values are masked", () => {
  assert.equal(redactText("CVV (123)"), "CVV (•••)");
  assert.equal(redactText("Expiry (12/29)"), "Expiry (••/••)");
});
