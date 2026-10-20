import { feedFailureLines, feedOfflineLines } from "@t3tools/client-runtime/ardud/missions";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useMissionsEnvironmentId, type FeedState } from "./missionsStore";
import { EmptyLine, LinkButton, Meta, StateGlyph } from "./parts";

/**
 * The Desk error line inside the block whose read failed: what could not load,
 * when it last loaded, and Retry. Nothing renders while the feed is healthy.
 */
export function FeedError(props: {
  readonly what: string;
  readonly feed: FeedState;
  readonly nowMs: number;
}) {
  const failure = props.feed.failure;
  if (!failure) return null;
  const lines = feedFailureLines(props.what, failure, props.nowMs);
  return (
    <View accessibilityRole="alert" className="flex-row gap-3 px-3.5 py-3">
      <View className="pt-1">
        <StateGlyph state="stuck" />
      </View>
      <View className="min-w-0 flex-1 items-start gap-0.5">
        <Text className="text-[15px] font-t3-semibold text-foreground">{lines.title}</Text>
        {lines.detail ? <Meta>{lines.detail}</Meta> : null}
        <LinkButton label="Retry" onPress={props.feed.retry} />
      </View>
    </View>
  );
}

/**
 * A block's loading line: "Loading" while the server is connected or the first
 * connection is being made, the Desk offline line otherwise, so a block opened
 * offline says why it is empty instead of loading forever.
 */
export function LoadingLine() {
  const { presentation } = useEnvironmentPresentation(useMissionsEnvironmentId());
  const offline = feedOfflineLines(presentation?.connection.phase ?? null);
  if (offline === null) return <EmptyLine label="Loading" />;
  return (
    <View accessibilityRole="text" className="flex-row gap-3 px-3.5 py-3">
      <View className="pt-1">
        <StateGlyph state="waiting" />
      </View>
      <View className="min-w-0 flex-1 items-start gap-0.5">
        <Text className="text-[15px] font-t3-semibold text-foreground">{offline.title}</Text>
        <Meta>{offline.detail}</Meta>
      </View>
    </View>
  );
}
