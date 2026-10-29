// The company does not keep a record of who has been paid: it only tracks whether a salary has been CLEARED or is still pending.
// The stored status value stays "paid" (the API, the database and every filter value are unchanged); these are the words every
// payroll screen uses for it.

export const CLEARED_LABEL = "Cleared";

/** The words of the button that clears a salary. */
export const MARK_CLEARED_LABEL = "Mark as Cleared";

/** A payroll's status in words: "paid" is shown as "Cleared", "pending" stays "Pending", anything else is capitalised as it came. */
export function payStatusLabel(status: string | null | undefined): string {
  const text = (status ?? "").trim();
  if (text.toLowerCase() === "paid") return CLEARED_LABEL;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
