import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import ProductionPayrollTab from "../ProductionPayrollTab";
import { PRODUCTION_PAYROLL_SETTINGS } from "../ProductionPayrollTab.meta";

// jsdom render checks of Settings -> Production Payroll with a fake server: the five sub-tabs (the read-only Overview, one per
// pay cycle, Pay & Bonus), the live next-period example of each cycle worked out from what is typed (and the server's answer for
// the saved rule), the "Not set" warning of a cycle without a first period start, each cycle's Save sending only its period
// keys (never a late value, so it can never overwrite what Late Detection saved), and Pay & Bonus sending only what changed.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

type Slab = { fromLates: number; deductionShifts: number };
type Stored = { weekStart?: string; anchorDate?: string; lateFreeAllowance?: number; lateSlabs?: Slab[] };

const SAVED = {
  companyName: "UK Textiles",
  companyLogo: null,
  prodAttendanceMode: "strict",
  prodLateDetectionEnabled: true,
  prodLateFreeAllowance: 3,
  prodLateDeductionSlabs: [
    { fromLates: 3, deductionShifts: 0.25 },
    { fromLates: 6, deductionShifts: 0.5 },
  ],
  defaultSalaryPerShift: 300,
  bonusPercent: 8.33,
  bonusWageCeiling: 7000,
  bonusEligibilityCeiling: 21000,
  bonusFyStartMonth: 4,
  prodBonusPercent: 10,
  prodBonusWageCeiling: 8000,
  prodBonusEligibilityCeiling: 25000,
  companyWideRulesEditable: true,
};
/** What PayrollSettings.prod_cycles holds: Weekly set up, BiWeekly with a date and its own late rules, Monthly empty. */
const STORED: Record<string, Stored> = {
  weekly: { weekStart: "monday" },
  biweekly: {
    weekStart: "monday",
    anchorDate: "2026-09-21",
    lateFreeAllowance: 1,
    lateSlabs: [{ fromLates: 1, deductionShifts: 0.5 }],
  },
  monthly: {},
};
const NEXT: Record<string, unknown> = {
  weekly: {
    cycle: "weekly",
    label: "Weekly",
    days: 7,
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
    periodEnded: true,
  },
  biweekly: {
    cycle: "biweekly",
    label: "BiWeekly",
    days: 14,
    periodStart: "2026-09-21",
    periodEnd: "2026-10-04",
    periodEnded: true,
  },
  monthly: {
    status: 400,
    body: { error: "Set the first period start date for Monthly in Settings -> Production Payroll -> Monthly." },
  },
};
const RUNS: Record<string, unknown[]> = {
  weekly: [
    { id: 1, periodStart: "2026-10-05", periodEnd: "2026-10-11", salaryMode: "shift", payCycle: null },
    { id: 2, periodStart: "2026-09-28", periodEnd: "2026-10-04", salaryMode: "shift", payCycle: "weekly" },
  ],
  biweekly: [],
  monthly: [],
};
const SHIFTS = [
  {
    id: 1,
    name: "Production A",
    shiftType: "production",
    startTime: "08:00:00",
    endTime: "17:00:00",
    genderRule: "any",
    gracePeriodMinutes: 10,
    isDefault: true,
    isActive: true,
  },
  {
    id: 2,
    name: "Office",
    shiftType: "staff",
    startTime: "09:00:00",
    endTime: "17:30:00",
    genderRule: "any",
    gracePeriodMinutes: 10,
    isDefault: false,
    isActive: true,
  },
];

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];
let stored: Record<string, Stored>;

beforeEach(() => {
  puts = [];
  toast.mockClear();
  vi.setSystemTime(new Date(2026, 9, 12, 10, 0, 0)); // Mon 12 Oct 2026
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

/**
 * A fake /api/payroll-settings that stores prodCycles the way the server does (merge_prod_cycles: only the cycles and
 * keys sent change, null clears a key) and answers the way it does (every cycle, every key, shared values filled in).
 */
async function open(
  options: { saved?: Record<string, unknown>; stored?: Record<string, Stored>; readOnly?: boolean } = {},
) {
  let base: Record<string, unknown> = { ...SAVED, ...options.saved };
  stored = JSON.parse(JSON.stringify(options.stored ?? STORED));
  const respond = () =>
    Object.fromEntries(
      ["weekly", "biweekly", "monthly"].map((cycle) => {
        const raw = stored[cycle] ?? {};
        return [
          cycle,
          {
            weekStart: raw.weekStart ?? "monday",
            anchorDate: raw.anchorDate ?? null,
            lateFreeAllowance: raw.lateFreeAllowance ?? base.prodLateFreeAllowance,
            lateSlabs: raw.lateSlabs ?? base.prodLateDeductionSlabs,
            ownLateRules: raw.lateFreeAllowance !== undefined || raw.lateSlabs !== undefined,
          },
        ];
      }),
    );
  page = await renderMdPage(
    () => <ProductionPayrollTab readOnly={options.readOnly} />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
      "/api/payroll-settings": (_params, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(body);
          const { prodCycles, ...rest } = body;
          base = { ...base, ...rest };
          for (const [cycle, patch] of Object.entries((prodCycles ?? {}) as Record<string, Record<string, unknown>>)) {
            const entry: Record<string, unknown> = { ...(stored[cycle] ?? {}) };
            for (const [key, value] of Object.entries(patch)) {
              if (value === null) delete entry[key];
              else entry[key] = value;
            }
            stored[cycle] = entry as Stored;
          }
        }
        return { ...base, prodCycles: respond() };
      },
      "/api/payroll/production/next-period": (params) => NEXT[params.get("cycle") ?? ""] as object,
      // the Overview's cards: one request for all three cycles (production_cycles_summary), as the server answers it
      "/api/payroll/production/cycles": () => ({
        cycles: (["weekly", "biweekly", "monthly"] as const).map((cycle) => {
          const next = NEXT[cycle] as { periodStart?: string; periodEnd?: string; periodEnded?: boolean };
          const refused = (NEXT[cycle] as { body?: { error: string } }).body;
          return {
            cycle,
            label: { weekly: "Weekly", biweekly: "BiWeekly", monthly: "Monthly" }[cycle],
            days: { weekly: 7, biweekly: 14, monthly: 28 }[cycle],
            assigned: { weekly: 12, biweekly: 1, monthly: 0 }[cycle],
            configured: !refused,
            configError: refused ? refused.error : null,
            weekStart: stored[cycle]?.weekStart ?? "monday",
            anchorDate: stored[cycle]?.anchorDate ?? null,
            next: refused
              ? null
              : { periodStart: next.periodStart, periodEnd: next.periodEnd, periodEnded: next.periodEnded },
            pending: { records: 0, employees: 0, amount: 0 },
          };
        }),
        totalProduction: 13,
        unassigned: 0,
      }),
      "/api/payroll/production": (params) => RUNS[params.get("cycle") ?? ""] ?? [],
      "/api/shifts": SHIFTS,
    },
    { path: "/hr/settings?tab=production_payroll" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ");
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const tabNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.querySelector(".ptab-label")?.textContent?.trim() === name,
  );
const input = (selector: string) => q(selector) as HTMLInputElement;
const requestsTo = (prefix: string) => page!.requests().filter((r) => r.startsWith(prefix));

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}
async function openSubTab(name: string) {
  const b = tabNamed(name);
  if (!b) throw new Error(`no sub-tab "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}
async function choose(selector: string, value: string) {
  await act(async () => {
    const select = q(selector) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

const SUB_TABS = ["Overview", "Weekly", "BiWeekly", "Monthly", "Pay & Bonus"];

describe("Settings -> Production Payroll", () => {
  it("opens on the Overview with the five sub-tabs: the chain, each cycle's rule in a line, and nothing to edit", async () => {
    await open();
    expect(SUB_TABS.map((n) => !!tabNamed(n))).toEqual([true, true, true, true, true]);
    expect(tabNamed("Late Detection")).toBeUndefined();
    expect(tabNamed("Attendance & Shift")).toBeUndefined();
    expect(tabNamed("Overview")?.getAttribute("aria-selected")).toBe("true");
    // the chain overview, from the saved settings
    const overview = text('[data-testid="production-pay-overview"]');
    expect(overview).toContain("depending on the employee's pay cycle");
    expect(overview).toContain("Late deductions are ON");
    expect(overview).toContain("Statutory bonus");
    // one card a cycle: its week, first period, current period (today is Mon 12 Oct), the server's next period, the
    // PF / ESI factor and its late rules
    const biweekly = text('[data-testid="production-cycle-summary-biweekly"]');
    expect(biweekly).toContain("14 days, paid every two weeks · 1 worker");
    expect(biweekly).toContain("Week runsMonday → Sunday");
    expect(biweekly).toContain("First periodMon 21 Sep 2026");
    expect(biweekly).toContain("Current periodMon 5 Oct – Sun 18 Oct 2026");
    expect(biweekly).toContain("Next to generateMon 21 Sep – Sun 4 Oct 2026 (ended)");
    expect(biweekly).toContain("× 2 a period's pay");
    expect(biweekly).toContain("Late days1 free, 1 slab");
    const monthly = text('[data-testid="production-cycle-summary-monthly"]');
    expect(monthly).toContain("First periodNot set");
    expect(monthly).toContain("Next to generateNot known");
    expect(monthly).toContain("Payroll cannot be generated until the date is set.");
    const weekly = text('[data-testid="production-cycle-summary-weekly"]');
    expect(weekly).toContain("First periodNot needed");
    expect(weekly).toContain("Late days3 free, 2 slabs (shared)");
    expect(weekly).toContain("× 4 a period's pay");
    // the three cycles come from one request
    expect(requestsTo("/api/payroll/production/cycles")).toHaveLength(1);
    // the steps, short, and the production bonus in a line (from the saved values)
    expect(text('[data-testid="production-pay-steps"]')).toContain("New production employees start from ₹300 a shift.");
    expect(text('[data-testid="production-bonus-summary"]')).toContain("10% of the bonus wage");
    expect(text('[data-testid="production-bonus-summary"]')).toContain("workers up to ₹25,000");
    // links to where each part is set now
    const hrefs = [
      ...document.body.querySelectorAll<HTMLAnchorElement>('[data-testid="production-pay-overview"] a'),
    ].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/hr/settings?tab=production_payroll#default-salary-per-shift");
    expect(hrefs).toContain("/hr/settings?tab=late_detection#prod-late-switch");
    expect(hrefs).toContain("/hr/settings?tab=late_detection#weekly-late-allowance");
    expect(hrefs).toContain("/hr/settings?tab=payroll#fy-start-month");
    // the read-only content of the old "Attendance & Shift" sub-tab
    expect(page!.text()).toContain("Shifts earned, pay and PF / ESI");
    expect(q('[data-testid="production-shifts-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=production_shifts",
    );
    expect(q('[data-testid="production-attendance-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=attendance#production-attendance",
    );
    expect(q('[data-testid="production-pf-esi-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=pf_esi#prod-pf-rules",
    );
    // the same worker on each cycle: 6 shifts a week at ₹600 is an estimate of ₹14,400 on every cycle (x4, x2, x1)
    const pf = text('[data-testid="production-pf-esi-preview"]');
    expect(pf).toContain("Weekly: 6 shifts = ₹3,600.00, estimate ₹14,400.00 (x4)rules tested on ₹14,400.00 a month");
    expect(pf).toContain("BiWeekly: 12 shifts = ₹7,200.00, estimate ₹14,400.00 (x2)rules tested on ₹14,400.00 a month");
    expect(pf).toContain("Monthly: 24 shifts = ₹14,400.00, estimate ₹14,400.00 (x1)rules tested on ₹14,400.00 a month");
    expect(text('[data-testid="production-pf-esi-how"]')).toContain("switched ON in Employees - Co Emp");
    expect(pf).not.toContain("flat rates");
    // the production shifts, not the staff one
    expect(text('[data-testid="production-shift-table"]')).toContain("Production A");
    expect(text('[data-testid="production-shift-table"]')).not.toContain("Office");
    // nothing is set on the Overview
    expect(document.body.querySelector('[data-slot="input"], select')).toBeNull();
    expect(buttonNamed("Save Weekly settings")).toBeUndefined();
    // only the open cycle's rows and next period are asked for, and none while the Overview is open
    expect(requestsTo("/api/payroll/production?cycle=")).toHaveLength(0);
  });

  it("Weekly shows the live next period of the cycle, and no late controls (those are on Late Detection)", async () => {
    await open();
    await openSubTab("Weekly");
    expect(page!.text()).toContain("Weekly pay period");
    expect(page!.text()).not.toContain("Weekly late deductions");
    expect(q("#weekly-late-allowance-input")).toBeNull();
    expect(q('[data-testid="weekly-slab-table"]')).toBeNull();
    expect(buttonNamed("Use the shared rules again")).toBeUndefined();
    expect(q('[data-testid="weekly-late-pointer"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=late_detection#weekly-late-allowance",
    );
    // worked out from the values on screen and the latest WEEKLY period generated (28 Sep - 4 Oct; the later row
    // without a stamped cycle does not count)
    const preview = text('[data-testid="weekly-next-period-preview"]');
    expect(preview).toContain("Latest Weekly period generated: 28 Sep - 4 Oct 2026");
    expect(preview).toContain("5 Oct - 11 Oct 2026 (7 days)");
    expect(preview).toContain("now (it has ended)");
    expect(preview).toContain("12 Oct - 18 Oct 2026, 19 Oct - 25 Oct 2026");
    expect(preview).toContain("2026-10-05 to 2026-10-11 (ended)");
    expect(text('[data-testid="weekly-current"]')).toContain("Mon 12 Oct – Sun 18 Oct 2026");
    // only the open cycle's rows and next period are asked for
    expect(requestsTo("/api/payroll/production?cycle=weekly&limit=20")).toHaveLength(1);
    expect(requestsTo("/api/payroll/production?cycle=biweekly")).toHaveLength(0);
  });

  it("warns when a new week start covers days already generated, and the Weekly save sends only that cycle's period rule", async () => {
    await open();
    await openSubTab("Weekly");
    await choose("#weekly-week-start-input", "sunday");
    expect(text('[data-testid="weekly-current"]')).toContain("Sun 11 Oct – Sat 17 Oct 2026");
    // Sunday weeks: the period holding Mon 5 Oct is 4-10 Oct, and Sun 4 Oct is already in a Weekly payslip
    const preview = text('[data-testid="weekly-next-period-preview"]');
    expect(preview).toContain("4 Oct - 10 Oct 2026 (7 days)");
    expect(preview).toContain("4 Oct - 4 Oct 2026 is already generated");
    await press("Save Weekly settings");
    expect(text('[data-testid="confirm-settings-save"]')).toContain("Save anyway");
    expect(text('[role="alertdialog"]')).toContain("Monday -> Sunday");
    expect(puts).toHaveLength(0);
    await press("Save anyway");
    expect(puts).toEqual([{ prodCycles: { weekly: { weekStart: "sunday", anchorDate: null } } }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Weekly settings saved" }));
    // the server's next period for the cycle is asked again after the save
    expect(requestsTo("/api/payroll/production/next-period?cycle=weekly")).toHaveLength(2);
    expect(q('[data-testid="save-bar"]')?.dataset.dirty).toBe("false");
  });

  it("offers every weekday as the week start, and the Weekly save sends the one chosen", async () => {
    await open();
    await openSubTab("Weekly");
    const select = q("#weekly-week-start-input") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect([...select.options].map((o) => o.textContent)).toContain("Wednesday (weeks run Wednesday to Tuesday)");

    await choose("#weekly-week-start-input", "wednesday");
    // Wednesday weeks: the one holding Mon 12 Oct runs Wed 7 Oct to Tue 13 Oct
    expect(text('[data-testid="weekly-current"]')).toContain("Wed 7 Oct – Tue 13 Oct 2026");
    // and the one holding Mon 5 Oct (the day after the latest generated Weekly period) starts inside that period
    const preview = text('[data-testid="weekly-next-period-preview"]');
    expect(preview).toContain("30 Sep - 6 Oct 2026 (7 days)");
    expect(preview).toContain("30 Sep - 4 Oct 2026 is already generated");
    await press("Save Weekly settings");
    await press("Save anyway");
    expect(puts).toEqual([{ prodCycles: { weekly: { weekStart: "wednesday", anchorDate: null } } }]);
    await openSubTab("Overview");
    expect(text('[data-testid="production-cycle-summary-weekly"]')).toContain("Week runsWednesday → Tuesday");
  });

  it("Monthly says it cannot be generated until a first period start is chosen, and moves any date back to the start weekday", async () => {
    await open();
    await openSubTab("Monthly");
    expect(text('[data-testid="monthly-date-missing"]')).toBe(
      "Not set: Monthly payroll cannot be generated until you choose it.",
    );
    let preview = text('[data-testid="monthly-next-period-preview"]');
    expect(preview).toContain("Not a complete rule yet");
    expect(preview).toContain(
      "Set the first period start date for Monthly in Settings -> Production Payroll -> Monthly.",
    );
    expect(text('[data-testid="monthly-current"]')).toContain("Set the first period start below.");
    expect(buttonNamed("Save Monthly settings")?.disabled).toBe(false);

    await page!.type("#monthly-first-period-input", "2026-10-07"); // a Wednesday
    expect(q('[data-testid="monthly-date-missing"]')).toBeNull();
    preview = text('[data-testid="monthly-next-period-preview"]');
    expect(preview).toContain("First period start Wed 7 Oct 2026moved back to Mon 5 Oct 2026");
    // no Monthly period generated yet; the four weeks holding today (5 Oct - 1 Nov) have not ended, so the one before
    expect(preview).toContain("7 Sep - 4 Oct 2026 (28 days)");
    expect(preview).toContain("now (it has ended)");
    expect(preview).toContain("5 Oct - 1 Nov 2026, 2 Nov - 29 Nov 2026");
    expect(text('[data-testid="monthly-current"]')).toContain("Mon 5 Oct – Sun 1 Nov 2026");

    await press("Save Monthly settings");
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(puts).toEqual([{ prodCycles: { monthly: { weekStart: "monday", anchorDate: "2026-10-07" } } }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Monthly settings saved" }));
    await openSubTab("Overview");
    expect(text('[data-testid="production-cycle-summary-monthly"]')).toContain("First periodMon 5 Oct 2026");
  });

  it("a cycle's period save never carries a late value, so it cannot overwrite what Late Detection saved", async () => {
    await open();
    await openSubTab("BiWeekly");
    // BiWeekly has late rules of its own (1 free day, one slab): saving its period leaves them exactly as they are
    expect(q("#biweekly-late-allowance-input")).toBeNull();
    await choose("#biweekly-week-start-input", "tuesday");
    await press("Save BiWeekly settings");
    await press("Save anyway").catch(() => undefined);
    const sent = puts[0]?.prodCycles as Record<string, Record<string, unknown>>;
    expect(Object.keys(sent)).toEqual(["biweekly"]);
    expect(Object.keys(sent.biweekly).sort()).toEqual(["anchorDate", "weekStart"]);
    expect(stored.biweekly.lateFreeAllowance).toBe(1);
    expect(stored.biweekly.lateSlabs).toEqual([{ fromLates: 1, deductionShifts: 0.5 }]);
    expect(stored.biweekly.weekStart).toBe("tuesday");
  });

  it("keeps a Weekly edit while Monthly is saved, and says so on the pill row", async () => {
    await open();
    await openSubTab("Weekly");
    await choose("#weekly-week-start-input", "sunday");
    await openSubTab("Monthly");
    expect(page!.text()).toContain("Not saved yet: Weekly");
    await page!.type("#monthly-first-period-input", "2026-10-05");
    await press("Save Monthly settings");
    expect(Object.keys(puts[0])).toEqual(["prodCycles"]);
    expect(Object.keys(puts[0].prodCycles as object)).toEqual(["monthly"]);
    expect(page!.text()).toContain("Not saved yet: Weekly");
    await openSubTab("Weekly");
    expect((q("#weekly-week-start-input") as HTMLSelectElement).value).toBe("sunday");
    expect(page!.text()).not.toContain("Not saved yet");
  });

  it("tells a branch login its next period follows its own branch's latest generated one, and locks nothing by itself", async () => {
    // the server counts the latest generated period per branch (production_period.py last_generated_cycle_end), and the
    // payroll list a branch login reads is its own branch's: so its own latest period is shown, not hidden
    await open({ saved: { companyWideRulesEditable: false } });
    const notice = text('[data-testid="settings-branch-notice"]');
    expect(notice).toContain("continues from the latest period generated for your branch's own employees");
    expect(notice).not.toContain("company-wide");
    await openSubTab("Weekly");
    expect(text('[data-testid="weekly-next-period-preview"]')).toContain(
      "Latest Weekly period generated for your branch: 28 Sep - 4 Oct 2026",
    );
    expect(text('[data-testid="weekly-next"]')).toContain(
      "It follows the latest Weekly period generated for your branch.",
    );
    expect(requestsTo("/api/payroll/production?cycle=weekly&limit=20")).toHaveLength(1);
    expect(input("#weekly-week-start-input").disabled).toBe(false);
  });

  it("shows each cycle at a glance: the week, the length, the first period, the PF / ESI factor and the periods ahead", async () => {
    await open();
    await openSubTab("BiWeekly");
    expect(text('[data-testid="biweekly-week-runs"]')).toContain("Monday → Sunday");
    expect(text('[data-testid="biweekly-length"]')).toContain("14 days");
    expect(text('[data-testid="biweekly-first-start"]')).toContain("Mon 21 Sep 2026");
    expect(text('[data-testid="biweekly-factor"]')).toContain("× 2");
    expect(text('[data-testid="biweekly-factor"]')).toContain("Two weeks' pay times two");
    expect(text('[data-testid="biweekly-current"]')).toContain("Mon 5 Oct – Sun 18 Oct 2026");
    expect(text('[data-testid="biweekly-current"]')).toContain("Today is day 8 of 14.");
    // nothing generated on BiWeekly yet: the first is the latest period that has ended
    expect(text('[data-testid="biweekly-next"]')).toContain("Mon 21 Sep – Sun 4 Oct 2026");
    expect(text('[data-testid="biweekly-next"]')).toContain("It has ended: it can be generated now.");
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[data-testid="biweekly-strip"] li')].map(
        (li) => li.dataset.tags,
      ),
    ).toEqual(["next", "today", "", ""]);
    // editing the box moves the card at once, and says it is not saved
    await choose("#biweekly-week-start-input", "wednesday");
    expect(text('[data-testid="biweekly-week-runs"]')).toContain("Wednesday → Tuesday");
    expect(text('[data-testid="biweekly-week-runs-line"]')).toBe("Week runs Wednesday → Tuesday");
    expect(text('[data-testid="biweekly-first-start"]')).toContain("Wed 16 Sep 2026");
    expect(q('[data-testid="biweekly-card-unsaved"]')).not.toBeNull();

    await openSubTab("Monthly");
    expect(text('[data-testid="monthly-length"]')).toContain("Monthly = four weeks (28 days), not a calendar month");
    expect(text('[data-testid="monthly-first-start"]')).toContain("Not set");
    expect(text('[data-testid="monthly-next"]')).toContain("Not known yet");
    expect(q('[data-testid="monthly-strip"]')).toBeNull();

    await openSubTab("Weekly");
    expect(text('[data-testid="weekly-first-start"]')).toContain("Not needed");
    expect(text('[data-testid="weekly-factor"]')).toContain("× 4");
    // the latest generated Weekly period comes first in the strip, then the next one to generate
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[data-testid="weekly-strip"] li')].map((li) => li.dataset.tags),
    ).toEqual(["generated", "next", "today", "", ""]);
  });

  it("view only: every field and every Save button is disabled", async () => {
    await open({ readOnly: true });
    await openSubTab("Weekly");
    expect(input("#weekly-week-start-input").disabled).toBe(true);
    expect(input("#weekly-first-period-input").disabled).toBe(true);
    expect(buttonNamed("Save Weekly settings")?.disabled).toBe(true);
    await openSubTab("Pay & Bonus");
    for (const id of [
      "#default-salary-per-shift-input",
      "#prod-bonus-percent-input",
      "#prod-bonus-wage-ceiling-input",
      "#prod-bonus-eligibility-ceiling-input",
    ]) {
      expect(input(id).disabled, id).toBe(true);
    }
    expect(buttonNamed("Save Pay & Bonus settings")?.disabled).toBe(true);
  });

  it("an address naming a setting opens the sub-tab that holds it", async () => {
    window.history.replaceState(null, "", "/hr/settings?tab=production_payroll#biweekly-first-period");
    await open();
    expect(tabNamed("BiWeekly")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="biweekly-first-period"]')).not.toBeNull();
    expect(text('[data-testid="biweekly-next-period-preview"]')).toContain("21 Sep - 4 Oct 2026 (14 days)");
    page!.unmount();
    window.history.replaceState(null, "", "/hr/settings?tab=production_payroll#default-salary-per-shift");
    await open();
    expect(tabNamed("Pay & Bonus")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="default-salary-per-shift"]')).not.toBeNull();
    page!.unmount();
    window.history.replaceState(null, "", "/hr/settings?tab=production_payroll#prod-assigned-shifts");
    await open();
    expect(tabNamed("Overview")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="prod-assigned-shifts"]')).not.toBeNull();
  });
});

describe("Settings -> Production Payroll -> Pay & Bonus", () => {
  it("shows the suggested rate and the production bonus, apart from the staff bonus, with the financial year pointing to Staff Payroll", async () => {
    await open();
    await openSubTab("Pay & Bonus");
    expect(page!.text()).toContain("Rate for new production employees");
    expect(page!.text()).toContain("Production statutory bonus");
    expect(input("#default-salary-per-shift-input").value).toBe("300");
    expect(input("#prod-bonus-percent-input").value).toBe("10");
    expect(input("#prod-bonus-wage-ceiling-input").value).toBe("8000");
    expect(input("#prod-bonus-eligibility-ceiling-input").value).toBe("25000");
    // the example follows the production values (10%, ceiling ₹8,000): BiWeekly, 26 payslips of ₹9,600 -> wage 26 x 8,000 = 208,000
    expect(text('[data-testid="prod-bonus-wage-preview"]')).toContain(
      "BiWeekly, 26 payslips of ₹9,600wage ₹2,08,000.00",
    );
    expect(text('[data-testid="prod-bonus-eligibility-preview"]')).toContain("latest payslip ₹24,600eligible");
    // one company-wide value stays on Staff Payroll
    const pointer = [...document.body.querySelectorAll('[data-testid="prod-bonus-fy-pointer"] a')].map((a) =>
      a.getAttribute("href"),
    );
    expect(pointer).toEqual(["/hr/settings?tab=payroll#bonus-percent", "/hr/settings?tab=payroll#fy-start-month"]);
    expect(text('[data-testid="prod-bonus-fy-pointer"]')).toContain("now April");
    // no financial-year control here
    expect(q("#fy-start-month-input")).toBeNull();
    expect(buttonNamed("Save Pay & Bonus settings")?.disabled).toBe(true);
  });

  it("shows the four values as cards, each with a line and an example, and follows the boxes", async () => {
    await open();
    await openSubTab("Pay & Bonus");
    const card = (id: string) => text(`[data-testid="pay-bonus-glance-${id}"]`);
    expect(card("default-salary-per-shift")).toContain("₹300 a shift");
    expect(card("default-salary-per-shift")).toContain("Pre-fills Salary Per Shift on Add Employee");
    expect(card("default-salary-per-shift")).toContain("Example: 26 shifts at ₹300 = ₹7,800.00");
    expect(card("prod-bonus-percent")).toContain("10%");
    expect(card("prod-bonus-percent")).toContain("Example: BiWeekly, 26 payslips of ₹9,600: bonus ₹20,800.00");
    expect(card("prod-bonus-wage-ceiling")).toContain("₹8,000 a payslip");
    expect(card("prod-bonus-wage-ceiling")).toContain("Example: A ₹9,600 payslip counts as ₹8,000");
    expect(card("prod-bonus-eligibility-ceiling")).toContain("₹25,000");
    expect(card("prod-bonus-eligibility-ceiling")).toContain("Example: Latest payslip ₹24,600: eligible");
    expect(text('[data-testid="prod-bonus-formula"]')).toContain("Bonus = bonus wage × 10%");
    expect(q('[data-testid="pay-bonus-glance-unsaved"]')).toBeNull();
    await page!.type("#prod-bonus-percent-input", "12");
    expect(card("prod-bonus-percent")).toContain("12%");
    expect(text('[data-testid="prod-bonus-formula"]')).toContain("Bonus = bonus wage × 12%");
    expect(q('[data-testid="pay-bonus-glance-unsaved"]')).not.toBeNull();
    await page!.type("#default-salary-per-shift-input", "0");
    expect(card("default-salary-per-shift")).toContain("No suggestion");
  });

  it("saves the suggested rate alone, sending that one key and no bonus value", async () => {
    await open();
    await openSubTab("Pay & Bonus");
    await page!.type("#default-salary-per-shift-input", "350");
    expect(text('[data-testid="save-bar"]')).toContain("You have changes that are not saved yet.");
    await press("Save Pay & Bonus settings");
    // no question: it moves no money
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(puts).toEqual([{ defaultSalaryPerShift: 350 }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pay & Bonus settings saved" }));
    expect(input("#default-salary-per-shift-input").value).toBe("350");
    expect(q('[data-testid="save-bar"]')?.dataset.dirty).toBe("false");
  });

  it("asks before it saves the production bonus, lists the changes, and sends only the changed keys", async () => {
    await open();
    await openSubTab("Pay & Bonus");
    await page!.type("#prod-bonus-percent-input", "12.5");
    await page!.type("#prod-bonus-eligibility-ceiling-input", "30000");
    await press("Save Pay & Bonus settings");
    const dialog = text('[role="alertdialog"]');
    expect(dialog).toContain("Save the new production bonus rules?");
    expect(dialog).toContain("Production bonus rate");
    expect(dialog).toContain("10% -> 12.5%");
    expect(dialog).toContain("Production bonus eligibility limit");
    expect(dialog).toContain("Staff are not affected");
    expect(puts).toHaveLength(0);
    await press("Save changes");
    expect(puts).toEqual([{ prodBonusPercent: 12.5, prodBonusEligibilityCeiling: 30000 }]);
    for (const staff of ["bonusPercent", "bonusWageCeiling", "bonusEligibilityCeiling", "bonusFyStartMonth"]) {
      expect(Object.keys(puts[0])).not.toContain(staff);
    }
  });

  it("warns about a bonus rate outside the Act, refuses a bad number, and does not send anything until it is fixed", async () => {
    await open();
    await openSubTab("Pay & Bonus");
    await page!.type("#prod-bonus-percent-input", "5");
    expect(text('[data-testid="prod-bonus-act-warning"]')).toContain("outside the Payment of Bonus Act's 8.33% to 20%");
    expect(buttonNamed("Save Pay & Bonus settings")?.disabled).toBe(false);
    await page!.type("#prod-bonus-wage-ceiling-input", "-5");
    expect(buttonNamed("Save Pay & Bonus settings")?.disabled).toBe(true);
    expect(text('[data-testid="production-pay-bonus"]')).toContain("Fix the values marked in red first.");
    await page!.type("#prod-bonus-wage-ceiling-input", "8000");
    await page!.type("#default-salary-per-shift-input", "300.505");
    expect(buttonNamed("Save Pay & Bonus settings")?.disabled).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("keeps the bonus read-only, and says so, while the server does not report it (an older backend)", async () => {
    await open({
      saved: { prodBonusPercent: undefined, prodBonusWageCeiling: undefined, prodBonusEligibilityCeiling: undefined },
    });
    await openSubTab("Pay & Bonus");
    expect(input("#prod-bonus-percent-input").disabled).toBe(true);
    expect(input("#prod-bonus-wage-ceiling-input").disabled).toBe(true);
    expect(input("#prod-bonus-eligibility-ceiling-input").disabled).toBe(true);
    expect(document.body.querySelectorAll('[data-testid="prod-bonus-not-reported"]')).toHaveLength(3);
    // shown from the staff values, as the split starts from them; the suggested rate is still editable
    expect(input("#prod-bonus-percent-input").value).toBe("8.33");
    expect(input("#default-salary-per-shift-input").disabled).toBe(false);
  });

  it("a Pay & Bonus edit stays while a cycle is saved, and says so on the pill row", async () => {
    await open();
    await openSubTab("Pay & Bonus");
    await page!.type("#prod-bonus-percent-input", "9");
    await openSubTab("Monthly");
    expect(page!.text()).toContain("Not saved yet: Pay & Bonus");
    await page!.type("#monthly-first-period-input", "2026-10-05");
    await press("Save Monthly settings");
    expect(Object.keys(puts[0])).toEqual(["prodCycles"]);
    await openSubTab("Pay & Bonus");
    expect(input("#prod-bonus-percent-input").value).toBe("9");
  });
});

describe("Settings -> Production Payroll: the search catalogue", () => {
  it("has a search entry for every setting it draws, with the same title and words", async () => {
    await open();
    const seen = new Map<string, HTMLElement>();
    for (const name of SUB_TABS) {
      await openSubTab(name);
      const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
      for (const b of page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")) {
        seen.set(b.dataset.settingId!, b);
        const meta = PRODUCTION_PAYROLL_SETTINGS.find((m) => m.id === b.dataset.settingId);
        expect(meta, b.dataset.settingId).toBeTruthy();
        expect(b.querySelector("h4")?.textContent?.trim(), meta!.id).toBe(meta!.title);
        expect(b.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta!.id).toBe(meta!.purpose);
        expect(b.closest("section:not([data-setting-id])")?.querySelector("h3")?.textContent?.trim()).toBe(
          meta!.section,
        );
      }
    }
    expect([...seen.keys()].sort()).toEqual(PRODUCTION_PAYROLL_SETTINGS.map((m) => m.id).sort());
  });
});
