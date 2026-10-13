import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import ProductionPayrollTab from "../ProductionPayrollTab";
import { PRODUCTION_PAYROLL_SETTINGS } from "../ProductionPayrollTab.meta";

// jsdom render checks of Settings -> Production Payroll with a fake server: the five sub-tabs (one per pay cycle, the
// global late detection, the read-only Attendance & Shift), the live next-period example of each cycle worked out from
// what is typed (and the server's answer for the saved rule), the "Not set" warning of a cycle without a first period
// start, each cycle's own late rules against the shared ones, and each Save sending only its own keys.

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
  prodPayrollRulesEnabled: true,
  prodPfRate: 12,
  prodEsiRate: 0.75,
  prodEsiApplicableBelow: 21000,
  prodPfEfEnabled: false,
  prodPfEfRules: [],
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
  const stored: Record<string, Stored> = JSON.parse(JSON.stringify(options.stored ?? STORED));
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

const SUB_TABS = ["Weekly", "BiWeekly", "Monthly", "Late Detection", "Attendance & Shift"];

describe("Settings -> Production Payroll", () => {
  it("opens on Weekly with the five sub-tabs, the chain overview and the live next period of the cycle", async () => {
    await open();
    expect(SUB_TABS.map((n) => !!tabNamed(n))).toEqual([true, true, true, true, true]);
    expect(tabNamed("Weekly")?.getAttribute("aria-selected")).toBe("true");
    expect(page!.text()).toContain("Weekly pay period");
    expect(page!.text()).toContain("Weekly late deductions");
    // the overview: the cycle chain, and each cycle's saved rule in one line
    const overview = text('[data-testid="production-pay-overview"]');
    expect(overview).toContain("depending on the employee's pay cycle");
    expect(overview).toContain("Late deductions are ON");
    expect(text('[data-testid="production-cycle-summary-biweekly"]')).toContain(
      "Monday weeks counted from Mon 21 Sep 2026",
    );
    expect(text('[data-testid="production-cycle-summary-biweekly"]')).toContain("Late: 1 free, 1 slab");
    expect(text('[data-testid="production-cycle-summary-monthly"]')).toContain(
      "Payroll cannot be generated until the date is set.",
    );
    expect(text('[data-testid="production-cycle-summary-weekly"]')).toContain("Late: 3 free, 2 slabs (shared)");
    // worked out from the values on screen and the latest WEEKLY period generated (28 Sep - 4 Oct; the later row
    // without a stamped cycle does not count)
    const preview = text('[data-testid="weekly-next-period-preview"]');
    expect(preview).toContain("Latest Weekly period generated: 28 Sep - 4 Oct 2026");
    expect(preview).toContain("5 Oct - 11 Oct 2026 (7 days)");
    expect(preview).toContain("now (it has ended)");
    expect(preview).toContain("12 Oct - 18 Oct 2026, 19 Oct - 25 Oct 2026");
    expect(preview).toContain("2026-10-05 to 2026-10-11 (ended)");
    expect(text('[data-testid="weekly-today-preview"]')).toContain("Mon 12 Oct 2026 to Sun 18 Oct 2026");
    expect(text('[data-testid="weekly-late-source"]')).toContain("Using the shared production values");
    expect(buttonNamed("Use the shared rules again")).toBeUndefined();
    // only the open cycle's rows and next period are asked for
    expect(requestsTo("/api/payroll/production?cycle=weekly&limit=20")).toHaveLength(1);
    expect(requestsTo("/api/payroll/production?cycle=biweekly")).toHaveLength(0);
  });

  it("warns when a new week start covers days already generated, and the Weekly save sends only that cycle's period rule", async () => {
    await open();
    await choose("#weekly-week-start-input", "sunday");
    expect(text('[data-testid="weekly-today-preview"]')).toContain("Sun 11 Oct 2026 to Sat 17 Oct 2026");
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
    expect(text('[data-testid="weekly-today-preview"]')).toContain("Wed 7 Oct 2026 to Tue 13 Oct 2026");
    // and the one holding Mon 5 Oct (the day after the latest generated Weekly period) starts inside that period
    const preview = text('[data-testid="weekly-next-period-preview"]');
    expect(preview).toContain("30 Sep - 6 Oct 2026 (7 days)");
    expect(preview).toContain("30 Sep - 4 Oct 2026 is already generated");
    await press("Save Weekly settings");
    await press("Save anyway");
    expect(puts).toEqual([{ prodCycles: { weekly: { weekStart: "wednesday", anchorDate: null } } }]);
    expect(text('[data-testid="production-cycle-summary-weekly"]')).toContain("Wednesday weeks");
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
    expect(text('[data-testid="monthly-today-preview"]')).toContain("set the first period start below");
    expect(buttonNamed("Save Monthly settings")?.disabled).toBe(false);

    await page!.type("#monthly-first-period-input", "2026-10-07"); // a Wednesday
    expect(q('[data-testid="monthly-date-missing"]')).toBeNull();
    preview = text('[data-testid="monthly-next-period-preview"]');
    expect(preview).toContain("First period start Wed 7 Oct 2026moved back to Mon 5 Oct 2026");
    // no Monthly period generated yet; the four weeks holding today (5 Oct - 1 Nov) have not ended, so the one before
    expect(preview).toContain("7 Sep - 4 Oct 2026 (28 days)");
    expect(preview).toContain("now (it has ended)");
    expect(preview).toContain("5 Oct - 1 Nov 2026, 2 Nov - 29 Nov 2026");
    expect(text('[data-testid="monthly-today-preview"]')).toContain("Mon 5 Oct 2026 to Sun 1 Nov 2026");

    await press("Save Monthly settings");
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(puts).toEqual([{ prodCycles: { monthly: { weekStart: "monday", anchorDate: "2026-10-07" } } }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Monthly settings saved" }));
    expect(text('[data-testid="production-cycle-summary-monthly"]')).toContain(
      "Monday weeks counted from Mon 5 Oct 2026",
    );
  });

  it("prices a cycle's late rules from what is typed, sends them only when changed, and can hand them back to the shared ones", async () => {
    await open();
    // 9 lates, allowance 3, slabs 3 -> 0.25 and 6 -> 0.5, ₹600 a shift: 6 billable, half a shift = ₹300
    expect(text('[data-testid="weekly-late-worked-example"]')).toContain("9 late days-0.5 shift = ₹300.00");
    expect(text('[data-testid="weekly-allowance-preview"]')).toContain("7 late days3 free, 4 billable");
    expect(q('[data-testid="weekly-late-worked-example-everyone"]')).toBeNull();

    await page!.type('[aria-label="Row 1: from this many billable lates"]', "0");
    expect(text('[data-testid="weekly-slab-table-everyone-warning"]')).toContain(
      "deducts from every production worker",
    );
    expect(text('[data-testid="weekly-late-worked-example"]')).toContain("0 late days-0.25 shift = ₹150.00");
    await page!.type('[aria-label="Row 1: from this many billable lates"]', "6");
    expect(text('[aria-label="Row 1: from this many billable lates"] ~ p')).toContain(
      "6 is used by more than one row.",
    );
    expect(buttonNamed("Save Weekly settings")?.disabled).toBe(true);
    await page!.type('[aria-label="Row 1: from this many billable lates"]', "2");
    await page!.type("#weekly-late-allowance-input", "4");
    await press("Add Slab");
    expect(document.body.querySelectorAll('[data-testid="weekly-slab-table"] tbody tr')).toHaveLength(3);

    await press("Save Weekly settings");
    const dialog = text('[role="alertdialog"]');
    expect(dialog).toContain("Free late days a period");
    expect(dialog).toContain("3 -> 4");
    expect(dialog).toContain("Weekly stops following the shared production values (3 free late days, 2 slabs)");
    expect(puts).toHaveLength(0);
    await press("Save changes");
    expect(puts).toEqual([
      {
        prodCycles: {
          weekly: {
            weekStart: "monday",
            anchorDate: null,
            lateFreeAllowance: 4,
            lateSlabs: [
              { fromLates: 2, deductionShifts: 0.25 },
              { fromLates: 6, deductionShifts: 0.5 },
              { fromLates: 9, deductionShifts: 0.25 },
            ],
          },
        },
      },
    ]);
    // the cycle now has rules of its own, and can be handed back to the shared ones with nulls
    expect(text('[data-testid="weekly-late-source"]')).toContain("Weekly has late rules of its own.");
    await press("Use the shared rules again");
    expect(text('[role="alertdialog"]')).toContain("Use the shared late rules for Weekly again?");
    await press("Use the shared rules");
    expect(puts[1]).toEqual({ prodCycles: { weekly: { lateFreeAllowance: null, lateSlabs: null } } });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Weekly uses the shared late rules again" }));
    expect(text('[data-testid="weekly-late-source"]')).toContain("Using the shared production values");
    expect(input("#weekly-late-allowance-input").value).toBe("3");
    expect(document.body.querySelectorAll('[data-testid="weekly-slab-table"] tbody tr')).toHaveLength(2);
    expect(q('[data-testid="save-bar"]')?.dataset.dirty).toBe("false");
  });

  it("the Late Detection sub-tab saves only the switch and the mode, and points to each cycle's own late rules", async () => {
    await open();
    await openSubTab("Late Detection");
    expect(page!.text()).toContain("Production late detection");
    // the mode example uses the real production shift: on time until 08:10, 08:10:20 is late, 16:49 is early in Strict mode
    const mode = text('[data-testid="production-mode-preview"]');
    expect(mode).toContain("Your production shift Production A, 08:00-17:00, grace 10 min");
    expect(mode).toContain("First punch 08:10on time");
    expect(mode).toContain("First punch 08:10:20late");
    expect(mode).toContain("last punch 16:49 (before 16:50)late (left early)");
    await choose("#prod-attendance-mode-input", "simple");
    expect(text('[data-testid="production-mode-preview"]')).toContain("not late in Simple mode");
    // 7 lates on each cycle's saved rules: Weekly shares (3 free, slabs 3/6), BiWeekly has its own (1 free, 1 -> 0.5)
    const on = text('[data-testid="production-late-switch-preview"]');
    expect(on).toContain("Switch on, Weekly (3 free days, 2 slabs)4 billable - -0.25 shift = ₹150.00");
    expect(on).toContain("Switch on, BiWeekly (1 free day, 1 slab)6 billable - -0.5 shift = ₹300.00");
    expect(text('[data-testid="production-late-cycle-biweekly"]')).toContain(
      "1 free late day a period, 1 slab - its own rules",
    );
    expect(text('[data-testid="production-late-cycle-monthly"]')).toContain(
      "3 free late days a period, 2 slabs - the shared values",
    );
    expect(q('[data-testid="production-late-cycle-biweekly"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=production_payroll#biweekly-late-allowance",
    );
    expect(q("#weekly-late-allowance-input")).toBeNull();

    await press("Save Production Late Detection");
    expect(text('[role="alertdialog"]')).toContain("What counts as late");
    expect(text('[role="alertdialog"]')).toContain("Strict");
    expect(puts).toHaveLength(0);
    await press("Save changes");
    expect(puts).toEqual([{ prodAttendanceMode: "simple", prodLateDetectionEnabled: true }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Production Late Detection saved" }));
  });

  it("keeps a Weekly edit while Monthly is saved, and says so on the pill row", async () => {
    await open();
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

  it("the Attendance & Shift sub-tab sets nothing: it points to Manage Shifts, Attendance and the Payroll tab, and scales a month by the cycle", async () => {
    await open();
    await openSubTab("Attendance & Shift");
    expect(page!.text()).toContain("Shifts earned, pay and PF / ESI");
    expect(q('[data-testid="production-shifts-elsewhere"] a')?.getAttribute("href")).toBe("/hr/shifts");
    expect(q('[data-testid="production-attendance-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=attendance#production-attendance",
    );
    expect(q('[data-testid="production-pf-esi-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=payroll#prod-pf-esi-switch",
    );
    // the same worker on each cycle, with the saved flat rates: 6 shifts a week at ₹600 is an estimate of ₹14,400 on
    // every cycle (x4, x2, x1), within the ₹21,000 ceiling, so PF 12% and ESI 0.75% of each period's pay
    const pf = text('[data-testid="production-pf-esi-preview"]');
    expect(pf).toContain("Weekly: 6 shifts = ₹3,600.00, estimate ₹14,400.00 (x4)PF ₹432.00, ESI ₹27.00");
    expect(pf).toContain("BiWeekly: 12 shifts = ₹7,200.00, estimate ₹14,400.00 (x2)PF ₹864.00, ESI ₹54.00");
    expect(pf).toContain("Monthly: 24 shifts = ₹14,400.00, estimate ₹14,400.00 (x1)PF ₹1,728.00, ESI ₹108.00");
    expect(pf).toContain("the flat rates (PF 12%, ESI 0.75%)");
    expect(pf).toContain("₹12,564.00");
    // the production shifts, not the staff one
    expect(text('[data-testid="production-shift-table"]')).toContain("Production A");
    expect(text('[data-testid="production-shift-table"]')).not.toContain("Office");
    expect(document.body.querySelector('[data-slot="input"], select')).toBeNull();
  });

  it("tells a branch login the latest generated period is not known, and locks nothing by itself", async () => {
    await open({ saved: { companyWideRulesEditable: false } });
    expect(q('[data-testid="settings-branch-notice"]')).not.toBeNull();
    expect(text('[data-testid="weekly-next-period-preview"]')).toContain("could not be read with this login");
    expect(requestsTo("/api/payroll/production?")).toHaveLength(0);
    expect(input("#weekly-week-start-input").disabled).toBe(false);
  });

  it("view only: every field and every Save button is disabled", async () => {
    await open({ readOnly: true });
    expect(input("#weekly-week-start-input").disabled).toBe(true);
    expect(input("#weekly-first-period-input").disabled).toBe(true);
    expect(input("#weekly-late-allowance-input").disabled).toBe(true);
    expect(input('[aria-label="Row 1: from this many billable lates"]').disabled).toBe(true);
    expect(buttonNamed("Add Slab")?.disabled).toBe(true);
    expect(buttonNamed("Save Weekly settings")?.disabled).toBe(true);
    await openSubTab("BiWeekly");
    expect(buttonNamed("Use the shared rules again")?.disabled).toBe(true);
    await openSubTab("Late Detection");
    expect(input("#prod-late-enabled").disabled).toBe(true);
    expect(buttonNamed("Save Production Late Detection")?.disabled).toBe(true);
  });

  it("an address naming a setting opens the sub-tab that holds it", async () => {
    window.history.replaceState(null, "", "/hr/settings?tab=production_payroll#biweekly-first-period");
    await open();
    expect(tabNamed("BiWeekly")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="biweekly-first-period"]')).not.toBeNull();
    expect(text('[data-testid="biweekly-late-source"]')).toContain("BiWeekly has late rules of its own.");
    expect(text('[data-testid="biweekly-next-period-preview"]')).toContain("21 Sep - 4 Oct 2026 (14 days)");
  });

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
