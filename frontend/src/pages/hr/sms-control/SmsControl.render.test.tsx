import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGES,
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

// SMS Control in jsdom, with a fake server behind customFetch: the tabs and nested tabs that each have an address, the
// redirects, which section each renders (and that the others are not there, and ask the server for nothing), the settings
// (validation, one Save per section, the stale guard, the confirm when the channel changes), the messages filters, the test
// flow with its errors, the setup tab, the view-only role and the keyboard.

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
const puts = () => world.calls.filter((c) => c.method === "PUT");
const input = (id: string) => must(id) as HTMLInputElement;

/** Opens an address and waits until a section (by test id) is on screen with its data. */
async function open(url: string, ready: string) {
  mountPage(url);
  await waitFor(() => !!q(ready), ready);
}

describe("the addresses", () => {
  it("the bare page opens Overview, with the heading and the five tabs", async () => {
    mountPage(BASE);
    expect(headings()).toEqual(["SMS Control"]);
    await waitFor(() => !!q("sms-overview"), "the overview");
    expect(pathname()).toBe(`${BASE}/overview`);
    expect(pillLabels()).toEqual(["Overview", "Settings", "Messages", "Test", "Setup"]);
    expect(selected("Overview")).toBe(true);
    expect(selected("Settings")).toBe(false);
  });

  const cases: [string, string][] = [
    [BASE, `${BASE}/overview`],
    [`${BASE}/overview/deeper`, `${BASE}/overview`],
    [`${BASE}/nope`, `${BASE}/overview`],
    [`${BASE}/settings`, `${BASE}/settings/channel`],
    [`${BASE}/settings/nope`, `${BASE}/settings/channel`],
    [`${BASE}/settings/limits/extra`, `${BASE}/settings/limits`],
    [`${BASE}/messages/whatever`, `${BASE}/messages`],
    [`${BASE}/setup/x`, `${BASE}/setup`],
  ];
  it.each(cases)("%s lands on %s", async (from, to) => {
    mountPage(from);
    await waitFor(() => pathname() === to, `the redirect to ${to}`);
    expect(pathname()).toBe(to);
  });

  it("a trailing slash is the page itself", async () => {
    await open(`${BASE}/test/`, "sms-test");
    expect(pathname()).toBe(`${BASE}/test/`);
    expect(selected("Test")).toBe(true);
  });

  it("replaces the entry, so Back does not bounce, and keeps the query string", async () => {
    const before = window.history.length;
    mountPage(`${BASE}?from=link`);
    await waitFor(() => pathname() === `${BASE}/overview`, "the redirect");
    expect(here()).toBe(`${BASE}/overview?from=link`);
    expect(window.history.length).toBe(before);
  });

  it("a click on a tab is a new entry in the history and opens that tab at its own address", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    click(tab("Settings"));
    await waitFor(() => !!q("sms-settings"), "settings");
    expect(pathname()).toBe(`${BASE}/settings/channel`);
    expect(selected("Settings")).toBe(true);
    click(tab("Messages"));
    await waitFor(() => !!q("sms-messages"), "messages");
    expect(pathname()).toBe(`${BASE}/messages`);
    click(tab("Test"));
    expect(pathname()).toBe(`${BASE}/test`);
    click(tab("Setup"));
    expect(pathname()).toBe(`${BASE}/setup`);
  });
});

describe("each tab renders only its section", () => {
  const SECTIONS = ["sms-overview", "sms-settings", "sms-messages", "sms-test", "sms-setup"];
  const onlyThis = (id: string) => {
    for (const other of SECTIONS.filter((s) => s !== id)) expect(q(other), `${other} must not render`).toBeNull();
  };

  it("Overview", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    onlyThis("sms-overview");
    expect(must("sms-panel-overview")).toBeTruthy();
    // and asks the server only for what it shows
    await settle(20);
    expect(asked()).toEqual(["/api/sms-control/overview"]);
  });

  it("Settings > Channel renders the channel and neither of the other two sections", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    onlyThis("sms-settings");
    expect(q("sms-section-limits")).toBeNull();
    expect(q("sms-section-switches")).toBeNull();
    expect(nestedLabels()).toEqual(["Channel", "Limits", "Switches"]);
    expect(nestedTab("channel").getAttribute("aria-selected")).toBe("true");
    expect(asked().sort()).toEqual(["/api/sms-control/overview", "/api/sms-control/settings"]);
  });

  it("Settings > Limits", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    expect(q("sms-section-channel")).toBeNull();
    expect(q("sms-section-switches")).toBeNull();
    expect(nestedTab("limits").getAttribute("aria-selected")).toBe("true");
    expect(document.body.querySelectorAll('[data-testid^="sms-input-"]')).toHaveLength(7);
  });

  it("Settings > Switches", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    expect(q("sms-section-channel")).toBeNull();
    expect(q("sms-section-limits")).toBeNull();
    expect(document.body.querySelectorAll('[role="switch"]')).toHaveLength(3);
  });

  it("Messages", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    onlyThis("sms-messages");
    await waitFor(() => document.body.querySelectorAll('[data-testid="sms-message-row"]').length > 0, "rows");
    expect(asked()).toEqual(["/api/sms-control/messages"]);
  });

  it("Test", async () => {
    await open(`${BASE}/test`, "sms-test");
    onlyThis("sms-test");
  });

  it("Setup", async () => {
    await open(`${BASE}/setup`, "sms-setup");
    onlyThis("sms-setup");
  });

  it("switching tabs swaps the section: the one that was open is gone", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    click(tab("Setup"));
    await waitFor(() => !!q("sms-setup"), "setup");
    expect(q("sms-overview")).toBeNull();
    click(tab("Overview"));
    await waitFor(() => !!q("sms-overview"), "overview again");
    expect(q("sms-setup")).toBeNull();
  });
});

describe("Overview", () => {
  it("shows the state of the server in cards, in plain words", async () => {
    await open(`${BASE}/overview`, "sms-status-cards");
    expect(text(must("sms-card-channel"))).toContain("WhatsApp");
    expect(text(must("sms-card-configured"))).toContain("Yes");
    expect(text(must("sms-card-sending"))).toContain("Allowed");
    // 2Factor offers no balance check this system can use: the card says where to look instead of inventing a number
    expect(text(must("sms-card-balance"))).toContain("Not shown here");
    expect(text(must("sms-card-balance"))).toContain("Look at the balance in the 2Factor panel");
    expect(text(must("sms-today-sent"))).toBe("12 sent");
    expect(text(must("sms-today-failed"))).toBe("1 failed");
    expect(text(must("sms-today-blocked"))).toBe("0 blocked");
    expect(text(must("sms-card-hour"))).toContain("12 of 100");
    expect(text(must("sms-card-day"))).toContain("40 of 500");
    expect(text(must("sms-card-circuit"))).toContain("Working");
    expect(must("sms-hour-bar").getAttribute("data-level")).toBe("ok");
    expect(must("sms-hour-bar").querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("12");
  });

  it("draws the last seven days as bars with a table behind them for a screen reader", async () => {
    await open(`${BASE}/overview`, "sms-chart");
    expect(document.body.querySelectorAll('[data-testid^="sms-bar-"]')).toHaveLength(7);
    expect(must("sms-chart").querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Last 7 days: 48 sent, 4 failed",
    );
    const rows = must("sms-chart-table").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(7);
    expect([...rows[6].children].map(text)).toEqual(["Wed 14", "12", "1"]);
    expect(text(must("sms-last-sent"))).toContain("Last SMS sent:");
  });

  it("says so when nothing was sent in the week", async () => {
    world = installWorld(h.fetch, { overview: { last7Days: [], lastSentAt: null } });
    await open(`${BASE}/overview`, "sms-chart");
    expect(text(must("sms-chart-empty"))).toBe("No SMS in the last 7 days.");
    expect(text(must("sms-last-sent"))).toContain("none yet");
  });

  it("explains what to do next, here: 2Factor is ready but the codes still go by WhatsApp", async () => {
    await open(`${BASE}/overview`, "sms-next-steps");
    const steps = [...document.body.querySelectorAll('[data-testid^="sms-step-"]')].map((e) =>
      e.getAttribute("data-testid"),
    );
    // the one failure of today, the advice about switching, and the standing reminder about the balance, last
    expect(steps).toEqual(["sms-step-failed", "sms-step-switch", "sms-step-balance-note"]);
    expect(text(must("sms-step-switch"))).toContain("Codes still go by WhatsApp");
    const link = must("sms-step-switch").querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`${BASE}/settings/channel`);
  });

  it("names the missing 2Factor values, and shows no value", async () => {
    world = installWorld(h.fetch, {
      overview: {
        configured: false,
        env: { authKey: false, senderId: "UKTHRM", templateName: "", apiBase: "https://x.test/api" },
      },
    });
    await open(`${BASE}/overview`, "sms-step-configure");
    const step = text(must("sms-step-configure"));
    expect(step).toContain("TWOFACTOR_API_KEY, TWOFACTOR_TEMPLATE_NAME");
    expect(step).not.toContain("TWOFACTOR_SENDER_ID");
    expect(text(must("sms-card-configured"))).toContain("Missing: TWOFACTOR_API_KEY, TWOFACTOR_TEMPLATE_NAME");
    expect(text(must("sms-card-configured"))).toContain("No");
  });

  it("says why this machine will not send, with the server's sentence", async () => {
    const note = "This is a development machine, so no SMS leave it.";
    world = installWorld(h.fetch, { overview: { sendingAllowed: false, sendingNote: note } });
    await open(`${BASE}/overview`, "sms-step-sending-blocked");
    expect(text(must("sms-step-sending-blocked"))).toContain(note);
    expect(text(must("sms-card-sending"))).toContain("Not allowed");
    expect(text(must("sms-card-sending"))).toContain(note);
  });

  it("warns about a low or unreadable balance and a paused breaker, and turns the bars amber and red", async () => {
    world = installWorld(h.fetch, {
      overview: {
        channel: "sms",
        balance: { available: 40, checkedAt: null, error: null },
        circuit: { paused: true, until: "2026-10-14T10:11:00Z" },
        limits: { hourlyCap: 100, dailyCap: 500, hourUsed: 85, dayUsed: 500 },
      },
    });
    await open(`${BASE}/overview`, "sms-step-paused");
    expect(q("sms-step-balance-low")).not.toBeNull();
    expect(text(must("sms-card-circuit"))).toContain("Paused");
    expect(must("sms-hour-bar").getAttribute("data-level")).toBe("near");
    expect(must("sms-day-bar").getAttribute("data-level")).toBe("full");
    expect(q("sms-step-cap-day")).not.toBeNull();
    // the most serious first
    const order = [...document.body.querySelectorAll('#sms-next-steps, [data-testid^="sms-step-"]')].map((e) =>
      e.getAttribute("data-tone"),
    );
    expect(order[0]).toBe("bad");
  });

  it("shows a balance 2Factor reported as a number, and calls a low one low", async () => {
    world = installWorld(h.fetch, {
      overview: { balance: { available: 1520, checkedAt: "2026-10-14T06:00:00Z", error: null } },
    });
    await open(`${BASE}/overview`, "sms-card-balance");
    expect(text(must("sms-card-balance"))).toContain("1,520");
    expect(q("sms-step-balance-note")).toBeNull();
    expect(q("sms-step-balance-low")).toBeNull();
    unmountPage();
    world = installWorld(h.fetch, {
      overview: { balance: { available: 40, checkedAt: "2026-10-14T06:00:00Z", error: null } },
    });
    await open(`${BASE}/overview`, "sms-step-balance-low");
    expect(text(must("sms-card-balance"))).toContain("Low: top it up soon");
    expect(text(must("sms-step-balance-low"))).toContain("40 left");
  });

  it("says plainly when 2Factor refused the last message for lack of balance", async () => {
    world = installWorld(h.fetch, {
      overview: {
        balance: {
          available: null,
          checkedAt: null,
          error: "2Factor refused the last message because the account has no balance. Top it up in the 2Factor panel.",
        },
      },
    });
    await open(`${BASE}/overview`, "sms-step-balance-empty");
    expect(text(must("sms-card-balance"))).toContain("Empty");
    expect(text(must("sms-step-balance-empty"))).toContain("Codes cannot be sent until it is topped up");
    expect(must("sms-step-balance-empty").getAttribute("data-tone")).toBe("bad");
  });

  it("keeps the balance reminder last, and says everything is in order above it, when the channel is SMS", async () => {
    world = installWorld(h.fetch, { overview: { channel: "sms", today: { sent: 5, failed: 0, blocked: 0 } } });
    await open(`${BASE}/overview`, "sms-step-all-good");
    const steps = [...document.body.querySelectorAll('[data-testid^="sms-step-"]')].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(steps).toEqual(["sms-step-all-good", "sms-step-balance-note"]);
    expect(text(must("sms-step-balance-note"))).toContain("Look at the balance in the 2Factor panel");
  });

  it("links the failures and blocks to the Messages list already filtered", async () => {
    world = installWorld(h.fetch, { overview: { today: { sent: 2, failed: 3, blocked: 1 } } });
    await open(`${BASE}/overview`, "sms-step-failed");
    expect(must("sms-step-failed").querySelector("a")?.getAttribute("href")).toBe(`${BASE}/messages?status=failed`);
    expect(must("sms-step-blocked").querySelector("a")?.getAttribute("href")).toBe(`${BASE}/messages?status=blocked`);
  });

  it("shows a loading state first, then an error with a way to try again", async () => {
    world.failNext["GET /api/sms-control/overview"] = new Error("network down");
    mountPage(`${BASE}/overview`);
    expect(q("sms-overview-loading")).not.toBeNull();
    await waitFor(() => !!q("sms-overview-error"), "the error");
    expect(text(must("sms-overview-error"))).toContain("could not be loaded");
    click(button("Try again"));
    await waitFor(() => !!q("sms-overview"), "the overview after a retry");
    expect(q("sms-overview-error")).toBeNull();
  });

  it("survives an overview with keys left out", async () => {
    h.fetch.mockImplementation(async (url: string) => {
      if (url === "/api/sms-control/overview") return { channel: "sms" };
      world.unexpected.push(url);
      throw new Error(url);
    });
    await open(`${BASE}/overview`, "sms-overview");
    expect(text(must("sms-card-channel"))).toContain("SMS");
    expect(text(must("sms-card-balance"))).toContain("Not shown here");
  });
});

describe("Settings > Channel", () => {
  it("shows the two channels, the one in use, and the never-locked-out note", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    const whatsapp = must("sms-channel-whatsapp");
    const sms = must("sms-channel-sms");
    expect((whatsapp.querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect((sms.querySelector("input") as HTMLInputElement).checked).toBe(false);
    expect(text(whatsapp)).toContain("In use now");
    expect(text(sms)).not.toContain("In use now");
    expect(text(must("sms-never-locked-out"))).toContain("Nobody is ever locked out");
    expect(text(must("sms-setting-channel"))).toContain("What changes");
    expect(text(must("sms-settings-updated"))).toContain("Last saved by Asha HR");
    expect(must("sms-channel-save-row-save").hasAttribute("disabled")).toBe(true);
  });

  it("asks first when the channel changes, and sends nothing if HR says Cancel", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    click(must("sms-channel-sms").querySelector("input"));
    expect(text(must("sms-channel-pending"))).toContain("Nothing changes until you save");
    expect(must("sms-channel-save-row").getAttribute("data-dirty")).toBe("true");
    click(must("sms-channel-save-row-save"));
    await waitFor(() => !!q("sms-channel-confirm"), "the confirm");
    const dialog = text(must("sms-channel-confirm"));
    expect(dialog).toContain("Send codes by SMS?");
    expect(dialog).toContain("WhatsApp keeps sending every other message");
    click(button("Cancel"));
    await waitFor(() => !q("sms-channel-confirm"), "the dialog to close");
    expect(puts()).toHaveLength(0);
    // the choice is still there, unsaved
    expect((must("sms-channel-sms").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("saves the channel after the confirm, with the whole document and the version, and shows it as in use", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    click(must("sms-channel-sms").querySelector("input"));
    click(must("sms-channel-save-row-save"));
    await waitFor(() => !!q("sms-channel-confirm"), "the confirm");
    click(button("Yes, use SMS"));
    await waitFor(() => puts().length === 1, "the save");
    expect(puts()[0].body).toEqual({
      otpChannel: "sms",
      otpLoginEnabled: true,
      otpResetEnabled: true,
      otpActivateEnabled: true,
      otpExpiryMinutes: 5,
      resendCooldownSeconds: 60,
      maxRequestsPerHour: 5,
      maxAttemptsPerCode: 5,
      maxPerPhonePerHour: 5,
      hourlyCap: 100,
      dailyCap: 500,
      expectedVersion: "v1",
    });
    await waitFor(() => text(must("sms-channel-sms")).includes("In use now"), "the new channel in use");
    expect(text(must("sms-channel-whatsapp"))).not.toContain("In use now");
    expect(must("sms-channel-save-row").getAttribute("data-dirty")).toBe("false");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Codes now go by SMS" }));
  });

  it("asks again, in other words, when switching back to WhatsApp", async () => {
    world = installWorld(h.fetch, { settings: { otpChannel: "sms" } });
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    click(must("sms-channel-whatsapp").querySelector("input"));
    click(must("sms-channel-save-row-save"));
    await waitFor(() => !!q("sms-channel-confirm"), "the confirm");
    expect(text(must("sms-channel-confirm"))).toContain("Send codes by WhatsApp again?");
    click(button("Yes, use WhatsApp"));
    await waitFor(() => puts().length === 1, "the save");
    expect(puts()[0].body.otpChannel).toBe("whatsapp");
  });

  it("cannot choose SMS while the provider is not set up: the choice is off, with the reason", async () => {
    world = installWorld(h.fetch, { overview: { configured: false } });
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    await waitFor(() => !!q("sms-channel-blocked"), "the reason");
    const sms = must("sms-channel-sms").querySelector("input") as HTMLInputElement;
    expect(sms.disabled).toBe(true);
    expect(text(must("sms-channel-blocked"))).toContain(
      "SMS cannot be chosen yet: 2Factor is not set up on the server",
    );
    expect(sms.getAttribute("aria-describedby")).toBe("sms-channel-blocked");
    // WhatsApp stays chosen, and nothing can be saved
    expect((must("sms-channel-whatsapp").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(must("sms-channel-save-row-save").hasAttribute("disabled")).toBe(true);
  });

  it("a channel that is already SMS can always be left, whatever the provider", async () => {
    world = installWorld(h.fetch, { overview: { configured: false }, settings: { otpChannel: "sms" } });
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    await settle(20);
    expect(q("sms-channel-blocked")).toBeNull();
    click(must("sms-channel-whatsapp").querySelector("input"));
    click(must("sms-channel-save-row-save"));
    await waitFor(() => !!q("sms-channel-confirm"), "the confirm");
  });

  it("discards an unsaved choice", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    click(must("sms-channel-sms").querySelector("input"));
    click(must("sms-channel-save-row-discard"));
    expect((must("sms-channel-whatsapp").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(must("sms-channel-save-row").getAttribute("data-dirty")).toBe("false");
  });

  it("shows the server's warnings about what is saved", async () => {
    world = installWorld(h.fetch, {
      settings: {
        warnings: ["SMS is selected but 2Factor is not configured: employees will not be able to receive codes."],
      },
    });
    await open(`${BASE}/settings/channel`, "sms-settings-warnings");
    expect(text(must("sms-settings-warnings"))).toContain("employees will not be able to receive codes");
  });

  it("shows why a save was refused, in the server's sentence, and keeps the choice", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    world.failNext["PUT /api/sms-control/settings"] = refusal(400, { error: "The channel must be whatsapp or sms." });
    click(must("sms-channel-sms").querySelector("input"));
    click(must("sms-channel-save-row-save"));
    await waitFor(() => !!q("sms-channel-confirm"), "the confirm");
    click(button("Yes, use SMS"));
    await waitFor(() => !!q("sms-channel-error"), "the error");
    expect(text(must("sms-channel-error"))).toBe("The channel must be whatsapp or sms.");
    expect(q("sms-settings-reload")).toBeNull();
    expect((must("sms-channel-sms").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("a loading state first, and an error with a way to try again", async () => {
    world.failNext["GET /api/sms-control/settings"] = new Error("network down");
    mountPage(`${BASE}/settings/channel`);
    expect(q("sms-settings-loading")).not.toBeNull();
    await waitFor(() => !!q("sms-settings-error"), "the error");
    click(button("Try again"));
    await waitFor(() => !!q("sms-section-channel"), "the section after a retry");
  });
});

describe("Settings > Limits", () => {
  it("explains every limit: what it is for, what changes, its default and its range", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    for (const key of [
      "otpExpiryMinutes",
      "resendCooldownSeconds",
      "maxRequestsPerHour",
      "maxAttemptsPerCode",
      "maxPerPhonePerHour",
      "hourlyCap",
      "dailyCap",
    ]) {
      const block = text(must(`sms-setting-${key}`));
      expect(block, key).toContain("What changes");
      expect(block, key).toContain("Default:");
      expect(block, key).toMatch(/From [\d,]+ to [\d,]+/);
      expect(must(`sms-example-${key}`), key).toBeTruthy();
    }
    expect(text(must("sms-setting-otpExpiryMinutes"))).toContain("Default: 5 minutes");
    expect(text(must("sms-example-otpExpiryMinutes"))).toContain("10:05");
    // the box is labelled by its title
    expect(document.body.querySelector('label[for="sms-otpExpiryMinutes"]')?.textContent).toBe("How long a code works");
  });

  it("refuses a number outside its range right where it is typed, and keeps Save off", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    const expiry = input("sms-input-otpExpiryMinutes");
    typeInto(expiry, "16");
    expect(text(must("sms-setting-otpExpiryMinutes"))).toContain("Enter a whole number from 1 to 15.");
    expect(expiry.getAttribute("aria-invalid")).toBe("true");
    expect(q("sms-example-otpExpiryMinutes")).toBeNull();
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(text(must("sms-limits-save-row"))).toContain("Fix this first: How long a code works");
    for (const bad of ["0", "", "abc", "5.5", "-2"]) {
      typeInto(expiry, bad);
      expect(expiry.getAttribute("aria-invalid"), bad).toBe("true");
      expect(must("sms-limits-save-row-save").hasAttribute("disabled"), bad).toBe(true);
    }
    typeInto(input("sms-input-resendCooldownSeconds"), "29");
    expect(text(must("sms-setting-resendCooldownSeconds"))).toContain("Enter a whole number from 30 to 600.");
    typeInto(input("sms-input-dailyCap"), "10001");
    expect(text(must("sms-setting-dailyCap"))).toContain("Enter a whole number from 1 to 10,000.");
    expect(puts()).toHaveLength(0);
  });

  it("works the example out from what is typed, before saving", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "9");
    expect(text(must("sms-example-otpExpiryMinutes"))).toContain("10:09");
    typeInto(input("sms-input-hourlyCap"), "2500");
    expect(text(must("sms-example-hourlyCap"))).toContain("2,500");
  });

  it("saves the section with the one change, the other values as saved, and the version", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "10");
    expect(must("sms-limits-save-row").getAttribute("data-dirty")).toBe("true");
    click(must("sms-limits-save-row-save"));
    await waitFor(() => puts().length === 1, "the save");
    expect(puts()[0].body).toMatchObject({
      otpChannel: "whatsapp",
      otpExpiryMinutes: 10,
      resendCooldownSeconds: 60,
      hourlyCap: 100,
      dailyCap: 500,
      expectedVersion: "v1",
    });
    // no confirm for a limit, and the saved state is shown
    expect(q("sms-channel-confirm")).toBeNull();
    await waitFor(() => must("sms-limits-save-row").getAttribute("data-dirty") === "false", "the saved state");
    expect(input("sms-input-otpExpiryMinutes").value).toBe("10");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Settings saved" }));
    expect(world.settings.otpExpiryMinutes).toBe(10);
  });

  it("is one Save per section: an unsaved choice in Channel is not sent with the limits", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    click(must("sms-channel-sms").querySelector("input"));
    // look at Limits, change a number there and save it
    click(nestedTab("limits"));
    await waitFor(() => !!q("sms-section-limits"), "limits");
    typeInto(input("sms-input-maxAttemptsPerCode"), "7");
    click(must("sms-limits-save-row-save"));
    await waitFor(() => puts().length === 1, "the save");
    expect(puts()[0].body.otpChannel).toBe("whatsapp");
    expect(puts()[0].body.maxAttemptsPerCode).toBe(7);
    // the choice made in Channel is still waiting there, unsaved
    click(nestedTab("channel"));
    await waitFor(() => !!q("sms-section-channel"), "channel");
    expect((must("sms-channel-sms").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(must("sms-channel-save-row").getAttribute("data-dirty")).toBe("true");
    // and what was typed in Limits is kept when it is not saved
    click(nestedTab("limits"));
    await waitFor(() => !!q("sms-section-limits"), "limits again");
    expect(input("sms-input-maxAttemptsPerCode").value).toBe("7");
  });

  it("keeps what was typed in a section while another is looked at", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-dailyCap"), "900");
    click(nestedTab("switches"));
    await waitFor(() => !!q("sms-section-switches"), "switches");
    click(nestedTab("limits"));
    await waitFor(() => !!q("sms-section-limits"), "limits");
    expect(input("sms-input-dailyCap").value).toBe("900");
    expect(must("sms-limits-save-row").getAttribute("data-dirty")).toBe("true");
  });

  it("discards the changes of the section", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-dailyCap"), "900");
    click(must("sms-limits-save-row-discard"));
    expect(input("sms-input-dailyCap").value).toBe("500");
    expect(must("sms-limits-save-row").getAttribute("data-dirty")).toBe("false");
  });

  it("refuses a daily cap below the hourly cap, where it is typed, as the server would", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-dailyCap"), "50");
    expect(text(must("sms-setting-dailyCap"))).toContain("The daily cap cannot be lower than the hourly cap (100).");
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(true);
    // raising the hourly cap with it makes it fine again
    typeInto(input("sms-input-hourlyCap"), "40");
    expect(text(must("sms-setting-dailyCap"))).not.toContain("cannot be lower");
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(false);
  });

  it("advises, without blocking, when the wait makes the hourly allowance unreachable", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-resendCooldownSeconds"), "600");
    typeInto(input("sms-input-maxRequestsPerHour"), "20");
    expect(text(must("sms-limits-advice"))).toContain("never use all the codes");
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(false);
  });

  it("shows the server's sentence when it refuses a save", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    world.failNext["PUT /api/sms-control/settings"] = refusal(400, {
      error: "Something only the server could know about.",
    });
    typeInto(input("sms-input-dailyCap"), "900");
    click(must("sms-limits-save-row-save"));
    await waitFor(() => !!q("sms-limits-error"), "the error");
    expect(text(must("sms-limits-error"))).toBe("Something only the server could know about.");
    expect(input("sms-input-dailyCap").value).toBe("900");
  });

  it("refuses a stale copy: says so, keeps the edits, and offers to reload", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "10");
    world.saveElsewhere();
    click(must("sms-limits-save-row-save"));
    await waitFor(() => !!q("sms-limits-error"), "the error");
    expect(text(must("sms-limits-error"))).toContain("Someone else saved these settings while you were editing");
    expect(input("sms-input-otpExpiryMinutes").value).toBe("10");
    expect(world.settings.otpExpiryMinutes).toBe(5);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.expectedVersion).toBe("v1");

    // Reload asks first (there are edits), then starts the form from what is saved now
    click(must("sms-settings-reload"));
    await waitFor(() => !!q("sms-reload-confirm"), "the reload confirm");
    click(button("Reload and discard"));
    await waitFor(() => !q("sms-limits-error"), "the error to go");
    expect(input("sms-input-otpExpiryMinutes").value).toBe("5");
    expect(text(must("sms-settings-updated"))).toContain("Someone Else");

    // and the next save carries the new version and goes through
    typeInto(input("sms-input-otpExpiryMinutes"), "8");
    click(must("sms-limits-save-row-save"));
    await waitFor(() => puts().length === 2, "the second save");
    expect(puts()[1].body.expectedVersion).toBe("v2");
    await waitFor(() => world.settings.otpExpiryMinutes === 8, "the saved value");
  });

  it("reloads without asking when there is nothing to lose", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    typeInto(input("sms-input-otpExpiryMinutes"), "10");
    world.saveElsewhere();
    click(must("sms-limits-save-row-save"));
    await waitFor(() => !!q("sms-settings-reload"), "the reload button");
    // typed back to what was saved: nothing to lose
    typeInto(input("sms-input-otpExpiryMinutes"), "5");
    click(must("sms-settings-reload"));
    await waitFor(() => !q("sms-limits-error"), "the error to go");
    expect(q("sms-reload-confirm")).toBeNull();
  });
});

describe("Settings > Switches", () => {
  it("explains each switch and shows what it says in words", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    for (const key of ["otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled"]) {
      expect(text(must(`sms-setting-${key}`)), key).toContain("What changes");
      expect(must(`sms-switch-${key}`).getAttribute("aria-checked"), key).toBe("true");
    }
    expect(text(must("sms-setting-otpLoginEnabled"))).toContain("Employees can sign in with an SMS code");
    // the channel is WhatsApp: the switches are kept for later, and the page says where the live ones are
    const note = must("sms-switches-channel-note");
    expect(text(note)).toContain("do nothing yet");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/hr/whatsapp-control");
  });

  it("says the switches are in force while the channel is SMS", async () => {
    world = installWorld(h.fetch, { settings: { otpChannel: "sms" } });
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    expect(text(must("sms-switches-channel-note"))).toContain("these switches are in force");
  });

  it("saves the section with the switches that changed", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    click(must("sms-switch-otpLoginEnabled"));
    expect(must("sms-switch-otpLoginEnabled").getAttribute("aria-checked")).toBe("false");
    expect(text(must("sms-setting-otpLoginEnabled"))).toContain("Employees cannot sign in with an SMS code");
    click(must("sms-switches-save-row-save"));
    await waitFor(() => puts().length === 1, "the save");
    expect(puts()[0].body).toMatchObject({
      otpLoginEnabled: false,
      otpResetEnabled: true,
      otpActivateEnabled: true,
      otpChannel: "whatsapp",
      expectedVersion: "v1",
    });
    await waitFor(() => must("sms-switches-save-row").getAttribute("data-dirty") === "false", "the saved state");
    expect(must("sms-switch-otpLoginEnabled").getAttribute("aria-checked")).toBe("false");
  });

  it("warns when all three are off", async () => {
    await open(`${BASE}/settings/switches`, "sms-section-switches");
    for (const key of ["otpLoginEnabled", "otpResetEnabled", "otpActivateEnabled"]) click(must(`sms-switch-${key}`));
    expect(text(must("sms-switches-advice"))).toContain("nobody can get a code by SMS");
  });
});

describe("Messages", () => {
  const rows = () => [...document.body.querySelectorAll('[data-testid="sms-message-row"]')];

  it("lists the log newest first as the server sends it, with the number hidden and no code", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => rows().length === 7, "seven rows");
    const first = text(rows()[0]);
    expect(first).toContain("Asha Kumar");
    expect(first).toContain("E001");
    expect(first).toContain("••••••1001");
    expect(first).toContain("Login code");
    expect(first).toContain("Sent");
    expect(first).toContain("2Factor ID MSG1");
    expect(first).toContain("2Factor");
    // a failed and a blocked row say why
    const failed = rows().find((r) => r.getAttribute("data-status") === "failed")!;
    expect(text(failed)).toContain("2Factor did not accept the number.");
    expect(text(rows().find((r) => r.getAttribute("data-status") === "blocked"))).toContain(
      "The hourly SMS limit was reached.",
    );
    // a test message is named as one, and a message with no employee on record says so
    expect(text(rows()[3])).toContain("Test message");
    expect(text(rows()[3])).not.toContain("E00");
    expect(text(rows()[5])).toContain("No employee");
    // never a full number or a code
    expect(text(document.body)).not.toMatch(/\b\d{6}\b/);
    expect(text(document.body)).not.toMatch(/\b\d{10}\b/);
    expect(text(document.body)).toContain("The code itself is never saved or shown here");
  });

  it("counts the outcomes on the pills", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => rows().length === 7, "seven rows");
    const label = (name: string) => text(tab(name).querySelector(".ptab-label"));
    expect(label("All")).toBe("All(7)");
    expect(label("Sent")).toBe("Sent(4)");
    expect(label("Failed")).toBe("Failed(2)");
    expect(label("Blocked")).toBe("Blocked(1)");
  });

  it("narrows by outcome, in the address", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => rows().length === 7, "seven rows");
    click(tab("Failed"));
    await waitFor(() => rows().length === 2, "two failed rows");
    expect(here()).toBe(`${BASE}/messages?status=failed`);
    expect(world.gets.at(-1)).toContain("status=failed");
    expect(tab("Failed").getAttribute("aria-selected")).toBe("true");
    click(tab("All"));
    await waitFor(() => rows().length === 7, "all rows again");
    expect(here()).toBe(`${BASE}/messages`);
  });

  it("opens already narrowed when the address says so (a link from the Overview)", async () => {
    await open(`${BASE}/messages?status=blocked`, "sms-message-table");
    await waitFor(() => rows().length === 1, "one blocked row");
    expect(tab("Blocked").getAttribute("aria-selected")).toBe("true");
    expect(text(rows()[0])).toContain("The hourly SMS limit was reached.");
    expect(must("sms-clear-filters")).toBeTruthy();
  });

  it("narrows by purpose", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => rows().length === 7, "seven rows");
    typeInto(must("sms-purpose-filter") as unknown as HTMLSelectElement, "activate");
    await waitFor(() => rows().length === 2, "two activation rows");
    expect(here()).toBe(`${BASE}/messages?purpose=activate`);
    expect(world.gets.at(-1)).toContain("purpose=activate");
  });

  it("searches by name or code, after a short pause, and the list follows", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => rows().length === 7, "seven rows");
    typeInto(input("sms-search"), "ravi");
    // nothing is asked while typing is still going on
    expect(world.gets.filter((u) => u.includes("search=ravi"))).toHaveLength(0);
    await waitFor(() => rows().length === 1, "one row for Ravi");
    expect(text(rows()[0])).toContain("Ravi Nair");
    expect(here()).toBe(`${BASE}/messages?q=ravi`);
    expect(world.gets.at(-1)).toContain("search=ravi");
  });

  it("narrows by date, and clears every filter at once", async () => {
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => rows().length === 7, "seven rows");
    typeInto(input("sms-date-from"), "2026-10-15");
    await waitFor(() => !!q("sms-messages-empty"), "no rows after the 14th");
    expect(text(must("sms-messages-empty"))).toBe("No messages match these filters.");
    expect(world.gets.at(-1)).toContain("dateFrom=2026-10-15");
    click(must("sms-clear-filters"));
    await waitFor(() => rows().length === 7, "seven rows again");
    expect(here()).toBe(`${BASE}/messages`);
    expect(input("sms-search").value).toBe("");
    expect(q("sms-clear-filters")).toBeNull();
  });

  it("says what an empty log means, in plain words", async () => {
    world.messages = [];
    await open(`${BASE}/messages`, "sms-message-table");
    await waitFor(() => !!q("sms-messages-empty"), "the empty state");
    expect(text(must("sms-messages-empty"))).toContain("No SMS has been sent yet");
    expect(q("sms-clear-filters")).toBeNull();
  });

  it("pages through a long log, in the address", async () => {
    world.messages = Array.from({ length: 23 }, (_, i) => ({
      ...MESSAGES[0],
      id: 100 + i,
      employeeName: `Person ${i + 1}`,
    }));
    await open(`${BASE}/messages?size=10`, "sms-message-table");
    await waitFor(() => rows().length === 10, "ten rows");
    expect(text(document.body)).toContain("1–10 of 23");
    click(button("2"));
    await waitFor(() => here().includes("page=2"), "page 2 in the address");
    await waitFor(() => text(rows()[0]).includes("Person 11"), "the second page");
    expect(world.gets.at(-1)).toContain("page=2");
    click(button("3"));
    await waitFor(() => rows().length === 3, "three rows on the last page");
  });

  it("shows an error with a way to try again, then the list", async () => {
    world.failNext["GET /api/sms-control/messages"] = new Error("network down");
    mountPage(`${BASE}/messages`);
    await waitFor(() => !!q("sms-messages-error"), "the error");
    click(button("Try again"));
    await waitFor(() => rows().length === 7, "the rows after a retry");
  });
});

describe("Test", () => {
  const send = () => must("sms-test-send") as HTMLButtonElement;
  const phone = () => input("sms-test-phone");
  const tests = () => world.calls.filter((c) => c.url === "/api/sms-control/test");

  it("sends a test to the number typed, in ten digits, and says it went", async () => {
    await open(`${BASE}/test`, "sms-test");
    typeInto(phone(), "+91 98765 43210");
    click(send());
    await waitFor(() => !!q("sms-test-ok"), "the result");
    expect(tests()).toHaveLength(1);
    expect(tests()[0].body).toEqual({ phone: "9876543210" });
    expect(text(must("sms-test-ok"))).toContain("Sent to ••••••3210.");
    expect(text(must("sms-test-ok"))).toContain("The test SMS was accepted by 2Factor.");
    // the full number is not echoed anywhere
    expect(text(must("sms-test-outcome"))).not.toContain("9876543210");
  });

  it("refuses a number that is not a mobile number, before sending anything", async () => {
    await open(`${BASE}/test`, "sms-test");
    for (const bad of ["", "12345", "5876543210", "hello"]) {
      typeInto(phone(), bad);
      click(send());
      await settle(5);
      expect(text(must("sms-test")), bad).toContain("Enter a 10-digit Indian mobile number");
      expect(phone().getAttribute("aria-invalid"), bad).toBe("true");
    }
    expect(tests()).toHaveLength(0);
    // typing again takes the complaint away
    typeInto(phone(), "9");
    expect(phone().getAttribute("aria-invalid")).toBeNull();
  });

  it("shows the server's own words when it refuses the test (not configured, sending off, over the limit)", async () => {
    await open(`${BASE}/test`, "sms-test");
    world.testReply = { ok: false, message: "You can send 3 test messages an hour. Try again after 4:15 pm." };
    typeInto(phone(), "9876543210");
    click(send());
    await waitFor(() => !!q("sms-test-refused"), "the refusal");
    expect(text(must("sms-test-refused"))).toContain("The test was not sent to ••••••3210.");
    expect(text(must("sms-test-refused"))).toContain("You can send 3 test messages an hour.");
    expect(q("sms-test-ok")).toBeNull();
  });

  it("shows an HTTP error as a sentence: the server's, or a plain one", async () => {
    await open(`${BASE}/test`, "sms-test");
    typeInto(phone(), "9876543210");
    world.failNext["POST /api/sms-control/test"] = refusal(
      429,
      { error: "Too many test messages. Try again later." },
      "POST",
    );
    click(send());
    await waitFor(() => !!q("sms-test-failed"), "the failure");
    expect(text(must("sms-test-failed"))).toContain("Too many test messages. Try again later.");

    world.failNext["POST /api/sms-control/test"] = new Error("network down");
    click(send());
    await waitFor(() => text(q("sms-test-outcome")).includes("Could not send the test SMS"), "the plain sentence");
    expect(text(must("sms-test-failed"))).toContain("Check the connection and try again.");

    world.failNext["POST /api/sms-control/test"] = refusal(403, { error: "permission_denied" }, "POST");
    click(send());
    await waitFor(() => text(q("sms-test-outcome")).includes("not allowed"), "the permission sentence");
    // each result replaces the last
    expect(document.body.querySelectorAll('[data-testid="sms-test-failed"]')).toHaveLength(1);
  });

  it("is off, with the reason and where to fix it, while 2Factor is not set up", async () => {
    world = installWorld(h.fetch, {
      overview: {
        configured: false,
        env: { authKey: false, senderId: "UKTHRM", templateName: "UKT_HRMS_OTP", apiBase: "" },
      },
    });
    await open(`${BASE}/test`, "sms-test-blocked");
    expect(text(must("sms-test-blocked"))).toContain("Not set: TWOFACTOR_API_KEY.");
    expect(must("sms-test-blocked").querySelector("a")?.getAttribute("href")).toBe(`${BASE}/setup`);
    expect(send().disabled).toBe(true);
    typeInto(phone(), "9876543210");
    click(send());
    await settle(5);
    expect(tests()).toHaveLength(0);
  });

  it("is off, with the server's sentence, while this machine may not send", async () => {
    world = installWorld(h.fetch, {
      overview: { sendingAllowed: false, sendingNote: "Sending is switched off on this machine." },
    });
    await open(`${BASE}/test`, "sms-test-blocked");
    expect(text(must("sms-test-blocked"))).toContain("Sending is switched off on this machine.");
    expect(send().disabled).toBe(true);
  });

  it("is off while sending is paused, and says until when", async () => {
    world = installWorld(h.fetch, { overview: { circuit: { paused: true, until: "2026-10-14T10:11:00Z" } } });
    await open(`${BASE}/test`, "sms-test-blocked");
    expect(text(must("sms-test-blocked"))).toMatch(/paused after repeated 2Factor failures until 3:41\s?pm/i);
    expect(send().disabled).toBe(true);
  });

  it("shows the message as employees will get it: the 2Factor template with a made-up code", async () => {
    await open(`${BASE}/test`, "sms-test");
    expect(text(must("sms-test-preview"))).toBe(
      "123456 is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.",
    );
    expect(text(must("sms-test"))).toContain("through 2Factor");
  });

  it("tells how many tests there can be and what they cost", async () => {
    await open(`${BASE}/test`, "sms-test");
    expect(text(must("sms-test"))).toContain("You can send 3 tests an hour");
    expect(text(must("sms-test"))).toContain("counts against the hourly and daily caps");
  });
});

describe("Setup", () => {
  const clipboard = vi.fn(async () => {});
  beforeEach(() => {
    clipboard.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
  });

  it("lists the six steps and ticks the ones the server says are done", async () => {
    await open(`${BASE}/setup`, "sms-setup");
    await waitFor(() => must("sms-step-env").getAttribute("data-done") === "true", "the ticks");
    expect(must("sms-step-account").getAttribute("data-done")).toBe("true");
    expect(must("sms-step-template").getAttribute("data-done")).toBe("true");
    expect(must("sms-step-env").getAttribute("data-done")).toBe("true");
    expect(must("sms-step-test").getAttribute("data-done")).toBe("true");
    // the channel is still WhatsApp
    expect(must("sms-step-channel").getAttribute("data-done")).toBe("false");
    expect(must("sms-step-watch").getAttribute("data-done")).toBe("unknown");
  });

  it("shows which required values are set and which are not, by name, with a Copy button each", async () => {
    world = installWorld(h.fetch, {
      overview: {
        configured: false,
        env: { authKey: false, senderId: "UKTHRM", templateName: "", apiBase: "https://2factor.in/API/V1" },
      },
    });
    await open(`${BASE}/setup`, "sms-env-list");
    await waitFor(() => !!q("sms-env-state-authKey"), "the states");
    expect(text(must("sms-env-state-authKey"))).toBe("Not set");
    expect(text(must("sms-env-state-senderId"))).toBe("Set");
    expect(text(must("sms-env-state-templateName"))).toBe("Not set");
    for (const name of [
      "TWOFACTOR_API_KEY",
      "TWOFACTOR_SENDER_ID",
      "TWOFACTOR_TEMPLATE_NAME",
      "TWOFACTOR_API_BASE",
      "SMS_ALLOW_SENDING",
    ]) {
      const row = must(`sms-env-${name}`);
      expect(text(row)).toContain(name);
      expect(row.querySelector(`button[aria-label="Copy ${name}"]`), name).not.toBeNull();
    }
    expect(text(must("sms-env-TWOFACTOR_API_BASE"))).toContain("The server uses: https://2factor.in/API/V1");
    expect(text(must("sms-env-TWOFACTOR_API_BASE"))).toContain("Optional");
    expect(text(must("sms-env-SMS_ALLOW_SENDING"))).toContain("Optional");
    expect(must("sms-step-env").getAttribute("data-done")).toBe("false");
  });

  it("never asks for the auth key or any value: there is no box on the tab, and it says where the key lives", async () => {
    await open(`${BASE}/setup`, "sms-setup");
    expect(document.body.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(text(must("sms-setup-secret"))).toContain("only ever kept on the server");
    expect(text(must("sms-setup-secret"))).toContain("never asks for it, never shows it");
    // the example text is an example, not a key
    expect(text(must("sms-env-TWOFACTOR_API_KEY"))).toContain("your_2factor_api_key_here");
  });

  it("gives the exact 2Factor steps: the template with XXXX, its name and sender ID, in copyable lines", async () => {
    await open(`${BASE}/setup`, "sms-setup");
    expect(text(must("sms-setup-secret"))).toContain("The 2Factor API key is only ever kept on the server");
    expect(text(must("sms-step-account"))).toContain("API key");
    const template = text(must("sms-step-template"));
    expect(template).toContain("SMS OTP > OTP Templates");
    expect(template).toContain("XXXX exactly once");
    expect(template).toContain("under 150 characters");
    expect(text(must("sms-env-SMS_ALLOW_SENDING"))).toContain("a development machine never does");
    for (const [id, value] of [
      [
        "sms-2f-template-text",
        "XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.",
      ],
      ["sms-2f-template-name", "UKT_HRMS_OTP"],
      ["sms-2f-sender-id", "UKTHRM"],
    ]) {
      expect(text(must(id)), id).toContain(value);
      click(must(id).querySelector("button"));
      await waitFor(() => clipboard.mock.calls.length > 0, `the copy of ${id}`);
      await settle(5);
      expect(clipboard).toHaveBeenLastCalledWith(value);
      await waitFor(() => text(must(id)).includes("Copied"), "Copied");
      clipboard.mockClear();
    }
  });

  it("copies an environment variable name, and the docs file name", async () => {
    await open(`${BASE}/setup`, "sms-setup");
    click(must("sms-env-TWOFACTOR_SENDER_ID").querySelector("button"));
    await waitFor(() => clipboard.mock.calls.length === 1, "the copy");
    await settle(5);
    expect(clipboard).toHaveBeenLastCalledWith("TWOFACTOR_SENDER_ID");
    expect(text(must("sms-setup-docs"))).toContain("2factor-sms-otp-integration.md");
    click(must("sms-setup-docs").querySelector("button"));
    await waitFor(() => clipboard.mock.calls.length === 2, "the second copy");
    await settle(5);
    expect(clipboard).toHaveBeenLastCalledWith("2factor-sms-otp-integration.md");
  });

  it("falls back to telling the person what to press when the browser refuses to copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    document.execCommand = vi.fn(() => false);
    await open(`${BASE}/setup`, "sms-setup");
    click(must("sms-2f-template-text").querySelector("button"));
    await waitFor(() => text(must("sms-2f-template-text")).includes("Press Ctrl+C"), "the fallback");
  });
});

describe("a View Only role", () => {
  beforeEach(() => {
    h.user.current = VIEW_ONLY;
  });

  it("can look at every tab, and nothing in Settings can be changed or saved", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    for (const radio of document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(radio.closest("fieldset")?.disabled).toBe(true);
    }
    expect(must("sms-channel-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(text(must("sms-channel-save-row"))).toContain("View only");

    click(nestedTab("limits"));
    await waitFor(() => !!q("sms-section-limits"), "limits");
    for (const box of document.body.querySelectorAll<HTMLInputElement>('[data-testid^="sms-input-"]')) {
      expect(box.disabled, box.id).toBe(true);
    }
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(true);

    click(nestedTab("switches"));
    await waitFor(() => !!q("sms-section-switches"), "switches");
    for (const sw of document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
      expect(sw.disabled).toBe(true);
    expect(must("sms-switches-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("cannot send a test, and is told", async () => {
    await open(`${BASE}/test`, "sms-test");
    expect(text(must("sms-test-view-only"))).toContain("View only");
    expect((must("sms-test-send") as HTMLButtonElement).disabled).toBe(true);
    expect(input("sms-test-phone").disabled).toBe(true);
    expect(world.calls).toHaveLength(0);
  });

  it("still sees the overview, the messages and the setup", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    click(tab("Messages"));
    await waitFor(() => document.body.querySelectorAll('[data-testid="sms-message-row"]').length === 7, "the rows");
    click(tab("Setup"));
    await waitFor(() => !!q("sms-setup"), "setup");
  });

  it("a branch login can look but not change: the settings and the test are company-wide", async () => {
    h.user.current = { role: "hr", employeeId: null, branchId: 3, permissions: { sms_control: "edit" } };
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    expect(input("sms-input-dailyCap").disabled).toBe(true);
    expect(must("sms-limits-save-row-save").hasAttribute("disabled")).toBe(true);
    expect(text(must("sms-limits-save-row"))).toContain("Signed in for a branch");
    unmountPage();
    await open(`${BASE}/test`, "sms-test");
    expect(text(must("sms-test-view-only"))).toContain("only an administrator");
    expect((must("sms-test-send") as HTMLButtonElement).disabled).toBe(true);
    expect(world.calls).toHaveLength(0);
  });

  it("an editor and an administrator can change things", async () => {
    h.user.current = { role: "hr", employeeId: null, permissions: { sms_control: "edit" } };
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    expect(input("sms-input-dailyCap").disabled).toBe(false);
    unmountPage();
    h.user.current = null;
    await open(`${BASE}/test`, "sms-test");
    expect((must("sms-test-send") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the keyboard", () => {
  const focusTab = (name: string) => {
    const t = tab(name);
    t.focus();
    return t;
  };

  it("Left and Right move between the tabs of the row and open the one they land on; Home and End go to the ends", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    press(focusTab("Overview"), "ArrowRight");
    await waitFor(() => pathname() === `${BASE}/settings/channel`, "Settings");
    expect(document.activeElement).toBe(tab("Settings"));
    press(document.activeElement!, "ArrowRight");
    await waitFor(() => pathname() === `${BASE}/messages`, "Messages");
    press(document.activeElement!, "End");
    await waitFor(() => pathname() === `${BASE}/setup`, "Setup");
    press(document.activeElement!, "ArrowRight");
    await waitFor(() => pathname() === `${BASE}/overview`, "Overview again (it wraps)");
    press(document.activeElement!, "ArrowLeft");
    await waitFor(() => pathname() === `${BASE}/setup`, "Setup again (it wraps back)");
    press(document.activeElement!, "Home");
    await waitFor(() => pathname() === `${BASE}/overview`, "Home");
  });

  it("ignores other keys, and a key pressed outside the tabs", async () => {
    await open(`${BASE}/overview`, "sms-overview");
    press(focusTab("Overview"), "a");
    press(document.body, "ArrowRight");
    await settle(5);
    expect(pathname()).toBe(`${BASE}/overview`);
  });

  it("the nested tabs are a tab list of their own: Left and Right open the next section, Tab leaves for the panel", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    const channel = nestedTab("channel");
    expect(channel.getAttribute("tabindex")).toBe("0");
    expect(nestedTab("limits").getAttribute("tabindex")).toBe("-1");
    channel.focus();
    press(channel, "ArrowRight");
    await waitFor(() => pathname() === `${BASE}/settings/limits`, "Limits");
    await waitFor(() => !!q("sms-section-limits"), "the limits section");
    press(nestedTab("limits"), "End");
    await waitFor(() => pathname() === `${BASE}/settings/switches`, "Switches");
  });

  it("every control is reachable and named: the boxes by their labels, the switches by their titles, the tab list and panel by roles", async () => {
    await open(`${BASE}/settings/limits`, "sms-section-limits");
    const names = [...document.body.querySelectorAll<HTMLInputElement>('[data-testid^="sms-input-"]')].map(
      (el) => document.body.querySelector(`label[for="${el.id}"]`)?.textContent,
    );
    expect(names.every(Boolean)).toBe(true);
    expect(document.body.querySelectorAll('[role="tablist"]').length).toBeGreaterThanOrEqual(2);
    expect(must("sms-panel-settings").getAttribute("role")).toBe("tabpanel");
    click(nestedTab("switches"));
    await waitFor(() => !!q("sms-section-switches"), "switches");
    for (const sw of document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
      const label = document.getElementById(sw.getAttribute("aria-labelledby")!);
      expect(label?.textContent, sw.id).toBeTruthy();
    }
  });

  it("the channel choice is a native radio group: one choice, in a fieldset that is labelled", async () => {
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    const radios = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"][name="sms-channel"]')];
    expect(radios.map((r) => r.value)).toEqual(["whatsapp", "sms"]);
    const fieldset = radios[0].closest("fieldset")!;
    expect(document.getElementById(fieldset.getAttribute("aria-labelledby")!)?.textContent).toBe("Channel for codes");
  });
});

// the name of the provider that was removed, spelled so that this file does not contain it
const OLD_PROVIDER = new RegExp(["msg", "91"].join(""), "i");

describe("2Factor is the only provider", () => {
  const TABS = ["overview", "settings/channel", "settings/limits", "settings/switches", "messages", "test", "setup"];

  it("no tab offers a provider to choose, and none names another provider", async () => {
    for (const tabPath of TABS) {
      await open(`${BASE}/${tabPath}`, `sms-panel-${tabPath.split("/")[0]}`);
      await waitFor(() => !document.body.querySelector('[data-testid$="-loading"]'), "the data");
      await settle(30);
      expect(document.body.querySelector('[data-testid^="sms-provider"]'), tabPath).toBeNull();
      expect(document.body.querySelector('input[name="sms-provider"]'), tabPath).toBeNull();
      expect(text(document.body), tabPath).not.toMatch(OLD_PROVIDER);
      unmountPage();
    }
  });

  it("the page speaks of 2Factor: cards, chart, missing values and the channel text", async () => {
    world = installWorld(h.fetch, {
      overview: {
        configured: false,
        env: { authKey: false, senderId: "UKTHRM", templateName: "", apiBase: "https://2factor.in/API/V1" },
        balance: { available: null, checkedAt: null, error: null },
      },
    });
    await open(`${BASE}/overview`, "sms-step-configure");
    expect(text(must("sms-step-configure"))).toContain("Add the 2Factor details to the server");
    expect(text(must("sms-step-configure"))).toContain("TWOFACTOR_API_KEY, TWOFACTOR_TEMPLATE_NAME");
    expect(text(must("sms-step-configure"))).not.toContain("TWOFACTOR_SENDER_ID");
    expect(text(must("sms-card-configured"))).toContain("Missing: TWOFACTOR_API_KEY, TWOFACTOR_TEMPLATE_NAME");
    expect(document.body.querySelector('[data-testid="sms-card-configured"] p')?.textContent?.trim()).toBe(
      "2Factor set up",
    );
    expect(text(must("sms-card-balance"))).toContain("2Factor balance");
    expect(text(must("sms-chart"))).toContain("SMS handed to 2Factor each day");
  });

  it("selecting SMS while 2Factor is not set up stays refused, by the server too, in its own sentence", async () => {
    // the page believes 2Factor is ready (the overview says so); the server refuses all the same
    await open(`${BASE}/settings/channel`, "sms-section-channel");
    await waitFor(() => !!q("sms-never-locked-out"), "the page");
    world.failNext["PUT /api/sms-control/settings"] = refusal(400, {
      error: "SMS can't be selected while 2Factor is not configured: TWOFACTOR_API_KEY is empty.",
    });
    click(must("sms-channel-sms").querySelector("input"));
    click(must("sms-channel-save-row-save"));
    await waitFor(() => !!q("sms-channel-confirm"), "the confirm");
    click(button("Yes, use SMS"));
    await waitFor(() => !!q("sms-channel-error"), "the error");
    expect(text(must("sms-channel-error"))).toBe(
      "SMS can't be selected while 2Factor is not configured: TWOFACTOR_API_KEY is empty.",
    );
    expect((must("sms-channel-sms").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });
});
