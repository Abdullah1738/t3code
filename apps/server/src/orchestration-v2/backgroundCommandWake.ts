import { CommandId, MessageId } from "@t3tools/contracts";

// The adapter and board backstop must address the same persisted message.
export const backgroundCommandWakeKey = (threadId: string, itemId: string) =>
  `background-command:${threadId}:${itemId}`;

export const backgroundCommandWakeMessageId = (threadId: string, itemId: string) =>
  MessageId.make(`kanban:${backgroundCommandWakeKey(threadId, itemId)}`);

export const backgroundCommandWakeCommandId = (threadId: string, itemId: string) =>
  CommandId.make(`kanban:send:${backgroundCommandWakeKey(threadId, itemId)}`);
