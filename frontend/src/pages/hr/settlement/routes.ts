// Loan & Advance (owner 2026-11-27: the Settlement page renamed): its three addresses, and where the old Settlement
// addresses go. Tiny and free of imports on purpose: App.tsx (the old-address redirect) and the sidebar (its sub-items)
// read it without pulling the page in.
//
//   /hr/Loan&Advance                  Overview: Salary Advance and Term Loan together
//   /hr/Loan&Advance/salary-advance   Salary Advance
//   /hr/Loan&Advance/term-loan        Term Loan
//
// The "&" is part of the address as the owner wrote it. A browser keeps it as it is in the path (only a query string gives
// it a meaning), the router compares paths without regard to case, and a link that arrives percent-encoded
// (/hr/Loan%26Advance) is sent to the plain one.

/** The page's name everywhere in the HRMS (page titles, sidebar, reports, file names: "Loan_Advance_..."). */
export const LOAN_ADVANCE_TITLE = "Loan & Advance";

export const LOAN_ADVANCE_BASE = "/hr/Loan&Advance";
/** The same address as some apps send it on (the "&" percent-encoded): App.tsx redirects it to LOAN_ADVANCE_BASE. */
export const LOAN_ADVANCE_BASE_ENCODED = "/hr/Loan%26Advance";
/** The old address (the Settlement page until 2026-11-27): App.tsx redirects it, and everything under it. */
export const LEGACY_SETTLEMENT_BASE = "/hr/settlement";

/** The page an address shows: the Overview of both types, or one type's own page ("general" = Salary Advance). */
export type LoanAdvancePage = "overview" | "general" | "term";

export const LOAN_ADVANCE_PAGES: readonly { page: LoanAdvancePage; slug: string; label: string; path: string }[] = [
  { page: "overview", slug: "", label: "Overview", path: LOAN_ADVANCE_BASE },
  { page: "general", slug: "salary-advance", label: "Salary Advance", path: `${LOAN_ADVANCE_BASE}/salary-advance` },
  { page: "term", slug: "term-loan", label: "Term Loan", path: `${LOAN_ADVANCE_BASE}/term-loan` },
];

/** The address of a page: loanAdvancePath("term") = "/hr/Loan&Advance/term-loan". */
export const loanAdvancePath = (page: LoanAdvancePage): string => LOAN_ADVANCE_PAGES.find((p) => p.page === page)!.path;

/** The page an address is ("/hr/Loan&Advance/salary-advance" -> "general"), compared without regard to case, a "/" at
 *  the end and an encoded "&"; null for any other address (an unknown page under /hr/Loan&Advance too). */
export function loanAdvancePageOf(pathname: string): LoanAdvancePage | null {
  const path = (pathname.split(/[?#]/)[0] ?? "").replace(/%26/gi, "&").replace(/\/+$/, "").toLowerCase();
  const base = LOAN_ADVANCE_BASE.toLowerCase();
  if (path === base) return "overview";
  if (!path.startsWith(`${base}/`)) return null;
  const slug = path.slice(base.length + 1);
  return LOAN_ADVANCE_PAGES.find((p) => p.slug && p.slug === slug)?.page ?? null;
}

/** Where an old Settlement address goes (owner 2026-11-27): ?tab=advance -> Salary Advance, ?tab=loan -> Term Loan,
 *  anything else (?tab=overview, no tab) -> the Overview. Every other query parameter (month, status, view ...) and the
 *  #anchor are kept; only `tab` goes, since the page is now the address. */
export function legacySettlementTarget(search: string, hash = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  params.delete("tab");
  const page: LoanAdvancePage = tab === "advance" ? "general" : tab === "loan" ? "term" : "overview";
  const qs = params.toString();
  return `${loanAdvancePath(page)}${qs ? `?${qs}` : ""}${hash && hash !== "#" ? hash : ""}`;
}
