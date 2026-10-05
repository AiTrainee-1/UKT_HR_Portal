// Fixtures for the Activity Logs tests: every endpoint the page calls, answering like the server does for the standard
// week of the backend tests (api/tests_md_activity.py: 13 actions, 8 sensitive, 4 after hours, 7 sign-ins).

import type { Provenance } from "@/lib/md/types";
import type { Fixtures } from "../testing/renderMdPage";
import type {
  ActivityAfterHours,
  ActivityAreas,
  ActivityAttention,
  ActivityFeed,
  ActivityHeatmap,
  ActivitySensitive,
  ActivitySignIns,
  ActivitySummary,
  ActivityTrend,
  ActivityUsers,
  CategoryCount,
  FeedItem,
  RuleRow,
} from "./types";

const prov = (id: string, title: string, extra: Partial<Provenance> = {}): Provenance => ({
  id,
  title,
  dataset: "Audit trail",
  definition: `How ${title.toLowerCase()} is counted.`,
  formula: null,
  rows: null,
  filters: [],
  caveats: [],
  ...extra,
});

const COVERAGE = "The audit trail does not record looking at screens, salary-record edits or payroll approvals.";

const period = {
  start: "2026-09-28",
  end: "2026-10-04",
  preset: "custom",
  label: "28 Sep – 04 Oct 2026",
  days: 7,
};
const workingHours = { startHour: 7, endHour: 21, weeklyOff: "Sunday", label: "7 am to 9 pm, Monday to Saturday" };
const base = { generatedAt: "2026-10-05T10:42:10", period, notes: [] as string[] };

export const summary: ActivitySummary = {
  ...base,
  previousPeriod: { start: "2026-09-21", end: "2026-09-27", preset: null, label: "Previous 7 days", days: 7 },
  actions: { value: 13, previous: 5, change: { abs: 8, pct: 160 } },
  activeUsers: { value: 4, previous: 2, change: { abs: 2, pct: 100 }, enabledAccounts: 4 },
  sensitive: { value: 8, previous: 1, change: { abs: 7, pct: 700 }, critical: 1, high: 4, medium: 3 },
  afterHours: { value: 4, previous: 2, change: { abs: 2, pct: 100 }, weekend: 1, night: 3, sharePct: 30.8 },
  signIns: { value: 7, previous: 1, change: { abs: 6, pct: 600 }, people: 4 },
  failedSignIns: { value: 6, previous: 1, change: { abs: 5, pct: 500 }, lockouts: 1, blockedAttempts: 1 },
  workingHours,
  provenance: [
    prov("actions", "Actions", { rows: 180, caveats: [COVERAGE] }),
    prov("active-users", "Active people"),
    prov("sensitive", "Sensitive actions", { caveats: [COVERAGE] }),
    prov("after-hours", "After-hours actions"),
    prov("sign-ins", "Sign-ins"),
    prov("failed-sign-ins", "Failed sign-ins"),
  ],
};

const day = (
  date: string,
  actions: number,
  sensitive: number,
  afterHours: number,
  signIns: number,
  failed: number,
) => ({
  date,
  end: date,
  actions,
  sensitive,
  afterHours,
  signIns,
  failedSignIns: failed,
  activeUsers: Math.min(3, Math.max(1, signIns + 1)),
});

export const trend: ActivityTrend = {
  ...base,
  granularity: "day",
  points: [
    day("2026-09-28", 3, 0, 1, 1, 0),
    day("2026-09-29", 2, 1, 1, 2, 2),
    day("2026-09-30", 1, 1, 1, 1, 3),
    day("2026-10-01", 1, 1, 0, 1, 1),
    day("2026-10-02", 4, 4, 0, 1, 0),
    day("2026-10-03", 1, 1, 0, 1, 0),
    day("2026-10-04", 1, 0, 1, 0, 0),
  ],
  total: { actions: 13, sensitive: 8 },
  busiest: { date: "2026-10-02", end: "2026-10-02", actions: 4 },
  averagePerDay: 1.9,
  provenance: [prov("trend", "Activity over time"), prov("sensitive", "Sensitive actions")],
};

export const attention: ActivityAttention = {
  generatedAt: base.generatedAt,
  window: { start: "2026-09-29", end: "2026-10-05", preset: null, label: "Last 7 days", days: 7 },
  insights: [
    {
      id: "activity.new-device",
      severity: "warning",
      title: "Chandra S (Super admin) signed in from a new device",
      detail: "Chandra S on Safari on iPhone. Check it was them.",
      metric: "1",
      page: "activity",
      ask: "Which privileged accounts signed in from a new device recently?",
    },
    {
      id: "activity.critical-events",
      severity: "critical",
      title: "1 critical system change in the last 7 days",
      detail: "Managing Director access assigned by Chandra S on 01 Oct.",
      metric: "1",
      page: "activity",
      ask: "What critical system changes were made in the last 7 days, by whom and when?",
    },
  ],
  provenance: [prov("attention", "What stands out")],
  notes: [],
};

export const areas: ActivityAreas = {
  ...base,
  areas: [
    {
      area: "employees",
      label: "Employees",
      actions: 9,
      sharePct: 69.2,
      sensitive: 4,
      previous: 5,
      change: { abs: 4, pct: 80 },
      people: 3,
    },
    {
      area: "access",
      label: "Accounts & access",
      actions: 2,
      sharePct: 15.4,
      sensitive: 2,
      previous: 0,
      change: { abs: 2, pct: null },
      people: 1,
    },
    {
      area: "payroll",
      label: "Payroll & pay",
      actions: 1,
      sharePct: 7.7,
      sensitive: 1,
      previous: 0,
      change: { abs: 1, pct: null },
      people: 1,
    },
    {
      area: "reports",
      label: "Reports & exports",
      actions: 1,
      sharePct: 7.7,
      sensitive: 1,
      previous: 0,
      change: { abs: 1, pct: null },
      people: 1,
    },
  ],
  total: 13,
  previousTotal: 5,
  provenance: [prov("areas", "Actions by area")],
};

export const users: ActivityUsers = {
  ...base,
  users: [
    {
      userName: "Anita Rao",
      role: "Payroll Officer",
      actions: 7,
      sharePct: 53.8,
      sensitive: 5,
      afterHours: 0,
      signIns: 2,
      lastActive: "2026-10-03T20:59:59",
      topArea: "Employees",
      previous: 2,
      change: { abs: 5, pct: 250 },
    },
    {
      userName: "Babu K",
      role: "HR Executive",
      actions: 3,
      sharePct: 23.1,
      sensitive: 1,
      afterHours: 2,
      signIns: 2,
      lastActive: "2026-10-04T11:00:00",
      topArea: "Employees",
      previous: 3,
      change: { abs: 0, pct: 0 },
    },
    {
      userName: "Chandra S",
      role: "Super admin",
      actions: 3,
      sharePct: 23.1,
      sensitive: 2,
      afterHours: 2,
      signIns: 2,
      lastActive: "2026-10-01T14:00:00",
      topArea: "Accounts & access",
      previous: 0,
      change: { abs: 3, pct: null },
    },
  ],
  totalPeople: 3,
  total: 13,
  others: null,
  provenance: [prov("users", "Actions by person"), prov("after-hours", "After-hours actions")],
};

const grid = (cells: [number, number, number][]): number[][] => {
  const out = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const [weekday, hour, n] of cells) out[weekday][hour] = n;
  return out;
};

export const heatmap: ActivityHeatmap = {
  ...base,
  rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  hours: Array.from({ length: 24 }, (_, h) => h),
  values: grid([
    [0, 0, 1],
    [0, 10, 1],
    [0, 11, 1],
    [1, 9, 1],
    [1, 23, 1],
    [2, 6, 1],
    [3, 14, 1],
    [4, 10, 1],
    [4, 16, 3],
    [5, 20, 1],
    [6, 11, 1],
  ]),
  total: 13,
  peak: { weekday: "Fri", hour: 16, count: 3 },
  byWeekday: [3, 2, 1, 1, 4, 1, 1],
  byHour: Array.from({ length: 24 }, () => 0),
  afterHours: { events: 4, sharePct: 30.8, weekend: 1, night: 3 },
  workingHours,
  provenance: [prov("heatmap", "When people act"), prov("after-hours", "After-hours actions")],
};

export const afterHours: ActivityAfterHours = {
  ...base,
  events: 4,
  previous: 2,
  change: { abs: 2, pct: 100 },
  sharePct: 30.8,
  weekend: 1,
  night: 3,
  people: 2,
  byUser: [
    { userName: "Babu K", role: "HR Executive", afterHours: 2, weekend: 1, night: 1, sensitive: 0, sharePct: 66.7 },
    { userName: "Chandra S", role: "Super admin", afterHours: 2, weekend: 0, night: 2, sensitive: 1, sharePct: 66.7 },
  ],
  recent: [
    {
      at: "2026-10-04T11:00:00",
      userName: "Babu K",
      area: "Employees",
      count: 1,
      kind: "weekend",
      what: null,
      category: null,
      severity: null,
    },
    {
      at: "2026-09-30T06:30:00",
      userName: "Chandra S",
      area: "Accounts & access",
      count: 1,
      kind: "night",
      what: "Account changed (role, unit, status or password)",
      category: "access",
      severity: "high",
    },
  ],
  workingHours,
  provenance: [prov("after-hours", "After-hours actions")],
};

// ─── the sensitive feed ───────────────────────────────────────────────────────────────────────────────────────

const item = (over: Partial<FeedItem> & Pick<FeedItem, "id" | "at" | "userName" | "area">): FeedItem => ({
  role: null,
  count: 1,
  afterHours: null,
  category: null,
  categoryLabel: null,
  severity: null,
  title: null,
  action: "update",
  description: null,
  ...over,
});

export const sensitiveItems: FeedItem[] = [
  item({
    id: "9001",
    at: "2026-10-03T20:59:59",
    userName: "Anita Rao",
    role: "Payroll Officer",
    area: "Reports & exports",
    category: "export",
    categoryLabel: "Exports & downloads",
    severity: "medium",
    title: "Report exported",
    description: "Salary Register - XLSX - 250 rows",
  }),
  item({
    id: "b9003",
    at: "2026-10-02T16:10:00",
    userName: "Anita Rao",
    role: "Payroll Officer",
    area: "Employees",
    count: 20,
    category: "bulk",
    categoryLabel: "Bulk changes",
    severity: "medium",
    title: "Employee records changed by bulk upload",
    description: "20 employee records in one upload",
  }),
  item({
    id: "b9002",
    at: "2026-10-02T16:10:00",
    userName: "Anita Rao",
    role: "Payroll Officer",
    area: "Employees",
    count: 30,
    category: "payroll",
    categoryLabel: "Payroll & pay",
    severity: "high",
    title: "Salary or bank details changed by bulk upload",
    description: "30 employee records in one upload",
  }),
  item({
    id: "b9001",
    at: "2026-10-02T16:10:00",
    userName: "Anita Rao",
    role: "Payroll Officer",
    area: "Employees",
    count: 120,
    category: "bulk",
    categoryLabel: "Bulk changes",
    severity: "medium",
    title: "Employees added by bulk upload",
    description: "120 employee records in one upload",
  }),
  item({
    id: "9005",
    at: "2026-10-02T10:00:00",
    userName: "Babu K",
    role: "HR Executive",
    area: "Employees",
    category: "deletion",
    categoryLabel: "Deletions",
    severity: "high",
    title: "Employee deleted",
    description: "Deleted employee E9 -X Y",
  }),
  item({
    id: "9006",
    at: "2026-10-01T14:00:00",
    userName: "Chandra S",
    role: "Super admin",
    area: "Accounts & access",
    category: "access",
    categoryLabel: "Accounts & access",
    severity: "critical",
    title: "Managing Director access assigned",
    description: "Assigned MD: md_test",
  }),
  item({
    id: "9007",
    at: "2026-09-30T06:30:00",
    userName: "Chandra S",
    role: "Super admin",
    area: "Accounts & access",
    afterHours: "night",
    category: "access",
    categoryLabel: "Accounts & access",
    severity: "high",
    title: "Account changed (role, unit, status or password)",
    description: "Updated HR user: babu",
  }),
  item({
    id: "9008",
    at: "2026-09-29T09:30:00",
    userName: "Anita Rao",
    role: "Payroll Officer",
    area: "Payroll & pay",
    category: "payroll",
    categoryLabel: "Payroll & pay",
    severity: "high",
    title: "Payroll generated or changed",
    description: "Generated staff payroll 9/2026 -250 generated, 0 skipped",
  }),
];

const routineItem = item({
  id: "9010",
  at: "2026-10-04T11:00:00",
  userName: "Babu K",
  role: "HR Executive",
  area: "Employees",
  afterHours: "weekend",
  description: "Updated employee E4 -G H",
});

const cell = (
  id: CategoryCount["id"],
  label: string,
  critical: number,
  high: number,
  medium: number,
): CategoryCount => ({
  id,
  label,
  count: critical + high + medium,
  critical,
  high,
  medium,
});

export const categories: CategoryCount[] = [
  cell("access", "Accounts & access", 1, 1, 0),
  cell("deletion", "Deletions", 0, 1, 0),
  cell("payroll", "Payroll & pay", 0, 2, 0),
  cell("bulk", "Bulk changes", 0, 0, 2),
  cell("export", "Exports & downloads", 0, 0, 1),
  cell("settings", "Settings & workflow", 0, 0, 0),
  cell("backup", "Backup & restore", 0, 0, 0),
];

export const rules: RuleRow[] = [
  {
    id: "md-assigned",
    category: "access",
    categoryLabel: "Accounts & access",
    severity: "critical",
    title: "Managing Director access assigned",
  },
  {
    id: "role-changed",
    category: "access",
    categoryLabel: "Accounts & access",
    severity: "high",
    title: "Role or permissions changed",
  },
  {
    id: "employee-deleted",
    category: "deletion",
    categoryLabel: "Deletions",
    severity: "high",
    title: "Employee deleted",
  },
  {
    id: "payroll-generated",
    category: "payroll",
    categoryLabel: "Payroll & pay",
    severity: "high",
    title: "Payroll generated or changed",
  },
  {
    id: "bulk-import",
    category: "bulk",
    categoryLabel: "Bulk changes",
    severity: "medium",
    title: "Employees added by bulk upload",
  },
  {
    id: "report-export",
    category: "export",
    categoryLabel: "Exports & downloads",
    severity: "medium",
    title: "Report exported",
  },
  {
    id: "settings-universal",
    category: "settings",
    categoryLabel: "Settings & workflow",
    severity: "high",
    title: "Company-wide settings changed",
  },
  {
    id: "restore-started",
    category: "backup",
    categoryLabel: "Backup & restore",
    severity: "critical",
    title: "Database restore started",
  },
];

/** What /activity/sensitive answers for a query: the server's own filtering, on the fixture lines. */
export function sensitivePage(params: URLSearchParams): ActivitySensitive {
  const category = params.get("category");
  const q = (params.get("q") ?? "").toLowerCase();
  const user = params.get("user");
  const pageSize = Number(params.get("pageSize") ?? 25);
  const matches = sensitiveItems.filter(
    (i) =>
      (!category || i.category === category) &&
      (!user || i.userName.toLowerCase() === user.toLowerCase()) &&
      (!q || `${i.userName} ${i.description} ${i.title}`.toLowerCase().includes(q)),
  );
  return {
    ...base,
    total: matches.length,
    page: 1,
    pageSize,
    pages: Math.max(1, Math.ceil(matches.length / pageSize)),
    items: matches.slice(0, pageSize),
    categories,
    bySeverity: { critical: 1, high: 4, medium: 3 },
    filters: { category: (category as CategoryCount["id"] | null) ?? null, q: q || null, user },
    rules,
    provenance: [
      prov("sensitive", "Sensitive actions", { caveats: [COVERAGE] }),
      prov("sensitive-rules", "What counts as sensitive"),
    ],
  };
}

export function feedPage(params: URLSearchParams): ActivityFeed {
  const pageSize = Number(params.get("pageSize") ?? 25);
  const all = [routineItem, ...sensitiveItems];
  const q = (params.get("q") ?? "").toLowerCase();
  const user = params.get("user");
  const matches = all.filter(
    (i) =>
      (!user || i.userName.toLowerCase() === user.toLowerCase()) &&
      (!q || `${i.userName} ${i.description} ${i.title}`.toLowerCase().includes(q)),
  );
  return {
    ...base,
    total: matches.length,
    page: 1,
    pageSize,
    pages: Math.max(1, Math.ceil(matches.length / pageSize)),
    items: matches.slice(0, pageSize),
    filters: { q: q || null, user },
    provenance: [prov("feed", "Recent activity")],
  };
}

// ─── sign-ins ─────────────────────────────────────────────────────────────────────────────────────────────────

export const signIns: ActivitySignIns = {
  ...base,
  signIns: { value: 7, previous: 1, change: { abs: 6, pct: 600 }, people: 4 },
  granularity: "day",
  daily: trend.points.map((p) => ({ date: p.date, end: p.end, signIns: p.signIns, failed: p.failedSignIns })),
  accounts: [
    {
      userName: "Chandra S",
      role: "Super admin",
      privileged: true,
      enabled: true,
      signIns: 2,
      devices: ["Chrome on Windows", "Safari on iPhone"],
      lastSignIn: "2026-10-03T22:00:00",
      daysSince: 1,
      dormant: false,
      newDevices: 1,
      peakAtOnce: 1,
      overlapping: 0,
    },
    {
      userName: "Babu K",
      role: "HR Executive",
      privileged: false,
      enabled: true,
      signIns: 2,
      devices: ["Chrome on Windows", "Firefox on Windows"],
      lastSignIn: "2026-09-29T10:00:00",
      daysSince: 5,
      dormant: false,
      newDevices: 1,
      peakAtOnce: 2,
      overlapping: 1,
    },
    {
      userName: "Dora D",
      role: "HR Executive",
      privileged: false,
      enabled: true,
      signIns: 0,
      devices: [],
      lastSignIn: "2026-08-01T09:00:00",
      daysSince: 64,
      dormant: true,
      newDevices: 0,
      peakAtOnce: 0,
      overlapping: 0,
    },
  ],
  totalAccounts: 3,
  newDevices: [
    {
      userName: "Chandra S",
      role: "Super admin",
      privileged: true,
      device: "Safari on iPhone",
      at: "2026-10-03T22:00:00",
    },
    {
      userName: "Babu K",
      role: "HR Executive",
      privileged: false,
      device: "Firefox on Windows",
      at: "2026-09-29T10:00:00",
    },
  ],
  newDevicesTotal: 2,
  concurrent: {
    liveNow: { sessions: 1, accounts: 1 },
    severalNow: [],
    overlappingSignIns: 1,
    accounts: [{ userName: "Babu K", overlapping: 1, peak: 2 }],
  },
  failed: {
    value: 6,
    previous: 1,
    change: { abs: 5, pct: 500 },
    lockouts: 1,
    blockedAttempts: 1,
    unknownUsernames: 1,
    accounts: [
      {
        userName: "Chandra S",
        failures: 5,
        lastAt: "2026-09-29T11:05:00",
        knownAccount: true,
        privileged: true,
        lockedOut: 1,
      },
      {
        userName: "Unknown name 1",
        failures: 1,
        lastAt: "2026-09-30T10:02:00",
        knownAccount: false,
        privileged: false,
        lockedOut: 0,
      },
    ],
  },
  dormant: {
    days: 30,
    count: 1,
    accounts: [{ userName: "Dora D", role: "HR Executive", daysSince: 64, lastSignIn: "2026-08-01T09:00:00" }],
  },
  provenance: [
    prov("sign-ins", "Sign-ins"),
    prov("failed-sign-ins", "Failed sign-ins"),
    prov("new-devices", "New devices"),
    prov("concurrent", "Sessions open at the same time"),
    prov("dormant", "Accounts nobody signs in to"),
  ],
};

/** Every endpoint the page calls. */
export const FIXTURES: Fixtures = {
  "/api/md/activity/summary": summary,
  "/api/md/activity/trend": trend,
  "/api/md/activity/attention": attention,
  "/api/md/activity/modules": areas,
  "/api/md/activity/users": users,
  "/api/md/activity/heatmap": heatmap,
  "/api/md/activity/after-hours": afterHours,
  "/api/md/activity/sensitive": (params: URLSearchParams) => sensitivePage(params),
  "/api/md/activity/feed": (params: URLSearchParams) => feedPage(params),
  "/api/md/activity/sign-ins": signIns,
};

// ─── an empty database ────────────────────────────────────────────────────────────────────────────────────────

const zero = { value: 0, previous: 0, change: { abs: 0, pct: null } };

/** What every endpoint answers when the audit trail and the sign-in log hold nothing for the period. */
export const EMPTY_FIXTURES: Fixtures = {
  "/api/md/activity/summary": {
    ...summary,
    actions: zero,
    activeUsers: { ...zero, enabledAccounts: 1 },
    sensitive: { ...zero, critical: 0, high: 0, medium: 0 },
    afterHours: { ...zero, weekend: 0, night: 0, sharePct: null },
    signIns: { ...zero, people: 0 },
    failedSignIns: { ...zero, lockouts: 0, blockedAttempts: 0 },
    notes: ["Nothing was recorded in the audit trail or the sign-in log for 28 Sep – 04 Oct 2026."],
  } satisfies ActivitySummary,
  "/api/md/activity/trend": {
    ...trend,
    points: trend.points.map((p) => ({
      ...p,
      actions: 0,
      sensitive: 0,
      afterHours: 0,
      signIns: 0,
      failedSignIns: 0,
      activeUsers: 0,
    })),
    total: { actions: 0, sensitive: 0 },
    busiest: null,
    averagePerDay: null,
  } satisfies ActivityTrend,
  "/api/md/activity/attention": {
    ...attention,
    insights: [
      {
        id: "activity.silent",
        severity: "info",
        title: "No system activity was recorded in the last 7 days",
        detail: "No actions and no sign-ins.",
        metric: "0",
        page: "activity",
        ask: "Why was no activity recorded?",
      },
    ],
  } satisfies ActivityAttention,
  "/api/md/activity/modules": { ...areas, areas: [], total: 0, previousTotal: 0 } satisfies ActivityAreas,
  "/api/md/activity/users": { ...users, users: [], totalPeople: 0, total: 0 } satisfies ActivityUsers,
  "/api/md/activity/heatmap": {
    ...heatmap,
    values: grid([]),
    total: 0,
    peak: null,
    afterHours: { events: 0, sharePct: null, weekend: 0, night: 0 },
  } satisfies ActivityHeatmap,
  "/api/md/activity/after-hours": {
    ...afterHours,
    events: 0,
    previous: 0,
    change: { abs: 0, pct: null },
    sharePct: null,
    weekend: 0,
    night: 0,
    people: 0,
    byUser: [],
    recent: [],
  } satisfies ActivityAfterHours,
  "/api/md/activity/sensitive": (params: URLSearchParams) =>
    ({
      ...sensitivePage(params),
      total: 0,
      pages: 1,
      items: [],
      categories: categories.map((c) => ({ ...c, count: 0, critical: 0, high: 0, medium: 0 })),
      bySeverity: { critical: 0, high: 0, medium: 0 },
    }) satisfies ActivitySensitive,
  "/api/md/activity/feed": (params: URLSearchParams) =>
    ({ ...feedPage(params), total: 0, pages: 1, items: [] }) satisfies ActivityFeed,
  "/api/md/activity/sign-ins": {
    ...signIns,
    signIns: { ...zero, people: 0 },
    daily: signIns.daily.map((d) => ({ ...d, signIns: 0, failed: 0 })),
    accounts: [],
    totalAccounts: 0,
    newDevices: [],
    newDevicesTotal: 0,
    concurrent: { liveNow: { sessions: 0, accounts: 0 }, severalNow: [], overlappingSignIns: 0, accounts: [] },
    failed: { ...zero, lockouts: 0, blockedAttempts: 0, unknownUsernames: 0, accounts: [] },
    dormant: { days: 30, count: 0, accounts: [] },
  } satisfies ActivitySignIns,
};
