import type {
  TeaBreakAdminRecord,
  TeaBreakEmployeeRow,
  TeaBreakOptions,
  TeaBreakRecordDetail,
  TeaBreakRecordsSummary,
  TeaBreakStatus,
} from "@/lib/api-client/custom-hooks";
import { copy, harnessError, paginate, sliceState, type World } from "./harness-kit";
import { istDateKey } from "./kit/fmt";

// The render-test fake server's answers for Tea Break: /api/tea-break/records* with the new filters (the list, summary,
// detail, employees, options). Each answer is worked out from the breaks below and the query, like the server: every
// filter really narrows the rows, and a finished break is on time or overtime against the rule as it stands (world.rule),
// so saving a new rule changes the lists once they are asked for again.
//
// The clock is 14 Oct 2026 11:30 in India (harness-kit NOW). The breaks (times in India):
//   1 Tea Ontime  T1 Sewing   Gate 1 -> Gate 1  09:30-09:38   8 min
//   2 Tea Overtime T2 Sewing  Gate 1 -> Gate 2  09:30-09:55  25 min
//   3 Tea Missing T3 Cutting  Gate 2 ->         09:30 open    2 h (not returned)
//   4 Tea Onbreak T4 Cutting  Gate 1 ->         11:22 open    8 min (on break)
//   5 Tea Ontime  T1 Sewing   Gate 2 -> Gate 2  12 Oct 15:00-15:06  6 min (this week, not today)

export type TeaHarnessBreak = TeaBreakAdminRecord & { departmentId: number; branchId: number };

const DEPARTMENTS = [
  { id: 11, name: "Sewing" },
  { id: 12, name: "Cutting" },
];
const GATES = [
  { id: 1, name: "Gate 1" },
  { id: 2, name: "Gate 2" },
];
const BRANCHES = [
  { id: 1, name: "Main" },
  { id: 2, name: "Unit 2" },
];

const at = (day: string, hhmm: string) => `2026-10-${day}T${hhmm}:00+05:30`;

function teaBreak(
  id: number,
  emp: { id: number; name: string; department: string; departmentId: number },
  out: [string, number, string],
  back: [string, number, string] | null,
  taken: number,
): TeaHarnessBreak {
  const outGate = GATES.find((g) => g.id === out[1])!;
  const inGate = back ? GATES.find((g) => g.id === back[1])! : null;
  return {
    id,
    employee: {
      id: emp.id,
      employeeCode: `T${emp.id}`,
      name: emp.name,
      department: emp.department,
      photoUrl: null,
    },
    departmentId: emp.departmentId,
    branchId: 1,
    designation: "Operator",
    branchName: "Main",
    outGateId: outGate.id,
    outGateName: outGate.name,
    outAt: at(out[0], out[2]),
    inGateId: inGate?.id ?? null,
    inGateName: inGate?.name ?? null,
    inAt: back ? at(back[0], back[2]) : null,
    takenMinutes: taken,
    remark: "on_time",
    status: "on_time",
    statusLabel: "On time",
    overMinutes: null,
    flag: null,
    flagLabel: null,
    allowedMinutes: 10,
  };
}

const ONTIME = { id: 1, name: "Tea Ontime", department: "Sewing", departmentId: 11 };
const OVERTIME = { id: 2, name: "Tea Overtime", department: "Sewing", departmentId: 11 };
const MISSING = { id: 3, name: "Tea Missing", department: "Cutting", departmentId: 12 };
const ONBREAK = { id: 4, name: "Tea Onbreak", department: "Cutting", departmentId: 12 };

/** The breaks, newest first. */
export const TEA_BREAKS: readonly TeaHarnessBreak[] = [
  teaBreak(4, ONBREAK, ["14", 1, "11:22"], null, 8),
  teaBreak(1, ONTIME, ["14", 1, "09:30"], ["14", 1, "09:38"], 8),
  teaBreak(2, OVERTIME, ["14", 1, "09:30"], ["14", 2, "09:55"], 25),
  teaBreak(3, MISSING, ["14", 2, "09:30"], null, 120),
  teaBreak(5, ONTIME, ["12", 2, "15:00"], ["12", 2, "15:06"], 6),
];

const LABEL: Record<TeaBreakStatus, string> = {
  on_break: "On break",
  on_time: "On time",
  overtime: "Overtime",
  not_returned: "Not returned",
};
const REMARK: Record<TeaBreakStatus, TeaBreakAdminRecord["remark"]> = {
  on_break: "in_progress",
  on_time: "on_time",
  overtime: "overtime",
  not_returned: "not_returned",
};

/** A break as the server would send it under the rule of the moment. */
function asServed(b: TeaHarnessBreak, allowed: number): TeaHarnessBreak {
  const status: TeaBreakStatus = b.inAt
    ? b.takenMinutes > allowed
      ? "overtime"
      : "on_time"
    : b.takenMinutes > 60
      ? "not_returned"
      : "on_break";
  return {
    ...b,
    status,
    statusLabel: LABEL[status],
    remark: REMARK[status],
    overMinutes: b.inAt ? Math.max(0, b.takenMinutes - allowed) : null,
    allowedMinutes: allowed,
  };
}

type TeaState = { breaks: TeaHarnessBreak[] };

/** This test's breaks (a test may change them through `sliceState(world, "tea", ...)` before the page asks). */
export const teaState = (world: World) => sliceState<TeaState>(world, "tea", () => ({ breaks: copy([...TEA_BREAKS]) }));

/** The rows a query matches, as the server filters them (the status only when `withStatus`). */
export function teaMatches(world: World, query: URLSearchParams, withStatus = true): TeaHarnessBreak[] {
  const allowed = world.rule.allowedMinutes;
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const words = (query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const ids = (key: string) => (query.get(key) ? query.get(key)!.split(",").map(Number) : null);
  const departments = ids("departmentId");
  const gates = ids("gateId");
  const employee = query.get("employeeId") ? Number(query.get("employeeId")) : null;
  const branch = query.get("branchId") ? Number(query.get("branchId")) : null;
  const status = withStatus ? query.get("status") : null;
  return teaState(world)
    .breaks.map((b) => asServed(b, allowed))
    .filter((b) => {
      const day = istDateKey(b.outAt);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (departments && !departments.includes(b.departmentId)) return false;
      if (gates && !gates.includes(b.outGateId!) && !(b.inGateId && gates.includes(b.inGateId))) return false;
      if (employee !== null && b.employee.id !== employee) return false;
      if (branch !== null && b.branchId !== branch) return false;
      if (status && b.status !== status) return false;
      const text = `${b.employee.name} ${b.employee.employeeCode}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
}

const avg = (total: number, count: number) => (count ? Math.round((total / count) * 100) / 100 : null);

function summaryOf(rows: TeaHarnessBreak[], allowed: number): TeaBreakRecordsSummary {
  const done = rows.filter((r) => r.inAt);
  const total = done.reduce((s, r) => s + r.takenMinutes, 0);
  const over = rows.filter((r) => r.status === "overtime");
  return {
    breaks: rows.length,
    onBreakNow: rows.filter((r) => r.status === "on_break").length,
    onTime: rows.filter((r) => r.status === "on_time").length,
    overtime: over.length,
    notReturned: rows.filter((r) => r.status === "not_returned").length,
    avgMinutes: avg(total, done.length),
    longestMinutes: done.length ? Math.max(...done.map((r) => r.takenMinutes)) : null,
    employees: new Set(rows.map((r) => r.employee.id)).size,
    overMinutesTotal: over.reduce((s, r) => s + r.takenMinutes - allowed, 0),
    allowedMinutes: allowed,
    completed: done.length,
    totalMinutes: total,
    longOrOpen: 0,
    from: null,
    to: null,
  };
}

function employeesOf(rows: TeaHarnessBreak[], allowed: number, sort: string): TeaBreakEmployeeRow[] {
  const by = new Map<number, TeaHarnessBreak[]>();
  for (const r of rows) by.set(r.employee.id, [...(by.get(r.employee.id) ?? []), r]);
  const out = [...by.values()].map((list): TeaBreakEmployeeRow => {
    const s = summaryOf(list, allowed);
    return {
      employee: { ...list[0].employee, designation: list[0].designation },
      breaks: s.breaks,
      completed: s.completed,
      onTime: s.onTime,
      totalMinutes: s.totalMinutes,
      avgMinutes: s.avgMinutes,
      longestMinutes: s.longestMinutes,
      overtime: s.overtime,
      overMinutesTotal: s.overMinutesTotal,
      notReturned: s.notReturned,
      onBreak: s.onBreakNow,
      onBreakNow: s.onBreakNow > 0,
    };
  });
  const desc = sort.startsWith("-") || sort === "";
  const key = (sort.replace(/^-/, "") || "breaks") as "breaks" | "name" | "total";
  const value = (r: TeaBreakEmployeeRow): string | number =>
    key === "name" ? r.employee.name : key === "total" ? r.totalMinutes : r.breaks;
  return out.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    const order = x < y ? -1 : x > y ? 1 : 0;
    return (desc ? -order : order) || a.employee.employeeCode.localeCompare(b.employee.employeeCode);
  });
}

export function handler(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: Record<string, unknown>,
  world: World,
): unknown {
  if (method !== "GET" || !path.startsWith("/api/tea-break/records")) return undefined;
  const allowed = world.rule.allowedMinutes;
  if (path === "/api/tea-break/records") {
    return { ...paginate(teaMatches(world, query), query), allowedMinutes: allowed };
  }
  if (path === "/api/tea-break/records/summary") return summaryOf(teaMatches(world, query), allowed);
  if (path === "/api/tea-break/records/employees") {
    return {
      ...paginate(employeesOf(teaMatches(world, query), allowed, query.get("sort") ?? ""), query),
      allowedMinutes: allowed,
    };
  }
  if (path === "/api/tea-break/records/options") {
    const options: TeaBreakOptions = {
      departments: DEPARTMENTS,
      gates: GATES,
      branches: BRANCHES,
      branchScoped: false,
      allowedMinutes: allowed,
      ruleUpdatedAt: world.rule.updatedAt,
    };
    return copy(options);
  }
  const detail = /^\/api\/tea-break\/records\/(\d+)$/.exec(path);
  if (detail) {
    const all = teaState(world).breaks.map((b) => asServed(b, allowed));
    const row = all.find((b) => b.id === Number(detail[1]));
    if (!row) throw harnessError(404, { error: "This tea break was not found." }, method, path);
    const mine = all.filter((b) => b.employee.id === row.employee.id);
    const month = summaryOf(mine, allowed);
    const body: TeaBreakRecordDetail = {
      ...row,
      employeeMonth: {
        month: "2026-10",
        label: "October 2026",
        breaks: month.breaks,
        onTime: month.onTime,
        overtime: month.overtime,
        notReturned: month.notReturned,
        avgMinutes: month.avgMinutes,
        totalMinutes: month.totalMinutes,
        overMinutesTotal: month.overMinutesTotal,
      },
      recent: mine.slice(0, 10),
    };
    return copy(body);
  }
  return undefined;
}
