import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT,
  MESSAGES,
  PREVIOUS,
  button,
  click,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  nestedLabels,
  nestedTab,
  pathname,
  pillLabels,
  press,
  q,
  refusal,
  settle,
  tab,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";
import { monthLabel } from "./logic";

// SMS Control in jsdom, with a fake server behind customFetch that answers like sms_control_views.py (2026-11-20): the tabs
// and nested tabs that each have an address (and the retired Channel one), which tab renders and what it asks the server
// for, the status line and the alerts, the month's usage and cost, the OTP switches (the master switch asks first and cannot
// be switched on before 2Factor is set up), the limits, the price and budget, the stale guard, the messages, the test (by
// employee code or by number, with the development lock), the setup, the view-only and branch roles, and the keyboard.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: {
    current: null as { role: string; employeeId: null; branchId?: number; permissions: Record<string, string> } | null,
  },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
// the shared Refresh button subscribes to every query: its re-renders are not what these tests are about
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
// jsdom has no layout, so recharts' ResponsiveContainer would draw nothing: give the chart a fixed size so the real chart
// configuration is rendered
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 240 }),
  };
});

vi.setConfig({ testTimeout: 20_000 });

const VIEW_ONLY = { role: "hr", employeeId: null, permissions: { sms_control: "view" } };

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = null;
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const BASE = "/hr/sms-control";
const headings = () => [...document.body.querySelectorAll("h2")].map(text);
const selected = (name: string) => tab(name).getAttribute("aria-selected") === "true";
const asked = () => world.gets.map((u) => u.split("?")[0]);
const saves = () => world.calls.filter((c) => c.method === "PATCH" || c.method === "PUT");
const input = (id: string) => must(id) as HTMLInputElement;
const switchOf = (id: string) => must(id) as HTMLButtonElement;

/** Opens an address and waits until a section (by test id) is on screen with its data. */
async function open(url: string, ready: string) {
  mountPage(url);
  await waitFor(() => !!q(ready), ready);
}

describe("the addresses", () => {
  it("the bare page opens Overview, with the heading and the six tabs", async () => {
    mountPage(BASE);
    expect(headings()).toEqual(["SMS Control"]);
    await waitFor(() => !!q("sms-overview"), "the overview");
    expect(pathname()).toBe(`${BASE}/overview`);
    expect(pillLabels()).toEqual(["Overview", "Usage & Cost", "Settings", "Messages", "Test", "Setup"]);
    expect(selected("Overview")).toBe(true);
    expect(selected("Settings")).toBe(false);
  });

  const cases: [string, string][] = [
    [BASE, `${BASE}/overview`],
    [`${BASE}/overview/deeper`, `${BASE}/overview`],
    [`${BASE}/nope`, `${BASE}/overview`],
    [`${BASE}/settings`, `${BASE}/settings/switches`],
    [`${BASE}/settings/nope`, `${BASE}/settings/switches`],
    // the retired one-channel choice: a bookmark of it opens the SMS code switches
    [`${BASE}/settings/channel`, `${BASE}/settings/switches`],
    [`${BASE}/settings/limits/extra`, `${BASE}/settings/limits`],
    [`${BASE}/usage/x`, `${BASE}/usage`],
    [`${BASE}/messages/whatever`, `${BASE}/messages`],
    [`${BASE}/setup/x`, `${BASE}/setup`],
  ];
  it.each(cases)("%s lands on %s", async (from, to) => {
    mountPage(from);
    await waitFor(() => pathname() === to, `the redirect to ${to}`);
    expect(pathname()).toBe(to);
  });

  it("replaces the entry, so Back does not bounce, and keeps the query string", async () => {
    const before = window.history.length;
    mountPage(`${BASE}?from=link`);
    await waitFor(() => pathname() === `${BASE}/overview`, "the redirect");
    expect(here()).toBe(`${BASE}/overview?from=link`);
    expect(window.history.length).toBe(before);
  });

  it("a click on a tab opens that tab at its own address, Settings on its first section", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    click(tab("Usage & Cost"));
    await waitFor(() => !!q("sms-usage"), "usage");
    expect(pathname()).toBe(`${BASE}/usage`);
    click(tab("Settings"));
    await waitFor(() => !!q("sms-settings"), "settings");
    expect(pathname()).toBe(`${BASE}/settings/switches`);
    click(tab("Messages"));
    expect(pathname()).toBe(`${BASE}/messages`);
    click(tab("Test"));
    expect(pathname()).toBe(`${BASE}/test`);
    click(tab("Setup"));
    expect(pathname()).toBe(`${BASE}/setup`);
  });

  it("keeps the Messages filters with Messages and the Usage month with Usage", async () => {
    await open(`${BASE}/messages?status=failed`, "sms-messages");
    click(tab("Usage & Cost"));
    await waitFor(() => !!q("sms-usage"), "usage");
    expect(here()).toBe(`${BASE}/usage`);
    click(tab("Messages"));
    await waitFor(() => here() === `${BASE}/messages?status=failed`, "the filters back");
  });
});

describe("each tab renders only its own section, and asks the server only for what it shows", () => {
  it("Overview asks for the overview only", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    expect(new Set(asked())).toEqual(new Set(["/api/sms-control/overview"]));
  });

  it("Usage & Cost asks for the usage only", async () => {
    await open(`${BASE}/usage`, "sms-usage-totals");
    expect(new Set(asked())).toEqual(new Set(["/api/sms-control/usage"]));
    expect(q("sms-overview")).toBeNull();
  });

  it("Settings > OTP Switches renders the switches and neither of the other two sections", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    expect(q("sms-section-limits")).toBeNull();
    expect(q("sms-section-cost")).toBeNull();
    expect(nestedLabels()).toEqual(["OTP Switches", "Limits", "Cost"]);
  });

  it("switching tabs swaps the section: the one that was open is gone", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    click(tab("Setup"));
    await waitFor(() => !!q("sms-setup"), "setup");
    expect(q("sms-overview")).toBeNull();
  });
});

describe("Overview", () => {
  it("says what SMS codes are doing in the status line, with the four facts and what they are offered for", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    const hero = must("sms-hero");
    expect(hero.getAttribute("data-state")).toBe("working");
    expect(text(must("sms-hero-title"))).toBe("SMS codes are working");
    expect(text(must("sms-hero-badge"))).toBe("Available");
    expect(text(must("sms-card-otp-value"))).toBe("On");
    expect(text(must("sms-card-configured-value"))).toBe("Yes");
    expect(text(must("sms-card-sending-value"))).toBe("Allowed");
    expect(text(must("sms-card-circuit-value"))).toBe("Working");
    expect(must("sms-hero-purpose-login").getAttribute("data-on")).toBe("true");
    expect(must("sms-hero-purpose-reset").getAttribute("data-on")).toBe("true");
    expect(must("sms-hero-purpose-activate").getAttribute("data-on")).toBe("false");
    expect(text(must("sms-codes-only"))).toContain("SMS is used only for one-time sign-in codes");
    expect(text(must("sms-independent"))).toContain("WhatsApp codes are switched on WhatsApp Control");
  });

  it("shows the month's codes, rates and cost against the budget, with where the month is heading", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    expect(text(must("sms-month"))).toContain("November 2026 so far");
    expect(text(must("sms-kpi-sent-value"))).toBe("240");
    expect(text(must("sms-kpi-failed-value"))).toBe("12");
    expect(text(must("sms-kpi-blocked-value"))).toBe("8");
    expect(text(must("sms-kpi-verified-value"))).toBe("180");
    expect(text(must("sms-kpi-delivery-value"))).toBe("95%");
    expect(text(must("sms-kpi-verified-rate-value"))).toBe("78%");
    expect(text(must("sms-cost-so-far"))).toBe("₹48.00");
    expect(text(must("sms-cost-projected"))).toBe("₹72.00");
    expect(text(must("sms-cost-budget"))).toBe("₹60.00");
    expect(must("sms-budget").getAttribute("data-level")).toBe("near");
    expect(text(must("sms-budget-line"))).toContain(
      "80% of the budget used. At this pace the month ends ₹12.00 over it.",
    );
    expect(must("sms-budget-bar").querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("80");
  });

  it("lists the server's alerts with a link to where each is dealt with", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    const alert = must("sms-alert-budget_projected");
    expect(alert.getAttribute("data-tone")).toBe("warn");
    expect(text(alert)).toContain("At this pace the month ends at about ₹72.00");
    expect(alert.querySelector("a")?.getAttribute("href")).toBe(`${BASE}/settings/cost`);
  });

  it("says nothing needs attention when the server has no alerts", async () => {
    world = installWorld(h.fetch, { overview: { alerts: [] } });
    await open(`${BASE}/overview`, "sms-overview");
    expect(text(must("sms-alerts-none"))).toBe("Nothing needs attention.");
  });

  it("shows the 2Factor balance, today and the caps", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    expect(text(must("sms-balance-value"))).toBe("820");
    expect(text(must("sms-today-sent"))).toBe("12 sent");
    expect(text(must("sms-today-failed"))).toBe("1 failed");
    expect(text(must("sms-cap-hour"))).toContain("12 of 100 SMS");
    expect(must("sms-cap-day").getAttribute("data-level")).toBe("ok");
  });

  it("says when SMS codes are off, and that nothing is sent", async () => {
    world = installWorld(h.fetch, {
      overview: { otpEnabled: false },
      status: { otpEnabled: false, available: false },
    });
    await open(`${BASE}/overview`, "sms-overview");
    expect(must("sms-hero").getAttribute("data-state")).toBe("off");
    expect(text(must("sms-hero-title"))).toBe("SMS codes are switched off");
    expect(text(must("sms-card-otp-value"))).toBe("Off");
    expect(q("sms-hero-purposes")).toBeNull();
  });

  it("says when 2Factor is not set up, naming what is missing and never a value", async () => {
    world = installWorld(h.fetch, {
      overview: {
        configured: false,
        env: { authKey: false, senderId: "", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
        balance: {
          credits: null as unknown as number,
          available: 0,
          checkedAt: null as unknown as string,
          error: null,
        },
      },
      status: { configured: false, available: false },
    });
    await open(`${BASE}/overview`, "sms-overview");
    expect(must("sms-hero").getAttribute("data-state")).toBe("not-configured");
    expect(text(must("sms-card-configured"))).toContain("Missing: TWOFACTOR_API_KEY, TWOFACTOR_SENDER_ID");
    expect(text(must("sms-balance-value"))).toBe("Unknown");
  });

  it("says when sending is paused, in the server's sentence", async () => {
    world = installWorld(h.fetch, {
      status: { paused: true, pauseReason: "The hourly limit of 100 SMS is used up." },
    });
    await open(`${BASE}/overview`, "sms-overview");
    expect(must("sms-hero").getAttribute("data-state")).toBe("paused");
    expect(text(must("sms-hero-detail"))).toContain("The hourly limit of 100 SMS is used up.");
    expect(text(must("sms-card-circuit-value"))).toBe("Paused");
  });

  it("offers to set a budget when there is none", async () => {
    world = installWorld(h.fetch, {
      overview: {
        cost: { ...world.overview.cost, budget: null as unknown as number, budgetUsedPct: null as unknown as number },
      },
    });
    await open(`${BASE}/overview`, "sms-overview");
    expect(q("sms-budget")).toBeNull();
    expect(text(must("sms-budget-none"))).toContain("No monthly budget is set.");
  });

  it("works the alerts out itself for an older server that sends none", async () => {
    world = installWorld(h.fetch, { overview: { alerts: undefined, today: { sent: 1, failed: 2, blocked: 0 } } });
    await open(`${BASE}/overview`, "sms-overview");
    expect(q("sms-alert-failed_today")).not.toBeNull();
    expect(q("sms-alert-budget_near")).not.toBeNull();
  });

  it("shows an error with a way to try again, then the overview", async () => {
    world.failNext["GET /api/sms-control/overview"] = new Error("offline");
    mountPage(`${BASE}/overview`);
    await waitFor(() => !!q("sms-overview-error"), "the error");
    click(button("Try again"));
    await waitFor(() => !!q("sms-overview"), "the overview");
  });
});

describe("Usage & Cost", () => {
  it("shows this month: totals, a bar per day, the purposes and the cost with its projection", async () => {
    await open(`${BASE}/usage`, "sms-usage-totals");
    expect(text(must("sms-usage"))).toContain(monthLabel(CURRENT));
    expect(text(must("sms-usage-sent-value"))).toBe("16");
    expect(text(must("sms-usage-failed-value"))).toBe("1");
    expect(text(must("sms-usage-blocked-value"))).toBe("2");
    expect(text(must("sms-usage-verified-value"))).toBe("13");
    // the rates are the server's (tests are left out of the used rate there)
    expect(text(must("sms-usage-sent"))).toContain("Delivery rate 94%");
    expect(text(must("sms-usage-verified"))).toContain("Used rate 81%");
    // the chart is drawn (one stacked bar group per series) and its numbers are in the table behind it
    expect(must("sms-usage-chart").querySelectorAll(".recharts-bar").length).toBe(3);
    const row = must("sms-usage-table").querySelector(`tr[data-date="${CURRENT}-01"]`);
    expect([...(row?.querySelectorAll("td") ?? [])].slice(1).map(text)).toEqual(["10", "1", "0", "8"]);
    expect(text(must("sms-purpose-login"))).toContain("Sign-in code");
    expect(text(must("sms-purpose-reset"))).toContain("Password reset");
    expect(q("sms-purpose-test")).not.toBeNull();
    expect(text(must("sms-usage-so-far"))).toBe("₹3.20");
    expect(text(must("sms-usage-projected"))).toBe("₹99.50");
    expect(text(must("sms-usage-price"))).toBe("₹0.20");
    expect(text(must("sms-usage-budget"))).toBe("₹60.00");
    expect(text(must("sms-usage-cost"))).toContain("So far");
    expect(q("sms-month-current")).toBeNull();
    expect((must("sms-month-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes to the month before, in the address, and shows it as a whole month without a projection", async () => {
    await open(`${BASE}/usage`, "sms-usage-totals");
    click(must("sms-month-prev"));
    await waitFor(() => here() === `${BASE}/usage?month=${PREVIOUS}`, "the month in the address");
    await waitFor(() => text(must("sms-usage-sent-value")) === "50", "the month before");
    expect(world.gets).toContain(`/api/sms-control/usage?month=${PREVIOUS}`);
    expect(text(must("sms-usage-cost"))).toContain("Month total");
    expect(q("sms-usage-projected")).toBeNull();
    // back to this month: it is left out of the address again
    click(must("sms-month-current"));
    await waitFor(() => here() === `${BASE}/usage`, "this month");
  });

  it("picks a month from the list, and opens one named in the address", async () => {
    await open(`${BASE}/usage?month=${PREVIOUS}`, "sms-usage-totals");
    await waitFor(() => text(must("sms-usage-sent-value")) === "50", "the month in the address");
    typeInto(must("sms-month-select") as HTMLSelectElement, CURRENT);
    await waitFor(() => here() === `${BASE}/usage`, "this month");
  });

  it("treats a month still to come, or a wrong one, as this month", async () => {
    await open(`${BASE}/usage?month=2999-01`, "sms-usage-totals");
    expect(world.gets).toContain("/api/sms-control/usage");
    expect((must("sms-month-select") as HTMLSelectElement).value).toBe(CURRENT);
  });

  it("shows an error with a way to try again", async () => {
    world.failNext["GET /api/sms-control/usage"] = new Error("offline");
    mountPage(`${BASE}/usage`);
    await waitFor(() => !!q("sms-usage-error"), "the error");
    click(button("Try again"));
    await waitFor(() => !!q("sms-usage-totals"), "the usage");
  });
});

describe("Settings > OTP Switches", () => {
  it("shows the master switch, the three uses, and the two plain lines about WhatsApp and codes-only", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    expect(switchOf("sms-switch-otpEnabled").getAttribute("aria-checked")).toBe("true");
    expect(text(must("sms-master-state"))).toBe("On: employees can get one-time codes by SMS");
    expect(switchOf("sms-switch-otpLoginEnabled").getAttribute("aria-checked")).toBe("true");
    expect(switchOf("sms-switch-otpActivateEnabled").getAttribute("aria-checked")).toBe("false");
    expect(text(must("sms-switches-independent"))).toContain("Either one is enough");
    expect(text(must("sms-switches-codes-only"))).toContain("No promotional, bulk or other SMS");
    expect(text(must("sms-settings-updated"))).toContain("Last saved by Asha HR");
    expect(must("sms-switches-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).not.toMatch(/channel/i);
  });

  it("saves a change of use at once, with only the switches and the version", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(switchOf("sms-switch-otpActivateEnabled"));
    click(must("sms-switches-save-row-save"));
    await waitFor(() => saves().length === 1, "the save");
    expect(saves()[0].method).toBe("PATCH");
    expect(saves()[0].body).toEqual({
      otpEnabled: true,
      otpLoginEnabled: true,
      otpResetEnabled: true,
      otpActivateEnabled: true,
      expectedVersion: "v1",
    });
    await waitFor(() => must("sms-switches-save-row").getAttribute("data-dirty") === "false", "saved");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "SMS code switches saved" }));
  });

  it("asks first before switching SMS codes off, and sends nothing on Cancel", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(switchOf("sms-switch-otpEnabled"));
    expect(text(must("sms-master-pending"))).toContain("Nothing changes until you save");
    expect(must("sms-purposes").getAttribute("data-master")).toBe("off");
    click(must("sms-switches-save-row-save"));
    await waitFor(() => !!q("sms-master-confirm"), "the confirm");
    const dialog = text(must("sms-master-confirm"));
    expect(dialog).toContain("Switch SMS codes off?");
    expect(dialog).toContain("Nobody is locked out");
    click(button("Cancel"));
    await waitFor(() => !q("sms-master-confirm"), "the dialog to close");
    expect(saves()).toHaveLength(0);
    expect(switchOf("sms-switch-otpEnabled").getAttribute("aria-checked")).toBe("false");
  });

  it("switches SMS codes off after the confirm, and says so", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(switchOf("sms-switch-otpEnabled"));
    click(must("sms-switches-save-row-save"));
    await waitFor(() => !!q("sms-master-confirm"), "the confirm");
    click(button("Yes, switch off"));
    await waitFor(() => saves().length === 1, "the save");
    expect(saves()[0].body.otpEnabled).toBe(false);
    await waitFor(() => world.settings.otpEnabled === false, "saved off");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "SMS codes are off" }));
  });

  it("switches SMS codes on after the confirm, which names WhatsApp as independent", async () => {
    world = installWorld(h.fetch, { settings: { otpEnabled: false } });
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    expect(text(must("sms-purposes-kept"))).toContain("kept as they are");
    click(switchOf("sms-switch-otpEnabled"));
    click(must("sms-switches-save-row-save"));
    await waitFor(() => !!q("sms-master-confirm"), "the confirm");
    expect(text(must("sms-master-confirm"))).toContain("WhatsApp codes are switched on WhatsApp Control");
    click(button("Yes, switch on"));
    await waitFor(() => world.settings.otpEnabled === true, "saved on");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "SMS codes are on" }));
  });

  it("cannot switch SMS codes on while 2Factor is not set up: the switch is off, with the reason", async () => {
    world = installWorld(h.fetch, {
      settings: { otpEnabled: false },
      overview: { configured: false },
      status: { configured: false },
    });
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    await waitFor(() => !!q("sms-master-blocked"), "the reason");
    expect(text(must("sms-master-blocked"))).toContain("SMS codes cannot be switched on yet");
    expect(switchOf("sms-switch-otpEnabled").disabled).toBe(true);
    // the uses can still be set for later
    expect(switchOf("sms-switch-otpLoginEnabled").disabled).toBe(false);
  });

  it("can always switch SMS codes off, even when 2Factor went missing", async () => {
    world = installWorld(h.fetch, { overview: { configured: false }, status: { configured: false } });
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    await settle(20);
    expect(q("sms-master-blocked")).toBeNull();
    expect(switchOf("sms-switch-otpEnabled").disabled).toBe(false);
  });

  it("warns when SMS codes are on but all three uses are off", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(switchOf("sms-switch-otpLoginEnabled"));
    click(switchOf("sms-switch-otpResetEnabled"));
    expect(text(must("sms-switches-advice"))).toContain("all three uses are off");
  });

  it("shows the server's sentence when it refuses, and keeps the change", async () => {
    world.failNext["PATCH /api/sms-control/settings"] = refusal(400, {
      error: "otpLoginEnabled must be true or false.",
    });
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(switchOf("sms-switch-otpActivateEnabled"));
    click(must("sms-switches-save-row-save"));
    await waitFor(() => !!q("sms-switches-error"), "the error");
    expect(text(must("sms-switches-error"))).toBe("otpLoginEnabled must be true or false.");
    expect(switchOf("sms-switch-otpActivateEnabled").getAttribute("aria-checked")).toBe("true");
  });

  it("falls back to PUT for a server that does not take PATCH", async () => {
    world.failNext["PATCH /api/sms-control/settings"] = refusal(405, { detail: 'Method "PATCH" not allowed.' });
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(switchOf("sms-switch-otpActivateEnabled"));
    click(must("sms-switches-save-row-save"));
    await waitFor(() => saves().length === 2, "the second try");
    expect(saves().map((c) => c.method)).toEqual(["PATCH", "PUT"]);
    await waitFor(() => world.settings.otpActivateEnabled === true, "saved");
  });
});

describe("Settings > Limits", () => {
  it("refuses a number outside its range where it is typed, and keeps Save off", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "16");
    expect(text(must("sms-setting-otpExpiryMinutes"))).toContain("Enter a whole number from 1 to 15.");
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(text(must("sms-limits-save-row"))).toContain("Fix this first");
  });

  it("saves the limits only, with the version", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "8");
    expect(text(must("sms-example-otpExpiryMinutes"))).toContain("10:08");
    click(must("sms-limits-save-row-save"));
    await waitFor(() => saves().length === 1, "the save");
    expect(saves()[0].body).toEqual({
      otpExpiryMinutes: 8,
      resendCooldownSeconds: 60,
      maxRequestsPerHour: 5,
      maxAttemptsPerCode: 5,
      maxPerPhonePerHour: 5,
      hourlyCap: 100,
      dailyCap: 500,
      expectedVersion: "v1",
    });
  });

  it("keeps what was typed in one section while another is looked at, and saves each section on its own", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-hourlyCap"), "150");
    click(nestedTab("switches"));
    await waitFor(() => !!q("sms-section-switches"), "switches");
    click(switchOf("sms-switch-otpActivateEnabled"));
    click(must("sms-switches-save-row-save"));
    await waitFor(() => saves().length === 1, "the switches save");
    expect(saves()[0].body).not.toHaveProperty("hourlyCap");
    click(nestedTab("limits"));
    await waitFor(() => !!q("sms-section-limits"), "limits");
    expect(input("sms-input-hourlyCap").value).toBe("150");
  });

  it("refuses a stale copy: says so, keeps the edits, and offers to reload", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "10");
    world.saveElsewhere();
    click(must("sms-limits-save-row-save"));
    await waitFor(() => !!q("sms-limits-error"), "the error");
    expect(text(must("sms-limits-error"))).toContain("Someone else saved these settings while you were editing");
    expect(input("sms-input-otpExpiryMinutes").value).toBe("10");
    click(must("sms-settings-reload"));
    await waitFor(() => !!q("sms-reload-confirm"), "the reload confirm");
    click(button("Reload and discard"));
    await waitFor(() => !q("sms-limits-error"), "the error to go");
    expect(input("sms-input-otpExpiryMinutes").value).toBe("5");
    typeInto(input("sms-input-otpExpiryMinutes"), "8");
    click(must("sms-limits-save-row-save"));
    await waitFor(() => saves().length === 2, "the second save");
    expect(saves()[1].body.expectedVersion).toBe("v2");
  });
});

describe("Settings > Cost", () => {
  it("shows the price and the budget, with an example worked out from the price", async () => {
    await open(`${BASE}/settings/cost`, "sms-section-cost");
    expect(input("sms-input-pricePerSms").value).toBe("0.2");
    expect(input("sms-input-monthlyBudget").value).toBe("60");
    expect(text(must("sms-example-pricePerSms"))).toBe("Example: 1,000 SMS codes at ₹0.20 each cost ₹200.00.");
    await waitFor(() => !!q("sms-example-monthlyBudget"), "the month's example");
    expect(text(must("sms-example-monthlyBudget"))).toContain("240 SMS so far this month cost about ₹48.00");
    typeInto(input("sms-input-pricePerSms"), "0.115");
    expect(text(must("sms-example-pricePerSms"))).toBe("Example: 1,000 SMS codes at ₹0.115 each cost ₹115.00.");
  });

  it("refuses a price over ₹100 or a budget that is not an amount, before sending", async () => {
    await open(`${BASE}/settings/cost`, "sms-section-cost");
    typeInto(input("sms-input-pricePerSms"), "150");
    expect(text(must("sms-setting-pricePerSms"))).toContain("from 0 to 100");
    expect(must("sms-cost-save-row-save").hasAttribute("disabled")).toBe(true);
    typeInto(input("sms-input-pricePerSms"), "0.2");
    typeInto(input("sms-input-monthlyBudget"), "lots");
    expect(text(must("sms-setting-monthlyBudget"))).toContain("leave it empty for no budget");
    expect(must("sms-cost-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(saves()).toHaveLength(0);
  });

  it("saves the price and the budget only; an empty budget is no budget", async () => {
    await open(`${BASE}/settings/cost`, "sms-section-cost");
    typeInto(input("sms-input-pricePerSms"), "0.1150");
    typeInto(input("sms-input-monthlyBudget"), "");
    click(must("sms-cost-save-row-save"));
    await waitFor(() => saves().length === 1, "the save");
    expect(saves()[0].body).toEqual({ pricePerSms: 0.115, monthlyBudget: null, expectedVersion: "v1" });
    await waitFor(() => world.settings.monthlyBudget === null, "saved");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Price and budget saved" }));
  });
});

describe("Messages", () => {
  it("lists the log as the server sends it, with the number hidden and no code", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => document.body.querySelectorAll('[data-testid="sms-message-row"]').length === 7, "the rows");
    expect(text(must("sms-message-table"))).toContain("••••••1001");
    expect(text(must("sms-message-table"))).toContain("Sign-in code");
    expect(text(must("sms-message-table"))).toContain("Test code");
  });

  it("narrows by outcome, in the address, and opens already narrowed from a link", async () => {
    await open(`${BASE}/messages?status=failed`, "sms-message-table");
    await waitFor(
      () =>
        document.body.querySelectorAll('[data-testid="sms-message-row"]').length ===
        MESSAGES.filter((m) => m.status === "failed").length,
      "the failed rows",
    );
    expect(world.gets.some((u) => u.includes("status=failed"))).toBe(true);
  });
});

describe("Test", () => {
  it("sends a test code to an employee by code, and says it went", async () => {
    await open(`${BASE}/test`, "sms-test");
    expect(must("sms-test-mode-employee").getAttribute("aria-checked")).toBe("true");
    typeInto(input("sms-test-employee"), " 30020 ");
    click(must("sms-test-send"));
    await waitFor(() => !!q("sms-test-ok"), "the answer");
    expect(world.calls).toEqual([{ method: "POST", url: "/api/sms-control/test", body: { employeeCode: "30020" } }]);
    expect(text(must("sms-test-ok"))).toContain("Sent to employee 30020.");
  });

  it("sends a test code to a typed number, in ten digits", async () => {
    await open(`${BASE}/test`, "sms-test");
    click(must("sms-test-mode-phone"));
    typeInto(input("sms-test-phone"), "+91 98765 43210");
    click(must("sms-test-send"));
    await waitFor(() => !!q("sms-test-ok"), "the answer");
    expect(world.calls[0].body).toEqual({ phone: "9876543210" });
    expect(text(must("sms-test-ok"))).toContain("Sent to ••••••3210.");
  });

  it("refuses a code or number that cannot be one, before sending anything", async () => {
    await open(`${BASE}/test`, "sms-test");
    const help = () => document.getElementById("sms-test-help");
    click(must("sms-test-send"));
    expect(text(help())).toBe("Enter the employee's code, for example 30020.");
    expect(help()?.getAttribute("role")).toBe("alert");
    click(must("sms-test-mode-phone"));
    typeInto(input("sms-test-phone"), "12345");
    click(must("sms-test-send"));
    expect(text(help())).toContain("Enter a 10-digit Indian mobile number");
    expect(world.calls).toHaveLength(0);
  });

  it("shows the server's own words when it refuses, and an HTTP error as a sentence", async () => {
    world.testReply = { ok: false, message: "This development machine may send SMS only to employee 30020." };
    await open(`${BASE}/test`, "sms-test");
    typeInto(input("sms-test-employee"), "40001");
    click(must("sms-test-send"));
    await waitFor(() => !!q("sms-test-refused"), "the refusal");
    expect(text(must("sms-test-refused"))).toContain("may send SMS only to employee 30020");
    world.failNext["POST /api/sms-control/test"] = refusal(
      400,
      { ok: false, message: "No employee with that code. Choose the employee to send the test to." },
      "POST",
    );
    click(must("sms-test-send"));
    await waitFor(() => !!q("sms-test-failed"), "the failure");
    expect(text(must("sms-test-failed"))).toContain("No employee with that code");
  });

  it("names the development lock and fills the allowed employee in with one click", async () => {
    world = installWorld(h.fetch, { status: { devLock: { active: true, onlyToEmployees: ["30020"] } } });
    await open(`${BASE}/test`, "sms-test");
    await waitFor(() => !!q("sms-test-dev-lock"), "the lock note");
    expect(text(must("sms-test-dev-lock"))).toContain("texts only employee 30020 (SMS_ONLY_TO_EMPLOYEES)");
    click(must("sms-test-pick-30020"));
    expect(input("sms-test-employee").value).toBe("30020");
  });

  it("is off, with the reason and where to fix it, while 2Factor is not set up", async () => {
    world = installWorld(h.fetch, {
      overview: { configured: false, env: { ...world.overview.env, authKey: false } },
      status: { configured: false },
    });
    await open(`${BASE}/test`, "sms-test");
    await waitFor(() => !!q("sms-test-blocked"), "the reason");
    expect(text(must("sms-test-blocked"))).toContain("Not set: TWOFACTOR_API_KEY");
    expect((must("sms-test-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the SMS as employees get it: the OTP template with the 4-digit test code", async () => {
    await open(`${BASE}/test`, "sms-test");
    expect(text(must("sms-test-preview"))).toBe(
      "1234 is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.",
    );
    await waitFor(() => text(must("sms-test-preview-panel")).includes("UKTHRM"), "the sender");
  });
});

describe("Setup", () => {
  it("names every environment value with whether it is set, and never shows a value", async () => {
    world = installWorld(h.fetch, {
      overview: {
        env: { authKey: true, senderId: "", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
      },
    });
    await open(`${BASE}/setup`, "sms-setup");
    await waitFor(() => !!q("sms-env-state-authKey"), "the states");
    expect(text(must("sms-env-state-authKey"))).toBe("Set");
    expect(text(must("sms-env-state-senderId"))).toBe("Not set");
    expect(text(must("sms-env-SMS_ONLY_TO_EMPLOYEES"))).toContain("Optional");
    expect(text(must("sms-in-use-template"))).toContain("UKT_HRMS_OTP");
    expect(text(must("sms-in-use-sender"))).toContain("Not set");
    expect(text(must("sms-in-use-key"))).toContain("Set (hidden)");
    expect(document.body.querySelectorAll("input").length).toBe(0);
  });

  it("gives the template, the sender and the voice-call note, and ticks the switch step", async () => {
    await open(`${BASE}/setup`, "sms-setup");
    expect(text(must("sms-2f-template-text"))).toContain("XXXX is your UK Textiles HRMS OTP");
    expect(text(must("sms-2f-sender-id"))).toContain("UKTHRM");
    expect(text(must("sms-setup-voice"))).toContain("voice call");
    await waitFor(() => must("sms-step-switch").getAttribute("data-done") === "true", "the switch step ticked");
    expect(text(must("sms-setup-codes-only"))).toContain("No promotional, bulk or other SMS");
  });
});

describe("a View Only role", () => {
  beforeEach(() => {
    h.user.current = VIEW_ONLY;
  });

  it("can look at Settings but change and save nothing", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    for (const sw of document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
      expect(sw.disabled).toBe(true);
    expect(text(must("sms-switches-save-row"))).toContain("View only");
    click(nestedTab("cost"));
    await waitFor(() => !!q("sms-section-cost"), "cost");
    expect(input("sms-input-pricePerSms").disabled).toBe(true);
    expect(must("sms-cost-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(saves()).toHaveLength(0);
  });

  it("cannot send a test, and is told", async () => {
    await open(`${BASE}/test`, "sms-test");
    expect(text(must("sms-test-view-only"))).toContain("View only");
    expect((must("sms-test-send") as HTMLButtonElement).disabled).toBe(true);
    expect(world.calls).toHaveLength(0);
  });

  it("a branch login can look but not change: the settings and the test are company-wide", async () => {
    h.user.current = { role: "hr", employeeId: null, branchId: 3, permissions: { sms_control: "edit" } };
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    expect(input("sms-input-dailyCap").disabled).toBe(true);
    expect(text(must("sms-limits-save-row"))).toContain("Signed in for a branch");
  });
});

describe("the role's own keys for each tab and Settings section", () => {
  const as = (permissions: Record<string, string>) => {
    h.user.current = { role: "hr", employeeId: null, permissions: { sms_control: "edit", ...permissions } };
  };

  it("offers only the tabs the role may open, and the bare page lands on the first of them", async () => {
    as({ "sms_control.overview": "hidden", "sms_control.messages": "hidden" });
    mountPage(BASE);
    await waitFor(() => pathname() === `${BASE}/usage`, "the redirect to the first visible tab");
    expect(pillLabels()).toEqual(["Usage & Cost", "Settings", "Test", "Setup"]);
    expect(asked()).not.toContain("/api/sms-control/messages");
  });

  it("opens Settings on the first section the role may open; the retired Channel too", async () => {
    as({ "sms_control.settings.switches": "hidden" });
    mountPage(`${BASE}/settings/channel`);
    await waitFor(() => pathname() === `${BASE}/settings/limits`, "the first visible section");
    await waitFor(() => !!q("sms-section-limits"), "limits");
    expect(nestedLabels()).toEqual(["Limits", "Cost"]);
  });

  it("a section the role may only view is read-only, the others stay editable", async () => {
    as({ "sms_control.settings.cost": "view" });
    await open(`${BASE}/settings/cost`, "sms-section-cost");
    expect(input("sms-input-monthlyBudget").disabled).toBe(true);
    click(nestedTab("limits"));
    await waitFor(() => !!q("sms-section-limits"), "limits");
    expect(input("sms-input-dailyCap").disabled).toBe(false);
  });

  it("says so when no tab is open to the role", async () => {
    as(
      Object.fromEntries(
        ["overview", "usage", "settings", "messages", "test", "setup"].map((t) => [`sms_control.${t}`, "hidden"]),
      ),
    );
    mountPage(BASE);
    await waitFor(() => !!q("sms-nothing-open"), "the note");
    expect(pathname()).toBe(BASE);
  });
});

describe("the keyboard", () => {
  it("Left and Right move between the tabs of the row and open the one they land on; Home and End go to the ends", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    const first = tab("Overview");
    first.focus();
    press(first, "ArrowRight");
    await waitFor(() => pathname() === `${BASE}/usage`, "Usage & Cost");
    expect(document.activeElement).toBe(tab("Usage & Cost"));
    press(tab("Usage & Cost"), "End");
    await waitFor(() => pathname() === `${BASE}/setup`, "Setup");
    press(tab("Setup"), "Home");
    await waitFor(() => pathname() === `${BASE}/overview`, "Overview");
    press(tab("Overview"), "ArrowLeft");
    await waitFor(() => pathname() === `${BASE}/setup`, "round to Setup");
  });
});

describe("2Factor is the only provider, and SMS is for codes only", () => {
  it("no tab offers a provider to choose, a channel to pick, or a way to write SMS text", async () => {
    for (const tabPath of [
      "overview",
      "usage",
      "settings/switches",
      "settings/limits",
      "settings/cost",
      "test",
      "setup",
    ]) {
      await open(`${BASE}/${tabPath}`, `sms-panel-${tabPath.split("/")[0]}`);
      await settle(20);
      const page = text(document.body);
      expect(page, tabPath).not.toMatch(/MSG91|Twilio|Codes go by|Channel for codes/);
      expect(document.body.querySelectorAll("textarea").length, tabPath).toBe(0);
      unmountPage();
    }
  });
});
