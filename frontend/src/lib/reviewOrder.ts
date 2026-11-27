/**
 * The order of a review list (owner 2026-11-27, Loan & Advance in the HRMS, the MD portal and the Auditor Review Portal):
 * the requests still waiting for the reviewer always at the top, the approved ones below them, the rejected ones below
 * those. A request reopened with Rework waits again, so it moves back to the top. Within a group the list keeps its own
 * order (the column sort, or the order the server sent).
 */

export type ReviewState = "pending" | "approved" | "rejected";

export const REVIEW_ORDER: readonly ReviewState[] = ["pending", "approved", "rejected"] as const;

const RANK: Record<ReviewState, number> = { pending: 0, approved: 1, rejected: 2 };

/** The rows, waiting first, then approved, then rejected; stable within a group. A row without a state counts as
 *  waiting (an older server). */
export function sortByReview<T>(rows: readonly T[], stateOf: (row: T) => ReviewState | null | undefined): T[] {
  return rows
    .map((row, index) => ({ row, index, rank: RANK[stateOf(row) ?? "pending"] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.row);
}

export type ReviewGroup<T> = { state: ReviewState; rows: T[] };

/** The rows in their three groups (empty groups left out), in the review order. */
export function groupByReview<T>(
  rows: readonly T[],
  stateOf: (row: T) => ReviewState | null | undefined,
): ReviewGroup<T>[] {
  const groups: Record<ReviewState, T[]> = { pending: [], approved: [], rejected: [] };
  for (const row of rows) groups[stateOf(row) ?? "pending"].push(row);
  return REVIEW_ORDER.filter((s) => groups[s].length > 0).map((state) => ({ state, rows: groups[state] }));
}

/** The group's heading words. `pending` depends on who reviews ("Waiting for your decision", "Waiting for HR's
 *  answer"). */
export function reviewGroupLabel(state: ReviewState, pending = "Waiting for review"): string {
  return state === "pending" ? pending : state === "approved" ? "Approved" : "Rejected";
}
