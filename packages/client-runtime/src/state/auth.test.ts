import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { applyAuthAccessStreamEvent, EMPTY_AUTH_ACCESS_SNAPSHOT } from "./auth.ts";

describe("applyAuthAccessStreamEvent", () => {
  it("accumulates rapid pairing-link and client updates into one snapshot", () => {
    const pairingLink = {
      id: "pairing-link",
      scopes: ["orchestration:read"],
      subject: "subject",
      label: "Phone",
      createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
    } as const;
    const clientSession = {
      sessionId: AuthSessionId.make("session-client"),
      subject: "subject",
      scopes: ["orchestration:read"],
      method: "browser-session-cookie",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: true,
      current: false,
    } as const;

    const withPairingLink = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "pairingLinkUpserted",
      payload: pairingLink,
    });
    const withClient = applyAuthAccessStreamEvent(withPairingLink, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: clientSession,
    });

    expect(withClient).toEqual({
      pairingLinks: [pairingLink],
      clientSessions: [clientSession],
    });
  });

  it("applies removals without disturbing unrelated access state", () => {
    const snapshot = applyAuthAccessStreamEvent(
      {
        pairingLinks: [
          {
            id: "pairing-link",
            scopes: ["orchestration:read"],
            subject: "subject",
            label: "Phone",
            createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
          },
        ],
        clientSessions: [],
      },
      {
        version: 1,
        revision: 2,
        type: "pairingLinkRemoved",
        payload: { id: "pairing-link" },
      },
    );

    expect(snapshot).toEqual(EMPTY_AUTH_ACCESS_SNAPSHOT);
  });

  it("keeps what the snapshot said about owner standing when a change event does not say", () => {
    const phone = {
      sessionId: AuthSessionId.make("session-phone"),
      subject: "one-time-token",
      scopes: ["orchestration:read"],
      method: "bearer-access-token",
      client: { label: "iPhone", deviceType: "mobile" },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: false,
      current: false,
    } as const;
    const snapshot = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "snapshot",
      payload: { pairingLinks: [], clientSessions: [{ ...phone, owner: false }] },
    });
    // The phone connects: the change event carries no standing.
    const connected = applyAuthAccessStreamEvent(snapshot, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: { ...phone, connected: true },
    });
    expect(connected.clientSessions).toEqual([{ ...phone, connected: true, owner: false }]);

    // A session first seen in a change event has no standing until the next snapshot.
    const added = applyAuthAccessStreamEvent(connected, {
      version: 1,
      revision: 3,
      type: "clientUpserted",
      payload: { ...phone, sessionId: AuthSessionId.make("session-new") },
    });
    expect("owner" in added.clientSessions[1]!).toBe(false);
  });
});
