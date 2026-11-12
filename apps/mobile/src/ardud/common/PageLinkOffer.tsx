import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { parseWebLink } from "./pageNavigation";

/**
 * A link a page inside the app tried to follow. The page never opens anything
 * by itself: the link is shown here, with the site it leads to, and opens only
 * when he taps it. Nothing but a web address ever gets this far, and it is
 * read once more here (`parseWebLink`): the site shown and the address opened
 * come from that one reading.
 */
export function PageLinkOffer(props: { readonly url: string; readonly onDone: () => void }) {
  // Read once: the site named on the row and the address that opens are the same reading.
  const link = parseWebLink(props.url);
  if (link === null) return null;
  const { host } = link;
  return (
    <View className="flex-row items-center gap-1 border-t border-border bg-card">
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${host} in the browser`}
        accessibilityHint={link.url}
        onPress={() => {
          props.onDone();
          void tryOpenExternalUrl(link.url, "html-render");
        }}
        className="min-h-11 min-w-0 flex-1 flex-row items-start gap-2 px-3.5 py-3 active:opacity-70"
      >
        {/* As tall as one line of the label, so the arrow sits on its first line. */}
        <View className="h-5 justify-center">
          <SymbolView
            name="arrow.up.right"
            size={12}
            tintColorClassName="accent-primary-text"
            type="monochrome"
          />
        </View>
        {/* The whole host, on as many lines as it takes: its end says whose site it is. */}
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-primary-text">Open {host}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss link"
        hitSlop={6}
        onPress={props.onDone}
        className="size-11 items-center justify-center active:opacity-70"
      >
        <SymbolView
          name="xmark"
          size={11}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
