import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  InvestigationDay,
  InvestigationDecision,
  InvestigationRow,
  InvestigationSettings,
} from "@/lib/api-client/custom-hooks/employee-investigation";
import {
  ALL,
  NO_FILTERS,
  autoChip,
  calendarMonths,
  canReactivate,
  dayKindCounts,
  dayLabel,
  decisionBody,
  decisionIsCurrent,
  decisionText,
  doneTitle,
  errorText,
  filtersActive,
  keepOffered,
  lastAttendedText,
  lastRunText,
  leaveRange,
  leaveText,
  matchesFilters,
  names,
  noDataText,
  optionsOf,
  parseKind,
  parseTab,
  reasonProblem,
  refusalReport,
  requestStatusLabel,
  ruleLines,
  runNowBlock,
  runNowDoneTitle,
  sinceText,
} from "./logic";

const decision = (over: Partial<InvestigationDecision> = {}): InvestigationDecision => ({
  id: 1,
  action: "kept_active",
  actionLabel: "Kept active",
  reason: "On medical leave",
  by: "Priya",
  at: "2026-11-20T10:00:00+05:30",
  bucket: "30",
  spellStart: "2026-10-10",
  lastAttended: "2026-10-09",
  absentDays: 41,
  ...over,
});

const row = (over: Partial<InvestigationRow> = {}): InvestigationRow => ({
  id: 7,
  code: "30007",
  name: "SURYA M",
  kind: "staff",
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "Head Office",
  phone: "9876543210",
  joinDate: "2024-01-10",
  lastAttended: "2026-10-09",
  awayFrom: "2026-10-10",
  calendarDays: 44,
  absentDays: 42,
  noDataDays: 2,
  workingDays: 33,
  leaveDays: 2.5,
  coveredByLeave: false,
  neverAttended: false,
  bucket: "30",
  decision: null,
  keptActive: false,
  autoTonight: true,
  autoWhyNot: null,
  ...over,
});

const settings = (over: Partial<InvestigationSettings> = {}): InvestigationSettings => ({
  autoEnabled: true,
  autoDays: 30,
  runAt: "01:00",
  lastRunAt: null,
  lastRun: null,
  canChange: true,
  rules: { list15: 15, list30: 30, gapShare: 10 },
  ...over,
});

describe("the address", () => {
  it("reads the tab and the kind, falling back to 15 Days and All", () => {
    expect(parseTab("30")).toBe("30");
    expect(parseTab("auto")).toBe("auto");
    expect(parseTab("45")).toBe("15");
    expect(parseTab(undefined)).toBe("15");
    expect(parseKind("production")).toBe("production");
    expect(parseKind("contract")).toBe("all");
  });
});

describe("the filters", () => {
  it("search by name, code or phone, and filter by department and unit names", () => {
    const r = row();
    expect(matchesFilters(r, NO_FILTERS)).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, search: "surya" })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, search: "30007" })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, search: "98765" })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, search: "meena" })).toBe(false);
    expect(matchesFilters(r, { ...NO_FILTERS, department: "ACCOUNTS" })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, department: "STITCHING" })).toBe(false);
    expect(matchesFilters(r, { ...NO_FILTERS, unit: "Unit 2" })).toBe(false);
    // a History item's employee has no phone
    expect(matchesFilters({ name: "A", code: "1", department: "X", unit: "U" }, { ...NO_FILTERS, search: "1" })).toBe(
      true,
    );
  });

  it("says when a filter is on, and drops a value the list does not offer", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, unit: "Head Office" })).toBe(true);
    const options = optionsOf(["STITCHING", "", null, "ACCOUNTS", "STITCHING"]);
    expect(options).toEqual([
      { value: "ACCOUNTS", label: "ACCOUNTS" },
      { value: "STITCHING", label: "STITCHING" },
    ]);
    expect(keepOffered("ACCOUNTS", options)).toBe("ACCOUNTS");
    expect(keepOffered("CUTTING", options)).toBe(ALL);
    expect(keepOffered(ALL, [])).toBe(ALL);
  });
});

describe("the words of a row", () => {
  it("names a few people and counts the rest", () => {
    expect(names([{ name: "A" }])).toBe("A");
    expect(names([{ name: "A" }, { name: "B" }])).toBe("A and B");
    expect(names([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }])).toBe(
      "A, B, C and 2 more",
    );
  });

  it("says how many no-data days were left out, and nothing when none", () => {
    expect(noDataText(0)).toBeNull();
    expect(noDataText(1)).toBe("1 no-data day left out");
    expect(noDataText(3)).toBe("3 no-data days left out");
  });

  it("explains a never-attended employee by the join date", () => {
    expect(lastAttendedText(row())).toEqual({ main: "9 Oct 2026", note: null });
    expect(lastAttendedText(row({ neverAttended: true, lastAttended: null, joinDate: "2026-09-01" }))).toEqual({
      main: "Never attended",
      note: "Counted from the join date (1 Sep 2026)",
    });
    expect(lastAttendedText(row({ neverAttended: true, lastAttended: null, joinDate: null })).note).toContain(
      "no join date",
    );
  });

  it("puts approved leave against the working days, halves included", () => {
    expect(leaveText(row())).toBe("2.5 days of 33 working days");
    expect(leaveText(row({ leaveDays: 1, workingDays: 1 }))).toBe("1 day of 1 working day");
  });

  it("reads a decision, and tells the running absence from an earlier one", () => {
    expect(decisionText(decision())).toBe("Kept active by Priya: On medical leave");
    expect(decisionText(decision({ by: null, reason: null }))).toBe("Kept active");
    expect(decisionIsCurrent(row({ decision: decision() }))).toBe(true);
    expect(decisionIsCurrent(row({ decision: decision({ spellStart: "2026-06-01" }) }))).toBe(false);
    expect(decisionIsCurrent(row())).toBe(false);
  });

  it("warns of tonight's run, and says so differently while the switch is off", () => {
    expect(autoChip(row({ autoTonight: false }), settings())).toBeNull();
    expect(autoChip(row(), settings())).toMatchObject({ label: "Auto tonight", tone: "warning" });
    expect(autoChip(row(), settings())?.title).toContain("tonight at 01:00");
    expect(autoChip(row(), settings({ autoEnabled: false }))).toMatchObject({
      label: "Due for the Auto Trigger",
      tone: "neutral",
    });
  });
});

describe("the reason", () => {
  it("is required, 3 to 500 characters once trimmed", () => {
    expect(reasonProblem("")).toContain("Write a reason");
    expect(reasonProblem("   ")).toContain("Write a reason");
    expect(reasonProblem(" ok ")).toBe("Write at least 3 characters.");
    expect(reasonProblem("ok!")).toBeNull();
    expect(reasonProblem("x".repeat(500))).toBeNull();
    expect(reasonProblem("x".repeat(501))).toBe("Keep it to 500 characters.");
  });
});

describe("a decision", () => {
  it("sends the list it was decided in with Mark inactive and Keep active, none with Make active again", () => {
    const rows = [row({ id: 1 }), row({ id: 2, bucket: "15" })];
    expect(decisionBody("inactivate", rows, "  left  ", "15")).toEqual({
      employeeIds: [1, 2],
      reason: "left",
      bucket: "15",
    });
    // the Tonight list (no list) takes the rows' own list
    expect(decisionBody("keep", [row({ id: 3 })], "medical", null)).toEqual({
      employeeIds: [3],
      reason: "medical",
      bucket: "30",
    });
    // decided on the Auto Trigger tab
    expect(decisionBody("inactivate", [row({ id: 5 })], "left", "auto")).toEqual({
      employeeIds: [5],
      reason: "left",
      bucket: "auto",
    });
    expect(decisionBody("reactivate", [{ id: 4 }], "came back", null)).toEqual({
      employeeIds: [4],
      reason: "came back",
    });
  });

  it("reports what was done and who was refused, with the server's reasons", () => {
    expect(doneTitle("inactivate", 3)).toBe("3 employees marked inactive");
    expect(doneTitle("keep", 1)).toBe("1 employee kept active");
    expect(doneTitle("reactivate", 2)).toBe("2 employees made active again");
    expect(refusalReport("keep", { done: [], refused: [] })).toBeNull();
    const report = refusalReport("inactivate", {
      done: [],
      refused: [{ employeeId: 1, employeeCode: "30001", name: "A", reason: "Already inactive." }],
    });
    expect(report?.title).toBe("1 employee not marked inactive");
    expect(report?.items[0].reason).toBe("Already inactive.");
  });

  it("shows the server's sentence for a failed call", () => {
    const response = new Response("{}", { status: 400, statusText: "Bad Request" });
    const err = new ApiError(response, { error: "Select at least one employee." }, { method: "POST", url: "/x" });
    expect(errorText(err)).toBe("Select at least one employee.");
    expect(errorText(new Error("HTTP 403 Forbidden: Only a login for all units"))).toBe("Only a login for all units");
    expect(errorText(null)).toContain("Could not reach the server");
  });
});

describe("the Auto Trigger", () => {
  it("says when it last ran and what it did", () => {
    expect(lastRunText(settings())).toBe("Not run yet.");
    const ran = settings({
      lastRunAt: "2026-11-23T01:00:00+05:30",
      lastRun: {
        ran: true,
        at: "2026-11-23T01:00:00+05:30",
        day: "2026-11-23",
        inactivated: 3,
        employeeIds: [1, 2, 3],
      },
    });
    expect(lastRunText(ran)).toMatch(/^Last run .*: 3 employees marked inactive\.$/);
    expect(
      lastRunText(settings({ lastRunAt: "2026-11-23T01:00:00+05:30", lastRun: { ran: true, inactivated: 0 } })),
    ).toContain("nobody was due");
    // a Run now says who pressed it; the nightly run does not
    const now = { ran: true, at: "2026-11-23T15:00:00+05:30", inactivated: 1 };
    expect(lastRunText(settings({ lastRun: { ...now, runBy: "Priya" } }))).toMatch(
      /^Last run .* \(Run now by Priya\): 1 employee marked inactive\.$/,
    );
    expect(lastRunText(settings({ lastRun: { ...now, runBy: "nightly" } }))).not.toContain("Run now");
  });

  it("lets Run now be pressed only by a login for all units with edit rights, when someone is due", () => {
    expect(runNowBlock(settings({ canChange: false }), true, 3)).toBe(
      "The Auto Trigger runs for the whole company: only a login for all units can run it.",
    );
    expect(runNowBlock(settings(), false, 3)).toBe("Needs edit rights on this page.");
    expect(runNowBlock(settings(), true, 0)).toBe("Nobody is due.");
    expect(runNowBlock(settings(), true, null)).toContain("Checking");
    expect(runNowBlock(settings(), true, 2)).toBeNull();
    // the switch being off does not stop Run now
    expect(runNowBlock(settings({ autoEnabled: false }), true, 2)).toBeNull();
    expect(runNowDoneTitle(2)).toBe("2 employees marked inactive");
    expect(runNowDoneTitle(0)).toBe("Nobody was due: nobody was marked inactive");
  });

  it("puts the rule and its exceptions in plain words", () => {
    const { rule, exceptions, counting } = ruleLines(settings());
    expect(rule).toContain("Every night at 01:00");
    expect(rule).toContain("more than 30 days");
    expect(exceptions.join(" ")).toContain("approved leave");
    expect(exceptions.join(" ")).toContain("kept active");
    expect(exceptions.join(" ")).toContain("no attendance ever recorded");
    expect(counting[0]).toBe("15 Days lists 15-29 days away, 30 Days lists 30 or more.");
    expect(counting.join(" ")).toContain("fewer than 1 in 10");
  });

  it("tells what happened since a run, and who may be made active again", () => {
    const item = {
      since: decision({
        action: "reactivated",
        actionLabel: "Made active again",
        reason: "came back",
        at: "2026-11-24T09:00:00",
      }),
    };
    expect(sinceText(item)).toBe("Made active again by Priya on 24 Nov 2026: came back");
    expect(sinceText({ since: null })).toBeNull();
    const employee = {
      id: 1,
      code: "1",
      name: "A",
      kind: "staff" as const,
      department: "",
      unit: "",
      status: "inactive",
    };
    expect(canReactivate({ employee })).toBe(true);
    expect(canReactivate({ employee: { ...employee, status: "active" } })).toBe(false);
  });
});

describe("the absence calendar", () => {
  const days: InvestigationDay[] = [
    { date: "2026-10-30", kind: "absent", holiday: null },
    { date: "2026-10-31", kind: "no_data", holiday: null },
    { date: "2026-11-01", kind: "sunday", holiday: null },
    { date: "2026-11-02", kind: "leave", holiday: null },
    { date: "2026-11-03", kind: "holiday", holiday: "Diwali" },
  ];

  it("groups the days by month, padded so the weeks run Monday to Sunday", () => {
    const months = calendarMonths(days);
    expect(months.map((m) => m.label)).toEqual(["October 2026", "November 2026"]);
    // 30 Oct 2026 is a Friday: four blanks (Mon-Thu) before it
    expect(months[0].cells.slice(0, 4)).toEqual([null, null, null, null]);
    expect(months[0].cells[4]?.date).toBe("2026-10-30");
    // 1 Nov 2026 is a Sunday: six blanks before it
    expect(months[1].cells.filter((c) => c === null)).toHaveLength(6);
    expect(months[1].cells[6]?.date).toBe("2026-11-01");
  });

  it("counts the kinds and names each day, a holiday by its name", () => {
    const counts = dayKindCounts(days);
    expect(counts).toMatchObject({ absent: 1, no_data: 1, sunday: 1, leave: 1, holiday: 1, leave_pending: 0 });
    expect(dayLabel(days[4])).toBe("Tue, 3 Nov 2026: Holiday (Diwali)");
    expect(dayLabel(days[1])).toBe("Sat, 31 Oct 2026: No data (unit's punches missing)");
  });

  it("labels request statuses and leave ranges", () => {
    expect(requestStatusLabel("approved")).toBe("Approved");
    expect(requestStatusLabel("pending_hod")).toBe("Waiting for HOD");
    expect(requestStatusLabel("on_hold")).toBe("On hold");
    expect(leaveRange("2026-11-02", "2026-11-02")).toBe("2 Nov 2026");
    expect(leaveRange("2026-11-02", "2026-11-05")).toBe("2 Nov 2026 - 5 Nov 2026");
  });
});
