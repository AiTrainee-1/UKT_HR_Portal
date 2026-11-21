import { dayShort, num, pct } from "@/lib/md/format";
import { deltaChip, type Delta } from "../employees/logic";
import type { ShiftPeople, ShiftsAttendance, ShiftsChanges, ShiftsCoverage, ShiftsSummary } from "./types";

// Pure shaping for the Manage Shift Insights (tested in logic.test.ts).

export const NONE_KEY = "none";

export type ShiftTileId = "active" | "covered" | "none" | "changes" | "ending" | "overlap" | "production" | "inUse";

export type ShiftTile = {
  id: ShiftTileId;
  label: string;
  value: string;
  sub?: string;
  delta?: Delta | null;
  provenanceIds: string[];
  /** The shift key whose people a click lists. */
  people?: string;
};

/** The headline tiles: who is on a shift today, changes in the period, what needs a decision, production. */
export function shiftTiles(s: ShiftsSummary): ShiftTile[] {
  const e = s.employees;
  const p = s.production;
  return [
    {
      id: "active",
      label: "Active employees",
      value: num(e.active),
      sub: `${num(e.staff)} staff · ${num(e.production)} production`,
      provenanceIds: ["shift-coverage"],
    },
    {
      id: "covered",
      label: "On a shift today",
      value: pct(e.coveragePct),
      sub: `${num(e.onShift)} of ${num(e.active)}`,
      provenanceIds: ["shift-coverage"],
    },
    {
      id: "none",
      label: "Without a shift",
      value: num(e.noShift),
      sub: e.startsLater ? `${num(e.startsLater)} start one later` : "no late or half-day detection for them",
      provenanceIds: ["shift-unassigned"],
      people: NONE_KEY,
    },
    {
      id: "changes",
      label: "Shift changes",
      value: num(s.changes.moved),
      sub: `${num(s.changes.peopleMoved)} moved · ${num(s.changes.first)} first shifts`,
      delta: deltaChip(s.changes.change.moved, null),
      provenanceIds: ["shift-changes", "shift-previous"],
    },
    {
      id: "ending",
      label: "Ending soon",
      value: num(s.watch.endingSoon),
      sub: `in ${s.watch.days} days, nothing after`,
      provenanceIds: ["shift-watch"],
    },
    {
      id: "overlap",
      label: "On two shifts",
      value: num(s.watch.overlapping),
      sub: "two assignments at once",
      provenanceIds: ["shift-watch"],
    },
    {
      id: "production",
      label: "Production workers",
      value: num(p?.workers ?? e.production),
      sub: p?.inForce
        ? `${num(p.onSpecial ?? 0)} on a special shift · ${num(p.defaults)} default shifts`
        : "on production shift templates",
      provenanceIds: ["shift-production", "shift-coverage"],
      people: p?.inForce ? "production" : undefined,
    },
    {
      id: "inUse",
      label: "Staff shifts in use",
      value: `${num(s.shifts.inUse)} of ${num(s.shifts.active)}`,
      sub: s.shifts.unused ? `${num(s.shifts.unused)} with nobody on them` : "every active shift has people",
      provenanceIds: ["shift-templates"],
    },
  ];
}

/** The people-per-shift bars: every shift with its people, then "No shift assigned" when anyone has none. */
export function shiftBars(c: ShiftsCoverage) {
  const rows = c.shifts.map((s) => ({
    key: s.key,
    label: s.label,
    value: s.people,
    sub: [
      s.start && s.end ? `${s.start}-${s.end}` : s.start,
      s.source === "production" ? (s.detail ?? "picked by the first punch") : s.unit,
      s.type,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  if (c.noShift.people > 0) {
    rows.push({
      key: NONE_KEY,
      label: "No shift assigned",
      value: c.noShift.people,
      sub: "staff without a shift today",
    });
  }
  return rows;
}

/** The changes chart: one row per day or week. */
export function changeRows(c: ShiftsChanges) {
  return c.points.map((p) => ({ label: dayShort(p.date), moved: p.moved, first: p.first, renewed: p.renewed }));
}

/** Late arrivals by shift, the busiest first, small samples said. */
export function lateBars(a: ShiftsAttendance) {
  return a.rows
    .filter((r) => r.latePct != null)
    .map((r) => ({
      key: r.key,
      label: r.label,
      value: r.latePct ?? 0,
      sub: `${num(r.lateDays)} late of ${num(r.workedDays)} worked days${r.lowSample ? " · small sample" : ""}`,
    }));
}

/** "Since 01 Aug 2026" / "01 Aug - 20 Oct" for a person on a shift. */
export function spanText(row: ShiftPeople["rows"][number]): string | undefined {
  if (!row.since) return undefined;
  return row.until ? `${dayShort(row.since)} - ${dayShort(row.until)}` : `since ${dayShort(row.since)}`;
}

/** What the assistant is told the MD sees. */
export function assistantSummary(s: ShiftsSummary | undefined): Record<string, string> {
  if (!s) return {};
  return {
    "Active employees": num(s.employees.active),
    "On a shift": pct(s.employees.coveragePct),
    "Without a shift": num(s.employees.noShift),
    "Shift changes": num(s.changes.moved),
    "Ending soon": num(s.watch.endingSoon),
  };
}
