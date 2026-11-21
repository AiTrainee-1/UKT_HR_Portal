import { changeTone, num, pct, type Tone } from "@/lib/md/format";
import type { Change, EmpSummary, EmpWorkforce, MovementPoint, PeopleAsk, PersonRow } from "./types";

// Pure shaping for the Employees Insights (tested in logic.test.ts).

export type Delta = { text: string; tone: Tone; direction: "up" | "down" | "flat" };

/** A change chip: "+3", "-1.2 pts", coloured by whether up is good news (null good = neither). */
export function deltaChip(change: Change, good: "up" | "down" | null, unit = "", places = 0): Delta | null {
  if (!change) return null;
  const abs = change.abs;
  const direction = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  const tone: Tone = good === null || abs === 0 ? "neutral" : changeTone(abs, good === "up");
  const sign = abs > 0 ? "+" : abs < 0 ? "-" : "";
  return { text: `${sign}${num(Math.abs(abs), places)}${unit ? ` ${unit}` : ""}`, tone, direction };
}

export type TileId = "headcount" | "joiners" | "leavers" | "net" | "attrition" | "early" | "factory" | "tenure";

export type Tile = {
  id: TileId;
  label: string;
  value: string;
  sub?: string;
  delta?: Delta | null;
  provenanceIds: string[];
  /** What a click on the tile lists (none: it has no list behind it). */
  ask?: PeopleAsk;
};

/** The eight headline tiles of the tab, in order. `label` is the month or period in words. */
export function kpiTiles(s: EmpSummary, label: string): Tile[] {
  const h = s.headcount;
  const end = h.closing ?? h.current;
  const factory = h.factory ?? 0;
  return [
    {
      id: "headcount",
      label: "Headcount at the end",
      value: num(end),
      sub: `${num(h.staff)} staff · ${num(h.production)} production today`,
      delta: deltaChip(h.change, null),
      provenanceIds: ["headcount", "reconstructed-headcount"],
      ask: { group: "active", title: "People here today", open: { path: "/md/employees", label: "Open in Employees" } },
    },
    {
      id: "joiners",
      label: "Joiners",
      value: num(s.joiners.count),
      sub: `${num(s.joiners.previous)} the period before`,
      delta: deltaChip(s.joiners.change, null),
      provenanceIds: ["joiners-leavers"],
      ask: { group: "joiners", title: "Joiners", subtitle: label },
    },
    {
      id: "leavers",
      label: "Leavers",
      value: num(s.leavers.count),
      sub: s.leavers.approximate
        ? `${num(s.leavers.approximate)} with an approximate date`
        : `${num(s.leavers.previous)} the period before`,
      delta: deltaChip(s.leavers.change, "down"),
      provenanceIds: ["joiners-leavers"],
      ask: { group: "leavers", title: "Leavers", subtitle: label },
    },
    {
      id: "net",
      label: "Net change",
      value: `${s.net.count > 0 ? "+" : ""}${num(s.net.count)}`,
      sub: "joiners minus leavers",
      delta: deltaChip(s.net.change, "up"),
      provenanceIds: ["joiners-leavers"],
    },
    {
      id: "attrition",
      label: "Attrition",
      value: pct(s.attrition.pct),
      sub:
        s.attrition.annualisedPct != null
          ? `${pct(s.attrition.annualisedPct)} a year at this pace`
          : "of the average headcount",
      delta: deltaChip(s.attrition.change, "down", "pts", 1),
      provenanceIds: ["attrition"],
      ask: { group: "leavers", title: "Leavers", subtitle: label },
    },
    {
      id: "early",
      label: "Left within 90 days",
      value: num(s.earlyAttrition.count),
      sub: s.earlyAttrition.pctOfLeavers != null ? `${pct(s.earlyAttrition.pctOfLeavers)} of leavers` : "no leavers",
      delta: deltaChip(s.earlyAttrition.change, "down"),
      provenanceIds: ["early-attrition"],
      ask: { group: "early", title: "Left within 90 days of joining", subtitle: label },
    },
    {
      id: "factory",
      label: "Factory Employees",
      value: num(factory),
      sub: h.current ? `${pct((100 * factory) / h.current)} of the people here today` : undefined,
      provenanceIds: ["headcount"],
      ask: {
        group: "factory",
        title: "Factory Employees",
        open: { path: "/md/employees/factory-emp", label: "Open Factory Employees" },
      },
    },
    {
      id: "tenure",
      label: "Average tenure",
      value: s.tenure.averageYears != null ? `${num(s.tenure.averageYears, 1)} yrs` : "—",
      sub: s.tenure.unknown ? `${num(s.tenure.unknown)} without a usable join date` : "on the last day",
      delta: deltaChip(s.tenure.change, "up", "yrs", 1),
      provenanceIds: ["tenure"],
    },
  ];
}

/** The movement chart's rows: joiners and leavers per bucket, with the headcount on the right axis. */
export function movementRows(points: MovementPoint[]) {
  return points.map((p) => ({ label: p.label, joiners: p.joiners, leavers: p.leavers, headcount: p.headcount }));
}

/** The second line of a person in a drill-down list. */
export function personSecondary(r: PersonRow): string {
  return [r.designation, r.department, r.unit, r.type === "production" && r.cycle ? `${r.cycle} pay` : null]
    .filter(Boolean)
    .join(" · ");
}

/** What a group card row asks the people list for. */
export function workforceAsks(w: EmpWorkforce) {
  return {
    labels: w.factory.labels.map((l) => ({
      key: `label-${l.id ?? "none"}`,
      label: l.label,
      value: l.people,
      ask: {
        group: "factory",
        value: l.id == null ? "none" : String(l.id),
        title: `Factory Employees: ${l.label}`,
        open: { path: "/md/employees/factory-emp", label: "Open Factory Employees" },
      } satisfies PeopleAsk,
    })),
    cycles: w.cycles.rows.map((c) => ({
      key: `cycle-${c.key}`,
      label: c.key === "none" ? "No pay cycle yet" : c.label,
      value: c.people,
      ask: { group: "cycle", value: c.key, title: `Production pay cycle: ${c.label}` } satisfies PeopleAsk,
    })),
    statutory: w.statutory.map((s) => ({
      key: `statutory-${s.key}`,
      label: s.label,
      value: s.people,
      ask: { group: "statutory", value: s.key, title: s.label } satisfies PeopleAsk,
    })),
  };
}

/** What the assistant is told the MD sees. */
export function assistantSummary(s: EmpSummary | undefined, w: EmpWorkforce | undefined): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {
    Headcount: num(s.headcount.closing ?? s.headcount.current),
    Joiners: num(s.joiners.count),
    Leavers: num(s.leavers.count),
    Attrition: pct(s.attrition.pct),
  };
  if (w) {
    out["Factory Employees"] = num(w.factory.people);
    out["Production without a pay cycle"] = num(w.cycles.unassigned);
  }
  return out;
}
