import type { TableColumn } from "@/components/payroll/kit/export-table";
import type { EmployeeRules, PayrollKind, RuleGroup, RuleItem, RuleSource } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { NO_DEPARTMENT, appPath } from "../issues/lists";
import { PRODUCTION_EMPLOYEES_PATH, SHIFTS_PATH, employeeEditPath } from "../skipped/skipped-logic";

// Everything the Rules panel decides, kept free of React so it can be tested on its own: what a flag from the server is
// called, which employees the filters keep, where a rule is changed, which columns the export has.
//
// What the server sends (backend/api/payroll_insights_rules.py):
//   flags   staff: no_shift, no_rate (no salary amount), no_bank
//           production: no_shift, no_rate (no salary per shift), no_cycle, no_bank
//   chips   staff: shift, saturday_off, pf, esi, bank; production: cycle, rate, shift, statutory, bank
//   groups  "Attendance & late detection", "Half day & permissions", "Statutory (PF / ESI)", "Pay basis",
//           "Overtime / Compensation switch" (staff); "Pay cycle", "Attendance mode & late detection",
//           "Statutory (PF / ESI)", "Pay basis" (production)
//
// PF and ESI follow the Settings -> PF & ESI model: they apply only to Co Emp employees (rules with a salary range and a
// percentage, per Staff / Production, global or per unit), and TDS only to employees on the TDS list. The panel does not
// know those rules: it draws whatever groups and chips the server sends, so this file only has to recognise the words
// ("PF", "ESI", "TDS", "Co Emp", "statutory") to pick an icon and a column heading.

// ── Flags: problems with an employee's rule assignment ────────────────────────

/** The flag keys the server sends (`EmployeeRules.flags`) and the words for them. */
export const FLAG_LABELS: Record<string, string> = {
  no_shift: "No shift assigned",
  no_rate: "No rate per shift",
  no_cycle: "Not on a cycle",
  no_bank: "Bank details missing",
  bank_missing: "Bank details missing",
  no_bank_details: "Bank details missing",
  no_salary: "No salary amount",
};

/** "no_pf_number" -> "No pf number": the best words for a key nobody has named yet. */
export function humanizeKey(key: string): string {
  const words = key.replace(/[_\-.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * The words for a flag. `no_rate` is the one flag whose meaning depends on the payroll: for production it is the missing
 * salary per shift, for staff the missing monthly salary (a staff member is not paid per shift), so a staff payroll says so.
 */
export function flagLabel(key: string, kind?: PayrollKind): string {
  if (key === "no_rate" && kind === "staff") return "No salary amount";
  return FLAG_LABELS[key] ?? (humanizeKey(key) || "Problem");
}

/** Flags that leave the employee with no payslip at all are red; the others (a missing shift or bank detail) amber. */
const BLOCKING_FLAGS = new Set(["no_rate", "no_salary", "no_cycle"]);
export const flagTone = (key: string): Tone => (BLOCKING_FLAGS.has(key) ? "danger" : "warning");

// ── The employees table ───────────────────────────────────────────────────────

export type RuleFilterState = {
  q: string;
  /** A department name, NO_DEPARTMENT or "" (every department). */
  dept: string;
  /** Only employees whose rule assignment has a problem (any flag). */
  problemsOnly: boolean;
};

export const NO_RULE_FILTERS: RuleFilterState = { q: "", dept: "", problemsOnly: false };

/** How many filters are on (the switch, the department and the search count one each). */
export const ruleFiltersActive = (f: RuleFilterState): number =>
  (f.q.trim() ? 1 : 0) + (f.dept ? 1 : 0) + (f.problemsOnly ? 1 : 0);

export const hasRuleProblem = (e: EmployeeRules): boolean => e.flags.length > 0;

/**
 * The employees the filters keep. The search matches the name, code, department, designation, the words on the chips
 * (so "night" finds everyone on the night shift) and the flags; every word typed must match somewhere.
 */
export function filterEmployeeRules(list: EmployeeRules[], f: RuleFilterState, kind?: PayrollKind): EmployeeRules[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((e) => {
    if (f.problemsOnly && !hasRuleProblem(e)) return false;
    if (f.dept && (e.department ?? NO_DEPARTMENT) !== f.dept) return false;
    if (words.length === 0) return true;
    const hay = [
      e.employeeName,
      e.employeeCode,
      e.department ?? "",
      e.designation ?? "",
      ...e.chips.map((c) => c.label),
      ...e.flags.map((flag) => flagLabel(flag, kind)),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** How many of the employees have a rule problem. */
export const countRuleProblems = (list: EmployeeRules[]): number => list.filter(hasRuleProblem).length;

/** How many rules a list of groups holds in all. */
export const countRules = (groups: RuleGroup[]): number => groups.reduce((n, g) => n + g.items.length, 0);

// ── Where a rule is changed ───────────────────────────────────────────────────

export const RULE_SOURCE_LABEL: Record<RuleSource, string> = {
  settings: "Settings",
  employee: "Employee profile",
  shift: "Shift",
  cycle: "Pay cycle",
};

export type RuleLink = { href: string; label: string };

/**
 * The page that changes a rule: the Settings address the server sent ("Edit in Settings"), else where its source is
 * managed (the employee's profile, Manage Shifts, Production Employees). A rule with no known place has no link.
 */
export function ruleEditLink(item: RuleItem, employeeId?: number): RuleLink | null {
  const settings = appPath(item.settingsPath);
  if (settings) return { href: settings, label: "Edit in Settings" };
  switch (item.source) {
    case "employee":
      return employeeId !== undefined ? { href: employeeEditPath(employeeId), label: "Edit on profile" } : null;
    case "shift":
      return { href: SHIFTS_PATH, label: "Open Manage Shifts" };
    case "cycle":
      return { href: PRODUCTION_EMPLOYEES_PATH, label: "Open Production Employees" };
    default:
      return null;
  }
}

/** What a group of rules is about, from its name (the server names the groups; this picks the icon). */
export type RuleGroupKind = "late" | "overtime" | "deductions" | "attendance" | "shift" | "cycle" | "pay" | "other";

/** The groups the server names today; any other name is worked out from the words in it. */
const KNOWN_GROUPS: Record<string, RuleGroupKind> = {
  "attendance & late detection": "attendance",
  "attendance mode & late detection": "attendance",
  "half day & permissions": "late",
  "statutory (pf / esi)": "deductions",
  "statutory (pf / esi / tds)": "deductions",
  "pf, esi & tds": "deductions",
  "pf & esi": "deductions",
  tds: "deductions",
  "pay basis": "pay",
  "overtime / compensation switch": "overtime",
  "pay cycle": "cycle",
};

export function ruleGroupKind(name: string): RuleGroupKind {
  const n = name.trim().toLowerCase();
  const known = KNOWN_GROUPS[n];
  if (known) return known;
  if (/^attendance/.test(n)) return "attendance";
  if (/late|early|permission|grace/.test(n)) return "late";
  if (/overtime|\bot\b/.test(n)) return "overtime";
  if (/\bpf\b|\besi\b|\btds\b|\bco emp\b|provident|statutory|deduction|advance|tax/.test(n)) return "deductions";
  if (/attendance|punch|present|absent|half|lunch/.test(n)) return "attendance";
  if (/shift|roster|saturday|holiday/.test(n)) return "shift";
  if (/cycle|period|week|salary day|pay day/.test(n)) return "cycle";
  if (/salary|pay|bonus|earning|rate|compensation/.test(n)) return "pay";
  return "other";
}

// ── Export ────────────────────────────────────────────────────────────────────

/** The kinds of chip the server sends and what a column of them is headed. */
export const CHIP_KIND_LABELS: Record<string, string> = {
  shift: "Shift",
  saturday_off: "Saturday off",
  pf: "PF",
  esi: "ESI",
  tds: "TDS",
  co_emp: "Co Emp",
  pf_esi: "PF / ESI",
  bank: "Bank details",
  cycle: "Pay cycle",
  rate: "Rate per shift",
  statutory: "PF / ESI",
};

export const chipKindLabel = (key: string): string => CHIP_KIND_LABELS[key] ?? (humanizeKey(key) || key);

/** The kinds of chip that occur, in the order first met, with a heading for each. */
export function ruleChipKinds(list: EmployeeRules[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const e of list) for (const c of e.chips) if (!seen.has(c.key)) seen.set(c.key, chipKindLabel(c.key));
  return [...seen].map(([key, label]) => ({ key, label }));
}

/**
 * The table as a sheet: who they are, one column for each kind of rule chip that occurs (a person with two chips of one
 * kind has them joined), and the flags in words.
 */
export function rulesExportColumns(list: EmployeeRules[], kind?: PayrollKind): TableColumn<EmployeeRules>[] {
  return [
    { key: "code", label: "Employee code", width: 16, value: (e) => e.employeeCode },
    { key: "employee", label: "Employee", width: 28, value: (e) => e.employeeName },
    { key: "department", label: "Department", width: 22, value: (e) => e.department ?? "" },
    { key: "designation", label: "Designation", width: 22, value: (e) => e.designation ?? "" },
    ...ruleChipKinds(list).map((chipKind): TableColumn<EmployeeRules> => ({
      key: `chip:${chipKind.key}`,
      label: chipKind.label,
      width: 26,
      value: (e) =>
        e.chips
          .filter((c) => c.key === chipKind.key)
          .map((c) => c.label)
          .join("; "),
    })),
    { key: "flags", label: "Flags", width: 34, value: (e) => e.flags.map((flag) => flagLabel(flag, kind)).join("; ") },
  ];
}
