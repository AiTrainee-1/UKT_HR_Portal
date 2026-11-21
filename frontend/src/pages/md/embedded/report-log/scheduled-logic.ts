import { num, pct } from "@/lib/md/format";
import type { AbsenceMark, RlScheduled } from "./types";

// Scheduled attendance reports (Attendance Notify) and the absences drill-down: the pure logic, tested.

export type ScheduledFigure = { id: string; label: string; value: string; sub: string; tone?: "bad" | "good" };

/** The four figures at the top of the scheduled-reports card. */
export function scheduledFigures(s: RlScheduled): ScheduledFigure[] {
  const r = s.runs;
  const notReached = r.failed + r.partial;
  return [
    {
      id: "runs",
      label: "Reports sent",
      value: num(r.total),
      sub: `${num(r.scheduled)} on schedule · ${num(r.manual)} by hand · ${num(r.retries)} retried`,
    },
    {
      id: "delivered",
      label: "Recipients reached",
      value: num(s.delivered),
      sub: `${num(s.recipients)} different ${s.recipients === 1 ? "recipient" : "recipients"}`,
    },
    {
      id: "everyone",
      label: "Reached everyone",
      value: r.reachedEveryonePct == null ? "—" : pct(r.reachedEveryonePct, 0),
      sub: `${num(r.done)} of ${num(r.total)} runs`,
      tone: r.reachedEveryonePct != null && r.reachedEveryonePct >= 95 ? "good" : undefined,
    },
    {
      id: "failed",
      label: "Did not reach everyone",
      value: num(notReached),
      sub: `${num(r.failed)} failed · ${num(r.partial)} partly sent`,
      tone: notReached > 0 ? "bad" : undefined,
    },
  ];
}

/** One channel's line: "WhatsApp: 8 sent, 4 queued, 3 failed". */
export function channelText(c: RlScheduled["byChannel"][number]): string {
  const parts = [`${num(c.sent)} sent`];
  if (c.queued) parts.push(`${num(c.queued)} queued`);
  if (c.failed) parts.push(`${num(c.failed)} failed`);
  if (c.skipped) parts.push(`${num(c.skipped)} skipped`);
  return parts.join(", ");
}

/** True when nothing is scheduled at all (the card then says how to start). */
export const nothingScheduled = (s: RlScheduled): boolean => s.automations.total === 0 && s.runs.total === 0;

export const MARK_LABEL: Record<AbsenceMark, string> = {
  all: "All absences",
  informed: "Marked Informed",
  not_informed: "Marked Not informed",
  unmarked: "Not yet marked",
};

/** The tone of an absence's mark in the drill-down list. */
export const MARK_TONE: Record<Exclude<AbsenceMark, "all">, string> = {
  informed: "md-analytics-tone-good",
  not_informed: "md-analytics-tone-bad",
  unmarked: "md-analytics-tone-watch",
};

/** Which absences a headline tile opens (null: the tile is not a list). */
export function tileMark(tileId: string): AbsenceMark | null {
  switch (tileId) {
    case "absences":
      return "all";
    case "followed":
      return "informed";
    case "notInformed":
      return "not_informed";
    case "unmarked":
      return "unmarked";
    default:
      return null;
  }
}
