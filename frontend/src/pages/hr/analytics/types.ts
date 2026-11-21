// The HR Analytics contract (backend/api/hr_analytics, GET /api/hr-analytics/...): what the three endpoints answer.
// Dates are plain ISO days ("2026-11-20"); every list is already scoped to the HR user's branch by the server.

export type AnalyticsTab = "staff" | "production";

export type Level = "high" | "attention" | "watch" | "ok";

export type Period = {
  from: string;
  to: string;
  days: number;
  months: number;
  /** "1 Nov - 21 Nov 2026". */
  label: string;
  /** Days left out of the absence checks: (almost) nobody of the type had attendance, the devices' punches never came. */
  dataGaps?: string[];
};

export type CategoryMeta = {
  key: string;
  label: string;
  description: string;
  /** What one occurrence is: "days", "requests", "runs" ... */
  unit: string;
  thresholdPerMonth: number;
  /** The per-month threshold scaled to the period. */
  threshold: number;
  /** Shown for reference only: never raises an employee's level. */
  informational: boolean;
  flagged: number;
  high: number;
  affected: number;
  total: number;
};

export type EmployeeRef = {
  id: number;
  code: string;
  name: string;
  department: string | null;
  departmentId: number | null;
  designation: string | null;
  branch: string | null;
  photoUrl: string | null;
  type: AnalyticsTab;
};

export type EmployeeHit = EmployeeRef & {
  counts: Record<string, number>;
  flags: string[];
  level: Level;
  score: number;
  lastDate: string | null;
};

export type WeeklyPoint = { weekStart: string; weekEnd: string; counts: Record<string, number> };

export type DepartmentRow = {
  id: number;
  name: string;
  employees: number;
  flagged: number;
  counts: Record<string, number>;
};

export type HodRow = {
  employeeId: number;
  code: string;
  name: string;
  department: string | null;
  decided: number;
  rejected: number;
  rejectionRate: number;
  avgResponseHours: number | null;
  waitingNow: number;
  waitingLong: number;
  oldestWaitingHours: number | null;
};

export type Totals = {
  employeesInScope: number;
  employeesWithIssues: number;
  needingAttention: number;
  high: number;
};

export type DepartmentOption = { id: number; name: string; category: string | null };

export type AnalyticsSummary = {
  type: AnalyticsTab;
  period: Period;
  categories: CategoryMeta[];
  employees: EmployeeHit[];
  weekly: WeeklyPoint[];
  departments: DepartmentRow[];
  hods: HodRow[];
  totals: Totals;
  options: { departments: DepartmentOption[] };
};

export type AnalyticsRecord = {
  date: string;
  endDate: string | null;
  title: string;
  detail: string | null;
  reason: string | null;
  status: string | null;
  by: string | null;
  at: string | null;
};

export type TimelineRecord = AnalyticsRecord & { category: string };

/** byWeekday / longestStreak / lastDate / note, plus numbers of the category's own ("avgFirstPunch": "09:21"). */
export type Pattern = {
  byWeekday: Record<string, number>;
  longestStreak: number;
  lastDate: string | null;
  note: string | null;
  [extra: string]: unknown;
};

export type CategoryEmployee = EmployeeRef & {
  count: number;
  flagged: boolean;
  level: Level;
  lastDate: string | null;
  pattern: Pattern;
  records: AnalyticsRecord[];
};

export type CategoryDetail = {
  category: CategoryMeta;
  period: Period;
  employees: CategoryEmployee[];
};

export type EmployeeCategory = {
  category: CategoryMeta;
  count: number;
  flagged: boolean;
  records: AnalyticsRecord[];
  pattern: Pattern;
};

export type EmployeeDetail = {
  employee: EmployeeRef;
  period: Period;
  level: Level;
  score: number;
  counts: Record<string, number>;
  flags: string[];
  categories: Record<string, EmployeeCategory>;
  timeline: TimelineRecord[];
};
