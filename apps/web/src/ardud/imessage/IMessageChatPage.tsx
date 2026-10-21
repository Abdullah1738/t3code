export function IMessageChatPage(props: { chatSlug: string }) {
  return <div className="p-6 text-sm text-muted-foreground">{props.chatSlug}</div>;
}
