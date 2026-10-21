import { expect, test } from "bun:test";
import { cardSafeText } from "../src/card-text.ts";
import { cardAppConfig, SPECTRUM_CARD_APP } from "../src/config.ts";

test("cardSafeText removes times, dates and day words with their connectors", () => {
  const cases: Array<[string, string]> = [
    ["EK 203 departs at 14:35", "EK 203 departs"],
    ["Dinner at 8pm tonight", "Dinner"],
    ["Due Friday", ""],
    ["Oct 24 · Gate B12", "Gate B12"],
    ["24th of October, 2026: Trip to Rome", "Trip to Rome"],
    ["Delivery 2026-10-24T09:00:00+04:00", "Delivery"],
    ["Paid on 24/10/2026", "Paid"],
    ["Budget tracker", "Budget tracker"],
    ["Order #4521, 3 items", "Order #4521, 3 items"],
    ["Version 2.5 notes", "Version 2.5 notes"],
    ["Pickup 9.30am", "Pickup"],
    ["Sale ends 10.24.2026", "Sale ends"],
    ["Meeting from 9:30 am - 11 am", "Meeting"],
  ];
  for (const [input, expected] of cases) expect(cardSafeText(input)).toBe(expected);
});

test("cardAppConfig defaults to Spectrum and rejects malformed identities", () => {
  expect(cardAppConfig(undefined)).toEqual(SPECTRUM_CARD_APP);
  expect(cardAppConfig({ appName: "Robob", extensionBundleId: "com.abdullah.robob.cards.MessagesExtension", teamId: "HVG39427R3" }))
    .toEqual({ appName: "Robob", extensionBundleId: "com.abdullah.robob.cards.MessagesExtension", teamId: "HVG39427R3" });
  expect(cardAppConfig({ appName: "X", extensionBundleId: "a.b", teamId: "ABCDE12345", appStoreId: 7 }).appStoreId).toBe(7);
  for (const bad of [
    null, "Robob", [], {},
    { appName: "", extensionBundleId: "a.b", teamId: "ABCDE12345" },
    { appName: "X", extensionBundleId: "nodots", teamId: "ABCDE12345" },
    { appName: "X", extensionBundleId: "a.b", teamId: "short" },
    { appName: "X", extensionBundleId: "a.b", teamId: "ABCDE12345", appStoreId: 0 },
    { appName: "X", extensionBundleId: "a.b", teamId: "ABCDE12345", appStoreId: "1" },
    { appName: "X", extensionBundleId: "a.b", teamId: "ABCDE12345", extra: true },
  ]) expect(() => cardAppConfig(bad)).toThrow("Invalid bridge configuration");
});
