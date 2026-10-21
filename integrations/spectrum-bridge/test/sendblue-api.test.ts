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

  test("the owner's own chat can request and read its location; groups cannot", async () => {
    const asked: string[] = [];
    const d = deps({ line: {
      requestLocation: async (chat: string) => { asked.push(chat); },
      location: async (address: string) => { asked.push(address); return { latitude: 1, longitude: 2 }; },
    } as unknown as Line });
    expect((await locationRequest(d, "ses-owner")).status).toBe(202);
    expect((await location(d, "ses-owner")).body).toMatchObject({ latitude: 1, longitude: 2 });
    expect((await location(d, "ses-family")).status).toBe(400);
    expect(asked).toEqual([chatKey.dm("+15555550123"), "+15555550123"]);
  });

  test("an explicit target chat wins over the calling chat", async () => {
    const d = deps();
    expect((await locationRequest(d, "ses-owner", moni)).status).toBe(202);
    expect(d.requested).toEqual([moni.key]);
    expect((await locationRequest(d, "ses-owner", family)).status).toBe(400);
  });

  test("no fix reports whether the person shares at all", async () => {
    const d = deps({ line: { location: async () => ({ state: "not_shared" }) } as unknown as Line });
    expect((await location(d, "ses-moni")).body).toMatchObject({ location: "none", state: "not_shared" });
    const e = deps({ line: { location: async () => undefined } as unknown as Line });
    expect((await location(e, "ses-moni")).body).toEqual({ location: "none" });
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
