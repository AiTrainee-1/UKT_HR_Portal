import { describe, expect, it } from "vitest";
import { HODS, hod, item } from "./fixtures";
import {
  agoText,
  approvalWarning,
  filterByGroup,
  groupOptions,
  hodIdFromPath,
  hodLabel,
  pageCount,
  pageNumbers,
  pageRangeText,
  pageSlice,
  pickHod,
  rightsOff,
  stepName,
  whenText,
} from "./logic";

describe("HOD approvals helpers", () => {
  it("reads the Department Head from the address", () => {
    expect(hodIdFromPath("/md/approvals/12")).toBe(12);
    expect(hodIdFromPath("/md/approvals/12/")).toBe(12);
    expect(hodIdFromPath("/MD/Approvals/7?x=1")).toBe(7);
    expect(hodIdFromPath("/md/approvals")).toBeNull();
    expect(hodIdFromPath("/md/approvals/abc")).toBeNull();
  });

  it("shows the head in the address while they are listed, else the first one", () => {
    expect(pickHod(HODS.hods, 8)?.id).toBe(8);
    expect(pickHod(HODS.hods, 999)?.id).toBe(5);
    expect(pickHod(HODS.hods, null)?.id).toBe(5);
    expect(pickHod([], 5)).toBeUndefined();
  });

  it("names a tab 'HOD – name'", () => {
    expect(hodLabel(hod())).toBe("HOD – Sandhya Krishnan");
  });

  it("filters by type and counts each type for the pills", () => {
    const items = [item(), item({ key: "p", group: "permission" }), item({ key: "o", group: "other" })];
    expect(filterByGroup(items, "all")).toHaveLength(3);
    expect(filterByGroup(items, "permission").map((i) => i.key)).toEqual(["p"]);
    expect(groupOptions({ leave: 2, permission: 0, other: 5, total: 7 }).map((o) => o.label)).toEqual([
      "All (7)",
      "Leave (2)",
      "Permission (0)",
      "Other (5)",
    ]);
  });

  it("lists the kinds switched off for a head", () => {
    expect(rightsOff(HODS.hods[1])).toEqual(["missing punch"]);
    expect(rightsOff(hod())).toEqual([]);
  });

  it("writes dates, ages and steps in plain words", () => {
    expect(whenText({ from: "2026-11-12", to: "2026-11-13" })).toBe("12 Nov 2026 – 13 Nov 2026");
    expect(whenText({ from: "2026-11-12", to: null })).toBe("12 Nov 2026");
    expect(whenText({ from: null, to: null })).toBe("");
    const now = new Date(2026, 10, 14, 12, 0);
    expect(agoText(new Date(2026, 10, 14, 9, 0).toISOString(), now)).toBe("today");
    expect(agoText(new Date(2026, 10, 13, 9, 0).toISOString(), now)).toBe("yesterday");
    expect(agoText(new Date(2026, 10, 10, 9, 0).toISOString(), now)).toBe("4 days ago");
    expect(agoText(new Date(2026, 9, 10, 9, 0).toISOString(), now)).toBe("5 weeks ago");
    expect(agoText(null, now)).toBe("");
    expect(stepName({ label: null, roles: ["hod", "hr"] })).toBe("Department Head or HR");
    expect(stepName({ label: "Final check", roles: ["hr"] })).toBe("Final check");
  });

  it("warns before approving a resignation that may be the last step", () => {
    expect(approvalWarning(item())).toBeNull();
    const last = item({
      kind: "resignation",
      steps: [{ label: null, roles: ["hod"], state: "pending", by: null, at: null, comment: null }],
    });
    expect(approvalWarning(last)).toMatch(/inactive/);
    const withHr = item({
      kind: "resignation",
      steps: [
        { label: null, roles: ["hod"], state: "pending", by: null, at: null, comment: null },
        { label: null, roles: ["hr"], state: "waiting", by: null, at: null, comment: null },
      ],
    });
    expect(approvalWarning(withHr)).toMatch(/HR still has to approve/);
  });

  it("cuts the list into pages of 10 and numbers the pages", () => {
    const rows = Array.from({ length: 23 }, (_, i) => i + 1);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(23)).toBe(3);
    expect(pageSlice(rows, 1)).toEqual(rows.slice(0, 10));
    expect(pageSlice(rows, 3)).toEqual([21, 22, 23]);
    expect(pageSlice(rows, 9)).toEqual([21, 22, 23]); // past the end: the last page
    expect(pageRangeText(23, 2)).toBe("Showing 11–20 of 23");
    expect(pageRangeText(0, 1)).toBe("Nothing to show");
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(1, 12)).toEqual([1, 2, 3, 4, "…", 12]);
    expect(pageNumbers(6, 12)).toEqual([1, "…", 5, 6, 7, "…", 12]);
    expect(pageNumbers(12, 12)).toEqual([1, "…", 9, 10, 11, 12]);
  });
});
