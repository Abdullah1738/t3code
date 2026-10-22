import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useIMessagePalette } from "./palette";

/** The chat's initial in a circle, like a contact without a photo. */
export function IMessageAvatar(props: { readonly label: string; readonly size: "row" | "large" }) {
  const palette = useIMessagePalette();
  const large = props.size === "large";
  return (
    <View
      accessible={false}
      className={cn("items-center justify-center rounded-full", large ? "size-16" : "size-7")}
      style={{ backgroundColor: palette.incoming }}
    >
      <Text
        className={cn("font-t3-semibold text-foreground-muted", large ? "text-2xl" : "text-xs")}
      >
        {Array.from(props.label.trim())[0]?.toUpperCase() ?? "?"}
      </Text>
    </View>
  );
}
