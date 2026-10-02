import { stackedThreadToast, toastManager } from "../../components/ui/toast";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

export function undoToast(title: string, description: string, undo: () => Promise<unknown>) {
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title,
      description,
      actionProps: {
        children: "Undo",
        onClick: () => {
          void undo().catch((error) =>
            toastManager.add({
              type: "error",
              title: "Could not undo",
              description: errorMessage(error),
            }),
          );
        },
      },
      actionVariant: "outline",
    }),
  );
}
