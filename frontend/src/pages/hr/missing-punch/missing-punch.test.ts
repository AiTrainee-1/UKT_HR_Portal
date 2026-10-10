import { describe, expect, it } from "vitest";
import type { ApprovalProgress, ApprovalProgressStep } from "@/lib/approval-workflow";
import {
  DEFAULT_FILTERS,
  NO_FILTERS,
  bulkApprovable,
  decidedAt,
  decisionLines,
  exportTable,
  filterRows,
  formatPunchTime,
  hrDecides,
  hrRejects,
  punchLabel,
  sortRows,
  statusCounts,
  summarize,
  waitingLine,
  weekdayOf,
  type MissingRow,
} from "./logic";

let nextId = 1;

/** The pipeline block the server sends. `waiting` is who the request waits for now (null once decided). */
const pipeline = (steps: Partial<ApprovalProgressStep>[], over: Partial<ApprovalProgress> = {}): ApprovalProgress => {
  const full = steps.map((s, i) => ({
    index: i,
    roles: ["hr" as const],
    mandatory: true,
    state: "waiting" as const,
    ...s,
  })) as ApprovalProgressStep[];
  const current = full.findIndex((s) => s.state === "pending");
  const waitingFor = current >= 0 ? full[current].roles : [];
  return {
    workflow: "missing_punch",
    label: "Missing Punch",
    enabled: true,
    steps: full,
    currentStep: current >= 0 ? current : null,
    waitingFor,
    canAct: { hod: waitingFor.includes("hod"), hr: waitingFor.includes("hr") },
    ...over,
  };
};

const req = (over: Partial<MissingRow> = {}): MissingRow => ({
  id: nextId++,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  department: "Stitching",
  designation: "Operator",
  branch: "Tiruppur",
  branchId: 1,
  date: "2026-10-08",
  punchTime: "09:05",
  punchType: "IN",
  punchSlot: "morning_in",
  reason: "Forgot to punch at the gate",
  status: "pending_hr",
  hodReviewedBy: null,
  hodReviewComment: null,
  hodReviewedAt: null,
  hrReviewedBy: null,
  hrReviewComment: null,
  hrReviewedAt: null,
  createdAt: "2026-10-09T05:00:00Z",
  approval: null,
  ...over,
});

const hodThenHr = (hod: ApprovalProgressStep["state"], hr: ApprovalProgressStep["state"]) =>
  pipeline([
    {
      roles: ["hod"],
      state: hod,
      by: hod === "approved" ? "Suresh" : undefined,
      decidedBy: hod === "approved" ? "hod" : undefined,
    },
    { roles: ["hr"], state: hr },
  ]);

describe("who may decide", () => {
  it("follows the pipeline when the server sent one", () => {
    const waitingHod = req({ status: "pending_hod", approval: hodThenHr("pending", "waiting") });
    expect(hrDecides(waitingHod)).toBe(false);
    expect(hrRejects(waitingHod)).toBe(false);
    const waitingHr = req({ status: "pending_hr", approval: hodThenHr("approved", "pending") });
    expect(hrDecides(waitingHr)).toBe(true);
  });

  it("an HR-only pipeline lets HR decide a request that is still labelled pending_hod", () => {
    const r = req({ status: "pending_hod", approval: pipeline([{ roles: ["hr"], state: "pending" }]) });
    expect(hrDecides(r)).toBe(true);
  });

  it("without a pipeline (older backend) HR decides at Awaiting HR only, as it always did", () => {
    expect(hrDecides(req({ status: "pending_hr" }))).toBe(true);
    expect(hrDecides(req({ status: "pending_hod" }))).toBe(false);
    expect(hrDecides(req({ status: "approved" }))).toBe(false);
  });

  it("a bulk approval takes only pending requests HR may decide now", () => {
    const rows = [
      req({ status: "pending_hr" }),
      req({ status: "pending_hod", approval: hodThenHr("pending", "waiting") }),
      req({ status: "approved", approval: pipeline([{ roles: ["hr"], state: "approved" }]) }),
      req({ status: "rejected" }),
      req({ status: "pending_hod" }),
    ];
    expect(bulkApprovable(rows).map((r) => r.id)).toEqual([rows[0].id]);
  });
});

describe("filters", () => {
  const rows = [
    req({ employeeName: "Asha Kumar", employeeCode: "E001", status: "pending_hr" }),
    req({
      employeeName: "Ravi Shankar",
      employeeCode: "E002",
      status: "pending_hod",
      punchSlot: "lunch_out",
      punchType: "OUT",
      punchTime: "13:00",
      branch: "Erode",
      department: "Cutting",
      date: "2026-09-15",
      reason: "Biometric was down",
    }),
    req({
      employeeName: "Meena",
      employeeCode: "E003",
      status: "approved",
      punchSlot: null,
      punchType: "OUT",
      date: "2026-10-01",
    }),
    req({ employeeName: "Kavi", employeeCode: "E004", status: "rejected", punchSlot: "evening_out", punchType: "OUT" }),
  ];

  it("Pending is awaiting HOD plus awaiting HR", () => {
    expect(filterRows(rows, { ...NO_FILTERS, status: "pending" })).toHaveLength(2);
    expect(filterRows(rows, { ...NO_FILTERS, status: "pending_hr" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, status: "pending_hod" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, status: "approved" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, status: "all" })).toHaveLength(4);
  });

  it("a search needs every word: employee, code, date, punch slot, reason, branch", () => {
    expect(filterRows(rows, { ...NO_FILTERS, query: "ravi" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, query: "e003" })[0].employeeName).toBe("Meena");
    expect(filterRows(rows, { ...NO_FILTERS, query: "2026-09-15" })[0].employeeName).toBe("Ravi Shankar");
    expect(filterRows(rows, { ...NO_FILTERS, query: "15 sep" })[0].employeeName).toBe("Ravi Shankar");
    expect(filterRows(rows, { ...NO_FILTERS, query: "lunch" })[0].employeeName).toBe("Ravi Shankar");
    expect(filterRows(rows, { ...NO_FILTERS, query: "biometric down" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, query: "erode lunch" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, query: "ravi evening" })).toHaveLength(0);
    expect(filterRows(rows, { ...NO_FILTERS, query: "1:00 pm" })).toHaveLength(1);
  });

  it("filters by punch slot, including requests that name none", () => {
    expect(filterRows(rows, { ...NO_FILTERS, slot: "morning_in" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, slot: "evening_out" })[0].employeeName).toBe("Kavi");
    expect(filterRows(rows, { ...NO_FILTERS, slot: "other" })[0].employeeName).toBe("Meena");
  });

  it("filters by branch, department and the missed date range", () => {
    expect(filterRows(rows, { ...NO_FILTERS, branch: "Erode" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, department: "Cutting" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, from: "2026-10-01" })).toHaveLength(3);
    expect(filterRows(rows, { ...NO_FILTERS, to: "2026-09-30" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, from: "2026-10-01", to: "2026-10-01" })).toHaveLength(1);
  });

  it("the status counts follow the other filters but not the status", () => {
    const counts = statusCounts(rows, { ...DEFAULT_FILTERS, slot: "evening_out" });
    expect(counts).toEqual({ all: 1, pending: 0, pending_hr: 0, pending_hod: 0, approved: 0, rejected: 1 });
    expect(statusCounts(rows, NO_FILTERS).pending).toBe(2);
  });
});

describe("summary", () => {
  const now = new Date(2026, 9, 10);

  it("counts who the requests wait for, and this month's decisions by when they were decided", () => {
    const rows = [
      req({ status: "pending_hr" }),
      req({ status: "pending_hr" }),
      req({ status: "pending_hod", approval: hodThenHr("pending", "waiting") }),
      req({ status: "approved", hrReviewedAt: "2026-10-02T06:00:00Z" }),
      req({ status: "approved", hrReviewedAt: "2026-09-20T06:00:00Z", createdAt: "2026-10-01T06:00:00Z" }),
      req({ status: "rejected", hodReviewedAt: "2026-10-05T06:00:00Z" }),
    ];
    expect(summarize(rows, now)).toEqual({
      awaitingHr: 2,
      hrCanDecide: 2,
      awaitingHod: 1,
      approvedThisMonth: 1,
      rejectedThisMonth: 1,
    });
  });

  it("a decided request with no review time counts in the month it was raised", () => {
    const s = summarize([req({ status: "approved", createdAt: "2026-10-03T06:00:00Z" })], now);
    expect(s.approvedThisMonth).toBe(1);
  });

  it("hrCanDecide can differ from the awaiting-HR count when the pipeline lets HR act earlier", () => {
    const early = req({ status: "pending_hod", approval: pipeline([{ roles: ["hr"], state: "pending" }]) });
    const s = summarize([early], now);
    expect(s.awaitingHr).toBe(0);
    expect(s.hrCanDecide).toBe(1);
  });

  it("takes the later of the two review times as the decision time", () => {
    expect(decidedAt(req({ hodReviewedAt: "2026-10-01T05:00:00Z", hrReviewedAt: "2026-10-02T05:00:00Z" }))).toBe(
      "2026-10-02T05:00:00Z",
    );
    expect(decidedAt(req())).toBeNull();
  });
});

describe("who decided, and when", () => {
  it("reads the decisions from the pipeline, so an HR-first order is described correctly", () => {
    const approval = pipeline([
      { roles: ["hr"], state: "approved", by: "Priya", at: "2026-10-02T05:00:00Z", decidedBy: "hr", comment: "ok" },
      { roles: ["hod"], state: "rejected", by: "Suresh", at: "2026-10-03T05:00:00Z", decidedBy: "hod" },
    ]);
    const lines = decisionLines(req({ status: "rejected", approval }));
    expect(lines.map((l) => [l.role, l.outcome, l.by])).toEqual([
      ["HR", "approved", "Priya"],
      ["HOD", "rejected", "Suresh"],
    ]);
    expect(lines[0].comment).toBe("ok");
  });

  it("falls back to the review fields for an older backend, as the page always did", () => {
    const hodRejected = req({
      status: "rejected",
      hodReviewedBy: "Suresh",
      hodReviewComment: "no",
      hodReviewedAt: "2026-10-02T05:00:00Z",
    });
    expect(decisionLines(hodRejected)).toEqual([
      { role: "HOD", outcome: "rejected", by: "Suresh", at: "2026-10-02T05:00:00Z", comment: "no" },
    ]);
    const both = req({ status: "approved", hodReviewedBy: "Suresh", hrReviewedBy: "Priya" });
    expect(decisionLines(both).map((l) => [l.role, l.outcome])).toEqual([
      ["HOD", "approved"],
      ["HR", "approved"],
    ]);
    expect(decisionLines(req())).toEqual([]);
  });

  it("names who the request waits for", () => {
    expect(waitingLine(req({ status: "pending_hod", approval: hodThenHr("pending", "waiting") }))).toBe(
      "Waiting for HOD",
    );
    expect(waitingLine(req({ status: "pending_hr" }))).toBe("Awaiting HR");
  });
});

describe("labels, times and sorting", () => {
  it("names the punch from its slot, or its direction when it has none", () => {
    expect(punchLabel({ punchSlot: "lunch_in", punchType: "IN" })).toBe("Lunch Check-In");
    expect(punchLabel({ punchSlot: null, punchType: "IN" })).toBe("Check-In");
    expect(punchLabel({ punchSlot: null, punchType: "OUT" })).toBe("Check-Out");
  });

  it("writes times in 12 hours and finds the weekday", () => {
    expect(formatPunchTime("09:05")).toBe("9:05 am");
    expect(formatPunchTime("13:00")).toBe("1:00 pm");
    expect(formatPunchTime("00:30")).toBe("12:30 am");
    expect(formatPunchTime("12:00")).toBe("12:00 pm");
    expect(formatPunchTime(null)).toBe("-");
    expect(weekdayOf("2026-10-09")).toBe("Fri");
    expect(weekdayOf("")).toBe("");
  });

  it("sorts by request time, missed date, employee and who is waiting, without changing the input", () => {
    const a = req({ employeeName: "Zed", createdAt: "2026-10-01T00:00:00Z", date: "2026-10-05", status: "approved" });
    const b = req({ employeeName: "Amy", createdAt: "2026-10-03T00:00:00Z", date: "2026-10-01", status: "pending_hr" });
    const c = req({
      employeeName: "Moe",
      createdAt: "2026-10-02T00:00:00Z",
      date: "2026-10-09",
      status: "pending_hod",
    });
    const input = [a, b, c];
    const names = (rows: MissingRow[]) => rows.map((r) => r.employeeName);
    expect(names(sortRows(input, { key: "created", dir: "desc" }))).toEqual(["Amy", "Moe", "Zed"]);
    expect(names(sortRows(input, { key: "created", dir: "asc" }))).toEqual(["Zed", "Moe", "Amy"]);
    expect(names(sortRows(input, { key: "date", dir: "desc" }))).toEqual(["Moe", "Zed", "Amy"]);
    expect(names(sortRows(input, { key: "employee", dir: "asc" }))).toEqual(["Amy", "Moe", "Zed"]);
    expect(names(sortRows(input, { key: "status", dir: "asc" }))).toEqual(["Amy", "Moe", "Zed"]);
    expect(names(input)).toEqual(["Zed", "Amy", "Moe"]);
  });
});

describe("export", () => {
  it("writes one line per request with who decided and when", () => {
    const r = req({
      status: "approved",
      hodReviewedBy: "Suresh",
      hodReviewedAt: "2026-10-02T05:00:00Z",
      hrReviewedBy: "Priya",
      hrReviewComment: "checked the gate log",
      hrReviewedAt: "2026-10-03T05:00:00Z",
    });
    const t = exportTable([r]);
    expect(t.rows[0]).toHaveLength(t.headers.length);
    const at = (h: string) => t.rows[0][t.headers.indexOf(h)];
    expect(at("Employee code")).toBe("E001");
    expect(at("Punch")).toBe("Morning Check-In");
    expect(at("Time")).toBe("9:05 am");
    expect(at("Status")).toBe("Approved");
    expect(at("Waiting for")).toBe("");
    expect(at("HOD by")).toBe("Suresh");
    expect(at("HR by")).toBe("Priya");
    expect(at("HR comment")).toBe("checked the gate log");
    expect(at("Missed date")).toBe("8 Oct 2026");
  });

  it("says who a pending request waits for", () => {
    const t = exportTable([req({ status: "pending_hod", approval: hodThenHr("pending", "waiting") })]);
    expect(t.rows[0][t.headers.indexOf("Waiting for")]).toBe("Waiting for HOD");
  });
});
