import type { TableColumn } from "@/components/payroll/kit/export-table";
import { monthYear, periodLabel, plural } from "@/components/payroll/kit/format";
import type { Tone } from "@/lib/statusTones";
import { byText } from "../issues/lists";
import type { SkipCategory, SkipClassification, SkipLink, SkippedItem } from "./skipped-types";

// Everything the Skipped Employees panel decides, kept free of React so it can be tested on its own.
//
// The reasons are the payroll engine's own messages (backend/api/payroll_views.py `PayrollSkip(...)` and
// `_dry_run_skip_reason`, backend/api/production_payroll_views.py `_classify`, `_select` and the roster's blockedReason):
//
//   staff       "No Salary Amount set on this employee's profile"
//               "No working days found in 10/2026 for this employee's shift (check Holidays and Saturday-off configuration)"
//   production  "No Salary Per Shift set on this employee's profile"
//               "Already paid for this period."
//               "Overlaps the payroll already generated for 2026-02-01 to 2026-02-14."
//               "Not a production employee in your scope."
//               "Not an active employee."
//               "Not assigned to the Weekly cycle (assigned to BiWeekly)." / "(assigned to no pay cycle)."
//   both        whatever an unexpected engine failure says (the exception text) -> "Other"

// Real pages of the HRMS (frontend/src/App.tsx).
export const EMPLOYEES_PATH = "/hr/employees";
export const PRODUCTION_EMPLOYEES_PATH = "/hr/employees/productionEmployee";
export const SHIFTS_PATH = "/hr/shifts";
export const HOLIDAYS_PATH = "/hr/leave?tab=holidays";
export const STAFF_PAYROLL_PATH = "/hr/payroll";
export const employeePath = (id: number) => `/hr/employees/${id}`;
export const employeeEditPath = (id: number) => `/hr/employees/${id}/edit`;

type Guide = {
  label: string;
  tone: Tone;
  blocksPay: boolean;
  /** The category's general advice (the cards); a reason that carries specifics gets a more precise sentence. */
  fix: string;
  href?: string;
  hrefLabel?: string;
  secondary?: SkipLink;
};

/** The categories in the order they are listed when several have the same count. */
export const SKIP_CATEGORY_ORDER: SkipCategory[] = [
  "no_salary",
  "no_rate",
  "no_working_days",
  "no_cycle",
  "wrong_cycle",
  "overlap",
  "inactive",
  "not_production",
  "already_paid",
  "other",
];

export const SKIP_GUIDE: Record<SkipCategory, Guide> = {
  no_salary: {
    label: "No salary amount",
    tone: "danger",
    blocksPay: true,
    fix: "Enter the employee's monthly salary on their profile, then check again.",
    href: EMPLOYEES_PATH,
    hrefLabel: "Open Employees",
  },
  no_rate: {
    label: "No salary per shift",
    tone: "danger",
    blocksPay: true,
    fix: "Enter the salary per shift on the employee's profile (production employees are paid per shift), then check again.",
    href: PRODUCTION_EMPLOYEES_PATH,
    hrefLabel: "Open Production Employees",
  },
  no_working_days: {
    label: "No working days",
    tone: "danger",
    blocksPay: true,
    fix: "Every day of the month is a holiday or an off day for this employee's shift. Check the holidays and the Saturday-off setting of the shift.",
    href: SHIFTS_PATH,
    hrefLabel: "Open Manage Shifts",
    secondary: { href: HOLIDAYS_PATH, label: "Holidays" },
  },
  no_cycle: {
    label: "No pay cycle",
    tone: "warning",
    blocksPay: true,
    fix: "The employee is on no pay cycle, so no cycle's payroll includes them. Assign Weekly, BiWeekly or Monthly on Production Employees.",
    href: PRODUCTION_EMPLOYEES_PATH,
    hrefLabel: "Open Production Employees",
  },
  wrong_cycle: {
    label: "On another pay cycle",
    tone: "warning",
    blocksPay: true,
    fix: "The employee is on a different pay cycle than this page. Assign them to this cycle on Production Employees, or generate them from their own cycle's page.",
    href: PRODUCTION_EMPLOYEES_PATH,
    hrefLabel: "Open Production Employees",
  },
  overlap: {
    label: "Overlaps another payslip",
    tone: "warning",
    blocksPay: true,
    fix: "Some of these days are already in another payslip of the employee. Finish that payslip first, or generate the period that follows it.",
  },
  inactive: {
    label: "Inactive employee",
    tone: "warning",
    blocksPay: true,
    fix: "Payroll covers active employees only. Make the employee active on their profile if they should be paid.",
    href: EMPLOYEES_PATH,
    hrefLabel: "Open Employees",
  },
  not_production: {
    label: "Not a production employee",
    tone: "warning",
    blocksPay: true,
    fix: "Only production employees in your branch are paid here. Staff employees are paid on Staff Payroll.",
    href: STAFF_PAYROLL_PATH,
    hrefLabel: "Open Staff Payroll",
  },
  already_paid: {
    label: "Already paid",
    tone: "info",
    blocksPay: false,
    fix: "Nothing to fix: this period is already paid, and a paid payslip is never recomputed.",
  },
  other: {
    label: "Other",
    tone: "neutral",
    blocksPay: true,
    fix: "Payroll stopped with the message shown. Check the employee's salary, shift and attendance records, then check again.",
    href: EMPLOYEES_PATH,
    hrefLabel: "Open Employees",
  },
};

type Override = Partial<Pick<SkipClassification, "fix" | "href" | "hrefLabel" | "secondary">>;

function build(category: SkipCategory, over: Override = {}): SkipClassification {
  const guide = SKIP_GUIDE[category];
  const out: SkipClassification = {
    category,
    label: guide.label,
    tone: guide.tone,
    blocksPay: guide.blocksPay,
    fix: over.fix ?? guide.fix,
  };
  const href = over.href ?? guide.href;
  const hrefLabel = over.hrefLabel ?? guide.hrefLabel;
  const secondary = over.secondary ?? guide.secondary;
  if (href) out.href = href;
  if (hrefLabel) out.hrefLabel = hrefLabel;
  if (secondary) out.secondary = secondary;
  return out;
}

/**
 * What a skip reason means and what to do about it. Pass the employee's id to get a link straight to their own profile;
 * without it the link goes to the list page that shows everyone. An unrecognised message is "Other" (the panel still
 * shows the message itself, so nothing is hidden).
 */
export function classifySkipReason(reason: string, employeeId?: number): SkipClassification {
  const text = (reason ?? "").replace(/\s+/g, " ").trim();
  const profile: Override =
    employeeId !== undefined ? { href: employeeEditPath(employeeId), hrefLabel: "Open profile" } : {};

  if (/^no salary amount set/i.test(text)) return build("no_salary", profile);
  if (/^no salary per shift set/i.test(text)) return build("no_rate", profile);

  const noDays = /^no working days found(?: in (\d{1,2})\/(\d{4}))?/i.exec(text);
  if (noDays) {
    const when = noDays[1] && noDays[2] ? monthYear(Number(noDays[1]), Number(noDays[2])) : "the month";
    return build("no_working_days", {
      fix: `Every day of ${when} is a holiday or an off day for this employee's shift. Check the holidays and the Saturday-off setting of the shift.`,
    });
  }

  if (/^already paid/i.test(text)) return build("already_paid");

  const overlap = /^overlaps the payroll already generated for (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/i.exec(text);
  if (overlap) {
    return build("overlap", {
      fix: `Some of these days are already in the payslip for ${periodLabel(overlap[1], overlap[2])}. Finish that payslip first, or generate the period that follows it.`,
    });
  }

  if (/^not a production employee/i.test(text)) return build("not_production");
  if (/^not an active employee/i.test(text)) return build("inactive", profile);

  const cycle = /^not assigned to the (.+?) cycle \(assigned to (.+?)\)/i.exec(text);
  if (cycle) {
    const [, target, current] = cycle;
    if (/^no pay cycle$/i.test(current)) {
      return build("no_cycle", {
        fix: `They are on no pay cycle, so no cycle's payroll includes them. Assign them to ${target} on Production Employees.`,
      });
    }
    return build("wrong_cycle", {
      fix: `They are on ${current}, not ${target}. Assign them to ${target} on Production Employees, or generate them from the ${current} page.`,
    });
  }

  return build("other", employeeId !== undefined ? { href: employeePath(employeeId), hrefLabel: "Open employee" } : {});
}

// ── The list ──────────────────────────────────────────────────────────────────

/** A skipped employee with what their reason means. */
export type SkippedRow = SkippedItem & { info: SkipClassification };

/** Each skipped employee classified (with a link to their own profile), grouped by category then by name. */
export function classifySkipped(items: SkippedItem[] | undefined): SkippedRow[] {
  const seen = new Set<number>();
  const rows: SkippedRow[] = [];
  for (const item of items ?? []) {
    if (seen.has(item.employeeId)) continue; // one line per employee
    seen.add(item.employeeId);
    rows.push({ ...item, info: classifySkipReason(item.reason, item.employeeId) });
  }
  const rank = (c: SkipCategory) => SKIP_CATEGORY_ORDER.indexOf(c);
  return rows.sort((a, b) => rank(a.info.category) - rank(b.info.category) || byText(a.name, b.name));
}

/** One card of the reasons strip: a category, how many employees are in it and the general advice. */
export type SkipCategoryCard = {
  category: SkipCategory;
  label: string;
  tone: Tone;
  blocksPay: boolean;
  count: number;
  fix: string;
  href?: string;
  hrefLabel?: string;
  secondary?: SkipLink;
};

/** The categories that occur, biggest first (ties in the order of SKIP_CATEGORY_ORDER). */
export function skipCategoryCards(rows: SkippedRow[]): SkipCategoryCard[] {
  const counts = new Map<SkipCategory, number>();
  for (const row of rows) counts.set(row.info.category, (counts.get(row.info.category) ?? 0) + 1);
  return [...counts]
    .map(([category, count]): SkipCategoryCard => {
      const guide = SKIP_GUIDE[category];
      const card: SkipCategoryCard = {
        category,
        label: guide.label,
        tone: guide.tone,
        blocksPay: guide.blocksPay,
        count,
        fix: guide.fix,
      };
      if (guide.href) card.href = guide.href;
      if (guide.hrefLabel) card.hrefLabel = guide.hrefLabel;
      if (guide.secondary) card.secondary = guide.secondary;
      return card;
    })
    .sort(
      (a, b) => b.count - a.count || SKIP_CATEGORY_ORDER.indexOf(a.category) - SKIP_CATEGORY_ORDER.indexOf(b.category),
    );
}

export type SkipFilterState = { q: string; category: string };
export const NO_SKIP_FILTERS: SkipFilterState = { q: "", category: "" };

export function skipFiltersActive(f: SkipFilterState): number {
  return (f.q.trim() ? 1 : 0) + (f.category ? 1 : 0);
}

/** Search over name, code, department, the reason and the category name; every word typed must match somewhere. */
export function filterSkipped(rows: SkippedRow[], f: SkipFilterState): SkippedRow[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (f.category && row.info.category !== f.category) return false;
    if (words.length === 0) return true;
    const hay = `${row.name} ${row.employeeCode} ${row.department ?? ""} ${row.reason} ${row.info.label}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ── The banner ────────────────────────────────────────────────────────────────

export type SkipSummary = {
  /** success: nobody is skipped; danger: someone is left unpaid; info: they are skipped, but nobody is left unpaid. */
  tone: "success" | "danger" | "info";
  title: string;
  hint: string;
  count: number;
};

/** The sentence at the top: "5 of 42 employees were skipped" or "Nobody is skipped", and what it means. */
export function skipSummary(
  items: SkippedItem[] | undefined,
  totalChecked: number | undefined,
  period: string,
): SkipSummary {
  const rows = classifySkipped(items);
  const count = rows.length;
  if (count === 0) {
    return {
      tone: "success",
      title: "Nobody is skipped",
      hint:
        totalChecked === 0
          ? `There are no employees to check for ${period}.`
          : totalChecked !== undefined
            ? `All ${totalChecked} ${totalChecked === 1 ? "employee" : "employees"} can be paid for ${period}.`
            : `Everyone can be paid for ${period}.`,
      count,
    };
  }
  // "5 of 42 employees were skipped" (the noun after "of" is always plural), or "1 employee was skipped" without a total.
  const who =
    totalChecked !== undefined && totalChecked >= count
      ? `${count} of ${totalChecked} employees`
      : plural(count, "employee");
  const title = `${who} ${count === 1 ? "was" : "were"} skipped`;
  const them = count === 1 ? "this employee" : "them";
  const unpaid = rows.some((r) => r.info.blocksPay);
  return {
    tone: unpaid ? "danger" : "info",
    title,
    hint: unpaid
      ? `No payroll is generated for ${them} for ${period}, so they are not paid until ${
          count === 1 ? "the reason below is" : "each reason below is"
        } fixed.`
      : `Nothing is left to pay for ${them} for ${period}.`,
    count,
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

export const skippedExportColumns: TableColumn<SkippedRow>[] = [
  { key: "code", label: "Employee code", width: 16, value: (r) => r.employeeCode },
  { key: "name", label: "Employee", width: 28, value: (r) => r.name },
  { key: "department", label: "Department", width: 22, value: (r) => r.department ?? "" },
  { key: "reason", label: "Reason", width: 60, value: (r) => r.reason },
  { key: "category", label: "Category", width: 24, value: (r) => r.info.label },
  { key: "fix", label: "How to fix", width: 70, value: (r) => r.info.fix },
];
