export function analyticsQueueCount(
  layout: string,
  view: string,
  queueOpen: boolean,
  count: number,
) {
  return (layout === "phone" ? queueOpen : view === "queue") ? count : 0;
}
