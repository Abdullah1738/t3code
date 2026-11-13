import { useEffect } from "react";
import {
  analyticsForEnvironment,
  trackAnalyticsScreen,
} from "@t3tools/client-runtime/ardud/analytics";

export function useAnalyticsScreen(
  environmentId: string | null,
  route: string,
  boardId?: string,
  cardId?: string,
  discussionId?: string,
  key?: string,
) {
  useEffect(
    () =>
      trackAnalyticsScreen(environmentId, {
        route,
        ...(boardId ? { boardId } : {}),
        ...(cardId ? { cardId } : {}),
        ...(discussionId ? { discussionId } : {}),
        ...(key ? { props: { key } } : {}),
      }),
    [environmentId, route, boardId, cardId, discussionId, key],
  );
}

export function useAnalyticsSearch(
  environmentId: string | null,
  span: string,
  queryLength: number,
  resultCount: number,
  boardId?: string,
) {
  useEffect(() => {
    if (!queryLength) return;
    const collector = analyticsForEnvironment(environmentId);
    const timer = setTimeout(
      () =>
        collector?.record("search", {
          ...(boardId ? { boardId } : {}),
          props: { span, queryLength, resultCount },
        }),
      300,
    );
    return () => clearTimeout(timer);
  }, [environmentId, span, queryLength, resultCount, boardId]);
}
