// Contract-shaped examples of the HoD's / Notify answers (scratchpad contract "HoD's + Notify", 2026-11-04), for the tests
// of both sections. Built exactly as the server sends them, so a test reads the same shapes the page does.

import type {
  HodCategory,
  HodPending,
  HodPendingItem,
  HodReminderSettings,
  HodRow,
  HodRun,
} from "@/lib/api-client/custom-hooks";

export const CATEGORIES: HodCategory[] = [
  { key: "leave", label: "Leave" },
  { key: "permission", label: "Permission" },
  { key: "casual_leave", label: "Casual Leave" },
  { key: "attendance", label: "Attendance" },
  { key: "missing_punch", label: "Missing Punch" },
  { key: "on_duty", label: "On-Duty" },
  { key: "outpass", label: "Outpass" },
  { key: "holiday_work", label: "Holiday Work" },
  { key: "resignation", label: "Resignation" },
];

const zero = (over: Record<string, number | null> = {}): Record<string, number | null> => ({
  leave: 0,
  permission: 0,
  casual_leave: null,
  attendance: 0,
  missing_punch: 0,
  on_duty: 0,
  outpass: 0,
  holiday_work: 0,
  resignation: 0,
  ...over,
});

export const item = (over: Partial<HodPendingItem> = {}): HodPendingItem => ({
  category: "leave",
  categoryLabel: "Leave",
  id: 12,
  employeeId: 101,
  employeeCode: "E101",
  employeeName: "Asha Kumar",
  department: "Cutting",
  forText: "05 - 07 Nov 2026",
  summary: "Leave · 3 days",
  raisedAt: "2026-11-01T04:30:00Z",
  waitingDays: 3,
  openPath: "/hr/requests?kind=leave&focus=12",
  ...over,
});

export const RAVI: HodRow = {
  managerId: 1,
  employeeId: 501,
  code: "M001",
  name: "Ravi Shankar",
  designation: "Production Manager",
  departments: ["Cutting", "Stitching"],
  branch: "Head Office",
  phone: "9800000001",
  email: "ravi@example.com",
  devices: 1,
  pending: 4,
  byCategory: zero({ leave: 2, permission: 1, missing_punch: 1 }),
  oldestPendingAt: "2026-10-27T05:00:00Z",
  oldestDays: 8,
  items: [
    item({ id: 14, raisedAt: "2026-11-02T04:30:00Z", waitingDays: 2, openPath: "/hr/requests?kind=leave&focus=14" }),
    item(),
    item({
      category: "permission",
      categoryLabel: "Permission",
      id: 33,
      employeeName: "Bala Murugan",
      employeeCode: "E102",
      forText: "Morning Late-In · 05 Nov",
      summary: "Permission · 1 hour",
      raisedAt: "2026-11-03T03:00:00Z",
      waitingDays: 1,
      openPath: "/hr/requests?kind=permission&focus=33",
    }),
    item({
      category: "missing_punch",
      categoryLabel: "Missing Punch",
      id: 7,
      employeeName: "Chitra Devi",
      employeeCode: "E103",
      department: "Stitching",
      forText: "27 Oct 2026",
      summary: "Missing Punch · Out",
      raisedAt: "2026-10-27T05:00:00Z",
      waitingDays: 8,
      openPath: "/hr/requests?kind=missing_punch&focus=7",
    }),
  ],
};

export const MEENA: HodRow = {
  managerId: 2,
  employeeId: 502,
  code: "M002",
  name: "Meena Rani",
  designation: "Finishing Head",
  departments: ["Finishing"],
  branch: "Unit 1",
  phone: null,
  email: "meena@example.com",
  devices: 0,
  pending: 1,
  byCategory: zero({ casual_leave: 1 }),
  oldestPendingAt: "2026-11-03T06:00:00Z",
  oldestDays: 1,
  items: [
    item({
      category: "casual_leave",
      categoryLabel: "Casual Leave",
      id: 40,
      employeeName: "Divya S",
      employeeCode: "E201",
      department: "Finishing",
      forText: "06 Nov 2026",
      summary: "Casual Leave · First half",
      raisedAt: "2026-11-03T06:00:00Z",
      waitingDays: 1,
      openPath: "/hr/requests?kind=casual_leave&focus=40",
    }),
  ],
};

export const KUMAR: HodRow = {
  managerId: 3,
  employeeId: 503,
  code: "M003",
  name: "Kumar Vel",
  designation: "Store Keeper",
  departments: ["Stores"],
  branch: "Head Office",
  phone: "9800000003",
  email: null,
  devices: 2,
  pending: 0,
  byCategory: zero(),
  oldestPendingAt: null,
  oldestDays: null,
  items: [],
};

export const HOD_PENDING: HodPending = {
  generatedAt: "2026-11-04T05:00:00Z",
  categories: CATEGORIES,
  totals: {
    hods: 3,
    withPending: 2,
    pending: 5,
    byCategory: { leave: 2, permission: 1, casual_leave: 1, missing_punch: 1 },
  },
  hods: [RAVI, MEENA, KUMAR],
};

export const DEFAULT_TEMPLATE = [
  "Dear {{name}},",
  "You currently have some pending requests awaiting your approval in the UK Textiles HRMS application.",
  "Pending requests:",
  "{{pendingList}}",
  "Kindly review and approve the pending requests at the earliest.",
  "Regards,",
  "HR Team – UKT",
].join("\n");

export const RUN_DONE: HodRun = {
  id: 9,
  trigger: "schedule",
  slot: "10:00",
  startedAt: "2026-11-04T04:30:05Z",
  finishedAt: "2026-11-04T04:30:40Z",
  status: "done",
  sentBy: null,
  error: null,
  hods: 2,
  counts: {
    whatsapp: { sent: 1, failed: 0, skipped: 1 },
    email: { sent: 2, failed: 0, skipped: 0 },
    push: { sent: 1, failed: 0, skipped: 1 },
  },
};

export const SETTINGS: HodReminderSettings = {
  enabled: true,
  times: ["10:00", "16:00"],
  days: [0, 1, 2, 3, 4, 5],
  channels: { whatsapp: true, email: true, push: true },
  onlyWithPending: true,
  template: DEFAULT_TEMPLATE,
  defaultTemplate: DEFAULT_TEMPLATE,
  nextRunAt: "2026-11-04T10:30:00Z",
  lastRun: RUN_DONE,
  channelStatus: {
    whatsapp: { available: true, note: "Sent through the WhatsApp Business number" },
    email: { available: false, note: "SMTP is not set up in Settings: emails will be skipped" },
    push: { available: true, note: "Goes to the phones the HoDs signed in on" },
  },
  canEdit: true,
  companyWide: true,
};
