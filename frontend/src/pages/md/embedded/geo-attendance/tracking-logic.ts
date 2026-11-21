import type { BarItem } from "@/components/md/kit/BarList";
import { minutesText, num, pct } from "@/lib/md/format";
import type { KpiDelta } from "@/components/md/kit/dto";
import { deltaChip } from "./logic";
import type { AlertKind, GeoTracking, LiveRow, TrackState } from "./types";

// On-Duty tracking (the app's journeys) and the server's automatic alerts (2026-11-21): the pure logic behind the
// Tracking card and its drill-downs.

export type TrackingTile = {
  id: "journeys" | "km" | "gaps" | "alerts" | "escalated" | "fix";
  label: string;
  value: string;
  sub: string;
  delta: KpiDelta | null;
  /** What a click opens: the alert list (with a status) or nothing. */
  opens: "alerts" | "open-alerts" | "escalated" | null;
};

/** The six figures at the top of the Tracking card. */
export function trackingTiles(t: GeoTracking): TrackingTile[] {
  const j = t.journeys;
  const a = t.alerts;
  return [
    {
      id: "journeys",
      label: "Journeys tracked",
      value: num(j.count),
      sub: `${num(j.people)} ${j.people === 1 ? "person" : "people"} · ${num(j.stops)} stops`,
      delta: deltaChip(j.change, "pct", "none"),
      opens: null,
    },
    {
      id: "km",
      label: "Distance travelled",
      value: `${num(j.km, 1)} km`,
      sub: j.kmPerJourney == null ? "No journey" : `${num(j.kmPerJourney, 1)} km a journey`,
      delta: deltaChip(j.kmChange, "pct", "none"),
      opens: null,
    },
    {
      id: "gaps",
      label: "Journeys with gaps",
      value: j.withGapsPct == null ? "—" : pct(j.withGapsPct, 0),
      sub: `${num(j.withGaps)} of ${num(j.count)} · ${num(j.gapHours, 1)} h without data`,
      delta: null,
      opens: null,
    },
    {
      id: "alerts",
      label: "Automatic alerts",
      value: num(a.count),
      sub: `${num(a.people)} ${a.people === 1 ? "person" : "people"} · ${num(a.openNow)} open now`,
      delta: deltaChip(a.change, "pct", "down"),
      opens: "alerts",
    },
    {
      id: "escalated",
      label: "Escalated to the HOD",
      value: num(a.escalated),
      sub: a.escalatedPct == null ? "No alert" : `${pct(a.escalatedPct, 0)} of alerts`,
      delta: null,
      opens: "escalated",
    },
    {
      id: "fix",
      label: "Typical time to fix",
      value: a.medianMinutesToFix == null ? "—" : minutesText(Math.round(a.medianMinutesToFix)),
      sub: a.fixedPct == null ? "Nothing fixed yet" : `${pct(a.fixedPct, 0)} fixed by the employee`,
      delta: null,
      opens: null,
    },
  ];
}

/** The alert kinds as ranked bars (kinds with no alert left out), most first; "N open now" under a kind still open. */
export function alertKindBars(t: GeoTracking): (BarItem & { kind: AlertKind })[] {
  return (
    t.alerts.byKind
      .filter((k) => k.count > 0 || k.openNow > 0)
      // most first; a tie keeps the server's order (the HRMS's own order of the kinds)
      .sort((x, y) => y.count - x.count)
      .map((k) => ({
        key: k.kind,
        kind: k.kind,
        label: k.label,
        value: k.count,
        sub: k.openNow ? `${num(k.openNow)} open now` : undefined,
      }))
  );
}

/** The tone of a phone's tracking state on the live list: moving / stationary are fine, offline and location off are not. */
export function trackStateTone(state: TrackState | null | undefined): "good" | "warn" | "bad" | null {
  if (!state) return null;
  if (state === "moving" || state === "stationary") return "good";
  if (state === "waiting_first_fix") return "warn";
  return "bad";
}

/** The live row's tracking line: "Stationary · 64% battery · 2.0 km · 1 open alert". */
export function trackLine(
  row: Pick<LiveRow, "trackStateLabel" | "batteryPct" | "travelledKm" | "openAlerts">,
): string | null {
  if (!row.trackStateLabel) return null;
  const parts = [row.trackStateLabel];
  if (row.batteryPct != null) parts.push(`${num(row.batteryPct)}% battery`);
  if (row.travelledKm != null) parts.push(`${num(row.travelledKm, 1)} km`);
  if (row.openAlerts) parts.push(`${num(row.openAlerts)} open ${row.openAlerts === 1 ? "alert" : "alerts"}`);
  return parts.join(" · ");
}

/** The trend rows of the Tracking card's chart. */
export function trackingDays(t: GeoTracking) {
  return t.days.map((d) => ({ date: d.date, journeys: d.journeys, alerts: d.alerts, km: d.km }));
}

/** True when there is nothing tracked and no alert in the period (the card then says so instead of drawing zeros). */
export const trackingEmpty = (t: GeoTracking): boolean => t.journeys.count === 0 && t.alerts.count === 0;
