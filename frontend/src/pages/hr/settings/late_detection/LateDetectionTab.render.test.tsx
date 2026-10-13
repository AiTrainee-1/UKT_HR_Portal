import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import LateDetectionTab from "../LateDetectionTab";
import { LATE_DETECTION_SETTINGS } from "../LateDetectionTab.meta";

// jsdom render checks of Settings -> Late Detection with a fake server: the two policies with their own Save, a
// confirm before each, each request carrying only its own keys, the examples following what is typed, the plain links
// to the Attendance switches, and the company-wide cap locked for a branch login.

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
};

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];

beforeEach(() => {
  puts = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open(saved: Record<string, unknown> = SAVED) {
  let current = { ...saved };
  page = await renderMdPage(
    () => <LateDetectionTab />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
      "/api/payroll-settings": (_params, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(body);
          current = { ...current, ...body };
        }
        return current;
      },
    },
    { path: "/hr/settings?tab=late_detection" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ");
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}

describe("Settings -> Late Detection", () => {
  it("says it is for staff, links to the Attendance switches and to the production rules", async () => {
    await open();
    expect(page!.text()).toContain("Late Detection Policy");
    expect(page!.text()).toContain("Permission Policy");
    expect(page!.text()).toContain("Staff only");
    expect(q('[data-testid="link-morning-late-in"]')?.getAttribute("href")).toBe(
      "/hr/settings?tab=attendance#morning-late-in",
    );
    expect(text('[data-testid="late-detection-switch-status"]')).toContain("Morning Late-In marks (a first");
    expect(text('[data-testid="late-detection-switch-status"]')).toContain("not counted (switched off)");
    expect(q('[data-testid="late-production-elsewhere"] a')?.getAttribute("href")).toBe(
      "/hr/settings?tab=production_payroll",
    );
    // the old read-only switch chips are gone: no control for the Attendance switches here
    expect(document.body.querySelector('[role="switch"]')).toBeNull();
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

  it("has a search entry for every setting it draws, with the same title and words", async () => {
    await open();
    const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const blocks = [...page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")];
    expect(blocks.map((b) => b.dataset.settingId).sort()).toEqual(LATE_DETECTION_SETTINGS.map((m) => m.id).sort());
    for (const meta of LATE_DETECTION_SETTINGS) {
      const block = blocks.find((b) => b.dataset.settingId === meta.id)!;
      expect(block.querySelector("h4")?.textContent?.trim(), meta.id).toBe(meta.title);
      expect(block.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta.id).toBe(meta.purpose);
      expect(block.closest("section:not([data-setting-id])")?.querySelector("h3")?.textContent?.trim()).toBe(
        meta.section,
      );
    }
  });
});
