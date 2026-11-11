import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { threadDetailToShell } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import { useEffect, useMemo, useState } from "react";

import ChatView from "./ChatView";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { Button } from "./ui/button";
import { resolveByIdRouteState, ThreadRouteState } from "./ThreadRouteState";
import { useEnvironmentThread, environmentThreads } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadRefs, useQuietThreadShell } from "../state/entities";
import { buildThreadRouteParams, type ThreadRouteTarget } from "../threadRoutes";

/**
 * Plain server threads are unkeyed, so navigating between them reuses one instance as ChatView
 * expects. Rendered by the `_chat` layout rather than by the two leaf routes, since an element
 * only survives a route swap when the same parent renders it.
 */
export function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // Promotion can begin before the server creates the reserved thread.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : inferredThreadRef;
  const serverThread = useQuietThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const detailState = useEnvironmentThread(
    target.kind === "server" ? target.threadRef.environmentId : null,
    target.kind === "server" ? target.threadRef.threadId : null,
  );
  const detail = Option.getOrNull(detailState.data);
  const serverThreadShell = useMemo(
    () =>
      serverThread ??
      (detail !== null && serverThreadRef !== null
        ? threadDetailToShell(serverThreadRef.environmentId, detail)
        : null),
    [serverThread, detail, serverThreadRef],
  );

  const resolvedThread = detail?.thread ?? serverThreadShell;
  const { unarchiveThread } = useThreadActions();
  const [restoreError, setRestoreError] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);
  const routeKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const routeAttemptKey = routeKey === null ? null : `${routeKey}:${retryAttempt}`;
  useEffect(() => {
    if (routeAttemptKey === null) return;
    const timer = setTimeout(() => setTimedOutKey(routeAttemptKey), 15_000);
    return () => clearTimeout(timer);
  }, [routeAttemptKey]);
  const renderState = resolveByIdRouteState({
    status: detailState.status,
    error: Option.isSome(detailState.error),
    exists: detail !== null,
    deleted: resolvedThread?.deletedAt != null,
    archived: resolvedThread?.archivedAt != null,
    timedOut: routeAttemptKey !== null && timedOutKey === routeAttemptKey,
  });
  const retry = () => {
    setTimedOutKey(null);
    setRetryAttempt((attempt) => attempt + 1);
    // reload, not refresh: a refresh resumes the retained state and would
    // park again on a deleted thread instead of asking the server.
    if (target.kind === "server")
      environmentThreads.reload(
        appAtomRegistry,
        target.threadRef.environmentId,
        target.threadRef.threadId,
      );
  };
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const serverThreadStarted = threadHasStarted(serverThreadShell);

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || detail === null || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [detail, draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = (
    <ThreadRouteState state="loading" retry={retry} back={() => void navigate({ to: "/" })} />
  );
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <div className="flex h-full min-h-0 flex-col">
          {null}
          <ChatView
            key={target.draftId}
            draftId={target.draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            routeKind="draft"
            forceExpandedMobileComposer
          />
        </div>
      );
    }
  } else if (
    renderState === "ready" ||
    renderState === "archived" ||
    (renderState === "loading" && draftThread !== null)
  ) {
    view = (
      <div className="flex h-full min-h-0 flex-col">
        {renderState === "archived" ? (
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
            <span className="text-sm text-muted-foreground">
              {restoreError ? "Could not restore thread" : "Archived"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={restoring}
              onClick={() => {
                setRestoring(true);
                setRestoreError(false);
                void unarchiveThread(target.threadRef, { navigate: false })
                  .then((result) => {
                    if (result?._tag === "Failure") setRestoreError(true);
                  })
                  .catch(() => setRestoreError(true))
                  .finally(() => setRestoring(false));
              }}
            >
              Restore
            </Button>
          </div>
        ) : null}
        <ChatView
          readOnly={renderState === "archived"}
          key={nextChatViewKey?.key}
          environmentId={target.threadRef.environmentId}
          threadId={target.threadRef.threadId}
          routeKind="server"
        />
      </div>
    );
  } else {
    view = (
      <ThreadRouteState state={renderState} retry={retry} back={() => void navigate({ to: "/" })} />
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {view}
    </SidebarInset>
  );
}
