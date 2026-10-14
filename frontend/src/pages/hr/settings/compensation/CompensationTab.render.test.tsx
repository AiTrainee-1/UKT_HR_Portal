import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import type { CompensationSettings } from "@/lib/api-client/custom-hooks";
import CompensationTab from "../CompensationTab";
import { COMPENSATION_SECTIONS, COMPENSATION_SETTINGS } from "../CompensationTab.meta";

// jsdom render checks of Settings -> Compensation with a small in-memory copy of the server: what the tab shows from the
// saved settings, editing / adding / removing rules, the switches, the checks that mirror the server, the exact request a
// save sends, a refused save, the master-switch notice, the view-only role and a failed load.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

/** The defaults the server seeds, as the API contract shows them. */
const SEEDED: CompensationSettings = {
  masterEnabled: true,
  allowance: { enabled: true, effectiveFrom: "2026-10-14" },
  shift: { enabled: true, minExtraMinutes: 150, relaxationEnabled: true, payEnabled: false },
  windows: { enabled: false },
  holidayWork: { enabled: false },
  birthday: { enabled: false, effectiveFrom: null },
  allowanceRules: [
    { id: 1, label: "1 hour", enabled: true, minExtraMinutes: 60, allowanceMinutes: 30, sortOrder: 1 },
    { id: 2, label: "1 hour 30 minutes", enabled: true, minExtraMinutes: 90, allowanceMinutes: 30, sortOrder: 2 },
    { id: 3, label: "2 hours", enabled: true, minExtraMinutes: 120, allowanceMinutes: 60, sortOrder: 3 },
    { id: 4, label: "2 hours 30 minutes", enabled: true, minExtraMinutes: 150, allowanceMinutes: 60, sortOrder: 4 },
  ],
  shiftRules: [
    { id: 5, label: "Up to 9:00 PM", enabled: true, untilMinutes: 1260, shifts: 0.25, sortOrder: 1 },
    { id: 6, label: "Up to 12:00 AM", enabled: true, untilMinutes: 1440, shifts: 0.5, sortOrder: 2 },
    { id: 7, label: "Up to 2:00 AM next day", enabled: true, untilMinutes: 1560, shifts: 0.75, sortOrder: 3 },
    { id: 8, label: "No time limit", enabled: true, untilMinutes: null, shifts: 1, sortOrder: 4 },
  ],
  updatedBy: "Asha",
  updatedAt: "2026-10-14T10:00:00+05:30",
};

type Put = Record<string, unknown> & {
  allowance?: Record<string, unknown>;
  shift?: Record<string, unknown>;
  birthday?: Record<string, unknown>;
  allowanceRules?: {
    id?: number;
    label: string;
    enabled: boolean;
    minExtraMinutes: number;
    allowanceMinutes: number;
    sortOrder: number;
  }[];
  shiftRules?: {
    id?: number;
    label: string;
    enabled: boolean;
    untilMinutes: number | null;
    shifts: number;
    sortOrder: number;
  }[];
};

/**
 * The server in a few lines (backend/api/compensation_settings_views.py): groups merge, the rule tables replace the set and
 * get ids, a feature switched ON again with no date named starts today, and the answer is the new body plus `warnings`.
 */
function makeServer(initial: CompensationSettings) {
  const server = {
    current: structuredClone(initial) as CompensationSettings,
    puts: [] as Put[],
    refuse: null as { status: number; error: string } | null,
    down: false,
    nextId: 100,
    /** The warnings the next save answers with. */
    warnings: [] as string[],
    /** Answer a save with just {ok: true} (no body), as the contract first described it. */
    bare: false,
  };
  const handler = (_params: URLSearchParams, init?: RequestInit) => {
    if (server.down) return { status: 500, body: { error: "boom" } };
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Put;
      server.puts.push(body);
      if (server.refuse) return { status: server.refuse.status, body: { error: server.refuse.error } };
      const now = server.current;
      for (const group of ["allowance", "birthday"] as const) {
        const change = body[group] as { enabled?: boolean; effectiveFrom?: string } | undefined;
        if (change?.enabled === true && !now[group].enabled && change.effectiveFrom === undefined) {
          now[group].effectiveFrom = "2026-10-14";
        }
      }
      for (const group of ["allowance", "shift", "windows", "holidayWork", "birthday"] as const) {
        const change = body[group];
        if (change) Object.assign(now[group], change);
      }
      if (body.allowanceRules) {
        now.allowanceRules = body.allowanceRules.map((r) => ({ ...r, id: r.id ?? server.nextId++ }));
      }
      if (body.shiftRules) now.shiftRules = body.shiftRules.map((r) => ({ ...r, id: r.id ?? server.nextId++ }));
      return server.bare ? { ok: true } : { ...now, warnings: server.warnings };
    }
    return server.current;
  };
  return { server, handler };
}

let page: RenderedPage | undefined;
let server: ReturnType<typeof makeServer>["server"];

beforeEach(() => {
  toast.mockClear();
  // only the date is frozen (today in India is 14 Oct 2026); timers stay real so the page can settle
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.useRealTimers();
});

async function open(initial: CompensationSettings = SEEDED, props: { readOnly?: boolean } = {}) {
  const made = makeServer(initial);
  server = made.server;
  page = await renderMdPage(
    () => <CompensationTab {...props} />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
      "/api/compensation/settings": made.handler,
    },
    { path: "/hr/settings?tab=compensation" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ");
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const aria = (label: string) => `[aria-label="${label}"]`;
/** A control of the Type 2 table (both tables number their rules from 1). */
const ladder = (label: string) => `[data-testid="shift-table"] [aria-label="${label}"]`;
const value = (selector: string) => (q(selector) as HTMLInputElement | HTMLSelectElement).value;
const saveButton = () => buttonNamed("Save Compensation Settings")!;
const saveBar = () => q('[data-testid="save-bar"]')!;

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}

async function choose(selector: string, next: string) {
  await act(async () => {
    const select = q(selector) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, next);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

/** Leave a box: for the page (no next box), or for another box (focus moving on to it). */
async function leave(selector: string, nextSelector?: string) {
  await act(async () => {
    const relatedTarget = nextSelector ? q(nextSelector) : null;
    q(selector)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));
  });
  await page!.settle();
}

describe("Settings -> Compensation: what it shows", () => {
  it("draws the master strip, the five sections, both rule tables and the examples from the saved settings", async () => {
    await open();
    const strip = q('[data-testid="compensation-master-strip"]')!;
    expect(strip.dataset.state).toBe("on");
    expect(text('[data-testid="compensation-master-status"]')).toBe("OT and Compensation features are ON");
    expect(text('[data-testid="compensation-staff-only"]')).toBe("Staff employees only");
    expect(q('[data-testid="link-master-switch"]')?.getAttribute("href")).toBe(
      "/hr/settings?tab=payroll#compensation-features",
    );
    expect(text('[data-testid="compensation-updated"]')).toContain("Last saved by Asha on 14 Oct 2026");

    for (const title of Object.values(COMPENSATION_SECTIONS)) expect(page!.text()).toContain(title);
    expect(qa('[data-testid="allowance-row"]')).toHaveLength(4);
    expect(qa('[data-testid="shift-row"]')).toHaveLength(4);

    // switches as saved
    expect(q("#compensation-allowance-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(q("#compensation-shift-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(q("#compensation-relaxation-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(q("#compensation-pay-switch")?.getAttribute("aria-checked")).toBe("false");
    expect(q("#compensation-windows-switch")?.getAttribute("aria-checked")).toBe("false");
    expect(q("#compensation-holiday-work-switch")?.getAttribute("aria-checked")).toBe("false");
    expect(q("#compensation-birthday-switch")?.getAttribute("aria-checked")).toBe("false");

    // dates and the threshold
    expect(value("#compensation-allowance-from")).toBe("2026-10-14");
    expect(value("#compensation-birthday-from")).toBe("");
    expect(value("#compensation-shift-threshold")).toBe("150");

    // rows as saved: Type 1 in hours and minutes, Type 2 as clock times
    expect(value(aria("Rule 2: name"))).toBe("1 hour 30 minutes");
    expect(value(aria("Rule 2: hours of extra work"))).toBe("1");
    expect(value(aria("Rule 2: minutes of extra work"))).toBe("30");
    expect(value(aria("Rule 3: allowance minutes"))).toBe("60");
    expect(
      qa(`[data-testid="shift-row"] input[aria-label$="last punch-out before"]`).map(
        (i) => (i as HTMLInputElement).value,
      ),
    ).toEqual(["9:00 PM", "12:00 AM", "2:00 AM next day", ""]);
    expect((q(aria("Rule 4: no upper limit")) as HTMLInputElement).checked).toBe(true);
    expect(value(aria("Rule 2: shifts"))).toBe("0.5");

    // nothing is changed yet
    expect(saveBar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
  });

  it("works the Type 1 example from the rows: 2 hours extra is 60 minutes, so the first punch is not Late up to 10:10 AM", async () => {
    await open();
    expect(text('[data-testid="type1-allowance-line"]')).toContain("Works until 7:30 PM (2 hours extra)");
    expect(text('[data-testid="type1-allowance-line"]')).toContain('Allowance 60 minutes (row "2 hours")');
    const lines = qa('[data-testid="type1-punch-line"]').map((l) => (l.textContent ?? "").replace(/\s+/g, " "));
    expect(lines).toEqual([
      "Next morning, first punch 9:10 AMOn time: the allowance is not used, nothing is marked",
      "Next morning, first punch 9:40 AMNot Late: marked Compensation",
      "Next morning, first punch 10:10 AMNot Late: marked Compensation",
      "Next morning, first punch 10:11 AMAfter the allowance: the normal Late rules judge it",
    ]);
    expect(text('[data-testid="type1-limit-note"]')).toContain("not Late up to 10:10 AM");

    // try 45 minutes of extra work: below the smallest row
    await page!.type("#type1-try-extra", "45");
    expect(text('[data-testid="type1-allowance-line"]')).toContain(
      "No allowance: less than the smallest row that is on",
    );
    // 100 minutes: the 1 hour 30 minutes row
    await page!.type("#type1-try-extra", "100");
    expect(text('[data-testid="type1-allowance-line"]')).toContain('Allowance 30 minutes (row "1 hour 30 minutes")');
    // exactly where Type 2 starts (2 h 30) is still Type 1's; more than that is Type 2's
    await page!.type("#type1-try-extra", "150");
    expect(text('[data-testid="type1-allowance-line"]')).toContain('Allowance 60 minutes (row "2 hours 30 minutes")');
    await page!.type("#type1-try-extra", "151");
    expect(text('[data-testid="type1-allowance-line"]')).toContain(
      "No allowance: more than 2 h 30 min of extra work is Type 2's",
    );
    await page!.type("#type1-try-extra", "abc");
    expect(text('[data-testid="type1-example"]')).toContain("Enter a number");
  });

  it("works the Type 2 example from the ladder: the shift of five last punch-outs and what it means", async () => {
    await open();
    const lines = qa('[data-testid="type2-line"]').map((l) => (l.textContent ?? "").replace(/\s+/g, " "));
    expect(lines).toEqual([
      "Last punch-out 8:00 PM (2 h 30 min after the 5:30 PM end)Not Type 2: not more than 2 h 30 min past the end",
      "Last punch-out 8:30 PM (3 h after the 5:30 PM end)0.25 shift = a quarter of a day off as Relaxation",
      "Last punch-out 10:30 PM (5 h after the 5:30 PM end)0.50 shift = half a day off as Relaxation",
      "Last punch-out 12:40 AM next day (7 h 10 min after the 5:30 PM end)0.75 shift = three quarters of a day off as Relaxation",
      "Last punch-out 3:15 AM next day (9 h 45 min after the 5:30 PM end)1.00 shift = one whole day off as Relaxation",
    ]);
    // the try-it box starts at 11:40 PM: 0.50 shift
    expect(text('[data-testid="type2-try-line"]')).toContain("0.50 shift");
    await page!.type("#type2-try-punch", "1:30 AM next day");
    expect(text('[data-testid="type2-try-line"]')).toContain("0.75 shift");
    await page!.type("#type2-try-punch", "soon");
    expect(text('[data-testid="type2-example"]')).toContain("Write a clock time");
  });

  it("puts the money in the Type 2 example only while Payment is on, and drops Relaxation while that is off", async () => {
    await open();
    expect(text('[data-testid="type2-example"]')).not.toContain("Payment");
    await page!.click("#compensation-pay-switch");
    expect(text('[data-testid="type2-example"]')).toContain(
      "0.25 shift = a quarter of a day off as Relaxation or ₹250.00 as Payment",
    );
    expect(text('[data-testid="type2-example"]')).toContain(
      "1.00 shift = one whole day off as Relaxation or ₹1,000.00 as Payment",
    );
    await page!.click("#compensation-relaxation-switch");
    expect(text('[data-testid="type2-example"]')).toContain("0.50 shift = ₹500.00 as Payment");
    expect(text('[data-testid="type2-example"]')).not.toContain("Relaxation");
    // neither: the server refuses that, so the form says so (and will not save), and the example says so too
    await page!.click("#compensation-pay-switch");
    expect(text('[data-testid="shift-mode-error"]')).toBe(
      "Type 2 is switched on: switch on Relaxation, Payment or both, or switch Type 2 off.",
    );
    expect(saveButton().disabled).toBe(true);
    expect(text('[data-testid="type2-example"]')).toContain("(neither Relaxation nor Payment is on)");
    // Type 2 off: nothing to choose
    await page!.click("#compensation-shift-switch");
    expect(q('[data-testid="shift-mode-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("says Payment applies to Type 2 only, that Type 1 is automatic and never paid, and links the approval pipeline", async () => {
    await open();
    expect(text('[data-testid="setting-shift-pay"]')).toContain("Payment applies to Type 2 only");
    expect(text('[data-testid="setting-allowance-enabled"]')).toContain("automatic and never paid");
    expect(q('[data-testid="link-approval-workflow"]')?.getAttribute("href")).toBe("/hr/user-management?tab=approvals");
    expect(text('[data-testid="setting-holiday-work-enabled"]')).toContain("Department Head approves");
    expect(text('[data-testid="setting-windows-enabled"]')).toContain("grace do not apply");
    expect(text('[data-testid="setting-birthday-enabled"]')).toContain("no attendance detection applies that day");
  });

  it("tells HR when the master switch is off: still editable, but nothing acts", async () => {
    await open({ ...SEEDED, masterEnabled: false });
    const strip = q('[data-testid="compensation-master-strip"]')!;
    expect(strip.dataset.state).toBe("off");
    expect(text('[data-testid="compensation-master-status"]')).toBe("OT and Compensation features are OFF");
    expect(strip.textContent).toContain("none of it acts");
    expect(q('[data-testid="link-master-switch"]')?.getAttribute("href")).toBe(
      "/hr/settings?tab=payroll#compensation-features",
    );
    // every switch and box is still editable
    expect((q("#compensation-allowance-switch") as HTMLButtonElement).disabled).toBe(false);
    expect((q(aria("Rule 1: allowance minutes")) as HTMLInputElement).disabled).toBe(false);
    // and each feature says it does nothing yet
    for (const id of ["allowance-enabled", "shift-enabled", "shift-pay", "windows-enabled", "birthday-enabled"]) {
      expect(text(`[data-testid="setting-${id}"]`), id).toContain("master switch");
    }
  });
});

describe("Settings -> Compensation: editing and saving", () => {
  it("sends the whole form, with the edited value and the rows' ids, then reads it back and is clean again", async () => {
    await open();
    await page!.type(aria("Rule 3: allowance minutes"), "45");
    expect(saveBar().dataset.dirty).toBe("true");
    expect(saveButton().disabled).toBe(false);
    // the example follows what is typed, not what is saved
    expect(text('[data-testid="type1-allowance-line"]')).toContain('Allowance 45 minutes (row "2 hours")');
    expect(server.puts).toHaveLength(0);

    await press("Save Compensation Settings");
    expect(server.puts).toHaveLength(1);
    const put = server.puts[0];
    expect(Object.keys(put).sort()).toEqual([
      "allowance",
      "allowanceRules",
      "birthday",
      "holidayWork",
      "shift",
      "shiftRules",
      "windows",
    ]);
    expect(put.allowance).toEqual({ enabled: true, effectiveFrom: "2026-10-14" });
    expect(put.shift).toEqual({ enabled: true, minExtraMinutes: 150, relaxationEnabled: true, payEnabled: false });
    expect(put.allowanceRules).toEqual([
      { id: 1, label: "1 hour", enabled: true, minExtraMinutes: 60, allowanceMinutes: 30, sortOrder: 1 },
      { id: 2, label: "1 hour 30 minutes", enabled: true, minExtraMinutes: 90, allowanceMinutes: 30, sortOrder: 2 },
      { id: 3, label: "2 hours", enabled: true, minExtraMinutes: 120, allowanceMinutes: 45, sortOrder: 3 },
      { id: 4, label: "2 hours 30 minutes", enabled: true, minExtraMinutes: 150, allowanceMinutes: 60, sortOrder: 4 },
    ]);
    expect(put.shiftRules?.map((r) => [r.id, r.untilMinutes, r.shifts, r.sortOrder])).toEqual([
      [5, 1260, 0.25, 1],
      [6, 1440, 0.5, 2],
      [7, 1560, 0.75, 3],
      [8, null, 1, 4],
    ]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Compensation settings saved" }));
    // refetched: clean, and the saved value is what the server now holds
    expect(saveBar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
    expect(value(aria("Rule 3: allowance minutes"))).toBe("45");
    expect(server.current.allowanceRules[2].allowanceMinutes).toBe(45);
    // the server answers a save with the new body: nothing more is read (the load and the save)
    expect(page!.requests().filter((r) => r.startsWith("/api/compensation/settings"))).toHaveLength(2);
  });

  it("reads the settings back when the server's answer to a save has no body", async () => {
    await open();
    server.bare = true;
    await page!.type(aria("Rule 3: allowance minutes"), "45");
    await press("Save Compensation Settings");
    expect(page!.requests().filter((r) => r.startsWith("/api/compensation/settings"))).toHaveLength(3);
    expect(saveBar().dataset.dirty).toBe("false");
    expect(value(aria("Rule 3: allowance minutes"))).toBe("45");
  });

  it("shows the server's warnings about what was saved, and keeps them until the next save", async () => {
    await open();
    const warning =
      "The '2 hours 30 minutes' allowance can never apply: shift-based compensation already starts at 2 hours of extra work.";
    server.warnings = [warning];
    await page!.type("#compensation-shift-threshold", "120");
    await press("Save Compensation Settings");
    expect(text('[data-testid="compensation-warnings"]')).toContain(warning);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Compensation settings saved",
        description: expect.stringContaining("Saved, with a warning:"),
      }),
    );
    expect(saveBar().dataset.dirty).toBe("false");
    server.warnings = [];
    await page!.type("#compensation-shift-threshold", "150");
    await press("Save Compensation Settings");
    expect(q('[data-testid="compensation-warnings"]')).toBeNull();
  });

  it("changes a rule's hours and minutes, and the automatic name follows until HR types one", async () => {
    await open();
    await page!.type(aria("Rule 1: minutes of extra work"), "15");
    expect(value(aria("Rule 1: name"))).toBe("1 hour 15 minutes");
    await page!.type(aria("Rule 2: name"), "Standard");
    await page!.type(aria("Rule 2: hours of extra work"), "1");
    await page!.type(aria("Rule 2: minutes of extra work"), "45");
    expect(value(aria("Rule 2: name"))).toBe("Standard");
    await press("Save Compensation Settings");
    expect(server.puts[0].allowanceRules?.slice(0, 2)).toEqual([
      { id: 1, label: "1 hour 15 minutes", enabled: true, minExtraMinutes: 75, allowanceMinutes: 30, sortOrder: 1 },
      { id: 2, label: "Standard", enabled: true, minExtraMinutes: 105, allowanceMinutes: 30, sortOrder: 2 },
    ]);
  });

  it("adds a rule to each table (no id yet), removes another (its id is left out), and gets the new ids back", async () => {
    await open();
    await page!.click('[data-testid="allowance-add"]');
    expect(qa('[data-testid="allowance-row"]')).toHaveLength(5);
    expect(value(aria("Rule 5: name"))).toBe("3 hours");
    expect(value(aria("Rule 5: hours of extra work"))).toBe("3");
    await page!.type(aria("Rule 5: allowance minutes"), "90");

    await page!.click('[data-testid="shift-add"]');
    expect(qa('[data-testid="shift-row"]')).toHaveLength(5);
    // it goes before the row with no limit, an hour after the latest limit
    expect(value(aria("Rule 4: last punch-out before"))).toBe("3:00 AM next day");
    expect((q(aria("Rule 5: no upper limit")) as HTMLInputElement).checked).toBe(true);

    await page!.click(aria("Remove rule 1")); // the first Type 1 rule (the Type 2 table has its own "Remove rule 1")
    expect(qa('[data-testid="allowance-row"]')).toHaveLength(4);

    await press("Save Compensation Settings");
    const put = server.puts[0];
    expect(put.allowanceRules?.map((r) => r.id)).toEqual([2, 3, 4, undefined]);
    expect(put.allowanceRules?.[3]).toEqual({
      label: "3 hours",
      enabled: true,
      minExtraMinutes: 180,
      allowanceMinutes: 90,
      sortOrder: 4,
    });
    expect(put.shiftRules?.map((r) => r.id)).toEqual([5, 6, 7, undefined, 8]);
    expect(put.shiftRules?.[3]).toMatchObject({ untilMinutes: 1620, shifts: 0.75, label: "Up to 3:00 AM next day" });

    // read back: the server's ids are on the rows, so saving again would not create them twice
    expect(server.current.allowanceRules.map((r) => r.id)).toEqual([2, 3, 4, 100]);
    expect(saveBar().dataset.dirty).toBe("false");
    await page!.type(aria("Rule 4: allowance minutes"), "80");
    await press("Save Compensation Settings");
    expect(server.puts[1].allowanceRules?.map((r) => r.id)).toEqual([2, 3, 4, 100]);
  });

  it("switches a rule off without removing it, and the example ignores it", async () => {
    await open();
    await page!.click(aria("Rule 3 in use")); // Type 1's "2 hours" row (the Type 2 table has its own Rule 3)
    // the 2 hours row is off: 2 hours of extra work now gets the 1 hour 30 minutes row
    expect(text('[data-testid="type1-allowance-line"]')).toContain('Allowance 30 minutes (row "1 hour 30 minutes")');
    await press("Save Compensation Settings");
    expect(server.puts[0].allowanceRules?.[2]).toMatchObject({ id: 3, enabled: false });
    expect(server.puts[0].allowanceRules).toHaveLength(4);
  });

  it("changes a switch and sends only what is on screen, the other features as they were", async () => {
    await open();
    await page!.click("#compensation-windows-switch");
    expect(q("#compensation-windows-switch")?.getAttribute("aria-checked")).toBe("true");
    await page!.click("#compensation-pay-switch");
    await page!.click("#compensation-holiday-work-switch");
    await page!.click("#compensation-allowance-switch");
    await press("Save Compensation Settings");
    const put = server.puts[0];
    expect(put.windows).toEqual({ enabled: true });
    expect(put.holidayWork).toEqual({ enabled: true });
    expect(put.allowance).toMatchObject({ enabled: false });
    expect(put.shift).toMatchObject({ enabled: true, relaxationEnabled: true, payEnabled: true });
    expect(put.birthday).toEqual({ enabled: false });
  });

  it("turns birthday leave on: the box shows today at once, the request names it, and switching back off undoes it", async () => {
    await open();
    expect(text('[data-testid="birthday-from"]')).toContain(
      "Not set yet: switching birthday leave on sets it to today",
    );
    await page!.click("#compensation-birthday-switch");
    expect(value("#compensation-birthday-from")).toBe("2026-10-14");
    expect(q('[data-testid="birthday-from-note"]')?.dataset.kind).toBe("today");
    // switched back off before saving: the automatic date goes again and nothing is changed
    await page!.click("#compensation-birthday-switch");
    expect(value("#compensation-birthday-from")).toBe("");
    expect(saveBar().dataset.dirty).toBe("false");

    await page!.click("#compensation-birthday-switch");
    await press("Save Compensation Settings");
    expect(server.puts[0].birthday).toEqual({ enabled: true, effectiveFrom: "2026-10-14" });
    expect(server.current.birthday).toEqual({ enabled: true, effectiveFrom: "2026-10-14" });
    expect(value("#compensation-birthday-from")).toBe("2026-10-14");
    expect(text('[data-testid="birthday-from-note"]')).toContain("From today (14 Oct 2026) on");
  });

  it("starts a feature that was off today when it is switched on again, not on its old date", async () => {
    await open({ ...SEEDED, allowance: { enabled: false, effectiveFrom: "2026-09-01" } });
    expect(value("#compensation-allowance-from")).toBe("2026-09-01");
    await page!.click("#compensation-allowance-switch");
    expect(value("#compensation-allowance-from")).toBe("2026-10-14");
    await press("Save Compensation Settings");
    expect(server.puts[0].allowance).toEqual({ enabled: true, effectiveFrom: "2026-10-14" });
    expect(server.current.allowance).toEqual({ enabled: true, effectiveFrom: "2026-10-14" });
  });

  it("keeps a date HR picked before switching the feature on, and warns that it reaches back", async () => {
    await open({ ...SEEDED, allowance: { enabled: false, effectiveFrom: "2026-09-01" } });
    await page!.type("#compensation-allowance-from", "2026-10-01");
    await page!.click("#compensation-allowance-switch");
    expect(value("#compensation-allowance-from")).toBe("2026-10-01");
    expect(q('[data-testid="allowance-from-note"]')?.dataset.kind).toBe("past");
    await press("Save Compensation Settings");
    expect(server.puts[0].allowance).toEqual({ enabled: true, effectiveFrom: "2026-10-01" });
  });

  it("discards the edits, and Discard is only there while something changed", async () => {
    await open();
    expect(buttonNamed("Discard changes")).toBeUndefined();
    await page!.type("#compensation-shift-threshold", "200");
    await page!.click("#compensation-windows-switch");
    expect(buttonNamed("Discard changes")).toBeDefined();
    await press("Discard changes");
    expect(value("#compensation-shift-threshold")).toBe("150");
    expect(q("#compensation-windows-switch")?.getAttribute("aria-checked")).toBe("false");
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("shows the server's own words when a save is refused, keeps the edits and sends nothing twice", async () => {
    await open();
    await page!.type("#compensation-shift-threshold", "200");
    server.refuse = { status: 400, error: "Type 2 needs at least one rule." };
    await press("Save Compensation Settings");
    expect(text('[data-testid="compensation-save-error"]')).toBe("Type 2 needs at least one rule.");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save the Compensation settings", variant: "destructive" }),
    );
    // still unsaved, and the value typed is still there
    expect(saveBar().dataset.dirty).toBe("true");
    expect(value("#compensation-shift-threshold")).toBe("200");
    expect(server.puts).toHaveLength(1);

    // the next save clears the message
    server.refuse = null;
    await press("Save Compensation Settings");
    expect(q('[data-testid="compensation-save-error"]')).toBeNull();
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("explains a refused login in plain words", async () => {
    await open();
    await page!.type("#compensation-shift-threshold", "200");
    server.refuse = { status: 403, error: "permission_denied" };
    await press("Save Compensation Settings");
    expect(text('[data-testid="compensation-save-error"]')).toBe(
      "Your login is not allowed to change the Compensation settings.",
    );
  });
});

describe("Settings -> Compensation: checks before anything is sent", () => {
  it("refuses a ladder that does not get later, says why, and sends nothing", async () => {
    await open();
    await page!.type(aria("Rule 2: last punch-out before"), "8:00 PM");
    expect(text('[data-testid="shift-order-error"]')).toBe(
      'Must be later than rule 1 (9:00 PM). For a time after midnight write it as "2:00 AM next day".',
    );
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain("Fix this first: Type 2, rule 2: Must be later than rule 1 (9:00 PM)");
    expect(server.puts).toHaveLength(0);
    // fixed: the message goes and the button comes back
    await page!.type(aria("Rule 2: last punch-out before"), "12:00 AM");
    expect(q('[data-testid="shift-order-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(true); // 12:00 AM is the saved value: nothing changed, nothing to save
    await page!.type(aria("Rule 2: last punch-out before"), "11:30 PM");
    expect(saveButton().disabled).toBe(false);
  });

  it("suggests 'next day' when a time after midnight is written without it", async () => {
    await open();
    await page!.type(aria("Rule 3: last punch-out before"), "2:00 AM");
    expect(text('[data-testid="shift-order-error"]')).toContain('write it as "2:00 AM next day"');
    await page!.type(aria("Rule 3: last punch-out before"), "2:00 AM next day");
    expect(q('[data-testid="shift-order-error"]')).toBeNull();
  });

  it("explains a time it cannot read, and a limit on the row that must stay last", async () => {
    await open();
    await page!.type(aria("Rule 1: last punch-out before"), "after dinner");
    expect(text('[data-testid="shift-table"]')).toContain("Write a clock time such as 9:00 PM");
    expect(saveButton().disabled).toBe(true);
    await page!.type(aria("Rule 1: last punch-out before"), "9:00 PM");

    // ticking "no upper limit" on row 2 sends it to the end (the open-ended row must be last): there are now two of them
    await page!.click(aria("Rule 2: no upper limit"));
    expect(text('[data-testid="shift-order-error"]')).toContain("Only the last rule can have no upper limit");
    expect(saveButton().disabled).toBe(true);
    expect(
      qa(`[data-testid="shift-row"] input[aria-label$="last punch-out before"]`).map(
        (i) => (i as HTMLInputElement).value,
      ),
    ).toEqual(["9:00 PM", "2:00 AM next day", "", ""]);
    // un-ticking the one that moved (now the third row) puts it back in its place and clears the message
    await page!.click(aria("Rule 3: no upper limit"));
    expect(q('[data-testid="shift-order-error"]')).toBeNull();
    expect(
      qa(`[data-testid="shift-row"] input[aria-label$="last punch-out before"]`).map(
        (i) => (i as HTMLInputElement).value,
      ),
    ).toEqual(["9:00 PM", "12:00 AM", "2:00 AM next day", ""]);
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("checks the Type 1 boxes, the allowance range, and a rule that repeats another's extra work", async () => {
    await open();
    await page!.type(aria("Rule 1: allowance minutes"), "300");
    expect(text('[data-testid="allowance-table"]')).toContain("Must be from 0 to 240.");
    expect(saveButton().disabled).toBe(true);
    await page!.type(aria("Rule 1: allowance minutes"), "240");
    expect(saveButton().disabled).toBe(false);

    await page!.type(aria("Rule 2: hours of extra work"), "1");
    await page!.type(aria("Rule 2: minutes of extra work"), "0");
    expect(text('[data-testid="allowance-table"]')).toContain(
      "Row 1 already uses 1 hour: each row needs a different amount of extra work.",
    );
    expect(saveButton().disabled).toBe(true);
    // switching the repeated row off is fine
    await page!.click(aria("Rule 2 in use"));
    expect(text('[data-testid="allowance-table"]')).not.toContain("already uses");
    expect(saveButton().disabled).toBe(false);
  });

  it("checks the threshold, and wants a rule on for a feature that is on", async () => {
    await open();
    await page!.type("#compensation-shift-threshold", "0");
    expect(text('[data-testid="shift-threshold-error"]')).toBe("Must be from 1 to 1,440.");
    await page!.type("#compensation-shift-threshold", "150");
    expect(q('[data-testid="shift-threshold-error"]')).toBeNull();

    for (const n of [1, 2, 3, 4]) await page!.click(aria(`Rule ${n} in use`));
    expect(text('[data-testid="allowance-table-error"]')).toContain("Type 1 is switched on but no rule is switched on");
    expect(saveButton().disabled).toBe(true);
    await page!.click("#compensation-allowance-switch");
    expect(q('[data-testid="allowance-table-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps the shifts to the four allowed amounts", async () => {
    await open();
    expect(qa(`${aria("Rule 1: shifts")} option`).map((o) => (o as HTMLOptionElement).value)).toEqual([
      "0.25",
      "0.5",
      "0.75",
      "1",
    ]);
    await choose(aria("Rule 1: shifts"), "1");
    expect(value(aria("Rule 1: shifts"))).toBe("1");
    await press("Save Compensation Settings");
    expect(server.puts[0].shiftRules?.[0]).toMatchObject({ id: 5, shifts: 1 });
  });

  it("wants the last rule that is on to have no upper limit, as the server does", async () => {
    await open();
    // the open-ended row off: the last rule that is on has a limit
    await page!.click(ladder("Rule 4 in use"));
    expect(text('[data-testid="shift-order-error"]')).toContain("The last rule that is on must have no upper limit");
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain(
      "Fix this first: Type 2, rule 3: The last rule that is on must have no upper limit",
    );
    // ticking it on that rule (now the last one on) fixes it
    await page!.click(ladder("Rule 3: no upper limit"));
    expect(q('[data-testid="shift-order-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    await press("Save Compensation Settings");
    expect(server.puts[0].shiftRules?.map((r) => [r.id, r.untilMinutes, r.enabled])).toEqual([
      [5, 1260, true],
      [6, 1440, true],
      [7, null, true],
      [8, null, false],
    ]);
  });

  it("adds a rule at the end WITH no upper limit when no rule that is on has none", async () => {
    await open();
    await page!.click(ladder("Rule 4 in use"));
    expect(q('[data-testid="shift-order-error"]')).not.toBeNull();
    await page!.click('[data-testid="shift-add"]');
    expect(qa('[data-testid="shift-row"]')).toHaveLength(5);
    expect((q(aria("Rule 5: no upper limit")) as HTMLInputElement).checked).toBe(true);
    expect(value(aria("Rule 5: name"))).toBe("No time limit");
    expect(q('[data-testid="shift-order-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    await press("Save Compensation Settings");
    expect(server.puts[0].shiftRules?.map((r) => [r.id, r.untilMinutes, r.enabled])).toEqual([
      [5, 1260, true],
      [6, 1440, true],
      [7, 1560, true],
      [8, null, false],
      [undefined, null, true],
    ]);
  });

  it("warns, without blocking, about an allowance row beyond where Type 2 starts (the server says the same)", async () => {
    await open();
    expect(q('[data-testid="allowance-warning"]')).toBeNull();
    await page!.type("#compensation-shift-threshold", "120");
    expect(text('[data-testid="allowance-warning"]')).toBe(
      "The '2 hours 30 minutes' allowance can never apply: shift-based compensation already starts at 2 hours of extra work.",
    );
    expect(saveButton().disabled).toBe(false);
    // the Type 1 example follows: more than the threshold is Type 2's
    await page!.type("#type1-try-extra", "130");
    expect(text('[data-testid="type1-allowance-line"]')).toContain(
      "No allowance: more than 2 h of extra work is Type 2's",
    );
    await page!.type("#compensation-shift-threshold", "150");
    expect(q('[data-testid="allowance-warning"]')).toBeNull();
    expect(text('[data-testid="type1-allowance-line"]')).toContain('Allowance 60 minutes (row "2 hours")');
  });

  it("understands a time when the box is left ('21:30' becomes '9:30 PM') and keeps the rows in time order", async () => {
    await open();
    await page!.type(aria("Rule 1: last punch-out before"), "21:30");
    await leave(aria("Rule 1: last punch-out before"));
    expect(value(aria("Rule 1: last punch-out before"))).toBe("9:30 PM");
    expect(value(ladder("Rule 1: name"))).toBe("Up to 9:30 PM"); // the automatic name followed

    // 1:00 AM next day on the first row: it moves to its place after 12:00 AM
    await page!.type(aria("Rule 1: last punch-out before"), "1am next day");
    await leave(aria("Rule 1: last punch-out before"));
    expect(
      qa(`[data-testid="shift-row"] input[aria-label$="last punch-out before"]`).map(
        (i) => (i as HTMLInputElement).value,
      ),
    ).toEqual(["12:00 AM", "1:00 AM next day", "2:00 AM next day", ""]);
    expect(saveButton().disabled).toBe(false);
    await press("Save Compensation Settings");
    expect(server.puts[0].shiftRules?.map((r) => [r.id, r.untilMinutes, r.sortOrder])).toEqual([
      [6, 1440, 1],
      [5, 1500, 2],
      [7, 1560, 3],
      [8, null, 4],
    ]);
  });

  it("does not move a row away while the cursor is still in it: rows are put in order on leaving the row", async () => {
    await open();
    const untils = () =>
      qa(`[data-testid="shift-row"] input[aria-label$="last punch-out before"]`).map(
        (i) => (i as HTMLInputElement).value,
      );
    // Type 2: the time is understood at once, the row moves only once focus leaves the row
    await page!.type(aria("Rule 1: last punch-out before"), "1am next day");
    await leave(aria("Rule 1: last punch-out before"), ladder("Rule 1: name"));
    expect(untils()).toEqual(["1:00 AM next day", "12:00 AM", "2:00 AM next day", ""]);
    await leave(ladder("Rule 1: name"));
    await leave(aria("Rule 1: last punch-out before"));
    expect(untils()).toEqual(["12:00 AM", "1:00 AM next day", "2:00 AM next day", ""]);

    // Type 1: the same between the hours and the minutes of one row
    await page!.type(aria("Rule 1: hours of extra work"), "5");
    await leave(aria("Rule 1: hours of extra work"), aria("Rule 1: minutes of extra work"));
    expect(value(aria("Rule 1: name"))).toBe("5 hours");
    expect(value(aria("Rule 4: name"))).toBe("2 hours 30 minutes");
    await leave(aria("Rule 1: minutes of extra work"));
    expect(value(aria("Rule 4: name"))).toBe("5 hours");
    expect(value(aria("Rule 1: name"))).toBe("1 hour 30 minutes");
  });

  it("gives the last row a time to start from when its 'no upper limit' is un-ticked, and refuses it as the last rule", async () => {
    await open();
    await page!.click(aria("Rule 4: no upper limit"));
    expect(value(aria("Rule 4: last punch-out before"))).toBe("3:00 AM next day");
    expect(value(ladder("Rule 4: name"))).toBe("Up to 3:00 AM next day");
    expect(text('[data-testid="shift-order-error"]')).toContain("The last rule that is on must have no upper limit");
    expect(saveButton().disabled).toBe(true);
    // ticked again: back to what was saved
    await page!.click(aria("Rule 4: no upper limit"));
    expect(q('[data-testid="shift-order-error"]')).toBeNull();
    expect(value(ladder("Rule 4: name"))).toBe("No time limit");
    expect(saveBar().dataset.dirty).toBe("false");
  });
});

describe("Settings -> Compensation: dates", () => {
  it("says what the date means, warns about a date in the past, and puts today back with a button", async () => {
    await open();
    expect(q('[data-testid="allowance-from-note"]')?.dataset.kind).toBe("today");
    expect(text('[data-testid="allowance-from-note"]')).toContain("Days before today are never changed");
    expect((q('[data-testid="allowance-from-today"]') as HTMLButtonElement).disabled).toBe(true);

    await page!.type("#compensation-allowance-from", "2026-10-01");
    expect(q('[data-testid="allowance-from-note"]')?.dataset.kind).toBe("past");
    expect(text('[data-testid="allowance-from-note"]')).toContain("1 Oct 2026 is in the past");
    expect(text('[data-testid="allowance-from-note"]')).toContain("Payslips already generated are never rewritten");
    expect(saveButton().disabled).toBe(false); // a warning, not a refusal

    await page!.type("#compensation-allowance-from", "2026-11-02");
    expect(q('[data-testid="allowance-from-note"]')?.dataset.kind).toBe("future");

    await page!.click('[data-testid="allowance-from-today"]');
    expect(value("#compensation-allowance-from")).toBe("2026-10-14");
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("will not let a date that was set be emptied", async () => {
    await open();
    await page!.type("#compensation-allowance-from", "");
    expect(text('[data-testid="allowance-from-error"]')).toBe("Pick the date it applies from.");
    expect(saveButton().disabled).toBe(true);
  });
});

describe("Settings -> Compensation: view-only, loading and the search", () => {
  it("disables every control for a view-only role and says so on the Save bar", async () => {
    await open(SEEDED, { readOnly: true });
    const controls = qa(
      [
        '[role="switch"]',
        '[data-testid="allowance-table"] input',
        '[data-testid="shift-table"] input',
        '[data-testid="shift-table"] select',
        "#compensation-shift-threshold",
        "#compensation-allowance-from",
        "#compensation-birthday-from",
        '[data-testid="allowance-add"]',
        '[data-testid="shift-add"]',
        '[data-testid="allowance-from-today"]',
        '[aria-label^="Remove rule"]',
      ].join(","),
    ) as (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[];
    expect(controls.length).toBeGreaterThan(40);
    expect(controls.filter((c) => !c.disabled).map((c) => c.getAttribute("aria-label") ?? c.id)).toEqual([]);
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain("View only");
    // looking is still allowed: the worked examples can be tried
    expect((q("#type1-try-extra") as HTMLInputElement).disabled).toBe(false);
    expect((q("#type2-try-punch") as HTMLInputElement).disabled).toBe(false);
    expect(server.puts).toHaveLength(0);
  });

  it("shows a skeleton while loading, and a retry when the settings cannot be read", async () => {
    const made = makeServer(SEEDED);
    server = made.server;
    server.down = true;
    page = await renderMdPage(
      () => <CompensationTab />,
      {
        "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
        "/api/compensation/settings": made.handler,
      },
      { path: "/hr/settings?tab=compensation" },
    );
    expect(q('[data-testid="compensation-load-error"]')).not.toBeNull();
    expect(page.text()).toContain("could not be loaded");
    expect(q('[data-testid="compensation-tab"]')).toBeNull();
    server.down = false;
    await press("Try again");
    expect(q('[data-testid="compensation-load-error"]')).toBeNull();
    expect(q('[data-testid="compensation-tab"]')).not.toBeNull();
    expect(qa('[data-testid="allowance-row"]')).toHaveLength(4);
  });

  it("has a search entry for every setting it draws, with the same title, words and section", async () => {
    await open();
    const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const blocks = [...page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")];
    expect(blocks.map((b) => b.dataset.settingId).sort()).toEqual(COMPENSATION_SETTINGS.map((m) => m.id).sort());
    for (const meta of COMPENSATION_SETTINGS) {
      expect(meta.tab).toBe("compensation");
      const block = blocks.find((b) => b.dataset.settingId === meta.id)!;
      expect(block.querySelector("h4")?.textContent?.trim(), meta.id).toBe(meta.title);
      expect(block.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta.id).toBe(meta.purpose);
      expect(block.closest("section:not([data-setting-id])")?.querySelector("h3")?.textContent?.trim(), meta.id).toBe(
        meta.section,
      );
      // every setting says what changes (the page's convention) and has an explanation worth reading
      expect(block.querySelector('[data-testid="setting-affects"]'), meta.id).not.toBeNull();
      expect(meta.purpose.length, meta.id).toBeGreaterThan(60);
    }
  });
});
