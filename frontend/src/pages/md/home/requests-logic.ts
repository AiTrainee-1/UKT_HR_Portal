// What is waiting for a decision, as the dashboard's "Requests waiting" card shows it. No React in here: the card turns the
// three request lists (leave, permission, outpass) into PendingRequest rows, and these functions rank and count them.
//
// The MD only LOOKS at requests (permission_registry.MD_VIEW_ONLY): HR and the Department Heads decide them. So the card
// lists every pending request, oldest first, says who it is waiting for, and leads to the Requests page; it has no
// Approve or Reject.

export type RequestKind = "leave" | "permission" | "outpass";

export type PendingRequest = {
  kind: RequestKind;
  id: number;
  /** The employee's name. */
  who: string;
  /** "Casual Leave", "Permission · Late arrival", "Outpass Request". */
  what: string;
  /** Dates / destination / reason, one line. */
  detail: string;
  /** When it was made (ISO). */
  createdAt: string;
  /** Who it is waiting for, as the approval pipeline says ("hod", "hr"); empty when the server did not say. */
  waitingFor: string[];
};

export type PendingSummary = {
  /** The oldest first, cut to `limit`. */
  items: PendingRequest[];
  /** How many are pending, by kind. */
  counts: Record<RequestKind, number>;
  /** How many are pending in all. */
  total: number;
  /** Days the oldest request has waited; null when none waits. */
  oldestDays: number | null;
};

export const KIND_LABEL: Record<RequestKind, string> = {
  leave: "Leave",
  permission: "Permission",
  outpass: "Outpass",
};

const ROLE_LABEL: Record<string, string> = { hod: "Department Head", hr: "HR" };

/** Who the request is waiting for now ("Waiting for HR"); the approval pipeline decides the order, the card only says who is next. */
export function waitingForText(waitingFor: string[]): string {
  const names = waitingFor.map((r) => ROLE_LABEL[r] ?? r);
  if (names.length === 0) return "Waiting for HR";
  return `Waiting for ${names.join(" or ")}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since `createdAt` (0 = today; never negative; 0 for a date that cannot be read). */
export function waitingDays(createdAt: string, now: Date): number {
  const made = new Date(createdAt).getTime();
  if (Number.isNaN(made)) return 0;
  return Math.max(0, Math.floor((now.getTime() - made) / DAY_MS));
}

/** "today", "1 day", "5 days": how long a request has waited. */
export const waitingText = (days: number): string => (days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`);

/** The tone of a wait: a request waiting more than three days is late, more than a day is worth a look. */
export const waitingTone = (days: number): "late" | "watch" | "fresh" =>
  days > 3 ? "late" : days > 1 ? "watch" : "fresh";

/** Rank the pending requests, oldest first (an undated one last), cut to `limit`; the counts are of all of them. */
export function summarisePending(pending: PendingRequest[], now: Date, limit = 6): PendingSummary {
  const counts: Record<RequestKind, number> = { leave: 0, permission: 0, outpass: 0 };
  for (const r of pending) counts[r.kind] += 1;
  const age = (r: PendingRequest) => {
    const t = new Date(r.createdAt).getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const ranked = [...pending].sort((a, b) => age(a) - age(b) || a.id - b.id);
  const dated = ranked.filter((r) => !Number.isNaN(new Date(r.createdAt).getTime()));
  return {
    items: ranked.slice(0, Math.max(0, limit)),
    counts,
    total: pending.length,
    oldestDays: dated.length ? waitingDays(dated[0].createdAt, now) : null,
  };
}
