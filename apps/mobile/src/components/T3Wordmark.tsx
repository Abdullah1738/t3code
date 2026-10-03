import { Image } from "expo-image";
import type { ColorValue } from "react-native";

const ROBOB_MARK = require("../../assets/robob-mark.png");

/**
 * Robob mark (rounded app icon). Keeps the upstream component name and props so call
 * sites stay merge-friendly; the color props are ignored because the mark is a bitmap.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Image
      accessibilityLabel="Robob"
      source={ROBOB_MARK}
      style={{ width: props.height, height: props.height }}
      contentFit="contain"
    />
  );
}
