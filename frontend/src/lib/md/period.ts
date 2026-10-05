// Period and scope selection shared by every MD analytics page, and how they become query-string parameters.

export type PeriodPreset =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "last_12_months"
  | "this_year"
  | "this_fy";

export type PeriodChoice = { preset: PeriodPreset } | { preset: "custom"; from: string; to: string };

export const PRESET_LABEL: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  last_12_months: "Last 12 months",
  this_year: "This year",
  this_fy: "This financial year",
};

/** The presets a page offers, in the order shown. */
export const COMMON_PRESETS: PeriodPreset[] = [
  "today",
  "last_7_days",
  "last_30_days",
  "this_month",
  "last_month",
  "last_90_days",
];

export function periodParams(choice: PeriodChoice): Record<string, string> {
  return choice.preset === "custom" ? { from: choice.from, to: choice.to } : { period: choice.preset };
}

export function isValidCustom(from: string, to: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
}

/** Which part of the company: "" = everyone. Ids are the unit / department ids from /api/md/org. */
export type ScopeChoice = { branch: string; department: string; type: "" | "staff" | "production" };

export const EVERYONE: ScopeChoice = { branch: "", department: "", type: "" };

export function scopeParams(scope: ScopeChoice): Record<string, string> {
  const out: Record<string, string> = {};
  if (scope.branch) out.branch = scope.branch;
  if (scope.department) out.department = scope.department;
  if (scope.type) out.type = scope.type;
  return out;
}

export const scopeIsEveryone = (scope: ScopeChoice) => !scope.branch && !scope.department && !scope.type;

/** A readable sentence for the assistant and for headings: "Unit1 · Stitching · staff only". */
export function describeScope(scope: ScopeChoice, branchName?: string, departmentName?: string): string {
  const parts = [
    scope.branch ? (branchName ?? "one unit") : "All units",
    scope.department ? (departmentName ?? "one department") : "all departments",
    scope.type === "staff" ? "staff only" : scope.type === "production" ? "production only" : "staff and production",
  ];
  return parts.join(" · ");
}
