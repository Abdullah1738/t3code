import { useEffect } from "react";
import { analyticsForEnvironment } from "@t3tools/client-runtime/ardud/analytics";

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
