// Response shapes of GET /api/md/activity/* (backend: api/md_portal/analytics/activity.py). Dates are ISO strings,
// timestamps are the factory's wall clock ("2026-10-03T20:59:59"), percentages are 0-100.

import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

/** The change against the previous period: `pct` is null when the previous figure was 0. null = nothing to compare. */
export type Change = { abs: number; pct: number | null } | null;

export type Compared = { value: number; previous: number; change: Change };

export type WorkingHours = { startHour: number; endHour: number; weeklyOff: string; label: string };

export type Severity = "critical" | "high" | "medium";

export type CategoryId = "access" | "deletion" | "payroll" | "bulk" | "export" | "settings" | "backup";

/** When an action happened outside normal hours: on the weekly off, or at night on a working day. */
export type AfterKind = "weekend" | "night" | null;

// ─── summary ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ActivitySummary = MdEnvelope & {
  previousPeriod: MdPeriod;
  actions: Compared;
  activeUsers: Compared & { enabledAccounts: number };
  sensitive: Compared & { critical: number; high: number; medium: number };
  afterHours: Compared & { weekend: number; night: number; sharePct: number | null };
  signIns: Compared & { people: number };
  failedSignIns: Compared & { lockouts: number; blockedAttempts: number };
  workingHours: WorkingHours;
};

// ─── trend ────────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendPoint = {
  date: string;
  end: string;
  actions: number;
  sensitive: number;
  afterHours: number;
  signIns: number;
  failedSignIns: number;
  activeUsers: number;
};

export type ActivityTrend = MdEnvelope & {
  granularity: "day" | "week";
  points: TrendPoint[];
  total: { actions: number; sensitive: number };
  busiest: { date: string; end: string; actions: number } | null;
  averagePerDay: number | null;
};

// ─── areas and people ─────────────────────────────────────────────────────────────────────────────────────────

export type AreaRow = {
  area: string;
  label: string;
  actions: number;
  sharePct: number | null;
  sensitive: number;
  previous: number;
  change: Change;
  people: number;
};

export type ActivityAreas = MdEnvelope & { areas: AreaRow[]; total: number; previousTotal: number };

export type UserRow = {
  userName: string;
  role: string | null;
  actions: number;
  sharePct: number | null;
  sensitive: number;
  afterHours: number;
  signIns: number;
  lastActive: string | null;
  topArea: string;
  previous: number;
  change: Change;
};

export type ActivityUsers = MdEnvelope & {
  users: UserRow[];
  totalPeople: number;
  total: number;
  others: { people: number; actions: number } | null;
};

// ─── heatmap and after hours ──────────────────────────────────────────────────────────────────────────────────

export type ActivityHeatmap = MdEnvelope & {
  rows: string[];
  hours: number[];
  values: number[][];
  total: number;
  peak: { weekday: string; hour: number; count: number } | null;
  byWeekday: number[];
  byHour: number[];
  afterHours: { events: number; sharePct: number | null; weekend: number; night: number };
  workingHours: WorkingHours;
};

export type AfterHoursPerson = {
  userName: string;
  role: string | null;
  afterHours: number;
  weekend: number;
  night: number;
  sensitive: number;
  sharePct: number | null;
};

export type AfterHoursCase = {
  at: string | null;
  userName: string;
  area: string;
  count: number;
  kind: "weekend" | "night";
  what: string | null;
  category: CategoryId | null;
  severity: Severity | null;
};

export type ActivityAfterHours = MdEnvelope & {
  events: number;
  previous: number;
  change: Change;
  sharePct: number | null;
  weekend: number;
  night: number;
  people: number;
  byUser: AfterHoursPerson[];
  recent: AfterHoursCase[];
  workingHours: WorkingHours;
};

// ─── the sensitive feed and the full feed ─────────────────────────────────────────────────────────────────────

export type FeedItem = {
  id: string;
  at: string;
  userName: string;
  role: string | null;
  area: string;
  /** Audit rows behind the line: more than 1 for a bulk upload. */
  count: number;
  afterHours: AfterKind;
  category: CategoryId | null;
  categoryLabel: string | null;
  severity: Severity | null;
  /** The plain-English name of the rule that matched, null for routine activity. */
  title: string | null;
  action?: string;
  description?: string | null;
};

export type CategoryCount = { id: CategoryId; label: string; count: number } & Record<Severity, number>;

export type RuleRow = { id: string; category: CategoryId; categoryLabel: string; severity: Severity; title: string };

type Paged = { total: number; page: number; pageSize: number; pages: number; items: FeedItem[] };

export type ActivitySensitive = MdEnvelope &
  Paged & {
    categories: CategoryCount[];
    bySeverity: Record<Severity, number>;
    filters: { category: CategoryId | null; q: string | null; user: string | null };
    rules?: RuleRow[];
  };

export type ActivityFeed = MdEnvelope & Paged & { filters: { q: string | null; user: string | null } };

// ─── sign-ins ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SignInAccount = {
  userName: string;
  role: string | null;
  privileged: boolean;
  enabled: boolean;
  signIns: number;
  devices: string[];
  lastSignIn: string | null;
  daysSince: number | null;
  dormant: boolean;
  newDevices: number;
  peakAtOnce: number;
  overlapping: number;
};

export type NewDevice = {
  userName: string;
  role: string | null;
  privileged: boolean;
  device: string;
  at: string | null;
};

export type FailedAccount = {
  userName: string;
  failures: number;
  lastAt: string | null;
  knownAccount: boolean;
  privileged: boolean;
  lockedOut: number;
};

export type ActivitySignIns = MdEnvelope & {
  signIns: Compared & { people: number };
  granularity: "day" | "week";
  daily: { date: string; end: string; signIns: number; failed: number }[];
  accounts: SignInAccount[];
  totalAccounts: number;
  newDevices: NewDevice[];
  newDevicesTotal: number;
  concurrent: {
    liveNow: { sessions: number; accounts: number };
    severalNow: { userName: string; sessions: number }[];
    overlappingSignIns: number;
    accounts: { userName: string; overlapping: number; peak: number }[];
  };
  failed: Compared & {
    lockouts: number;
    blockedAttempts: number;
    unknownUsernames: number;
    accounts: FailedAccount[];
  };
  dormant: {
    days: number;
    count: number;
    accounts: { userName: string; role: string | null; daysSince: number | null; lastSignIn: string | null }[];
  };
};

// ─── what stands out ──────────────────────────────────────────────────────────────────────────────────────────

export type ActivityAttention = MdEnvelope & { window: MdPeriod; insights: MdInsightDto[] };
