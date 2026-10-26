import { describe, expect, it } from "vitest";
import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";
import {
  DEFAULT_SORT,
  LATE_COLUMNS,
  SEVERITY_BANDS,
  cellText,
  explain,
  filterNote,
  firstDir,
  formatMinutes,
  generatedStamp,
  lateEntries,
  lateFileStem,
  nextSort,
  severityOf,
  sortEntries,
  summarize,
  toEntry,
  type LateEntry,
} from "./late";

let id = 1;
const row = (over: Partial<ReportLogDailyRow> = {}): ReportLogDailyRow => ({
  employeeId: id++,
  employeeCode: `E${id}`,
  employeeName: `Person ${id}`,
  department: "Admin",
  designation: "Clerk",
  firstPunch: "09:40",
  shiftStart: "09:00",
  graceMinutes: 15,
  lateDeadline: "09:15",
  minutesAfterStart: 40,
  minutesLate: 25,
  branchId: 1,
  branchName: "Head Office",
  unitLabel: "HO",
  status: "present",
  isLate: true,
  lateAfternoon: false,
  permissionAfternoon: false,
  isCompensationDay: false,
  isInformed: null,
  ...over,
});
const entry = (over: Partial<ReportLogDailyRow> = {}): LateEntry => toEntry(row(over));

describe("the late entries", () => {
  it("are the rows the engine flagged late, nothing else", () => {
    const rows = [row(), row({ isLate: false, minutesLate: null }), row({ status: "absent", isLate: false })];
    expect(lateEntries(rows)).toHaveLength(1);
  });
  it("carry the fields the report shows", () => {
    expect(entry({ employeeName: "Babu", employeeCode: "2", department: "QC" })).toMatchObject({
      name: "Babu",
      code: "2",
      department: "QC",
      unit: "HO",
      shiftStart: "09:00",
      grace: 15,
      lateDeadline: "09:15",
      punchIn: "09:40",
      minutesLate: 25,
      minutesAfterStart: 40,
    });
  });
  it("cope with an older backend that sends none of the new fields", () => {
    const old = toEntry(
      row({
        shiftStart: undefined,
        graceMinutes: undefined,
        lateDeadline: undefined,
        minutesLate: undefined,
        minutesAfterStart: undefined,
        unitLabel: undefined,
      }),
    );
    expect(old).toMatchObject({ shiftStart: null, grace: null, minutesLate: null, unit: null });
    expect(cellText(old, "shiftStart")).toBe("—");
    expect(cellText(old, "minutesLate")).toBe("—");
  });
});

describe("the columns", () => {
  it("are the seven of the report, with the exact headers, on the page and in both files", () => {
    expect(LATE_COLUMNS.map((c) => c.header)).toEqual([
      "Employee Name",
      "Employee Code",
      "Department",
      "Shift Start Time",
      "Grace Period (minutes)",
      "Actual Punch-In Time",
      "Total Minutes Late",
    ]);
  });
  it("fill the width of an A4 landscape page between its margins", () => {
    expect(LATE_COLUMNS.reduce((sum, c) => sum + c.mm, 0)).toBe(273);
  });
  it("show times as hh:mm AM/PM, the grace as a number and the minutes as 'N min'", () => {
    const e = entry({ shiftStart: "09:00", firstPunch: "13:05", graceMinutes: 10, minutesLate: 14 });
    expect(cellText(e, "shiftStart")).toBe("09:00 AM");
    expect(cellText(e, "punchIn")).toBe("01:05 PM");
    expect(cellText(e, "grace")).toBe("10");
    expect(cellText(e, "minutesLate")).toBe("14 min");
    expect(cellText(entry({ department: null }), "department")).toBe("—");
  });
  it("write minutes as e.g. 14 min", () => {
    expect(formatMinutes(14)).toBe("14 min");
    expect(formatMinutes(1)).toBe("1 min");
    expect(formatMinutes(23.33)).toBe("23.3 min");
    expect(formatMinutes(null)).toBe("—");
  });
});

describe("severity steps", () => {
  it("are 1-10, 11-30 and 31+ minutes", () => {
    expect(SEVERITY_BANDS.map((b) => [b.key, b.label])).toEqual([
      ["low", "1-10 min"],
      ["mid", "11-30 min"],
      ["high", "31+ min"],
    ]);
    expect([1, 10].map(severityOf)).toEqual(["low", "low"]);
    expect([11, 30].map(severityOf)).toEqual(["mid", "mid"]);
    expect([31, 200].map(severityOf)).toEqual(["high", "high"]);
  });
  it("have none for a missing or zero figure", () => {
    expect(severityOf(null)).toBeNull();
    expect(severityOf(0)).toBeNull();
    expect(severityOf(undefined)).toBeNull();
  });
});

describe("how the minutes are explained", () => {
  it("says how the figure was worked out", () => {
    expect(explain(entry())).toBe(
      "Punch-in 09:40 AM minus the late deadline 09:15 AM (shift start 09:00 AM + 15 min grace) = 25 min",
    );
  });
  it("says so when there is no shift to measure from", () => {
    expect(explain(entry({ minutesLate: null }))).toContain("No shift");
  });
});

describe("sorting", () => {
  const a = entry({
    employeeName: "Anand",
    employeeCode: "10",
    department: "Zeta",
    minutesLate: 5,
    firstPunch: "09:21",
    graceMinutes: 15,
  });
  const b = entry({
    employeeName: "Babu",
    employeeCode: "9",
    department: "Alpha",
    minutesLate: 40,
    firstPunch: "09:55",
    graceMinutes: 5,
  });
  const c = entry({
    employeeName: "Chitra",
    employeeCode: "100",
    department: null,
    minutesLate: 12,
    firstPunch: "09:30",
    graceMinutes: 10,
  });
  const names = (sort?: Parameters<typeof sortEntries>[1]) => sortEntries([a, b, c], sort).map((e) => e.name);

  it("opens on the longest delay first", () => {
    expect(DEFAULT_SORT).toEqual({ key: "minutesLate", dir: "desc" });
    expect(names()).toEqual(["Babu", "Chitra", "Anand"]);
  });
  it("sorts every column both ways", () => {
    expect(names({ key: "minutesLate", dir: "asc" })).toEqual(["Anand", "Chitra", "Babu"]);
    expect(names({ key: "name", dir: "asc" })).toEqual(["Anand", "Babu", "Chitra"]);
    expect(names({ key: "name", dir: "desc" })).toEqual(["Chitra", "Babu", "Anand"]);
    expect(names({ key: "code", dir: "asc" })).toEqual(["Babu", "Anand", "Chitra"]);
    expect(names({ key: "punchIn", dir: "asc" })).toEqual(["Anand", "Chitra", "Babu"]);
    expect(names({ key: "grace", dir: "asc" })).toEqual(["Babu", "Chitra", "Anand"]);
  });
  it("puts a missing value last whichever way the column runs", () => {
    expect(names({ key: "department", dir: "asc" })).toEqual(["Babu", "Anand", "Chitra"]);
    expect(names({ key: "department", dir: "desc" })).toEqual(["Anand", "Babu", "Chitra"]);
  });
  it("keeps a tie in name order and does not change its input", () => {
    const x = entry({ employeeName: "Zed", minutesLate: 9 });
    const y = entry({ employeeName: "Amy", minutesLate: 9 });
    const input = [x, y];
    expect(sortEntries(input).map((e) => e.name)).toEqual(["Amy", "Zed"]);
    expect(input[0]).toBe(x);
  });
  it("flips a column on a second click and starts another in its own direction", () => {
    expect(nextSort(DEFAULT_SORT, "minutesLate")).toEqual({ key: "minutesLate", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "name", dir: "asc" }, "minutesLate")).toEqual({ key: "minutesLate", dir: "desc" });
    expect(firstDir("punchIn")).toBe("asc");
  });
});

describe("the summary", () => {
  it("counts, averages and finds the longest delay", () => {
    const s = summarize([
      entry({ employeeName: "A", minutesLate: 5 }),
      entry({ employeeName: "B", minutesLate: 40 }),
      entry({ employeeName: "C", minutesLate: 12 }),
    ]);
    expect(s).toEqual({ count: 3, average: 19, longest: 40, longestName: "B" });
  });
  it("rounds the average to one decimal and ignores staff whose lateness could not be measured", () => {
    const s = summarize([entry({ minutesLate: 10 }), entry({ minutesLate: 11 }), entry({ minutesLate: null })]);
    expect(s.count).toBe(3);
    expect(s.average).toBe(10.5);
  });
  it("is empty for nobody", () => {
    expect(summarize([])).toEqual({ count: 0, average: null, longest: null, longestName: null });
  });
});

describe("file helpers", () => {
  it("names the files after the report and its date", () => {
    expect(lateFileStem("2026-10-16")).toBe("Daily_Late_Report_2026-10-16");
  });
  it("writes the moment a file was made", () => {
    expect(generatedStamp(new Date(2026, 9, 26, 11, 5))).toBe("26 Oct 2026, 11:05 AM");
    expect(generatedStamp(new Date(2026, 9, 26, 0, 7))).toBe("26 Oct 2026, 12:07 AM");
    expect(generatedStamp(new Date(2026, 9, 26, 15, 30))).toBe("26 Oct 2026, 03:30 PM");
  });
  it("words the filters of a download", () => {
    expect(filterNote(null, "")).toBe("");
    expect(filterNote("Admin", " kumar ")).toBe("Department: Admin; Search: kumar");
  });
});
