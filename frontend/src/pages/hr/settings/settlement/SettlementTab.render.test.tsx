import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { SettlementSettings } from "@/lib/api-client/custom-hooks/settlement-automation";
import SettlementTab from "../SettlementTab";

// Settings -> Loan & Advance (owner 2026-11-26; Settlement until 2026-11-27) against a fake server: the two methods as sub-tabs, which one is active, "Use
// this method" behind an in-page confirm (what it sends, the refusal while a batch is in progress), the auditor's and
// Accounts' addresses (checked as they are added, what Save sends) and a login that may only look.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // a #setting address scrolls its block into view (kit/jump.ts)
  Element.prototype.scrollIntoView ??= () => {};
});

const SA_RULES = {
  percent: 50,
  windowFromDay: 21,
  windowToDay: 22,
  earnedThroughDay: 20,
  perMonth: 1,
  rejectedAllowsReapply: true,
  windowText: "the 21st and 22nd of each month",
};
const TL_RULES = {
  limitPercent: 100,
  effectivePercent: 100,
  allowAboveSalary: false,
  maxMonths: 6,
  absoluteMaxMonths: 12,
  minAmount: 1000,
  perYear: 1,
  minServiceMonths: 6,
  reapplyNextMonth: true,
  oneOpenAtATime: true,
  staffOnly: true,
};
/** advance_rules.LIMITS as the server sends them. */
const RULE_LIMITS = {
  sa_percent: { min: 1, max: 100 },
  sa_window_from: { min: 1, max: 28 },
  sa_window_to: { min: 1, max: 28 },
  sa_earned_through: { min: 1, max: 28 },
  sa_per_month: { min: 1, max: 5 },
  tl_limit_percent: { min: 1, max: 1000 },
  tl_max_months: { min: 1, max: 12 },
  tl_min_amount: { min: 0, max: 1000000 },
  tl_per_year: { min: 1, max: 12 },
  tl_min_service_months: { min: 0, max: 120 },
};

const settings = (over: Partial<SettlementSettings> = {}): SettlementSettings => ({
  method: "normal",
  methods: [
    { key: "normal", label: "Normal Method" },
    { key: "automation", label: "Automation Method" },
  ],
  auditorEmails: ["auditor@firm.in"],
  auditorCc: [],
  accountsEmails: [],
  accountsCc: [],
  updatedBy: "Priya HR",
  updatedAt: "2026-11-25T05:00:00Z",
  canChange: true,
  inProgress: [],
  salaryAdvanceRules: { ...SA_RULES },
  termLoanRules: { ...TL_RULES },
  ruleLimits: RULE_LIMITS,
  ruleDefaults: { salaryAdvance: { ...SA_RULES }, termLoan: { ...TL_RULES } },
  ...over,
});

let saved: SettlementSettings;
let puts: Record<string, unknown>[];
let refuseNext: { status: number; data: Record<string, unknown> } | null;

function server(url: string, options?: { method?: string; body?: string }) {
  if (url === "/api/settlement-settings" && options?.method === "PUT") {
    const body = JSON.parse(options.body ?? "{}") as Record<string, unknown>;
    puts.push(body);
    if (refuseNext) {
      const r = refuseNext;
      refuseNext = null;
      return Promise.reject(
        new ApiError(new Response(null, { status: r.status, statusText: "Refused" }), r.data, { method: "PUT", url }),
      );
    }
    const { salaryAdvanceRules, termLoanRules, ...rest } = body as Partial<SettlementSettings>;
    saved = {
      ...saved,
      ...rest,
      // the server keeps the rules it was not sent
      ...(salaryAdvanceRules && { salaryAdvanceRules: { ...saved.salaryAdvanceRules!, ...salaryAdvanceRules } }),
      ...(termLoanRules && { termLoanRules: { ...saved.termLoanRules!, ...termLoanRules } }),
    };
    return Promise.resolve({ ...saved });
  }
  if (url === "/api/settlement-settings") return Promise.resolve({ ...saved });
  return Promise.resolve({});
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  saved = settings();
  puts = [];
  refuseNext = null;
  h.fetch.mockImplementation(server);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(readOnly = false, hash = "") {
  window.history.replaceState(null, "", `/hr/settings?tab=settlement${hash}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(SettlementTab, { readOnly }))));
  await flush();
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
async function click(el: Element | null) {
  expect(el, "element to click").not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}
const pillButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").includes(label) && !b.dataset.testid,
  );
async function typeIn(el: Element | null, value: string) {
  await act(async () => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(el: Element | null, k: string) {
  await act(async () => {
    el!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}
const saveButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("Save Loan & Advance Settings"),
  );

describe("Settings -> Loan & Advance: the method", () => {
  it("opens on the active method and says which one runs", async () => {
    await mount();
    expect(text(q("sl-active"))).toContain("Loan & Advance runs the Normal Method.");
    expect(text(q("sl-active"))).toContain("Last changed by Priya HR");
    expect(q("sl-normal")).not.toBeNull();
    expect(text(q("sl-normal"))).toContain("Active: the Loan & Advance pages run this method.");
    // the active method has no "Use this method"
    expect(q("sl-use-normal")).toBeNull();
    expect(pillButton("Automation Method")).toBeDefined();
  });

  it("switches to the Automation Method after an in-page confirm", async () => {
    await mount();
    await click(pillButton("Automation Method")!);
    expect(q("sl-automation")).not.toBeNull();
    expect(text(q("sl-stages"))).toContain("Auditor Review (in the Auditor Review Portal)");
    expect(text(q("sl-stages"))).toContain("HR Review of Auditor Changes");
    await click(q("sl-use-automation"));
    expect(text(q("sl-confirm-automation"))).toContain("Switch Loan & Advance to the Automation Method?");
    expect(puts).toEqual([]);
    await click(q("sl-confirm-automation-button"));
    expect(puts).toEqual([{ method: "automation" }]);
    expect(text(q("sl-active"))).toContain("runs the Automation Method");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Automation Method switched on" }));
  });

  it("shows the server's refusal and the batches in progress when the Normal Method cannot be switched back on", async () => {
    saved = settings({
      method: "automation",
      inProgress: [{ id: 7, month: 11, year: 2026, number: 1, stage: "hr_final", stageLabel: "HR Final Settlement" }],
    });
    refuseNext = {
      status: 409,
      data: { error: "A settlement batch is still in progress. Complete it first.", code: "workflow_in_progress" },
    };
    await mount();
    // it opens on the active method: Automation
    expect(q("sl-automation")).not.toBeNull();
    await click(pillButton("Normal Method")!);
    expect(text(q("sl-in-progress"))).toContain("Batch 1 of Nov 2026: HR Final Settlement");
    await click(q("sl-use-normal"));
    await click(q("sl-confirm-normal-button"));
    expect(puts).toEqual([{ method: "normal" }]);
    expect(text(q("sl-switch-error"))).toContain("A settlement batch is still in progress. Complete it first.");
    expect(text(q("sl-switch-error"))).toContain("Batch 1 of Nov 2026: HR Final Settlement");
    expect(text(q("sl-active"))).toContain("runs the Automation Method");
  });

  it("only shows a login that may not change it", async () => {
    saved = settings({ canChange: false });
    await mount();
    expect(text(q("sl-read-only"))).toContain("View only");
    await click(pillButton("Automation Method")!);
    expect((q("sl-use-automation") as HTMLButtonElement).disabled).toBe(true);
    expect((q("sl-input-auditorEmails") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("Settings -> Loan & Advance: the e-mail addresses", () => {
  it("opens the Automation Method's page from a link to an address setting", async () => {
    await mount(false, "#sl-accounts");
    expect(q("sl-field-accountsEmails")).not.toBeNull();
  });

  it("adds an address on Enter, keeps a bad one back with the reason, and saves only what changed", async () => {
    await mount(false, "#sl-auditor");
    const cc = q("sl-input-auditorCc");
    await typeIn(cc, "md@uktextiles.in");
    await key(cc, "Enter");
    expect([...document.querySelectorAll('[data-testid="sl-chip-auditorCc"]')].map((c) => text(c))).toEqual([
      "md@uktextiles.in",
    ]);
    const to = q("sl-input-accountsEmails");
    await typeIn(to, "accounts@uktextiles");
    await key(to, "Enter");
    expect(text(q("sl-problem-accountsEmails"))).toBe("'accounts@uktextiles' is not an e-mail address.");
    expect((to as HTMLInputElement).value).toBe("accounts@uktextiles");
    // Save waits for the address still in the box
    expect(saveButton()!.disabled).toBe(true);
    await typeIn(to, "Accounts@UKTextiles.in");
    await key(to, "Enter");
    expect(saveButton()!.disabled).toBe(false);
    await click(saveButton()!);
    expect(puts).toEqual([{ auditorCc: ["md@uktextiles.in"], accountsEmails: ["accounts@uktextiles.in"] }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Loan & Advance settings saved" }));
  });

  it("removes an address with its ×, and shows the server's refusal at its field", async () => {
    await mount(false, "#sl-auditor");
    await click(document.querySelector('[aria-label="Remove auditor@firm.in"]'));
    expect(document.querySelectorAll('[data-testid="sl-chip-auditorEmails"]')).toHaveLength(0);
    const to = q("sl-input-auditorEmails");
    await typeIn(to, "new@firm.in");
    await key(to, "Enter");
    refuseNext = {
      status: 400,
      data: { error: "'new@firm.in' is not allowed.", code: "email", field: "auditorEmails" },
    };
    await click(saveButton()!);
    expect(puts).toEqual([{ auditorEmails: ["new@firm.in"] }]);
    expect(text(q("sl-problem-auditorEmails"))).toBe("'new@firm.in' is not allowed.");
  });
});

describe("Settings -> Loan & Advance: how long the auditor's review link works (2026-11-27)", () => {
  it("shows the saved days, refuses what is outside 1-30, and saves only the days when only they changed", async () => {
    saved = settings({ auditorLinkDays: 7, auditorLinkDaysLimits: { min: 1, max: 30, default: 7 } });
    await mount(false, "#sl-link-days");
    const days = q("sl-link-days") as HTMLInputElement;
    expect(days.value).toBe("7");
    expect(text(q("sl-link-days")?.closest("[data-setting-id]") ?? null)).toContain("1 to 30 days (7 by default)");
    expect(saveButton()!.disabled).toBe(true);
    await typeIn(days, "31");
    expect(text(q("sl-link-days-problem"))).toBe("Enter whole days from 1 to 30.");
    expect(saveButton()!.disabled).toBe(true);
    await typeIn(days, "2.5");
    expect(text(q("sl-link-days-problem"))).toBe("Enter whole days from 1 to 30.");
    await typeIn(days, "14");
    expect(q("sl-link-days-problem")).toBeNull();
    expect(saveButton()!.disabled).toBe(false);
    await click(saveButton()!);
    expect(puts).toEqual([{ auditorLinkDays: 14 }]);
    expect((q("sl-link-days") as HTMLInputElement).value).toBe("14");
  });

  it("shows the server's refusal of the days at the field", async () => {
    saved = settings({ auditorLinkDays: 7 });
    await mount(false, "#sl-link-days");
    await typeIn(q("sl-link-days"), "10");
    refuseNext = {
      status: 400,
      data: { error: "The review link must work 1 to 30 days.", code: "link_days", field: "auditorLinkDays" },
    };
    await click(saveButton()!);
    expect(text(q("sl-link-days-problem"))).toBe("The review link must work 1 to 30 days.");
  });

  it("is locked for a login that may not change it", async () => {
    saved = settings({ auditorLinkDays: 7, canChange: false });
    await mount(false, "#sl-link-days");
    expect((q("sl-link-days") as HTMLInputElement).disabled).toBe(true);
  });
});

// ───────────────────── the Salary Advance and Term Loan rules (owner 2026-11-27) ─────────────────────

const input = (id: string) => q(id) as HTMLInputElement;
const buttonWith = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(label));

describe("Settings -> Loan & Advance: one row of four sub-tabs", () => {
  it("Normal Method, Automation Method, Salary Advance Rules and Term Loan Rules in ONE tab row", async () => {
    await mount();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((t) => text(t));
    expect(tabs).toHaveLength(4);
    ["Normal Method", "Automation Method", "Salary Advance Rules", "Term Loan Rules"].forEach((label, i) =>
      expect(tabs[i]).toContain(label),
    );
    await click(pillButton("Term Loan Rules")!);
    expect(q("sl-tl-rules")).not.toBeNull();
    expect(q("sl-summary")).toBeNull(); // the method's page is its own sub-tab
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });

  it("a link to a rule opens its sub-tab", async () => {
    await mount(false, "#sl-tl-repay");
    expect(q("sl-tl-max-months")).not.toBeNull();
  });
});

describe("Settings -> Loan & Advance: Salary Advance Rules", () => {
  it("shows the saved rules and the preview, checks each field, and saves only what changed", async () => {
    await mount();
    await click(pillButton("Salary Advance Rules")!);
    expect(input("sl-sa-percent").value).toBe("50");
    expect(input("sl-sa-earned-through").value).toBe("20");
    expect(input("sl-sa-window-from").value).toBe("21");
    expect(input("sl-sa-window-to").value).toBe("22");
    expect(input("sl-sa-per-month").value).toBe("1");
    expect(q("sl-sa-rejected")?.getAttribute("aria-checked")).toBe("true");
    expect(text(q("sl-sa-preview"))).toContain(
      "apply on the 21st and 22nd of each month; up to 50% of the salary earned from the 1st to the 20th",
    );
    expect(buttonWith("Save Salary Advance rules")!.disabled).toBe(true);

    await typeIn(q("sl-sa-percent"), "101");
    expect(text(q("sl-sa-percent-problem"))).toBe("Enter a whole number from 1 to 100.");
    expect(buttonWith("Save Salary Advance rules")!.disabled).toBe(true);
    await typeIn(q("sl-sa-percent"), "40");
    await typeIn(q("sl-sa-earned-through"), "21");
    expect(text(q("sl-sa-earned-through-problem"))).toContain(
      "Count the earned salary up to a day BEFORE the window opens",
    );
    await typeIn(q("sl-sa-earned-through"), "18");
    await typeIn(q("sl-sa-window-from"), "23");
    expect(text(q("sl-sa-window-to-problem"))).toBe("The window must start on or before the day it ends.");
    await typeIn(q("sl-sa-window-from"), "21");
    await click(q("sl-sa-rejected"));
    expect(q("sl-sa-rejected")?.getAttribute("aria-checked")).toBe("false");
    // the preview follows the form
    expect(text(q("sl-sa-preview"))).toContain("up to 40% of the salary earned from the 1st to the 18th");
    expect(text(q("sl-sa-preview"))).toContain("(a rejected request counts too)");

    await click(buttonWith("Save Salary Advance rules")!);
    expect(puts).toEqual([{ salaryAdvanceRules: { percent: 40, earnedThroughDay: 18, rejectedAllowsReapply: false } }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Salary Advance rules saved" }));
    expect(input("sl-sa-percent").value).toBe("40");
  });

  it("Reset to defaults fills in the server's defaults, and Save sends them", async () => {
    saved = settings({ salaryAdvanceRules: { ...SA_RULES, percent: 40, perMonth: 2 } });
    await mount();
    await click(pillButton("Salary Advance Rules")!);
    expect(input("sl-sa-percent").value).toBe("40");
    await click(q("sl-sa-reset"));
    expect(input("sl-sa-percent").value).toBe("50");
    expect(input("sl-sa-per-month").value).toBe("1");
    await click(buttonWith("Save Salary Advance rules")!);
    expect(puts).toEqual([{ salaryAdvanceRules: { percent: 50, perMonth: 1 } }]);
  });

  it("puts the server's refusal under the field it names", async () => {
    await mount();
    await click(pillButton("Salary Advance Rules")!);
    await typeIn(q("sl-sa-window-to"), "25");
    refuseNext = {
      status: 400,
      data: { error: "The window must end by the 25th.", code: "rules", field: "sa_window_to" },
    };
    await click(buttonWith("Save Salary Advance rules")!);
    expect(puts).toEqual([{ salaryAdvanceRules: { windowToDay: 25 } }]);
    expect(text(q("sl-sa-window-to-problem"))).toBe("The window must end by the 25th.");
  });
});

describe("Settings -> Loan & Advance: Term Loan Rules", () => {
  it("staff only; above 100% only with its switch; months 1 to 12; saves only what changed", async () => {
    await mount();
    await click(pillButton("Term Loan Rules")!);
    expect(text(q("sl-tl-staff-only"))).toBe("Term Loans are for staff employees only.");
    expect(input("sl-tl-limit-percent").value).toBe("100");
    expect(input("sl-tl-max-months").value).toBe("6");
    expect(input("sl-tl-min-amount").value).toBe("1000");
    expect(q("sl-tl-above")?.getAttribute("aria-checked")).toBe("false");
    expect(q("sl-tl-one-open")?.getAttribute("aria-checked")).toBe("true");
    expect(text(q("sl-tl-preview"))).toContain("Up to 100% of the fixed monthly salary, from ₹1,000, repaid in 1 to 6");

    await typeIn(q("sl-tl-limit-percent"), "150");
    expect(text(q("sl-tl-limit-percent-problem"))).toBe(
      "Above 100% of the monthly salary needs 'Allow loan above monthly salary' switched on.",
    );
    expect(buttonWith("Save Term Loan rules")!.disabled).toBe(true);
    await click(q("sl-tl-above"));
    expect(q("sl-tl-limit-percent-problem")).toBeNull();
    expect(text(q("sl-tl-above-note"))).toBe("Loans above the monthly salary are allowed: up to 150% of it.");
    await typeIn(q("sl-tl-max-months"), "13");
    expect(text(q("sl-tl-max-months-problem"))).toBe("Enter a whole number from 1 to 12.");
    await typeIn(q("sl-tl-max-months"), "9");
    expect(text(q("sl-tl-preview"))).toContain("Up to 150% of the fixed monthly salary, from ₹1,000, repaid in 1 to 9");
    await click(buttonWith("Save Term Loan rules")!);
    expect(puts).toEqual([{ termLoanRules: { limitPercent: 150, allowAboveSalary: true, maxMonths: 9 } }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Term Loan rules saved" }));
  });

  it("the server's refusal: under its field, or under the block when it names none", async () => {
    await mount();
    await click(pillButton("Term Loan Rules")!);
    await typeIn(q("sl-tl-min-amount"), "500");
    refuseNext = { status: 400, data: { error: "Too small.", code: "rules", field: "tl_min_amount" } };
    await click(buttonWith("Save Term Loan rules")!);
    expect(text(q("sl-tl-min-amount-problem"))).toBe("Too small.");
    refuseNext = { status: 400, data: { error: "Settings are being changed by someone else.", code: "rules" } };
    await click(buttonWith("Save Term Loan rules")!);
    expect(text(q("sl-tl-error"))).toBe("Settings are being changed by someone else.");
  });

  it("is locked for a login that may not change it", async () => {
    saved = settings({ canChange: false });
    await mount();
    await click(pillButton("Term Loan Rules")!);
    expect(input("sl-tl-limit-percent").disabled).toBe(true);
    expect((q("sl-tl-reset") as HTMLButtonElement).disabled).toBe(true);
    await click(pillButton("Salary Advance Rules")!);
    expect(input("sl-sa-percent").disabled).toBe(true);
  });
});
