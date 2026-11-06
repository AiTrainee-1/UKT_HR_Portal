import type { AttendanceDailyRecord, ListedPunch } from "@/lib/api-client/custom-hooks";

// The pure half of the Staff / Production Attendance page: which status card a row belongs to, the counts, the filters, the
// arrival curve and the punch chips' meaning. No React here, so all of it is unit-tested on its own (logic.test.ts).

/** The six status cards, in the order of the roll-call strip: the two ways of working, then the four ways of being away. */
export type BoardState = "present" | "on_duty" | "on_leave" | "cl" | "leave_applied" | "absent";

export const BOARD_ORDER: readonly BoardState[] = ["present", "on_duty", "on_leave", "cl", "leave_applied", "absent"];

export type BoardMeta = {
  /** The owner's own words for the card. */
  label: string;
  /** What the card counts, in one line. */
  hint: string;
  /** Tailwind classes: the swatch / strip segment fill, the soft wash and its ink, the ring of the chosen card. */
  fill: string;
  wash: string;
  ink: string;
  ring: string;
  /** The keyboard focus ring in the same colour. */
  focus: string;
  /** The same colour for SVG (charts) and the exports. Picked from the shades the MD skin re-colours. */
  hex: string;
  /** Excel ARGB of a light wash of the colour (the status cell of the exports). */
  argbWash: string;
};

export const BOARD_META: Record<BoardState, BoardMeta> = {
  present: {
    label: "Present",
    hint: "Punched in or marked present",
    fill: "bg-emerald-500",
    wash: "bg-emerald-50",
    ink: "text-emerald-800",
    ring: "ring-emerald-500",
    focus: "focus-visible:ring-emerald-500",
    hex: "#16a34a",
    argbWash: "FFDCFCE7",
  },
  on_duty: {
    label: "On Duty",
    hint: "Approved On-Duty, working off-site",
    fill: "bg-cyan-600",
    wash: "bg-cyan-50",
    ink: "text-cyan-800",
    ring: "ring-cyan-600",
    focus: "focus-visible:ring-cyan-600",
    hex: "#0891b2",
    argbWash: "FFCFFAFE",
  },
  on_leave: {
    label: "On Leave",
    hint: "Leave approved for today",
    fill: "bg-indigo-600",
    wash: "bg-indigo-50",
    ink: "text-indigo-800",
    ring: "ring-indigo-600",
    focus: "focus-visible:ring-indigo-600",
    hex: "#4338ca",
    argbWash: "FFE0E7FF",
  },
  cl: {
    label: "CL",
    hint: "Casual leave approved for today",
    fill: "bg-violet-600",
    wash: "bg-violet-50",
    ink: "text-violet-800",
    ring: "ring-violet-600",
    focus: "focus-visible:ring-violet-600",
    hex: "#7c3aed",
    argbWash: "FFEDE9FE",
  },
  leave_applied: {
    label: "Leave",
    hint: "Leave asked for, waiting for approval",
    fill: "bg-amber-500",
    wash: "bg-amber-50",
    ink: "text-amber-800",
    ring: "ring-amber-500",
    focus: "focus-visible:ring-amber-500",
    hex: "#f59e0b",
    argbWash: "FFFEF3C7",
  },
  absent: {
    label: "Absent",
    hint: "No punch and no approved leave",
    fill: "bg-red-500",
    wash: "bg-red-50",
    ink: "text-red-800",
    ring: "ring-red-500",
    focus: "focus-visible:ring-red-500",
    hex: "#ef4444",
    argbWash: "FFFEE2E2",
  },
};

/**
 * The one card a row belongs to, so the six counts add up to the roster. An approved On-Duty comes first (that is where
 * the person is working, punched or not), then anybody who punched or was marked present (a half-day leave or a half
 * Casual Leave with punches is present, with its chip), then the approved absences, then a request still waiting, and
 * only then Absent. `status` itself is the server's and is never rewritten: this only sorts rows into cards.
 */
export function boardStateOf(r: Pick<AttendanceDailyRecord, "status" | "leaveState">): BoardState {
  if (r.leaveState === "on_duty") return "on_duty";
  if (r.status === "present" || r.status === "manual") return "present";
  if (r.leaveState === "cl") return "cl";
  if (r.leaveState === "on_leave" || r.status === "on_leave") return "on_leave";
  if (r.leaveState === "leave_applied") return "leave_applied";
  return "absent";
}

export type BoardCounts = Record<BoardState, number> & {
  total: number;
  /** Present by hand (no punch, an Add Attendance entry). */
  manual: number;
  /** Late / early-out, where the row says it (production days the shift-table rules judge). */
  late: number;
  earlyOut: number;
  /** Production half days: a credit above nothing and under a full shift. */
  halfDay: number;
  /** Rows with an On-Duty punch still waiting for HR. */
  heldPunches: number;
};

export function countBoard(rows: readonly AttendanceDailyRecord[]): BoardCounts {
  const c: BoardCounts = {
    present: 0,
    on_duty: 0,
    on_leave: 0,
    cl: 0,
    leave_applied: 0,
    absent: 0,
    total: rows.length,
    manual: 0,
    late: 0,
    earlyOut: 0,
    halfDay: 0,
    heldPunches: 0,
  };
  for (const r of rows) {
    c[boardStateOf(r)] += 1;
    if (r.status === "manual") c.manual += 1;
    if (r.isLate) c.late += 1;
    if (r.isEarlyOut) c.earlyOut += 1;
    if (typeof r.shiftsEarned === "number" && r.shiftsEarned > 0 && r.shiftsEarned < 1) c.halfDay += 1;
    if (r.punches?.some((p) => p.verification === "pending")) c.heldPunches += 1;
  }
  return c;
}

export type StatusFilter = "all" | BoardState;

export const STATUS_FILTERS: readonly StatusFilter[] = ["all", ...BOARD_ORDER];

export function parseStatusFilter(value: string | null | undefined): StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value ?? "") ? (value as StatusFilter) : "all";
}

/** Each row's lower-cased name, code and department, worked out once per day's list instead of on every keystroke. */
export type IndexedRow = { row: AttendanceDailyRecord; state: BoardState; haystack: string };

export function indexRows(rows: readonly AttendanceDailyRecord[]): IndexedRow[] {
  return rows.map((row) => ({
    row,
    state: boardStateOf(row),
    haystack: `${row.employeeName} ${row.employeeCode} ${row.designation ?? ""}`.toLowerCase(),
  }));
}

export function filterRows(
  index: readonly IndexedRow[],
  { status, query, department }: { status: StatusFilter; query: string; department: string },
): AttendanceDailyRecord[] {
  const q = query.trim().toLowerCase();
  return index
    .filter(
      (x) =>
        (status === "all" || x.state === status) &&
        (!department || (x.row.department ?? "") === department) &&
        (!q || x.haystack.includes(q)),
    )
    .map((x) => x.row)
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

export function departmentsOf(rows: readonly AttendanceDailyRecord[]): string[] {
  return Array.from(new Set(rows.map((r) => r.department ?? "").filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

// ── the arrival curve ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ArrivalSlot = { slot: string; label: string; arrived: number; inBy: number };

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Who arrived when: each row's first counted punch in half-hour slots, and how many were in by the end of each slot. The
 * window runs from the slot before the first arrival to the slot after the last (four hours at least), so a day shift
 * and a night shift both fill the chart.
 */
export function arrivalCurve(rows: readonly AttendanceDailyRecord[], slotMinutes = 30): ArrivalSlot[] {
  const times = rows.map((r) => r.firstPunch).filter((t): t is string => !!t);
  if (times.length === 0) return [];
  const slots = new Map<number, number>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of times) {
    const s = Math.floor(toMinutes(t) / slotMinutes);
    slots.set(s, (slots.get(s) ?? 0) + 1);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  const minSpan = Math.ceil(240 / slotMinutes);
  const from = Math.max(0, lo - 1);
  const to = Math.min(Math.floor(1440 / slotMinutes) - 1, Math.max(hi + 1, from + minSpan - 1));
  const out: ArrivalSlot[] = [];
  let running = 0;
  for (let s = from; s <= to; s++) {
    const arrived = slots.get(s) ?? 0;
    running += arrived;
    out.push({
      slot: clock(s * slotMinutes),
      label: `${clock(s * slotMinutes)}-${clock((s + 1) * slotMinutes)}`,
      arrived,
      inBy: running,
    });
  }
  return out;
}

/** Earliest, middle and latest first punch of the day ("" when nobody punched). */
export function arrivalStats(rows: readonly AttendanceDailyRecord[]): { first: string; median: string; last: string } {
  const times = rows
    .map((r) => r.firstPunch)
    .filter((t): t is string => !!t)
    .sort();
  if (times.length === 0) return { first: "", median: "", last: "" };
  return { first: times[0], median: times[Math.floor((times.length - 1) / 2)], last: times[times.length - 1] };
}

// ── punches ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PunchKind =
  "biometric" | "geo" | "on_duty" | "missing_punch" | "hr_entry" | "auto" | "held" | "rejected" | "uncounted";

export const PUNCH_KIND_META: Record<PunchKind, { label: string; chip: string; dot: string }> = {
  biometric: { label: "Biometric", chip: "border-slate-200 bg-white text-slate-800", dot: "bg-slate-500" },
  geo: { label: "Geo punch (mobile)", chip: "border-sky-200 bg-sky-50 text-sky-900", dot: "bg-sky-500" },
  on_duty: { label: "On-Duty", chip: "border-cyan-200 bg-cyan-50 text-cyan-900", dot: "bg-cyan-600" },
  missing_punch: {
    label: "Missing punch (approved)",
    chip: "border-amber-200 bg-amber-50 text-amber-900",
    dot: "bg-amber-500",
  },
  hr_entry: { label: "HR entry", chip: "border-violet-200 bg-violet-50 text-violet-900", dot: "bg-violet-500" },
  auto: { label: "Auto attendance", chip: "border-slate-200 bg-slate-50 text-slate-700", dot: "bg-slate-400" },
  held: {
    label: "On-Duty, waiting for HR",
    chip: "border-dashed border-cyan-400 bg-white text-cyan-900",
    dot: "bg-cyan-400",
  },
  rejected: {
    label: "On-Duty, rejected",
    chip: "border-dashed border-red-300 bg-white text-red-700 line-through",
    dot: "bg-red-400",
  },
  uncounted: {
    label: "Not counted on this day",
    chip: "border-dashed border-slate-300 bg-white text-slate-500",
    dot: "bg-slate-300",
  },
};

export function punchKind(p: Pick<ListedPunch, "source" | "verification" | "note" | "counted">): PunchKind {
  if (p.verification === "pending") return "held";
  if (p.verification === "rejected") return "rejected";
  if (p.counted === false) return "uncounted";
  const s = p.source ?? "";
  if (s.startsWith("biometric")) return "biometric";
  if (s.startsWith("geo")) return "geo";
  if (s.startsWith("on_duty")) return "on_duty";
  if (s.startsWith("missing_punch")) return "missing_punch";
  if (s === "auto:md" || s.startsWith("auto")) return "auto";
  return "hr_entry";
}

const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** "4 Feb" for "2026-02-04" (the date as written, not shifted by the browser's time zone). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_MONTH.format(new Date(Date.UTC(y, (m || 1) - 1, d || 1)));
}

/** What a punch is, in one sentence (the chip's tooltip and its accessible name). */
export function punchTitle(p: ListedPunch, dayDate?: string): string {
  const when = `${p.time}${p.nextDay || (dayDate && p.date !== dayDate) ? ` on ${shortDate(p.date)}` : ""}`;
  const what = `${p.type === "OUT" ? "Out" : p.type === "IN" ? "In" : p.type} ${when}, ${p.sourceLabel}`;
  if (p.verification === "pending") return `${what}. Waiting for HR to verify; not counted yet.`;
  if (p.verification === "rejected") return `${what}. Rejected by HR; not counted.`;
  if (p.note === "previous_shift") return `${what}. Closes the previous day's night shift and is counted there.`;
  if (p.note === "double_tap") return `${what}. A second tap within a few minutes; the attendance engine ignores it.`;
  if (p.nextDay) return `${what}. Closes this shift after midnight.`;
  return `${what}.`;
}

/** "IN 08:31 (Biometric)" lines for an export cell. */
export function punchText(p: ListedPunch, dayDate?: string): string {
  const day = p.nextDay || (dayDate && p.date !== dayDate) ? ` ${shortDate(p.date)}` : "";
  const flag =
    p.verification === "pending"
      ? ", waiting for HR"
      : p.verification === "rejected"
        ? ", rejected"
        : p.note === "previous_shift"
          ? ", previous night"
          : p.note === "double_tap"
            ? ", double tap"
            : "";
  return `${p.type} ${p.time.slice(0, 5)}${day} (${p.sourceLabel}${flag})`;
}

// ── the leave / On-Duty wording of a row ─────────────────────────────────────────────────────────────────────────────

const LEAVE_TYPE_LABEL: Record<string, string> = {
  casual: "Casual",
  sick: "Sick",
  earned: "Earned",
  maternity: "Maternity",
  paternity: "Paternity",
  unpaid: "Unpaid",
  lop: "Loss of pay",
};

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

/** The leave / Casual Leave / On-Duty facts of a row as short phrases: "Sick leave, waiting for approval". */
export function leaveFacts(r: AttendanceDailyRecord): string[] {
  const out: string[] = [];
  if (r.onDuty) {
    out.push(`On-Duty: ${r.onDuty.label}${r.onDuty.destination ? ` (${r.onDuty.destination})` : ""}`);
  }
  if (r.casualLeave) {
    const part =
      r.casualLeave.portion === "first_half"
        ? ", first half"
        : r.casualLeave.portion === "second_half"
          ? ", second half"
          : "";
    out.push(`Casual leave${part}${r.casualLeave.status === "pending" ? ", waiting for approval" : ""}`);
  }
  if (r.leave) {
    const type = LEAVE_TYPE_LABEL[r.leave.type] ?? titleCase(r.leave.type || "Leave");
    const half = r.leave.isHalfDay
      ? `, half day${r.leave.halfDaySlot ? ` (${r.leave.halfDaySlot === "morning" ? "morning" : "afternoon"})` : ""}`
      : "";
    out.push(`${type} leave${half}${r.leave.status === "pending" ? ", waiting for approval" : ""}`);
  }
  return out;
}

/** The status of the row as the server says it (the old badge): Present, Manual, On Leave or Absent. */
export const STATUS_LABEL: Record<AttendanceDailyRecord["status"], string> = {
  present: "Present",
  manual: "Manual",
  on_leave: "On Leave",
  absent: "Absent",
};
