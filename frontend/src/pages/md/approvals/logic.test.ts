import { describe, expect, it } from "vitest";
import { HODS, hod, item } from "./fixtures";
import {
  agoText,
  approvalWarning,
  decisionOf,
  filterItems,
  inMonth,
  kindOptions,
  overviewOf,
  requestDayText,
  requestedLabel,
  requestedText,
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
  submittedText,
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
    expect(submittedText("2026-11-11T09:52:00")).toBe("11 Nov 2026, 9:52:00 am");
    expect(submittedText("2026-11-11T15:05:30")).toBe("11 Nov 2026, 3:05:30 pm");
    expect(submittedText(null)).toBe("");
    expect(submittedText("not a date")).toBe("");
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

  it("says what a request is for, as the HR Requests page does", () => {
    expect(requestDayText("2026-11-11T09:52:00")).toBe("11 Nov 2026");
    expect(requestedLabel(item())).toBe("Requested dates");
    expect(requestedText(item())).toBe("12 Nov 2026 – 13 Nov 2026 · 2 days");
    expect(requestedText(item({ requested: null }))).toBeNull();
    // an older server without `requested`: the item's own dates
    expect(requestedText(item({ requested: undefined }))).toBe("12 Nov 2026 – 13 Nov 2026");
    expect(requestedLabel(item({ requested: undefined }))).toBe("Requested date");
  });

  it("finds the decision and its remark", () => {
    expect(decisionOf(item())).toBeNull();
    const rejected = item({
      state: "rejected",
      steps: [
        { label: null, roles: ["hod"], state: "rejected", by: "Sandhya", at: "2026-11-12T10:00:00", comment: "No" },
      ],
    });
    expect(decisionOf(rejected)).toEqual({
      state: "rejected",
      by: "Sandhya",
      at: "2026-11-12T10:00:00",
      comment: "No",
    });
    const approved = item({
      state: "approved",
      steps: [
        { label: null, roles: ["hod"], state: "approved", by: "Sandhya", at: "2026-11-12T10:00:00", comment: null },
      ],
    });
    expect(decisionOf(approved)?.state).toBe("approved");
  });

  it("filters by month (the dates asked for, else the day it was sent), type and search", () => {
    const across = item({ requested: { from: "2026-10-30", to: "2026-11-02", note: null, label: "Requested dates" } });
    expect(inMonth(across, "2026-10")).toBe(true);
    expect(inMonth(across, "2026-11")).toBe(true);
    expect(inMonth(across, "2026-12")).toBe(false);
    expect(inMonth(item({ requested: null, submittedAt: "2026-09-03T08:00:00" }), "2026-09")).toBe(true);
    expect(inMonth(item(), null)).toBe(true);
    const list = [item(), item({ key: "permission-1", kind: "permission", reason: "Bank work" })];
    expect(filterItems(list, { kind: "permission", month: null, q: "" })).toHaveLength(1);
    expect(filterItems(list, { kind: "all", month: null, q: "bank" })).toHaveLength(1);
    expect(filterItems(list, { kind: "all", month: null, q: "surya 30020" })).toHaveLength(2);
    expect(kindOptions(list).map((o) => o.label)).toEqual(["All (2)", "Leave (1)", "Permission (1)"]);
    expect(kindOptions([], "resignation").map((o) => o.label)).toEqual(["All (0)", "Resignation (0)"]);
  });

  it("sums up a head's month", () => {
    const now = new Date(2026, 10, 21, 12, 0);
    const list = [
      item({ submittedAt: new Date(2026, 10, 18, 9, 0).toISOString() }),
      item({
        key: "leave-2",
        state: "approved",
        canApprove: false,
        canReject: false,
        submittedAt: new Date(2026, 10, 10, 9, 0).toISOString(),
        steps: [
          {
            label: null,
            roles: ["hod"],
            state: "approved",
            by: "S",
            at: new Date(2026, 10, 12, 9, 0).toISOString(),
            comment: null,
          },
        ],
      }),
      item({
        key: "leave-3",
        state: "rejected",
        canApprove: false,
        canReject: false,
        requested: { from: "2026-10-05", to: null, note: null, label: "Requested date" },
      }),
    ];
    const nov = overviewOf(list, "2026-11", now);
    expect(nov.received).toBe(2);
    expect(nov.approved).toBe(1);
    expect(nov.rejected).toBe(0);
    expect(nov.open).toBe(1);
    expect(nov.approvalRatePct).toBe(100);
    expect(nov.avgDecisionDays).toBe(2);
    expect(nov.oldestWaitingDays).toBe(3);
    expect(nov.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(nov.months.at(-1)).toMatchObject({ received: 2, decided: 1 });
    expect(overviewOf(list, null, now).received).toBe(3);
  });
});
