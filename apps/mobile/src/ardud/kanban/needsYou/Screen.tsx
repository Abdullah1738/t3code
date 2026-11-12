import type { ReactNode } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarSearch } from "../../../components/ui/AppBar.types";
import { useHeaderInset } from "../../common/hooks";
import { bottomInsetFor } from "./logic";

/** Room under the last control: the home indicator, or a little air above the keyboard. */
export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  // Read one by one: a selector has to give the same value for the same state.
  const visible = useKeyboardState((state) => state.isVisible);
  const height = useKeyboardState((state) => state.height);
  return bottomInsetFor({ visible, height }, insets.bottom);
}

/** One pushed Needs-you screen: the app's header, then the body above the keyboard. */
export function Screen(props: {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onBack: () => void;
  readonly actions?: ReadonlyArray<AppBarAction>;
  readonly menus?: ReadonlyArray<AppBarMenu>;
  readonly search?: AppBarSearch;
  readonly children: ReactNode;
}) {
  const headerInset = useHeaderInset();
  return (
    <View collapsable={false} className="flex-1 bg-screen" style={{ paddingTop: headerInset }}>
      <AppBar
        title={props.title}
        sidebar={false}
        onBack={props.onBack}
        {...(props.subtitle ? { subtitle: props.subtitle } : {})}
        {...(props.actions ? { actions: props.actions } : {})}
        {...(props.menus ? { menus: props.menus } : {})}
        {...(props.search ? { search: props.search } : {})}
      />
      {/*
        Padding, not height: in its height mode the view is pinned to a height it measured
        earlier for as long as the keyboard counts as open, and a keyboard that went away
        without saying so (a hardware keyboard, an interrupted dismissal) left the bar
        under an ask partly below the screen. With padding the body always fills what is
        there and only makes room for the keyboard that is really up.
      */}
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        {props.children}
      </KeyboardAvoidingView>
    </View>
  );
}
