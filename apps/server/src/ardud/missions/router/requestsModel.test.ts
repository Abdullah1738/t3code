import { MissionId, OwnerRequestId, RoomId, type OwnerRequest } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  renderRequestContext,
  requestIdOfRoom,
  requestRoomId,
  requestTitleOf,
} from "./requestsModel.ts";

const at = "2026-10-19T08:00:00.000Z";
const request: OwnerRequest = {
  id: OwnerRequestId.make("request-1"),
  missionId: MissionId.make("m-1"),
  subMissionId: null,
  title: "Speed up reviews",
  status: "waiting-on-master",
  roomId: RoomId.make("m-1:room:request:request-1"),
  createdBy: { _tag: "owner-app", surface: "web", sessionId: "s-1" },
  lastOwnerAt: at,
  lastMasterAt: null,
  links: [{ kind: "work-item", id: "wi-1", label: "Batch reviews" }],
  unreadForOwner: false,
  settledBy: null,
  settledAt: null,
  createdAt: at,
  updatedAt: at,
};

const message = (seq: number, text: string) => ({ seq, author: "owner", text });

describe("owner request context", () => {
  it("keeps the opening and the newest messages and says what it left out", () => {
    const long = "x".repeat(3_000);
    const messages = [
      message(1, "Speed up reviews: they wait hours."),
      ...Array.from({ length: 10 }, (_, index) => message(index + 2, `${long} round ${index + 2}`)),
    ];
    const text = renderRequestContext({
      request,
      openedBy: "the owner",
      messages,
      total: 30,
      budget: 8_000,
    });
    assert.include(text, "Speed up reviews: they wait hours.");
    assert.include(text, "round 11");
    assert.notInclude(text, "round 2\n");
    assert.match(text, /\[\d+ earlier messages elided here/);
    assert.include(text, "work-item wi-1");
    assert.include(text, "Never give it a default or a deadline.");
  });

  it("bakes in no clock time: the owner reads it in the master's thread, in his own zone", () => {
    const text = renderRequestContext({
      request,
      openedBy: "the owner",
      messages: [message(1, "Speed up reviews.")],
      total: 1,
    });
    assert.include(text, "#1 owner:\nSpeed up reviews.");
    assert.notInclude(text, "2026-10-19");
    assert.notMatch(text, /\d{1,2}:\d{2}/);
  });

  it("titles from the first line and round-trips room ids", () => {
    assert.strictEqual(requestTitleOf("\n  Ship   it \nmore"), "Ship it");
    assert.strictEqual(requestTitleOf("a".repeat(200)).length, 120);
    const roomId = requestRoomId(request.missionId, request.id);
    assert.strictEqual(requestIdOfRoom(roomId), request.id);
    assert.isNull(requestIdOfRoom("m-1:room:control"));
  });
});
