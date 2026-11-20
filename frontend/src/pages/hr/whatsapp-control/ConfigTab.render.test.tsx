import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppControl from "../WhatsAppControl";
import { ADMIN, connectionFixture, hrWith, pageFixtures, settingsServer } from "./test-fixtures";

// Settings: the Meta set-up check (each environment variable set or missing, by name only, never a value; the number at
// Meta; whether Meta took the token), the webhook URL to paste into Meta with the verify token and app secret set or not
// and when Meta last called, the development lock, and the prices per pricing category and the monthly budget.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (
  opts: { server?: ReturnType<typeof settingsServer>; me?: Record<string, unknown>; extra?: Fixtures } = {},
) => {
  const server = opts.server ?? settingsServer();
  page = await renderMdPage(
    WhatsAppControl,
    { ...pageFixtures(server), "/api/auth/me": opts.me ?? ADMIN, ...opts.extra },
    { path: "/hr/whatsapp-control?tab=config" },
  );
  return { page, server };
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);

describe("the Meta set-up check", () => {
  it("lists every environment variable as set or missing, by name only", async () => {
    await open();
    const env = el('[data-testid="wa-env"]')!;
    expect(el('[data-testid="wa-env-WHATSAPP_CLOUD_ACCESS_TOKEN"]')!.textContent).toContain("Set");
    expect(el('[data-testid="wa-env-WHATSAPP_CLOUD_ACCESS_TOKEN"]')!.textContent).toContain("secret");
    expect(el('[data-testid="wa-env-WHATSAPP_CLOUD_APP_SECRET"]')!.textContent).toContain("Missing");
    // an optional variable left unset is not an error: the server uses its default
    const base = el('[data-testid="wa-env-WHATSAPP_CLOUD_API_BASE"]')!.textContent;
    expect(base).toContain("Optional");
    expect(base).not.toContain("Missing");
    expect(env.querySelectorAll("li")).toHaveLength(7);
    expect(page!.text()).not.toMatch(/wa ?client/i);
  });

  it("shows Meta's answer about the number (snake_case read as well) and the token", async () => {
    await open();
    const phone = el('[data-testid="wa-connection-phone"]')!.textContent!;
    expect(phone).toContain("+91 98765 43210");
    expect(phone).toContain("UK Textiles");
    expect(phone).toContain("High");
    expect(phone).toContain("2,000 people / 24 h");
    expect(phone).toContain("Connected");
    expect(phone).toContain("standard");
    const verdict = el('[data-testid="wa-connection-verdict"]')!.textContent!;
    expect(verdict).toContain("Token accepted by Meta");
    expect(verdict).toContain("Graph API v23.0");
    expect(el('[data-testid="wa-connection-devlock"]')!.textContent).toContain("employee 30020");
  });

  it("checks again on demand, and shows Meta's error and why nothing is sent", async () => {
    let calls = 0;
    const bad = {
      ...connectionFixture(),
      tokenOk: false,
      error: "190: the access token has expired",
      sendingAllowed: false,
    };
    bad.blockReasons = ["WhatsApp sending is off on this development machine."] as never;
    await open({
      extra: {
        "/api/whatsapp-control/connection": () => {
          calls += 1;
          return bad;
        },
      },
    });
    expect(el('[data-testid="wa-connection-meta-error"]')!.textContent).toContain("expired");
    expect(el('[data-testid="wa-connection-block"]')!.textContent).toContain("development machine");
    expect(el('[data-testid="wa-connection-verdict"]')!.textContent).toContain("Token refused by Meta");
    await page!.click('[data-testid="wa-connection-recheck"]');
    expect(calls).toBe(2);
  });
});

describe("the webhook", () => {
  it("gives the URL to paste into Meta and says what is set and when Meta last called", async () => {
    await open();
    expect(el('[data-testid="wa-webhook-url"]')!.textContent).toContain(
      "https://hrms.example.test/api/whatsapp/webhook/",
    );
    const hook = el('[data-testid="wa-webhook"]')!.textContent!;
    expect(hook).toContain("Verify tokenSet");
    expect(hook).toContain("App secret (signature check)Missing");
    expect(el('[data-testid="wa-webhook-last"]')!.textContent).toContain("Never");
    expect(hook).toContain("message_template_status_update");
  });
});

describe("prices and the monthly budget", () => {
  it("shows the saved rates (a Decimal sent as text too) with GST, and saves only what changed", async () => {
    const { server } = await open();
    expect((el('[data-testid="wa-rate-authentication"]') as HTMLInputElement).value).toBe("0.115");
    expect((el('[data-testid="wa-budget"]') as HTMLInputElement).value).toBe("500");
    expect(el('[data-testid="wa-prices-save"]')!.hasAttribute("disabled")).toBe(true);
    await page!.type('[data-testid="wa-rate-utility"]', "0.12");
    await page!.type('[data-testid="wa-budget"]', "750");
    await page!.click('[data-testid="wa-prices-save"]');
    expect(server.patches).toEqual([
      { priceRates: { authentication: 0.115, utility: 0.12, marketing: 0.8631, service: 0 }, monthlyBudget: 750 },
    ]);
  });

  it("clears the budget with an empty field, and refuses a bad price", async () => {
    const { server } = await open();
    await page!.type('[data-testid="wa-rate-marketing"]', "abc");
    expect(el('[data-testid="wa-rate-error-marketing"]')!.textContent).toContain("Numbers only");
    expect(el('[data-testid="wa-prices-save"]')!.hasAttribute("disabled")).toBe(true);
    await page!.type('[data-testid="wa-rate-marketing"]', "0.8631");
    await page!.type('[data-testid="wa-budget"]', "");
    await page!.click('[data-testid="wa-prices-save"]');
    expect(server.patches).toEqual([{ monthlyBudget: null }]);
  });

  it("shows the server's refusal", async () => {
    const server = settingsServer();
    server.refuse(400, { error: "priceRates.utility must be between 0 and 100" });
    await open({ server });
    await page!.type('[data-testid="wa-rate-utility"]', "0.2");
    await page!.click('[data-testid="wa-prices-save"]');
    expect(el('[data-testid="wa-prices-error"]')!.textContent).toContain("between 0 and 100");
  });

  it("locks the prices on a View-only tab", async () => {
    await open({ me: hrWith({ whatsapp_control: "edit", "whatsapp_control.config": "view" }) });
    expect((el('[data-testid="wa-rate-utility"]') as HTMLInputElement).disabled).toBe(true);
    expect((el('[data-testid="wa-budget"]') as HTMLInputElement).disabled).toBe(true);
  });
});
