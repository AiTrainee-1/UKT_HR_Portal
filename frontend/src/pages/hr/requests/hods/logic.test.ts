import { describe, expect, it } from "vitest";
import type { HodRow } from "@/lib/api-client/custom-hooks";
import { CATEGORIES, KUMAR, MEENA, RAVI, item } from "../fixtures";
import {
  DASH,
  NO_HOD_FILTERS,
  boardHeaders,
  boardRows,
  boardTotals,
  byOldest,
  categoryBreakdown,
  cellText,
  dayText,
  detailRows,
  filterHods,
  groupItems,
  hodFigures,
  hodFileStem,
  hodFiltersActive,
  matchesHod,
  requestsLabel,
  scopeText,
  serverHodParams,
  shareSummary,
  shortDay,
  sortHods,
  visibleCategories,
  waitingText,
  waitingTone,
} from "./logic";

const ROWS = [KUMAR, MEENA, RAVI];

describe("filters", () => {
  it("sends the branch and the department to the server, keeps the search and only-pending here", () => {
    expect(serverHodParams(NO_HOD_FILTERS)).toEqual({});
    expect(serverHodParams({ query: "x", branch: "2", department: "5", onlyPending: true })).toEqual({
      branchId: "2",
      departmentId: "5",
    });
    expect(hodFiltersActive(NO_HOD_FILTERS)).toBe(false);
    expect(hodFiltersActive({ ...NO_HOD_FILTERS, onlyPending: true })).toBe(true);
    expect(hodFiltersActive({ ...NO_HOD_FILTERS, query: "  " })).toBe(false);
  });

  it("finds a head by name, code, department, or by who is waiting on them", () => {
    expect(matchesHod(RAVI, "ravi")).toBe(true);
    expect(matchesHod(RAVI, "stitching m001")).toBe(true);
    expect(matchesHod(RAVI, "chitra")).toBe(true); // a missing punch of Chitra waits for Ravi
    expect(matchesHod(MEENA, "chitra")).toBe(false);
    expect(matchesHod(KUMAR, "")).toBe(true);
  });

  it("puts the most pending first, then by name, and filters on top", () => {
    expect(sortHods(ROWS).map((r) => r.name)).toEqual(["Ravi Shankar", "Meena Rani", "Kumar Vel"]);
    const tie: HodRow = { ...MEENA, managerId: 9, name: "Abi" };
    expect(sortHods([MEENA, tie]).map((r) => r.name)).toEqual(["Abi", "Meena Rani"]);
    expect(filterHods(ROWS, { ...NO_HOD_FILTERS, onlyPending: true }).map((r) => r.managerId)).toEqual([1, 2]);
    expect(filterHods(ROWS, { ...NO_HOD_FILTERS, query: "finishing" }).map((r) => r.managerId)).toEqual([2]);
  });
});

describe("figures and totals", () => {
  it("counts the heads, those with something pending, the requests, and the oldest wait", () => {
    expect(hodFigures(ROWS)).toEqual({
      hods: 3,
      withPending: 2,
      pending: 5,
      oldest: { managerId: 1, name: "Ravi Shankar", days: 8, label: "Missing Punch" },
    });
    expect(hodFigures([KUMAR]).oldest).toBeNull();
    expect(hodFigures([])).toEqual({ hods: 0, withPending: 0, pending: 0, oldest: null });
  });

  it("totals each category over the heads shown, null when none of them may decide it", () => {
    const t = boardTotals(ROWS, CATEGORIES);
    expect(t.pending).toBe(5);
    expect(t.byCategory.leave).toBe(2);
    expect(t.byCategory.casual_leave).toBe(1); // only Meena may approve casual leave
    expect(boardTotals([RAVI, KUMAR], CATEGORIES).byCategory.casual_leave).toBeNull();
    expect(cellText(null)).toBe(DASH);
    expect(cellText(undefined)).toBe(DASH);
    expect(cellText(0)).toBe("0");
  });

  it("keeps only the kinds with something pending among the heads shown", () => {
    const pendingIn = (rows: HodRow[]) =>
      CATEGORIES.filter((c) => rows.some((r) => (r.byCategory[c.key] ?? 0) > 0)).map((c) => c.key);
    const keys = visibleCategories([RAVI, KUMAR], CATEGORIES).map((c) => c.key);
    expect(keys).toEqual(pendingIn([RAVI, KUMAR]));
    expect(keys.length).toBeGreaterThan(0);
    // a kind every head has at 0 (or may not decide) has no column
    for (const c of CATEGORIES) {
      if (![RAVI, KUMAR].some((r) => (r.byCategory[c.key] ?? 0) > 0)) expect(keys).not.toContain(c.key);
    }
    // nothing pending at all: no category column
    const none: HodRow = { ...KUMAR, pending: 0, byCategory: { leave: 0, permission: null } };
    expect(visibleCategories([none], CATEGORIES)).toEqual([]);
    expect(visibleCategories([], CATEGORIES)).toEqual([]);
  });
});

describe("time words", () => {
  it("says how long something has waited, and how loudly", () => {
    expect(waitingText(null)).toBe(DASH);
    expect(waitingText(0)).toBe("today");
    expect(waitingText(1)).toBe("1 day");
    expect(waitingText(9)).toBe("9 days");
    expect(waitingTone(null)).toBe("neutral");
    expect(waitingTone(2)).toBe("neutral");
    expect(waitingTone(3)).toBe("warning");
    expect(waitingTone(7)).toBe("danger");
  });

  it("writes dates the reminder's way", () => {
    expect(dayText(new Date(2026, 10, 4))).toBe("04 Nov 2026");
    expect(shortDay(new Date(2026, 9, 27, 10).toISOString())).toBe("27 Oct");
    expect(shortDay(null)).toBe("");
    expect(shortDay("nope")).toBe("");
    expect(hodFileStem(new Date(2026, 10, 4))).toBe("hod-pending-approvals-2026-11-04");
  });
});

describe("the drill-down", () => {
  it("groups a head's requests in the board's category order, each oldest first", () => {
    const groups = groupItems(RAVI.items, CATEGORIES);
    expect(groups.map((g) => g.key)).toEqual(["leave", "permission", "missing_punch"]);
    expect(groups[0].items.map((i) => i.id)).toEqual([12, 14]);
    expect(groups[0].label).toBe("Leave");
  });

  it("puts a category the board does not know last, and a request without a time after the dated ones", () => {
    const odd = item({ category: "zzz", categoryLabel: "Something", id: 99 });
    const undated = item({ id: 50, raisedAt: null, waitingDays: null });
    const groups = groupItems([odd, undated, item()], CATEGORIES);
    expect(groups.map((g) => g.key)).toEqual(["leave", "zzz"]);
    expect(groups[0].items.map((i) => i.id)).toEqual([12, 50]);
    expect(groups[1].label).toBe("Something");
    expect([undated, item()].sort(byOldest).map((i) => i.id)).toEqual([12, 50]);
  });
});

describe("words for the summary and the exports", () => {
  it("names a category the reminder's way", () => {
    expect(requestsLabel("Leave")).toBe("Leave Requests");
    expect(requestsLabel("Missing Punch Requests")).toBe("Missing Punch Requests");
    expect(requestsLabel("Other request")).toBe("Other request");
    expect(categoryBreakdown(RAVI, CATEGORIES)).toBe("Leave 2, Permission 1, Missing Punch 1");
    expect(categoryBreakdown(KUMAR, CATEGORIES)).toBe("");
  });

  it("writes the WhatsApp summary: figures, then each head with something pending", () => {
    const text = shareSummary(ROWS, CATEGORIES, new Date(2026, 10, 4), "Branch: Head Office");
    expect(text.split("\n")).toEqual([
      "*Pending approvals with HoDs* - 04 Nov 2026",
      "Branch: Head Office",
      "3 HoDs · 2 with pending · 5 requests waiting",
      "",
      "1. *Ravi Shankar* (Cutting, Stitching): 4 · oldest 8 days",
      "   Leave 2, Permission 1, Missing Punch 1",
      "2. *Meena Rani* (Finishing): 1 · oldest 1 day",
      "   Casual Leave 1",
    ]);
    expect(shareSummary([KUMAR], CATEGORIES, new Date(2026, 10, 4))).toContain("Nothing is pending with any HoD.");
    expect(shareSummary([KUMAR], CATEGORIES, new Date(2026, 10, 4))).toContain("1 HoD · 0 with pending · 0 requests");
  });

  it("says what narrows the board", () => {
    expect(scopeText(NO_HOD_FILTERS, {})).toBe("");
    expect(scopeText({ query: " ravi ", branch: "2", department: "5", onlyPending: true }, { branch: "Unit 1" })).toBe(
      "Branch: Unit 1 · Department: 5 · Search: ravi · Only HoDs with pending",
    );
  });

  it("lays out the board for Excel: a row per head, a dash for not allowed, the totals row last", () => {
    const cats = CATEGORIES.slice(0, 3);
    expect(boardHeaders(cats)).toEqual([
      "#",
      "HoD",
      "Code",
      "Designation",
      "Departments",
      "Branch",
      "Leave",
      "Permission",
      "Casual Leave",
      "Total",
      "Oldest waiting (days)",
    ]);
    const rows = boardRows([RAVI, KUMAR], cats);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([
      1,
      "Ravi Shankar",
      "M001",
      "Production Manager",
      "Cutting, Stitching",
      "Head Office",
      2,
      1,
      DASH,
      4,
      8,
    ]);
    expect(rows[1].slice(-2)).toEqual([0, ""]);
    expect(rows[2]).toEqual(["", "Total", "", "", "", "", 2, 1, DASH, 4, ""]);
  });

  it("lists every pending request, head by head, oldest first", () => {
    const rows = detailRows([MEENA, RAVI], CATEGORIES);
    expect(rows.map((r) => [r[0], r[2], r[4]])).toEqual([
      ["Ravi Shankar", "Leave", "Asha Kumar"],
      ["Ravi Shankar", "Leave", "Asha Kumar"],
      ["Ravi Shankar", "Permission", "Bala Murugan"],
      ["Ravi Shankar", "Missing Punch", "Chitra Devi"],
      ["Meena Rani", "Casual Leave", "Divya S"],
    ]);
    expect(rows[0][9]).toBe(3);
    expect(rows[3][6]).toBe("27 Oct 2026");
  });
});
