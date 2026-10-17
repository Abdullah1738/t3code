import { toastManager } from "../../components/ui/toast";
import { missionErrorMessage } from "./missionsStore";

/** Runs an owner action; failures surface as a toast with the source's reason. */
export function runMissionAction(
  action: Promise<unknown>,
  failureTitle: string,
  onFailure?: () => void,
): Promise<boolean> {
  return action.then(
    () => true,
    (error: unknown) => {
      onFailure?.();
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: missionErrorMessage(error),
      });
      return false;
    },
  );
}

/** What the client-runtime input builders return. */
export type BuiltInput<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Sends an input built by a view-model helper. A build error (empty text, a
 * missing reason) is shown as a warning and nothing is sent.
 */
export function submitMissionInput<T>(
  built: BuiltInput<T>,
  send: (input: T) => Promise<unknown>,
  failureTitle: string,
): Promise<boolean> {
  if (!built.ok) {
    toastManager.add({ type: "warning", title: failureTitle, description: built.error });
    return Promise.resolve(false);
  }
  return runMissionAction(send(built.value), failureTitle);
}
