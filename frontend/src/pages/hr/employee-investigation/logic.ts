// The pure rules of Employees -> Investigation (/hr/employees/investigation): the tabs and filters in the address, the
// sentences a row is made of, the reason check, the refusals report and the absence calendar. No React here.
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  InvestigationActionPath,
  InvestigationBucket,
  InvestigationDay,
  InvestigationDayKind,
  InvestigationDecision,
  InvestigationDecisionBucket,
  InvestigationHistoryItem,
  InvestigationKind,
  InvestigationResult,
  InvestigationRow,
  InvestigationSettings,
} from "@/lib/api-client/custom-hooks/employee-investigation";
import { dateLong, dateShort, dateTime, parseIso } from "@/components/payroll/kit/format";
import type { Tone } from "@/lib/statusTones";

export const INVESTIGATION_PATH = "/hr/employees/investigation";
/** The page's permission key (it follows "employees.status" until a role sets it). */
export const INVESTIGATION_MODULE = "employees.investigation";
export const EMPLOYEES_PATH = "/hr/employees";

// ── Tabs, kinds and filters (in the address) ─────────────────────────────────

export const TABS = ["15", "30", "auto"] as const;
export type InvestigationTab = (typeof TABS)[number];
export const TAB_LABEL: Record<InvestigationTab, string> = { "15": "15 Days", "30": "30 Days", auto: "Auto Trigger" };
export const isTab = (v: string): v is InvestigationTab => (TABS as readonly string[]).includes(v);
export const parseTab = (v: string | null | undefined): InvestigationTab => (v && isTab(v) ? v : "15");

export const KINDS = ["all", "staff", "production"] as const satisfies readonly InvestigationKind[];
export const KIND_LABEL: Record<InvestigationKind, string> = { all: "All", staff: "Staff", production: "Production" };
export const isKind = (v: string): v is InvestigationKind => (KINDS as readonly string[]).includes(v);
export const parseKind = (v: string | null | undefined): InvestigationKind => (v && isKind(v) ? v : "all");

export const ALL = "all";

/** The address's defaults: a value equal to its default is left out of the address. */
export const URL_DEFAULTS: Record<string, string> = { tab: "15", kind: ALL, dept: ALL, unit: ALL };

export type Filters = { search: string; department: string; unit: string };
export const NO_FILTERS: Filters = { search: "", department: ALL, unit: ALL };

export const filtersActive = (f: Filters): boolean => f.search.trim() !== "" || f.department !== ALL || f.unit !== ALL;

/** What the search and the department / unit filters look at (a row of the lists, or a History item's employee). */
type Searchable = { name: string; code: string; phone?: string | null; department: string; unit: string };

export function matchesFilters(row: Searchable, f: Filters): boolean {
  if (f.department !== ALL && row.department !== f.department) return false;
  if (f.unit !== ALL && row.unit !== f.unit) return false;
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.code, row.phone ?? ""].some((v) => (v ?? "").toLowerCase().includes(q));
}

export const historyEmployee = (item: InvestigationHistoryItem): Searchable => item.employee;

export type Option = { value: string; label: string };

/** The distinct non-empty names, sorted, as filter options (the value is the name: History items carry no ids). */
export function optionsOf(names: readonly (string | null | undefined)[]): Option[] {
  const seen = new Set<string>();
  for (const n of names) if (n && n.trim()) seen.add(n);
  return [...seen].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
}

/** A filter value the current list does not offer (another kind was picked) falls back to "all". */
export const keepOffered = (value: string, options: readonly Option[]): string =>
  value === ALL || options.some((o) => o.value === value) ? value : ALL;

// ── Words ─────────────────────────────────────────────────────────────────────

export const plural = (n: number, one: string, many = `${one}s`): string => {
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${n === 1 ? one : many}`;
};
export const employeeCount = (n: number): string => plural(n, "employee");
export const dayCount = (n: number): string => plural(n, "day");

/** "SURYA M, ARUN K and 3 more". */
export function names(rows: readonly { name: string }[], shown = 3): string {
  const first = rows.slice(0, shown).map((r) => r.name);
  const more = rows.length - first.length;
  if (more > 0) return `${first.join(", ")} and ${more} more`;
  return first.length > 1 ? `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}` : (first[0] ?? "");
}

export const NO_DATA_HELP =
  "The unit's punches did not arrive on these working days (the device or the connector was down), so they say " +
  "nothing about the employee and are not counted as days away.";

/** "3 no-data days left out" (nothing when there are none). */
export const noDataText = (n: number): string | null => (n > 0 ? `${plural(n, "no-data day")} left out` : null);

/** The last attended day, or how a never-attended employee is counted. */
export function lastAttendedText(row: Pick<InvestigationRow, "lastAttended" | "neverAttended" | "joinDate">): {
  main: string;
  note: string | null;
} {
  if (row.neverAttended || !row.lastAttended) {
    return {
      main: "Never attended",
      note: row.joinDate
        ? `Counted from the join date (${dateShort(row.joinDate)})`
        : "No attendance and no join date on record",
    };
  }
  return { main: dateShort(row.lastAttended), note: null };
}

/** "2 of 22 working days" of approved leave. */
export const leaveText = (row: Pick<InvestigationRow, "leaveDays" | "workingDays">): string =>
  `${plural(row.leaveDays, "day")} of ${plural(row.workingDays, "working day")}`;

/** "Kept active by Priya: on medical leave, papers sent". */
export function decisionText(d: InvestigationDecision): string {
  const who = d.by ? `${d.actionLabel} by ${d.by}` : d.actionLabel;
  return d.reason ? `${who}: ${d.reason}` : who;
}

/** Is the latest decision about the absence that is running now (not an earlier one)? */
export const decisionIsCurrent = (row: Pick<InvestigationRow, "decision" | "awayFrom">): boolean =>
  !!row.decision && !!row.awayFrom && row.decision.spellStart === row.awayFrom;

export type ChipInfo = { label: string; tone: Tone; title: string };

/** The warning chip of a row the next Auto Trigger run would mark inactive (it says so when the switch is off). */
export function autoChip(
  row: Pick<InvestigationRow, "autoTonight">,
  settings: Pick<InvestigationSettings, "autoEnabled" | "runAt"> | undefined,
): ChipInfo | null {
  if (!row.autoTonight) return null;
  if (settings && !settings.autoEnabled) {
    return {
      label: "Due for the Auto Trigger",
      tone: "neutral",
      title: "The Auto Trigger is switched off: nobody is marked inactive automatically while it is off.",
    };
  }
  return {
    label: "Auto tonight",
    tone: "warning",
    title: `The Auto Trigger marks this employee inactive tonight at ${settings?.runAt ?? "01:00"} unless HR keeps them active.`,
  };
}

/** "Away 42 days (since 12 Oct 2026)". */
export const awaySince = (row: Pick<InvestigationRow, "awayFrom">): string | null =>
  row.awayFrom ? `since ${dateShort(row.awayFrom)}` : null;

// ── Reason ────────────────────────────────────────────────────────────────────

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export const cleanReason = (text: string): string => text.trim();

export function reasonProblem(text: string): string | null {
  const n = cleanReason(text).length;
  if (n === 0) return "Write a reason: it is kept with the decision.";
  if (n < REASON_MIN) return `Write at least ${REASON_MIN} characters.`;
  if (n > REASON_MAX) return `Keep it to ${REASON_MAX} characters.`;
  return null;
}

// ── Decisions ─────────────────────────────────────────────────────────────────

export type DecisionKind = "inactivate" | "keep" | "reactivate";

export const DECISION_PATH: Record<DecisionKind, InvestigationActionPath> = {
  inactivate: "inactivate",
  keep: "keep-active",
  reactivate: "reactivate",
};

export const DECISION_LABEL: Record<DecisionKind, string> = {
  inactivate: "Mark inactive",
  keep: "Keep active",
  reactivate: "Make active again",
};

/**
 * The body of a decision: Inactivate and Keep active say where it was decided (the 15 / 30 Days list, or "auto" for the
 * Auto Trigger tab), Make active again does not.
 */
export function decisionBody(
  kind: DecisionKind,
  rows: readonly { id: number; bucket?: InvestigationBucket | null }[],
  reason: string,
  bucket: InvestigationDecisionBucket | null,
): { employeeIds: number[]; reason: string; bucket?: InvestigationDecisionBucket } {
  const body = { employeeIds: rows.map((r) => r.id), reason: cleanReason(reason) };
  if (kind === "reactivate") return body;
  return { ...body, bucket: bucket ?? rows.find((r) => r.bucket)?.bucket ?? "30" };
}

const DONE_VERB: Record<DecisionKind, string> = {
  inactivate: "marked inactive",
  keep: "kept active",
  reactivate: "made active again",
};

const REFUSED_VERB: Record<DecisionKind, string> = {
  inactivate: "not marked inactive",
  keep: "not kept active",
  reactivate: "not made active again",
};

/** The toast after a decision: "3 employees marked inactive". */
export const doneTitle = (kind: DecisionKind, n: number): string => `${employeeCount(n)} ${DONE_VERB[kind]}`;

export type ResultReport = {
  title: string;
  items: { employeeId: number; employeeCode: string; name: string; reason: string }[];
};

/** Who a decision did not change and why (the server's own sentences); null when it changed everyone. */
export function refusalReport(kind: DecisionKind, result: InvestigationResult): ResultReport | null {
  if (result.refused.length === 0) return null;
  return { title: `${employeeCount(result.refused.length)} ${REFUSED_VERB[kind]}`, items: result.refused };
}

/** The server's sentence for a failed call ({error} on a 400 / 403), or a plain fallback. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const data = e.data as { error?: unknown; message?: unknown; detail?: unknown } | null;
    for (const v of [data?.error, data?.message, data?.detail]) if (typeof v === "string" && v) return v;
  }
  if (e instanceof Error && e.message) {
    const m = /^HTTP \d+ [^:]*: (.+)$/s.exec(e.message);
    return m ? m[1] : e.message;
  }
  return "Could not reach the server. Check the connection and try again.";
}

// ── The Auto Trigger ─────────────────────────────────────────────────────────

/** "Last run 23 Nov 2026, 01:00: 3 employees marked inactive" / "... (Run now by Priya): ..." / "Not run yet". */
export function lastRunText(settings: Pick<InvestigationSettings, "lastRunAt" | "lastRun">): string {
  const at = settings.lastRun?.at ?? settings.lastRunAt;
  if (!at) return "Not run yet.";
  const n = settings.lastRun?.inactivated ?? 0;
  const what = n > 0 ? `${employeeCount(n)} marked inactive` : "nobody was due";
  const runBy = settings.lastRun?.runBy;
  const how = runBy && runBy !== "nightly" ? ` (Run now by ${runBy})` : "";
  return `Last run ${dateTime(at)}${how}: ${what}.`;
}

export const RUN_NOW_UNIT_BLOCK = "The Auto Trigger runs for the whole company: only a login for all units can run it.";

/**
 * Why Run now cannot be pressed (null = it can): a unit login, no edit rights, nobody due, or the list still loading.
 * `due` is how many the run would mark inactive (null = not known yet).
 */
export function runNowBlock(
  settings: Pick<InvestigationSettings, "canChange">,
  canEdit: boolean,
  due: number | null,
): string | null {
  if (!settings.canChange) return RUN_NOW_UNIT_BLOCK;
  if (!canEdit) return "Needs edit rights on this page.";
  if (due === null) return "Checking who is due...";
  if (due === 0) return "Nobody is due.";
  return null;
}

/** The toast after Run now, from what the server says it did. */
export const runNowDoneTitle = (inactivated: number): string =>
  inactivated > 0 ? `${employeeCount(inactivated)} marked inactive` : "Nobody was due: nobody was marked inactive";

/** The rule in plain words, then its exceptions. */
export function ruleLines(settings: Pick<InvestigationSettings, "autoDays" | "runAt" | "rules">): {
  rule: string;
  exceptions: string[];
  counting: string[];
} {
  const { autoDays, runAt, rules } = settings;
  return {
    rule:
      `Every night at ${runAt} it marks inactive each active employee away more than ${autoDays} days in a row ` +
      "who was not dealt with here.",
    exceptions: [
      "Employees on approved leave for every working day away: listed, never marked inactive automatically.",
      "Employees HR kept active for this absence: left alone until they attend again (a later absence starts fresh).",
      "Employees with no attendance ever recorded: listed for HR to check, never marked inactive automatically.",
    ],
    counting: [
      `15 Days lists ${rules.list15}-${rules.list30 - 1} days away, 30 Days lists ${rules.list30} or more.`,
      "Days are calendar days since the last attended day, up to yesterday: Sundays and holidays count.",
      `A working day on which fewer than 1 in ${rules.gapShare} of the unit's active employees punched is a ` +
        "no-data day (the punches did not arrive) and is not counted.",
    ],
  };
}

/** "Made active again by Priya on 24 Nov 2026: came back with a medical note". */
export function sinceText(item: Pick<InvestigationHistoryItem, "since">): string | null {
  const s = item.since;
  if (!s) return null;
  const when = s.at ? ` on ${dateShort(s.at)}` : "";
  const who = s.by ? ` by ${s.by}` : "";
  return `${s.actionLabel}${who}${when}${s.reason ? `: ${s.reason}` : ""}`;
}

/** May HR make this History employee active again from here (still inactive)? */
export const canReactivate = (item: Pick<InvestigationHistoryItem, "employee">): boolean =>
  item.employee.status !== "active";

// ── The absence calendar ─────────────────────────────────────────────────────

export const DAY_KIND_META: Record<InvestigationDayKind, { label: string; cell: string; dot: string }> = {
  absent: { label: "Away", cell: "bg-red-100 text-red-800", dot: "bg-red-500" },
  leave: { label: "Approved leave", cell: "bg-sky-100 text-sky-900", dot: "bg-sky-500" },
  half_leave: { label: "Half-day leave", cell: "bg-cyan-50 text-cyan-900", dot: "bg-cyan-400" },
  leave_pending: { label: "Leave asked, not approved", cell: "bg-amber-100 text-amber-900", dot: "bg-amber-500" },
  holiday: { label: "Holiday", cell: "bg-violet-100 text-violet-900", dot: "bg-violet-500" },
  sunday: { label: "Sunday", cell: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  no_data: {
    label: "No data (unit's punches missing)",
    cell: "border border-dashed border-gray-300 bg-white text-gray-400",
    dot: "border border-dashed border-gray-400 bg-white",
  },
};

export const DAY_KIND_ORDER: InvestigationDayKind[] = [
  "absent",
  "leave",
  "half_leave",
  "leave_pending",
  "holiday",
  "sunday",
  "no_data",
];

/** "Mon, 3 Nov 2026: Holiday (Diwali)". */
export function dayLabel(d: InvestigationDay): string {
  const meta = DAY_KIND_META[d.kind] ?? { label: d.kind };
  const kind = d.kind === "holiday" && d.holiday ? `${meta.label} (${d.holiday})` : meta.label;
  return `${dateLong(d.date)}: ${kind}`;
}

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type CalendarMonth = { key: string; label: string; cells: (InvestigationDay | null)[] };

/** Monday = 0 ... Sunday = 6, from an ISO day (no time zones involved). */
function mondayIndex(iso: string): number {
  const d = parseIso(iso);
  if (!d) return 0;
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;
}

/** The days grouped by month, each month padded at the start so its weeks line up Monday to Sunday. */
export function calendarMonths(days: readonly InvestigationDay[]): CalendarMonth[] {
  const out: CalendarMonth[] = [];
  for (const day of days) {
    const ymd = parseIso(day.date);
    if (!ymd) continue;
    const key = `${ymd.year}-${String(ymd.month).padStart(2, "0")}`;
    let month = out[out.length - 1];
    if (!month || month.key !== key) {
      month = { key, label: `${MONTHS_LONG[ymd.month - 1]} ${ymd.year}`, cells: [] };
      for (let i = 0; i < mondayIndex(day.date); i++) month.cells.push(null);
      out.push(month);
    }
    month.cells.push(day);
  }
  return out;
}

/** How many days of each kind the calendar shows. */
export function dayKindCounts(days: readonly InvestigationDay[]): Record<InvestigationDayKind, number> {
  const out = Object.fromEntries(DAY_KIND_ORDER.map((k) => [k, 0])) as Record<InvestigationDayKind, number>;
  for (const d of days) if (d.kind in out) out[d.kind] += 1;
  return out;
}

export const REQUEST_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  pending_hod: "Waiting for HOD",
  pending_hr: "Waiting for HR",
  dept_approved: "HOD approved",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const requestStatusLabel = (status: string): string =>
  REQUEST_STATUS_LABEL[status] ?? status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** "12 Nov 2026" or "12 Nov - 15 Nov 2026" for a leave request (dates as the server stored them). */
export function leaveRange(from: string, to: string): string {
  if (!to || to === from) return dateShort(from);
  return `${dateShort(from)} - ${dateShort(to)}`;
}
