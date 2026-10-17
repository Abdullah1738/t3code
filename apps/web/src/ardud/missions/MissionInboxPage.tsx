import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import type { MissionId, MissionInbox } from "@t3tools/contracts";
import {
  formatRelative,
  needsYouCounts,
  needsYouLine,
} from "@t3tools/client-runtime/ardud/missions";

import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { MissionSection } from "./MissionSection";
import { useMissionInbox, useMissionList } from "./missionsStore";
import { useNowMs } from "./useNowMs";

/**
 * Stub inbox: what waits on the owner, read-only. Round 2 replaces this with
 * the Decide / Approve / Knocks / Suggestions / FYI inbox and its actions.
 */
export function MissionInboxPage(props: { missionId: MissionId | null }) {
  const inbox = useMissionInbox(props.missionId);
  const list = useMissionList();
  const nowMs = useNowMs();
  const mission = list?.missions.find((item) => item.id === props.missionId) ?? null;
  const counts = useMemo(() => (inbox ? needsYouCounts(inbox) : null), [inbox]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="relative bg-background"
        >
          <WorkspaceBreadcrumb ariaLabel="Mission inbox" className="overflow-hidden">
            {mission ? (
              <>
                <WorkspaceBreadcrumbItem>
                  <Link
                    to="/missions/$missionId"
                    params={{ missionId: mission.id }}
                    className="min-w-0 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <WorkspaceBreadcrumbText>{mission.title}</WorkspaceBreadcrumbText>
                  </Link>
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
              </>
            ) : null}
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Inbox</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="min-h-full gap-4">
            <p className="text-sm text-muted-foreground">
              {counts ? (needsYouLine(counts) ?? "Nothing needs you.") : "Loading…"} Answering and
              approving from here arrives with the full inbox.
            </p>
            {inbox ? <InboxPreview inbox={inbox} nowMs={nowMs} /> : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function InboxPreview(props: { inbox: MissionInbox; nowMs: number }) {
  const { inbox, nowMs } = props;
  const sections = [
    {
      title: "Decide",
      items: inbox.asks.map((ask) => ({
        id: ask.id,
        text: ask.question,
        detail: `Asked ${formatRelative(ask.createdAt, nowMs)} · ${ask.costOfWaiting}`,
      })),
    },
    {
      title: "Approve",
      items: [
        ...inbox.drafts.map((draft) => ({
          id: draft.id,
          text: `Draft for ${draft.audience} on ${draft.target.label}`,
          detail: draft.text,
        })),
        ...inbox.approvals.map((approval) => ({
          id: approval.id,
          text: approval.title,
          detail: approval.detail,
        })),
      ],
    },
    {
      title: "Knocks",
      items: inbox.knocks.map((knock) => ({
        id: knock.id,
        text: knock.summary,
        detail: `From "${knock.fromTitle}"`,
      })),
    },
    {
      title: "Suggestions",
      items: inbox.suggestions.map((suggestion) => ({
        id: suggestion.id,
        text: suggestion.title,
        detail: suggestion.why,
      })),
    },
    {
      title: "FYI",
      items: inbox.fyi.map((note) => ({ id: note.id, text: note.summary, detail: null })),
    },
  ].filter((section) => section.items.length > 0);

  return (
    <>
      {sections.map((section) => (
        <MissionSection
          key={section.title}
          title={section.title}
          caption={`${section.items.length}`}
        >
          <ul className="flex flex-col divide-y divide-border/60">
            {section.items.map((item) => (
              <li key={item.id} className="py-2 first:pt-0 last:pb-0">
                <p className="text-sm text-pretty text-foreground">{item.text}</p>
                {item.detail ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </MissionSection>
      ))}
    </>
  );
}
