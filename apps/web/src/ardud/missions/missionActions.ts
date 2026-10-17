import { toastManager } from "../../components/ui/toast";
import { missionErrorMessage } from "./missionsStore";

/** Runs an owner action; failures surface as a toast with the source's reason. */
export function runMissionAction(
  action: Promise<void>,
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
