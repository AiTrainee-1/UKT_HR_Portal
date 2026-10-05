// The Employees page's pure logic: turning what the server sends into what the cards show (chart rows, bar lists,
// KPI tiles, labels, the questions "Ask AI" opens). No React here, so every rule is tested in logic.test.ts.

import type { BarItem } from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import type { DonutSlice } from "@/components/md/kit/DonutChart";
import type { KpiDelta } from "@/components/md/kit/dto";
import type { StatTone } from "@/components/md/kit/StatCard";
import type { AssistantPageContext } from "@/lib/md/assistant-store";
import { changeTone, dayShort, monthText, num, pct, signed } from "@/lib/md/format";
import type { PeriodPreset } from "@/lib/md/period";
import type {
  AttritionRow,
  Change,
  DirectorySort,
  DirectoryStatus,
  EmployeesComposition,
  EmployeesMovement,
  EmployeesSummary,
  GroupRow,
  KeyedShareRow,
  MovementGrain,
  MovementPoint,
  StaffingRow,
} from "./types";

/** The periods this page offers: movement and attrition are read over months, so the short ones are left out. */
export const EMPLOYEE_PRESETS: PeriodPreset[] = [
  "this_month",
  "last_month",
  "last_90_days",
  "last_12_months",
  "this_year",
  "this_fy",
];

// ─── the KPI strip ────────────────────────────────────────────────────────────────────────────────────────────

/** From this many days a period is read as a year, and its attrition is not scaled up to one. */
export const YEAR_LONG_DAYS = 330;

export type TileIcon = "users" | "joiners" | "leavers" | "net" | "attrition" | "tenure" | "early" | "people";

export type KpiTile = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  /** What the change chip is compared with ("vs previous 90 days"). */
  note?: string;
  delta: KpiDelta | null;
  spark?: number[];
  tone: StatTone;
  icon: TileIcon;
  provenanceIds: string[];
};

/** The change chip for a count, a percentage-points figure or a length of service; coloured by whether a rise is good. */
export function changeDelta(change: Change, unit: "count" | "pts" | "years", higherIsBetter: boolean): KpiDelta | null {
  if (!change || change.abs == null) return null;
  const abs = change.abs;
  const text = unit === "pts" ? `${signed(abs, 1)} pts` : unit === "years" ? `${signed(abs, 1)} yrs` : signed(abs, 0);
  return { text, tone: changeTone(abs, higherIsBetter), direction: abs > 0 ? "up" : abs < 0 ? "down" : "flat" };
}

const sparkOf = (movement: EmployeesMovement | undefined, pick: (p: MovementPoint) => number): number[] | undefined =>
  movement && movement.points.length > 1 ? movement.points.map(pick) : undefined;

/** A figure with its sign, for net change: "+3", "-2", "0". */
export const signedCount = (n: number | null | undefined) => signed(n, 0);

/** The eight tiles. The headcount chip compares today with the start of the period, which only makes sense when the
 *  period runs up to today; otherwise today's number is shown on its own. */
export function kpiTiles(summary: EmployeesSummary, movement?: EmployeesMovement): KpiTile[] {
  const { headcount: hc, joiners, leavers, net, attrition, tenure, earlyAttrition: early, gender, age } = summary;
  const versus = `vs ${summary.previousPeriod.label.toLowerCase()}`;
  const reachesToday = !!summary.period && summary.period.end >= summary.asOf;
  // a window of about a year already IS an annual rate: scaling it by 365/339 would only add noise
  const yearLong = (summary.period?.days ?? 0) >= YEAR_LONG_DAYS;
  const tiles: KpiTile[] = [
    {
      id: "headcount",
      label: "Active headcount",
      value: num(hc.current),
      sub: `Staff ${num(hc.staff)} · Production ${num(hc.production)}${hc.other ? ` · Other ${num(hc.other)}` : ""}`,
      note: reachesToday && summary.period ? `since ${dayShort(summary.period.start)}` : undefined,
      delta: reachesToday ? changeDelta(hc.change, "count", true) : null,
      spark: sparkOf(movement, (p) => p.headcount),
      tone: "blue",
      icon: "users",
      provenanceIds: ["headcount", "reconstructed-headcount"],
    },
    {
      id: "joiners",
      label: "Joiners",
      value: num(joiners.count),
      sub: summary.period?.label,
      note: versus,
      delta: changeDelta(joiners.change, "count", true),
      spark: sparkOf(movement, (p) => p.joiners),
      tone: "green",
      icon: "joiners",
      provenanceIds: ["joiners-leavers"],
    },
    {
      id: "leavers",
      label: "Leavers",
      value: num(leavers.count),
      sub:
        leavers.approximate > 0 ? `${num(leavers.approximate)} with an approximate exit date` : summary.period?.label,
      note: versus,
      delta: changeDelta(leavers.change, "count", false),
      spark: sparkOf(movement, (p) => p.leavers),
      tone: "amber",
      icon: "leavers",
      provenanceIds: ["joiners-leavers"],
    },
    {
      id: "net",
      label: "Net change",
      value: signedCount(net.count),
      sub: "Joiners minus leavers",
      note: versus,
      delta: changeDelta(net.change, "count", true),
      spark: sparkOf(movement, (p) => p.net),
      tone: "indigo",
      icon: "net",
      provenanceIds: ["joiners-leavers"],
    },
    {
      id: "attrition",
      label: "Attrition",
      value: pct(attrition.pct),
      sub:
        attrition.annualisedPct != null && !yearLong
          ? `About ${pct(attrition.annualisedPct, 0)} a year at this pace`
          : attrition.averageHeadcount != null
            ? `Of an average ${num(attrition.averageHeadcount, 0)} people`
            : "No headcount in this period",
      note: versus,
      delta: changeDelta(attrition.change, "pts", false),
      tone: "red",
      icon: "attrition",
      provenanceIds: ["attrition", "reconstructed-headcount"],
    },
    {
      id: "tenure",
      label: "Average tenure",
      value: tenure.averageYears != null ? `${num(tenure.averageYears, 1)} yrs` : "—",
      sub: tenure.unknown > 0 ? `${num(tenure.unknown)} without a usable join date` : "Length of service",
      note: versus,
      delta: changeDelta(tenure.change, "years", true),
      tone: "teal",
      icon: "tenure",
      provenanceIds: ["tenure"],
    },
    {
      id: "early",
      label: "Left within 90 days",
      value: num(early.count),
      sub: early.pctOfLeavers != null ? `${pct(early.pctOfLeavers, 0)} of leavers` : "No leavers in this period",
      note: versus,
      delta: changeDelta(early.change, "count", false),
      tone: "purple",
      icon: "early",
      provenanceIds: ["early-attrition"],
    },
    {
      id: "people",
      label: "Women · average age",
      value: gender.femalePct != null ? pct(gender.femalePct, 0) : "—",
      sub: [
        age.average != null ? `Average age ${num(age.average, 1)}` : null,
        gender.recorded < hc.current && gender.recorded > 0 ? `gender known for ${num(gender.recorded)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      delta: null,
      tone: "slate",
      icon: "people",
      provenanceIds: ["gender-age"],
    },
  ];
  return tiles;
}

// ─── charts ───────────────────────────────────────────────────────────────────────────────────────────────────

export type MovementRow = { label: string; joiners: number; leavers: number; headcount: number };

/** The x-axis text of one step: "Sep" (or "Sep 25" when the chart spans more than one calendar year), "06 Sep" for
 *  day and week steps. Always unique within a chart, which the chart library needs. */
export function stepLabel(point: MovementPoint, grain: MovementGrain, spansYears: boolean): string {
  if (grain !== "month") return dayShort(point.start);
  const short = monthText(point.key, true);
  return spansYears ? `${short} ${point.key.slice(2, 4)}` : short;
}

export function movementRows(movement: EmployeesMovement): MovementRow[] {
  const spansYears = new Set(movement.points.map((p) => p.start.slice(0, 4))).size > 1;
  return movement.points.map((p) => ({
    label: stepLabel(p, movement.grain, spansYears),
    joiners: p.joiners,
    leavers: p.leavers,
    headcount: p.headcount,
  }));
}

/** "per month" / "per week" / "per day", for the chart's subtitle. */
export const grainText = (grain: MovementGrain) => ({ day: "day", week: "week", month: "month" })[grain];

/** Rows for a column chart of age or length-of-service bands. A trailing "not recorded" band with nobody in it is
 *  dropped (it would only be an empty column); the others stay so the shape of the workforce is visible. */
export function bandRows<T extends { label: string; count: number }>(rows: T[]): { label: string; count: number }[] {
  return rows
    .filter((r) => r.count > 0 || !/^(Not recorded|Not known)$/.test(r.label))
    .map((r) => ({ label: r.label, count: r.count }));
}

/** A band's short axis text: "Under 1 year" -> "<1 yr", "3-5 years" -> "3-5 yrs", "Not recorded" -> "Unknown". */
export function bandTick(label: string): string {
  return label
    .replace(/^Under 1 year$/, "<1 yr")
    .replace(/ years?$/, " yrs")
    .replace(/^Not (recorded|known)$/, "Unknown");
}

/** The same for how long leavers stayed: "Within 90 days" -> "≤90 days", "3-12 months" -> "3-12 mo". */
export const exitTick = (label: string) =>
  bandTick(label.replace(/^Within (\d+) days$/, "≤$1 days").replace(/ months$/, " mo"));

/** The headcount line's vertical range: the data with some room, so a 20-person swing in 1,240 is visible without
 *  looking like a cliff (a chart that starts at 0 would be a flat line). */
export function headcountDomain(rows: { headcount: number }[]): [number, number] | undefined {
  if (rows.length === 0) return undefined;
  const values = rows.map((r) => r.headcount);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max(3, Math.ceil((high - low) * 0.5));
  return [Math.max(0, low - pad), high + pad];
}

const KIND_COLOR: Record<string, string> = { staff: CHART.brand, production: CHART.warn, other: CHART.slate };

export function typeSlices(rows: KeyedShareRow[]): DonutSlice[] {
  return rows.map((r) => ({ name: r.label, value: r.count, color: KIND_COLOR[r.key] }));
}

const GENDER_COLOR: Record<string, string> = {
  male: CHART.brand,
  female: CHART.leave,
  other: CHART.teal,
  unspecified: CHART.slate,
};

export const genderSlices = (rows: KeyedShareRow[]): DonutSlice[] =>
  rows.map((r) => ({ name: r.label, value: r.count, color: GENDER_COLOR[r.key] }));

const REASON_COLOR: Record<string, string> = { other: CHART.slate, none: "#cbd5e1" };

export function reasonSlices(rows: KeyedShareRow[]): DonutSlice[] {
  return rows.map((r, i) => ({
    name: r.label,
    value: r.count,
    color: REASON_COLOR[r.key] ?? CHART.series[i % CHART.series.length],
  }));
}

/** People per unit, department or designation as bars; the "Other" row is grey. */
export function groupBars(rows: GroupRow[], sub?: (row: GroupRow) => string | undefined): BarItem[] {
  return rows.map((r, i) => ({
    key: `${r.id ?? "other"}-${i}`,
    label: r.label,
    value: r.count,
    sub: sub?.(r),
    display: `${num(r.count)} · ${pct(r.pct, 0)}`,
    color: r.other ? CHART.slate : undefined,
  }));
}

/** "6 staff · 12 production" under a unit or department. */
export function typeSplitText(row: GroupRow): string | undefined {
  if (row.staff == null || row.production == null) return undefined;
  return `${num(row.staff)} staff · ${num(row.production)} production`;
}

/** Attrition as ranked bars: the rate, with who left and out of how many; hot-spots are red. */
export function attritionBars(rows: AttritionRow[]): BarItem[] {
  return rows.map((r, i) => ({
    key: `${r.id ?? "none"}-${i}`,
    label: r.hotspot ? `${r.label} · hot-spot` : r.label,
    value: r.attritionPct ?? 0,
    display: pct(r.attritionPct),
    sub:
      r.averageHeadcount != null
        ? `${num(r.leavers)} left · average ${num(r.averageHeadcount, 0)} people`
        : `${num(r.leavers)} left`,
    color: r.hotspot ? CHART.bad : undefined,
  }));
}

/** Planned vs actual staff as fill bars: red under 80% filled, amber under 100%, green when the plan is met. */
export function staffingBars(rows: StaffingRow[]): BarItem[] {
  return rows.map((r) => {
    const fill = r.fillPct ?? 0;
    return {
      key: String(r.departmentId),
      label: r.label,
      value: Math.min(fill, 100),
      display: `${num(r.actual)} of ${num(r.required)}`,
      sub:
        r.gap > 0
          ? `${num(r.gap)} short · ${pct(fill, 0)} filled`
          : r.gap < 0
            ? `${num(-r.gap)} over plan`
            : "Fully staffed",
      color: fill < 80 ? CHART.bad : fill < 100 ? CHART.warn : CHART.good,
    };
  });
}

/** Everything shown for the composition's department card when there are more departments than bars. */
export function departmentsFootnote(c: EmployeesComposition): string | undefined {
  const shown = c.byDepartment.filter((d) => !d.other).length;
  return c.departmentsTotal > shown ? `Showing the ${shown} biggest of ${c.departmentsTotal} departments.` : undefined;
}

// ─── text ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** "6 people" / "1 person". */
export const peopleText = (n: number) => `${num(n)} ${n === 1 ? "person" : "people"}`;

/** "5 years" / "1 year". */
export const yearsText = (n: number) => `${num(n)} ${n === 1 ? "year" : "years"}`;

const DAY_MS = 86_400_000;

function isoToUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `from` to `to` (ISO dates). */
export const daysBetween = (from: string, to: string) => Math.round((isoToUtc(to) - isoToUtc(from)) / DAY_MS);

/** "Today", "Tomorrow", "In 5 days" for a date looking ahead from `asOf`. */
export function whenText(iso: string, asOf: string): string {
  const n = daysBetween(asOf, iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 0) return `${-n} days ago`;
  return `In ${n} days`;
}

/** The text a name shows as an avatar: "Anita Raman" -> "AR", "Madonna" -> "M". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Server notes without repeats, in the order first seen (the summary and the charts say some of the same things). */
export function uniqueNotes(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const note of list ?? []) {
      if (!seen.has(note)) {
        seen.add(note);
        out.push(note);
      }
    }
  }
  return out;
}

/** Green from 95%, amber from 85%, red below; grey when there is no figure. */
export function attendanceTone(value: number | null): "good" | "warn" | "bad" | "none" {
  if (value == null) return "none";
  return value >= 95 ? "good" : value >= 85 ? "warn" : "bad";
}

// ─── the directory ────────────────────────────────────────────────────────────────────────────────────────────

export type DirectoryFilters = {
  q: string;
  status: DirectoryStatus;
  /** A designation title, "" for any. */
  designation: string;
  sort: DirectorySort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export const DEFAULT_DIRECTORY: DirectoryFilters = {
  q: "",
  status: "active",
  designation: "",
  sort: "name",
  dir: "asc",
  page: 1,
  pageSize: 10,
};

export const DIRECTORY_SORTS: { value: string; label: string; sort: DirectorySort; dir: "asc" | "desc" }[] = [
  { value: "name:asc", label: "Name (A to Z)", sort: "name", dir: "asc" },
  { value: "joined:desc", label: "Joined most recently", sort: "joined", dir: "desc" },
  { value: "joined:asc", label: "Longest serving", sort: "joined", dir: "asc" },
  { value: "department:asc", label: "Department", sort: "department", dir: "asc" },
  { value: "code:asc", label: "Employee code", sort: "code", dir: "asc" },
];

/** The query string of the directory: only what differs from the defaults is sent. */
export function directoryParams(f: DirectoryFilters): Record<string, string | number> {
  const out: Record<string, string | number> = { page: f.page, pageSize: f.pageSize };
  const q = f.q.trim();
  if (q) out.q = q;
  if (f.status !== "active") out.status = f.status;
  if (f.designation) out.designation = f.designation;
  if (f.sort !== "name") out.sort = f.sort;
  if (f.dir !== "asc") out.dir = f.dir;
  return out;
}

export const directoryFiltersActive = (f: DirectoryFilters) =>
  f.q.trim() !== "" || f.status !== "active" || f.designation !== "";

// ─── what "Ask AI" opens with ─────────────────────────────────────────────────────────────────────────────────

/** The question the profile's "Ask AI" opens with. */
export const personQuestion = (name: string, code: string) =>
  `Tell me about ${name} (${code}): tenure, history, attendance and anything I should know.`;

/** Ready-made questions that name the period and the part of the company on screen, so the answer matches the card. */
export function askQuestions(periodLabel: string, scopeText: string) {
  const where = `${periodLabel.toLowerCase()}, ${scopeText}`;
  return {
    attention: `What needs my attention in the workforce (${where})? Explain each item and what I should do.`,
    mix: `How is the workforce made up today (${scopeText})? Staff and production, units, departments, age and length of service: what stands out?`,
    units: `How do our units compare today (${scopeText})? Size, staff and production mix, and anything that stands out.`,
    departments: `Which departments are the biggest today (${scopeText}) and how is each made up between staff and production?`,
    service: `How experienced is the workforce (${scopeText})? Comment on length of service and what it means for us.`,
    age: `What does the age profile of the workforce look like (${scopeText}), and does anything stand out?`,
    designations: `What are our main designations (${scopeText}) and how many people hold each?`,
    staffing: `Which departments are below their planned staff (${scopeText}), by how many people, and how serious is it?`,
    movement: `How did headcount move in ${where}? When did most people join or leave, and is the trend healthy?`,
    attrition: `Where is attrition highest in ${where}, and what is driving it?`,
    tenure: `How long do people stay before they leave (${where})? Are we losing new joiners early?`,
    reasons: `Why are people leaving (${where})? Group the reasons they gave and tell me what to act on.`,
    early: `Who left within 90 days of joining in ${where}, from which departments, and why?`,
    milestones: `Who has a work anniversary of 5 or more years, a birthday or a probation end coming up soon (${scopeText})?`,
    directory: `Help me find people in the workforce (${scopeText}).`,
    person: personQuestion,
  };
}

export type Asks = ReturnType<typeof askQuestions>;

/** What the assistant is told this page is showing. */
export function assistantContext(
  summary: EmployeesSummary | undefined,
  periodLabel: string,
  scopeText: string,
): AssistantPageContext {
  return {
    page: "employees",
    title: "Employees",
    filters: { Period: periodLabel, Scope: scopeText },
    summary: summary
      ? {
          "Active headcount": summary.headcount.current,
          Joiners: summary.joiners.count,
          Leavers: summary.leavers.count,
          "Net change": summary.net.count,
          "Attrition %": summary.attrition.pct,
          "Average tenure (years)": summary.tenure.averageYears,
          "Left within 90 days": summary.earlyAttrition.count,
        }
      : undefined,
  };
}
