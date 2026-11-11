import { describe, expect, it } from "vitest";
import { actionLabel, changesOf, showValue, toCsv, when } from "./logic";
import type { HrActivityRow } from "@/lib/api-client/custom-hooks";

const row = (patch: Partial<HrActivityRow>): HrActivityRow => ({
  id: 1,
  at: "2026-11-10T08:35:00Z",
  accountId: 4,
  username: "hr.priya",
  fullName: "Priya",
  action: "update",
  module: "payroll",
  moduleLabel: "Payroll",
  recordId: 12,
  description: "Changed in Payroll (PATCH /api/payroll/12)",
  oldValues: null,
  newValues: null,
  ...patch,
});

describe("assistant activity", () => {
  it("names the actions in plain words", () => {
    expect(actionLabel("approve")).toBe("Approved");
    expect(actionLabel("update")).toBe("Changed");
    expect(actionLabel("key_create")).toBe("key create");
  });

  it("shows values for people", () => {
    expect(showValue(true)).toBe("Yes");
    expect(showValue(null)).toBe("—");
    expect(showValue([1, "a"])).toBe("1, a");
    expect(showValue({ a: 1 })).toBe('{"a":1}');
  });

  it("reads what a generic row sent as the new values", () => {
    expect(changesOf(row({ newValues: { request: { bonus: 250 } } }))).toEqual([
      { field: "bonus", before: null, after: "250" },
    ]);
  });

  it("pairs old and new values a view logged", () => {
    expect(changesOf(row({ oldValues: { isActive: true }, newValues: { isActive: false } }))).toEqual([
      { field: "isActive", before: "Yes", after: "No" },
    ]);
    expect(changesOf(row({}))).toEqual([]);
  });

  it("formats the time without Intl month names", () => {
    expect(when(null)).toBe("—");
    expect(when("not a date")).toBe("—");
    expect(when("2026-11-10T08:35:00Z")).toMatch(/^\d\d (Nov|Oct) 2026, \d\d:\d\d$/);
  });

  it("exports the rows as CSV, quoting what needs it", () => {
    const csv = toCsv([row({ description: 'Approved "leave", Asha', newValues: { request: { bonus: 5 } } })]);
    const [header, line] = csv.split("\n");
    expect(header).toBe("When,Username,Name,Action,Module,Record,What,Changes");
    expect(line).toContain('"Approved ""leave"", Asha"');
    expect(line).toContain("bonus: 5");
    expect(line).toContain("Changed,Payroll,12");
  });
});
