import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OLD_WEEK, PREVIOUS_WEEK, cyclesOf, summaryOf } from "./fixtures";
import {
  click,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  q,
  settle,
  tab,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The shell of a Production Payroll cycle page (Weekly / BiWeekly / Monthly) in jsdom, with a fake server behind
// customFetch: who is on the page, the states a cycle can be in (set up, not set up, nobody assigned), and the page's
// state - tab, pay period, filters - living in the address, so a reload, a shared link and Back from a payroll's
// details page all land on the same screen.

const h = vi.hoisted(() => ({ fetch: vi.fn(), trigger: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
}));
vi.mock("@/contexts/PayrollGenerationContext", () => ({
  usePayrollGeneration: () => ({
    isGenerating: false,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerGenerate: vi.fn(),
    triggerGenerateProduction: h.trigger,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/contexts/SalarySlipBulkContext", () => ({
  useSalarySlipBulk: () => ({
    isRunning: false,
    kind: null,
    showPipeline: false,
    progress: undefined,
    lastEmailResult: null,
    triggerBulkDownload: vi.fn(),
    triggerBulkEmail: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/contexts/WhatsAppBulkContext", () => ({
  useWhatsAppBulk: () => ({
    isRunning: false,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerBulkWhatsApp: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.trigger.mockResolvedValue(null);
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const WEEKLY = "/hr/production-payroll/weekly";
const WEEK_PARAM = "2026-02-02_2026-02-08";

/** Opens a cycle's page and waits until its Payroll tab has the figures of the period on screen. */
async function openPayroll(url = WEEKLY, cycle: "weekly" | "biweekly" | "monthly" = "weekly") {
  mountPage(url, cycle);
  await waitFor(() => !!q("view-records-count"), "the Payroll tab");
}

// The page's own tab row (the first pill row on the page; the statement's Scroll / Pages switch is another). It draws
// each label twice (its animation): the first copy is the one that reads.
const selectedTab = () =>
  [...document.body.querySelector('[data-slot="pill-tabs"]')!.querySelectorAll('[role="tab"]')]
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => text(t.querySelector(".ptab-label")).replace(/\(\d+\)$/, ""));

describe("a Production Payroll cycle page", () => {
  it("names its cycle, what the period is, and the people it pays", async () => {
    await openPayroll();
    expect(text(q("pcp-cycle-badge"))).toBe("Weekly");
    const blurb = text(document.body.querySelector("h2")!.parentElement!.querySelector("p"));
    expect(blurb).toContain("One-week calculation");
    expect(blurb).toContain("7-day pay period");
    expect(q("production-payroll-weekly")).not.toBeNull();
    expect(text(document.body)).toContain("Production Employees(3)");
    expect(text(tab("Employees"))).toContain("3");
  });

  it("shows the other cycles with their own length", async () => {
    world.cycles = cyclesOf();
    mountPage("/hr/production-payroll/biweekly", "biweekly");
    await waitFor(() => !!q("pcp-cycle-badge"), "the page");
    expect(text(q("pcp-cycle-badge"))).toBe("BiWeekly");
    unmountPage();
    mountPage("/hr/production-payroll/monthly", "monthly");
    await waitFor(() => !!q("pcp-cycle-badge"), "the page");
    expect(text(q("pcp-cycle-badge"))).toBe("Monthly");
    const blurb = text(document.body.querySelector("h2")!.parentElement!.querySelector("p"));
    expect(blurb).toContain("Four-week calculation");
    expect(blurb).toContain("28-day pay period");
  });

  it("links to Production Employees and to the Settings of the cycle", async () => {
    await openPayroll();
    expect(document.body.querySelector('a[href="/hr/employees/productionEmployee"]')).not.toBeNull();
    const settings = document.body.querySelector<HTMLAnchorElement>('a[href*="tab=production_payroll"]');
    expect(settings?.getAttribute("href")).toBe("/hr/settings?tab=production_payroll#weekly-first-period");
    expect(text(settings)).toBe("Weekly settings");
  });

  it("reloads every payroll figure on screen when Reload is pressed", async () => {
    await openPayroll();
    const reload = must("pcp-refresh") as HTMLButtonElement;
    expect(reload.getAttribute("aria-label")).toBe("Reload the payroll figures");
    const asked = (path: string) => world.requests().filter((r) => r.startsWith(path)).length;
    expect(asked("/api/payroll/production/cycles")).toBe(1);
    expect(asked("/api/payroll/production/period-status")).toBe(1);
    click(reload);
    await waitFor(() => asked("/api/payroll/production/period-status") === 2, "the roster to be asked for again");
    expect(asked("/api/payroll/production/cycles")).toBe(2);
    expect(asked("/api/payroll/production/issues")).toBe(2);
    await waitFor(() => !reload.disabled, "Reload to finish");
  });

  it("reminds that some production employees are in no cycle", async () => {
    await openPayroll();
    expect(q("pcp-unassigned-notice")).toBeNull();
    unmountPage();
    world.cycles = cyclesOf({ unassigned: 4 });
    mountPage(WEEKLY);
    await waitFor(() => !!q("pcp-unassigned-notice"), "the notice");
    expect(text(q("pcp-unassigned-notice"))).toContain("4 production employees are not assigned to a pay cycle yet");
  });

  it("a cycle with no first period start asks for it instead of showing a period", async () => {
    world.cycles = cyclesOf({
      cycles: [
        summaryOf("weekly"),
        summaryOf("biweekly", {
          configured: false,
          configError: "Set the first period start date for BiWeekly in Settings -> Production Payroll -> BiWeekly.",
          next: null,
        }),
        summaryOf("monthly"),
      ],
    });
    world.failing.set("/api/payroll/production/periods", 400);
    mountPage("/hr/production-payroll/biweekly", "biweekly");
    await waitFor(() => !!q("pcp-setup-needed"), "the set-up notice");
    expect(text(q("pcp-setup-needed"))).toContain("BiWeekly payroll is not set up yet");
    expect(text(q("pcp-setup-needed"))).toContain("Set the first period start date for BiWeekly");
    expect(document.body.querySelector('a[href*="biweekly-first-period"]')).not.toBeNull();
    // no period to pick, nothing to generate
    expect(q("pcp-period")).toBeNull();
    expect(q("pcp-generate-open")).toBeNull();
    // every tab is about one pay period (the Payslip tab too, since 2026-11-20), so each needs the set-up
    click(tab("Employees"));
    expect(q("pcp-setup-needed")).not.toBeNull();
    click(tab("Excess"));
    expect(q("pcp-setup-needed")).not.toBeNull();
    expect(q("excess-tab")).toBeNull();
    click(tab("Payslip"));
    expect(q("pcp-setup-needed")).not.toBeNull();
    expect(q("pcp-payslip-tab")).toBeNull();
  });

  it("shows a loader while the cycle is on its way, never a blank page", async () => {
    const release = world.hold("/api/payroll/production/cycles");
    mountPage(WEEKLY);
    await settle(20);
    expect(q("payroll-loader")).not.toBeNull();
    expect(text(q("payroll-loader"))).toContain("Loading the pay cycle");
    expect(q("pcp-period")).toBeNull();
    release();
    await waitFor(() => !!q("view-records-count"), "the Payroll tab");
    expect(q("payroll-loader")).toBeNull();
  });

  it("says so, with a way to try again, when the pay periods cannot be loaded", async () => {
    world.failing.set("/api/payroll/production/periods", 500);
    mountPage(WEEKLY);
    await waitFor(() => !!q("pcp-periods-error"), "the error");
    expect(text(q("pcp-periods-error"))).toContain("The pay periods could not be loaded");
    world.failing.delete("/api/payroll/production/periods");
    click(must("pcp-periods-error").querySelector("button"));
    await waitFor(() => !!q("view-records-count"), "the Payroll tab");
    expect(q("pcp-periods-error")).toBeNull();
  });
});

describe("the page's state in its address", () => {
  it("opens on the Payroll tab and on the next due period when the address says nothing", async () => {
    await openPayroll();
    expect(selectedTab()).toEqual(["Payroll"]);
    expect(text(q("pcp-period"))).toBe("2 Feb - 8 Feb 2026 Next due");
    // the calendar is hidden on every visit (owner 2026-11-16); opened, it shows the period: February with January
    // beside it, the week filled in
    expect(q("pcp-calendar")).toBeNull();
    click(must("pcp-cal-toggle"));
    expect(text(q("pcp-cal-month-1"))).toBe("February 2026");
    expect(must("pcp-cal-day-2026-02-04").dataset.selected).toBe("true");
    expect(text(q("pcp-record-count"))).toBe("2 Feb - 8 Feb 2026 · 1 record");
    expect(here()).toBe(WEEKLY); // following the next due period leaves nothing in the address
  });

  it("opens on the tab the address names", async () => {
    mountPage(`${WEEKLY}?tab=employees`);
    await waitFor(() => !!q("pcp-roster-list"), "the Employees tab");
    expect(selectedTab()).toEqual(["Employees"]);
    expect(q("pcp-payroll-tab")).toBeNull();
    unmountPage();
    // `salary` is the Excess tab since 2026-11-20: old links still open it
    mountPage(`${WEEKLY}?tab=salary`);
    await waitFor(() => !!q("excess-summary"), "the Excess tab");
    expect(selectedTab()).toEqual(["Excess"]);
    unmountPage();
    mountPage(`${WEEKLY}?tab=payslip`);
    await waitFor(() => !!q("ps-list") || !!q("ps-empty"), "the Payslip tab");
    expect(selectedTab()).toEqual(["Payslip"]);
    // the Payslip tab is about the page's pay period too
    expect(text(q("pcp-period"))).toBe("2 Feb - 8 Feb 2026 Next due");
  });

  it("opens the Payroll tab for a tab that does not exist", async () => {
    mountPage(`${WEEKLY}?tab=settings`);
    await waitFor(() => !!q("view-records-count"), "the Payroll tab");
    expect(selectedTab()).toEqual(["Payroll"]);
  });

  it("puts the chosen tab in the address, and leaves Payroll (the default) out of it", async () => {
    await openPayroll();
    click(tab("Employees"));
    expect(params()).toEqual({ tab: "employees" });
    click(tab("Excess"));
    expect(params()).toEqual({ tab: "salary" });
    click(tab("Payroll"));
    expect(params()).toEqual({});
    expect(here()).toBe(WEEKLY);
  });

  it("keeps the pay period when the tab changes, and each tab's own filters under its own keys", async () => {
    await openPayroll(`${WEEKLY}?period=${WEEK_PARAM}&q=asha&view=issues&eq=bala`);
    click(tab("Employees"));
    expect(params()).toEqual({ period: WEEK_PARAM, q: "asha", view: "issues", eq: "bala", tab: "employees" });
    await waitFor(() => !!q("pcp-roster-list"), "the roster");
    expect((must("pcp-roster-search") as HTMLInputElement).value).toBe("bala");
    click(tab("Payroll"));
    await waitFor(() => !!q("view-records-count"), "the Payroll tab");
    expect(q("issues-panel")).not.toBeNull(); // the view it was left on
  });

  it("opens the pay period the address names", async () => {
    mountPage(`${WEEKLY}?period=2026-01-26_2026-02-01`);
    await waitFor(() => !!q("pcp-record-count"), "the period");
    expect(text(q("pcp-record-count"))).toBe("26 Jan - 1 Feb 2026 · 0 records");
    expect(text(q("pcp-period"))).toContain("26 Jan - 1 Feb 2026");
    // nothing was generated for that week: the page says so and offers to generate
    expect(text(q("pcp-empty-period"))).toContain("No payroll generated for this period yet");
  });

  it("opens an old pay period the list does not offer, by adding it to the list", async () => {
    mountPage(`${WEEKLY}?period=${OLD_WEEK.periodStart}_${OLD_WEEK.periodEnd}`);
    await waitFor(() => !!q("pcp-record-count"), "the period");
    expect(text(q("pcp-record-count"))).toBe("3 Nov - 9 Nov 2025 · 0 records");
    await waitFor(() => text(q("pcp-period")).includes("3 Nov - 9 Nov 2025"), "the picker to show the old period");
    expect(world.requests()).toContain("/api/payroll/production/periods?cycle=weekly&around=2025-11-03");
    // the period itself was asked for by its own dates
    expect(world.requests()).toContain(
      "/api/payroll/production/period-status?cycle=weekly&periodStart=2025-11-03&periodEnd=2025-11-09",
    );
  });

  it("ignores a pay period in the address that is not one, and follows the next due period", async () => {
    mountPage(`${WEEKLY}?period=nonsense`);
    await waitFor(() => !!q("pcp-record-count"), "the Payroll tab");
    expect(text(q("pcp-record-count"))).toBe("2 Feb - 8 Feb 2026 · 1 record");
    unmountPage();
    mountPage(`${WEEKLY}?period=2026-02-30_2026-03-05`);
    await waitFor(() => !!q("pcp-record-count"), "the Payroll tab");
    expect(text(q("pcp-record-count"))).toBe("2 Feb - 8 Feb 2026 · 1 record");
  });

  it("puts a period picked on the calendar in the address: any day picks its whole week", async () => {
    await openPayroll();
    click(must("pcp-cal-toggle"));
    expect(must("pcp-cal-day-2026-02-04").dataset.kind).toBe("generated");
    expect(must("pcp-cal-day-2026-01-28").dataset.kind).toBe("due");
    click(must("pcp-cal-day-2026-01-28"));
    await waitFor(() => params().period === "2026-01-26_2026-02-01", "the period in the address");
    await waitFor(() => text(q("pcp-record-count")).startsWith("26 Jan - 1 Feb 2026"), "the new period");
    expect(text(q("pcp-period"))).toBe("26 Jan - 1 Feb 2026");
    expect((must("pcp-period-date") as HTMLInputElement).value).toBe("2026-01-26");
    expect(text(q("pcp-period-to"))).toBe("01-02-2026");
    // Next due brings the next due week back
    click(must("pcp-quick-next"));
    await waitFor(() => params().period === WEEK_PARAM, "the next due period in the address");
  });

  it("opens the period holding a date typed into From, and puts it in the address", async () => {
    await openPayroll(`${WEEKLY}?period=2026-01-26_2026-02-01`);
    typeInto(must("pcp-period-date") as HTMLInputElement, "2026-02-04");
    await waitFor(() => params().period === WEEK_PARAM, "the period in the address");
    await waitFor(() => text(q("pcp-period")).includes("2 Feb - 8 Feb 2026"), "the picker");
    await waitFor(() => (must("pcp-period-date") as HTMLInputElement).value === "2026-02-02", "From to snap");
  });

  it("asks the server for a typed date whose week no list holds yet, and opens it", async () => {
    await openPayroll();
    click(must("pcp-cal-toggle"));
    typeInto(must("pcp-period-date") as HTMLInputElement, "2025-11-05");
    await waitFor(
      () => params().period === `${OLD_WEEK.periodStart}_${OLD_WEEK.periodEnd}`,
      "the period in the address",
    );
    expect(world.requests()).toContain("/api/payroll/production/periods?cycle=weekly&around=2025-11-05");
    await waitFor(() => text(q("pcp-period")).includes("3 Nov - 9 Nov 2025"), "the picker");
    await waitFor(() => text(q("pcp-cal-month-1")) === "November 2025", "the calendar to move to it");
  });

  it("keeps the Payslip tab on the pay period in the address", async () => {
    mountPage(`${WEEKLY}?tab=payslip&period=${WEEK_PARAM}`);
    await waitFor(() => !!q("ps-row-11"), "the payslips of the week");
    expect(world.requests()).toContain(
      "/api/payslips/production?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
    unmountPage();
    // nothing was generated for the week before
    mountPage(`${WEEKLY}?tab=payslip&period=${PREVIOUS_WEEK.periodStart}_${PREVIOUS_WEEK.periodEnd}`);
    await waitFor(() => !!q("ps-empty"), "the empty week");
    expect(text(q("ps-empty"))).toContain("No payroll for Weekly 26 Jan - 1 Feb 2026 yet");
    expect(params()).toEqual({ tab: "payslip", period: `${PREVIOUS_WEEK.periodStart}_${PREVIOUS_WEEK.periodEnd}` });
  });

  it("opens a payroll's details page with the history Back needs, and Back returns to the same tab and period", async () => {
    await openPayroll(`${WEEKLY}?period=${WEEK_PARAM}&q=asha&tab=payroll`);
    const list = here();
    expect(list).toBe(`${WEEKLY}?period=${WEEK_PARAM}&q=asha&tab=payroll`);
    click(must("payroll-record-details-11"));
    expect(here()).toBe("/hr/production-payroll/details/11");
    expect(window.history.state).toEqual({ fromPayroll: true });
    window.history.back();
    await waitFor(() => here() === list, "Back to the list");
    await waitFor(() => !!q("pcp-pf-search"), "the list");
    expect((must("pcp-pf-search") as HTMLInputElement).value).toBe("asha");
    expect(text(q("pcp-record-count"))).toBe("2 Feb - 8 Feb 2026 · 1 record");
  });
});
