import { describe, expect, it } from "vitest";
import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";
import {
  absentRows,
  branchLine,
  dash,
  filterByInformed,
  formatClock12,
  formatDMY,
  compareUnits,
  groupByUnit,
  informedColor,
  informedLabel,
  informedValue,
  lateRows,
  latestArrival,
  leaveTitle,
  localToday,
  minutesOf,
  parseTab,
  searchWithTab,
  totalRows,
  unitCounts,
} from "./logic";
import { LEAVE_COLUMNS, leaveSpec } from "./sheets";

let nextId = 1;
const row = (over: Partial<ReportLogDailyRow> = {}): ReportLogDailyRow => ({
  employeeId: nextId++,
  employeeCode: `E${nextId}`,
  employeeName: `Person ${nextId}`,
  department: "Admin",
  designation: "Clerk",
  firstPunch: null,
  branchId: null,
  branchName: null,
  unitLabel: null,
  status: "present",
  isLate: false,
  lateAfternoon: false,
  permissionAfternoon: false,
  isCompensationDay: false,
  isInformed: null,
  ...over,
});
const ho = (over: Partial<ReportLogDailyRow> = {}) =>
  row({ branchId: 1, branchName: "Head Office", unitLabel: "HO", ...over });
const u1 = (over: Partial<ReportLogDailyRow> = {}) =>
  row({ branchId: 2, branchName: "Unit One", unitLabel: "U-1", ...over });
const u2 = (over: Partial<ReportLogDailyRow> = {}) =>
  row({ branchId: 3, branchName: "Unit Two", unitLabel: "U-2", ...over });

describe("the sub-tab of an address", () => {
  it("opens the Monthly Report with no or an unknown tab", () => {
    expect(parseTab(null)).toBe("monthly");
    expect(parseTab("")).toBe("monthly");
    expect(parseTab("nonsense")).toBe("monthly");
  });
  it("names the three tabs, whatever the case", () => {
    expect(parseTab("monthly")).toBe("monthly");
    expect(parseTab("leave")).toBe("leave");
    expect(parseTab("LATE")).toBe("late");
  });
  it("maps the old 'daily' to the Daily Leave Report", () => {
    expect(parseTab("daily")).toBe("leave");
  });
  it("sets the tab and keeps every other key", () => {
    expect(searchWithTab("", "late")).toBe("?tab=late");
    expect(searchWithTab("?tab=monthly&from=2026-10-01", "leave")).toBe("?tab=leave&from=2026-10-01");
  });
});

describe("dates and times", () => {
  it("formats the two title dates", () => {
    expect(formatDMY("2026-10-03")).toBe("03.10.2026");
    expect(formatDMY("garbage")).toBe("garbage");
  });
  it("builds the title of the paper leave list", () => {
    expect(leaveTitle("2026-10-03")).toBe("03.10.2026 STAFF LEAVE LIST");
  });
  it("turns a 24 hour punch into hh:mm AM/PM", () => {
    expect(formatClock12("09:06")).toBe("09:06 AM");
    expect(formatClock12("13:05")).toBe("01:05 PM");
    expect(formatClock12("00:10")).toBe("12:10 AM");
    expect(formatClock12("12:00")).toBe("12:00 PM");
    expect(formatClock12("09:06:30")).toBe("09:06 AM");
    expect(formatClock12(null)).toBe("");
    expect(formatClock12("25:00")).toBe("");
    expect(formatClock12("nope")).toBe("");
  });
  it("orders times, a missing punch last", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it("reads today in the local calendar, not UTC", () => {
    // 00:30 local on the 5th: the UTC date of that instant is still the 4th in a zone ahead of UTC
    expect(localToday(new Date(2026, 9, 5, 0, 30))).toBe("2026-10-05");
    expect(localToday(new Date(2026, 0, 31, 23, 59))).toBe("2026-01-31");
  });
});

describe("the Informed remark", () => {
  it("labels and colours the three states like the paper list", () => {
    expect(informedLabel({ isInformed: true })).toBe("Informed");
    expect(informedLabel({ isInformed: false })).toBe("Not informed");
    expect(informedLabel({ isInformed: null })).toBe("Unset");
    expect(informedColor({ isInformed: true })).toBe("#9bbb59");
    expect(informedColor({ isInformed: false })).toBe("#f79646");
    expect(informedColor({ isInformed: null })).toBe("#dddddd");
    expect(informedValue({ isInformed: false })).toBe("not_informed");
  });
  it("filters by it", () => {
    const rows = [row({ isInformed: true }), row({ isInformed: false }), row({ isInformed: null })];
    expect(filterByInformed(rows, "all")).toHaveLength(3);
    expect(filterByInformed(rows, "informed")).toHaveLength(1);
    expect(filterByInformed(rows, "not_informed")).toHaveLength(1);
    expect(filterByInformed(rows, "unset")).toHaveLength(1);
  });
});

describe("which rows each list takes", () => {
  it("the leave list is the absent ones only", () => {
    const rows = [row({ status: "absent" }), row({ status: "present" }), row({ status: "on_leave" })];
    expect(absentRows(rows)).toHaveLength(1);
  });
  it("the late list is the engine's own late flag, nothing else", () => {
    const rows = [
      row({ isLate: true, status: "present" }),
      row({ isLate: true, status: "half_shift" }),
      row({ isLate: false, status: "present", firstPunch: "09:05" }),
      row({ isLate: false, status: "absent" }),
    ];
    expect(lateRows(rows)).toHaveLength(2);
  });
});

describe("unit blocks", () => {
  it("puts HO first, then the other branches by name, then Other", () => {
    const rows = [
      row({ employeeName: "No Branch" }),
      u2({ employeeName: "B" }),
      ho({ employeeName: "A" }),
      u1({ employeeName: "C" }),
    ];
    expect(groupByUnit(rows).map((b) => b.label)).toEqual(["HO", "U-1", "U-2", "Other"]);
  });
  it("orders other branches by name even when they arrive in another order", () => {
    const blocks = groupByUnit([
      row({ branchId: 9, branchName: "Weaving", unitLabel: "WV" }),
      row({ branchId: 8, branchName: "Dyeing 10", unitLabel: "D-10" }),
      row({ branchId: 7, branchName: "Dyeing 2", unitLabel: "D-2" }),
    ]);
    expect(blocks.map((b) => b.label)).toEqual(["D-2", "D-10", "WV"]);
  });
  it("keeps the rows of a block in the order they come in", () => {
    const a = ho({ employeeName: "First" });
    const b = ho({ employeeName: "Second" });
    expect(groupByUnit([a, b])[0].rows).toEqual([a, b]);
  });
  it("falls back to the branch name when an older backend sends no label, and to Other when it sends no branch", () => {
    const [named] = groupByUnit([row({ branchId: 5, branchName: "Annexe", unitLabel: null })]);
    expect(named.label).toBe("Annexe");
    const [none] = groupByUnit([row()]);
    expect(none.label).toBe("Other");
    expect(none.key).toBe("none");
  });
  it("counts per unit and in total", () => {
    const blocks = groupByUnit([ho(), ho(), u1()]);
    expect(unitCounts(blocks)).toBe("HO 2 · U-1 1");
    expect(totalRows(blocks)).toBe(3);
  });
});

describe("the latest arrival", () => {
  it("finds it", () => {
    expect(latestArrival([])).toBeNull();
    expect(latestArrival([row({ firstPunch: null })])).toBeNull();
    const late = row({ employeeName: "Last", firstPunch: "09:58" });
    expect(latestArrival([row({ firstPunch: "09:10" }), late])).toBe(late);
  });
});

describe("the sheets (what Excel, the PDF and the picture all draw)", () => {
  it("the leave list has the six columns and the remark colours of the paper list", () => {
    expect(LEAVE_COLUMNS.map((c) => c.header)).toEqual([
      "S.No",
      "Ticket No",
      "Employee Name",
      "Department",
      "Designation",
      "Remarks",
    ]);
    const spec = leaveSpec("2026-10-03", [
      ho({ employeeCode: "2503", employeeName: "Narayanan", department: "ADMIN", designation: null, isInformed: true }),
      u1({ employeeCode: "86", employeeName: "Marimuthu", isInformed: false }),
    ]);
    expect(spec.title).toBe("03.10.2026 STAFF LEAVE LIST");
    expect(spec.blocks.map((b) => b.label)).toEqual(["HO", "U-1"]);
    const remarks = LEAVE_COLUMNS[5];
    expect(remarks.cell(spec.blocks[0].rows[0], 0)).toEqual({ text: "Informed", fill: "#9bbb59", bold: true });
    expect(remarks.cell(spec.blocks[1].rows[0], 0)).toEqual({ text: "Not informed", fill: "#f79646", bold: true });
    expect(LEAVE_COLUMNS[4].cell(spec.blocks[0].rows[0], 0).text).toBe("—");
  });
});

describe("small helpers", () => {
  it("shows a dash for an empty cell", () => {
    expect(dash(null)).toBe("—");
    expect(dash("  ")).toBe("—");
    expect(dash("QC")).toBe("QC");
  });
  it("names the branch an export is for", () => {
    expect(branchLine("Unit One")).toBe("Unit One Branch");
    expect(branchLine(null)).toBe("All Branches");
  });
  it("uses u2 in a block of its own", () => {
    expect(groupByUnit([u2()])[0].label).toBe("U-2");
  });
});

describe("the order of units", () => {
  const head = (key: string, label: string, branchName: string | null = null) => ({ key, label, branchName });
  const sorted = (...units: ReturnType<typeof head>[]) => [...units].sort(compareUnits).map((u) => u.label);

  it("puts HO first, the others in natural order of their label, and Other last", () => {
    expect(
      sorted(head("none", "Other"), head("5", "UKT-10"), head("3", "UKT-2"), head("1", "HO"), head("4", "UKT-1")),
    ).toEqual(["HO", "UKT-1", "UKT-2", "UKT-10", "Other"]);
  });
  it("breaks a tie on the label by the branch name, and is the same whichever way round it is asked", () => {
    const a = head("7", "WB", "Weaving A");
    const b = head("8", "WB", "Weaving B");
    expect(compareUnits(a, b)).toBeLessThan(0);
    expect(compareUnits(b, a)).toBeGreaterThan(0);
    expect(compareUnits(a, a)).toBe(0);
  });
});
