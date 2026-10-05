// The shapes every MD analytics endpoint shares (backend: api/md_portal/common.py envelope()).

/** One explanation entry: how a figure is made (shown by "How is this calculated?" and used by the assistant). */
export type Provenance = {
  id: string;
  title: string;
  /** The data, in HR's own words ("Attendance day records"). */
  dataset: string;
  definition: string;
  formula: string | null;
  /** How many records stand behind it. */
  rows: number | null;
  filters: string[];
  caveats: string[];
};

export type MdPeriod = { start: string; end: string; preset: string | null; label: string; days: number };

export type MdScope = {
  branchIds: number[];
  departmentIds: number[];
  employmentType: "staff" | "production" | null;
  description: string;
};

export type MdEnvelope = {
  /** The factory's wall clock when the numbers were made, "2026-10-05T10:42:10". */
  generatedAt: string;
  period?: MdPeriod;
  scope?: MdScope;
  provenance: Provenance[];
  notes: string[];
  tookMs?: number;
};

/** The response of GET /api/md/org: what the filters offer. */
export type MdOrg = {
  branches: { id: number; name: string; isHeadOffice?: boolean; isActive?: boolean }[];
  departments: { id: number; name: string; branchId: number | null; branchName: string | null; employees: number }[];
};

/** The response of GET /api/md/me. */
export type MdMe = {
  id: number;
  username: string;
  name: string;
  assignedAt: string | null;
  serverTime: string;
  pages: { id: string; title: string; path: string; summary: string }[];
};

/** A named series point for charts. */
export type SeriesPoint = { label: string; value: number | null };

/** One exception the MD should read (backend: each analytics module's `insights()`). `page` is an MD page id. */
export type MdInsightDto = {
  id: string;
  severity: "critical" | "warning" | "info" | "good";
  title: string;
  detail?: string | null;
  metric?: string | null;
  page?: string | null;
  ask?: string | null;
};

export type MdKpiFormat = "number" | "pct" | "inr" | "inr_compact" | "minutes" | "text";

/** One headline figure (backend: each analytics module's `headline()`). `delta.good` is the direction that is good news. */
export type MdKpiDto = {
  id: string;
  label: string;
  value: number | string | null;
  format: MdKpiFormat;
  sub?: string | null;
  delta?: { abs: number | null; pct: number | null; good: "up" | "down" | null } | null;
  spark?: (number | null)[] | null;
  page?: string | null;
};
