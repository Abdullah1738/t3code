import { expect, test } from "bun:test";
import { commandWord, controlCommand, isCommand } from "../src/commands.ts";

test.each([
  ["/new", "new"], [" /new", "new"], ["/New", "new"], ["/status", "status"], ["/Status", "status"],
  ["/approve r1 once", "approve"], ['/answer q1 [["A"]]', "answer"],
  ["/notification n1 hi", "notification"], ["/context n1 hi", "context"],
  ["/reminders", "reminders"], ["/snooze R1 1h", "snooze"], ["/cancel R2", "cancel"],
  ["\t/NEW\n", "new"], ["/new extra words", "new"], ["/status x", "status"],
])("recognizes %s as %s", (text, word) => {
  expect(commandWord(text)).toBe(word);
  expect(isCommand(text)).toBe(true);
  expect(controlCommand(text)).toBe(word !== "notification" && word !== "context");
});

test.each([
  "/ defrosted", "/frobnicate", "/Users/ardud/x.txt", "/new-ish", "//", "/", "fresh / defrosted", "",
  "/contextual thing", "/notificationish thing", "/new/path", "/new.txt", "/new1", "/new_", "/new?", "/newé",
])("leaves %j as ordinary text", text => {
  expect(commandWord(text)).toBeUndefined();
  expect(isCommand(text)).toBe(false);
  expect(controlCommand(text)).toBe(false);
});
