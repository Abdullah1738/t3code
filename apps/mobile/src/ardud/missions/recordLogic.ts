import type {
  MissionActor,
  MissionId,
  MissionMessage,
  MissionRecordRef,
  RoomId,
} from "@t3tools/contracts";
import {
  actorKey,
  actorLabel,
  discussRequestInput,
  formatDayLabel,
  INITIAL_ROOM_UI,
  openRequestInput,
  type OwnerRequest,
  pendingRuleOffer,
  postMessageInput,
  receiptNudgeLanes,
  receiptNudgeNote,
  replyRequestInput,
  requestReadMark,
  roomMembers,
  roomUiReducer,
  roomView,
  ruleFromCorrection,
  type ComposerTarget,
  type RoomMember,
  type RoomView,
} from "@t3tools/client-runtime/ardud/missions";
import {
  discussionOn,
  missionErrorMessage,
  type DiscussionView,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Alert } from "react-native";

import {
  missionsSource,
  useFullOwnerRequest,
  useOwnerRequest,
  useOwnerRequests,
  useRoomPage,
} from "./missionsStore";
import { useRequestDraft, type RequestDraft } from "./requestDraft";
import { useMissionAction } from "./useMissionsLogic";

// State and actions for the record screens: a discussion on an inbox item,
// one of Your requests, and an open room. Components only render these.

type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function sendChecked<T>(
  run: ReturnType<typeof useMissionAction>["run"],
  failureTitle: string,
  result: Checked<T>,
  send: (input: T) => Promise<unknown>,
): Promise<boolean> {
  if (!result.ok) {
    Alert.alert(failureTitle, result.error);
    return Promise.resolve(false);
  }
  return run(failureTitle, async () => {
    await send(result.value);
  });
}

/**
 * Takes a `requestReadMark`. Read receipts are best effort: the next new
 * message marks the request again.
 */
function markRead(mark: string | null): void {
  if (mark === null) return;
  const [requestId = ""] = mark.split("\n");
  missionsSource()
    .markRequestRead({ requestId })
    .catch(() => undefined);
}

function settleInput(requestId: string, text: string) {
  const note = text.trim();
  return note ? { requestId, note } : { requestId };
}

export interface DiscussionState {
  readonly request: OwnerRequest | null;
  readonly unread: number;
  readonly draft: RequestDraft;
  readonly pending: boolean;
  readonly send: () => void;
  readonly settle: () => void;
}

/** The discussion on one record and its unread count, without reading it. */
export function useDiscussionMark(
  missionId: MissionId | null,
  subject: MissionRecordRef,
): DiscussionView {
  const requests = useOwnerRequests(missionId);
  return discussionOn(requests ?? [], subject);
}

/**
 * The discussion thread on one inbox item. Its unread count only ever shows on
 * the item's discussion symbol; it is marked read only while it is open.
 */
export function useDiscussion(
  missionId: MissionId | null,
  subject: MissionRecordRef,
  open: boolean,
): DiscussionState {
  const mark = useDiscussionMark(missionId, subject);
  const full = useFullOwnerRequest(missionId, open ? (mark.request?.id ?? null) : null);
  const request = full ?? mark.request;
  const { unread } = mark;
  const draft = useRequestDraft();
  const { pending, run } = useMissionAction();

  const readMark = open ? requestReadMark(request) : null;
  useEffect(() => {
    markRead(readMark);
  }, [readMark]);

  const send = () => {
    if (request) {
      void draft.send((text, images) =>
        sendChecked(run, "Could not send", replyRequestInput(request.id, text, images), (input) =>
          missionsSource().replyRequest(input),
        ),
      );
      return;
    }
    if (!missionId) return;
    void draft.send((text, images) =>
      sendChecked(
        run,
        "Could not send",
        discussRequestInput(missionId, subject, text, images),
        (input) => missionsSource().openRequest(input),
      ),
    );
  };

  const settle = () => {
    if (!request) return;
    void draft.sendNote((note) =>
      run("Could not settle", () => missionsSource().settleRequest(settleInput(request.id, note))),
    );
  };

  return { request, unread, draft, pending: pending || draft.busy, send, settle };
}

export interface RequestComposerState {
  readonly draft: RequestDraft;
  readonly pending: boolean;
  readonly send: () => void;
}

/** "Ask or tell the master": opens a new request in Your requests. */
export function useRequestComposer(
  missionId: MissionId,
  onOpened: (request: OwnerRequest) => void,
): RequestComposerState {
  const draft = useRequestDraft();
  const { pending, run } = useMissionAction();
  const send = () => {
    let opened: OwnerRequest | null = null;
    void draft
      .send((text, images) =>
        sendChecked(
          run,
          "Could not send",
          openRequestInput(missionId, text, images),
          async (input) => {
            opened = await missionsSource().openRequest(input);
          },
        ),
      )
      .then((sent) => {
        if (sent && opened) onOpened(opened);
      });
  };
  return { draft, pending: pending || draft.busy, send };
}

export interface RequestThreadState {
  /** Undefined while loading, null once the request is gone. */
  readonly request: OwnerRequest | null | undefined;
  /** True while only the list row is known: the newest few messages, clipped. */
  readonly partial: boolean;
  readonly draft: RequestDraft;
  readonly pending: boolean;
  readonly reply: () => void;
  readonly settle: () => void;
  readonly reopen: () => void;
}

/** One of Your requests, opened: reply, settle with an optional note, reopen. */
export function useRequestThread(missionId: MissionId, requestId: string): RequestThreadState {
  const thread = useOwnerRequest(missionId, requestId);
  // Until the full read lands the request shows as its list row, so opening
  // one never waits on a blank screen.
  const row = useOwnerRequests(missionId)?.find((request) => request.id === requestId);
  const request = thread === undefined ? row : thread;
  const draft = useRequestDraft();
  const { pending, run } = useMissionAction();

  const readMark = requestReadMark(request);
  useEffect(() => {
    markRead(readMark);
  }, [readMark]);

  return {
    request,
    partial: thread === undefined && row !== undefined,
    draft,
    pending: pending || draft.busy,
    reply: () => {
      void draft.send((text, images) =>
        sendChecked(run, "Could not send", replyRequestInput(requestId, text, images), (input) =>
          missionsSource().replyRequest(input),
        ),
      );
    },
    settle: () => {
      void draft.sendNote((note) =>
        run("Could not settle", () => missionsSource().settleRequest(settleInput(requestId, note))),
      );
    },
    reopen: () => {
      void draft.sendNote((note) =>
        run("Could not reopen", () => missionsSource().reopenRequest(settleInput(requestId, note))),
      );
    },
  };
}

export interface RoomScreenState {
  /** Undefined while loading, null when the room is gone. */
  readonly found: boolean | undefined;
  readonly title: string;
  readonly view: RoomView | null;
  readonly loadingOlder: boolean;
  readonly expandRun: (key: string) => void;
  readonly loadOlder: () => void;
  readonly members: ReadonlyArray<RoomMember>;
  /** Who wrote or is addressed, by the name the room page gives them. */
  readonly nameOf: (actor: MissionActor) => string;
  readonly target: ComposerTarget;
  readonly setTarget: (target: ComposerTarget) => void;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly pending: boolean;
  readonly send: () => void;
  /** An owner correction not yet offered as a rule. */
  readonly ruleOffer: MissionMessage | null;
  readonly saveRule: (message: MissionMessage) => void;
  readonly skipRule: (message: MissionMessage) => void;
  // --- finish-b ---
  /** Control posts already nudged from this screen. */
  readonly nudged: ReadonlySet<string>;
  /** Nudges every lane a control post's receipt still waits on. */
  readonly nudge: (message: MissionMessage) => void;
  // --- end finish-b ---
}

/**
 * The open room: newest page live, older pages on demand, marked read up to
 * the newest message while it is open. Days read in the device's zone.
 */
export function useRoomScreen(roomId: RoomId, masterRoleId: string | null): RoomScreenState {
  const page = useRoomPage(roomId);
  const [ui, dispatch] = useReducer(roomUiReducer, INITIAL_ROOM_UI);
  const { pending, run } = useMissionAction();
  const [nudged, setNudged] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    dispatch({ type: "open", roomId });
  }, [roomId]);
  useEffect(() => {
    if (page) dispatch({ type: "page", page });
  }, [page]);

  const view = useMemo(
    () =>
      page && ui.roomId === page.room.id ? roomView(page, ui, (iso) => formatDayLabel(iso)) : null,
    [page, ui],
  );
  const markReadSeq = view?.markRead ?? null;
  useEffect(() => {
    if (markReadSeq === null) return;
    missionsSource()
      .markRoomRead({ roomId, seq: markReadSeq })
      .catch(() => undefined);
  }, [roomId, markReadSeq]);

  const nameOf = useMemo(() => {
    const names = page?.names ?? {};
    return (actor: MissionActor) =>
      actor._tag === "owner" ? "You" : (names[actorKey(actor)] ?? actorLabel(actor, masterRoleId));
  }, [page, masterRoleId]);
  const members = useMemo(
    () =>
      page
        ? roomMembers(page.subscriptions, masterRoleId).map((member) => ({
            ...member,
            label: nameOf(member.actor),
          }))
        : [],
    [page, masterRoleId, nameOf],
  );
  const ruleOffer = page ? pendingRuleOffer(page, ui.offeredRuleIds) : null;

  return {
    found: page === undefined ? undefined : page !== null,
    title: page?.room.title ?? "",
    view,
    loadingOlder: ui.loadingOlder,
    expandRun: (key) => dispatch({ type: "toggle-run", key }),
    loadOlder: () => {
      const request = view?.olderRequest;
      if (!request) return;
      dispatch({ type: "older-start" });
      missionsSource()
        .loadRoomPage(request)
        .then(
          (older) => dispatch({ type: "older-done", page: older }),
          (error: unknown) => {
            dispatch({ type: "older-failed" });
            Alert.alert("Could not load earlier messages", missionErrorMessage(error));
          },
        );
    },
    members,
    nameOf,
    target: ui.target,
    setTarget: (target) => dispatch({ type: "target", target }),
    text: ui.text,
    setText: (text) => dispatch({ type: "text", text }),
    pending,
    send: () => {
      if (!page) return;
      void sendChecked(
        run,
        "Could not post",
        postMessageInput(page.room, ui.target, ui.text),
        (input) => missionsSource().postRoomMessage(input),
      ).then((sent) => {
        if (sent) dispatch({ type: "sent" });
      });
    },
    ruleOffer,
    saveRule: (message) => {
      if (!page) return;
      const input = ruleFromCorrection(page.room.missionId, message);
      dispatch({ type: "rule-offered", messageId: message.id });
      if (input)
        void run("Could not save the rule", () =>
          missionsSource()
            .upsertRule(input)
            .then(() => undefined),
        );
    },
    skipRule: (message) => dispatch({ type: "rule-offered", messageId: message.id }),
    // --- finish-b ---
    nudged,
    nudge: (message) => {
      const laneIds = receiptNudgeLanes(message.receipt);
      if (laneIds.length === 0) return;
      const note = receiptNudgeNote(message);
      void run("Could not nudge", async () => {
        await Promise.all(laneIds.map((laneId) => missionsSource().nudgeLane({ laneId, note })));
      }).then((sent) => {
        if (sent) setNudged((current) => new Set([...current, message.id]));
      });
    },
    // --- end finish-b ---
  };
}
