import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue } from "../src/redact.js";

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
