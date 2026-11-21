// Fixtures for the On-Duty tracking card and its drill-downs: the backend's TrackingBase company (api/tests_md_geo.py),
// so each number traces to a journey or an alert there. Not used by the page itself.

import type { GeoAlerts, GeoPersonDetail, GeoTracking } from "./types";
import { PERIOD, SCOPE } from "./fixtures";

const PROVENANCE = [
  {
    id: "geo-journeys",
    title: "On-Duty journeys",
    dataset: "On-Duty tracking (tracks)",
    definition: "Each tracked on-duty session has one journey.",
    formula: null,
    rows: 3,
    filters: [],
    caveats: [],
  },
];

const KINDS: GeoTracking["alerts"]["byKind"] = [
  { kind: "location_off", label: "Location turned off", count: 1, openNow: 1 },
  { kind: "permission_restricted", label: "Background location permission restricted", count: 1, openNow: 0 },
  { kind: "background_restricted", label: "Background app restriction", count: 0, openNow: 0 },
  { kind: "tracking_failure", label: "On-Duty tracking failure", count: 0, openNow: 0 },
  { kind: "missing_punch", label: "Missing Geo-Punch", count: 1, openNow: 0 },
  { kind: "punch_reminder", label: "Geo-Punch reminder", count: 1, openNow: 0 },
];

const days = Array.from({ length: 14 }, (_, i) => {
  const date = `2026-09-${String(i + 1).padStart(2, "0")}`;
  if (date === "2026-09-02") return { date, journeys: 2, km: 23.5, alerts: 3 };
  if (date === "2026-09-03") return { date, journeys: 1, km: 40.5, alerts: 1 };
  return { date, journeys: 0, km: 0, alerts: 0 };
});

export const tracking: GeoTracking = {
  generatedAt: "2026-09-15T15:30:00",
  period: PERIOD,
  scope: SCOPE,
  provenance: PROVENANCE,
  notes: [],
  journeys: {
    count: 3,
    previous: 1,
    change: { abs: 2, pct: 200 },
    people: 3,
    km: 64,
    kmPrevious: 5,
    kmChange: { abs: 59, pct: 1180 },
    kmPerJourney: 21.3,
    travelHours: 4.5,
    stopHours: 3.5,
    gapHours: 0.7,
    stops: 6,
    withGaps: 2,
    withGapsPct: 66.7,
    mockPoints: 4,
    withMock: 1,
    gpsOffEvents: 0,
    backgroundRestrictedEvents: 0,
    ended: [
      { reason: "manual", label: "Employee marked Done", count: 1 },
      { reason: "auto_4th_punch", label: "4th punch captured", count: 1 },
      { reason: "auto_day_end", label: "Day ended automatically", count: 1 },
      { reason: "rejected", label: "Request rejected", count: 0 },
      { reason: "admin", label: "Ended by an administrator", count: 0 },
    ],
    stillRecording: 0,
  },
  alerts: {
    count: 4,
    previous: 1,
    change: { abs: 3, pct: 300 },
    people: 2,
    escalated: 1,
    escalatedPct: 25,
    fixed: 3,
    fixedPct: 75,
    openFromPeriod: 0,
    openNow: 1,
    medianMinutesToFix: 30,
    pushed: 1,
    whatsapp: 1,
    byKind: KINDS,
  },
  days,
  topAlerted: [
    { employeeId: 101, employeeCode: "A", employeeName: "Asha Test", department: "Sales", alerts: 3, open: 0 },
    { employeeId: 104, employeeCode: "D", employeeName: "Dinesh Test", department: "Sales", alerts: 1, open: 0 },
  ],
  topDistance: [
    {
      employeeId: 104,
      employeeCode: "D",
      employeeName: "Dinesh Test",
      department: "Sales",
      journeys: 1,
      km: 40.5,
      gapHours: 0.5,
    },
  ],
  repeatAlertsMin: 3,
};

export const emptyTracking: GeoTracking = {
  ...tracking,
  journeys: {
    ...tracking.journeys,
    count: 0,
    previous: 0,
    change: { abs: 0, pct: null },
    people: 0,
    km: 0,
    kmPrevious: 0,
    kmChange: { abs: 0, pct: null },
    kmPerJourney: null,
    withGaps: 0,
    withGapsPct: null,
  },
  alerts: {
    ...tracking.alerts,
    count: 0,
    previous: 0,
    change: { abs: 0, pct: null },
    people: 0,
    escalated: 0,
    escalatedPct: null,
    fixed: 0,
    fixedPct: null,
    openNow: 0,
    medianMinutesToFix: null,
    byKind: KINDS.map((k) => ({ ...k, count: 0, openNow: 0 })),
  },
  days: days.map((d) => ({ ...d, journeys: 0, km: 0, alerts: 0 })),
  topAlerted: [],
  topDistance: [],
};

export function alerts(params: URLSearchParams): GeoAlerts {
  const rows: GeoAlerts["rows"] = [
    {
      id: 3,
      kind: "permission_restricted",
      kindLabel: "Background location permission restricted",
      employeeId: 104,
      employeeCode: "D",
      employeeName: "Dinesh Test",
      department: "Sales",
      destination: "Site visit",
      detectedAt: "2026-09-03T09:30:00",
      resolvedAt: "2026-09-03T23:50:00",
      open: false,
      resolution: "Day over",
      minutes: 860,
      employeeTold: true,
      escalated: false,
      departmentHead: null,
    },
    {
      id: 2,
      kind: "missing_punch",
      kindLabel: "Missing Geo-Punch",
      employeeId: 101,
      employeeCode: "A",
      employeeName: "Asha Test",
      department: "Sales",
      destination: "Site visit",
      detectedAt: "2026-09-02T11:00:00",
      resolvedAt: "2026-09-02T11:40:00",
      open: false,
      resolution: "Fixed",
      minutes: 40,
      employeeTold: true,
      escalated: true,
      departmentHead: "Esha Test",
    },
  ];
  const kind = params.get("kind");
  const status = params.get("status");
  const shown = rows.filter((r) => (!kind || r.kind === kind) && (status !== "escalated" || r.escalated));
  return {
    generatedAt: "2026-09-15T15:30:00",
    period: PERIOD,
    scope: SCOPE,
    provenance: [],
    notes: [],
    filters: { kind: (kind as GeoAlerts["filters"]["kind"]) ?? null, employee: null, status: "all" },
    rows: shown,
    total: shown.length,
    page: 1,
    pageSize: 25,
    pages: 1,
    kinds: KINDS.map((k) => ({ kind: k.kind, label: k.label })),
  };
}

export const person: GeoPersonDetail = {
  generatedAt: "2026-09-15T15:30:00",
  period: PERIOD,
  scope: SCOPE,
  provenance: [],
  notes: [],
  employee: { id: 101, employeeCode: "A", employeeName: "Asha Test", department: "Sales", unit: "Unit 1" },
  totals: { sessions: 3, punches: 5, verified: 2, rejected: 3, pending: 0, km: 15.2, alerts: 3 },
  sessions: [
    {
      date: "2026-09-04",
      since: "2026-09-04T08:00:00",
      destination: "Site visit",
      status: "rejected",
      punches: 2,
      verified: 0,
      rejected: 2,
      pending: 0,
      tracked: false,
      km: null,
      travelHours: null,
      stops: null,
      gapHours: null,
      ended: null,
      mockPoints: 0,
    },
    {
      date: "2026-09-02",
      since: "2026-09-02T08:00:00",
      destination: "Dyeing unit",
      status: "completed",
      punches: 2,
      verified: 2,
      rejected: 0,
      pending: 0,
      tracked: true,
      km: 15.2,
      travelHours: 1.5,
      stops: 3,
      gapHours: 0.2,
      ended: "4th punch captured",
      mockPoints: 0,
    },
  ],
  alerts: [
    {
      kind: "missing_punch",
      kindLabel: "Missing Geo-Punch",
      detectedAt: "2026-09-02T11:00:00",
      resolvedAt: "2026-09-02T11:40:00",
      resolution: "Fixed",
      escalated: true,
    },
  ],
};
