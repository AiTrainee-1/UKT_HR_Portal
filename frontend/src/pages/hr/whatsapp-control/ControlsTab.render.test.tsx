import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import ControlsTab from "./ControlsTab";

// Feature Controls of WhatsApp Control: the engine master switch (confirmed both ways), a switch for every message type
// grouped by module (shown, dimmed, while the engine is OFF), and the sending limits with quiet hours.

const CONFIG = {
  provider: "WAClient (WhatsApp Web API)",
  configured: true,
  instanceId: "…1234",
  apiUrl: "https://api.waclient.test/send",
  defaultCountryCode: "91",
  sendDelaySeconds: 2,
  publicBaseUrl: "https://api.example.test",
  webhookUrl: "https://api.example.test/api/whatsapp/webhook/",
  webhookTokenSet: true,
  backgroundSending: true,
};

const feature = (key: string, group: string, label: string, enabled = true) => ({
  key,
  group,
  label,
  description: `${label} description`,
  enabled,
});

type Settings = Record<string, unknown> & {
  engineEnabled?: boolean;
  features: { key: string; enabled: boolean }[];
  queueLimits?: (Record<string, unknown> & { key: string; value: number })[];
  quietHours?: { enabled: boolean; start: string; end: string };
};

const settings = (): Settings => ({
  engineEnabled: true,
  groups: [
    { key: "signin", title: "Employee sign-in", blurb: "How employees get in." },
    { key: "documents", title: "Documents", blurb: "Salary slips and letters." },
  ],
  features: [
    feature("otpLoginEnabled", "signin", "OTP login"),
    feature("documentNotificationsEnabled", "documents", "Document notifications"),
    feature("type:salary_slip", "documents", "Salary slip"),
    feature("type:id_card", "documents", "ID card"),
    feature("type:otp_login", "otp", "Login OTP"),
    feature("type:visitor_contact", "other", "Visitor contact card", false),
  ],
  timings: [{ key: "lateAlertGraceMinutes", label: "Late alert after (minutes)", value: 10, min: 0, max: 120 }],
  queueLimits: [
    { key: "minGapSeconds", label: "Gap between messages", value: 30, min: 5, max: 600, unit: "seconds" },
    { key: "maxPerHour", label: "Messages per hour", value: 60, min: 1, max: 500, unit: "messages" },
    { key: "maxPerDay", label: "Messages per day", value: 200, min: 1, max: 2000, unit: "messages" },
    { key: "maxPerEmployeePerDay", label: "Per employee per day", value: 3, min: 1, max: 20, unit: "messages" },
  ],
  quietHours: { enabled: true, start: "21:00", end: "07:00" },
  config: CONFIG,
  updatedAt: null,
});

/** A fake settings endpoint: GET answers the current state, PUT records the body and applies it (or refuses). */
function settingsServer(initial: Settings = settings()) {
  const state = initial;
  const puts: Record<string, unknown>[] = [];
  let refusal: { status: number; body: unknown } | null = null;
  const fixture = (_params: URLSearchParams, init?: RequestInit) => {
    if (init?.method !== "PUT") return state;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    puts.push(body);
    if (refusal) return refusal;
    for (const [key, value] of Object.entries(body)) {
      if (key === "engineEnabled") state.engineEnabled = value as boolean;
      else if (key === "quietHours") state.quietHours = { ...state.quietHours!, ...(value as object) };
      else {
        const f = state.features.find((x) => x.key === key);
        if (f) f.enabled = value as boolean;
        const l = state.queueLimits?.find((x) => x.key === key);
        if (l) l.value = value as number;
      }
    }
    return state;
  };
  return {
    fixture,
    puts,
    refuse: (status: number, body: unknown) => {
      refusal = { status, body };
    },
  };
}

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (server = settingsServer()) => {
  page = await renderMdPage(
    () => <ControlsTab />,
    { "/api/whatsapp-control/settings": server.fixture },
    { path: "/hr/whatsapp-control" },
  );
  return { page, server };
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const checked = (selector: string) => el(selector)?.getAttribute("aria-checked");
const groupOrder = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="wa-feature-group-"]')).map((g) =>
    g.dataset.testid!.replace("wa-feature-group-", ""),
  );

describe("WhatsApp engine master switch", () => {
  it("is shown first, ON, and turning it OFF asks first and warns that login codes stop too", async () => {
    const { server } = await open();
    expect(el('[data-testid="wa-engine"]')!.dataset.state).toBe("on");
    expect(checked('[data-testid="wa-engine-switch"]')).toBe("true");
    expect(page!.text()).toContain("WhatsApp engine");

    await page!.click('[data-testid="wa-engine-switch"]');
    // Nothing is sent until HR confirms.
    expect(server.puts).toEqual([]);
    const dialog = el('[data-testid="wa-engine-confirm"]')!;
    expect(dialog.textContent).toContain("Turn the WhatsApp engine OFF?");
    expect(dialog.textContent).toContain("One-time login codes will not go by WhatsApp either");
    expect(dialog.textContent).toContain("password");

    await page!.click('[data-testid="wa-engine-confirm-confirm"]');
    expect(server.puts).toEqual([{ engineEnabled: false }]);
    expect(el('[data-testid="wa-engine"]')!.dataset.state).toBe("off");
  });

  it("cancelling the confirmation changes nothing", async () => {
    const { server } = await open();
    await page!.click('[data-testid="wa-engine-switch"]');
    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
      (b) => b.textContent === "Cancel",
    )!;
    cancel.setAttribute("data-testid", "cancel-engine");
    await page!.click('[data-testid="cancel-engine"]');
    expect(server.puts).toEqual([]);
    expect(checked('[data-testid="wa-engine-switch"]')).toBe("true");
  });

  it("while OFF, keeps every switch on screen but marked inactive, and turning it ON confirms too", async () => {
    const server = settingsServer({ ...settings(), engineEnabled: false });
    await open(server);
    expect(el('[data-testid="wa-engine-off-note"]')).not.toBeNull();
    expect(el('[data-testid="toggle-type:salary_slip"]')).not.toBeNull();
    for (const group of groupOrder()) {
      expect(el(`[data-testid="wa-feature-group-${group}"]`)!.dataset.inactive).toBe("true");
    }
    // HR can still prepare the switches before turning the engine back on.
    expect(el('[data-testid="toggle-type:salary_slip"]')!.hasAttribute("disabled")).toBe(false);

    await page!.click('[data-testid="wa-engine-switch"]');
    expect(el('[data-testid="wa-engine-confirm"]')!.textContent).toContain("Turn the WhatsApp engine ON?");
    await page!.click('[data-testid="wa-engine-confirm-confirm"]');
    expect(server.puts).toEqual([{ engineEnabled: true }]);
    expect(el('[data-testid="wa-engine-off-note"]')).toBeNull();
  });
});

describe("a switch for every message type", () => {
  it("groups the per-type switches by module, adding the modules the server has no group for", async () => {
    await open();
    // OTP sits next to sign-in; anything else comes last.
    expect(groupOrder()).toEqual(["signin", "otp", "documents", "other"]);
    const docs = el('[data-testid="wa-feature-group-documents"]')!;
    expect(docs.textContent).toContain("Each message type");
    expect(docs.querySelector('[data-testid="toggle-documentNotificationsEnabled"]')).not.toBeNull();
    expect(docs.querySelector('[data-testid="toggle-type:salary_slip"]')).not.toBeNull();
    expect(docs.querySelector('[data-testid="toggle-type:id_card"]')).not.toBeNull();
    expect(el('[data-testid="wa-feature-group-otp"]')!.textContent).toContain("OTP & Login");
    expect(checked('[data-testid="toggle-type:visitor_contact"]')).toBe("false");
  });

  it("switches one message type on its own", async () => {
    const { server } = await open();
    await page!.click('[data-testid="toggle-type:salary_slip"]');
    expect(server.puts).toEqual([{ "type:salary_slip": false }]);
    expect(checked('[data-testid="toggle-type:salary_slip"]')).toBe("false");
    expect(checked('[data-testid="toggle-type:id_card"]')).toBe("true");
  });
});

describe("sending limits", () => {
  it("shows the four limits with their range and unit, and quiet hours", async () => {
    await open();
    const card = el('[data-testid="wa-sending-limits"]')!;
    expect(card.textContent).toContain("keep the company's WhatsApp number from being restricted");
    expect((el('[data-testid="wa-limit-minGapSeconds"]') as HTMLInputElement).value).toBe("30");
    expect((el('[data-testid="wa-limit-maxPerHour"]') as HTMLInputElement).value).toBe("60");
    expect((el('[data-testid="wa-limit-maxPerDay"]') as HTMLInputElement).value).toBe("200");
    expect((el('[data-testid="wa-limit-maxPerEmployeePerDay"]') as HTMLInputElement).value).toBe("3");
    expect(card.textContent).toContain("5–600 seconds");
    expect(checked('[data-testid="wa-quiet-hours-switch"]')).toBe("true");
    expect((el('[data-testid="wa-quiet-start"]') as HTMLInputElement).value).toBe("21:00");
    expect((el('[data-testid="wa-quiet-end"]') as HTMLInputElement).value).toBe("07:00");
    expect(card.textContent).toContain("Runs overnight.");
    expect(el('[data-testid="wa-save-limits"]')!.hasAttribute("disabled")).toBe(true);
  });

  it("explains an out-of-range value inline and saves only what changed", async () => {
    const { server } = await open();
    await page!.type('[data-testid="wa-limit-maxPerHour"]', "9999");
    expect(el('[data-testid="wa-limit-error-maxPerHour"]')!.textContent).toBe("Must be between 1 and 500.");
    expect(el('[data-testid="wa-save-limits"]')!.hasAttribute("disabled")).toBe(true);

    await page!.type('[data-testid="wa-limit-maxPerHour"]', "45");
    expect(el('[data-testid="wa-limit-error-maxPerHour"]')).toBeNull();
    await page!.click('[data-testid="wa-save-limits"]');
    expect(server.puts).toEqual([{ maxPerHour: 45 }]);
    expect((el('[data-testid="wa-limit-maxPerHour"]') as HTMLInputElement).value).toBe("45");
    expect(el('[data-testid="wa-save-limits"]')!.hasAttribute("disabled")).toBe(true);
  });

  it("shows the server's refusal inline and keeps what HR typed", async () => {
    const server = settingsServer();
    server.refuse(400, { error: "Messages per day can't be lower than messages per hour." });
    await open(server);
    await page!.type('[data-testid="wa-limit-maxPerDay"]', "20");
    await page!.click('[data-testid="wa-save-limits"]');
    expect(server.puts).toEqual([{ maxPerDay: 20 }]);
    expect(el('[data-testid="wa-limits-error"]')!.textContent).toContain(
      "Messages per day can't be lower than messages per hour.",
    );
    expect((el('[data-testid="wa-limit-maxPerDay"]') as HTMLInputElement).value).toBe("20");
  });

  it("saves quiet hours as one object", async () => {
    const { server } = await open();
    await page!.click('[data-testid="wa-quiet-hours-switch"]');
    await page!.type('[data-testid="wa-quiet-end"]', "06:30");
    await page!.click('[data-testid="wa-save-limits"]');
    expect(server.puts).toEqual([{ quietHours: { enabled: false, start: "21:00", end: "06:30" } }]);
    expect(checked('[data-testid="wa-quiet-hours-switch"]')).toBe("false");
  });

  it("refuses quiet hours that start and end at the same time", async () => {
    await open();
    await page!.type('[data-testid="wa-quiet-end"]', "21:00");
    expect(el('[data-testid="wa-quiet-hours-error"]')!.textContent).toBe("Start and end can't be the same time.");
    expect(el('[data-testid="wa-save-limits"]')!.hasAttribute("disabled")).toBe(true);
  });
});

describe("a server older than the sending queue", () => {
  it("shows the switches as before, with no engine state to lose and no limits section", async () => {
    const old = settings();
    delete old.engineEnabled;
    delete old.queueLimits;
    delete old.quietHours;
    old.features = old.features.filter((f) => !f.key.startsWith("type:"));
    await open(settingsServer(old));
    expect(el('[data-testid="wa-engine"]')!.dataset.state).toBe("on");
    expect(el('[data-testid="wa-sending-limits"]')).toBeNull();
    expect(groupOrder()).toEqual(["signin", "documents"]);
    expect(page!.text()).toContain("Timing");
  });
});
