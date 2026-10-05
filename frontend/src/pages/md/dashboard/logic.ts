// The Dashboard's pure rules: names and dates for the hero, which icon and tint a card gets, how a unit's bar is cut,
// how the three charts' rows are shaped, and what the page tells the assistant. No React in here, so every rule has a
// plain unit test (logic.test.ts).

import type { LucideIcon } from "lucide-react";
import type { StatTone } from "@/components/md/kit/StatCard";
import { MD_NAV } from "@/components/md/md-nav";
import type { AssistantPageContext } from "@/lib/md/assistant-store";
import { clockText, greeting, monthText, num, signed } from "@/lib/md/format";
import type { MdMe, Provenance } from "@/lib/md/types";
import type { AttendanceTrend, DashboardKpi, DashboardOverview, MovementTrend, PayrollTrend, UnitRow } from "./types";

/** What "Brief me" asks the assistant (the backend's briefing carries the same sentence in `briefing.ask`). */
export const BRIEFING_QUESTION = "Give me a briefing on how the company is doing today";

// ─── the hero ───────────────────────────────────────────────────────────────────────────────────────────────────────

const TITLES = /^(mr|mrs|ms|miss|dr|prof|sir|shri|sri|smt|thiru|thirumathi|tmt|er|ca|capt|col)\.?$/i;

/** What to call the MD in the greeting: the first real word of the name, skipping titles ("Dr.") and initials ("R.").
 *  "R. Murugan" -> "Murugan"; "Mr. Rajesh Kumar" -> "Rajesh"; an account name with no spaces is used as it is. */
export function firstName(name: string | null | undefined): string {
  const tokens = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const words = tokens.filter((t) => !TITLES.test(t));
  const real = words.find((t) => t.replace(/\./g, "").length > 1);
  return real ?? words[0] ?? tokens[0] ?? "";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
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

/** "2026-10-05" -> "Monday, 5 October 2026" (written out here so the text does not depend on the browser's locale). */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "Good afternoon, Murugan": the greeting follows the factory's clock (the server's time), not the laptop's. */
export function greetingLine(serverTime: string | undefined, name: string | undefined): string {
  const hello = greeting(serverTime);
  const first = firstName(name);
  return first ? `${hello}, ${first}` : hello;
}

// ─── what went wrong, if anything ───────────────────────────────────────────────────────────────────────────────────

/** The analytics modules that could not be read (the rest of the page is intact). */
export function failedSources(
  overview: DashboardOverview | undefined,
): { module: string; title: string; message: string }[] {
  return Object.entries(overview?.sources ?? {})
    .filter(([, s]) => !s.ok)
    .map(([module, s]) => ({ module, title: s.title, message: s.error ?? `${s.title} could not be loaded just now.` }));
}

/** "Payroll Analysis and Tea Break could not be read just now, so their figures and exceptions are missing here." */
export function failureMessage(failures: { title: string }[]): string {
  const names = failures.map((f) => f.title);
  const list = names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} could not be read just now, so ${names.length === 1 ? "its" : "their"} figures and exceptions are missing from this page.`;
}

const FAILURE_NOTE = /could not be loaded, so what it adds is missing here\.$/;

/** The server's notes minus the ones the failure banner already says, and the "Matched unit 'x' to 'y'" ones. */
export const pageNotes = (notes: string[] | undefined): string[] =>
  [...new Set(notes ?? [])].filter((n) => !FAILURE_NOTE.test(n) && !n.startsWith("Matched "));

// ─── the cards ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type KpiIconKey =
  | "users"
  | "attendance"
  | "absence"
  | "attrition"
  | "rupee"
  | "overtime"
  | "briefcase"
  | "door"
  | "coffee"
  | "activity";

export type KpiLook = { icon: KpiIconKey; tone: StatTone };

const LOOK_BY_ID: Record<string, KpiLook> = {
  "employees.headcount": { icon: "users", tone: "blue" },
  "attendance-today": { icon: "attendance", tone: "green" },
  "absenteeism-30d": { icon: "absence", tone: "amber" },
  "employees.attrition-12m": { icon: "attrition", tone: "red" },
  "payroll-gross": { icon: "rupee", tone: "indigo" },
  "payroll-overtime": { icon: "overtime", tone: "purple" },
  "recruitment.open_positions": { icon: "briefcase", tone: "teal" },
  "visitors-today": { icon: "door", tone: "slate" },
};

const LOOK_BY_MODULE: Record<string, KpiLook> = {
  attendance: { icon: "attendance", tone: "green" },
  employees: { icon: "users", tone: "blue" },
  payroll: { icon: "rupee", tone: "indigo" },
  recruitment: { icon: "briefcase", tone: "teal" },
  visitors: { icon: "door", tone: "slate" },
  tea_break: { icon: "coffee", tone: "amber" },
  activity: { icon: "activity", tone: "purple" },
};

/** The icon and tint of a card: its own if it is one of the eight usual ones, else its page's. */
export const kpiLook = (kpi: Pick<DashboardKpi, "id" | "module">): KpiLook =>
  LOOK_BY_ID[kpi.id] ?? LOOK_BY_MODULE[kpi.module] ?? { icon: "users", tone: "slate" };

/** The eight tiles the strip draws while the first answer is on its way. */
export const SKELETON_KPIS: { id: string; label: string; look: KpiLook }[] = [
  ["employees.headcount", "Active headcount"],
  ["attendance-today", "Attendance today"],
  ["absenteeism-30d", "Absenteeism, 30 days"],
  ["employees.attrition-12m", "Attrition (12 months)"],
  ["payroll-gross", "Payroll cost"],
  ["payroll-overtime", "Overtime cost"],
  ["recruitment.open_positions", "Open positions"],
  ["visitors-today", "Visitors today"],
].map(([id, label]) => ({ id, label, look: kpiLook({ id, module: "" }) }));

/** The provenance entries that explain a card (it names them by id). */
export const provenanceFor = (
  kpi: Pick<DashboardKpi, "provenanceIds">,
  entries: Provenance[] | undefined,
): Provenance[] => (entries ?? []).filter((p) => kpi.provenanceIds?.includes(p.id));

// ─── today by unit ──────────────────────────────────────────────────────────────────────────────────────────────────

export type SegmentKey = "in" | "late" | "leave" | "notIn";
export type UnitSegment = { key: SegmentKey; label: string; value: number; widthPct: number };

/** One unit's bar, cut into people in, late, on leave and not in yet. The whole bar is the people scheduled today;
 *  "late" is part of "in" and is only cut out when the day records say how many (otherwise everyone in is "in"). */
export function unitSegments(row: Pick<UnitRow, "expected" | "present" | "late" | "leave" | "absent">): UnitSegment[] {
  if (row.expected <= 0) return [];
  const late = row.late ?? 0;
  const parts: { key: SegmentKey; label: string; value: number }[] = [
    { key: "in", label: "In", value: Math.max(0, row.present - late) },
    { key: "late", label: "Late", value: late },
    { key: "leave", label: "On leave", value: row.leave },
    { key: "notIn", label: "Not in yet", value: row.absent },
  ];
  return parts.filter((p) => p.value > 0).map((p) => ({ ...p, widthPct: (p.value / row.expected) * 100 }));
}

/** "11 of 14 in · 3 not in yet · 2 late". */
export function unitCaption(row: Pick<UnitRow, "expected" | "present" | "late" | "leave" | "absent">): string {
  const parts = [`${num(row.present)} of ${num(row.expected)} in`];
  if (row.absent) parts.push(`${num(row.absent)} not in yet`);
  if (row.leave) parts.push(`${num(row.leave)} on leave`);
  if (row.late) parts.push(`${num(row.late)} late`);
  return parts.join(" · ");
}

// ─── the three charts ───────────────────────────────────────────────────────────────────────────────────────────────

export type AttendanceRow = { date: string; attendance: number | null };

export const attendanceRows = (trend: AttendanceTrend): AttendanceRow[] =>
  trend.points.map((p) => ({ date: p.date, attendance: p.attendancePct }));

/** The y range of the attendance line: from just under the lowest point (to the nearest 5) up to 100, so a dip is
 *  visible without the axis starting at zero. */
export function attendanceDomain(rows: AttendanceRow[]): [number, number] {
  const values = rows.map((r) => r.attendance).filter((v): v is number => v != null);
  if (values.length === 0) return [0, 100];
  return [Math.max(0, Math.floor((Math.min(...values) - 5) / 5) * 5), 100];
}

export type PayrollRow = {
  month: string;
  gross: number | null;
  grossProvisional: number | null;
  headcount: number | null;
};

/** Gross pay per month. A month still running, or with staff slips made before it ended, is drawn lighter (its pay is
 *  understated), exactly as the Payroll page draws it. */
export const payrollRows = (trend: PayrollTrend): PayrollRow[] =>
  trend.months.map((m) => {
    const provisional = m.state === "in_progress" || m.provisionalSlips > 0;
    return {
      month: m.month,
      gross: provisional ? null : m.grossPay,
      grossProvisional: provisional ? m.grossPay : null,
      headcount: m.headcount,
    };
  });

/** "2026-09" -> "Sep 26". */
export const tickMonth = (ym: string): string => `${monthText(ym, true)} ${ym.slice(2, 4)}`;

export type MovementRow = { label: string; joiners: number; leavers: number };

export const movementRows = (trend: MovementTrend): MovementRow[] =>
  trend.points.map((p) => ({ label: p.label, joiners: p.joiners, leavers: p.leavers }));

/** "Nov 2025" -> "Nov 25" (other labels, such as a week, stay as they are). */
export const tickLabel = (label: string): string => label.replace(/^([A-Za-z]{3}) \d{2}(\d{2})$/, "$1 $2");

/** "14 joined · 9 left · net +5". */
export const movementSummary = (totals: MovementTrend["totals"]): string =>
  `${num(totals.joiners)} joined · ${num(totals.leavers)} left · net ${signed(totals.net, 0)}`;

// ─── explore ────────────────────────────────────────────────────────────────────────────────────────────────────────

const EXPLORE_QUESTIONS: Record<string, string> = {
  attendance: "How is attendance this month, and which departments have the most absence?",
  employees: "How is the workforce changing, and where are people leaving from?",
  visitors: "How many visitors and outpasses were there recently, and is anything out of order?",
  "tea-break": "Are tea breaks costing us production time, and where is it worst?",
  payroll: "What did payroll cost last month and what changed from the month before?",
  reports: "Which reports should I read this week?",
  recruitment: "Are we hiring fast enough, and which positions have been open too long?",
  activity: "Has anything unusual happened in the system recently?",
};

export type ExploreTile = {
  id: string;
  title: string;
  path: string;
  icon: LucideIcon;
  /** The page's own one-line description (from /api/md/me); empty until that loads. */
  summary: string;
  question: string;
};

/** A tile for every page except this one, in sidebar order. */
export function exploreTiles(pages: MdMe["pages"] | undefined): ExploreTile[] {
  return MD_NAV.filter((p) => p.id !== "dashboard").map((p) => ({
    id: p.id,
    title: p.title,
    path: p.path,
    icon: p.icon,
    summary: pages?.find((x) => x.id === p.id)?.summary ?? "",
    question: EXPLORE_QUESTIONS[p.id] ?? `What changed on ${p.title}, and what needs my attention?`,
  }));
}

// ─── the assistant ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What the page tells the assistant it is showing: the headline numbers (as the cards write them) and the first item. */
export function assistantContext(overview: DashboardOverview | undefined): AssistantPageContext {
  const summary: Record<string, string | null> = {};
  for (const kpi of overview?.kpis ?? []) summary[kpi.label] = kpi.display ?? "no data";
  const first = overview?.insights[0];
  if (first) summary["Most important item"] = first.title;
  return {
    page: "dashboard",
    title: "Dashboard",
    filters: { Scope: "Whole company", "Numbers as of": overview ? clockText(overview.generatedAt) : null },
    summary: overview ? summary : undefined,
  };
}

/** "And 3 more on the pages." when the merged list was cut. */
export const moreText = (total: number, shown: number): string | null =>
  total > shown ? `And ${total - shown} more, lower on the list: open the pages to see them.` : null;
