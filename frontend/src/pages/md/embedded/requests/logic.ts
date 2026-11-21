import type { StatTone } from "@/components/md/kit/StatCard";
import { changeTone, dayLong, monthText, num, pct, type Tone } from "@/lib/md/format";
import type { InsightsDefaults } from "../shared/filters";
import type { Drill, Metric, Requested, RqListItem, RqSummary, RqTrend } from "./types";

export const PAGE = "requests";
export const TITLE = "Requests";

/** The kinds of request, in the order the HR Requests page lists its sub-tabs (backend requests.KINDS). */
export const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All requests" },
  { value: "leave", label: "Leave" },
  { value: "permission", label: "Permission" },
  { value: "casual_leave", label: "Casual leave" },
  { value: "missing_punch", label: "Missing punch" },
  { value: "on_duty", label: "On-duty" },
  { value: "on_duty_punch", label: "On-duty punch" },
  { value: "outpass", label: "Outpass" },
  { value: "request", label: "Other requests" },
  { value: "resignation", label: "Resignation" },
  { value: "attendance_correction", label: "Attendance correction" },
  { value: "holiday_work", label: "Compensation claims" },
  { value: "advance", label: "Advance" },
];

export const kindLabel = (key: string) => KIND_OPTIONS.find((k) => k.value === key)?.label ?? key;

/** The tab's defaults (a module constant: the filter hook decides what to leave out of the address by it). */
export const DEFAULTS: InsightsDefaults = { extra: { kind: "all" } };

/** A length of time as the MD says it: "45 minutes", "5.5 hours", "3 days". */
export function hoursText(hours: number | null | undefined): string {
  if (hours == null) return "—";
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  if (hours < 48) {
    const h = Number(hours.toFixed(1));
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Number((hours / 24).toFixed(1));
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** "17 Nov 2026 to 18 Nov 2026 · 2 days", "Nov 2026" for a month, null when the request is not for a date. */
export function requestedText(r: Requested | null): string | null {
  if (!r) return null;
  const when =
    r.precision === "month"
      ? monthText(r.from.slice(0, 7))
      : r.to
        ? `${dayLong(r.from)} to ${dayLong(r.to)}`
        : dayLong(r.from);
  return r.note ? `${when} · ${r.note}` : when;
}

/** Where a request stands, in one line: "Waiting 2.5 days, with the Department Head", "Rejected by Priya in 4 hours". */
export function standingText(item: RqListItem): string {
  if (item.outcome === "waiting") {
    const who = item.holderLabel ? `, with ${item.holder === "hod" ? "the " : ""}${item.holderLabel}` : "";
    return `Waiting ${hoursText(item.ageHours)}${who}`;
  }
  const verb = item.outcome === "approved" ? (item.partial ? "Approved in part" : "Approved") : "Rejected";
  const by = item.decidedBy ? ` by ${item.decidedBy}` : "";
  const took = item.decisionHours != null ? ` in ${hoursText(item.decisionHours)}` : "";
  return `${verb}${by}${took}`;
}

/** "2026-11-09T09:00:00" -> "09 Nov 2026, 9:00 am". */
export function stampText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [d, t = "00:00"] = iso.split("T");
  const [h, m] = t.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${dayLong(d)}, ${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

type Delta = { text: string; tone: Tone; direction?: "up" | "down" | "flat" } | null;

/** A change chip for a count or a rate: "+12 (+50%)", "-3.2 pts", coloured by whether the move is good news. */
export function deltaOf(
  m: Metric<number | null> | undefined,
  opts: { higherIsBetter: boolean | null; points?: boolean },
): Delta {
  const c = m?.change;
  if (!c) return null;
  const direction = c.abs > 0 ? "up" : c.abs < 0 ? "down" : "flat";
  const tone = opts.higherIsBetter === null ? "neutral" : changeTone(c.abs, opts.higherIsBetter);
  const sign = c.abs > 0 ? "+" : "";
  if (opts.points) return { text: `${sign}${Number(c.abs.toFixed(1))} pts`, tone, direction };
  const share = c.pct != null ? ` (${c.pct > 0 ? "+" : ""}${Number(c.pct.toFixed(0))}%)` : "";
  return { text: `${sign}${num(c.abs, Number.isInteger(c.abs) ? 0 : 1)}${share}`, tone, direction };
}

export type Tile = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  tone: StatTone;
  delta?: Delta;
  provenanceIds: string[];
  drill?: Drill;
};

/** The eight headline figures, each opening the requests behind it. */
export function kpiTiles(s: RqSummary): Tile[] {
  const w = s.waiting;
  const m = s.metrics;
  const period = s.period?.label ?? "this period";
  return [
    {
      id: "waiting",
      label: "Waiting now",
      value: num(w.total),
      sub: `${num(w.withHr + w.withEither)} with HR · ${num(w.withDepartmentHead)} with Department Heads`,
      tone: "blue",
      provenanceIds: ["requests-waiting", "requests-holder"],
      drill: {
        title: "Waiting now",
        subtitle: "Every request nobody has decided yet, oldest first",
        params: { status: "waiting" },
      },
    },
    {
      id: "aged",
      label: `Waiting ${w.agedDays}+ days`,
      value: num(w.threeDaysPlus),
      sub: w.oldestHours != null ? `oldest ${hoursText(w.oldestHours)}` : "nothing waiting",
      tone: w.sevenDaysPlus > 0 ? "red" : w.threeDaysPlus > 0 ? "amber" : "green",
      provenanceIds: ["requests-aging"],
      drill: {
        title: `Waiting ${w.agedDays} days or more`,
        subtitle: "Oldest first, with who each one waits on",
        params: { status: "waiting", band: "aged" },
      },
    },
    {
      id: "hod",
      label: "With Department Heads",
      value: num(w.withDepartmentHead),
      sub: "need the Department Head first",
      tone: "purple",
      provenanceIds: ["requests-holder"],
      drill: {
        title: "Waiting on a Department Head",
        subtitle: "Only the Department Head can move these on",
        params: { status: "waiting", holder: "hod" },
      },
    },
    {
      id: "submitted",
      label: "Submitted",
      value: num(m.submitted.value),
      sub: period,
      tone: "indigo",
      delta: deltaOf(m.submitted, { higherIsBetter: null }),
      provenanceIds: ["requests-submitted", "requests-previous"],
      drill: {
        title: "Submitted",
        subtitle: `Requests made in ${period}, newest first`,
        params: { status: "submitted" },
      },
    },
    {
      id: "decided",
      label: "Decided",
      value: num(m.decided.value),
      sub: `${num(m.approved.value)} approved · ${num(m.rejected.value)} rejected`,
      tone: "slate",
      delta: deltaOf(m.decided, { higherIsBetter: true }),
      provenanceIds: ["requests-decided", "requests-previous"],
      drill: {
        title: "Decided",
        subtitle: `Approved or rejected in ${period}, newest first`,
        params: { status: "decided" },
      },
    },
    {
      id: "approval",
      label: "Approved",
      value: pct(m.approvalPct.value),
      sub: "of the requests decided",
      tone: "green",
      delta: deltaOf(m.approvalPct, { higherIsBetter: null, points: true }),
      provenanceIds: ["requests-approval"],
      drill: { title: "Approved", subtitle: `Approved in ${period}`, params: { status: "approved" } },
    },
    {
      id: "rejected",
      label: "Rejected",
      value: num(m.rejected.value),
      sub: m.rejectionPct.value != null ? `${pct(m.rejectionPct.value)} of the requests decided` : "none decided",
      tone: "red",
      delta: deltaOf(m.rejected, { higherIsBetter: null }),
      provenanceIds: ["requests-approval"],
      drill: {
        title: "Rejected",
        subtitle: `Rejected in ${period}, with the reason given`,
        params: { status: "rejected" },
      },
    },
    {
      id: "speed",
      label: "Typical time to decide",
      value: hoursText(m.medianHours.value),
      sub:
        m.withinDayPct.value != null
          ? `${pct(m.withinDayPct.value)} within a day · 9 in 10 within ${hoursText(m.p90Hours.value)}`
          : "no decisions",
      tone: "teal",
      delta: deltaOf(m.medianHours, { higherIsBetter: false }),
      provenanceIds: ["requests-turnaround"],
    },
  ];
}

export type TrendRow = { date: string; submitted: number; decided: number; previousSubmitted: number };

export const trendRows = (t: RqTrend): TrendRow[] =>
  t.points.map((p) => ({
    date: p.date,
    submitted: p.submitted,
    decided: p.decided,
    previousSubmitted: p.previousSubmitted,
  }));

export const hasTrend = (t: RqTrend) => t.points.some((p) => p.submitted || p.decided || p.previousSubmitted);

/** The questions the Ask AI buttons open with, about what the MD is looking at. */
export function askQuestions(period: string, kind: string, selection: string | null) {
  const what = kind === "all" ? "requests" : `${kindLabel(kind).toLowerCase()} requests`;
  const where = selection ? ` for ${selection}` : "";
  return {
    briefing: `Brief me on ${what} (${period})${where}: what is waiting and with whom, who is holding things up, and how fast they are decided.`,
    attention: `What needs my attention about ${what} (${period})${where}, and why?`,
    trend: `How did the number of ${what} submitted and decided change over ${period}${where}?`,
    waiting: `Which ${what} have waited longest${where}, and who is each one waiting on?`,
    groups: `Compare ${what} across kinds and departments (${period})${where}: where are they rejected or slow?`,
    bottlenecks: `Where do ${what} get stuck${where}: which Department Heads and approvers are slowest (${period})?`,
    rejections: `Why are ${what} being rejected (${period})${where}? What reasons do approvers give?`,
  };
}

/** What the assistant is told the MD is looking at. */
export function assistantSummary(s: RqSummary | undefined): Record<string, string> {
  if (!s) return {};
  return {
    "Waiting now": num(s.waiting.total),
    "Waiting 3+ days": num(s.waiting.threeDaysPlus),
    "With HR": num(s.waiting.withHr + s.waiting.withEither),
    "With Department Heads": num(s.waiting.withDepartmentHead),
    Submitted: num(s.metrics.submitted.value),
    Decided: num(s.metrics.decided.value),
    "Approval rate": pct(s.metrics.approvalPct.value),
    "Typical time to decide": hoursText(s.metrics.medianHours.value),
  };
}

/** The Requests page itself, opened on a kind and (when given) one request's details. */
export function requestsAddress(kind?: string | null, id?: number | null): string {
  const p = new URLSearchParams();
  if (kind && kind !== "all") p.set("kind", kind);
  if (kind && kind !== "all" && id != null) p.set("focus", String(id));
  const q = p.toString();
  return `/md/requests${q ? `?${q}` : ""}`;
}
