// The Geo Attendance insights' logic, with no React in it: which way a change is good news, how a status becomes a slice,
// what a click on a ranking row does, how a person out right now is described, the questions the "Ask AI" buttons carry.
// Every rule has a test.

import type { BarItem } from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import type { DonutSlice } from "@/components/md/kit/DonutChart";
import type { KpiDelta } from "@/components/md/kit/dto";
import type { StatTone } from "@/components/md/kit/StatCard";
import { changeTone, dayLong, dayShort, num, pct, signed } from "@/lib/md/format";
import { PRESET_LABEL, describeScope, type PeriodChoice, type ScopeChoice } from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import type {
  Backlog,
  Change,
  GeoGroupRow,
  GeoLive,
  GeoReach,
  GeoSummary,
  GeoTrend,
  GeoVerification,
  GroupBy,
  LiveRow,
  ReasonCode,
  Verdict,
} from "./types";

/** The key the server gives the people who have no department / unit: not a group the MD can focus on. */
export const NONE_KEY = "__none__";

export const GROUP_TABS: { value: GroupBy; label: string; header: string }[] = [
  { value: "department", label: "Departments", header: "Department" },
  { value: "unit", label: "Units", header: "Unit" },
  { value: "type", label: "Staff vs production", header: "Group" },
];

const plural = (n: number | null | undefined, one: string, many: string) => (n === 1 ? one : many);

// ─── change chips ───────────────────────────────────────────────────────────────────────────────────────────────

export type ChipKind = "pts" | "pct" | "hours";
/** Which direction of change is good news: "none" for a figure with no good or bad side (how many sessions). */
export type Better = "up" | "down" | "none";

/** "+8.3 pts" / "-4.2%" / "+1.4 h" next to a figure, coloured by whether the change is good news. A change that rounds
 *  to nothing is shown flat and neutral rather than as a tiny red or green arrow. */
export function deltaChip(change: Change | undefined, kind: ChipKind, better: Better): KpiDelta | null {
  if (!change || change.abs == null || Number.isNaN(change.abs)) return null;
  const shown = kind === "pct" && change.pct != null ? change.pct : change.abs;
  if (Math.abs(shown) < 0.05) {
    return { text: kind === "pts" ? "0 pts" : kind === "hours" ? "0 h" : "0%", tone: "neutral", direction: "flat" };
  }
  let text: string;
  if (kind === "pts") text = `${signed(change.abs, 1)} pts`;
  else if (kind === "hours") text = `${signed(change.abs, 1)} h`;
  else text = change.pct != null ? `${signed(change.pct, 1)}%` : signed(change.abs, 0);
  return {
    text,
    tone: better === "none" ? "neutral" : changeTone(change.abs, better === "up"),
    direction: change.abs > 0 ? "up" : "down",
  };
}

// ─── words for times ────────────────────────────────────────────────────────────────────────────────────────────

/** 5.4 -> "5.4 h", 30 -> "30 h", 251 -> "10.5 days": how long something waited, short enough for a card. */
export function hoursText(hours: number | null | undefined): string {
  if (hours == null || Number.isNaN(hours)) return "—";
  if (hours >= 48) return `${num(hours / 24, 1)} days`;
  return `${num(hours, hours < 10 ? 1 : 0)} h`;
}

/** 360 -> "6 h", 925 -> "15 h 25 m", 45 -> "45 m": how long someone has been out. */
export function minutesOutText(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours >= 48) return `${num(minutes / 1440, 1)} days`;
  return rest ? `${hours} h ${rest} m` : `${hours} h`;
}

// ─── the figures strip ──────────────────────────────────────────────────────────────────────────────────────────

export type TileIcon = "sessions" | "people" | "punches" | "office" | "verified" | "waiting" | "speed" | "mocked";

export type KpiTile = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  icon: TileIcon;
  tone: StatTone;
  delta: KpiDelta | null;
  spark?: (number | null)[];
  /** Which response explains the figure. */
  source: "summary" | "verification";
  provenanceIds: string[];
};

/** The eight headline tiles. `trend` supplies the sparklines, `verification` the backlog and the timing. */
export function kpiTiles(summary: GeoSummary, trend?: GeoTrend, verification?: GeoVerification): KpiTile[] {
  const m = summary.metrics;
  const spark = (key: "sessions" | "punches" | "officePunches") => trend?.points.map((p) => p[key]);
  const sessions = m.sessions.value ?? 0;
  const punches = m.punches.value ?? 0;
  const approved = verification?.punches.approved;
  const backlog = verification?.backlog;
  const timing = verification?.decisionTime.punches;

  return [
    {
      id: "sessions",
      label: "On-duty sessions",
      value: num(sessions),
      sub: `${num(m.people.value)} ${plural(m.people.value, "person", "people")} out`,
      icon: "sessions",
      tone: "blue",
      delta: deltaChip(m.sessions.change, "pct", "none"),
      spark: spark("sessions"),
      source: "summary",
      provenanceIds: ["geo-sessions"],
    },
    {
      id: "people",
      label: "Employees who went out",
      value: summary.participationPct == null ? "—" : pct(summary.participationPct, 0),
      sub: `${num(summary.headcount)} active ${plural(summary.headcount, "employee", "employees")} in the selection`,
      icon: "people",
      tone: "indigo",
      delta: deltaChip(m.people.change, "pct", "none"),
      source: "summary",
      provenanceIds: ["geo-sessions"],
    },
    {
      id: "punches",
      label: "On-duty punches",
      value: num(punches),
      sub: sessions > 0 ? `${num(punches / sessions, 1)} per session` : "No sessions",
      icon: "punches",
      tone: "teal",
      delta: deltaChip(m.punches.change, "pct", "none"),
      spark: spark("punches"),
      source: "summary",
      provenanceIds: ["geo-punches"],
    },
    {
      id: "office",
      label: "Office geo punches",
      value: num(m.officePunches.value),
      sub: `${num(summary.officePeople)} ${plural(summary.officePeople, "person", "people")} · inside the unit`,
      icon: "office",
      tone: "slate",
      delta: deltaChip(m.officePunches.change, "pct", "none"),
      spark: spark("officePunches"),
      source: "summary",
      provenanceIds: ["geo-office-punches"],
    },
    {
      id: "verified",
      label: "Verified by HR",
      value: pct(m.verifiedPct.value, 1),
      sub: approved != null && punches > 0 ? `${num(approved)} of ${num(punches)} punches` : "No punches",
      icon: "verified",
      tone: "green",
      delta: deltaChip(m.verifiedPct.change, "pts", "up"),
      source: "summary",
      provenanceIds: ["geo-verification"],
    },
    {
      id: "waiting",
      label: "Waiting for HR now",
      value: backlog ? num(backlog.pendingPunches) : "—",
      sub: backlog
        ? backlog.pendingPunches > 0
          ? `Oldest ${hoursText(backlog.oldestPunchHours)} · ${num(backlog.pendingSessions)} ${plural(backlog.pendingSessions, "request", "requests")}`
          : `${num(backlog.pendingSessions)} ${plural(backlog.pendingSessions, "request", "requests")} waiting`
        : undefined,
      icon: "waiting",
      tone: "amber",
      delta: null,
      source: "verification",
      provenanceIds: ["geo-backlog"],
    },
    {
      id: "speed",
      label: "Median time to verify",
      value: hoursText(m.medianVerifyHours.value),
      sub:
        timing && timing.within24hPct != null
          ? `${pct(timing.within24hPct, 0)} decided within a day`
          : "Nothing decided",
      icon: "speed",
      tone: "purple",
      delta: deltaChip(m.medianVerifyHours.change, "hours", "down"),
      source: "summary",
      provenanceIds: ["geo-turnaround"],
    },
    {
      id: "mocked",
      label: "Simulated GPS punches",
      value: num(m.mockedPunches.value),
      sub: `${num(m.farPunches.value)} far from the unit · ${num(m.oddPunches.value)} at odd hours`,
      icon: "mocked",
      tone: "red",
      delta: deltaChip(m.mockedPunches.change, "pct", "down"),
      source: "summary",
      provenanceIds: ["geo-distance"],
    },
  ];
}

/** What the change chips compare with: "18 Aug to 31 Aug 2026". */
export function previousText(summary: Pick<GeoSummary, "previousPeriod">): string {
  return `${dayShort(summary.previousPeriod.start)} to ${dayLong(summary.previousPeriod.end)}`;
}

export type CompareRow = {
  id: string;
  label: string;
  current: string;
  previous: string;
  delta: KpiDelta | null;
};

/** "This period against the previous" as rows: the same figures as the strip, side by side, so the MD sees what moved. */
export function compareRows(summary: GeoSummary): CompareRow[] {
  const m = summary.metrics;
  const count = (key: "sessions" | "people" | "punches" | "officePunches" | "mockedPunches" | "farPunches") => ({
    current: num(m[key].value),
    previous: num(m[key].previous),
  });
  return [
    {
      id: "sessions",
      label: "On-duty sessions",
      ...count("sessions"),
      delta: deltaChip(m.sessions.change, "pct", "none"),
    },
    {
      id: "people",
      label: "People who went out",
      ...count("people"),
      delta: deltaChip(m.people.change, "pct", "none"),
    },
    { id: "punches", label: "On-duty punches", ...count("punches"), delta: deltaChip(m.punches.change, "pct", "none") },
    {
      id: "office",
      label: "Office geo punches",
      ...count("officePunches"),
      delta: deltaChip(m.officePunches.change, "pct", "none"),
    },
    {
      id: "verified",
      label: "Verified by HR",
      current: pct(m.verifiedPct.value, 1),
      previous: pct(m.verifiedPct.previous, 1),
      delta: deltaChip(m.verifiedPct.change, "pts", "up"),
    },
    {
      id: "rejected",
      label: "Rejected or voided",
      current: pct(m.rejectedPct.value, 1),
      previous: pct(m.rejectedPct.previous, 1),
      delta: deltaChip(m.rejectedPct.change, "pts", "down"),
    },
    {
      id: "speed",
      label: "Median time to verify",
      current: hoursText(m.medianVerifyHours.value),
      previous: hoursText(m.medianVerifyHours.previous),
      delta: deltaChip(m.medianVerifyHours.change, "hours", "down"),
    },
    {
      id: "mocked",
      label: "Simulated GPS punches",
      ...count("mockedPunches"),
      delta: deltaChip(m.mockedPunches.change, "pct", "down"),
    },
    {
      id: "far",
      label: "Punches far from the unit",
      ...count("farPunches"),
      delta: deltaChip(m.farPunches.change, "pct", "down"),
    },
  ];
}

// ─── the trend ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendRow = {
  date: string;
  sessions: number;
  punches: number;
  officePunches: number;
  average: number | null;
};

/** One row per day (or week) for the chart. The 7-day average only exists for daily points. */
export function trendRows(trend: GeoTrend): TrendRow[] {
  const daily = trend.granularity === "day";
  return trend.points.map((p) => ({
    date: p.date,
    sessions: p.sessions,
    punches: p.punches,
    officePunches: p.officePunches,
    average: daily ? p.maSessions : null,
  }));
}

/** False when nothing happened in the period: there is nothing to draw, only to explain. */
export function hasActivity(trend: GeoTrend): boolean {
  return trend.points.some((p) => p.sessions > 0 || p.punches > 0 || p.officePunches > 0);
}

export const VERDICT_STYLE: Record<Verdict, { label: string; box: string }> = {
  rising: { label: "Rising", box: "border-amber-200 bg-amber-50 text-amber-900" },
  falling: { label: "Falling", box: "border-blue-200 bg-blue-50 text-blue-900" },
  steady: { label: "Steady", box: "border-slate-200 bg-slate-50 text-slate-800" },
  unclear: { label: "Too early to say", box: "border-slate-200 bg-slate-50 text-slate-700" },
};

// ─── verification ───────────────────────────────────────────────────────────────────────────────────────────────

/** The punches by what HR decided, in the donut's order. Slices with nothing in them are left out by the chart. */
export function statusSlices(v: Pick<GeoVerification, "punches">): DonutSlice[] {
  return [
    { name: "Verified", value: v.punches.approved, color: CHART.good },
    { name: "Rejected by HR", value: v.punches.rejected, color: CHART.bad },
    { name: "Voided with a rejected request", value: v.punches.voided, color: CHART.slate },
    { name: "Waiting for HR", value: v.punches.pending, color: CHART.warn },
  ];
}

const AGE_COLORS = [CHART.good, CHART.warn, "#f97316", CHART.bad];

/** What is waiting for HR now, by how long it has waited (punches and requests together). */
export function ageBars(backlog: Pick<Backlog, "ageBuckets">): BarItem[] {
  return backlog.ageBuckets.map((b, i) => {
    const parts = [
      b.punches ? `${num(b.punches)} ${plural(b.punches, "punch", "punches")}` : null,
      b.sessions ? `${num(b.sessions)} ${plural(b.sessions, "request", "requests")}` : null,
    ].filter(Boolean);
    return {
      key: `age-${i}`,
      label: b.label,
      value: b.punches + b.sessions,
      display: parts.length ? parts.join(" · ") : "none",
      color: AGE_COLORS[i] ?? CHART.slate,
    };
  });
}

/** "5 of the 9 decided..." the one-line reading of how HR is doing, under the donut. */
export function decisionLine(v: Pick<GeoVerification, "decisionTime">): string | null {
  const t = v.decisionTime.punches;
  if (!t.decided || t.medianHours == null) return null;
  const parts = [`HR typically decides a punch in ${hoursText(t.medianHours)}`];
  if (t.p90Hours != null) parts.push(`9 in 10 within ${hoursText(t.p90Hours)}`);
  if (t.within24hPct != null) parts.push(`${pct(t.within24hPct, 0)} within a day`);
  return `${parts.join(", ")}.`;
}

// ─── how far from the unit ──────────────────────────────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, string> = {
  at_unit: CHART.teal,
  upto_2: CHART.light,
  upto_10: CHART.sky,
  upto_50: CHART.brand,
  upto_100: CHART.deep,
  beyond: CHART.bad,
  unknown: CHART.slate,
};

/** Punches by distance from the unit as ranked-bar rows. Bands with no punches are dropped. */
export function bandBars(reach: Pick<GeoReach, "bands">): BarItem[] {
  return reach.bands
    .filter((b) => b.punches > 0)
    .map((b) => ({
      key: b.key,
      label: b.label,
      value: b.punches,
      display: `${num(b.punches)}${b.sharePct != null ? ` · ${pct(b.sharePct, 0)}` : ""}`,
      sub: `${num(b.people)} ${plural(b.people, "person", "people")}`,
      color: BAND_COLORS[b.key] ?? CHART.brand,
    }));
}

// ─── comparison by group ────────────────────────────────────────────────────────────────────────────────────────

/** What clicking a ranking row does: narrow the whole page to that department, unit or staff/production group. null when
 *  there is nothing to narrow to (no group, or already focused). */
export function focusScope(
  scope: ScopeChoice,
  by: GroupBy,
  row: Pick<GeoGroupRow, "key" | "label">,
  org?: MdOrg,
): ScopeChoice | null {
  if (row.key === NONE_KEY) return null;
  if (by === "department") return scope.department === row.label ? null : { ...scope, department: row.label };
  if (by === "type") {
    if (row.key !== "staff" && row.key !== "production") return null;
    return scope.type === row.key ? null : { ...scope, type: row.key };
  }
  const unit = org?.branches.find((b) => b.name === row.label);
  if (!org || !unit || scope.branch === String(unit.id)) return null;
  // a department the new unit does not have is dropped, as the unit selector itself does
  const keeps = !scope.department || org.departments.some((d) => d.name === scope.department && d.branchId === unit.id);
  return { ...scope, branch: String(unit.id), department: keeps ? scope.department : "" };
}

/** The text under a group's name: how many people it has and how many of them went out. */
export function participationText(row: GeoGroupRow): string | null {
  if (row.headcount === 0)
    return row.people ? `${num(row.people)} ${plural(row.people, "person", "people")} out` : null;
  const people = `${num(row.headcount)} ${plural(row.headcount, "employee", "employees")}`;
  return row.participationPct == null ? people : `${people} · ${pct(row.participationPct, 0)} went out`;
}

// ─── who is out now ─────────────────────────────────────────────────────────────────────────────────────────────

export type LiveStatus = { label: string; tone: "good" | "warn" | "bad" };

/** Left open (an earlier day), awaiting approval, or approved: what the MD needs to know about the person's request. */
export function liveStatus(row: Pick<LiveRow, "stale" | "approved">): LiveStatus {
  if (row.stale) return { label: "Left open", tone: "bad" };
  return row.approved ? { label: "Approved", tone: "good" } : { label: "Awaiting approval", tone: "warn" };
}

/** What the phone last reported, in words: "20 m ago, 5 km from the unit", "no location yet", "not tracked". */
export function signalText(
  row: Pick<LiveRow, "tracked" | "minutesSinceSeen" | "distanceFromUnitKm" | "lastSeenMocked">,
): string {
  if (row.minutesSinceSeen == null) return row.tracked ? "No location yet" : "Not tracked";
  const ago = row.minutesSinceSeen < 1 ? "just now" : `${minutesOutText(row.minutesSinceSeen)} ago`;
  const distance = row.distanceFromUnitKm != null ? `, ${num(row.distanceFromUnitKm, 1)} km from the unit` : "";
  return `${ago}${distance}${row.lastSeenMocked ? ", simulated" : ""}`;
}

/** True when the person is tracked but their phone has not reported within the server's window. */
export function isSilent(row: Pick<LiveRow, "tracked" | "minutesSinceSeen">, silentMinutes: number): boolean {
  if (row.minutesSinceSeen != null) return row.minutesSinceSeen > silentMinutes;
  return row.tracked;
}

/** The chips above the live list. */
export function liveChips(live: Pick<GeoLive, "onDutyNow" | "leftOpen" | "awaitingApproval" | "noSignal">) {
  return [
    { id: "now", label: "On duty today", value: live.onDutyNow, tone: "blue" as const },
    { id: "open", label: "Left open", value: live.leftOpen, tone: "red" as const },
    { id: "awaiting", label: "Awaiting approval", value: live.awaitingApproval, tone: "amber" as const },
    { id: "silent", label: "No location signal", value: live.noSignal, tone: "slate" as const },
  ];
}

// ─── unusual sessions ───────────────────────────────────────────────────────────────────────────────────────────

export const REASON_STYLE: Record<ReasonCode, string> = {
  mocked: "bg-red-100 text-red-800",
  far: "bg-amber-100 text-amber-800",
  odd: "bg-slate-100 text-slate-700",
  long: "bg-amber-100 text-amber-800",
  stale: "bg-orange-100 text-orange-800",
  rejected: "bg-purple-100 text-purple-800",
};

export const SEVERITY_BAR: Record<"critical" | "warning" | "info", string> = {
  critical: "border-l-red-500",
  warning: "border-l-amber-500",
  info: "border-l-blue-400",
};

// ─── the assistant ──────────────────────────────────────────────────────────────────────────────────────────────

/** The period in words, for the questions and the assistant until the server's own label arrives. */
export function periodText(choice: PeriodChoice): string {
  return choice.preset === "custom" ? `${dayLong(choice.from)} to ${dayLong(choice.to)}` : PRESET_LABEL[choice.preset];
}

/** The selection in words: the server's description once it has answered, otherwise worked out from the filters. */
export function scopeText(scope: ScopeChoice, serverDescription?: string): string {
  return serverDescription ?? describeScope(scope, undefined, scope.department || undefined);
}

/** The headline numbers on screen, in the words the assistant is given as page context. */
export function assistantSummary(
  summary: GeoSummary | undefined,
  verification?: GeoVerification,
): Record<string, string | number | null> | undefined {
  if (!summary) return undefined;
  const m = summary.metrics;
  return {
    "On-duty sessions": m.sessions.value,
    "People who went out": m.people.value,
    "Share of employees who went out": summary.participationPct == null ? null : pct(summary.participationPct, 0),
    "On-duty punches": m.punches.value,
    "Office geo punches": m.officePunches.value,
    "Verified by HR": m.verifiedPct.value == null ? null : pct(m.verifiedPct.value, 1),
    "Rejected or voided": m.rejectedPct.value == null ? null : pct(m.rejectedPct.value, 1),
    "Median hours to verify": m.medianVerifyHours.value,
    "Simulated GPS punches": m.mockedPunches.value,
    "Punches far from the unit": m.farPunches.value,
    "Punches waiting for HR now": verification?.backlog.pendingPunches ?? null,
  };
}

/** The ready-made questions on the page's "Ask AI" buttons. `scopeText` is null when the page shows everyone. */
export function askQuestions(periodLabel: string, scopeText: string | null) {
  const when = scopeText ? ` (${periodLabel}, ${scopeText})` : ` (${periodLabel})`;
  return {
    page: `Summarise geo attendance and on-duty work${when}: how many people work outside the premises, how it is being verified and what needs my attention.`,
    attention: `What needs my attention on geo attendance and on-duty work${when}, and why?`,
    trend: `Is on-duty work rising or falling${when}? What changed in the last week?`,
    verification: `How well and how fast is on-duty work being verified by HR${when}? What is waiting the longest?`,
    groups: `Which departments, units or staff groups work outside the premises most${when}, and is anything unusual?`,
    reach: `How far from their units do people work on duty${when}? Who is far away or has no unit location?`,
    unusual: `Which on-duty sessions look unusual${when} (simulated GPS, far away, odd hours, left open, repeated rejections) and what should I check?`,
    people: `Who goes on duty most often${when}, and is it justified?`,
    live: "Who is on duty right now, who is awaiting approval and whose phone is not reporting a location?",
    compare: `How does on-duty work compare with the previous period${when}? Which figures moved most?`,
    briefing: `Explain the geo attendance summary${when} in more detail and tell me what to ask HR.`,
  };
}
