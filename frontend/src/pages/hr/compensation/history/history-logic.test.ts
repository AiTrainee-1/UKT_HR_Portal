import { describe, expect, it } from "vitest";
import { emptyReport, reportOf, TODAY } from "../fixtures";
import {
  CSV_COLUMNS,
  IDENTITY_COLUMNS,
  REDEMPTION_COLUMNS,
  REPORT_TYPES,
  TYPE_COLUMNS,
  TYPE_META,
  beneficiaries,
  flatRows,
  isReportType,
  overviewText,
  reportFileStem,
  reportSubtitle,
  statusTone,
  summaryTiles,
  tilesText,
} from "./history-logic";

// What History & Reports shows for each of the seven types: who benefits, the tiles, the columns, and the flat CSV.

const qs = (query = "") => new URLSearchParams(query);
const report = reportOf(qs("period=today"));
const section = (type: (typeof REPORT_TYPES)[number]) => report.sections.find((s) => s.type === type)!;

describe("the types", () => {
  it("are the seven of the API, each with a label, a sheet name, a sentence on who benefits and its setting", () => {
    expect(REPORT_TYPES).toEqual([
      "ot_allowance",
      "ot_shift_relaxation",
      "ot_shift_pay",
      "window_late_in",
      "window_early_out",
      "holiday_work",
      "birthday",
    ]);
    for (const type of REPORT_TYPES) {
      const meta = TYPE_META[type];
      expect(meta.label.length).toBeGreaterThan(5);
      expect(meta.who.length).toBeGreaterThan(30);
      expect(meta.sheet.length).toBeLessThanOrEqual(31);
      expect(meta.sheet).not.toMatch(/[\\/?*[\]:]/);
      expect(meta.setting).toMatch(/^[a-z-]+$/);
    }
    // sheet names are unique, or Excel would refuse the workbook
    expect(new Set(REPORT_TYPES.map((t) => TYPE_META[t].sheet)).size).toBe(7);
    expect(isReportType("birthday")).toBe(true);
    expect(isReportType("all")).toBe(false);
  });
});

describe("the tiles of a section", () => {
  it("count the allowance: earned, used, did not need it, not yet worked", () => {
    const tiles = summaryTiles("ot_allowance", section("ot_allowance").summary);
    expect(tiles.map((t) => [t.key, t.value])).toEqual([
      ["earned", "2"],
      ["used", "1"],
      ["notUsed", "0"],
      ["pending", "1"],
      ["employees", "2"],
    ]);
    expect(tiles[0].sub).toBe("1 h 30 min allowed");
    expect(tiles[1].sub).toBe("18 min used");
  });

  it("count relaxation: records, shifts, applied, coming up, not applied", () => {
    const tiles = summaryTiles("ot_shift_relaxation", section("ot_shift_relaxation").summary);
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ["Records", "1"],
      ["Shifts given", "0.50"],
      ["Day off applied", "1"],
      ["Coming up", "0"],
      ["Not applied", "0"],
      ["Employees", "1"],
    ]);
  });

  it("show the payment amount, and the estimate separately", () => {
    const tiles = summaryTiles("ot_shift_pay", section("ot_shift_pay").summary);
    const amount = tiles.find((t) => t.key === "amount")!;
    expect(amount.value).toBe("₹0.00");
    expect(amount.sub).toBe("+ ₹450.00 estimated");
    expect(tiles.find((t) => t.key === "pendingPayroll")!.value).toBe("1");
    // no estimate, no second line
    expect(
      summaryTiles("ot_shift_pay", { amount: 900, estimatedAmount: 0 }).find((t) => t.key === "amount")!.sub,
    ).toBeUndefined();
  });

  it("count the company windows: announcements, staff covered, who used it", () => {
    for (const type of ["window_late_in", "window_early_out"] as const) {
      const tiles = summaryTiles(type, { announcements: 2, staffCovered: 400, used: 120, employees: 120 });
      expect(tiles.map((t) => [t.label, t.value])).toEqual([
        ["Announcements", "2"],
        ["Staff covered", "400"],
        ["Used it", "120"],
        ["Employees", "120"],
      ]);
    }
  });

  it("count the holiday work claims by where they stand, and what was redeemed", () => {
    const tiles = summaryTiles("holiday_work", section("holiday_work").summary);
    expect(tiles.map((t) => [t.key, t.value])).toEqual([
      ["claims", "1"],
      ["pending", "0"],
      ["approved", "1"],
      ["rejected", "0"],
      ["redeemedShifts", "0.50"],
      ["employees", "1"],
    ]);
    expect(tiles.find((t) => t.key === "approved")!.sub).toBe("1 shifts");
  });

  it("count the birthdays: marked, still to come, not marked", () => {
    const tiles = summaryTiles("birthday", section("birthday").summary);
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ["Birthdays", "1"],
      ["Marked", "1"],
      ["Still to come", "0"],
      ["Not marked", "0"],
      ["Shifts", "1"],
      ["Employees", "1"],
    ]);
  });

  it("read a missing figure as zero", () => {
    expect(summaryTiles("birthday", {}).every((t) => t.value === "0")).toBe(true);
  });

  it("read as one line for the Summary sheet", () => {
    expect(
      tilesText(summaryTiles("window_late_in", { announcements: 1, staffCovered: 214, used: 1, employees: 1 })),
    ).toBe("Announcements: 1; Staff covered: 214; Used it: 1; Employees: 1");
  });
});

describe("the columns", () => {
  it("every type has its own, and no two columns of a type share a key and a label", () => {
    for (const type of REPORT_TYPES) {
      const columns = TYPE_COLUMNS[type]();
      expect(columns.length).toBeGreaterThanOrEqual(6);
      const names = columns.map((c) => `${c.key}|${c.label}`);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("read the cells of an allowance row: the OT date, the allowance and where it was used", () => {
    const row = section("ot_allowance").rows[0];
    const cells = Object.fromEntries(TYPE_COLUMNS.ot_allowance().map((c) => [c.label, c.display(row)]));
    expect(cells).toMatchObject({
      "OT date": "13 Oct 2026",
      "Last punch": "7:00 PM",
      "Extra time (min)": "90",
      "Allowance (min)": "30",
      "Used on": "14 Oct 2026",
      "Minutes used": "18",
      "First punch": "9:48 AM",
      Status: "Used",
    });
  });

  it("read the extra time and the allowance from their own keys, and an older backend's `minutes` as a fallback", () => {
    const [first] = section("ot_allowance").rows;
    const allowance = Object.fromEntries(TYPE_COLUMNS.ot_allowance().map((c) => [c.label, c]));
    expect(allowance["Extra time (min)"].value!(first)).toBe(90);
    expect(allowance["Allowance (min)"].value!(first)).toBe(30);
    // an older backend sends neither key: the allowance is its `minutes`, and there is no extra time to show
    const older = { ...first, extraMinutes: undefined, allowanceMinutes: undefined };
    expect(allowance["Allowance (min)"].value!(older)).toBe(30);
    expect(allowance["Extra time (min)"].value!(older)).toBeNull();
    expect(allowance["Extra time (min)"].display(older)).toBe("—");
    // Type 2: the extra time, else `minutes`
    const pay = section("ot_shift_pay").rows[0];
    const shift = Object.fromEntries(TYPE_COLUMNS.ot_shift_pay().map((c) => [c.label, c]));
    expect(shift["Extra time (min)"].value!(pay)).toBe(240);
    expect(shift["Extra time (min)"].value!({ ...pay, extraMinutes: undefined })).toBe(240);
    expect(shift["Extra time (min)"].display({ ...pay, extraMinutes: 250 })).toBe("250");
  });

  it("export real values: ISO dates, numbers, and the money as a number", () => {
    const pay = section("ot_shift_pay").rows[0];
    const columns = Object.fromEntries(TYPE_COLUMNS.ot_shift_pay().map((c) => [c.label, c]));
    expect(columns["OT date"].value!(pay)).toBe("2026-10-05");
    expect(columns["OT date"].type).toBe("date");
    expect(columns["Amount (₹)"].value!(pay)).toBe(450);
    expect(columns["Amount (₹)"].type).toBe("money");
    expect(columns["Amount (₹)"].display(pay)).toBe("₹450.00 (estimate)");
    expect(columns["Amount is an estimate"].value!(pay)).toBe("Estimate");
    expect(columns["Shifts"].value!(pay)).toBe(0.5);
    expect(columns["Extra time (min)"].value!(pay)).toBe(240);
  });

  it("show the window time as a clock time and who announced it", () => {
    const row = section("window_late_in").rows[0];
    const cells = Object.fromEntries(TYPE_COLUMNS.window_late_in().map((c) => [c.label, c.display(row)]));
    expect(cells["Window time"]).toBe("10:30 AM");
    expect(cells["Announced by"]).toBe("Meena");
    expect(cells["Reason"]).toBe("Heavy rain");
  });

  it("show who raised and who approved a holiday work claim", () => {
    const row = section("holiday_work").rows[0];
    const cells = Object.fromEntries(TYPE_COLUMNS.holiday_work().map((c) => [c.label, c.display(row)]));
    expect(cells).toMatchObject({
      "Work date": "11 Oct 2026",
      Shifts: "1",
      "Raised by": "Meena",
      "Approved by": "Suresh Raj",
      "Decided on": "12 Oct 2026",
      Status: "Approved",
    });
  });

  it("show a dash for what a row does not have", () => {
    const row = { ...section("birthday").rows[0], firstPunch: null, shifts: null, status: null, statusLabel: null };
    const cells = Object.fromEntries(TYPE_COLUMNS.birthday().map((c) => [c.label, c.display(row)]));
    expect(cells["First punch"]).toBe("—");
    expect(cells["Shifts"]).toBe("—");
    expect(cells["Status"]).toBe("—");
  });

  it("start the sheets with who the row is about, and the redeemed balance has its own few", () => {
    expect(IDENTITY_COLUMNS().map((c) => c.label)).toEqual(["Code", "Name", "Department", "Designation", "Branch"]);
    expect(REDEMPTION_COLUMNS().map((c) => c.label)).toEqual([
      "Redeemed on",
      "Shifts",
      "Recorded by",
      "Recorded on",
      "Details",
    ]);
  });

  it("colour the statuses by what they mean", () => {
    expect(statusTone("used")).toBe("success");
    expect(statusTone("approved")).toBe("success");
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("rejected")).toBe("danger");
    expect(statusTone("not_applied")).toBe("caution");
    expect(statusTone("whatever")).toBe("neutral");
    expect(statusTone(null)).toBe("neutral");
  });
});

describe("the flat CSV and the file names", () => {
  it("has every row of every section, and the redeemed balance, with the type named", () => {
    const rows = flatRows(report);
    // 2 allowance + 1 relaxation + 1 pay + 1 late-in + 0 early-out + 1 holiday + 1 birthday + 1 redeemed
    expect(rows).toHaveLength(8);
    const type = CSV_COLUMNS.find((c) => c.key === "type")!;
    expect(rows.map((r) => type.value!(r))).toContain("Holiday / Sunday work");
    expect(rows.filter((r) => r.status === "redeemed")).toHaveLength(1);
  });

  it("covers every key the API sends on a row", () => {
    const keys = new Set(CSV_COLUMNS.map((c) => c.key));
    const missing = report.rowKeys.filter(
      (k) => !keys.has(k) && !["employeeId", "departmentId", "branchId", "employmentType", "status"].includes(k),
    );
    expect(missing).toEqual([]);
    expect(keys.has("statusLabel")).toBe(true);
  });

  it("is empty for a quiet day", () => {
    expect(flatRows(emptyReport(qs("period=today")))).toEqual([]);
  });

  it("names the file after the period", () => {
    expect(reportFileStem(report)).toBe("Compensation_Report_2026-10-14");
    expect(reportFileStem(reportOf(qs("period=week")))).toBe("Compensation_Report_2026-10-12_to_2026-10-18");
    expect(reportSubtitle(reportOf(qs("period=week")), ["Cutting", null])).toBe(
      "Compensation · 12 Oct - 18 Oct 2026 · Cutting",
    );
  });

  it("says how many people and records a section has", () => {
    expect(beneficiaries(section("ot_allowance"))).toBe(2);
    expect(overviewText(section("ot_allowance"))).toBe("2 employees · 2 records");
    expect(overviewText(section("birthday"))).toBe("1 employee · 1 record");
    expect(TODAY).toBe("2026-10-14");
  });
});
