// Fixtures for the scheduled-reports card and the absences drill-down: the backend's ScheduledReportTests and
// AbsenceDrillDownTests (api/tests_md_reportlog.py), so each number traces to a run or an absence there.

import { PERIOD, SCOPE } from "./fixtures";
import type { AbsenceRow, RlAbsences, RlScheduled } from "./types";

export const scheduled: RlScheduled = {
  generatedAt: "2026-09-21T10:00:00",
  period: PERIOD,
  provenance: [],
  notes: [],
  automations: {
    total: 3,
    active: 2,
    byChannel: [
      { channel: "chat", label: "Chat", total: 1, active: 0 },
      { channel: "email", label: "Gmail", total: 1, active: 1 },
      { channel: "whatsapp", label: "WhatsApp", total: 1, active: 1 },
    ],
  },
  runs: {
    total: 8,
    previous: 2,
    change: { abs: 6, pct: 300 },
    done: 6,
    partial: 1,
    failed: 1,
    skipped: 0,
    running: 0,
    scheduled: 6,
    manual: 1,
    retries: 1,
    reachedEveryonePct: 75,
  },
  delivered: 13,
  deliveredPrevious: 2,
  recipients: 2,
  byChannel: [
    { channel: "email", label: "Gmail", sent: 2, queued: 0, failed: 0, skipped: 0, pending: 0 },
    { channel: "whatsapp", label: "WhatsApp", sent: 7, queued: 4, failed: 3, skipped: 0, pending: 0 },
  ],
  byAutomation: [
    {
      automation: "Absent list 09:30",
      channel: "whatsapp",
      label: "WhatsApp",
      runs: 7,
      done: 5,
      failed: 2,
      lastRun: null,
    },
  ],
  failures: [
    {
      id: 7,
      automation: "Absent list 09:30",
      channel: "WhatsApp",
      date: "2026-09-11",
      slot: "09:30",
      status: "partial",
      trigger: "schedule",
      error: "",
      failedDeliveries: 1,
    },
    {
      id: 5,
      automation: "Absent list 09:30",
      channel: "WhatsApp",
      date: "2026-09-09",
      slot: "09:30",
      status: "failed",
      trigger: "schedule",
      error: "WhatsApp is not configured",
      failedDeliveries: 2,
    },
  ],
  days: [],
  lastRun: { automation: "Daily summary mail", channel: "Gmail", date: "2026-09-13", slot: null, status: "done" },
};

export const emptyScheduled: RlScheduled = {
  ...scheduled,
  automations: { total: 0, active: 0, byChannel: [] },
  runs: {
    ...scheduled.runs,
    total: 0,
    previous: 0,
    change: { abs: 0, pct: null },
    done: 0,
    partial: 0,
    failed: 0,
    scheduled: 0,
    manual: 0,
    retries: 0,
    reachedEveryonePct: null,
  },
  delivered: 0,
  deliveredPrevious: 0,
  recipients: 0,
  byChannel: [],
  byAutomation: [],
  failures: [],
  lastRun: null,
};

const ROWS: AbsenceRow[] = [
  {
    date: "2026-09-11",
    weekday: "Fri",
    employeeId: 1,
    employeeCode: "T001",
    employeeName: "Asha Test",
    department: "Stitching",
    unit: "Unit A",
    type: "staff",
    mark: "not_informed",
    absencesInSelection: 3,
  },
  {
    date: "2026-09-08",
    weekday: "Tue",
    employeeId: 2,
    employeeCode: "T002",
    employeeName: "Bala Test",
    department: "Stitching",
    unit: "Unit A",
    type: "staff",
    mark: "unmarked",
    absencesInSelection: 3,
  },
  {
    date: "2026-09-08",
    weekday: "Tue",
    employeeId: 4,
    employeeCode: "T004",
    employeeName: "Dev Test",
    department: "Stitching",
    unit: "Unit A",
    type: "production",
    mark: "unmarked",
    absencesInSelection: 2,
  },
];

export function absences(params: URLSearchParams): RlAbsences {
  const mark = (params.get("mark") ?? "all") as RlAbsences["filters"]["mark"];
  const day = params.get("day");
  const rows = ROWS.filter((r) => (mark === "all" || r.mark === mark) && (!day || r.date === day));
  return {
    generatedAt: "2026-09-21T10:00:00",
    period: PERIOD,
    scope: SCOPE,
    provenance: [],
    notes: [],
    filters: { mark, day, by: null, group: null },
    counts: { absences: 9, informed: 2, notInformed: 2, unmarked: 5, reviewedPct: 44.4 },
    rows,
    total: rows.length,
    page: 1,
    pageSize: 25,
    pages: 1,
  };
}
