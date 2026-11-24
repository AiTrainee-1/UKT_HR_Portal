import type { VisitSource, VisitStatus, VisitorVisit } from "@/lib/api-client/custom-hooks";

// The Visitors page's pure parts: its filters (in the address), the words it shows for a status and a source, the phone
// and Aadhaar masks, and what the server's error answers say. No React here, so logic.test.ts covers it directly.

/** Every filter of the page, as the address has it (useGateFilters). `view` (Visits | People) is a screen switch: it is
 *  kept by Clear and never sent to the API (apiQuery drops it). The dates are the HR portal's date filter
 *  (lib/date-range: This Month by default, `month` for an earlier one). */
export const VISIT_FILTER_DEFAULTS = {
  view: "visits",
  range: "month",
  month: "",
  from: "",
  to: "",
  status: "",
  hostEmployeeId: "",
  departmentId: "",
  source: "",
  branchId: "",
  q: "",
  pageSize: "25",
};
export const VISIT_FILTER_KEEP = ["view"] as const;

export type VisitorsView = "visits" | "people";
export const viewOf = (value: string | undefined): VisitorsView => (value === "people" ? "people" : "visits");

/** The filters as the API takes them: without the screen switch (and without the paging for the figures and the file). */
export function apiQuery(params: URLSearchParams, opts: { paging?: boolean } = {}): string {
  const out = new URLSearchParams(params);
  out.delete("view");
  if (opts.paging === false) {
    out.delete("page");
    out.delete("pageSize");
  }
  return out.toString();
}

/** The People view's query: only the search, the branch (an account not bound to one) and the paging apply there. */
export function peopleQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of ["q", "branchId", "page", "pageSize"]) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  return out.toString();
}

export const STATUS_OPTIONS: readonly { value: VisitStatus; label: string }[] = [
  { value: "inside", label: "Inside" },
  { value: "checked_out", label: "Checked out" },
  { value: "not_checked_out", label: "Left without check-out" },
];

export const SOURCE_OPTIONS: readonly { value: VisitSource; label: string }[] = [
  { value: "qr", label: "QR self check-in" },
  { value: "hr", label: "Registered by HR" },
  { value: "reception", label: "Reception desk" },
];

export const ID_PROOF_TYPES = [
  "Aadhaar",
  "Driving licence",
  "PAN card",
  "Voter ID",
  "Passport",
  "Company ID",
  "Other",
] as const;

/** 98•••••210: the first two and the last three of the (last ten) digits, as the server masks it. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length >= 7) return `${digits.slice(0, 2)}${"•".repeat(digits.length - 5)}${digits.slice(-3)}`;
  if (digits.length >= 3) return `${"•".repeat(digits.length - 2)}${digits.slice(-2)}`;
  return phone ? "•••" : "";
}

/** XXXX XXXX 1234 from the last four digits. */
export const maskAadhaar = (last4: string | null | undefined): string | null =>
  last4 ? `XXXX XXXX ${last4.replace(/\D/g, "").slice(-4)}` : null;

/** 1234 5678 9012 */
export const groupAadhaar = (value: string): string =>
  value
    .replace(/\D/g, "")
    .replace(/(\d{4})(?=\d)/g, "$1 ")
    .trim();

/** Whom the visit is for: the matched employee's name, else what was typed. */
export const hostName = (v: Pick<VisitorVisit, "meetingEmployee" | "whomToMeet">): string =>
  v.meetingEmployee?.name ?? v.whomToMeet;

/** "Registered by HR (Priya)", "Reception desk (Front Desk)", "QR self check-in". */
export function checkedInByLabel(v: Pick<VisitorVisit, "source" | "sourceLabel" | "checkedInBy">): string {
  return v.checkedInBy && v.source !== "qr" ? `${v.sourceLabel} (${v.checkedInBy})` : v.sourceLabel;
}

/** "Priya HR · HR", "Front Desk · Reception desk", or null before a check-out. */
export function checkedOutByLabel(v: Pick<VisitorVisit, "checkedOutBy" | "checkoutSource">): string | null {
  if (!v.checkedOutBy) return null;
  const where = v.checkoutSource === "reception" ? "Reception desk" : v.checkoutSource === "hr" ? "HR" : null;
  return where ? `${v.checkedOutBy} · ${where}` : v.checkedOutBy;
}

/** A long stay: inside for more than two hours. */
/**
 * May a check-out be recorded for this visit? The server says (canCheckOut: none yet, checked in under 24 hours ago, so a
 * visitor who came in the evening can be checked out after midnight); a server without the key: only while "inside".
 */
export const canCheckOut = (v: Pick<VisitorVisit, "status" | "checkedOutAt" | "canCheckOut">): boolean =>
  v.canCheckOut ?? (v.status === "inside" && !v.checkedOutAt);

export const LONG_STAY_MINUTES = 120;
export const isLongStay = (v: Pick<VisitorVisit, "status" | "minutesInside">): boolean =>
  v.status === "inside" && (v.minutesInside ?? 0) > LONG_STAY_MINUTES;

/** The server's own words from an error answer (`{error}`), else `fallback`. */
export function errorText(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: unknown; message?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error && data.error !== "permission_denied") return data.error;
  if (data && typeof data.message === "string" && data.message) return data.message;
  return fallback;
}

/** The error's code (`already_inside`, `already_checked_out`, ...) and the visit it names, if any. */
export function errorCode(err: unknown): { status: number | null; code: string | null; visitId: number | null } {
  const e = err as { status?: number; data?: { code?: unknown; visitId?: unknown } } | null;
  return {
    status: typeof e?.status === "number" ? e.status : null,
    code: typeof e?.data?.code === "string" ? e.data.code : null,
    visitId: typeof e?.data?.visitId === "number" ? e.data.visitId : null,
  };
}
