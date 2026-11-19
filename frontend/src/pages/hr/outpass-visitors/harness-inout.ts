import type { InOutDetail, InOutRow, InOutScan, InOutStatus, InOutSummary } from "@/lib/api-client/custom-hooks";
import { copy, harnessError, paginate, sliceState, type World } from "./harness-kit";
import { istDateKey } from "./kit/fmt";

// The render-test fake server's answers for Gate Pass -> In/Out: /api/outpass/in-out* (list, summary, detail, options)
// and the employee search its Employee filter uses (/api/employees?search=…&lite=1). Filters work like the server's
// (outpass_inout_views.py): days are India days of the exit, "out" lists everyone still out (overdue included), gateId
// matches the exit or the return gate, every word of q must match the name, code, destination or reason.
//
// The world (the frozen clock is 14 Oct 2026, 11:30 in India):
//   31 Ravi Kumar   Cutting  out 09:00 Gate 1, back 09:40 Gate 2 (expected 09:30: 10 min late)  back
//   32 Meena S      Sewing   out 10:30 Gate 1, expected 11:00, not back                           overdue
//   33 Arun P       Cutting  out 11:10 Gate 2, expected 12:10, not back                           out
//   34 Divya R      Stores   out 13 Oct 15:30 Gate 1, never back                                   not_returned
//   35 Kumar V      Sewing   an early dismissal, out 12 Oct 16:30 Gate 2                           early_dismissal
// Today: 3 went out, 1 back, 2 still out (1 overdue). This week (from Monday the 12th): all five.

const GATES = [
  { id: 1, name: "Gate 1", isActive: true },
  { id: 2, name: "Gate 2", isActive: true },
  { id: 3, name: "Old gate", isActive: false },
];
const DEPARTMENTS = [
  { id: 10, name: "Cutting" },
  { id: 11, name: "Sewing" },
  { id: 12, name: "Stores" },
];
const deptId = (name: string | null) => DEPARTMENTS.find((d) => d.name === name)?.id ?? null;

const LABEL: Record<InOutStatus, string> = {
  back: "Back",
  out: "Out",
  overdue: "Overdue",
  not_returned: "Not returned",
  early_dismissal: "Left for the day",
};

function row(
  id: number,
  name: string,
  department: string,
  patch: Partial<InOutRow> & Pick<InOutRow, "exitedAt" | "status">,
): InOutRow {
  return {
    id,
    employee: { id, employeeCode: `E${id}`, name, department, designation: null, photoUrl: null },
    passType: "official",
    passTypeLabel: "Official",
    destination: `Destination ${id}`,
    reason: `Reason ${id}`,
    source: "manual",
    sourceLabel: "Manual",
    approvedBy: "HR – Priya",
    approvedAt: patch.exitedAt,
    expectedReturnAt: null,
    exitGateId: 1,
    exitGateName: "Gate 1",
    entryGateId: null,
    entryGateName: null,
    enteredAt: null,
    minutesOut: null,
    allowedMinutes: null,
    overMinutes: null,
    overdue: false,
    statusLabel: LABEL[patch.status],
    ...patch,
  };
}

export const IN_OUT_ROWS: InOutRow[] = [
  row(33, "Arun P", "Cutting", {
    destination: "Supplier visit",
    exitedAt: "2026-10-14T05:40:00Z",
    exitGateId: 2,
    exitGateName: "Gate 2",
    expectedReturnAt: "2026-10-14T06:40:00Z",
    minutesOut: 20,
    allowedMinutes: 60,
    status: "out",
  }),
  row(32, "Meena S", "Sewing", {
    passType: "personal",
    passTypeLabel: "Personal",
    destination: "Clinic",
    reason: "Fever",
    exitedAt: "2026-10-14T05:00:00Z",
    expectedReturnAt: "2026-10-14T05:30:00Z",
    minutesOut: 60,
    allowedMinutes: 30,
    overMinutes: 30,
    overdue: true,
    status: "overdue",
  }),
  row(31, "Ravi Kumar", "Cutting", {
    destination: "Bank",
    reason: "Cash deposit",
    exitedAt: "2026-10-14T03:30:00Z",
    enteredAt: "2026-10-14T04:10:00Z",
    entryGateId: 2,
    entryGateName: "Gate 2",
    expectedReturnAt: "2026-10-14T04:00:00Z",
    minutesOut: 40,
    allowedMinutes: 30,
    overMinutes: 10,
    overdue: true,
    status: "back",
  }),
  row(34, "Divya R", "Stores", {
    passType: "personal",
    passTypeLabel: "Personal",
    destination: "Home",
    exitedAt: "2026-10-13T10:00:00Z",
    status: "not_returned",
  }),
  row(35, "Kumar V", "Sewing", {
    passType: "early_dismissal",
    passTypeLabel: "Early Dismissal",
    destination: "Home",
    exitedAt: "2026-10-12T11:00:00Z",
    exitGateId: 2,
    exitGateName: "Gate 2",
    status: "early_dismissal",
  }),
];

const scan = (patch: Partial<InOutScan> & Pick<InOutScan, "at" | "type">): InOutScan => ({
  result: "allowed",
  reason: null,
  reasonLabel: null,
  gateName: "Gate 1",
  message: null,
  ...patch,
});

/** Ravi's pass (31) has a refused second exit scan; the others have their own scans only. */
const SCANS: Record<number, InOutScan[]> = {
  31: [
    scan({ id: 1, at: "2026-10-14T03:30:00Z", type: "exit", message: "Exit recorded via Gate 1" }),
    scan({
      id: 2,
      at: "2026-10-14T03:35:00Z",
      type: "exit",
      result: "denied",
      reason: "already_scanned",
      reasonLabel: "Already scanned",
      message: "Already exited at 09:00 via Gate 1",
    }),
    scan({ id: 3, at: "2026-10-14T04:10:00Z", type: "return", gateName: "Gate 2", message: "Return recorded" }),
  ],
};

const APPROVED_BY_HR = {
  workflow: "outpass",
  label: "Outpass",
  enabled: true,
  steps: [{ index: 0, roles: ["hr"], mandatory: true, label: "HR", state: "approved", by: "Priya HR" }],
  currentStep: null,
  waitingFor: [],
  canAct: { hr: false, hod: false },
  canReject: { hr: false, hod: false },
} as unknown as InOutDetail["approvalTrail"];

/** Who the Employee filter finds (the shape of /api/employees?lite=1). */
const EMPLOYEES = IN_OUT_ROWS.map((r) => {
  const [firstName, ...rest] = r.employee.name.split(" ");
  return {
    id: r.employee.id,
    employeeCode: r.employee.employeeCode,
    firstName,
    lastName: rest.join(" "),
    departmentName: r.employee.department,
  };
});

const STATUSES: InOutStatus[] = ["back", "out", "overdue", "not_returned", "early_dismissal"];

function filtered(query: URLSearchParams, rows: readonly InOutRow[], withStatus = true): InOutRow[] {
  const today = istDateKey(new Date());
  const from = query.get("from") || (query.get("to") ? "" : today);
  const to = query.get("to") || (query.get("from") ? "" : today);
  const status = withStatus ? (query.get("status") ?? "") : "";
  if (status && !STATUSES.includes(status as InOutStatus)) {
    throw harnessError(400, { error: "status must be back, out, overdue, not_returned or early_dismissal" });
  }
  const gate = query.get("gateId");
  const dept = query.get("departmentId");
  const emp = query.get("employeeId");
  const words = (query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    const day = istDateKey(r.exitedAt);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (status === "out" ? !(r.status === "out" || r.status === "overdue") : status && r.status !== status)
      return false;
    if (gate && String(r.exitGateId) !== gate && String(r.entryGateId) !== gate) return false;
    if (dept && String(deptId(r.employee.department)) !== dept) return false;
    if (emp && String(r.employee.id) !== emp) return false;
    const hay = [r.employee.name, r.employee.employeeCode, r.destination, r.reason].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function summarise(rows: readonly InOutRow[]): InOutSummary {
  const back = rows.filter((r) => r.status === "back").map((r) => r.minutesOut ?? 0);
  const total = back.reduce((a, b) => a + b, 0);
  return {
    wentOut: rows.length,
    cameBack: back.length,
    stillOut: rows.filter((r) => r.status === "out" || r.status === "overdue").length,
    overdue: rows.filter((r) => r.status === "overdue").length,
    notReturned: rows.filter((r) => r.status === "not_returned").length,
    earlyDismissal: rows.filter((r) => r.status === "early_dismissal").length,
    avgMinutesOut: back.length ? Math.floor(total / back.length + 0.5) : null,
    longestMinutesOut: back.length ? Math.max(...back) : null,
    totalMinutesOut: back.length ? total : null,
  };
}

/** This part's data in a test's world: the rows, which a test may change (sliceState(world, "inout", ...)). */
export const inOutState = (world: World) => sliceState(world, "inout", () => ({ rows: copy(IN_OUT_ROWS) }));

export function handler(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: Record<string, unknown>,
  world: World,
): unknown {
  if (method !== "GET") return undefined;
  const { rows } = inOutState(world);
  if (path === "/api/outpass/in-out") return paginate(filtered(query, rows), query, 25);
  if (path === "/api/outpass/in-out/summary") return summarise(filtered(query, rows));
  if (path === "/api/outpass/in-out/options") return { gates: copy(GATES), departments: copy(DEPARTMENTS) };
  const detail = /^\/api\/outpass\/in-out\/(\d+)$/.exec(path);
  if (detail) {
    const found = rows.find((r) => r.id === Number(detail[1]));
    if (!found) throw harnessError(404, { error: "This gate pass was not found, or it has not gone out yet." });
    const out: InOutDetail = {
      ...copy(found),
      requestedAt: found.exitedAt,
      reviewComment: null,
      approvalTrail: copy(APPROVED_BY_HR),
      scans: copy(SCANS[found.id] ?? [scan({ at: found.exitedAt, type: "exit", gateName: found.exitGateName })]),
    };
    return out;
  }
  if (path === "/api/employees" && query.get("lite") === "1" && query.has("search")) {
    const words = (query.get("search") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return copy(
      EMPLOYEES.filter((e) => {
        const hay = `${e.firstName} ${e.lastName} ${e.employeeCode}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    );
  }
  return undefined;
}
