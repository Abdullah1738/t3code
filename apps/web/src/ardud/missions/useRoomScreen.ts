import { useEffect, useReducer } from "react";

import type { MissionId, MissionMessage, RoomId } from "@t3tools/contracts";
import {
  INITIAL_ROOM_UI,
  pendingRuleOffer,
  postMessageInput,
  roomMembers,
  roomUiReducer,
  roomView,
  ruleFromCorrection,
} from "@t3tools/client-runtime/ardud/missions";

import { toastManager } from "../../components/ui/toast";
import { runMissionAction, submitMissionInput } from "./missionActions";
import { missionErrorMessage, missionsSource, useRoomPage } from "./missionsStore";

/**
 * One open room: live page, older pages, the pinned read marker, status-run
 * folding, the composer and the "save as a rule?" offer. Logic lives in the
 * client-runtime reducer and helpers; this hook wires them to the source.
 */
export function useRoomScreen(
  missionId: MissionId,
  roomId: RoomId | null,
  masterRoleId: string | null,
) {
  const page = useRoomPage(roomId);
  const [ui, dispatch] = useReducer(roomUiReducer, INITIAL_ROOM_UI);

  useEffect(() => {
    dispatch({ type: "open", roomId });
  }, [roomId]);

  useEffect(() => {
    if (page) dispatch({ type: "page", page });
  }, [page]);

  const view = page && ui.roomId === page.room.id ? roomView(page, ui) : null;
  const markRead = view?.markRead ?? null;

  // The room is open with its newest message on screen: move the owner's read
  // position. The marker itself stays where it was when the room opened.
  useEffect(() => {
    if (roomId === null || markRead === null) return;
    void runMissionAction(
      missionsSource.markRoomRead({ roomId, seq: markRead } as Parameters<
        typeof missionsSource.markRoomRead
      >[0]),
      "Couldn't mark the room read",
    );
  }, [roomId, markRead]);

  const olderRequest = view?.olderRequest ?? null;
  const loadOlder = () => {
    if (olderRequest === null) return;
    dispatch({ type: "older-start" });
    missionsSource.loadRoomPage(olderRequest).then(
      (older) => dispatch({ type: "older-done", page: older }),
      (error: unknown) => {
        dispatch({ type: "older-failed" });
        toastManager.add({
          type: "error",
          title: "Couldn't load older messages",
          description: missionErrorMessage(error),
        });
      },
    );
  };

  const send = async () => {
    if (!page) return false;
    const sent = await submitMissionInput(
      postMessageInput(page.room, ui.target, ui.text),
      (input) => missionsSource.postRoomMessage(input),
      "Couldn't post the message",
    );
    if (sent) dispatch({ type: "sent" });
    return sent;
  };

  const ruleOffer = page ? pendingRuleOffer(page, ui.offeredRuleIds) : null;
  const saveRule = async (message: MissionMessage) => {
    const input = ruleFromCorrection(missionId, message);
    dispatch({ type: "rule-offered", messageId: message.id });
    if (input === null) return false;
    const saved = await runMissionAction(
      missionsSource.upsertRule(input),
      "Couldn't save the rule",
    );
    if (saved)
      toastManager.add({ type: "success", title: "Saved as a rule", description: input.title });
    return saved;
  };
  const skipRule = (message: MissionMessage) =>
    dispatch({ type: "rule-offered", messageId: message.id });

  const members = page ? roomMembers(page.subscriptions, masterRoleId) : [];

  return { page, ui, view, dispatch, loadOlder, send, ruleOffer, saveRule, skipRule, members };
}

export type RoomScreen = ReturnType<typeof useRoomScreen>;
