import type { ReactNode } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarSearch } from "../../../components/ui/AppBar.types";
import { useHeaderInset } from "../../common/hooks";

/** Room under the last control: the home indicator, or a little air above the keyboard. */
export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  return keyboardVisible ? 8 : Math.max(insets.bottom, 12);
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
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
        {props.children}
      </KeyboardAvoidingView>
    </View>
  );
}
