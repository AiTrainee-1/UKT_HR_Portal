import { describe, expect, it } from "vitest";
import type { PayrollIssuesSummary } from "@/lib/api-client/custom-hooks";
import { addSkipped } from "./issue-summary";

const SUMMARY: PayrollIssuesSummary = {
  employees: 2,
  employeesWithIssues: 2,
  total: 16,
  bySeverity: { critical: 0, warning: 16, info: 0 },
  byCode: [
    { code: "absent", label: "Absent", severity: "warning", category: "attendance", count: 12 },
    { code: "bank_missing", label: "Bank details missing", severity: "warning", category: "profile", count: 2 },
    { code: "no_shift", label: "No shift assigned", severity: "warning", category: "rule", count: 2 },
  ],
  byDepartment: [{ department: "Stitching", count: 16 }],
};

describe("addSkipped", () => {
  it("adds the skipped employees to the total, the critical count, the people and the types", () => {
    const merged = addSkipped(SUMMARY, 3)!;
    expect(merged.total).toBe(19);
    expect(merged.employeesWithIssues).toBe(5);
    expect(merged.bySeverity).toEqual({ critical: 3, warning: 16, info: 0 });
    expect(merged.byCode[0]).toEqual({
      code: "skipped",
      label: "Skipped at generation",
      severity: "critical",
      category: "generation",
      count: 3,
    });
    expect(merged.byCode).toHaveLength(4);
    expect(merged.byDepartment).toEqual(SUMMARY.byDepartment);
  });

  it("does not touch the server's summary", () => {
    addSkipped(SUMMARY, 3);
    expect(SUMMARY.total).toBe(16);
    expect(SUMMARY.bySeverity.critical).toBe(0);
    expect(SUMMARY.byCode).toHaveLength(3);
  });

  it("leaves the summary alone when nobody was skipped, or when there is no summary yet", () => {
    expect(addSkipped(SUMMARY, 0)).toBe(SUMMARY);
    expect(addSkipped(undefined, 2)).toBeUndefined();
  });

  it("does not count them twice when the server already did", () => {
    const merged = addSkipped(SUMMARY, 1)!;
    expect(addSkipped(merged, 1)).toBe(merged);
  });
});
