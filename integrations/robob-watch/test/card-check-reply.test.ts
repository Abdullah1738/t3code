import { expect, test } from "bun:test";
import { checkReply } from "../helpers/card-check/reply.mjs";

const fails = (text: string, chat?: string) =>
  checkReply(text, { chat }).filter((f: { level: string }) => f.level === "FAIL");
const rules = (text: string, chat?: string) =>
  checkReply(text, { chat }).map((f: { level: string; rule: string }) => `${f.level}:${f.rule}`);

test("codes, Wi-Fi and flight details have to go out as a card", () => {
  for (const text of [
    "Gate code is 4821, door code 1937. Check-in after 3pm.",
    "Wi-Fi: LakeHouse_5G, password sunset2026",
    "EK57 to Düsseldorf boards at 14:05 from gate B12, seat 17A. Lands 19:10.",
    "Your flight EK 202 departs Terminal 3 at 08:45.",
    // Sent as text on 23 Oct; each should have been a card.
    "EK57 gate change: now leaving from B23 (was B12). Still on time for 14:25, landing Düsseldorf 19:15 at gate C37.",
    "Door code 3189 (keypad by the gate). Wi-Fi TWGast / 123456789.",
    "Eaten: 905 kcal, 50g protein\nTarget: 1,900 kcal, 180g protein\nLeft: 995 kcal, 130g protein",
  ]) {
    expect(fails(text).length, text).toBeGreaterThan(0);
  }
});

test("an address with a time or a phone, field lists and tables are structured too", () => {
  for (const text of [
    "Address: Villa 12, Street 4, Al Barsha 2. Host Omar +971 50 123 4567, arrive by 16:00.",
    "Booking: Lakehouse\nCheck-in: Fri 3pm\nCheck-out: Sun 11am\nHost: Omar",
    "Packing:\n- passports\n- chargers\n- dog food",
    "| item | price |\n|---|---|\n| latte | 18 |",
  ]) {
    expect(fails(text).length, text).toBeGreaterThan(0);
  }
});

test("one or two plain facts stay text", () => {
  for (const text of [
    "On it, back in a minute.",
    "Your noon order is on the way, about 20 min out.",
    "Booked. Imran in a black Lexus, 4 min away.",
    "Approve the ENBD prompt now, AED 133.48 at noon.",
    "Done, I logged 2 eggs and a coffee. 1,240 kcal left today.",
    "Flight's on time.",
    "The noon order NAEIA0069805590 was cancelled; refund in 3-5 days.",
    "Gym at 7? You skipped Thursday.",
    "Booking: done",
    // Seen in real replies: Wi-Fi as a topic, a catch-up in full sentences, a tower name.
    "On mobile data the proxy setting doesn't apply, because iOS only lets you set a proxy per Wi-Fi network.",
    "Quick catch-up from overnight:\n\n- Moni's second tripod from noon Supermall went through as one order and is on its way now.\n- The Lakehouse host replied and says he'll look into the refund this week.\n- Nothing else changed while you slept, the board is the same as yesterday evening.",
    "Your pizza is on the way to HDS Tower, about 10 minutes.",
  ]) {
    expect(checkReply(text), text).toEqual([]);
  }
  expect(rules("It's at Banyan Tree Residences, Flat 2104.")).toEqual(["WARN:address"]);
});

test("a trip item in a 1:1 chat points at the group", () => {
  const text = "EK57 boards at 14:05 from gate B12.";
  expect(rules(text, "moni")).toContain("WARN:group");
  expect(rules(text, "abdullah")).toContain("WARN:group");
  expect(rules(text, "group-sb_gro")).not.toContain("WARN:group");
  expect(rules("Your noon order is on the way.", "moni")).toEqual([]);
});
