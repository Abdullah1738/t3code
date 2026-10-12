import { createContext, type ComponentProps, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { cn } from "../lib/cn";
import { useHoverGesture } from "../lib/useHoverGesture";

/** Whether a pointer hovers the enclosing row. Lets hover-only controls render without re-rendering the row. */
export const RowHoverContext = createContext(false);

/** Pointer feedback layered over selection. Touch-down may be the start of a scroll. */
export function RowPressable({
  children,
  className,
  highlighted = false,
  interactionClassName = "bg-row-hover",
  interactionOpacity = 1,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
  /** Shows the hover feedback without a pointer, e.g. while a drag targets the row. */
  readonly highlighted?: boolean;
  readonly interactionClassName?: string;
  readonly interactionOpacity?: number;
}) {
  const { hovered, hoverGesture } = useHoverGesture(props.disabled ?? false);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable {...props} className={cn("relative overflow-hidden", className)}>
        {() => (
          <>
            <View
              pointerEvents="none"
              className={cn("absolute inset-0", interactionClassName)}
              style={{
                opacity: props.disabled || !(hovered || highlighted) ? 0 : interactionOpacity,
              }}
            />
            <RowHoverContext value={hovered}>{children}</RowHoverContext>
          </>
        )}
      </Pressable>
    </GestureDetector>
  );
}
