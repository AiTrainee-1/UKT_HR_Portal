// The Factory Employees page without React: who may do what, the filters and the label tabs, the selection, how a row's
// pay, shift and payroll readiness read, the create / edit forms (their checks and the bodies they send), the payroll
// category and frequency, the labels (their checks, colours and order), the shift assignments, the history and the toasts.
// Everything here is unit-tested in logic.test.ts; the components only wire it to the hooks and the DOM.
//
// Owner 2026-11-20: labels are the categories of factory employees (no departments or designations on this page); shifts
// are only assigned and removed here (created and changed on Manage Shifts); Staff Payroll is monthly and Production
// Payroll is paid on the chosen frequency (Weekly, BiWeekly or Monthly), which is always asked for.

import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  FactoryCandidate,
  FactoryCounts,
  FactoryEmployee,
  FactoryEmployeeRecord,
  FactoryFilters,
  FactoryLabel,
  FactoryLabelInput,
  FactoryMoved,
  FactoryPayCycle,
  FactoryPayrollBody,
  FactoryPayrollCategory,
  FactoryPayrollResult,
  FactoryShift,
  FactoryShiftBody,
  FactoryStatusFilter,
  PermissionLevel,
  PlanResult,
} from "@/lib/api-client/custom-hooks";
import {
  EMPTY_SPLIT,
  checkSplit,
  defaultSplit,
  splitFromBreakup,
  splitPayload,
  type SplitValues,
} from "@/lib/salary-split";

// ── who may do what ──

export type Rights = {
  /** employees.factory edit (and the server agrees): create, add / remove, labels, shifts and payroll on this page. */
  manage: boolean;
  /** Edit an employee's personal details (PATCH /api/employees/<id>: `employees`, and the Edit employee page key). */
  editEmployee: boolean;
  /** Read an employee's full record (the edit form loads it for the salary split on record). */
  readEmployee: boolean;
  /** Activate / deactivate (employees.status). */
  setStatus: boolean;
};

/** The rights of the signed-in login; `serverCanEdit` is the list's `canEdit`. */
export function rightsFor(level: (key: string) => PermissionLevel, serverCanEdit?: boolean): Rights {
  const edit = (k: string) => level(k) === "edit";
  return {
    manage: edit("employees.factory") && serverCanEdit !== false,
    editEmployee: edit("employees") && edit("employees.edit"),
    readEmployee: level("employees") !== "hidden",
    setStatus: edit("employees.status"),
  };
}

// ── the page's sections ──

export type Section = "employees" | "labels" | "shifts";

export const SECTIONS: readonly Section[] = ["employees", "labels", "shifts"];

export const SECTION_LABEL: Record<Section, string> = {
  employees: "Employees",
  labels: "Labels",
  shifts: "Shifts",
};

export const isSection = (v: unknown): v is Section => v === "employees" || v === "labels" || v === "shifts";

/** The section an address asks for (?tab=labels), else Employees (an old ?tab=org too). */
export function sectionFromSearch(search: string): Section {
  const asked = new URLSearchParams(search).get("tab");
  return isSection(asked) ? asked : "employees";
}

// ── payroll category and frequency ──

export const CATEGORY_LABEL: Record<FactoryPayrollCategory, string> = {
  staff: "Staff Payroll",
  production: "Production Payroll",
};

export const categoryOf = (row: { employmentType?: string | null }): FactoryPayrollCategory =>
  (row.employmentType ?? "").toLowerCase() === "production" ? "production" : "staff";

export const PAY_CYCLE_LABEL: Record<FactoryPayCycle, string> = {
  weekly: "Weekly",
  biweekly: "BiWeekly",
  monthly: "Monthly",
};

export const PAY_CYCLE_LIST: readonly FactoryPayCycle[] = ["weekly", "biweekly", "monthly"];

export const isPayCycleValue = (v: unknown): v is FactoryPayCycle =>
  v === "weekly" || v === "biweekly" || v === "monthly";

/** The server's own words when a Production Payroll frequency is missing. */
export const FREQUENCY_REQUIRED = "Choose the Production Payroll frequency: Weekly, BiWeekly or Monthly.";

/** The payroll frequency: Staff Payroll is always Monthly; Production Payroll is its cycle (or none chosen yet). */
export function frequencyText(category: FactoryPayrollCategory, cycle: FactoryPayCycle | null | undefined): string {
  if (category === "staff") return "Monthly";
  return cycle ? PAY_CYCLE_LABEL[cycle] : "No frequency";
}

// ── filters ──

export const ALL = "all";
export const NO_LABEL = "none";

export type CategoryFilter = "all" | FactoryPayrollCategory;

export type Filters = {
  search: string;
  status: FactoryStatusFilter;
  category: CategoryFilter;
};

export const NO_FILTERS: Filters = { search: "", status: "active", category: ALL };

export const isStatusFilter = (v: unknown): v is FactoryStatusFilter =>
  v === "active" || v === "inactive" || v === "all";
export const isCategoryFilter = (v: unknown): v is CategoryFilter => v === "all" || v === "staff" || v === "production";

export const filtersActive = (f: Filters): boolean =>
  f.search.trim() !== "" || f.status !== "active" || f.category !== ALL;

/** What the list request carries. The label is filtered here on the page (the server's counts ignore it anyway), so
 *  switching label tabs is instant and the figures cover every label. */
export function requestFilters(f: Filters, search: string = f.search): FactoryFilters {
  return {
    status: f.status,
    search: search.trim() || undefined,
    employmentType: f.category === ALL ? undefined : f.category,
  };
}

// ── label tabs ──

/** "all", "none" (no label), or a label's id as text. */
export type LabelTab = string;

/** Labels in their order (sortOrder, then name). */
export function sortLabels(labels: readonly FactoryLabel[]): FactoryLabel[] {
  return [...labels].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id,
  );
}

export type LabelTabItem = { value: LabelTab; label: string; count: number; color: string | null };

/** The tab row: All, every label (in order, even the empty ones), and No label. */
export function labelTabs(labels: readonly FactoryLabel[], counts: FactoryCounts | undefined): LabelTabItem[] {
  return [
    { value: ALL, label: "All", count: counts?.total ?? 0, color: null },
    ...sortLabels(labels).map((l) => ({
      value: String(l.id),
      label: l.name,
      count: counts?.byLabel[String(l.id)] ?? 0,
      color: l.color,
    })),
    { value: NO_LABEL, label: "No label", count: counts?.unlabeled ?? 0, color: null },
  ];
}

export function matchesLabel(row: Pick<FactoryEmployee, "labelId">, tab: LabelTab): boolean {
  if (tab === ALL) return true;
  if (tab === NO_LABEL) return row.labelId == null;
  return String(row.labelId) === tab;
}

/** A tab whose label was deleted falls back to All. */
export const validLabelTab = (tab: LabelTab, labels: readonly FactoryLabel[]): LabelTab =>
  tab === ALL || tab === NO_LABEL || labels.some((l) => String(l.id) === tab) ? tab : ALL;

// ── needs attention ──

/** The quick filters the figures open: everyone, or only those payroll skips, or only those with no shift. */
export type Attention = "all" | "payroll" | "shift";

export function matchesAttention(row: FactoryEmployee, attention: Attention): boolean {
  if (attention === "payroll") return !!row.payrollIssue;
  if (attention === "shift") return row.shift == null;
  return true;
}

export type Figures = { total: number; active: number; inactive: number; payroll: number; noShift: number };

/** The figures on the cards: the list as filtered (every label), active people only for the two warnings. */
export function figures(rows: readonly FactoryEmployee[], counts: FactoryCounts | undefined): Figures {
  const active = rows.filter((r) => r.status === "active");
  return {
    total: counts?.total ?? rows.length,
    active: counts?.active ?? active.length,
    inactive: counts?.inactive ?? rows.length - active.length,
    payroll: active.filter((r) => !!r.payrollIssue).length,
    noShift: active.filter((r) => r.shift == null).length,
  };
}

// ── pages ──

export const PAGE_SIZE = 25;

export type PageOf<T> = { rows: T[]; page: number; totalPages: number; from: number; to: number; total: number };

/** The rows of one page; the page number is clamped so a search that shrinks the list never strands the reader. */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number = PAGE_SIZE): PageOf<T> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const start = (safe - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return { rows: slice, page: safe, totalPages, from: total === 0 ? 0 : start + 1, to: start + slice.length, total };
}

export const showingText = (p: Pick<PageOf<unknown>, "from" | "to" | "total">): string =>
  p.total === 0 ? "Showing 0 of 0" : `Showing ${p.from}-${p.to} of ${p.total}`;

// ── selection ──

/** Selected employees by id; whole rows are kept so people ticked under one filter stay actionable after it changes. */
export type Selection = ReadonlyMap<number, FactoryEmployee>;

export const NO_SELECTION: Selection = new Map();

export function toggleRow(selection: Selection, row: FactoryEmployee): Selection {
  const next = new Map(selection);
  if (next.has(row.id)) next.delete(row.id);
  else next.set(row.id, row);
  return next;
}

export function selectRows(selection: Selection, rows: readonly FactoryEmployee[]): Selection {
  const next = new Map(selection);
  for (const row of rows) next.set(row.id, row);
  return next;
}

export function deselectRows(selection: Selection, rows: readonly { id: number }[]): Selection {
  const next = new Map(selection);
  for (const row of rows) next.delete(row.id);
  return next;
}

export type ListSelection = "none" | "some" | "all";

export function listSelection(selection: Selection, rows: readonly FactoryEmployee[]): ListSelection {
  if (rows.length === 0) return "none";
  const n = rows.filter((r) => selection.has(r.id)).length;
  return n === 0 ? "none" : n === rows.length ? "all" : "some";
}

/** The selected rows, refreshed from the current list where it has them. */
export function selectedRows(selection: Selection, rows: readonly FactoryEmployee[]): FactoryEmployee[] {
  const current = new Map(rows.map((r) => [r.id, r]));
  return [...selection.values()].map((r) => current.get(r.id) ?? r);
}

export function hiddenSelected(selection: Selection, rows: readonly FactoryEmployee[]): number {
  const shown = new Set(rows.map((r) => r.id));
  let hidden = 0;
  for (const id of selection.keys()) if (!shown.has(id)) hidden++;
  return hidden;
}

// ── words ──

export const employees = (n: number): string => `${n} ${n === 1 ? "employee" : "employees"}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parseDay = (iso: string | null | undefined): { y: number; m: number; d: number } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= 31 ? day : null;
};

/** "1 Apr 2025"; unreadable dates are shown as sent, none as "". */
export function longDay(iso: string | null | undefined): string {
  const d = parseDay(iso);
  return d ? `${d.d} ${MONTHS[d.m - 1]} ${d.y}` : (iso ?? "");
}

/** "20 Nov 2026, 10:05" in the reader's time; "" for nothing, the text as sent when it is not a time. */
export function whenText(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}, ${hh}:${mm}`;
}

/** "₹18,000" / "₹650.5"; null when there is no amount. */
export function formatRupees(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** What the employee is paid, and how often: "₹18,000 a month · Monthly", "₹650 a shift · Weekly". */
export function payText(row: FactoryEmployee): string {
  const category = categoryOf(row);
  const rate = formatRupees(row.salaryPerShift);
  const salary = formatRupees(row.salaryAmount);
  const amount =
    category === "production"
      ? rate
        ? `${rate} a shift`
        : "No salary per shift"
      : salary
        ? `${salary} a month`
        : "No monthly salary";
  return `${amount} · ${frequencyText(category, row.productionPayCycle)}`;
}

/** The fix a payroll problem has on this page: choose the Production Payroll frequency, or set the salary. */
export type PayrollFix = "cycle" | "salary" | null;

export function payrollFix(row: Pick<FactoryEmployee, "payrollIssue" | "employmentType">): PayrollFix {
  const issue = (row.payrollIssue ?? "").toLowerCase();
  if (!issue) return null;
  if (issue.includes("cycle")) return categoryOf(row) === "production" ? "cycle" : null;
  if (issue.includes("salary")) return "salary";
  return null;
}

/** "General · 09:00-18:00"; "No shift". */
export function shiftText(shift: FactoryShift | null | undefined): string {
  if (!shift) return "No shift";
  const hours = shift.startTime && shift.endTime ? `${shift.startTime}-${shift.endTime}` : null;
  return hours ? `${shift.name} · ${hours}` : shift.name;
}

/** A candidate's second line: their payroll ("Staff Payroll"). */
export function candidateSub(c: FactoryCandidate): string {
  return CATEGORY_LABEL[categoryOf(c)];
}

/** The message of a failed request: the server's own `error` (or `message`), else what the error says. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const data = e.data as { error?: unknown; message?: unknown; errors?: unknown } | null;
    // the permission middleware sends a code in `error` and the sentence in `message`
    const code = typeof data?.error === "string" && /^[a-z_]+$/.test(data.error);
    if (code && typeof data?.message === "string" && data.message) return data.message;
    if (typeof data?.error === "string" && data.error) return data.error;
    if (Array.isArray(data?.errors) && typeof data.errors[0] === "string") return data.errors[0];
    if (typeof data?.message === "string" && data.message) return data.message;
  }
  if (e instanceof Error && e.message) {
    const m = /^HTTP \d+ [^:]*: (.+)$/s.exec(e.message);
    return m ? m[1] : e.message;
  }
  return "Could not reach the server. Check the connection and try again.";
}

// ── labels ──

/** The server's palette: the colours a label can have. */
export const LABEL_PALETTE: readonly string[] = [
  "#2563eb",
  "#0d9488",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#65a30d",
  "#ea580c",
  "#475569",
];

export const LABEL_NAME_MAX = 40;
export const LABEL_DESCRIPTION_MAX = 200;

const COLOR = /^#[0-9a-f]{6}$/i;

/** A colour that is safe to put in a style ("#94a3b8" grey for anything else). */
export const safeColor = (color: string | null | undefined): string => (color && COLOR.test(color) ? color : "#94a3b8");

/** A chip in the label's colour: the colour for the text and border, a pale tint behind. */
export function chipStyle(color: string | null | undefined): {
  color: string;
  backgroundColor: string;
  borderColor: string;
} {
  const c = safeColor(color);
  return { color: c, backgroundColor: `${c}14`, borderColor: `${c}40` };
}

/** The next unused palette colour for a new label (the first again when all are used). */
export function nextColor(labels: readonly FactoryLabel[]): string {
  const used = new Set(labels.map((l) => l.color.toLowerCase()));
  return LABEL_PALETTE.find((c) => !used.has(c)) ?? LABEL_PALETTE[labels.length % LABEL_PALETTE.length];
}

export type LabelForm = { name: string; color: string; description: string };

const tidy = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** What is wrong with a label form (the server's checks), or null. */
export function labelProblem(
  form: LabelForm,
  labels: readonly FactoryLabel[],
  editingId: number | null,
): string | null {
  const name = tidy(form.name);
  if (!name) return "Give the label a name.";
  if (name.length > LABEL_NAME_MAX) return `Keep the label name under ${LABEL_NAME_MAX} characters.`;
  if (labels.some((l) => l.id !== editingId && l.name.trim().toLowerCase() === name.toLowerCase()))
    return `A label called "${name}" already exists.`;
  if (!COLOR.test(form.color)) return "Pick a colour.";
  return null;
}

/** The body of a create (everything) or an edit (only what changed; null when nothing did). */
export function labelBody(form: LabelForm, editing: FactoryLabel | null): FactoryLabelInput | null {
  const name = tidy(form.name);
  const description = form.description.trim().slice(0, LABEL_DESCRIPTION_MAX);
  const color = form.color.toLowerCase();
  if (!editing) return { name, color, description };
  const out: FactoryLabelInput = {};
  if (name !== editing.name) out.name = name;
  if (color !== editing.color.toLowerCase()) out.color = color;
  if (description !== (editing.description ?? "")) out.description = description;
  return Object.keys(out).length ? out : null;
}

/**
 * Moving a label one place up (-1) or down (+1): the new order written as sortOrder 1..n, only for the labels whose number
 * changes. Empty when it cannot move (first up, last down, unknown).
 */
export function moveLabel(
  labels: readonly FactoryLabel[],
  id: number,
  step: -1 | 1,
): { id: number; sortOrder: number }[] {
  const ordered = sortLabels(labels);
  const at = ordered.findIndex((l) => l.id === id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ordered.length) return [];
  const next = [...ordered];
  [next[at], next[to]] = [next[to], next[at]];
  return next.map((l, i) => ({ id: l.id, sortOrder: i + 1 })).filter((c, i) => next[i].sortOrder !== c.sortOrder);
}

/** Owner 2026-11-20: a label is also the employee's department and designation across the HRMS. */
export const LABEL_IS_DEPARTMENT =
  "The label is also the employee's department and designation (e.g. DRIVER) across the HRMS.";

/** The department / designation a label gives: its name in capitals ("Driver" -> "DRIVER"). */
export const labelDepartment = (name: string): string => tidy(name).toUpperCase();

/** Who moved department / designation because of a label, a few lines at most: "F001: department ADMIN -> DRIVER". */
export function movedLines(moved: readonly FactoryMoved[] | undefined, max = 3): string[] {
  const list = moved ?? [];
  const lines = list.slice(0, max).map((m) => `${m.code}: ${m.what}`);
  if (list.length > max) lines.push(`and ${list.length - max} more moved.`);
  return lines;
}

/** The confirmation of a bulk label change: what it does to the department and designation of everyone in it. */
export function labelConfirmWording(
  count: number,
  label: Pick<FactoryLabel, "name"> | null,
): { title: string; lines: string[] } {
  if (!label) {
    return {
      title: `Remove the label from ${employees(count)}?`,
      lines: ["They keep the department and designation they have now, and stay in Factory Employees with no label."],
    };
  }
  const dept = labelDepartment(label.name);
  return {
    title: `Give ${employees(count)} the label ${label.name}?`,
    lines: [
      `The label is also their department and designation: they move to the department ${dept} and the designation ${dept} of their payroll (Staff or Production) and branch, created if it does not exist yet.`,
      `Their Department Head becomes the head of ${dept}; until one is set, their leave and permission requests go to HR.`,
    ],
  };
}

/** A delete the server refused because employees still carry the label: how many (409 {employees}); null otherwise. */
export function labelInUse(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const n = (e.data as { employees?: unknown } | null)?.employees;
  return typeof n === "number" && n >= 0 ? n : 1;
}

// ── the payroll part of a form (create, edit, Set payroll) ──

export type PayrollForm = {
  category: FactoryPayrollCategory;
  /** Production Payroll's frequency; "" = not chosen yet (it must be before saving). */
  payCycle: "" | FactoryPayCycle;
  salaryAmount: string;
  split: SplitValues;
  salaryPerShift: string;
};

export type PayrollField = keyof PayrollForm;

const positive = (v: string) => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n > 0;
};

/**
 * The problems of the payroll part. A Production Payroll frequency is always required. The amount is required when
 * `amountRequired` (a new employee, or a payroll being changed); a typed amount must be more than zero, and a staff
 * salary's split (when the form has one) must be a valid 50% + 50%.
 */
export function payrollProblems(
  form: PayrollForm,
  opts: { amountRequired: boolean; withSplit: boolean },
): Partial<Record<PayrollField, string>> {
  const out: Partial<Record<PayrollField, string>> = {};
  if (form.category === "production") {
    if (!form.payCycle) out.payCycle = FREQUENCY_REQUIRED;
    if (form.salaryPerShift.trim() ? !positive(form.salaryPerShift) : opts.amountRequired)
      out.salaryPerShift = "Enter the salary per shift (more than 0)";
  } else if (form.salaryAmount.trim() ? !positive(form.salaryAmount) : opts.amountRequired) {
    out.salaryAmount = "Enter the monthly salary (more than 0)";
  } else if (opts.withSplit && form.salaryAmount.trim()) {
    const check = checkSplit(form.salaryAmount, form.split);
    if (!check.ok) out.split = check.message ?? "The salary split is not valid";
  }
  return out;
}

/** POST /api/employees/factory/payroll: the category, the frequency (production), and the amount when one is given. */
export function payrollBody(
  employeeIds: readonly number[],
  form: PayrollForm,
  opts: { withSplit: boolean; sendAmount?: boolean },
): FactoryPayrollBody {
  const body: FactoryPayrollBody = { employeeIds: [...employeeIds], category: form.category };
  const send = opts.sendAmount ?? true;
  if (form.category === "production") {
    if (form.payCycle) body.payCycle = form.payCycle;
    if (send && positive(form.salaryPerShift)) body.salaryPerShift = Number(form.salaryPerShift);
  } else if (send && positive(form.salaryAmount)) {
    body.salaryAmount = Number(form.salaryAmount);
    if (opts.withSplit) body.salaryBreakup = splitPayload(form.split);
  }
  return body;
}

/** One toast for a payroll save: who is on which payroll now, who was refused, and what had to be cleared. */
export function payrollToast(
  result: FactoryPayrollResult,
  form: Pick<PayrollForm, "category" | "payCycle">,
): { title: string; lines: string[]; failed: boolean } {
  const target = `${CATEGORY_LABEL[form.category]} (${frequencyText(form.category, form.payCycle || null)})`;
  const n = result.updated.length;
  const title =
    n > 0 ? `${n === 1 ? result.updated[0].name : employees(n)} now on ${target}` : `Nobody was moved to ${target}`;
  const lines: string[] = [];
  for (const r of result.refused.slice(0, 3)) lines.push(`${r.name}: ${r.reason}`);
  if (result.refused.length > 3) lines.push(`and ${result.refused.length - 3} more were not changed.`);
  if (result.cleared.length) {
    const what = result.cleared.slice(0, 3).map((c) => `${c.code}: ${c.what}`);
    const more = result.cleared.length > 3 ? `; and ${result.cleared.length - 3} more` : "";
    lines.push(`Removed because it belongs to the other payroll: ${what.join("; ")}${more}.`);
  }
  lines.push(...movedLines(result.moved));
  return { title, lines, failed: result.refused.length > 0 };
}

// ── the create form ──

export type CreateForm = PayrollForm & {
  employeeCode: string;
  firstName: string;
  lastName: string;
  phone: string;
  gender: string;
  dateOfBirth: string;
  /** A label id as text, "" = no label. */
  labelId: string;
  branchId: string;
  joinDate: string;
  /** An existing shift's id as text, "" = none now. */
  shiftId: string;
  shiftFrom: string;
  saturdayOff: boolean;
  bankName: string;
  bankAccount: string;
  bankIfsc: string;
};

export type CreateField = keyof CreateForm;

export function emptyCreateForm(today: string, labelId = ""): CreateForm {
  return {
    employeeCode: "",
    firstName: "",
    lastName: "",
    phone: "",
    gender: "",
    dateOfBirth: "",
    labelId,
    category: "staff",
    branchId: "",
    joinDate: today,
    salaryAmount: "",
    split: EMPTY_SPLIT,
    salaryPerShift: "",
    payCycle: "",
    shiftId: "",
    shiftFrom: today,
    saturdayOff: false,
    bankName: "",
    bankAccount: "",
    bankIfsc: "",
  };
}

const PHONE = /^\+?[0-9][0-9 -]{8,}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The problems of a create form by field (the Add Employee rules, and the payroll's frequency and amount). */
export function createProblems(form: CreateForm, needsBranch: boolean): Partial<Record<CreateField, string>> {
  const out: Partial<Record<CreateField, string>> = {};
  if (!form.employeeCode.trim()) out.employeeCode = "Employee code is required";
  if (!form.firstName.trim()) out.firstName = "First name is required";
  if (!form.lastName.trim()) out.lastName = "Last name is required";
  if (!form.phone.trim()) out.phone = "Phone is required";
  else if (!PHONE.test(form.phone.trim()) || form.phone.replace(/\D/g, "").length < 10)
    out.phone = "Enter a phone number of at least 10 digits";
  if (needsBranch && !form.branchId)
    out.branchId = "Select a branch: an employee with no branch is hidden from every branch login";
  if (form.joinDate && !DAY.test(form.joinDate)) out.joinDate = "Not a valid date";
  Object.assign(out, payrollProblems(form, { amountRequired: true, withSplit: true }));
  if (form.shiftId && !DAY.test(form.shiftFrom)) out.shiftFrom = "Pick the day the shift starts";
  return out;
}

/** The first problem in form order (the toast of a refused Save). */
export function firstProblem(problems: Partial<Record<string, string>>): string | null {
  const order: string[] = [
    "employeeCode",
    "firstName",
    "lastName",
    "phone",
    "branchId",
    "joinDate",
    "payCycle",
    "salaryAmount",
    "split",
    "salaryPerShift",
    "shiftFrom",
  ];
  for (const k of order) if (problems[k]) return problems[k] as string;
  const any = Object.values(problems).find(Boolean);
  return any ?? null;
}

const orNull = (v: string) => (v.trim() ? v.trim() : undefined);

/** POST /api/employees/factory: the employee create body (NewEmployee.tsx's shape, no department or designation) and
 *  the label. A Production Payroll frequency is set right after, through the payroll endpoint. */
export function createBody(form: CreateForm): Record<string, unknown> {
  const production = form.category === "production";
  const body: Record<string, unknown> = {
    employeeCode: form.employeeCode.trim(),
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    phone: form.phone.trim(),
    gender: orNull(form.gender),
    dateOfBirth: orNull(form.dateOfBirth),
    employmentType: form.category,
    branchId: form.branchId ? Number(form.branchId) : undefined,
    joinDate: orNull(form.joinDate),
    salaryType: "monthly",
    salaryAmount: production ? undefined : Number(form.salaryAmount),
    salaryBreakup: production ? undefined : splitPayload(form.split),
    salaryPerShift: production ? Number(form.salaryPerShift) : undefined,
    bankName: orNull(form.bankName),
    bankAccount: orNull(form.bankAccount),
    bankIfsc: orNull(form.bankIfsc)?.toUpperCase(),
    labelId: form.labelId ? Number(form.labelId) : null,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/** The body of a shift plan / apply on this page: these factory employees on an existing shift from a day. */
export function shiftBody(
  employeeIds: readonly number[],
  shiftId: number,
  effectiveFrom: string,
  saturdayOff: boolean,
): FactoryShiftBody {
  return { shiftId, employeeIds: [...employeeIds], effectiveFrom, saturdayOff };
}

/** One step of a create: the employee, then the payroll frequency (production), then the shift. */
export type StepKey = "create" | "payroll" | "shift";
export type StepResult = { key: StepKey; ok: boolean; title: string; detail: string | null };

export const allStepsOk = (steps: readonly StepResult[]): boolean => steps.every((s) => s.ok);

// ── the edit form ──

export type EditForm = PayrollForm & {
  firstName: string;
  lastName: string;
  phone: string;
  branchId: string;
  joinDate: string;
  status: "active" | "inactive";
};

export type EditField = keyof EditForm;

const amountText = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v)) ? "" : String(v));

/** The split shown for a stored staff employee: the one on record, else the automatic one as a suggestion. */
export function storedSplit(record: FactoryEmployeeRecord): { split: SplitValues; recorded: boolean } {
  const stored = splitFromBreakup(record.salaryBreakup ?? null);
  if (stored) return { split: stored, recorded: true };
  const staffWithSalary = categoryOf(record) === "staff" && !!record.salaryAmount;
  return { split: (staffWithSalary ? defaultSplit(record.salaryAmount) : null) ?? EMPTY_SPLIT, recorded: false };
}

/** The edit form from the employee record, and the production frequency (from their list row). */
export function editFormFrom(record: FactoryEmployeeRecord, cycle: FactoryPayCycle | null = null): EditForm {
  const category = categoryOf(record);
  return {
    firstName: record.firstName ?? "",
    lastName: record.lastName ?? "",
    phone: record.phone ?? "",
    branchId: record.branchId ? String(record.branchId) : "",
    joinDate: (record.joinDate ?? "").slice(0, 10),
    status: (record.status ?? "active").toLowerCase() === "active" ? "active" : "inactive",
    category,
    payCycle: category === "production" && cycle ? cycle : "",
    salaryAmount: amountText(record.salaryAmount),
    split: storedSplit(record).split,
    salaryPerShift: amountText(record.salaryPerShift),
  };
}

/** A record built from the list row, for a login that may not read the full employee record (no split on record). */
export function recordFromRow(row: FactoryEmployee): FactoryEmployeeRecord {
  return {
    id: row.id,
    employeeCode: row.code,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    employmentType: row.employmentType,
    branchId: row.branchId,
    salaryAmount: row.salaryAmount,
    salaryBreakup: null,
    salaryPerShift: row.salaryPerShift,
    status: row.status,
    joinDate: row.joinDate,
  };
}

const sameSplit = (a: SplitValues, b: SplitValues) =>
  (Object.keys(a) as (keyof SplitValues)[]).every((k) => Number(a[k] || 0) === Number(b[k] || 0));

const amountChanged = (form: EditForm, before: EditForm, splitRecorded: boolean): boolean =>
  form.category === "production"
    ? Number(form.salaryPerShift || 0) !== Number(before.salaryPerShift || 0)
    : Number(form.salaryAmount || 0) !== Number(before.salaryAmount || 0) ||
      (!!form.salaryAmount.trim() && (!sameSplit(form.split, before.split) || !splitRecorded));

/** Whether the payroll part was changed: category, frequency, amount or (staff) split. */
export function payrollChanged(form: EditForm, before: EditForm, splitRecorded: boolean): boolean {
  if (form.category !== before.category) return true;
  if (form.category === "production" && form.payCycle !== before.payCycle) return true;
  return amountChanged(form, before, splitRecorded);
}

/** The problems of an edit: the personal details (when they can be edited) and the payroll (when it can be). A
 *  Production Payroll frequency is always asked for; the amounts only when the payroll is being changed. */
export function editProblems(
  form: EditForm,
  before: EditForm,
  opts: { needsBranch: boolean; personal: boolean; payroll: boolean; splitRecorded: boolean },
): Partial<Record<EditField, string>> {
  const out: Partial<Record<EditField, string>> = {};
  if (opts.personal) {
    if (!form.firstName.trim()) out.firstName = "First name is required";
    if (!form.lastName.trim()) out.lastName = "Last name is required";
    if (!form.phone.trim()) out.phone = "Phone is required";
    else if (form.phone.replace(/\D/g, "").length < 10) out.phone = "Enter a phone number of at least 10 digits";
    if (opts.needsBranch && !form.branchId) out.branchId = "Select a branch";
    if (form.joinDate && !DAY.test(form.joinDate)) out.joinDate = "Not a valid date";
  }
  if (opts.payroll) {
    const changed = payrollChanged(form, before, opts.splitRecorded);
    const problems = payrollProblems(form, { amountRequired: changed, withSplit: true });
    if (problems.payCycle) out.payCycle = problems.payCycle;
    if (changed) Object.assign(out, problems);
  }
  return out;
}

/** PATCH /api/employees/<id>: only the personal details that changed (the payroll goes to its own endpoint); null when
 *  nothing changed. A branch login never sends the branch. */
export function personalBody(
  form: EditForm,
  before: EditForm,
  opts: { sendBranch: boolean },
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (form.firstName.trim() !== before.firstName) out.firstName = form.firstName.trim();
  if (form.lastName.trim() !== before.lastName) out.lastName = form.lastName.trim();
  if (form.phone.trim() !== before.phone) out.phone = form.phone.trim();
  if (opts.sendBranch && form.branchId !== before.branchId) out.branchId = form.branchId ? Number(form.branchId) : null;
  if (form.joinDate !== before.joinDate && form.joinDate) out.joinDate = form.joinDate;
  return Object.keys(out).length ? out : null;
}

/** The payroll body of an edit, or null when the payroll part did not change. The amount goes only when it changed (a
 *  staff salary with its split; a split not on record yet is recorded). */
export function editPayrollBody(
  id: number,
  form: EditForm,
  before: EditForm,
  splitRecorded: boolean,
): FactoryPayrollBody | null {
  if (!payrollChanged(form, before, splitRecorded)) return null;
  return payrollBody([id], form, { withSplit: true, sendAmount: amountChanged(form, before, splitRecorded) });
}

/** Whether the edit also changes the status (sent to the status endpoint after the save). */
export const statusChanged = (form: EditForm, before: EditForm): boolean => form.status !== before.status;

// ── shifts ──

/** The toast of a shift apply: "General assigned to 3 employees" and what else happened. */
export function shiftApplyToast(
  result: PlanResult,
  names: ReadonlyMap<number, string> = new Map(),
): {
  title: string;
  lines: string[];
  failed: boolean;
} {
  const a = result.applied;
  const done = a?.assigned ?? 0;
  const shift = result.shift?.name ?? "The shift";
  const title = done > 0 ? `${shift} assigned to ${employees(done)}` : `Nobody was put on ${shift}`;
  const lines: string[] = [];
  if (a?.unchanged) lines.push(`${a.unchanged} already on it.`);
  const left = result.rows.filter((r) => r.status === "skipped" || r.status === "blocked");
  if (left.length) {
    const shown = left
      .slice(0, 3)
      .map((r) => `${names.get(r.employeeId) ?? r.name}: ${r.reason ?? "cannot be given this shift"}`);
    const more = left.length - shown.length;
    lines.push(`Not changed: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`);
  }
  return { title, lines, failed: done === 0 && left.length > 0 };
}

/** The toast of taking people off their shift. */
export function shiftRemoveToast(result: { ended: number; cancelled: number }, lastDay: string): string {
  const parts: string[] = [];
  if (result.ended) parts.push(`${employees(result.ended)} taken off their shift after ${longDay(lastDay)}`);
  if (result.cancelled) parts.push(`${result.cancelled} upcoming shift${result.cancelled === 1 ? "" : "s"} cancelled`);
  return parts.length ? parts.join("; ") : "Nobody was on a shift";
}

/** The shifts one kind of employee can be given (a staff shift for staff, a production one for production). */
export function shiftsFor<T extends { shiftType: string; isActive?: boolean }>(
  shifts: readonly T[],
  category: FactoryPayrollCategory,
): T[] {
  return shifts.filter((s) => s.isActive !== false && s.shiftType === category);
}

/** The categories in a set of employees (a shift is given to one kind at a time). */
export function categoriesIn(rows: readonly { employmentType?: string | null }[]): FactoryPayrollCategory[] {
  const found = new Set(rows.map(categoryOf));
  return (["staff", "production"] as const).filter((c) => found.has(c));
}

// ── history ──

const ACTION_LABEL: Record<string, string> = {
  create: "Created",
  update: "Changed",
  delete: "Deleted",
  approve: "Approved",
  reject: "Rejected",
};

export const actionLabel = (action: string): string =>
  ACTION_LABEL[action.toLowerCase()] ?? (action ? action.charAt(0).toUpperCase() + action.slice(1) : "Changed");

// ── empty list ──

export type EmptyInfo = { title: string; hint: string; action: "clear" | "add" | "all-labels" | null };

export function emptyInfo(opts: {
  total: number;
  filtered: boolean;
  labelTab: LabelTab;
  labelName: string | null;
  attention: Attention;
  manage: boolean;
}): EmptyInfo {
  if (opts.total === 0 && !opts.filtered) {
    return {
      title: "No factory employees yet",
      hint: opts.manage
        ? "Create a new factory employee, or add people who are already employees (drivers, housekeeping, chefs, security...)."
        : "Nobody has been added to Factory Employees yet.",
      action: opts.manage ? "add" : null,
    };
  }
  if (opts.filtered || opts.attention !== "all") {
    return { title: "Nothing matches", hint: "Try fewer words, or clear the filters.", action: "clear" };
  }
  if (opts.labelTab === NO_LABEL) {
    return {
      title: "Everyone has a label",
      hint: "Every factory employee in this view carries a label.",
      action: "all-labels",
    };
  }
  return {
    title: `Nobody has the label ${opts.labelName ?? ""}`.trim(),
    hint: "Select employees on All, then use Assign label.",
    action: "all-labels",
  };
}
