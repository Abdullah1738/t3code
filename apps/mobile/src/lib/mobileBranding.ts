// Robob fork: product name shown in the app and in the server's authorized-client list.
export const MOBILE_APP_NAME = "Robob";

export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Beta";
}
