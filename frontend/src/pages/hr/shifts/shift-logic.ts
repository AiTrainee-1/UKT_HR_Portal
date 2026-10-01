import type {
  AssignRequest,
  ConflictDecision,
  GenderRule,
  PlanCounts,
  PlanResult,
  PlanRow,
  PlanStatus,
  ShiftAssignment,
  ShiftFormPayload,
  ShiftItem,
  ShiftSelection,
  ShiftType,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

// The logic of the Manage Shifts screen, kept out of the components so it can be tested. The rules themselves are the
// server's (backend/api/shift_views.py validate_template and shift_planner.py); the form validation here repeats the
// template rules only so a mistake is shown while typing, and the server still checks them.

// ── dates ────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** Today as YYYY-MM-DD in the browser's own time zone (toISOString would give yesterday's date before 05:30 in India). */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return todayIso(date);
}

/** '01 Oct 2026' for a YYYY-MM-DD string. */
export function prettyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${pad(d)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

// ── the shift form ───────────────────────────────────────────────────────────

export type ShiftForm = {
  name: string;
  shiftType: ShiftType;
  genderRule: GenderRule;
  startTime: string;
  endTime: string;
  gracePeriodMinutes: string;
  firstHalfEnd: string;
  lunchDurationMinutes: string;
  lunchGraceMinutes: string;
};

export type FormErrors = Partial<Record<keyof ShiftForm, string>>;

export const MIN_SHIFT_MINUTES = 60;

export function emptyShiftForm(shiftType: ShiftType): ShiftForm {
  return {
    name: "",
    shiftType,
    genderRule: "all",
    startTime: "09:00",
    endTime: shiftType === "staff" ? "19:00" : "20:00",
    gracePeriodMinutes: "15",
    firstHalfEnd: "13:30",
    lunchDurationMinutes: "60",
    lunchGraceMinutes: "10",
  };
}

export function formFromShift(s: ShiftItem): ShiftForm {
  return {
    name: s.name,
    shiftType: s.shiftType,
    genderRule: s.genderRule,
    startTime: s.startTime ?? "",
    endTime: s.endTime ?? "",
    gracePeriodMinutes: String(s.gracePeriodMinutes ?? 15),
    firstHalfEnd: s.firstHalfEnd ?? "",
    lunchDurationMinutes: String(s.lunchDurationMinutes ?? 60),
    lunchGraceMinutes: String(s.lunchGraceMinutes ?? 10),
  };
}

export function toMinutes(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/** '10h', '8h 30m' for a shift's length; null when the times are not (yet) a valid pair. */
export function durationLabel(start: string, end: string): string | null {
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === null || b === null || b <= a) return null;
  const mins = b - a;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Where a shift sits in the day as percentages of 24 hours, for the little timeline bar. */
export function timelineBar(start: string, end: string): { left: number; width: number } {
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === null || b === null || b <= a) return { left: 0, width: 0 };
  return { left: (a / 1440) * 100, width: ((b - a) / 1440) * 100 };
}

const wholeNumber = (raw: string, lo: number, hi: number, label: string): string | null => {
  if (raw.trim() === "" || !/^\d+$/.test(raw.trim())) return `${label} must be a whole number`;
  const n = Number(raw);
  return n < lo || n > hi ? `${label} must be between ${lo} and ${hi}` : null;
};

/** The template rules, repeated from the server so a mistake shows while typing. `others` are the shifts that exist (a
 *  name is unique per type, ignoring case); `editingId` leaves the shift being edited out of that check. */
export function validateShiftForm(f: ShiftForm, others: ShiftItem[], editingId: number | null = null): FormErrors {
  const errors: FormErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = "Shift name is required";
  else if (name.length > 80) errors.name = "Shift name can be at most 80 characters";
  else if (
    others.some(
      (o) => o.id !== editingId && o.shiftType === f.shiftType && o.name.trim().toLowerCase() === name.toLowerCase(),
    )
  ) {
    errors.name = `A ${f.shiftType} shift called '${name}' already exists`;
  }

  if (f.shiftType === "production" && f.genderRule !== "all")
    errors.genderRule = "Production shifts apply to every gender";

  const start = toMinutes(f.startTime);
  const end = toMinutes(f.endTime);
  if (start === null) errors.startTime = "Start time is required";
  if (end === null) errors.endTime = "End time is required";
  if (start !== null && end !== null) {
    if (end <= start) errors.endTime = "A shift cannot end before it starts. Overnight shifts are not supported";
    else if (end - start < MIN_SHIFT_MINUTES) errors.endTime = "A shift must be at least 1 hour long";
  }

  const grace = wholeNumber(f.gracePeriodMinutes, 0, 60, "Grace period");
  if (grace) errors.gracePeriodMinutes = grace;

  if (f.shiftType === "staff") {
    const half = toMinutes(f.firstHalfEnd);
    if (f.firstHalfEnd.trim() !== "" && start !== null && end !== null) {
      if (half === null || !(start < half && half < end)) {
        errors.firstHalfEnd = "The first half must end between the start and the end of the shift";
      }
    }
    const lunch = wholeNumber(f.lunchDurationMinutes, 15, 120, "Lunch duration");
    if (lunch) errors.lunchDurationMinutes = lunch;
    const lunchGrace = wholeNumber(f.lunchGraceMinutes, 0, 30, "Lunch grace");
    if (lunchGrace) errors.lunchGraceMinutes = lunchGrace;
  }
  return errors;
}

export const isValid = (errors: FormErrors) => Object.keys(errors).length === 0;

export function formPayload(f: ShiftForm): ShiftFormPayload {
  const base = {
    name: f.name.trim(),
    shiftType: f.shiftType,
    startTime: f.startTime,
    endTime: f.endTime,
    genderRule: f.shiftType === "production" ? ("all" as const) : f.genderRule,
    gracePeriodMinutes: Number(f.gracePeriodMinutes),
  };
  return f.shiftType === "staff"
    ? {
        ...base,
        firstHalfEnd: f.firstHalfEnd.trim() || null,
        lunchDurationMinutes: Number(f.lunchDurationMinutes),
        lunchGraceMinutes: Number(f.lunchGraceMinutes),
      }
    : { ...base, firstHalfEnd: null };
}

// ── choosing who gets the shift ──────────────────────────────────────────────

export type RuleKind = "employee" | "department" | "designation";
export type RuleMode = "include" | "exclude";

export type Rule = {
  kind: RuleKind;
  id: number;
  label: string;
  sub?: string;
  mode: RuleMode;
};

export const KIND_LABEL: Record<RuleKind, { one: string; many: string }> = {
  employee: { one: "employee", many: "employees" },
  department: { one: "department", many: "departments" },
  designation: { one: "designation", many: "designations" },
};

export const ruleOf = (rules: Rule[], kind: RuleKind, id: number) => rules.find((r) => r.kind === kind && r.id === id);

/** Adds the rule, or changes the mode of the one already there for the same employee / department / designation. */
export function setRule(rules: Rule[], rule: Rule): Rule[] {
  return ruleOf(rules, rule.kind, rule.id)
    ? rules.map((r) => (r.kind === rule.kind && r.id === rule.id ? { ...r, mode: rule.mode } : r))
    : [...rules, rule];
}

export const removeRule = (rules: Rule[], kind: RuleKind, id: number) =>
  rules.filter((r) => !(r.kind === kind && r.id === id));

export const flipRule = (rules: Rule[], kind: RuleKind, id: number): Rule[] =>
  rules.map((r) =>
    r.kind === kind && r.id === id
      ? { ...r, mode: r.mode === "include" ? ("exclude" as const) : ("include" as const) }
      : r,
  );

const ids = (rules: Rule[], kind: RuleKind, mode: RuleMode) =>
  rules.filter((r) => r.kind === kind && r.mode === mode).map((r) => r.id);

export function selectionOf(rules: Rule[], includeAll: boolean): ShiftSelection {
  return {
    includeAll,
    employees: { include: ids(rules, "employee", "include"), exclude: ids(rules, "employee", "exclude") },
    departments: { include: ids(rules, "department", "include"), exclude: ids(rules, "department", "exclude") },
    designations: { include: ids(rules, "designation", "include"), exclude: ids(rules, "designation", "exclude") },
  };
}

/** Something is included: everyone of the shift's type, or at least one employee / department / designation. */
export const hasSelection = (rules: Rule[], includeAll: boolean) =>
  includeAll || rules.some((r) => r.mode === "include");

export function ruleCounts(rules: Rule[]) {
  return {
    include: rules.filter((r) => r.mode === "include").length,
    exclude: rules.filter((r) => r.mode === "exclude").length,
    byKind: {
      employee: rules.filter((r) => r.kind === "employee").length,
      department: rules.filter((r) => r.kind === "department").length,
      designation: rules.filter((r) => r.kind === "designation").length,
    } satisfies Record<RuleKind, number>,
  };
}

// ── the request ──────────────────────────────────────────────────────────────

export type AssignState = {
  shiftId: number | null;
  effectiveFrom: string;
  rules: Rule[];
  includeAll: boolean;
  customStartTime: string;
  customEndTime: string;
  saturdayOff: boolean;
  notes: string;
  onConflict: ConflictDecision;
  decisions: Record<string, ConflictDecision>;
};

export function buildRequest(s: AssignState): AssignRequest {
  return {
    shiftId: s.shiftId,
    effectiveFrom: s.effectiveFrom,
    selection: selectionOf(s.rules, s.includeAll),
    customStartTime: s.customStartTime || null,
    customEndTime: s.customEndTime || null,
    saturdayOff: s.saturdayOff,
    notes: s.notes.trim() || null,
    onConflict: s.onConflict,
    decisions: s.decisions,
  };
}

/** Worth asking the server for a preview: a shift, a date and somebody included. */
export const canPreview = (s: AssignState) =>
  s.shiftId !== null && s.effectiveFrom !== "" && hasSelection(s.rules, s.includeAll);

// ── reading a plan ───────────────────────────────────────────────────────────

export const STATUS_META: Record<PlanStatus, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "success" },
  unchanged: { label: "Already on this shift", tone: "neutral" },
  conflict: { label: "On another shift", tone: "warning" },
  skipped: { label: "Skipped", tone: "neutral" },
  blocked: { label: "Needs attention", tone: "danger" },
  excluded: { label: "Left out", tone: "neutral" },
};

export type RowFilter = "all" | "new" | "conflict" | "skipped" | "errors";

export const ROW_FILTERS: { value: RowFilter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "new", label: "New" },
  { value: "conflict", label: "Already assigned" },
  { value: "skipped", label: "Skipped" },
  { value: "errors", label: "Errors" },
];

const FILTER_STATUSES: Record<RowFilter, PlanStatus[]> = {
  all: ["new", "unchanged", "conflict", "skipped", "blocked", "excluded"],
  new: ["new"],
  conflict: ["conflict", "unchanged"],
  skipped: ["skipped", "excluded"],
  errors: ["blocked"],
};

export function filterRows(rows: PlanRow[], filter: RowFilter, query: string): PlanRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      FILTER_STATUSES[filter].includes(r.status) &&
      (!q ||
        r.name.toLowerCase().includes(q) ||
        r.employeeCode.toLowerCase().includes(q) ||
        (r.department ?? "").toLowerCase().includes(q) ||
        (r.designation ?? "").toLowerCase().includes(q)),
  );
}

export function rowFilterCounts(rows: PlanRow[]): Record<RowFilter, number> {
  const out = {} as Record<RowFilter, number>;
  for (const f of Object.keys(FILTER_STATUSES) as RowFilter[]) {
    out[f] = rows.filter((r) => FILTER_STATUSES[f].includes(r.status)).length;
  }
  return out;
}

/** What will happen to this row if the plan is applied, in words. */
export function rowOutcome(row: PlanRow): { label: string; tone: Tone } {
  switch (row.status) {
    case "new":
      return { label: "Will be assigned", tone: "success" };
    case "unchanged":
      return { label: "Already on this shift", tone: "neutral" };
    case "conflict":
      return row.action === "keep"
        ? { label: "Keeps current shift", tone: "info" }
        : { label: "Will be reassigned", tone: "warning" };
    case "blocked":
      return { label: "Not assigned: needs attention", tone: "danger" };
    case "excluded":
      return { label: "Left out", tone: "neutral" };
    default:
      return { label: "Skipped", tone: "neutral" };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** '12 to assign · 3 to reassign · 2 keep their shift · 5 skipped' for the footer; empty parts are left out. */
export function summaryLine(c: PlanCounts): string {
  const parts: string[] = [];
  if (c.new) parts.push(`${c.new} to assign`);
  if (c.willReassign) parts.push(`${c.willReassign} to reassign`);
  if (c.kept) parts.push(`${c.kept} keep their shift`);
  if (c.alreadyOnThisShift) parts.push(`${c.alreadyOnThisShift} already on it`);
  const left = c.skipped + c.excluded;
  if (left) parts.push(`${left} skipped`);
  if (c.blocked) parts.push(`${c.blocked} need attention`);
  return parts.join(" · ");
}

/** The apply button: 'Assign 12 employees', 'Assign 9 and reassign 3', or why there is nothing to do. */
export function confirmLabel(c: PlanCounts | undefined): string {
  if (!c) return "Assign";
  if (c.willChange === 0) return "Nothing to assign";
  if (c.willReassign === 0) return `Assign ${plural(c.new, "employee")}`;
  if (c.new === 0) return `Reassign ${plural(c.willReassign, "employee")}`;
  return `Assign ${c.new} and reassign ${c.willReassign}`;
}

/** Everything that stops Apply: the request's own errors, or a plan with nothing to write. */
export function applyBlocker(plan: PlanResult | undefined, pending: boolean): string | null {
  if (pending) return "Checking…";
  if (!plan) return "Choose a shift, a date and who to include";
  if (!plan.ok) return plan.errors[0] ?? "Fix the errors first";
  if (plan.counts.willChange === 0) return "Nobody would be assigned or changed";
  return null;
}

// ── lists of assignments ─────────────────────────────────────────────────────

export type AssignedGroup = {
  shiftId: number;
  shiftName: string;
  shiftType: string;
  startTime: string;
  endTime: string;
  genderRule: string;
  gracePeriodMinutes: number;
  members: ShiftAssignment[];
};

export function groupAssignments(assignments: ShiftAssignment[]): AssignedGroup[] {
  const map = new Map<number, AssignedGroup>();
  for (const a of assignments) {
    if (!a.shiftId) continue;
    let g = map.get(a.shiftId);
    if (!g) {
      g = {
        shiftId: a.shiftId,
        shiftName: a.shiftName ?? `Shift #${a.shiftId}`,
        shiftType: a.shiftType ?? "staff",
        startTime: a.startTime ?? "",
        endTime: a.endTime ?? "",
        genderRule: a.genderRule ?? "all",
        gracePeriodMinutes: a.gracePeriodMinutes ?? 0,
        members: [],
      };
      map.set(a.shiftId, g);
    }
    g.members.push(a);
  }
  return Array.from(map.values()).sort((a, b) => a.shiftName.localeCompare(b.shiftName));
}

export type TypeFilter = "all" | ShiftType;

/** Filter by the EMPLOYEE's type (a production employee on any shift belongs under Production), then by a search. */
export function filterAssignments(assignments: ShiftAssignment[], type: TypeFilter, query: string): ShiftAssignment[] {
  const q = query.trim().toLowerCase();
  return assignments.filter(
    (a) =>
      (type === "all" || (a.employmentType ?? "staff") === type) &&
      (!q ||
        a.employeeName.toLowerCase().includes(q) ||
        a.employeeCode.toLowerCase().includes(q) ||
        (a.shiftName ?? "").toLowerCase().includes(q) ||
        (a.departmentName ?? "").toLowerCase().includes(q)),
  );
}

export type Person = {
  id: number;
  employeeCode: string;
  firstName: string;
  lastName?: string | null;
  employmentType?: string | null;
  departmentName?: string | null;
  designationTitle?: string | null;
  gender?: string | null;
};

/** Active employees with no shift at all. */
export function unassignedOf<T extends Person>(employees: T[], assignments: ShiftAssignment[]): T[] {
  const assigned = new Set(assignments.map((a) => a.employeeId));
  return employees.filter((e) => !assigned.has(e.id));
}

export function filterPeople<T extends Person>(people: T[], type: TypeFilter, query: string): T[] {
  const q = query.trim().toLowerCase();
  return people.filter(
    (e) =>
      (type === "all" || (e.employmentType ?? "staff") === type) &&
      (!q ||
        `${e.firstName} ${e.lastName ?? ""}`.toLowerCase().includes(q) ||
        e.employeeCode.toLowerCase().includes(q) ||
        (e.departmentName ?? "").toLowerCase().includes(q) ||
        (e.designationTitle ?? "").toLowerCase().includes(q)),
  );
}

/** The most recent start date among assignments: a shift cannot be ended before the latest day one began. */
export const latestStart = (assignments: Pick<ShiftAssignment, "effectiveFrom">[]): string =>
  assignments.reduce((m, a) => (a.effectiveFrom > m ? a.effectiveFrom : m), "");

export const pluralize = plural;
