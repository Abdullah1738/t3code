export function messageLengthError(text: string, limit: number): string {
  return `message too long: ${text.length.toLocaleString("en-US")} chars, limit ${limit.toLocaleString("en-US")}; split it or send as a card`;
}
