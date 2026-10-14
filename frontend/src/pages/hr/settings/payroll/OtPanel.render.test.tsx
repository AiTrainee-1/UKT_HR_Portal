import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import PayrollTab from "../PayrollTab";

// Settings -> Payroll -> "OT / Compensation" now holds ONLY the master switch of the OT & Compensation features (its
// confirm-on-OFF, its save-as-you-switch) and a link to the Compensation tab, where every rule and every feature switch is.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const SAVED = {
  companyName: "UK Textiles",
  companyLogo: null,
  compensationFeatureEnabled: true,
  companyWideRulesEditable: true,
  staffPayrollRulesEnabled: true,
  pfRate: 12,
  esiRate: 0.75,
  esiApplicableBelow: 21000,
  // the old OT values are still stored by the server (they are superseded, never dropped)
  otDetectionEnabled: true,
  otThresholdMinutes: 60,
  otCompensationType: "relaxation",
};

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];

beforeEach(() => {
  puts = [];
  toast.mockClear();
  window.history.replaceState(null, "", "/hr/settings?tab=payroll#compensation-features");
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

async function open(saved: Record<string, unknown> = SAVED, props: { readOnly?: boolean } = {}) {
  let current = { ...saved };
  page = await renderMdPage(
    () => <PayrollTab {...props} />,
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
    { path: "/hr/settings?tab=payroll" },
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

describe("Settings -> Payroll -> OT / Compensation", () => {
  it("is opened by the address of the master switch and shows only that switch", async () => {
    await open();
    expect(q('[data-testid="toggle-compensation-features"]')?.getAttribute("aria-checked")).toBe("true");
    expect(page!.text()).toContain("OT & Compensation Features");
    expect(page!.text()).toContain("OT pay");
    // the old OT inputs are gone: no detection switch, no threshold, no Pay-or-Relaxation default, no OT save button
    expect(q("#ot-detection-enabled")).toBeNull();
    expect(q("#ot-threshold-input")).toBeNull();
    expect(q('[data-setting-id="ot-detection"]')).toBeNull();
    expect(q('[data-setting-id="ot-threshold"]')).toBeNull();
    expect(buttonNamed("Save OT / Compensation Settings")).toBeUndefined();
    expect(q('[data-testid="ot-type-pointer"]')).toBeNull();
    // only the master switch is a setting here
    expect(
      [...page!.container.querySelectorAll("[data-setting-id]")].map((e) => e.getAttribute("data-setting-id")),
    ).toEqual(["compensation-features"]);
  });

  it("links to the Compensation tab, where the rules for OT, relaxation and payment now are", async () => {
    await open();
    const pointer = q('[data-testid="ot-rules-moved"]')!;
    expect(pointer.textContent).toContain("Rules for OT, relaxation and payment are now in the Compensation tab");
    const link = pointer.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/hr/settings?tab=compensation");
    expect(link.textContent).toContain("Open the Compensation tab");
    expect(pointer.textContent).toContain("Type 1");
    expect(pointer.textContent).toContain("Type 2");
    expect(pointer.textContent).toContain("Relaxation");
    expect(pointer.textContent).toContain("Payment");
    expect(pointer.textContent).toContain("birthday");
    expect(pointer.textContent).toContain("old values are kept but no longer used");
  });

  it("turning the switch off asks first; Keep them on changes nothing", async () => {
    await open();
    await page!.click('[data-testid="toggle-compensation-features"]');
    const dialog = q('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Turn off the OT & Compensation features?");
    expect(dialog.textContent).toContain("Compensation page stays in the sidebar");
    expect(dialog.textContent).toContain("next-day late-in allowance");
    expect(dialog.textContent).toContain("birthday leave");
    expect(puts).toHaveLength(0);
    await press("Keep them on");
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(q('[data-testid="toggle-compensation-features"]')?.getAttribute("aria-checked")).toBe("true");
    expect(puts).toHaveLength(0);
  });

  it("saves the switch as it is switched, sending only that key, and again with no question when it is switched on", async () => {
    await open();
    await page!.click('[data-testid="toggle-compensation-features"]');
    await page!.click('[data-testid="confirm-compensation-features-off"]');
    expect(puts).toEqual([{ compensationFeatureEnabled: false }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "OT & Compensation features OFF" }));
    expect(q('[data-testid="toggle-compensation-features"]')?.getAttribute("aria-checked")).toBe("false");
    expect(text('[data-setting-id="compensation-features"]')).toContain("no OT pay");

    await page!.click('[data-testid="toggle-compensation-features"]');
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(puts).toEqual([{ compensationFeatureEnabled: false }, { compensationFeatureEnabled: true }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "OT & Compensation features ON" }));
    expect(q('[data-testid="toggle-compensation-features"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("no Payroll save sends any of the old OT keys", async () => {
    await open();
    await page!.click('[data-testid="toggle-compensation-features"]');
    await page!.click('[data-testid="confirm-compensation-features-off"]');
    for (const body of puts) {
      expect(Object.keys(body)).not.toContain("otDetectionEnabled");
      expect(Object.keys(body)).not.toContain("otThresholdMinutes");
      expect(Object.keys(body)).not.toContain("otCompensationType");
    }
  });

  it("leaves the switch alone for a view-only role", async () => {
    await open(SAVED, { readOnly: true });
    expect((q('[data-testid="toggle-compensation-features"]') as HTMLButtonElement).disabled).toBe(true);
    // the link is for looking, so it still works
    expect(q('[data-testid="ot-rules-moved"] a')?.getAttribute("href")).toBe("/hr/settings?tab=compensation");
  });
});
