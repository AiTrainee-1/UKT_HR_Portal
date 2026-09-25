import type { AttendanceSearchDay, AttendanceSearchPunch } from "@/lib/api-client/custom-hooks";

export type ViewMode = "day" | "week" | "month" | "range";

// ── dates (all in the browser's local calendar; the punches themselves come from the server) ──

export function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's date as YYYY-MM-DD in the local calendar (toISOString would give yesterday before 5:30 am IST). */
export const todayStr = (): string => formatYMD(new Date());

export function addDays(dateStr: string, n: number): string {
  const d = parseYMD(dateStr);
  d.setDate(d.getDate() + n);
  return formatYMD(d);
}

/** Monday to Sunday around `dateStr`. */
export function weekRange(dateStr: string): [string, string] {
  const d = parseYMD(dateStr);
  const dow = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [formatYMD(monday), formatYMD(sunday)];
}

/** First and last day of a YYYY-MM month. */
export function monthRange(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [formatYMD(new Date(y, (m || 1) - 1, 1)), formatYMD(new Date(y, m || 1, 0))];
}

export function formatDisplayDate(dateStr: string): string {
  return parseYMD(dateStr).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

// ── quick ranges ──

export type PresetKey = "today" | "yesterday" | "this-week" | "last-week" | "this-month" | "last-month";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
];

export type Period = {
  mode: ViewMode;
  date: string;
  weekAnchor: string;
  month: string;
  rangeStart: string;
  rangeEnd: string;
};

function previousMonth(today: string): string {
  const d = parseYMD(today);
  return formatYMD(new Date(d.getFullYear(), d.getMonth() - 1, 1)).slice(0, 7);
}

/** What the period controls should be set to for a quick range. */
export function presetPeriod(
  key: PresetKey,
  today = todayStr(),
): Pick<Period, "mode" | "date" | "weekAnchor" | "month"> {
  const base = { date: today, weekAnchor: today, month: today.slice(0, 7) };
  switch (key) {
    case "today":
      return { ...base, mode: "day" };
    case "yesterday":
      return { ...base, mode: "day", date: addDays(today, -1) };
    case "this-week":
      return { ...base, mode: "week" };
    case "last-week":
      return { ...base, mode: "week", weekAnchor: addDays(today, -7) };
    case "this-month":
      return { ...base, mode: "month" };
    case "last-month":
      return { ...base, mode: "month", month: previousMonth(today) };
  }
}

/** Which quick range (if any) the current period controls amount to. */
export function activePreset(p: Period, today = todayStr()): PresetKey | null {
  for (const { key } of PRESETS) {
    const want = presetPeriod(key, today);
    if (p.mode !== want.mode) continue;
    if (p.mode === "day" && p.date === want.date) return key;
    if (p.mode === "week" && weekRange(p.weekAnchor)[0] === weekRange(want.weekAnchor)[0]) return key;
    if (p.mode === "month" && p.month === want.month) return key;
  }
  return null;
}

/** [start, end] of the period being looked at. */
export function periodBounds(p: Period): [string, string] {
  if (p.mode === "week") return weekRange(p.weekAnchor);
  if (p.mode === "month") return monthRange(p.month);
  if (p.mode === "range") return [p.rangeStart, p.rangeEnd];
  return [p.date, p.date];
}

// ── one employee's days ──

const toMinutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** Minutes from the first punch to the last of the day (breaks included), or null with fewer than two punches. */
export function punchSpanMinutes(punches: AttendanceSearchPunch[]): number | null {
  const times = punches
    .filter((p): p is NonNullable<AttendanceSearchPunch> => p !== null)
    .map((p) => toMinutes(p.time));
  if (times.length < 2) return null;
  const span = Math.max(...times) - Math.min(...times);
  return span > 0 ? span : null;
}

/** 8h 04m / 45m. */
export function formatSpan(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** The most days the server will return for one employee in a single lookup. */
export const MAX_RANGE_DAYS = 100;

/** How many calendar days start..end covers, both ends counted; 0 while either date is missing. */
export function inclusiveDays(start: string, end: string): number {
  if (!start || !end) return 0;
  const ms = Date.UTC(...ymdParts(end)) - Date.UTC(...ymdParts(start));
  return Math.abs(Math.round(ms / 86_400_000)) + 1;
}

function ymdParts(s: string): [number, number, number] {
  const [y, m, d] = s.split("-").map(Number);
  return [y, (m || 1) - 1, d || 1];
}

/** "Wed, 23 Sep 2026", or "Mon, 21 Sep – Sun, 27 Sep 2026" (each end carries its year when they differ). */
export function formatPeriodLabel(start: string, end: string): string {
  const fmt = (s: string, year: boolean) =>
    parseYMD(s).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      ...(year ? { year: "numeric" } : {}),
    });
  if (!start || !end || start === end) return fmt(start || end, true);
  const sameYear = parseYMD(start).getFullYear() === parseYMD(end).getFullYear();
  return `${fmt(start, !sameYear)} – ${fmt(end, true)}`;
}

/** "Asha Kumar" -> "AK"; a single name gives one letter. */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
  return letters.toUpperCase() || "?";
}

export type FlagTone = "late" | "halfShift" | "casual" | "leave" | "permission" | "autoPermission" | "compensation";

export type DayFlag = { key: string; tone: FlagTone; label: string; detail?: string };

/**
 * The badges a day earns, in the order they read best. Only flags that are true are returned, so a
 * plain day has none. The day's own status (Present / Absent ...) is shown separately.
 */
export function dayFlags(day: AttendanceSearchDay): DayFlag[] {
  const flags: DayFlag[] = [];
  if (day.isLate)
    flags.push({ key: "late", tone: "late", label: "Late", detail: day.lateAfternoon ? "after lunch" : undefined });
  // A half-shift day already says so in its status; only flag it separately when the status differs.
  if (day.isHalfShift && day.status !== "half_shift")
    flags.push({ key: "half", tone: "halfShift", label: "Half shift" });
  if (day.permissionEscalatedToHalfShift)
    flags.push({
      key: "escalated",
      tone: "halfShift",
      label: "Permission limit reached",
      detail: "counted as half shift",
    });
  const zones = [
    day.permissionMorning && "Morning",
    day.permissionAfternoon && "Afternoon",
    day.permissionDeparture && "Departure",
  ].filter(Boolean);
  if (zones.length)
    flags.push({ key: "auto", tone: "autoPermission", label: "Auto permission", detail: zones.join(" + ") });
  if (day.permission)
    flags.push({ key: "perm", tone: "permission", label: "Permission", detail: day.permission.time ?? undefined });
  if (day.casualLeave) flags.push({ key: "cl", tone: "casual", label: "Casual leave" });
  if (day.leave) flags.push({ key: "leave", tone: "leave", label: day.leave.type || "Leave" });
  if (day.isHalfDayLeave) flags.push({ key: "halfleave", tone: "leave", label: "Half-day leave" });
  if (day.isCompensationDay) flags.push({ key: "comp", tone: "compensation", label: "Comp day" });
  return flags;
}

/** The reasons people gave for a day's leave / casual leave / permission, blanks dropped. */
export function dayNotes(day: AttendanceSearchDay): { key: string; label: string; text: string }[] {
  const notes = [
    { key: "cl", label: "Casual leave", text: day.casualLeave?.reason },
    { key: "leave", label: day.leave?.type || "Leave", text: day.leave?.reason },
    { key: "perm", label: "Permission", text: day.permission?.reason },
  ];
  return notes.flatMap((n) => (n.text?.trim() ? [{ key: n.key, label: n.label, text: n.text.trim() }] : []));
}

/** A day worth a second look: absent, half shift, or late. */
export const isIssueDay = (d: AttendanceSearchDay): boolean =>
  d.status === "absent" || d.status === "half_shift" || d.isLate;

export type Summary = {
  total: number;
  present: number;
  halfShift: number;
  absent: number;
  onLeave: number;
  holiday: number;
  late: number;
  permission: number;
  issues: number;
};

export function summarize(days: AttendanceSearchDay[]): Summary {
  const count = (fn: (d: AttendanceSearchDay) => boolean) => days.filter(fn).length;
  return {
    total: days.length,
    present: count((d) => d.status === "present"),
    halfShift: count((d) => d.status === "half_shift"),
    absent: count((d) => d.status === "absent"),
    onLeave: count((d) => d.status === "on_leave"),
    holiday: count((d) => d.status === "holiday"),
    late: count((d) => d.isLate),
    permission: count((d) => !!d.permission),
    issues: count(isIssueDay),
  };
}
