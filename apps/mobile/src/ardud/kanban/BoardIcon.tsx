import type { Icon } from "@tabler/icons-react-native/types";
/* Per-icon imports: the package root registers the whole Tabler set in Metro. */
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBox from "@tabler/icons-react-native/IconBox";
import IconBrain from "@tabler/icons-react-native/IconBrain";
import IconBriefcase from "@tabler/icons-react-native/IconBriefcase";
import IconBug from "@tabler/icons-react-native/IconBug";
import IconChartLine from "@tabler/icons-react-native/IconChartLine";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconCoins from "@tabler/icons-react-native/IconCoins";
import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconHeart from "@tabler/icons-react-native/IconHeart";
import IconHome from "@tabler/icons-react-native/IconHome";
import IconLeaf from "@tabler/icons-react-native/IconLeaf";
import IconPlane from "@tabler/icons-react-native/IconPlane";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconShield from "@tabler/icons-react-native/IconShield";
import IconTarget from "@tabler/icons-react-native/IconTarget";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconUsers from "@tabler/icons-react-native/IconUsers";
import IconWallet from "@tabler/icons-react-native/IconWallet";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import { kanbanBoardIcon, type KanbanBoard, type KanbanBoardIcon } from "@t3tools/contracts";
import { View } from "react-native";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";

const ICONS: Record<KanbanBoardIcon, Icon> = {
  briefcase: IconBriefcase,
  rocket: IconRocket,
  code: IconCode,
  shield: IconShield,
  chart: IconChartLine,
  bot: IconRobot,
  wallet: IconWallet,
  flask: IconFlask,
  server: IconServer,
  globe: IconWorld,
  users: IconUsers,
  wrench: IconTool,
  book: IconBook,
  bolt: IconBolt,
  home: IconHome,
  heart: IconHeart,
  target: IconTarget,
  box: IconBox,
  database: IconDatabase,
  bug: IconBug,
  brain: IconBrain,
  coins: IconCoins,
  plane: IconPlane,
  leaf: IconLeaf,
};

const THEMED = Object.fromEntries(
  Object.entries(ICONS).map(([name, icon]) => [name, withUniwind(icon)]),
) as Record<KanbanBoardIcon, ReturnType<typeof withUniwind<Icon>>>;

/** The board's icon, or its first letter when it has none. */
export function BoardIcon(props: { readonly board: KanbanBoard; readonly size?: number }) {
  const size = props.size ?? 18;
  const name = kanbanBoardIcon(props.board);
  if (name === null) {
    return (
      <View
        style={{ width: size, height: size }}
        className="items-center justify-center rounded-[5px] bg-secondary-border"
      >
        <Text className="text-[11px] font-t3-bold text-foreground-muted">
          {props.board.name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
    );
  }
  const Themed = THEMED[name];
  return <Themed size={size} strokeWidth={1.8} colorClassName="accent-icon-muted" />;
}
