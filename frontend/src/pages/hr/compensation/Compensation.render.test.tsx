import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  freezeClock,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  nestedLabels,
  nestedTab,
  params,
  q,
  tab,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// Compensation in jsdom, with a fake server behind customFetch: the five pages, each with its own address and heading, the
// bare addresses that redirect to the first subtab, the old `?tab=` addresses that redirect to the new paths with their
// other parameters, the switch-off notice of the master switch, and the CTC Breakdown page, which the overhaul left exactly
// as it was.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { branchId?: number | null } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: h.user.current }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  world = installWorld(h.fetch);
});

afterEach(async () => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
  // the CTC Breakdown page (unchanged) leaves a 300 ms search debounce running; let it fire before the next test
  await new Promise((resolve) => setTimeout(resolve, 320));
});

const headings = () => [...document.body.querySelectorAll("h2")].map(text);
const pathname = () => window.location.pathname;
const subtabLabels = (testId: string) =>
  [...document.body.querySelectorAll(`[data-testid="${testId}"] [role="tab"]`)].map((t) =>
    text(t.querySelector(".ptab-label")).replace(/\(\d+\)$/, ""),
  );

describe("the five pages", () => {
  it("CTC Breakdown: its own heading, the CTC rows, no pill-tab strip and no subtabs", async () => {
    mountPage("/hr/compensation/ctc-breakdown");
    expect(headings()).toEqual(["CTC Breakdown"]);
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(text(q("ctc-summary"))).toContain("1 employee");
    // the old four-tab strip is gone: nothing on this page is a tab named after another page
    for (const old of ["OT Detection", "Compensation Leave", "History & Reports"]) expect(tab(old)).toBeUndefined();
    expect(q("ot-tab")).toBeNull();
  });

  it("OT Detection: its own heading, the tiles and the filter bar, and the first subtab", async () => {
    mountPage("/hr/compensation/ot-detection/type-1");
    expect(headings()).toEqual(["OT Detection"]);
    await waitFor(() => !!q("ot-kpis"), "OT Detection");
    expect(q("ot-search")).not.toBeNull();
    expect(q("ot-type1")).not.toBeNull();
    expect(pathname()).toBe("/hr/compensation/ot-detection/type-1/allowance");
    expect(subtabLabels("ot-subtabs")).toEqual([
      "Type 1 · Late-in allowance",
      "Type 2 · Shift compensation",
      "Earlier records",
    ]);
    // the second level: one tab per section of Type 1
    expect(nestedLabels("ot-type1-nested")).toEqual(["Late-in allowance (2)", "How it is worked out"]);
  });

  it("Compensation Leave: its own heading and its three subtabs", async () => {
    mountPage("/hr/compensation/compensation-leave/announcements");
    expect(headings()).toEqual(["Compensation Leave"]);
    await waitFor(() => !!q("windows-part"), "the announcements");
    expect(subtabLabels("leave-subtabs")).toEqual([
      "A. Announce late-in / early-out",
      "B. Sunday & holiday work",
      "C. Birthdays",
    ]);
  });

  it("Compensation Leave: Sunday & holiday work has a nested subtab per section and shows only the open one", async () => {
    mountPage("/hr/compensation/compensation-leave/holiday-work");
    await waitFor(() => !!q("holiday-part"), "the Sunday / holiday work part");
    expect(tab("B. Sunday & holiday work").getAttribute("aria-selected")).toBe("true");
    expect(pathname()).toBe("/hr/compensation/compensation-leave/holiday-work/raise");
    expect(nestedLabels("holiday-nested").map((l) => l.replace(/ \(\d+\)$/, ""))).toEqual([
      "Raise a claim",
      "Claims",
      "Compensation balance",
      "Earlier Alternative-Day credits",
    ]);
    expect(q("claim-form")).not.toBeNull();
    expect(q("claim-list")).toBeNull();
    expect(q("balance-part")).toBeNull();
    expect(q("credits-card")).toBeNull();
    expect(q("windows-part")).toBeNull();
  });

  it("Compensation Leave: Birthdays", async () => {
    mountPage("/hr/compensation/compensation-leave/birthdays");
    await waitFor(() => !!q("birthdays-part"), "the Birthdays part");
    expect(q("holiday-part")).toBeNull();
    expect(pathname()).toBe("/hr/compensation/compensation-leave/birthdays/list");
  });

  it("History: its own heading, the six subtabs and the filters above them", async () => {
    mountPage("/hr/compensation/history/ot-allowance");
    expect(headings()).toEqual(["History"]);
    await waitFor(() => !!q("history-range"), "History");
    expect(subtabLabels("history-subtabs")).toEqual([
      "OT allowance",
      "OT relaxation",
      "OT pay",
      "Company windows",
      "Holiday / Sunday work",
      "Birthday leave",
    ]);
    expect(q("history-period")).not.toBeNull();
  });

  it("Reports: its own heading, the totals and the overview, no subtabs", async () => {
    mountPage("/hr/compensation/reports");
    expect(headings()).toEqual(["Reports"]);
    await waitFor(() => !!q("reports-kpis"), "Reports");
    expect(q("reports-overview")).not.toBeNull();
    expect(document.body.querySelector('[data-testid$="-subtabs"]')).toBeNull();
  });

  it("each page has exactly one heading, and none of them is called Compensation", async () => {
    for (const path of [
      "/hr/compensation/ctc-breakdown",
      "/hr/compensation/ot-detection/type-2",
      "/hr/compensation/compensation-leave/birthdays",
      "/hr/compensation/history/ot-pay",
      "/hr/compensation/reports",
    ]) {
      mountPage(path);
      expect(headings(), path).toHaveLength(1);
      expect(headings()[0], path).not.toBe("Compensation");
      await new Promise((resolve) => setTimeout(resolve, 340));
      unmountPage();
    }
  });
});

describe("the bare addresses", () => {
  it("send /hr/compensation to CTC Breakdown, replacing the entry", async () => {
    mountPage("/hr/compensation");
    expect(pathname()).toBe("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
  });

  it("send each page with subtabs to its first subtab and its first nested subtab, with the query string kept", async () => {
    const cases: [string, string][] = [
      ["/hr/compensation/ot-detection?month=9&year=2026", "/hr/compensation/ot-detection/type-1/allowance"],
      ["/hr/compensation/ot-detection/type-2?month=9", "/hr/compensation/ot-detection/type-2/waiting"],
      ["/hr/compensation/ot-detection/type-2/bogus?month=9", "/hr/compensation/ot-detection/type-2/waiting"],
      ["/hr/compensation/ot-detection/earlier?month=9", "/hr/compensation/ot-detection/earlier"],
      [
        "/hr/compensation/compensation-leave?bperiod=week",
        "/hr/compensation/compensation-leave/announcements/announce",
      ],
      [
        "/hr/compensation/compensation-leave/holiday-work?hdate=2026-10-11",
        "/hr/compensation/compensation-leave/holiday-work/raise",
      ],
      [
        "/hr/compensation/compensation-leave/holiday-work/nonsense?hdate=2026-10-11",
        "/hr/compensation/compensation-leave/holiday-work/raise",
      ],
      [
        "/hr/compensation/compensation-leave/birthdays?bperiod=week",
        "/hr/compensation/compensation-leave/birthdays/list",
      ],
      ["/hr/compensation/history?period=week", "/hr/compensation/history/ot-allowance"],
      ["/hr/compensation/history/company-windows?period=week", "/hr/compensation/history/company-windows/late-in"],
      ["/hr/compensation/history/holiday-work/x?period=week", "/hr/compensation/history/holiday-work/work"],
    ];
    for (const [from, to] of cases) {
      mountPage(from);
      expect(pathname(), from).toBe(to);
      expect(window.location.search, from).toBe(from.slice(from.indexOf("?")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      unmountPage();
    }
  });

  it("send an unknown subtab, and an unknown page, to the first", async () => {
    mountPage("/hr/compensation/ot-detection/nonsense?otq=asha");
    expect(pathname()).toBe("/hr/compensation/ot-detection/type-1/allowance");
    expect(params()).toEqual({ otq: "asha" });
    await waitFor(() => !!q("ot-kpis"), "OT Detection");
    unmountPage();

    mountPage("/hr/compensation/nonsense");
    expect(pathname()).toBe("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
  });

  it("keep a full address as it is, nested subtab and all", async () => {
    mountPage("/hr/compensation/ot-detection/type-2/assigned?otstatus=rejected");
    expect(here()).toBe("/hr/compensation/ot-detection/type-2/assigned?otstatus=rejected");
    await waitFor(() => !!q("ot-kpis"), "OT Detection");
    expect(nestedTab("ot-type2-nested", "assigned").getAttribute("aria-selected")).toBe("true");
  });

  it("open the section a section's filter belongs to, when a bare subtab arrives with it", async () => {
    mountPage("/hr/compensation/compensation-leave/holiday-work?hstatus=pending&hmonth=10&hyear=2026");
    expect(here()).toBe("/hr/compensation/compensation-leave/holiday-work/claims?hstatus=pending&hmonth=10&hyear=2026");
    await waitFor(() => !!q("claim-list"), "the claims");
    unmountPage();
    mountPage("/hr/compensation/ot-detection/type-2?otstatus=rejected");
    expect(here()).toBe("/hr/compensation/ot-detection/type-2/assigned?otstatus=rejected");
    await waitFor(() => !!q("ot-type2-assigned"), "the assigned list");
  });
});

describe("the old ?tab= addresses", () => {
  it("?tab=ctc and an unknown tab open CTC Breakdown", async () => {
    mountPage("/hr/compensation?tab=ctc");
    expect(here()).toBe("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    unmountPage();
    mountPage("/hr/compensation?tab=nonsense");
    expect(here()).toBe("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
  });

  it("?tab=ot opens OT Detection, Type 1, with its filters", async () => {
    mountPage("/hr/compensation?tab=ot&month=9&year=2026&otq=asha");
    await waitFor(() => !!q("ot-kpis"), "OT Detection");
    expect(pathname()).toBe("/hr/compensation/ot-detection/type-1/allowance");
    expect(params()).toEqual({ month: "9", year: "2026", otq: "asha" });
  });

  it("?tab=leave&sub=holiday-work (the Requests hub link) opens Sunday & holiday work, on Claims when it carries a claim filter", async () => {
    mountPage("/hr/compensation?tab=leave&sub=holiday-work&hstatus=pending&hmonth=10&hyear=2026");
    await waitFor(() => !!q("holiday-part"), "the Sunday / holiday work part");
    expect(pathname()).toBe("/hr/compensation/compensation-leave/holiday-work/claims");
    expect(params()).toEqual({ hstatus: "pending", hmonth: "10", hyear: "2026" });
    expect(tab("B. Sunday & holiday work").getAttribute("aria-selected")).toBe("true");
    expect(nestedTab("holiday-nested", "claims").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => !!q("claim-list"), "the claims");
    expect(q("claim-form")).toBeNull();
    expect(q("balance-part")).toBeNull();
    unmountPage();
    // with no claim filter it opens the first section
    mountPage("/hr/compensation?tab=leave&sub=holiday-work");
    await waitFor(() => !!q("claim-form"), "the claim form");
    expect(pathname()).toBe("/hr/compensation/compensation-leave/holiday-work/raise");
  });

  it("reads the other spellings of a part, and opens A for one it does not know", async () => {
    mountPage("/hr/compensation?tab=leave&sub=holiday_work");
    await waitFor(() => !!q("holiday-part"), "the Sunday / holiday work part");
    unmountPage();
    mountPage("/hr/compensation?tab=leave&sub=birthday");
    await waitFor(() => !!q("birthdays-part"), "the Birthdays part");
    unmountPage();
    mountPage("/hr/compensation?tab=leave&sub=nonsense");
    await waitFor(() => !!q("windows-part"), "the first part");
    expect(pathname()).toBe("/hr/compensation/compensation-leave/announcements/announce");
    unmountPage();
    mountPage("/hr/compensation?tab=leave");
    await waitFor(() => !!q("windows-part"), "the first part");
  });

  it("?tab=history opens History, and its old type filter picks the subtab", async () => {
    mountPage("/hr/compensation?tab=history&period=week&dept=3");
    await waitFor(() => !!q("history-range"), "History");
    expect(pathname()).toBe("/hr/compensation/history/ot-allowance");
    expect(params()).toEqual({ period: "week", dept: "3" });
    unmountPage();

    mountPage("/hr/compensation?tab=history&type=holiday_work&period=month");
    await waitFor(() => !!q("history-range"), "History");
    expect(pathname()).toBe("/hr/compensation/history/holiday-work/work");
    expect(params()).toEqual({ period: "month" });
    expect(tab("Holiday / Sunday work").getAttribute("aria-selected")).toBe("true");
    unmountPage();

    // each company window opens on its own nested subtab
    mountPage("/hr/compensation?tab=history&type=window_early_out");
    await waitFor(() => !!q("history-range"), "History");
    expect(pathname()).toBe("/hr/compensation/history/company-windows/early-out");
    expect(nestedTab("history-nested", "early-out").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the master switch", () => {
  it("shows no notice while the features are on", async () => {
    mountPage("/hr/compensation/ot-detection/type-1");
    await waitFor(() => !!q("ot-kpis"), "the page");
    expect(q("compensation-features-off")).toBeNull();
  });

  it("says what is paused and links to the switch, while everything stays readable", async () => {
    world.settings.compensationFeatureEnabled = false;
    mountPage("/hr/compensation/ot-detection/type-1");
    await waitFor(() => !!q("compensation-features-off"), "the notice");
    const notice = q("compensation-features-off")!;
    expect(text(notice)).toContain("The OT and Compensation features are switched off");
    expect(text(notice)).toContain("This page and every record on it stay available");
    expect(text(notice)).toContain(
      "assigning OT, announcing, raising Sunday / holiday claims and redeeming the balance are paused",
    );
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=payroll#compensation-features");
    // the subtabs still open
    click(tab("Type 2"));
    expect(tab("Type 2").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => !!q("ot-type2"), "Type 2");
    expect(pathname()).toBe("/hr/compensation/ot-detection/type-2/waiting");
    expect(q("compensation-features-off")).not.toBeNull();
  });

  it("shows the notice on every page except CTC Breakdown", async () => {
    world.settings.compensationFeatureEnabled = false;
    for (const path of [
      "/hr/compensation/ot-detection/type-1",
      "/hr/compensation/compensation-leave/announcements",
      "/hr/compensation/history/ot-allowance",
      "/hr/compensation/reports",
    ]) {
      mountPage(path);
      await waitFor(() => !!q("compensation-features-off"), `the notice on ${path}`);
      unmountPage();
    }
    mountPage("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    await waitFor(() => world.requests().includes("/api/payroll-settings"), "Settings to have been read");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(q("compensation-features-off")).toBeNull();
  });

  it("does not flash the notice before the settings have come back", async () => {
    const release = world.hold("/api/payroll-settings");
    world.settings.compensationFeatureEnabled = false;
    mountPage("/hr/compensation/reports");
    await waitFor(() => !!q("reports-kpis"), "the page");
    expect(q("compensation-features-off")).toBeNull();
    release();
    await waitFor(() => !!q("compensation-features-off"), "the notice");
  });
});

describe("a subtab switch", () => {
  it("changes the path (not the query) and keeps the filters of the page", async () => {
    mountPage("/hr/compensation/ot-detection/type-1/allowance?month=10&year=2026&otdept=Cutting");
    await waitFor(() => !!q("ot-kpis"), "OT Detection");
    click(tab("Type 2"));
    expect(pathname()).toBe("/hr/compensation/ot-detection/type-2/waiting");
    expect(params()).toEqual({ month: "10", year: "2026", otdept: "Cutting" });
    // a nested switch changes the path too, and keeps the page's filters
    await waitFor(() => !!q("ot-type2-nested"), "the nested subtabs");
    click(nestedTab("ot-type2-nested", "how"));
    expect(pathname()).toBe("/hr/compensation/ot-detection/type-2/how");
    expect(params()).toEqual({ month: "10", year: "2026", otdept: "Cutting" });
    click(tab("Earlier records"));
    expect(pathname()).toBe("/hr/compensation/ot-detection/earlier");
    expect(params()).toEqual({ month: "10", year: "2026", otdept: "Cutting" });
  });

  it("is a history entry of its own, so Back returns to the subtab before", async () => {
    mountPage("/hr/compensation/compensation-leave/announcements/announce");
    await waitFor(() => !!q("windows-part"), "the announcements");
    click(tab("C. Birthdays"));
    await waitFor(() => !!q("birthdays-part"), "Birthdays");
    expect(pathname()).toBe("/hr/compensation/compensation-leave/birthdays/list");
    window.history.back();
    await waitFor(() => !!q("windows-part"), "the announcements again");
    expect(pathname()).toBe("/hr/compensation/compensation-leave/announcements/announce");
  });

  it("does not leak one page's filters into another: the sidebar link carries none", async () => {
    mountPage("/hr/compensation/history/ot-pay?period=week");
    await waitFor(() => !!q("history-range"), "History");
    expect(params()).toEqual({ period: "week" });
    unmountPage();
    mountPage("/hr/compensation/reports");
    await waitFor(() => !!q("reports-kpis"), "Reports");
    expect(params()).toEqual({});
  });
});

describe("CTC Breakdown, unchanged", () => {
  it("lists the staff with the 50% + 50% split, and says when the split is the automatic one", async () => {
    mountPage("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    const row = text(q("ctc-row-E11"));
    expect(row).toContain("Asha Kumar");
    expect(row).toContain("Sales");
    expect(row).toContain("₹6,000"); // Basic
    expect(row).toContain("₹1,440"); // employer PF
    expect(row).toContain("₹3,05,280"); // annual CTC, in Indian grouping
    expect(text(q("ctc-auto-split"))).toBe("Auto split");
    expect(text(q("ctc-summary"))).toContain("1 showing the automatic split (not recorded yet)");
  });

  it("asks the server with its filters, and offers the Excel export", async () => {
    mountPage("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(world.requests()).toContain("/api/compensation?");
    const exportButton = [...document.body.querySelectorAll("button")].find((b) => text(b) === "Export to Excel");
    expect(exportButton).toBeTruthy();
    expect((exportButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides the branch filter from a login that sees one branch only", async () => {
    h.user.current = { branchId: 2 };
    mountPage("/hr/compensation/ctc-breakdown");
    await waitFor(() => !!q("ctc-row-E11"), "the CTC rows");
    expect(world.requests().some((r) => r.startsWith("/api/branches"))).toBe(false);
  });
});
