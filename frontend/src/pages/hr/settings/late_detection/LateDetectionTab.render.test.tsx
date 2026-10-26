import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import LateDetectionTab from "../LateDetectionTab";
import { LATE_DETECTION_SETTINGS, LATE_VIEW_OF } from "../LateDetectionTab.meta";

// jsdom render checks of Settings -> Late Detection with a fake server. Staff page: the late policy, the permission policy
// and the permission pricing, each with its own Save and a confirm before it, each request carrying only its own keys, the
// examples following what is typed, the plain links to the Attendance switches, the company-wide rules locked for a branch
// login. Production page: the switch, the mode and each pay cycle's late rules, saved with only what changed. The pills keep
// what was typed on the other page.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const SLABS = Array.from({ length: 10 }, (_, i) => ({ fromLates: (i + 1) * 3, deductionShifts: (i + 1) * 0.25 }));
const SAVED = {
  companyName: "UK Textiles",
  companyLogo: null,
  morningLateInEnabled: true,
  eveningEarlyOutEnabled: false,
  halfDaySecondHalfStartTime: "14:30",
  arrivalLateWindowMinutes: 60,
  arrivalPermissionWindowMinutes: 60,
  arrivalExtraMinutes: 20,
  arrivalQuarterDeduction: 0.25,
  lateFreeAllowance: 3,
  lateDeductionSlabs: SLABS,
  permissionMonthlyCap: 3,
  companyWideRulesEditable: true,
  // the production late rules (a backend that reports permission pricing says so below)
  prodAttendanceMode: "strict",
  prodLateDetectionEnabled: true,
  prodLateFreeAllowance: 3,
  prodLateDeductionSlabs: [
    { fromLates: 3, deductionShifts: 0.25 },
    { fromLates: 6, deductionShifts: 0.5 },
  ],
};
const PRICING = { permissionPricingEnabled: false, permissionFreeAllowance: 0, permissionDeductionSlabs: [] };

type Slab = { fromLates: number; deductionShifts: number };
type Stored = { weekStart?: string; anchorDate?: string; lateFreeAllowance?: number; lateSlabs?: Slab[] };
/** What PayrollSettings.prod_cycles holds: Weekly with a period only, BiWeekly with a date and its own late rules. */
const STORED: Record<string, Stored> = {
  weekly: { weekStart: "sunday" },
  biweekly: {
    weekStart: "monday",
    anchorDate: "2026-09-21",
    lateFreeAllowance: 1,
    lateSlabs: [{ fromLates: 1, deductionShifts: 0.5 }],
  },
  monthly: {},
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
];

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];
let stored: Record<string, Stored>;

beforeEach(() => {
  puts = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

/**
 * A fake /api/payroll-settings that stores prodCycles the way the server does (merge_prod_cycles: only the cycles and keys
 * sent change, null clears a key) and answers the way it does (every cycle, every key, shared values filled in).
 */
async function open(saved: Record<string, unknown> = SAVED, options: { readOnly?: boolean } = {}) {
  let base: Record<string, unknown> = { ...saved };
  stored = JSON.parse(JSON.stringify(STORED));
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
    () => <LateDetectionTab readOnly={options.readOnly} />,
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
      "/api/shifts": SHIFTS,
    },
    { path: "/hr/settings?tab=late_detection" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ");
const input = (selector: string) => q(selector) as HTMLInputElement;
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const tabNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.querySelector(".ptab-label")?.textContent?.trim() === name,
  );

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}
/** A button inside one setting block (the page has an "Add Slab" in more than one block). */
const buttonIn = (blockId: string, name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>(`[data-setting-id="${blockId}"] button`)].find(
    (b) => b.textContent?.trim() === name,
  );
async function pressIn(blockId: string, name: string) {
  const b = buttonIn(blockId, name);
  if (!b) throw new Error(`no button "${name}" in ${blockId}`);
  await act(async () => b.click());
  await page!.settle();
}
async function openPill(name: string) {
  const b = tabNamed(name);
  if (!b) throw new Error(`no pill "${name}"`);
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

describe("Settings -> Late Detection: the Staff page", () => {
  it("opens on Staff with the two pills, says it is for staff, links to the Attendance switches and to the production page", async () => {
    await open();
    expect([
      tabNamed("Staff")?.getAttribute("aria-selected"),
      tabNamed("Production")?.getAttribute("aria-selected"),
    ]).toEqual(["true", "false"]);
    expect(page!.text()).toContain("Late Detection Policy");
    expect(page!.text()).toContain("Permission Policy");
    expect(page!.text()).toContain("Permission Pricing");
    expect(page!.text()).toContain("Staff only");
    expect(q('[data-testid="link-morning-late-in"]')?.getAttribute("href")).toBe(
      "/hr/settings?tab=attendance#morning-late-in",
    );
    expect(text('[data-testid="late-detection-switch-status"]')).toContain("Morning Late-In marks (a first");
    expect(text('[data-testid="late-detection-switch-status"]')).toContain("not counted (switched off)");
    expect(q('[data-testid="late-production-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=late_detection#prod-late-switch",
    );
    // the staff page asks for nothing of production (no shifts), and has no production controls
    expect(page!.requests().filter((r) => r.startsWith("/api/shifts"))).toHaveLength(0);
    expect(q("#prod-late-enabled")).toBeNull();
    // the old read-only switch chips are gone: the only switches are the permission pricing one
    expect(document.body.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });

  it("prices the worked example from what is typed, in shifts and rupees", async () => {
    await open();
    expect(text('[data-testid="late-worked-example"]')).toContain("6 marks-0.25 shift = ₹250");
    expect(text('[data-testid="late-worked-example"]')).toContain("20 marks-1.25 shifts = ₹1,250");
    await page!.type("#late-free-allowance", "5");
    expect(text('[data-testid="late-worked-example"]')).toContain("6 marksNo deduction");
    // the month example: 5 Late days, 1 Early Out (switched off, so not counted), 4 permissions with a cap of 3
    expect(text('[data-testid="late-month-example"]')).toContain(
      "5 Late + 0 Early Out + 1 permission beyond the cap of 3",
    );
    expect(text('[data-testid="late-month-example"]')).toContain("6 marks, 5 free, 1 billable");
  });

  it("saves the late policy after a confirm, sending only the allowance and the rows in ascending order", async () => {
    await open();
    await page!.type("#late-free-allowance", "4");
    await press("Add Slab");
    expect(document.body.querySelectorAll('[data-testid="slab-table"] tbody tr')).toHaveLength(11);
    await press("Save Late Detection Policy");
    expect(text('[data-testid="confirm-save"]')).toContain("Free allowance");
    expect(text('[data-testid="confirm-save"]')).toContain("33 → 0.25");
    expect(puts).toHaveLength(0);
    await press("Confirm and save");
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0]).sort()).toEqual(["lateDeductionSlabs", "lateFreeAllowance"]);
    expect(puts[0].lateFreeAllowance).toBe(4);
    const rows = puts[0].lateDeductionSlabs as { fromLates: number }[];
    expect(rows.map((r) => r.fromLates)).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Late Detection policy saved" }));
  });

  it("refuses a duplicate threshold before anything is sent", async () => {
    await open();
    const first = q('[aria-label="Row 2: from this many billable marks"]') as HTMLInputElement;
    expect(first.value).toBe("6");
    await page!.type('[aria-label="Row 2: from this many billable marks"]', "3");
    expect(text('[data-testid="slab-error"]')).toContain("Duplicate threshold: 3 billable marks");
    expect(buttonNamed("Save Late Detection Policy")?.disabled).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("saves the cap on its own, after a confirm that says past days are re-judged", async () => {
    await open();
    await page!.type("#permission-monthly-cap", "2");
    expect(page!.text()).toContain("15th: beyond the cap (Excess)");
    await press("Save Permission Policy");
    expect(text('[data-testid="confirm-save"]')).toContain("re-judged");
    await press("Confirm and save");
    expect(puts).toEqual([{ permissionMonthlyCap: 2 }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Permission policy saved" }));
  });

  it("keeps the company-wide cap read-only for a branch login, the allowance stays editable", async () => {
    await open({ ...SAVED, companyWideRulesEditable: false });
    expect((q("#permission-monthly-cap") as HTMLInputElement).disabled).toBe(true);
    expect(q('[data-testid="company-wide-note-cap"]')).not.toBeNull();
    expect(buttonNamed("Save Permission Policy")?.disabled).toBe(true);
    expect((q("#late-free-allowance") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("Settings -> Late Detection: Permission pricing", () => {
  it("is OFF by default, says what OFF and ON do, and shows the empty slab table", async () => {
    await open({ ...SAVED, ...PRICING });
    const sw = q("#permission-pricing-switch") as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(text('[data-testid="pricing-off-text"]')).toContain("one more mark in the late pool");
    expect(q('[data-testid="pricing-off-text"]')?.getAttribute("data-active")).toBe("true");
    expect(text('[data-testid="pricing-on-text"]')).toContain("leave the late pool");
    expect(text('[data-testid="pricing-on-text"]')).toContain("never deducted twice");
    expect(input("#permission-free-allowance-input").value).toBe("0");
    expect(q('[data-testid="permission-slab-empty"]')).not.toBeNull();
    expect(q('[data-testid="pricing-needs-slab"]')).toBeNull();
    expect(text('[data-testid="late-pool-permissions"]')).toContain("one mark each");
    // nothing to save while nothing changed
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
  });

  it("warns, and will not save, when it is turned ON with no slab", async () => {
    await open({ ...SAVED, ...PRICING });
    await act(async () => (q("#permission-pricing-switch") as HTMLButtonElement).click());
    await page!.settle();
    expect(text('[data-testid="pricing-needs-slab"]')).toContain("Add at least one slab before turning this on.");
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
    expect(q('[data-testid="pricing-on-text"]')?.getAttribute("data-active")).toBe("true");
    // the late pool no longer counts the extra permissions, and the intro says so
    expect(text('[data-testid="late-pool-permissions"]')).toContain("priced on their own");
    expect(puts).toHaveLength(0);
  });

  it("adds permission slabs with the editor of the late slabs, works the month out, and saves the three keys after a confirm", async () => {
    await open({ ...SAVED, ...PRICING });
    await act(async () => (q("#permission-pricing-switch") as HTMLButtonElement).click());
    await page!.settle();
    await pressIn("permission-deduction-slabs", "Add Slab");
    expect(q('[data-testid="pricing-needs-slab"]')).toBeNull();
    const headings = [...document.body.querySelectorAll('[data-testid="permission-slab-table"] th')].map((th) =>
      th.textContent?.trim(),
    );
    expect(headings.slice(0, 2)).toEqual(["From permissions", "Deduct shifts"]);
    // the first row starts at 1 permission, a quarter shift
    expect(input('[aria-label="Row 1: from permissions"]').value).toBe("1");
    expect(input('[aria-label="Row 1: deduct shifts"]').value).toBe("0.25");
    await page!.type('[aria-label="Row 1: deduct shifts"]', "0.5");
    await pressIn("permission-deduction-slabs", "Add Slab");
    expect(input('[aria-label="Row 2: from permissions"]').value).toBe("2");
    await page!.type('[aria-label="Row 2: from permissions"]', "3");
    await page!.type('[aria-label="Row 2: deduct shifts"]', "1");
    await page!.type("#permission-free-allowance-input", "1");

    // the default month: 6 approved permissions, cap 3 -> 3 extra; 1 free -> 2 billable -> row "from 1" -> 0.5 shift = ₹500
    expect(text('[data-testid="pricing-example-excess"]')).toContain("6 approved permissions, cap 3");
    expect(text('[data-testid="pricing-example-excess"]')).toContain("3 beyond the cap");
    expect(text('[data-testid="pricing-example-billable"]')).toContain("1 free, 2 billable");
    expect(text('[data-testid="pricing-example-row"]')).toContain("from 1: 0.5 shift");
    expect(text('[data-testid="pricing-example-permission-cut"]')).toContain("-0.5 shift = ₹500");
    // the late pool holds the Late and Early Out days only (Early Out is switched off here): 2 marks, both free
    expect(text('[data-testid="pricing-example-pool"]')).toContain("2 marks");
    expect(text('[data-testid="pricing-example-total"]')).toContain("-0.5 shift = ₹500");
    expect(text('[data-testid="pricing-example-other"]')).toContain("with the switch off");
    // typing another month
    await page!.type("#pricing-example-permissions", "9");
    expect(text('[data-testid="pricing-example-billable"]')).toContain("1 free, 5 billable");
    expect(text('[data-testid="pricing-example-row"]')).toContain("from 3: 1 shift");

    await press("Save Permission Pricing");
    expect(text('[data-testid="confirm-permission-pricing"]')).toContain("Price permissions separately");
    expect(text('[data-testid="confirm-permission-pricing"]')).toContain("Off");
    expect(text('[data-testid="confirm-permission-pricing"]')).toContain("never deducted twice");
    expect(puts).toHaveLength(0);
    await press("Confirm and save");
    expect(puts).toEqual([
      {
        permissionPricingEnabled: true,
        permissionFreeAllowance: 1,
        permissionDeductionSlabs: [
          { fromPermissions: 1, deductionShifts: 0.5 },
          { fromPermissions: 3, deductionShifts: 1 },
        ],
      },
    ]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Permission pricing saved" }));
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
  });

  it("refuses a slab that starts at 0 or twice, before anything is sent", async () => {
    await open({ ...SAVED, ...PRICING, permissionDeductionSlabs: [{ fromPermissions: 2, deductionShifts: 0.5 }] });
    await page!.type('[aria-label="Row 1: from permissions"]', "0");
    expect(text('[data-testid="permission-slab-error"]')).toContain("from 1 to 999");
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
    await pressIn("permission-deduction-slabs", "Add Slab");
    await page!.type('[aria-label="Row 1: from permissions"]', "3");
    await page!.type('[aria-label="Row 2: from permissions"]', "3");
    expect(text('[data-testid="permission-slab-error"]')).toContain("Duplicate threshold: 3 billable permissions");
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("is read-only for a branch login, like the monthly cap: all three are company-wide rules", async () => {
    await open({ ...SAVED, ...PRICING, companyWideRulesEditable: false });
    expect((q("#permission-pricing-switch") as HTMLButtonElement).disabled).toBe(true);
    expect(input("#permission-free-allowance-input").disabled).toBe(true);
    expect(buttonIn("permission-deduction-slabs", "Add Slab")?.disabled).toBe(true);
    expect(q('[data-testid="company-wide-note-pricing"]')?.textContent).toContain("Company-wide rule");
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
    expect(buttonNamed("Save Late Detection Policy")?.disabled).toBe(true); // nothing changed yet
  });

  it("cannot be changed while the server does not report it (an older backend), and says so", async () => {
    await open(SAVED);
    expect((q("#permission-pricing-switch") as HTMLButtonElement).disabled).toBe(true);
    expect(q('[data-testid="pricing-not-reported"]')?.textContent).toContain("Not reported by the server");
    expect(buttonNamed("Save Permission Pricing")?.disabled).toBe(true);
  });

  it("shows the saved pricing, ON, with its rows, and the extra permissions out of the late pool example", async () => {
    await open({
      ...SAVED,
      permissionPricingEnabled: true,
      permissionFreeAllowance: 2,
      permissionDeductionSlabs: [
        { fromPermissions: 1, deductionShifts: 0.25 },
        { fromPermissions: 4, deductionShifts: 0.75 },
      ],
    });
    expect((q("#permission-pricing-switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect(input("#permission-free-allowance-input").value).toBe("2");
    expect(document.body.querySelectorAll('[data-testid="permission-slab-table"] tbody tr')).toHaveLength(2);
    // the late policy's own month example no longer counts the extra permissions as marks
    expect(text('[data-testid="late-month-example"]')).toContain("priced separately, below");
    expect(text('[data-testid="late-month-example"]')).toContain("5 marks, 3 free, 2 billable");
  });
});

describe("Settings -> Late Detection: the Production page", () => {
  it("opens from its pill, with the switch, the mode and Weekly's late rules, and writes the page into the address", async () => {
    await open();
    expect(q("#prod-late-enabled")).toBeNull();
    await openPill("Production");
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=production");
    expect(page!.text()).toContain("Production late detection");
    expect(page!.text()).toContain("Weekly late deductions");
    expect(tabNamed("Weekly")?.getAttribute("aria-selected")).toBe("true");
    expect((q("#prod-late-enabled") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect(text('[data-testid="weekly-late-source"]')).toContain("Using the shared production values");
    expect(buttonNamed("Use the shared rules again")).toBeUndefined();
    // the staff page's controls are not there
    expect(q("#late-free-allowance")).toBeNull();
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
  });

  it("prices a cycle's late rules from what is typed and sends only what changed, never a period key", async () => {
    await open();
    await openPill("Production");
    // 9 lates, allowance 3, slabs 3 -> 0.25 and 6 -> 0.5, ₹600 a shift: 6 billable, half a shift = ₹300
    expect(text('[data-testid="weekly-late-worked-example"]')).toContain("9 late days-0.5 shift = ₹300.00");
    expect(text('[data-testid="weekly-allowance-preview"]')).toContain("7 late days3 free, 4 billable");
    await page!.type('[aria-label="Row 1: from this many billable lates"]', "0");
    expect(text('[data-testid="weekly-slab-table-everyone-warning"]')).toContain(
      "deducts from every production worker",
    );
    await page!.type('[aria-label="Row 1: from this many billable lates"]', "6");
    expect(text('[aria-label="Row 1: from this many billable lates"] ~ p')).toContain(
      "6 is used by more than one row.",
    );
    expect(buttonNamed("Save Production Late Detection")?.disabled).toBe(true);
    await page!.type('[aria-label="Row 1: from this many billable lates"]', "2");
    await page!.type("#weekly-late-allowance-input", "4");
    await press("Add Slab");
    expect(document.body.querySelectorAll('[data-testid="weekly-slab-table"] tbody tr')).toHaveLength(3);

    await press("Save Production Late Detection");
    const dialog = text('[data-testid="confirm-production-late"]');
    expect(dialog).toContain("Weekly: free late days a period");
    expect(dialog).toContain("Weekly: deduction slabs");
    expect(dialog).toContain("Weekly stops following the shared production values");
    expect(dialog).toContain("pay period rules of the cycles");
    expect(puts).toHaveLength(0);
    await press("Confirm and save");
    expect(puts).toEqual([
      {
        prodCycles: {
          weekly: {
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
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Production Late Detection saved" }));
    // the cycle's period rule on the server is exactly what it was (the save never carried it)
    expect(stored.weekly.weekStart).toBe("sunday");
    expect(stored.biweekly.anchorDate).toBe("2026-09-21");
    expect(text('[data-testid="weekly-late-source"]')).toContain("Weekly has late rules of its own.");

    // and it can be handed back to the shared ones with nulls
    await press("Use the shared rules again");
    expect(text('[role="alertdialog"]')).toContain("Use the shared late rules for Weekly again?");
    await press("Use the shared rules");
    expect(puts[1]).toEqual({ prodCycles: { weekly: { lateFreeAllowance: null, lateSlabs: null } } });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Weekly uses the shared late rules again" }));
    expect(text('[data-testid="weekly-late-source"]')).toContain("Using the shared production values");
    expect(input("#weekly-late-allowance-input").value).toBe("3");
    expect(document.body.querySelectorAll('[data-testid="weekly-slab-table"] tbody tr')).toHaveLength(2);
    expect(stored.weekly).toEqual({ weekStart: "sunday" });
    expect(q('[data-testid="save-bar"]')?.dataset.dirty).toBe("false");
  });

  it("shows what it saved the way the server writes it, with nothing left unsaved (a typed 4.0 becomes 4)", async () => {
    await open();
    await openPill("Production");
    await page!.type("#weekly-late-allowance-input", "4.0");
    expect(text('[data-testid="save-bar"]')).toContain("You have changes that are not saved yet.");
    await press("Save Production Late Detection");
    await press("Confirm and save");
    expect(puts).toEqual([{ prodCycles: { weekly: { lateFreeAllowance: 4 } } }]);
    expect(input("#weekly-late-allowance-input").value).toBe("4");
    expect(q('[data-testid="save-bar"]')?.dataset.dirty).toBe("false");
    expect(buttonNamed("Save Production Late Detection")?.disabled).toBe(true);
  });

  it("saves the switch and the mode alone when only they changed", async () => {
    await open();
    await openPill("Production");
    await choose("#prod-attendance-mode-input", "simple");
    await act(async () => (q("#prod-late-enabled") as HTMLButtonElement).click());
    await page!.settle();
    await press("Save Production Late Detection");
    expect(text('[data-testid="confirm-production-late"]')).toContain("What counts as late");
    expect(text('[data-testid="confirm-production-late"]')).toContain("Late deductions");
    await press("Confirm and save");
    expect(puts).toEqual([{ prodAttendanceMode: "simple", prodLateDetectionEnabled: false }]);
  });

  it("a BiWeekly edit stays while Weekly is open, and says so; the pills keep both pages' edits", async () => {
    await open();
    await openPill("Production");
    await openPill("BiWeekly");
    await page!.type("#biweekly-late-allowance-input", "2");
    await openPill("Weekly");
    expect(page!.text()).toContain("Not saved yet: BiWeekly");
    await openPill("BiWeekly");
    expect(input("#biweekly-late-allowance-input").value).toBe("2");
    // a staff edit made on the other page survives a visit to this one
    await openPill("Staff");
    expect(page!.text()).toContain("Not saved yet: Production");
    await page!.type("#late-free-allowance", "6");
    await openPill("Production");
    expect(page!.text()).toContain("Not saved yet: Staff");
    await openPill("Staff");
    expect(input("#late-free-allowance").value).toBe("6");
    await openPill("Production");
    await openPill("BiWeekly");
    expect(input("#biweekly-late-allowance-input").value).toBe("2");
  });

  it("lists the other cycles' unsaved late edits next to the cycle pills", async () => {
    await open();
    await openPill("Production");
    await page!.type("#weekly-late-allowance-input", "5");
    await openPill("Monthly");
    expect(text('[data-testid="production-late-cycle-unsaved"]')).toBe("Not saved yet: Weekly");
  });

  it("view only: every field and every Save button is disabled", async () => {
    await open(SAVED, { readOnly: true });
    await openPill("Production");
    expect((q("#prod-late-enabled") as HTMLButtonElement).disabled).toBe(true);
    expect(input("#weekly-late-allowance-input").disabled).toBe(true);
    expect(input('[aria-label="Row 1: from this many billable lates"]').disabled).toBe(true);
    expect(buttonNamed("Add Slab")?.disabled).toBe(true);
    expect(buttonNamed("Save Production Late Detection")?.disabled).toBe(true);
    await openPill("BiWeekly");
    expect(buttonNamed("Use the shared rules again")?.disabled).toBe(true);
  });

  it("opens on the page and the cycle that a setting's address names", async () => {
    window.history.replaceState(null, "", "/hr/settings?tab=late_detection#biweekly-late-slabs");
    await open();
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("true");
    expect(tabNamed("BiWeekly")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="biweekly-late-slabs"]')).not.toBeNull();
    expect(text('[data-testid="biweekly-late-source"]')).toContain("BiWeekly has late rules of its own.");
  });

  it("opens on the Production page when the address asks for it, and on a staff setting's page for a staff setting", async () => {
    window.history.replaceState(null, "", "/hr/settings?tab=late_detection&view=production");
    await open();
    expect(tabNamed("Production")?.getAttribute("aria-selected")).toBe("true");
    page!.unmount();
    window.history.replaceState(null, "", "/hr/settings?tab=late_detection&view=production#permission-cap");
    await open();
    expect(tabNamed("Staff")?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-setting-id="permission-cap"]')).not.toBeNull();
  });
});

describe("Settings -> Late Detection: the search catalogue", () => {
  it("has a search entry for every setting it draws on each page, with the same title and words", async () => {
    await open({ ...SAVED, ...PRICING });
    const seen = new Set<string>();
    for (const [pill, view] of [
      ["Staff", "staff"],
      ["Production", "production"],
    ] as const) {
      await openPill(pill);
      const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
      for (const b of page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")) {
        const meta = LATE_DETECTION_SETTINGS.find((m) => m.id === b.dataset.settingId);
        expect(meta, b.dataset.settingId).toBeTruthy();
        expect(LATE_VIEW_OF[meta!.id], `${meta!.id} is drawn on the ${view} page`).toBe(view);
        expect(b.querySelector("h4")?.textContent?.trim(), meta!.id).toBe(meta!.title);
        expect(b.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta!.id).toBe(meta!.purpose);
        expect(b.closest("section:not([data-setting-id])")?.querySelector("h3")?.textContent?.trim()).toBe(
          meta!.section,
        );
        seen.add(meta!.id);
      }
    }
    // Weekly is open on the Production page: the other two cycles' blocks are drawn from their own pills
    for (const cycle of ["BiWeekly", "Monthly"]) {
      await openPill(cycle);
      for (const b of page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")) {
        const meta = LATE_DETECTION_SETTINGS.find((m) => m.id === b.dataset.settingId);
        expect(meta, b.dataset.settingId).toBeTruthy();
        expect(b.querySelector("h4")?.textContent?.trim(), meta!.id).toBe(meta!.title);
        expect(b.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta!.id).toBe(meta!.purpose);
        seen.add(meta!.id);
      }
    }
    expect([...seen].sort()).toEqual(LATE_DETECTION_SETTINGS.map((m) => m.id).sort());
  });
});
