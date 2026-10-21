import { describe, expect, test } from "bun:test";
import { applyEdit, askOwner, location, locationRequest, type SbApiDeps } from "../src/sb-api.ts";
import type { Access, ChatInfo } from "../src/chats.ts";
import { chatKey, type Line } from "../src/line.ts";

const owner: ChatInfo = { key: chatKey.dm("+15555550123"), slug: "owner", kind: "owner", title: "Abdullah" };
const moni: ChatInfo = { key: chatKey.dm("+15555550199"), slug: "moni", kind: "dm", title: "Moni" };
const family: ChatInfo = { key: chatKey.group("grp-a"), slug: "group-family-grp-a", kind: "group", title: "Family" };

function deps(overrides: Partial<SbApiDeps> = {}): SbApiDeps & { wakes: string[]; requested: string[] } {
  const wakes: string[] = [];
  const requested: string[] = [];
  const line = {
    requestLocation: async (chat: string) => { requested.push(chat); },
    location: async () => ({ latitude: 25.2, longitude: 55.3, accuracy: 9 }),
  } as unknown as Line;
  const sessions: Record<string, ChatInfo> = { "ses-owner": owner, "ses-moni": moni, "ses-family": family };
  return {
    line, owner, accessPath: "/unused", wakes, requested,
    chatForSession: id => sessions[id],
    wakeOwner: (text: string) => { wakes.push(text); },
    ...overrides,
  } as SbApiDeps & { wakes: string[]; requested: string[] };
}

describe("location routes", () => {
  test("location-request asks the line in a 1:1 chat", async () => {
    const d = deps();
    expect((await locationRequest(d, "ses-moni")).status).toBe(202);
    expect(d.requested).toEqual([chatKey.dm("+15555550199")]);
  });

  test("location-request refuses a group chat", async () => {
    const d = deps();
    expect((await locationRequest(d, "ses-family")).status).toBe(400);
    expect(d.requested).toHaveLength(0);
  });

  test("location returns the fix for the chat's person", async () => {
    const result = await location(deps(), "ses-moni");
    expect(result.body).toMatchObject({ latitude: 25.2, longitude: 55.3, accuracy: 9 });
  });

  test("an unknown session is a 409", async () => {
    expect((await location(deps(), "ses-nobody")).status).toBe(409);
  });
});

describe("ask-owner", () => {
  test("a guest chat queues a prefixed wake for the owner", () => {
    const d = deps();
    expect(askOwner(d, "ses-moni", "can I come by?", "k1").status).toBe(202);
    expect(d.wakes).toEqual(["[From Moni] can I come by?"]);
  });

  test("the owner chat cannot ask itself", () => {
    expect(askOwner(deps(), "ses-owner", "hi", "k2").status).toBe(400);
  });
});

describe("access edits", () => {
  const base: Access = { people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] };

  test("allow adds a new person as a person by default", () => {
    const next = applyEdit(base, { type: "allow", address: "+447000000000", name: "Sam", admin: false });
    expect(next.people.find(p => p.name === "Sam")).toEqual({ name: "Sam", role: "person", addresses: ["+447000000000"] });
  });

  test("allow --admin upgrades an existing person without duplicating them", () => {
    const next = applyEdit(base, { type: "allow", address: "moni@example.com", name: "Moni", admin: true });
    expect(next.people).toHaveLength(1);
    expect(next.people[0]!.role).toBe("admin");
    expect(next.people[0]!.addresses).toEqual(["+15555550199", "moni@example.com"]);
  });

  test("allow-group records the group once and keeps its name", () => {
    const first = applyEdit(base, { type: "allow-group", id: "grp-a", name: "Family" });
    const second = applyEdit(first, { type: "allow-group", id: "grp-a" });
    expect(second.groups).toEqual([{ id: "grp-a" }]);
  });
});
