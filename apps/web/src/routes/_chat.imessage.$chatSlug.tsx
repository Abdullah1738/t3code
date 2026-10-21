import { createFileRoute } from "@tanstack/react-router";

import { IMessageChatPage } from "../ardud/imessage/IMessageChatPage";

function IMessageChatRouteView() {
  const { chatSlug } = Route.useParams();
  return <IMessageChatPage chatSlug={chatSlug} />;
}

export const Route = createFileRoute("/_chat/imessage/$chatSlug")({
  component: IMessageChatRouteView,
});
