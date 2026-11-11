import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useNowMs } from "../../common/hooks";
import { Group, Row, Title } from "../../common/parts";
import { useOwnerStanding, useWatchAsks } from "./askStore";
import { useQueue } from "./useQueue";

/**
 * "Needs you" on the phone's thread list, above the boards: every ask that
 * waits on him across boards, with how many are his to answer.
 */
export function NeedsYouHomeRow() {
  const navigation = useNavigation();
  const nowMs = useNowMs();
  useWatchAsks(false);
  useOwnerStanding();
  const queue = useQueue(nowMs);
  // An ask whose answer is on its way no longer counts.
  const owed = queue.needsYou.items.filter((item) => !queue.hidden.has(item.key));
  const count = owed.length;
  const holding = owed.some((item) => item.blocking);
  return (
    <Group>
      <Row
        accessibilityLabel={
          queue.read
            ? `Needs you, ${count} to answer${holding ? ", some hold a card" : ""}`
            : "Needs you"
        }
        onPress={() => navigation.navigate("NeedsYou")}
        className="items-center"
      >
        <SymbolView
          name="questionmark.bubble"
          size={17}
          tintColorClassName={holding ? "accent-warning-foreground" : "accent-icon"}
          type="monochrome"
        />
        <Title className="flex-1">Needs you</Title>
        {count > 0 ? (
          <View
            className={
              holding
                ? "min-h-6 min-w-6 items-center justify-center rounded-full bg-warning px-2"
                : "min-h-6 min-w-6 items-center justify-center rounded-full bg-secondary px-2"
            }
          >
            <Text
              className={
                holding
                  ? "text-xs font-t3-semibold tabular-nums text-warning-foreground"
                  : "text-xs font-t3-semibold tabular-nums text-foreground"
              }
            >
              {count}
            </Text>
          </View>
        ) : null}
        <SymbolView
          name="chevron.right"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Row>
    </Group>
  );
}
