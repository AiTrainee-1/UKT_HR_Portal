import { describe, expect, it } from "vitest";
import {
  COMPENSATION_BASE,
  COMPENSATION_PAGES,
  FIRST_PAGE_PATH,
  HISTORY_NESTED,
  HISTORY_SUBS,
  HISTORY_SUB_VALUES,
  LEAVE_NESTED,
  LEAVE_SUBS,
  LEAVE_SUB_LABEL,
  OT_NESTED,
  OT_SUBS,
  OT_SUB_LABEL,
  defaultNested,
  historyPath,
  historySubOfType,
  leavePath,
  legacyCompensationTarget,
  nestedOf,
  otPath,
  pagePath,
  subPath,
} from "./routes";
import { REPORT_TYPES } from "./history/history-logic";

// The addresses of Compensation: five pages with subtabs in the path, and where every old `?tab=...` address now goes.

describe("the pages", () => {
  it("are five, in the order of the sidebar, each under /hr/compensation", () => {
    expect(COMPENSATION_PAGES.map((p) => [p.label, pagePath(p.key)])).toEqual([
      ["CTC Breakdown", "/hr/compensation/ctc-breakdown"],
      ["OT Detection", "/hr/compensation/ot-detection"],
      ["Compensation Leave", "/hr/compensation/compensation-leave"],
      ["History", "/hr/compensation/history"],
      ["Reports", "/hr/compensation/reports"],
    ]);
    expect(FIRST_PAGE_PATH).toBe("/hr/compensation/ctc-breakdown");
    expect(COMPENSATION_BASE).toBe("/hr/compensation");
  });

  it("have subtabs in the order and with the labels the owner asked for", () => {
    expect(OT_SUBS.map((s) => OT_SUB_LABEL[s])).toEqual([
      "Type 1 · Late-in allowance",
      "Type 2 · Shift compensation",
      "Earlier records",
    ]);
    expect(LEAVE_SUBS.map((s) => LEAVE_SUB_LABEL[s])).toEqual([
      "A. Announce late-in / early-out",
      "B. Sunday & holiday work",
      "C. Birthdays",
    ]);
    expect(HISTORY_SUBS.map((s) => s.label)).toEqual([
      "OT allowance",
      "OT relaxation",
      "OT pay",
      "Company windows",
      "Holiday / Sunday work",
      "Birthday leave",
    ]);
  });

  it("build addresses down to the nested subtab, with an optional query string", () => {
    expect(otPath()).toBe("/hr/compensation/ot-detection/type-1/allowance");
    expect(otPath("type-2")).toBe("/hr/compensation/ot-detection/type-2/waiting");
    expect(otPath("type-2", "how")).toBe("/hr/compensation/ot-detection/type-2/how");
    expect(otPath("earlier")).toBe("/hr/compensation/ot-detection/earlier");
    expect(leavePath()).toBe("/hr/compensation/compensation-leave/announcements/announce");
    expect(leavePath("holiday-work")).toBe("/hr/compensation/compensation-leave/holiday-work/raise");
    expect(leavePath("holiday-work", "claims")).toBe("/hr/compensation/compensation-leave/holiday-work/claims");
    expect(leavePath("birthdays")).toBe("/hr/compensation/compensation-leave/birthdays/list");
    expect(historyPath()).toBe("/hr/compensation/history/ot-allowance");
    expect(historyPath("company-windows")).toBe("/hr/compensation/history/company-windows/late-in");
    expect(subPath("history", "ot-pay", "?period=week")).toBe("/hr/compensation/history/ot-pay?period=week");
    expect(subPath("history", "ot-pay", "period=week")).toBe("/hr/compensation/history/ot-pay?period=week");
    expect(subPath("history", "ot-pay", "")).toBe("/hr/compensation/history/ot-pay");
    expect(subPath("history", "company-windows", "period=week", "early-out")).toBe(
      "/hr/compensation/history/company-windows/early-out?period=week",
    );
  });
});

describe("the nested subtabs", () => {
  it("are the sections the owner named, in order", () => {
    expect(OT_NESTED["type-1"].map((n) => n.label)).toEqual(["Late-in allowance", "How it is worked out"]);
    expect(OT_NESTED["type-2"].map((n) => n.label)).toEqual([
      "Waiting for HR",
      "Assigned and rejected",
      "How the suggested shifts are worked out",
    ]);
    expect(LEAVE_NESTED.announcements.map((n) => n.value)).toEqual(["announce", "list"]);
    expect(LEAVE_NESTED["holiday-work"].map((n) => n.label)).toEqual([
      "Raise a claim",
      "Claims",
      "Compensation balance",
      "Earlier Alternative-Day credits",
    ]);
    expect(LEAVE_NESTED.birthdays.map((n) => n.value)).toEqual(["list", "how"]);
    expect(HISTORY_NESTED["company-windows"].map((n) => n.value)).toEqual(["late-in", "early-out"]);
    expect(HISTORY_NESTED["holiday-work"].map((n) => n.value)).toEqual(["work", "redeemed"]);
  });

  it("belong only to subtabs that exist", () => {
    for (const sub of Object.keys(OT_NESTED)) expect(OT_SUBS).toContain(sub);
    for (const sub of Object.keys(LEAVE_NESTED)) expect(LEAVE_SUBS).toContain(sub);
    for (const sub of Object.keys(HISTORY_NESTED)) expect(HISTORY_SUB_VALUES).toContain(sub);
    expect(nestedOf("ot", "earlier")).toEqual([]);
    expect(nestedOf("history", "ot-pay")).toEqual([]);
    expect(nestedOf("reports", "x")).toEqual([]);
    expect(nestedOf("ctc", "x")).toEqual([]);
  });

  it("have a first one that a bare subtab opens, and a section's filter opens that section", () => {
    expect(defaultNested("ot", "type-1")).toBe("allowance");
    expect(defaultNested("ot", "type-2")).toBe("waiting");
    expect(defaultNested("ot", "earlier")).toBeUndefined();
    expect(defaultNested("leave", "holiday-work")).toBe("raise");
    expect(defaultNested("leave", "holiday-work", "hstatus=all")).toBe("raise");
    expect(defaultNested("leave", "holiday-work", "hstatus=pending")).toBe("claims");
    expect(defaultNested("leave", "holiday-work", "hmonth=9&hyear=2026")).toBe("claims");
    expect(defaultNested("leave", "announcements", "hstatus=pending")).toBe("announce");
    expect(defaultNested("ot", "type-2", "otstatus=rejected")).toBe("assigned");
    expect(defaultNested("ot", "type-2", "otstatus=all")).toBe("waiting");
    expect(defaultNested("history", "company-windows")).toBe("late-in");
  });
});

describe("History's subtabs", () => {
  it("list every kind of record exactly once, the two company windows together", () => {
    const listed = HISTORY_SUBS.flatMap((s) => s.types);
    expect([...listed].sort()).toEqual([...REPORT_TYPES].sort());
    expect(new Set(HISTORY_SUB_VALUES).size).toBe(HISTORY_SUB_VALUES.length);
    expect(HISTORY_SUBS.find((s) => s.value === "company-windows")?.types).toEqual([
      "window_late_in",
      "window_early_out",
    ]);
  });

  it("find the subtab of a kind of record", () => {
    expect(historySubOfType("ot_allowance")).toBe("ot-allowance");
    expect(historySubOfType("window_early_out")).toBe("company-windows");
    expect(historySubOfType("holiday_work")).toBe("holiday-work");
    expect(historySubOfType("birthday")).toBe("birthday-leave");
    expect(historySubOfType("lunch")).toBeUndefined();
    expect(historySubOfType("all")).toBeUndefined();
  });
});

describe("the old ?tab= addresses", () => {
  const cases: [string, string][] = [
    ["", "/hr/compensation/ctc-breakdown"],
    ["?tab=ctc", "/hr/compensation/ctc-breakdown"],
    ["?tab=nonsense", "/hr/compensation/ctc-breakdown"],
    ["?tab=ot", "/hr/compensation/ot-detection/type-1/allowance"],
    ["?tab=ot&month=9&year=2026&otq=asha", "/hr/compensation/ot-detection/type-1/allowance?month=9&year=2026&otq=asha"],
    ["?tab=ot&otstatus=rejected", "/hr/compensation/ot-detection/type-2/assigned?otstatus=rejected"],
    ["?tab=ot&sub=type-2", "/hr/compensation/ot-detection/type-2/waiting"],
    ["?tab=ot&sub=earlier", "/hr/compensation/ot-detection/earlier"],
    ["?tab=leave", "/hr/compensation/compensation-leave/announcements/announce"],
    ["?tab=leave&sub=windows", "/hr/compensation/compensation-leave/announcements/announce"],
    ["?tab=leave&sub=holiday-work", "/hr/compensation/compensation-leave/holiday-work/raise"],
    [
      "?tab=leave&sub=holiday-work&hstatus=pending&hmonth=10&hyear=2026",
      "/hr/compensation/compensation-leave/holiday-work/claims?hstatus=pending&hmonth=10&hyear=2026",
    ],
    ["?tab=leave&sub=holiday_work", "/hr/compensation/compensation-leave/holiday-work/raise"],
    ["?tab=leave&sub=Holiday", "/hr/compensation/compensation-leave/holiday-work/raise"],
    ["?tab=leave&sub=birthdays&bperiod=week", "/hr/compensation/compensation-leave/birthdays/list?bperiod=week"],
    ["?tab=leave&sub=birthday", "/hr/compensation/compensation-leave/birthdays/list"],
    ["?tab=leave&sub=announce", "/hr/compensation/compensation-leave/announcements/announce"],
    ["?tab=leave&sub=nonsense", "/hr/compensation/compensation-leave/announcements/announce"],
    ["?tab=history", "/hr/compensation/history/ot-allowance"],
    ["?tab=history&period=week&dept=3", "/hr/compensation/history/ot-allowance?period=week&dept=3"],
    ["?tab=history&type=ot_shift_pay&period=month", "/hr/compensation/history/ot-pay?period=month"],
    ["?tab=history&type=window_late_in", "/hr/compensation/history/company-windows/late-in"],
    ["?tab=history&type=window_early_out", "/hr/compensation/history/company-windows/early-out"],
    ["?tab=history&type=holiday_work&period=week", "/hr/compensation/history/holiday-work/work?period=week"],
    ["?tab=history&type=all", "/hr/compensation/history/ot-allowance"],
    ["?tab=reports&type=birthday", "/hr/compensation/reports?type=birthday"],
    ["?tab=OT", "/hr/compensation/ot-detection/type-1/allowance"],
  ];

  it.each(cases)("%s -> %s", (search, target) => {
    expect(legacyCompensationTarget(search)).toBe(target);
    // the search arrives from the router without its "?" as well
    expect(legacyCompensationTarget(search.replace(/^\?/, ""))).toBe(target);
  });

  it("never sends an address to a page, subtab or nested subtab that does not exist", () => {
    const valid = new Set<string>([
      ...COMPENSATION_PAGES.map((p) => pagePath(p.key)),
      ...OT_SUBS.flatMap((s) => [otPath(s), ...nestedOf("ot", s).map((n) => otPath(s, n.value))]),
      ...LEAVE_SUBS.flatMap((s) => [leavePath(s), ...nestedOf("leave", s).map((n) => leavePath(s, n.value))]),
      ...HISTORY_SUB_VALUES.flatMap((s) => [
        historyPath(s),
        ...nestedOf("history", s).map((n) => historyPath(s, n.value)),
      ]),
    ]);
    for (const [search] of cases) {
      const path = legacyCompensationTarget(search).split("?")[0];
      expect(valid.has(path), `${search} -> ${path}`).toBe(true);
    }
  });
});
