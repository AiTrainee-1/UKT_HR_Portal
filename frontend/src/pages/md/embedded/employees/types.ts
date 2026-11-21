import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

// What the Employees Insights tab reads (backend: api/md_portal/analytics/employees.py).

export type Change = { abs: number; pct: number | null } | null;

export type EmpSummary = MdEnvelope & {
  asOf: string;
  headcount: {
    current: number;
    staff: number;
    production: number;
    other: number;
    factory?: number;
    opening: number | null;
    closing: number | null;
    change: Change;
  };
  joiners: { count: number; previous: number; change: Change };
  leavers: { count: number; previous: number; change: Change; approximate: number };
  net: { count: number; previous: number; change: Change };
  attrition: {
    pct: number | null;
    annualisedPct: number | null;
    averageHeadcount: number | null;
    previousPct: number | null;
    change: Change;
  };
  tenure: { averageYears: number | null; previousYears: number | null; change: Change; unknown: number };
  earlyAttrition: { count: number; pctOfLeavers: number | null; previous: number; change: Change };
  previousPeriod: MdPeriod;
};

export type BriefingSentence = { id: string; text: string; tone: string; page?: string | null };

export type Briefing = MdEnvelope & { briefing: { sentences: BriefingSentence[]; text: string; ask: string } };

export type MovementPoint = {
  key: string;
  label: string;
  start: string;
  end: string;
  joiners: number;
  leavers: number;
  net: number;
  headcount: number;
};

export type EmpMovement = MdEnvelope & {
  grain: string;
  points: MovementPoint[];
  totals: { joiners: number; leavers: number; net: number; opening: number | null; closing: number | null };
};

export type GroupRow = { key: string; label: string; people: number; sharePct: number | null };

export type EmpWorkforce = MdEnvelope & {
  asOf: string;
  active: number;
  types: { staff: number; production: number; other: number };
  factory: {
    people: number;
    sharePct: number | null;
    labels: {
      id: number | null;
      label: string;
      people: number;
      staff: number;
      production: number;
      sharePct: number | null;
    }[];
  };
  cycles: { production: number; unassigned: number; rows: GroupRow[] };
  statutory: GroupRow[];
};

export type EmpExceptions = MdEnvelope & { items: MdInsightDto[]; total: number };

export type CompositionRow = {
  id: number | null;
  label: string;
  count: number;
  staff?: number;
  production?: number;
  pct: number | null;
};

export type EmpComposition = MdEnvelope & {
  total: number;
  byDepartment: CompositionRow[];
  departmentsTotal: number;
  byUnit: CompositionRow[];
};

export type PeopleGroup = "active" | "joiners" | "leavers" | "early" | "factory" | "cycle" | "statutory";

export type PersonRow = {
  id: number;
  name: string;
  code: string;
  type: string;
  designation: string | null;
  department: string | null;
  unit: string | null;
  joinDate: string | null;
  leftOn: string | null;
  exitApproximate: boolean | null;
  tenure: string | null;
  status: "active" | "inactive";
  factoryLabel: string | null;
  cycle: string | null;
  statutory: string;
};

export type PeopleList = MdEnvelope & {
  group: PeopleGroup;
  value: string | null;
  title: string;
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  rows: PersonRow[];
};

/** What a click asks the people list for: a group (and its value), plus extra scope (a unit or department). */
export type PeopleAsk = {
  group: PeopleGroup;
  value?: string;
  title: string;
  subtitle?: string;
  /** Extra parameters on top of the tab's filters (a unit's id, a department). */
  extra?: Record<string, string>;
  /** Where "Open in ..." goes (an MD address), and what it says. */
  open?: { path: string; label: string };
};
