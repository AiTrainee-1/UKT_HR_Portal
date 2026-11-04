// HoD's (Requests page, ?tab=hods): the rules behind the board, kept apart from the screens so they can be tested alone.
//
// The server (GET /api/hr/hod-pending) sends every active Department Head with what is pending WITH them per category: the
// same "mine" list their mobile Approvals tab shows. A category the head may not decide at all is null (shown "—", never 0).
// This file decides what the page shows from it: the search and the "only with pending" filter, the four figures, the
// totals row, the drill-down grouping, the WhatsApp summary and what the Excel / PDF / picture hold.

import type { HodCategory, HodPendingItem, HodRow } from "@/lib/api-client/custom-hooks";

export const DASH = "—";

// ─── filters ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type HodFilters = {
  query: string;
  /** "" = every branch the login sees, else a branch id. */
  branch: string;
  /** "" = every department, else a department id. */
  department: string;
  onlyPending: boolean;
};

export const NO_HOD_FILTERS: HodFilters = { query: "", branch: "", department: "", onlyPending: false };

/** What the server narrows (branch, department); the search and "only with pending" are the page's own (instant). */
export function serverHodParams(f: HodFilters): { branchId?: string; departmentId?: string } {
  const out: { branchId?: string; departmentId?: string } = {};
  if (f.branch) out.branchId = f.branch;
  if (f.department) out.departmentId = f.department;
  return out;
}

export const hodFiltersActive = (f: HodFilters) =>
  f.query.trim() !== "" || f.branch !== "" || f.department !== "" || f.onlyPending;

/** Everything the search looks at: the head, their departments and branch, and who their pending requests are from. */
export function hodHaystack(row: HodRow): string {
  return [
    row.name,
    row.code,
    row.designation,
    row.branch,
    ...row.departments,
    ...row.items.flatMap((i) => [i.employeeName, i.employeeCode, i.categoryLabel]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Every word typed must appear somewhere. */
export function matchesHod(row: HodRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = hodHaystack(row);
  return words.every((w) => hay.includes(w));
}

/** Most pending first, then by name: the order the server sends, kept whatever it sends. */
export function sortHods(rows: HodRow[]): HodRow[] {
  return [...rows].sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name) || a.managerId - b.managerId);
}

export function filterHods(rows: HodRow[], f: HodFilters): HodRow[] {
  return sortHods(rows.filter((r) => (!f.onlyPending || r.pending > 0) && matchesHod(r, f.query)));
}

// ─── figures ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type HodFigures = {
  hods: number;
  withPending: number;
  pending: number;
  /** The head whose oldest pending request has waited longest. */
  oldest: { managerId: number; name: string; days: number; label: string } | null;
};

export function hodFigures(rows: HodRow[]): HodFigures {
  let oldest: HodFigures["oldest"] = null;
  for (const row of rows) {
    if (row.pending <= 0) continue;
    const days = row.oldestDays ?? row.items[0]?.waitingDays ?? null;
    if (days === null) continue;
    if (!oldest || days > oldest.days) {
      const first = [...row.items].sort(byOldest)[0];
      oldest = { managerId: row.managerId, name: row.name, days, label: first?.categoryLabel ?? "" };
    }
  }
  return {
    hods: rows.length,
    withPending: rows.filter((r) => r.pending > 0).length,
    pending: rows.reduce((sum, r) => sum + r.pending, 0),
    oldest,
  };
}

/** The totals row: per category the sum over the heads shown (null when not one of them may decide it), and in all. */
export function boardTotals(
  rows: HodRow[],
  categories: HodCategory[],
): { byCategory: Record<string, number | null>; pending: number } {
  const byCategory: Record<string, number | null> = {};
  for (const c of categories) {
    const values = rows.map((r) => r.byCategory[c.key]).filter((v): v is number => typeof v === "number");
    byCategory[c.key] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  }
  return { byCategory, pending: rows.reduce((sum, r) => sum + r.pending, 0) };
}

/** A category cell: "—" when the head may not decide it, else the number. */
export const cellText = (v: number | null | undefined): string => (typeof v === "number" ? String(v) : DASH);

/**
 * The categories worth a column (owner 2026-11-04): only the ones with something pending among the heads shown, so the
 * board, the exports and the share text list just what is waiting; a column of zeros says nothing. Nothing pending at all:
 * no category column (the Total says 0). A head who may not decide a shown kind still reads "—" in it.
 */
export function visibleCategories(rows: HodRow[], categories: HodCategory[]): HodCategory[] {
  return categories.filter((c) => rows.some((r) => (r.byCategory[c.key] ?? 0) > 0));
}

// ─── time ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "today", "1 day", "5 days"; "—" when not known. */
export function waitingText(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return DASH;
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

/** How loud a wait is: under 3 days quiet, 3-6 amber, a week or more red. */
export function waitingTone(days: number | null | undefined): "neutral" | "warning" | "danger" {
  if (days === null || days === undefined) return "neutral";
  if (days >= 7) return "danger";
  return days >= 3 ? "warning" : "neutral";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "04 Nov 2026" (the {{date}} of the reminder). */
export const dayText = (d: Date) => `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** "04 Nov 2026, 10:32". */
export const stampText = (d: Date) => `${dayText(d)}, ${two(d.getHours())}:${two(d.getMinutes())}`;

/** "05 Nov" of an ISO time; "" when there is none. */
export function shortDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${two(d.getDate())} ${MONTHS[d.getMonth()]}`;
}

/** YYYY-MM-DD of a local date, for file names. */
export const fileDay = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

export const hodFileStem = (d: Date) => `hod-pending-approvals-${fileDay(d)}`;

// ─── the drill-down ────────────────────────────────────────────────────────────────────────────────────────────────

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/** Oldest first; a request without a time goes last. */
export function byOldest(a: HodPendingItem, b: HodPendingItem): number {
  const ta = time(a.raisedAt);
  const tb = time(b.raisedAt);
  if (ta && tb && ta !== tb) return ta - tb;
  if (!ta !== !tb) return ta ? -1 : 1;
  return (b.waitingDays ?? -1) - (a.waitingDays ?? -1) || a.id - b.id;
}

export type ItemGroup = { key: string; label: string; items: HodPendingItem[] };

/** A head's pending requests by category, in the board's category order (one the board does not know goes last). */
export function groupItems(items: HodPendingItem[], categories: HodCategory[]): ItemGroup[] {
  const order = new Map(categories.map((c, i) => [c.key, i]));
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    const label = categories.find((c) => c.key === item.category)?.label ?? item.categoryLabel ?? item.category;
    const group = groups.get(item.category) ?? { key: item.category, label, items: [] };
    group.items.push(item);
    groups.set(item.category, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort(byOldest) }))
    .sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999) || a.label.localeCompare(b.label));
}

// ─── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Leave" -> "Leave Requests"; a label that already says so is left alone (the reminder's {{pendingList}} rule). */
export function requestsLabel(label: string): string {
  return /requests?$/i.test(label.trim()) ? label.trim() : `${label.trim()} Requests`;
}

/** The categories with something pending, in order: "Leave 3, Permission 1". */
export function categoryBreakdown(row: Pick<HodRow, "byCategory">, categories: HodCategory[]): string {
  return categories
    .filter((c) => (row.byCategory[c.key] ?? 0) > 0)
    .map((c) => `${c.label} ${row.byCategory[c.key]}`)
    .join(", ");
}

/** "Cutting, Stitching" (or the designation when no department is known). */
export const hodSubline = (row: HodRow) => row.departments.join(", ") || row.designation || "";

/**
 * The board as a message for WhatsApp (bold with *...*): the date and scope, the three figures, then every head with
 * something pending, most first, with their categories. "Copy summary" puts this on the clipboard; Share sends it along.
 */
export function shareSummary(rows: HodRow[], categories: HodCategory[], now: Date, scope = ""): string {
  const figures = hodFigures(rows);
  const lines = [
    `*Pending approvals with HoDs* - ${dayText(now)}`,
    ...(scope ? [scope] : []),
    `${figures.hods} HoD${figures.hods === 1 ? "" : "s"} · ${figures.withPending} with pending · ${figures.pending} request${figures.pending === 1 ? "" : "s"} waiting`,
  ];
  const waiting = sortHods(rows.filter((r) => r.pending > 0));
  if (waiting.length === 0) {
    lines.push("", "Nothing is pending with any HoD.");
  } else {
    lines.push("");
    waiting.forEach((r, i) => {
      const where = r.departments.length ? ` (${r.departments.join(", ")})` : "";
      const oldest = r.oldestDays !== null && r.oldestDays >= 1 ? ` · oldest ${waitingText(r.oldestDays)}` : "";
      lines.push(`${i + 1}. *${r.name}*${where}: ${r.pending}${oldest}`);
      const breakdown = categoryBreakdown(r, categories);
      if (breakdown) lines.push(`   ${breakdown}`);
    });
  }
  return lines.join("\n");
}

/** One line of what narrows the board ("Branch: Unit 1 · Department: Cutting · Search: ravi · Only HoDs with pending"). */
export function scopeText(f: HodFilters, names: { branch?: string; department?: string }): string {
  const parts: string[] = [];
  if (f.branch) parts.push(`Branch: ${names.branch ?? f.branch}`);
  if (f.department) parts.push(`Department: ${names.department ?? f.department}`);
  if (f.query.trim()) parts.push(`Search: ${f.query.trim()}`);
  if (f.onlyPending) parts.push("Only HoDs with pending");
  return parts.join(" · ");
}

// ─── what the exports hold ─────────────────────────────────────────────────────────────────────────────────────────

/** The board's header row in the Excel sheet. */
export function boardHeaders(categories: HodCategory[]): string[] {
  return [
    "#",
    "HoD",
    "Code",
    "Designation",
    "Departments",
    "Branch",
    ...categories.map((c) => c.label),
    "Total",
    "Oldest waiting (days)",
  ];
}

/** The board's rows: one per head, then the totals; a not-allowed category is "—". */
export function boardRows(rows: HodRow[], categories: HodCategory[]): (string | number)[][] {
  const body = rows.map((r, i) => [
    i + 1,
    r.name,
    r.code,
    r.designation ?? "",
    r.departments.join(", "),
    r.branch ?? "",
    ...categories.map((c) => {
      const v = r.byCategory[c.key];
      return typeof v === "number" ? v : DASH;
    }),
    r.pending,
    r.pending > 0 && r.oldestDays !== null ? r.oldestDays : "",
  ]);
  const totals = boardTotals(rows, categories);
  const total = [
    "",
    "Total",
    "",
    "",
    "",
    "",
    ...categories.map((c) => {
      const v = totals.byCategory[c.key];
      return typeof v === "number" ? v : DASH;
    }),
    totals.pending,
    "",
  ];
  return [...body, total];
}

export const DETAIL_HEADERS = [
  "HoD",
  "HoD departments",
  "Category",
  "Employee code",
  "Employee",
  "Department",
  "For",
  "What",
  "Raised on",
  "Waiting (days)",
];

/** Every pending request, head by head (most pending first), each head's oldest first. */
export function detailRows(rows: HodRow[], categories: HodCategory[]): (string | number)[][] {
  const out: (string | number)[][] = [];
  for (const r of sortHods(rows)) {
    for (const group of groupItems(r.items, categories)) {
      for (const item of group.items) {
        out.push([
          r.name,
          r.departments.join(", "),
          group.label,
          item.employeeCode,
          item.employeeName,
          item.department ?? "",
          item.forText,
          item.summary,
          item.raisedAt ? dayText(new Date(item.raisedAt)) : "",
          item.waitingDays ?? "",
        ]);
      }
    }
  }
  return out;
}
