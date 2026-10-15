import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import type {
  ProductionShiftPreview,
  ProductionShiftPreviewInput,
  ProductionShiftRules,
  ProductionShiftRulesInput,
} from "@/lib/api-client/custom-hooks";
import ProductionShiftsTab from "../ProductionShiftsTab";
import { PRODUCTION_SHIFT_SECTIONS, PRODUCTION_SHIFT_SETTINGS } from "../ProductionShiftsTab.meta";
import { SEEDED } from "./fixtures";

// jsdom render checks of Settings -> Production Shifts with a small in-memory copy of the server: what the tab shows from the
// saved rules, editing / adding / removing rows, groups and breaks, the checks that mirror the server, the question before a
// save and the exact request it sends, a refused save, the "Try a day" box (which asks the server and never the form), the
// view-only role and a branch login, and a failed load.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const NO_WARNINGS: string[] = [];

/**
 * The server in a few lines (backend/api/production_shift_rules_views.py): the two arrays replace the tables and get ids,
 * the answer is the new document plus `warnings`, and the preview answers from what is SAVED.
 */
function makeServer(initial: ProductionShiftRules) {
  const server = {
    current: structuredClone(initial) as ProductionShiftRules,
    puts: [] as ProductionShiftRulesInput[],
    previews: [] as ProductionShiftPreviewInput[],
    refuse: null as { status: number; body: unknown } | null,
    down: false,
    previewFails: null as { status: number; error: string } | null,
    nextId: 100,
    /** The warnings the next save answers with. */
    warnings: NO_WARNINGS,
    /** Answer a save with just {ok: true} (no body). */
    bare: false,
    /** What the preview says (a function of the typed day). */
    preview: ((input: ProductionShiftPreviewInput): ProductionShiftPreview => ({
      group: new Date(`${input.date}T00:00:00Z`).getUTCDay() === 0 ? "Sunday shift" : "Day shift",
      shifts: 1.5,
      status: "present",
      isLate: false,
      earlyLeave: false,
      note: `Day shift: left ${input.punches[input.punches.length - 1]}, 1.50 shift (20:00 rule)`,
    })) as (input: ProductionShiftPreviewInput) => ProductionShiftPreview,
  };
  const handler = (_params: URLSearchParams, init?: RequestInit) => {
    if (server.down) return { status: 500, body: { error: "boom" } };
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as ProductionShiftRulesInput;
      server.puts.push(body);
      if (server.refuse) return server.refuse;
      const now = server.current;
      const { groups, breaks, ...rest } = body;
      Object.assign(now, rest);
      now.groups = groups.map((g) => ({
        ...g,
        id: g.id ?? server.nextId++,
        rules: g.rules.map((r) => ({ ...r, id: r.id ?? server.nextId++ })),
      }));
      now.breaks = breaks.map((b) => ({ ...b, id: b.id ?? server.nextId++ }));
      now.updatedBy = "Test HR";
      return server.bare ? { ok: true } : { ...now, warnings: server.warnings };
    }
    return server.current;
  };
  const previewHandler = (_params: URLSearchParams, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as ProductionShiftPreviewInput;
    server.previews.push(input);
    if (server.previewFails) return { status: server.previewFails.status, body: { error: server.previewFails.error } };
    return server.preview(input);
  };
  return { server, handler, previewHandler };
}

let page: RenderedPage | undefined;
let server: ReturnType<typeof makeServer>["server"];

beforeEach(() => {
  toast.mockClear();
  // only the date is frozen (today in India is 14 Oct 2026, a Wednesday); timers stay real so the page can settle
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
});
afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.useRealTimers();
});

async function open(initial: ProductionShiftRules = SEEDED, props: { readOnly?: boolean; branch?: boolean } = {}) {
  const made = makeServer(initial);
  server = made.server;
  page = await renderMdPage(
    () => <ProductionShiftsTab readOnly={props.readOnly} />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
      "/api/payroll-settings": {
        companyName: "UKTextiles",
        companyLogo: null,
        companyWideRulesEditable: !props.branch,
      },
      "/api/production-shift-rules": made.handler,
      "/api/production-shift-rules/preview": made.previewHandler,
    },
    { path: "/hr/settings?tab=production_shifts" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const text = (selector: string) => (q(selector)?.textContent ?? "").replace(/\s+/g, " ");
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const aria = (label: string) => `[aria-label="${label}"]`;
const value = (selector: string) => (q(selector) as HTMLInputElement | HTMLSelectElement).value;
const saveButton = () => buttonNamed("Save Production Shift Rules")!;
const saveBar = () => q('[data-testid="save-bar"]')!;
/** The lines of the question before a save: "Grace | 5 min | 3 min | pay" (what, from, to, and the pay mark). */
const changeLines = () =>
  qa('[data-testid="confirm-production-shifts-changes"] li').map((li) =>
    [...li.querySelectorAll("span")]
      .map((span) => (span.textContent ?? "").trim())
      .filter(Boolean)
      .join(" | "),
  );
const groupCard = (kind: string) => q(`[data-testid="group-card"][data-kind="${kind}"]`)!;
const rowsOf = (kind: string) => [...groupCard(kind).querySelectorAll<HTMLElement>('[data-testid="rule-row"]')];

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}

/** Wait out the pause after typing in "Try a day" (it asks the server once typing stops). */
async function waitForTry() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 380));
  });
  // the answer comes back after the pause: let the request and the render finish (twice, on a busy machine)
  await page!.settle();
  await page!.settle();
}

/** Save with the question: press Save, read the dialog, confirm. */
async function saveAndConfirm() {
  await press("Save Production Shift Rules");
  expect(q('[data-testid="confirm-production-shifts"]')).not.toBeNull();
  await page!.click('[data-testid="confirm-production-shifts-confirm"]');
}

describe("Settings -> Production Shifts: what it shows", () => {
  it("draws the strip, the sections, the three default groups with their ladders, the breaks and the advanced numbers", async () => {
    await open();
    expect(q('[data-testid="production-rules-strip"]')?.dataset.state).toBe("on");
    expect(text('[data-testid="production-rules-status"]')).toBe("The production shift rules are ON from 14 Oct 2026");
    expect(text('[data-testid="production-only"]')).toBe("Production employees only");
    expect(text('[data-testid="production-shifts-updated"]')).toContain("Last saved by Asha on 14 Oct 2026");
    for (const title of Object.values(PRODUCTION_SHIFT_SECTIONS)) expect(page!.text()).toContain(title);

    // the switch, the date and the grace as saved
    expect(q("#production-rules-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(value("#production-rules-from")).toBe("2026-10-14");
    expect(value("#production-rules-grace")).toBe("5");

    // the three groups, their boxes and their ladders
    expect(qa('[data-testid="group-card"]').map((c) => c.dataset.kind)).toEqual(["day", "night", "sunday"]);
    expect(value(aria("Day shift: name"))).toBe("Day shift");
    expect(value(aria("Day shift: used on"))).toBe("mon_sat");
    expect(value(aria("Day shift: start time"))).toBe("08:30");
    expect(value(aria("Day shift: first punch from"))).toBe("04:00");
    expect(value(aria("Day shift: first punch to"))).toBe("16:59");
    expect(value(aria("Day shift: standard departure"))).toBe("20:00");
    expect(value(aria("Night shift: used on"))).toBe("all");
    expect(value(aria("Night shift: start time"))).toBe("21:00");
    expect(value(aria("Night shift: standard departure"))).toBe("05:30");
    expect((q(aria("Night shift: standard departure is the next day")) as HTMLInputElement).checked).toBe(true);
    expect(value(aria("Sunday shift: used on"))).toBe("sunday");
    expect(rowsOf("day")).toHaveLength(8);
    expect(rowsOf("night")).toHaveLength(2);
    expect(rowsOf("sunday")).toHaveLength(1);
    expect(
      rowsOf("day").map((r) => [
        (r.querySelector('input[type="time"]') as HTMLInputElement).value,
        (r.querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
        (r.querySelector('input[aria-label$="shifts"]') as HTMLInputElement).value,
      ]),
    ).toEqual([
      ["10:30", false, "0.25"],
      ["12:45", false, "0.50"],
      ["15:30", false, "0.75"],
      ["17:45", false, "1.00"],
      ["20:00", false, "1.50"],
      ["22:30", false, "2.00"],
      ["00:30", true, "2.50"],
      ["05:30", true, "3.00"],
    ]);
    expect(value(aria("Day shift, row 4: name"))).toBe("Evening tea");
    expect(text('[data-testid="group-window-note"]')).toContain(
      "A day whose first punch is between 4:00 AM and 4:59 PM on Monday to Saturday uses this group.",
    );

    // the five breaks, each with its length
    expect(qa('[data-testid="break-row"]')).toHaveLength(5);
    expect(value(aria("Break 2: from"))).toBe("12:45");
    expect(value(aria("Break 2: to"))).toBe("13:30");
    expect(qa('[data-testid="break-length"]').map((l) => (l.textContent ?? "").replace(/Length/, "").trim())).toEqual([
      "15 min",
      "45 min",
      "15 min",
      "15 min",
      "1 h",
    ]);

    // the advanced numbers
    expect(value("#production-min-credit")).toBe("0");
    expect(value("#production-rounding-step")).toBe("0.01");
    expect(value("#production-rounding-mode")).toBe("nearest");
    expect(value("#production-full-day")).toBe("1");
    expect(value("#production-night-hours")).toBe("12");

    // nothing is changed yet
    expect(saveBar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
  });
});

/** A control inside one card (the page has one "Add a row" button for each group). */
async function clickIn(card: HTMLElement, selector: string) {
  const target = card.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`no ${selector} in the card`);
  await act(async () => target.click());
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

/** Pick an option of a drop-down. */
async function choose(selector: string, next: string) {
  await act(async () => {
    const select = q(selector) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, next);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

const timesOf = (kind: string) =>
  rowsOf(kind).map(
    (r) =>
      `${(r.querySelector('input[type="time"]') as HTMLInputElement).value}${
        (r.querySelector('input[type="checkbox"]') as HTMLInputElement).checked ? "+1" : ""
      }`,
  );

describe("Settings -> Production Shifts: the explanations and the owner's two unverified rows", () => {
  it("marks the two rows that follow the owner's handwriting, and the note goes away once a row is changed", async () => {
    await open();
    const banner = text('[data-testid="unverified-banner"]');
    expect(banner).toContain("Check these 2 rows with HR");
    expect(banner).toContain(
      "Day shift: leaving at 12:30 AM the next morning earns 2.50 shifts (the handwriting may mean 12:30 PM)",
    );
    expect(banner).toContain(
      "Night shift: leaving at 12:00 AM the next morning earns 0.50 shifts (the handwriting may mean 12:00 PM (noon))",
    );
    expect(qa('[data-testid="unverified-row"]')).toHaveLength(2);
    expect(rowsOf("day")[6].querySelector('[data-testid="unverified-row"]')).not.toBeNull();
    expect(rowsOf("night")[0].querySelector('[data-testid="unverified-row"]')).not.toBeNull();
    expect(rowsOf("day")[7].querySelector('[data-testid="unverified-row"]')).toBeNull();

    await page!.type(aria("Day shift, row 7: shifts"), "2.4");
    expect(text('[data-testid="unverified-banner"]')).toContain("Check this row with HR");
    expect(qa('[data-testid="unverified-row"]')).toHaveLength(1);
    await page!.type(aria("Night shift, row 1: leaves at"), "00:15");
    expect(q('[data-testid="unverified-banner"]')).toBeNull();
    expect(qa('[data-testid="unverified-row"]')).toHaveLength(0);
  });

  it("says that Sunday work after 5:00 PM has no rule, and what the top of every other ladder means", async () => {
    await open();
    expect(text('[data-testid="sunday-note"]')).toBe(
      "Nothing was given for Sunday work after 5:00 PM, so leaving later than that earns no more than 1.00 shift. Add a row if later Sunday work should earn more.",
    );
    expect(qa('[data-testid="ladder-cap"]').map((n) => (n.textContent ?? "").replace(/\s+/g, " "))).toEqual([
      "Leaving later than 5:30 AM next day earns no more than 3.00 shifts.",
      "Leaving later than 5:30 AM next day earns no more than 1.50 shifts.",
    ]);
    // a row added to the Sunday ladder moves the top of it
    await clickIn(groupCard("sunday"), '[data-testid="rule-add"]');
    expect(text('[data-testid="sunday-note"]')).toContain("after 6:00 PM");
    // how a ladder is worked out is written down once
    expect(text('[data-testid="ladder-how"]')).toContain("halfway through the paid time between 1.00 and 1.50 is 1.25");
  });

  it("works the grace example from the grace on screen", async () => {
    await open();
    expect(text('[data-testid="grace-on-time"]')).toBe("First punch at 8:35 AMOn time: nothing is lost");
    expect(text('[data-testid="grace-late"]')).toContain("First punch at 8:36 AM");
    expect(text('[data-testid="grace-snap"]')).toBe("Leaving at 5:40 PMCounts as 5:45 PM: 1.00 shift");
    await page!.type("#production-rules-grace", "10");
    expect(text('[data-testid="grace-on-time"]')).toContain("8:40 AM");
    expect(text('[data-testid="grace-snap"]')).toContain("Leaving at 5:35 PM");
    await page!.type("#production-rules-grace", "0");
    expect(q('[data-testid="grace-snap"]')).toBeNull();
    await page!.type("#production-rules-grace", "abc");
    expect(q('[data-testid="grace-example"]')).toBeNull();
    expect(text('[data-testid="rules-grace-error"]')).toBe("Enter a number, using digits and at most one dot.");
    expect(saveButton().disabled).toBe(true);
  });

  it("tells HR the rules are off while the saved switch is off, and when they start later", async () => {
    await open({ ...SEEDED, enabled: false });
    expect(q('[data-testid="production-rules-strip"]')?.dataset.state).toBe("off");
    expect(text('[data-testid="production-rules-status"]')).toBe("The production shift rules are OFF");
    expect(text('[data-testid="production-rules-strip"]')).toContain("none of it acts until the switch is turned on");
    expect(q("#production-rules-switch")?.getAttribute("aria-checked")).toBe("false");
    // still editable while off
    expect((q(aria("Day shift, row 1: shifts")) as HTMLInputElement).disabled).toBe(false);
    page!.unmount();
    await open({ ...SEEDED, effectiveFrom: "2026-11-02" });
    expect(q('[data-testid="production-rules-strip"]')?.dataset.state).toBe("future");
    expect(text('[data-testid="production-rules-status"]')).toBe("The production shift rules start on 2 Nov 2026");
  });
});

describe("Settings -> Production Shifts: editing and saving", () => {
  it("asks first, listing what changes, then sends the whole document with the rows' ids and is clean again", async () => {
    await open();
    await page!.type(aria("Day shift, row 4: shifts"), "1.1");
    expect(saveBar().dataset.dirty).toBe("true");
    expect(saveButton().disabled).toBe(false);

    await press("Save Production Shift Rules");
    const dialog = q('[data-testid="confirm-production-shifts"]')!;
    expect(dialog.textContent).toContain("Save these production shift rules?");
    expect(changeLines()).toEqual(["Day shift: row | 5:45 PM = 1.00 shifts | 5:45 PM = 1.10 shifts | pay"]);
    expect(dialog.textContent).toContain("Days from 14 Oct 2026 on are worked out with these rules");
    expect(dialog.textContent).toContain("Only production employees are affected");
    expect(server.puts).toHaveLength(0); // nothing is sent until the question is answered

    await page!.click('[data-testid="confirm-production-shifts-confirm"]');
    expect(server.puts).toHaveLength(1);
    const put = server.puts[0];
    expect(put).toMatchObject({
      enabled: true,
      effectiveFrom: "2026-10-14",
      graceMinutes: 5,
      minCredit: 0,
      roundingStep: 0.01,
      roundingMode: "nearest",
      fullDayValue: 1,
      nightSessionHours: 12,
    });
    expect(put.groups.map((g) => g.id)).toEqual([1, 2, 3]);
    expect(put.groups[0].rules.map((r) => [r.id, r.outTime, r.outNextDay, r.shiftValue, r.enabled])).toEqual([
      [1, "10:30", false, 0.25, true],
      [2, "12:45", false, 0.5, true],
      [3, "15:30", false, 0.75, true],
      [4, "17:45", false, 1.1, true],
      [5, "20:00", false, 1.5, true],
      [6, "22:30", false, 2, true],
      [7, "00:30", true, 2.5, true],
      [8, "05:30", true, 3, true],
    ]);
    expect(put.groups[1]).toMatchObject({
      mainOutTime: "05:30",
      mainOutNextDay: true,
      kind: "night",
      appliesOn: "all",
    });
    expect(put.breaks.map((b) => [b.id, b.startTime, b.endTime])).toEqual([
      [1, "10:30", "10:45"],
      [2, "12:45", "13:30"],
      [3, "15:30", "15:45"],
      [4, "17:45", "18:00"],
      [5, "20:00", "21:00"],
    ]);
    expect(Object.keys(put)).not.toContain("updatedAt");
    expect(Object.keys(put)).not.toContain("warnings");
    expect(Object.keys(put)).not.toContain("legacy");

    expect(q('[data-testid="confirm-production-shifts"]')).toBeNull();
    expect(saveBar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
    expect(value(aria("Day shift, row 4: shifts"))).toBe("1.10"); // as the server now has it
    expect(text('[data-testid="production-shifts-updated"]')).toContain("by Test HR");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Production shift rules saved" }));
  });

  it("sends nothing when the question is cancelled, and keeps the edits", async () => {
    await open();
    await page!.type("#production-rules-grace", "3");
    await press("Save Production Shift Rules");
    expect(changeLines()).toEqual(["Grace | 5 min | 3 min | pay"]);
    await press("Cancel");
    expect(q('[data-testid="confirm-production-shifts"]')).toBeNull();
    expect(server.puts).toHaveLength(0);
    expect(value("#production-rules-grace")).toBe("3");
    expect(saveBar().dataset.dirty).toBe("true");
  });

  it("says a date in the past is judged again, in the question and under the box", async () => {
    await open();
    await page!.type("#production-rules-from", "2026-10-01");
    expect(q('[data-testid="rules-from-note"]')?.dataset.kind).toBe("past");
    expect(text('[data-testid="rules-from-note"]')).toContain("1 Oct 2026 is in the past");
    expect(saveButton().disabled).toBe(false); // a warning, not a refusal
    await press("Save Production Shift Rules");
    expect(text('[data-testid="confirm-production-shifts"]')).toContain(
      "1 Oct 2026 is in the past: every production day from then until today is judged again",
    );
    expect(changeLines()).toEqual(["Applies from | 14 Oct 2026 | 1 Oct 2026 | pay"]);
    await press("Cancel");
  });

  it("puts today back with a button, and will not let the date be emptied", async () => {
    await open();
    await page!.type("#production-rules-from", "2026-11-02");
    expect(q('[data-testid="rules-from-note"]')?.dataset.kind).toBe("future");
    await page!.click('[data-testid="rules-from-today"]');
    expect(value("#production-rules-from")).toBe("2026-10-14");
    expect(saveBar().dataset.dirty).toBe("false");
    await page!.type("#production-rules-from", "");
    expect(text('[data-testid="rules-from-error"]')).toBe("Pick the date the rules apply from.");
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain("Fix this first: Applies from: Pick the date the rules apply from.");
  });

  it("switches the rules off and says so in the question", async () => {
    await open();
    await page!.click("#production-rules-switch");
    expect(q("#production-rules-switch")?.getAttribute("aria-checked")).toBe("false");
    await press("Save Production Shift Rules");
    expect(changeLines()).toEqual(["Production shift rules | On | Off | pay"]);
    expect(text('[data-testid="confirm-production-shifts"]')).toContain(
      "every production day uses the old calculation",
    );
    await page!.click('[data-testid="confirm-production-shifts-confirm"]');
    expect(server.puts[0].enabled).toBe(false);
    expect(q('[data-testid="production-rules-strip"]')?.dataset.state).toBe("off");
  });

  it("shows the server's words when a save is refused, keeps the edits and sends nothing twice", async () => {
    await open();
    await page!.type("#production-rules-grace", "3");
    server.refuse = { status: 400, body: { error: "The Night shift's rows must get later." } };
    await saveAndConfirm();
    expect(text('[data-testid="production-shifts-save-error"]')).toBe("The Night shift's rows must get later.");
    expect(server.puts).toHaveLength(1);
    expect(value("#production-rules-grace")).toBe("3");
    expect(saveBar().dataset.dirty).toBe("true");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save the production shift rules", variant: "destructive" }),
    );
    // a second try that works clears the message
    server.refuse = null;
    await saveAndConfirm();
    expect(q('[data-testid="production-shifts-save-error"]')).toBeNull();
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("explains a refused login, and the tab turns read-only", async () => {
    await open();
    await page!.type("#production-rules-grace", "3");
    server.refuse = {
      status: 403,
      body: { error: "These settings are company-wide.", code: "company_wide_settings" },
    };
    await saveAndConfirm();
    expect(text('[data-testid="production-shifts-save-error"]')).toContain("company-wide");
    expect(text('[data-testid="production-shifts-save-error"]')).toContain("only an administrator");
    expect(q('[data-testid="settings-branch-notice"]')).not.toBeNull();
    expect((q("#production-rules-grace") as HTMLInputElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("says plainly when the login may not change the rules, and when the server could not be reached", async () => {
    await open();
    await page!.type("#production-rules-grace", "3");
    server.refuse = { status: 403, body: { error: "permission_denied" } };
    await saveAndConfirm();
    expect(text('[data-testid="production-shifts-save-error"]')).toBe(
      "Your login is not allowed to change the production shift rules.",
    );
    server.refuse = { status: 500, body: {} };
    await saveAndConfirm();
    expect(text('[data-testid="production-shifts-save-error"]')).toContain("could not be saved");
  });

  it("reads the rules back when the server's answer to a save has no document", async () => {
    await open();
    server.bare = true;
    await page!.type("#production-rules-grace", "3");
    await saveAndConfirm();
    expect(saveBar().dataset.dirty).toBe("false");
    expect(value("#production-rules-grace")).toBe("3");
  });

  it("shows the server's warnings about what was saved, and keeps them until the next save", async () => {
    await open({ ...SEEDED, warnings: ["Days from 14 Oct 2026 are re-judged: regenerate payroll to apply."] });
    expect(text('[data-testid="production-shifts-warnings"]')).toContain("regenerate payroll to apply");
    server.warnings = ["The Sunday shift has no row beyond its standard departure."];
    await page!.type("#production-rules-grace", "3");
    await saveAndConfirm();
    expect(text('[data-testid="production-shifts-warnings"]')).toContain("The server points out:");
    expect(text('[data-testid="production-shifts-warnings"]')).toContain("no row beyond its standard departure");
    expect(text('[data-testid="production-shifts-warnings"]')).not.toContain("regenerate payroll");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("Saved, with a warning") }),
    );
    server.warnings = NO_WARNINGS;
    await page!.type("#production-rules-grace", "4");
    await saveAndConfirm();
    expect(q('[data-testid="production-shifts-warnings"]')).toBeNull();
  });

  it("discards the edits, and Discard is only there while something changed", async () => {
    await open();
    expect(buttonNamed("Discard changes")).toBeUndefined();
    await page!.type(aria("Day shift, row 1: shifts"), "0.3");
    await page!.click("#production-rules-switch");
    expect(buttonNamed("Discard changes")).toBeDefined();
    await press("Discard changes");
    expect(value(aria("Day shift, row 1: shifts"))).toBe("0.25");
    expect(q("#production-rules-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(saveBar().dataset.dirty).toBe("false");
    expect(buttonNamed("Discard changes")).toBeUndefined();
  });
});

describe("Settings -> Production Shifts: rows, groups and breaks", () => {
  it("adds a row to a ladder (no id yet) and removes another (its id is left out), and gets the new id back", async () => {
    await open();
    await clickIn(groupCard("sunday"), '[data-testid="rule-add"]');
    expect(rowsOf("sunday")).toHaveLength(2);
    expect(value(aria("Sunday shift, row 2: leaves at"))).toBe("18:00");
    expect(value(aria("Sunday shift, row 2: shifts"))).toBe("1.00");
    expect(value(aria("Sunday shift, row 2: name"))).toBe("Leaves 6:00 PM");
    await page!.click(aria("Remove Day shift row 1"));
    expect(rowsOf("day")).toHaveLength(7);
    await saveAndConfirm();
    expect(server.puts[0].groups[0].rules.map((r) => r.id)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(server.puts[0].groups[2].rules.map((r) => [r.id, r.outTime, r.shiftValue])).toEqual([
      [11, "17:00", 1],
      [undefined, "18:00", 1],
    ]);
    expect(rowsOf("sunday")).toHaveLength(2);
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("switches a row off without removing it, and the ladder cap follows", async () => {
    await open();
    await page!.click(aria("Day shift, row 8: in use"));
    expect(q(aria("Day shift, row 8: in use"))?.getAttribute("aria-checked")).toBe("false");
    expect(rowsOf("day")[7].dataset.enabled).toBe("false");
    expect(text('[data-testid="group-card"][data-kind="day"] [data-testid="ladder-cap"]')).toBe(
      "Leaving later than 12:30 AM next day earns no more than 2.50 shifts.",
    );
    await saveAndConfirm();
    expect(server.puts[0].groups[0].rules[7]).toMatchObject({ id: 8, enabled: false });
  });

  it("puts rows in time order when a box is left, but not while the cursor is still in the row", async () => {
    await open();
    await page!.type(aria("Day shift, row 1: leaves at"), "21:30");
    await leave(aria("Day shift, row 1: leaves at"), aria("Day shift, row 1: shifts"));
    expect(timesOf("day")[0]).toBe("21:30"); // focus is still in the row
    await page!.type(aria("Day shift, row 1: shifts"), "1.75"); // between 20:00 (1.5) and 22:30 (2): the ladder stays valid
    await leave(aria("Day shift, row 1: shifts"));
    expect(timesOf("day")).toEqual(["12:45", "15:30", "17:45", "20:00", "21:30", "22:30", "00:30+1", "05:30+1"]);
    // the typed name travelled with its row
    expect(value(aria("Day shift, row 5: name"))).toBe("Morning tea");
    expect(value(aria("Day shift, row 5: shifts"))).toBe("1.75");
    await saveAndConfirm();
    expect(server.puts[0].groups[0].rules.map((r) => r.id)).toEqual([2, 3, 4, 5, 1, 6, 7, 8]);
    expect(server.puts[0].groups[0].rules[4]).toMatchObject({ id: 1, outTime: "21:30", shiftValue: 1.75 });
  });

  it("follows the time with the automatic name of a row, and keeps a typed one", async () => {
    await open();
    await page!.type(aria("Day shift, row 1: name"), "");
    expect((q(aria("Day shift, row 1: name")) as HTMLInputElement).placeholder).toBe("Leaves 10:30 AM");
    await page!.type(aria("Day shift, row 1: leaves at"), "10:40");
    expect(value(aria("Day shift, row 1: name"))).toBe("Leaves 10:40 AM");
    await page!.type(aria("Day shift, row 2: leaves at"), "12:50");
    expect(value(aria("Day shift, row 2: name"))).toBe("Lunch");
  });

  it("adds a break after the last one, removes another, and puts the breaks in order", async () => {
    await open();
    await page!.click('[data-testid="break-add"]');
    expect(qa('[data-testid="break-row"]')).toHaveLength(6);
    expect(value(aria("Break 6: from"))).toBe("22:00");
    expect(value(aria("Break 6: to"))).toBe("22:15");
    expect(value(aria("Break 6: name"))).toBe("Break 10:00 PM");
    await page!.click(aria("Remove break 1"));
    expect(qa('[data-testid="break-row"]')).toHaveLength(5);
    await saveAndConfirm();
    expect(server.puts[0].breaks.map((b) => [b.id, b.label, b.startTime, b.endTime])).toEqual([
      [2, "Lunch", "12:45", "13:30"],
      [3, "Afternoon tea", "15:30", "15:45"],
      [4, "Evening tea", "17:45", "18:00"],
      [5, "Night dinner", "20:00", "21:00"],
      [undefined, "Break 10:00 PM", "22:00", "22:15"],
    ]);

    // the first break (Lunch, as saved) is moved to the evening: it takes its place in the order when its box is left
    await page!.type(aria("Break 1: from"), "21:30");
    await page!.type(aria("Break 1: to"), "21:45");
    await leave(aria("Break 1: from"));
    expect(
      qa('[data-testid="break-row"] input[aria-label$=": from"]').map((i) => (i as HTMLInputElement).value),
    ).toEqual(["15:30", "17:45", "20:00", "21:30", "22:00"]);
    expect(value(aria("Break 4: name"))).toBe("Lunch");
  });

  it("adds a group that starts switched off, so a half-made group cannot block a save, and sends it without an id", async () => {
    await open();
    await page!.click('[data-testid="group-add"]');
    expect(qa('[data-testid="group-card"]')).toHaveLength(4);
    const added = qa('[data-testid="group-card"]')[3];
    expect(added.dataset.kind).toBe("custom");
    expect(added.dataset.enabled).toBe("false");
    expect(value(aria("New group: name"))).toBe("New group");
    expect(saveButton().disabled).toBe(false);
    await page!.type(aria("New group: name"), "Overtime shift");
    await saveAndConfirm();
    expect(server.puts[0].groups).toHaveLength(4);
    expect("id" in server.puts[0].groups[3]).toBe(false);
    expect(server.puts[0].groups[3]).toMatchObject({
      label: "Overtime shift",
      kind: "custom",
      appliesOn: "all",
      enabled: false,
    });
    expect("id" in server.puts[0].groups[3].rules[0]).toBe(false);
    expect(server.current.groups[3].id).toBeGreaterThan(99);
    expect(qa('[data-testid="group-card"]')).toHaveLength(4);
  });

  it("switching a new group on with a window that is already taken is refused, and says which", async () => {
    await open();
    await page!.click('[data-testid="group-add"]');
    await page!.click(aria("New group: in use"));
    expect(text('[data-testid="group-overlap-error"]')).toContain("overlaps Day shift (4:00 AM to 4:59 PM)");
    expect(saveButton().disabled).toBe(true);
    // a window of its own (the small hours: the other three cover 4:00 AM to midnight) is fine
    await page!.type(aria("New group: first punch from"), "01:00");
    await page!.type(aria("New group: first punch to"), "03:30");
    expect(q('[data-testid="group-overlap-error"]')).toBeNull();
    expect(qa('[data-testid="group-window-note"]')[3].textContent).toBe(
      "A day whose first punch is between 1:00 AM and 3:30 AM on any day uses this group.",
    );
    expect(saveButton().disabled).toBe(false);
    // the same window on a day the others do not use is no different: one group for a day
    await choose(aria("New group: used on"), "sunday");
    expect(q('[data-testid="group-overlap-error"]')).toBeNull();
    expect(qa('[data-testid="group-window-note"]')[3].textContent).toContain("on Sunday uses this group.");
  });

  it("removes a group with its rows, and says what a group with no rows is", async () => {
    await open();
    await page!.click(aria("Remove group Sunday shift"));
    expect(qa('[data-testid="group-card"]')).toHaveLength(2);
    await saveAndConfirm();
    expect(server.puts[0].groups.map((g) => g.id)).toEqual([1, 2]);

    await page!.click(aria("Remove Night shift row 1"));
    await page!.click(aria("Remove Night shift row 1"));
    expect(q('[data-testid="ladder-empty"]')?.textContent).toContain("a day of this group earns nothing");
    expect(text('[data-testid="ladder-table-error"]')).toContain(
      "Night shift is in use but none of its rows is switched on",
    );
    expect(saveButton().disabled).toBe(true);
  });

  it("shows an empty state when there are no groups and when there are no breaks", async () => {
    await open({ ...SEEDED, groups: [], breaks: [] });
    expect(q('[data-testid="groups-empty"]')?.textContent).toContain("every production day keeps the old calculation");
    expect(q('[data-testid="breaks-empty"]')?.textContent).toContain("every minute between a worker's punches is paid");
    expect(q('[data-testid="group-add"]')).not.toBeNull();
    expect(q('[data-testid="break-add"]')).not.toBeNull();
    expect(q('[data-testid="grace-example"]')).toBeNull();
  });
});

describe("Settings -> Production Shifts: checks before anything is sent", () => {
  it("refuses a ladder that does not get later, says why, and sends nothing", async () => {
    await open();
    await page!.type(aria("Day shift, row 4: leaves at"), "12:45");
    expect(text('[data-testid="rule-order-error"]')).toBe(
      'Must be later than row 3 (3:30 PM). For a time after midnight tick "Next day".',
    );
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain(
      'Fix this first: Day shift, row 4: Must be later than row 3 (3:30 PM). For a time after midnight tick "Next day".',
    );
    await press("Save Production Shift Rules");
    expect(q('[data-testid="confirm-production-shifts"]')).toBeNull();
    expect(server.puts).toHaveLength(0);
  });

  it("wants a time after midnight to say so: unticking Next day on one is refused, and ticking it again fixes it", async () => {
    await open();
    await page!.click(aria("Day shift, row 7: next day"));
    expect(text('[data-testid="rule-time-error"]')).toContain("Must be later than the start (8:30 AM).");
    expect(saveButton().disabled).toBe(true);
    await page!.click(aria("Day shift, row 7: next day"));
    expect(q('[data-testid="rule-time-error"]')).toBeNull();
    expect(timesOf("day")).toEqual(["10:30", "12:45", "15:30", "17:45", "20:00", "22:30", "00:30+1", "05:30+1"]);
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("keeps the shifts from going down, and in range", async () => {
    await open();
    await page!.type(aria("Day shift, row 5: shifts"), "0.5");
    expect(text('[data-testid="rule-value-error"]')).toBe(
      "Must be at least row 4's 1.00: leaving later never earns less.",
    );
    expect(saveButton().disabled).toBe(true);
    await page!.type(aria("Day shift, row 5: shifts"), "10");
    expect(text('[data-testid="rule-value-error"]')).toBe("Must be from 0.01 to 9.99.");
    await page!.type(aria("Day shift, row 5: shifts"), "1.5");
    expect(q('[data-testid="rule-value-error"]')).toBeNull();
    // back to what is saved: nothing to save
    expect(saveBar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
  });

  it("checks the group's window against the others that can be used on the same day", async () => {
    await open();
    await page!.type(aria("Night shift: first punch from"), "16:00");
    expect(text('[data-testid="group-overlap-error"]')).toContain("overlaps Day shift (4:00 AM to 4:59 PM)");
    expect(saveButton().disabled).toBe(true);
    await page!.type(aria("Night shift: first punch from"), "17:00");
    expect(q('[data-testid="group-overlap-error"]')).toBeNull();
    await page!.type(aria("Day shift: first punch from"), "18:00");
    expect(text('[data-testid="group-window-error"]')).toBe("The window must start before it ends.");
  });

  it("checks a break: it must end after it starts, and may not overlap another", async () => {
    await open();
    await page!.type(aria("Break 1: to"), "10:30");
    expect(text('[data-testid="break-end-error"]')).toBe("The break must end after it starts.");
    await page!.type(aria("Break 1: to"), "10:45");
    await page!.type(aria("Break 2: from"), "10:40");
    expect(text('[data-testid="break-overlap-error"]')).toContain("Overlaps Morning tea (10:30 AM to 10:45 AM)");
    expect(saveButton().disabled).toBe(true);
    await page!.click(aria("Break 2: in use"));
    expect(q('[data-testid="break-overlap-error"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("warns, without blocking, about a row inside a break", async () => {
    await open();
    expect(q('[data-testid="production-shifts-advice"]')).toBeNull();
    await page!.type(aria("Day shift, row 2: leaves at"), "13:00");
    expect(text('[data-testid="production-shifts-advice"]')).toContain(
      "Day shift: leaving at 1:00 PM is inside the break Lunch (12:45 PM to 1:30 PM)",
    );
    expect(saveButton().disabled).toBe(false);
    await page!.type(aria("Day shift, row 2: leaves at"), "12:45");
    expect(q('[data-testid="production-shifts-advice"]')).toBeNull();
  });

  it("checks the advanced numbers and works their examples from the boxes", async () => {
    await open();
    expect(text('[data-testid="rounding-example"]')).toContain("Worked out to 1.37Saved as 1.37 shifts");
    await page!.type("#production-min-credit", "0.25");
    expect(text('[data-testid="min-credit-example"]')).toContain(
      "The ladder gives 0.10 shiftsThe day earns 0.25 shifts",
    );
    await page!.type("#production-min-credit", "10");
    expect(page!.text()).toContain("Must be from 0 to 9.99.");
    expect(saveButton().disabled).toBe(true);
    await page!.type("#production-min-credit", "0");

    await page!.type("#production-full-day", "1.25");
    expect(text('[data-testid="full-day-example"]')).toContain("A day that earns 1.50 shiftsPresent");
    expect(text('[data-testid="full-day-example"]')).toContain("A day that earns 0.75 shiftsHalf shift");
    await page!.type("#production-full-day", "2");
    expect(text('[data-testid="full-day-example"]')).toContain("A day that earns 1.50 shiftsHalf shift");
    await page!.type("#production-full-day", "1");

    await page!.type("#production-night-hours", "0");
    expect(page!.text()).toContain("Must be from 1 to 24.");
    await page!.type("#production-night-hours", "12");

    await choose("#production-rounding-step", "0.25");
    await choose("#production-rounding-mode", "down");
    expect(text('[data-testid="rounding-example"]')).toContain("Worked out to 1.37Saved as 1.25 shifts");
    expect(text('[data-testid="rounding-example"]')).toContain("Worked out to 0.62Saved as 0.50 shifts");
    await saveAndConfirm();
    expect(server.puts[0]).toMatchObject({ roundingStep: 0.25, roundingMode: "down" });
  });
});

describe("Settings -> Production Shifts: try a day", () => {
  it("asks the server about the owner's regular day with today's date, and shows what it says", async () => {
    await open();
    expect(server.previews).toEqual([{ punches: ["08:30", "12:45", "13:30", "20:00"], date: "2026-10-14" }]);
    expect(text('[data-testid="try-read-as"]')).toContain("Read as: 8:30 AM, 12:45 PM, 1:30 PM, 8:00 PM.");
    expect(text('[data-testid="try-weekday"]')).toBe("Wednesday");
    expect(text('[data-testid="try-group"]')).toBe("Group usedDay shift");
    expect(text('[data-testid="try-shifts"]')).toBe("Shifts earned1.50 shifts = ₹900");
    expect(text('[data-testid="try-status"]')).toBe("The day is markedPresent");
    expect(text('[data-testid="try-late"]')).toBe("LateNo");
    expect(text('[data-testid="try-early"]')).toBe("Left earlyNo");
    expect(text('[data-testid="try-note"]')).toBe("Day shift: left 20:00, 1.50 shift (20:00 rule)");
  });

  it("asks again, once typing stops, with a night's punches and the next morning marked", async () => {
    await open();
    await page!.type("#production-try-punches", "21:00 05:30");
    expect(text('[data-testid="try-read-as"]')).toContain("Read as: 9:00 PM, 5:30 AM next day.");
    await waitForTry();
    expect(server.previews.at(-1)).toEqual({ punches: ["21:00", "05:30"], date: "2026-10-14" });
    // typing a key at a time asks once, not for every key
    const before = server.previews.length;
    await act(async () => {
      for (const t of ["2", "21", "21:", "21:3", "21:30 05:30"]) {
        const input = q("#production-try-punches") as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, t);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await waitForTry();
    expect(server.previews.length - before).toBeLessThanOrEqual(1);
    expect(server.previews.at(-1)?.punches).toEqual(["21:30", "05:30"]);
  });

  it("fills in the owner's examples with one click, and the Sunday one picks the coming Sunday", async () => {
    await open();
    await page!.click('[data-testid="try-sample-day-night"]');
    await waitForTry();
    expect((q("#production-try-punches") as HTMLInputElement).value).toBe("08:30 12:45 13:30 20:00 21:00 05:30");
    expect(server.previews.at(-1)?.punches).toEqual(["08:30", "12:45", "13:30", "20:00", "21:00", "05:30"]);
    await page!.click('[data-testid="try-sample-sunday"]');
    await waitForTry();
    expect(value("#production-try-date")).toBe("2026-10-18");
    expect(text('[data-testid="try-weekday"]')).toBe("Sunday");
    expect(server.previews.at(-1)).toEqual({ punches: ["08:30", "17:00"], date: "2026-10-18" });
    expect(text('[data-testid="try-group"]')).toBe("Group usedSunday shift");
    // an ordinary day goes back to a weekday
    await page!.click('[data-testid="try-sample-late-out"]');
    expect(value("#production-try-date")).toBe("2026-10-14");
    await page!.click('[data-testid="try-sample-night"]');
    await waitForTry();
    expect(server.previews.at(-1)?.punches).toEqual(["21:00", "05:30"]);
  });

  it("says what it cannot read and asks the server nothing for it", async () => {
    await open();
    const asked = server.previews.length;
    await page!.type("#production-try-punches", "08:30 soon");
    await waitForTry();
    expect(text('[data-testid="try-parse-error"]')).toContain('"soon" is not a time');
    expect(text('[data-testid="try-waiting"]')).toBe("Enter the punches and a date to see the result.");
    expect(server.previews).toHaveLength(asked);
    // an empty date first, then punches that can be read: still nothing to ask (and no pause between the two can matter)
    await page!.type("#production-try-date", "");
    await page!.type("#production-try-punches", "08:30 20:00");
    await waitForTry();
    expect(text('[data-testid="try-waiting"]')).toContain("Enter the punches and a date");
    expect(server.previews).toHaveLength(asked);
  });

  it("shows the server's own sentence when it cannot work a day out", async () => {
    await open();
    server.previewFails = { status: 400, error: "The punches are not in order." };
    await page!.type("#production-try-punches", "08:30 20:00");
    await waitForTry();
    expect(text('[data-testid="try-error"]')).toBe("The punches are not in order.");
    server.previewFails = { status: 500, error: "" };
    await page!.type("#production-try-punches", "08:30 19:00");
    await waitForTry();
    expect(text('[data-testid="try-error"]')).toContain("could not be worked out");
  });

  it("says the saved rules are used while there are unsaved changes, and that note goes once they are saved", async () => {
    await open();
    expect(q('[data-testid="try-unsaved"]')).toBeNull();
    await page!.type(aria("Day shift, row 4: shifts"), "1.1");
    expect(text('[data-testid="try-unsaved"]')).toContain(
      "worked out with the saved rules: save first to try the new ones",
    );
    await saveAndConfirm();
    expect(q('[data-testid="try-unsaved"]')).toBeNull();
  });

  it("shows a late, early-leaving and half-shift answer in warning words", async () => {
    await open();
    server.preview = () => ({
      group: "Day shift",
      shifts: 0.5,
      status: "half_shift",
      isLate: true,
      earlyLeave: true,
      note: "Day shift: left 12:45, 0.50 shift (12:45 rule)",
    });
    await page!.type("#production-try-punches", "09:10 12:45");
    await waitForTry();
    expect(text('[data-testid="try-status"]')).toBe("The day is markedHalf shift");
    expect(text('[data-testid="try-late"]')).toContain("Yes: the first punch was after the grace");
    expect(text('[data-testid="try-early"]')).toContain("Yes: before the standard departure");
    expect(text('[data-testid="try-shifts"]')).toBe("Shifts earned0.50 shifts = ₹300");
  });
});

describe("Settings -> Production Shifts: view-only, branch login, loading and the search", () => {
  const editable = [
    '[role="switch"]',
    '[data-testid="group-card"] input',
    '[data-testid="group-card"] select',
    '[data-testid="breaks"] input',
    "#production-rules-from",
    "#production-rules-grace",
    "#production-min-credit",
    "#production-rounding-step",
    "#production-rounding-mode",
    "#production-full-day",
    "#production-night-hours",
    '[data-testid="rule-add"]',
    '[data-testid="break-add"]',
    '[data-testid="group-add"]',
    '[data-testid="rules-from-today"]',
    '[aria-label^="Remove"]',
  ].join(",");

  const enabledControls = () =>
    (qa(editable) as (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[]).filter((c) => !c.disabled);

  it("disables every control for a view-only role, says so on the Save bar, and still lets a day be tried", async () => {
    await open(SEEDED, { readOnly: true });
    expect(qa(editable).length).toBeGreaterThan(100);
    expect(enabledControls().map((c) => c.getAttribute("aria-label") ?? c.id)).toEqual([]);
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain("View only");
    expect((q("#production-try-punches") as HTMLInputElement).disabled).toBe(false);
    expect((q("#production-try-date") as HTMLInputElement).disabled).toBe(false);
    expect((q('[data-testid="try-sample-regular"]') as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-testid="settings-branch-notice"]')).toBeNull();
    expect(server.puts).toHaveLength(0);
  });

  it("is read-only for a branch login, with the company-wide message, and sends nothing", async () => {
    await open(SEEDED, { branch: true });
    expect(text('[data-testid="settings-branch-notice"]')).toContain("The production shift rules are company-wide");
    expect(text('[data-testid="settings-branch-notice"]')).toContain("only an administrator");
    expect(enabledControls().map((c) => c.getAttribute("aria-label") ?? c.id)).toEqual([]);
    expect(saveButton().disabled).toBe(true);
    expect(saveBar().textContent).toContain("Signed in for a branch");
    // it can still read, and try a day
    expect(rowsOf("day")).toHaveLength(8);
    expect(q('[data-testid="try-answer"]')).not.toBeNull();
  });

  it("shows a retry when the rules cannot be read, and the tab once they can", async () => {
    const made = makeServer(SEEDED);
    server = made.server;
    server.down = true;
    page = await renderMdPage(
      () => <ProductionShiftsTab />,
      {
        "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
        "/api/payroll-settings": { companyName: "UKTextiles", companyLogo: null, companyWideRulesEditable: true },
        "/api/production-shift-rules": made.handler,
        "/api/production-shift-rules/preview": made.previewHandler,
      },
      { path: "/hr/settings?tab=production_shifts" },
    );
    expect(q('[data-testid="production-shifts-load-error"]')).not.toBeNull();
    expect(page.text()).toContain("could not be loaded");
    expect(q('[data-testid="production-shifts-tab"]')).toBeNull();
    server.down = false;
    await press("Try again");
    expect(q('[data-testid="production-shifts-load-error"]')).toBeNull();
    expect(q('[data-testid="production-shifts-tab"]')).not.toBeNull();
    expect(rowsOf("day")).toHaveLength(8);
  });

  it("names every control, so a keyboard or screen-reader user can tell them apart", async () => {
    await open();
    const controls = qa('input:not([type="hidden"]), select, button[role="switch"]');
    expect(controls.length).toBeGreaterThan(100);
    const unnamed = controls.filter((el) => {
      const label = el.getAttribute("aria-label");
      const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      return !label && !forLabel && !el.closest("label");
    });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
    // every icon-only button says what it does
    const buttons = qa("button").filter((b) => (b.textContent ?? "").trim() === "");
    expect(buttons.filter((b) => !b.getAttribute("aria-label") && !b.title)).toEqual([]);
  });

  it("has a search entry for every setting it draws, with the same title, words and section", async () => {
    await open();
    const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const blocks = [...page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")];
    expect(blocks.map((b) => b.dataset.settingId).sort()).toEqual(PRODUCTION_SHIFT_SETTINGS.map((m) => m.id).sort());
    for (const meta of PRODUCTION_SHIFT_SETTINGS) {
      expect(meta.tab).toBe("production_shifts");
      const block = blocks.find((b) => b.dataset.settingId === meta.id)!;
      expect(block.querySelector("h4")?.textContent?.trim(), meta.id).toBe(meta.title);
      expect(block.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta.id).toBe(meta.purpose);
      expect(block.closest("section:not([data-setting-id])")?.querySelector("h3")?.textContent?.trim(), meta.id).toBe(
        meta.section,
      );
      expect(block.querySelector('[data-testid="setting-affects"]'), meta.id).not.toBeNull();
      expect(meta.purpose.length, meta.id).toBeGreaterThan(60);
    }
  });
});
