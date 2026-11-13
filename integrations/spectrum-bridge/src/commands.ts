/** Telegram reminder commands stay reserved so the bridge can redirect them. */
const COMMANDS = new Set(["new", "status", "approve", "answer", "notification", "context", "reminders", "snooze", "cancel"]);

export function commandWord(text: string): string | undefined {
  const match = /^\/([A-Za-z]+)(?=\s|$)/.exec(text.trimStart());
  const word = match?.[1]?.toLowerCase();
  return word && COMMANDS.has(word) ? word : undefined;
}

export const isCommand = (text: string) => commandWord(text) !== undefined;

export function controlCommand(text: string): boolean {
  const word = commandWord(text);
  return word !== undefined && word !== "notification" && word !== "context";
}
