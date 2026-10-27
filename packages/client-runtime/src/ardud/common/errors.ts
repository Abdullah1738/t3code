/** Reads the owner-facing detail of a rejected mutation. */
export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail;
  }
  return "Something went wrong. Try again.";
}
