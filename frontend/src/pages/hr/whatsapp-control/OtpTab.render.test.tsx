import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppControl from "../WhatsAppControl";
import { ADMIN, metaTemplatesFixture, overviewFixture, pageFixtures, settingsServer } from "./test-fixtures";

// OTP: WhatsApp's codes on their own. The WhatsApp OTP master (turning it OFF is confirmed and says SMS still works),
// sign-in / password reset / activation, the code's expiry, the hrms_otp template's status with Create when it has
// none, this month's WhatsApp codes, and password sign-in; a plain line that SMS codes live on SMS Control and work
// independently. No SMS data is asked for.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (server = settingsServer(), extra: Fixtures = {}) => {
  page = await renderMdPage(
    WhatsAppControl,
    { ...pageFixtures(server), "/api/auth/me": ADMIN, ...extra },
    { path: "/hr/whatsapp-control?tab=otp" },
  );
  return { page, server };
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const checked = (selector: string) => el(selector)?.getAttribute("aria-checked");

describe("the OTP tab", () => {
  it("shows WhatsApp OTP working, the three uses, the code template and this month's codes, and asks nothing about SMS", async () => {
    await open();
    expect(el('[data-testid="wa-otp-master"]')!.dataset.state).toBe("on");
    expect(el('[data-testid="wa-otp-verdict"]')!.textContent).toBe("Working");
    expect(checked('[data-testid="toggle-otpLoginEnabled"]')).toBe("true");
    expect(checked('[data-testid="toggle-otpActivateEnabled"]')).toBe("false");
    expect(el('[data-testid="wa-otp-template-name"]')!.textContent).toBe("hrms_otp");
    expect(el('[data-testid="wa-otp-template-status"]')!.textContent).toBe("Approved");
    expect(el('[data-testid="wa-otp-create-template"]')).toBeNull();
    expect(el('[data-testid="wa-otp-sent"]')!.textContent).toContain("120");
    expect(el('[data-testid="wa-otp-delivered"]')!.textContent).toContain("117");
    expect(el('[data-testid="wa-otp-verified"]')!.textContent).toContain("96");
    expect(el('[data-testid="wa-otp-preview-button"]')!.textContent).toBe("Copy code");
    expect(el('[data-testid="wa-otp-preview"]')!.textContent).toContain("This code expires in 5 minutes.");
    expect(page!.requests().some((r) => r.includes("/api/sms"))).toBe(false);
  });

  it("says SMS codes are set on SMS Control and work on their own, with a link there", async () => {
    await open();
    const note = el('[data-testid="wa-otp-sms-note"]')!;
    expect(note.textContent).toContain("either WhatsApp or SMS is enough");
    expect(note.querySelector("a")!.getAttribute("href")).toBe("/hr/sms-control/overview");
  });

  it("asks before turning WhatsApp OTP off, then PATCHes otpEnabled alone", async () => {
    const { server } = await open();
    await page!.click('[data-testid="wa-otp-master-switch"]');
    expect(server.patches).toEqual([]);
    expect(el('[data-testid="wa-otp-off-confirm"]')!.textContent).toContain("SMS where SMS codes are switched on");
    await page!.click('[data-testid="wa-otp-off-confirm-confirm"]');
    expect(server.patches).toEqual([{ otpEnabled: false }]);
    expect(el('[data-testid="wa-otp-master"]')!.dataset.state).toBe("off");
    expect(el('[data-testid="wa-otp-verdict"]')!.textContent).toBe("OFF");
    // back ON needs no confirmation
    await page!.click('[data-testid="wa-otp-master-switch"]');
    expect(server.patches).toEqual([{ otpEnabled: false }, { otpEnabled: true }]);
  });

  it("switches one use, saves the expiry, and shows password sign-in as always on", async () => {
    const { server } = await open();
    await page!.click('[data-testid="toggle-otpActivateEnabled"]');
    await page!.type('[data-testid="wa-otp-expiry-input"]', "10");
    await page!.click('[data-testid="wa-otp-expiry-save"]');
    // 2026-11-24: password sign-in is always on; its switch is shown on and cannot be turned off
    expect(el('[data-testid="toggle-passwordLoginEnabled"]')!.hasAttribute("disabled")).toBe(true);
    expect(server.patches).toEqual([{ otpActivateEnabled: true }, { otpExpiryMinutes: 10 }]);
    expect(el('[data-testid="wa-otp-password"]')!.textContent).toContain("always ON");
  });

  it("refuses an expiry outside the server's range", async () => {
    await open();
    await page!.type('[data-testid="wa-otp-expiry-input"]', "45");
    expect(el('[data-testid="wa-otp-expiry-save"]')!.hasAttribute("disabled")).toBe(true);
  });

  it("explains why codes are not available when the template is missing, and offers to create it", async () => {
    const templates = metaTemplatesFixture();
    templates.templates = templates.templates.filter((t) => t.name !== "hrms_otp");
    const overview = overviewFixture();
    overview.otp = {
      enabled: true,
      available: false,
      templateStatus: null as unknown as string,
      month: overview.otp.month,
    };
    await open(settingsServer(), {
      "/api/whatsapp-control/meta-templates": templates,
      "/api/whatsapp-control/overview": overview,
      "/api/whatsapp-control/meta-templates/draft/otp_login": {
        name: "hrms_otp",
        language: "en",
        category: "AUTHENTICATION",
        body: "",
        footer: "",
        examples: {},
        codeExpirationMinutes: 5,
        warnings: [],
      },
    });
    expect(el('[data-testid="wa-otp-verdict"]')!.textContent).toBe("ON, not available");
    expect(el('[data-testid="wa-otp-master"]')!.textContent).toContain("hrms_otp is not approved by Meta yet");
    expect(el('[data-testid="wa-otp-template-status"]')!.textContent).toBe("No template");
    await page!.click('[data-testid="wa-otp-create-template"]');
    expect(page!.requests()).toContain("/api/whatsapp-control/meta-templates/draft/otp_login");
    expect(el('[data-testid="wa-tpl-auth-note"]')!.textContent).toContain("expires in 5 minutes");
  });

  it("says when WhatsApp codes are on hold and why, and shows the code limits", async () => {
    const overview = overviewFixture() as ReturnType<typeof overviewFixture> & { otp: Record<string, unknown> };
    overview.otp = {
      ...overview.otp,
      paused: true,
      pauseReason: "The hourly limit of 300 WhatsApp codes is used up.",
      limits: {
        perEmployeePerDay: 10,
        perNumberPerHour: 10,
        hourlyCap: 300,
        dailyCap: 1500,
        hourUsed: 300,
        dayUsed: 812,
      },
    };
    await open(settingsServer(), { "/api/whatsapp-control/overview": overview });
    expect(el('[data-testid="wa-otp-verdict"]')!.textContent).toBe("ON, not available");
    expect(el('[data-testid="wa-otp-master"]')!.textContent).toContain("hourly limit of 300 WhatsApp codes is used up");
    expect(el('[data-testid="wa-otp-master"]')!.textContent).toContain("Password sign-in stays open");
    const limits = el('[data-testid="wa-otp-limits"]')!.textContent!;
    expect(limits).toContain("300 of 300 this hour");
    expect(limits).toContain("812 of 1,500 today");
  });
});
