import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppControl from "../WhatsAppControl";
import { ADMIN, hrWith, overviewFixture, pageFixtures } from "./test-fixtures";

// The page as a whole: the nine tabs in the permission tree's order, ?tab= picking one, a hidden tab never asking the
// server for anything, and the Overview: the hero (the number's health, the month's spend against the budget and where it
// is heading), the month in four numbers, what needs attention linked to the tab that fixes it. The old provider is named nowhere.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (path = "/hr/whatsapp-control", me: Record<string, unknown> = ADMIN, extra: Fixtures = {}) => {
  page = await renderMdPage(WhatsAppControl, { ...pageFixtures(), "/api/auth/me": me, ...extra }, { path });
  return page;
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const tabLabels = () =>
  Array.from(page!.container.querySelectorAll<HTMLElement>('[data-testid="wa-tabs"] [role="tab"] .ptab-label')).map(
    (t) => t.textContent,
  );
const apiCalls = () => page!.requests().filter((r) => r.startsWith("/api/whatsapp"));

describe("the page and its tabs", () => {
  it("offers the nine tabs in order and opens the Overview, asking only for the overview", async () => {
    await open();
    expect(tabLabels()).toEqual([
      "Overview",
      "Usage & Cost",
      "Message Controls",
      "Templates",
      "OTP",
      "Messages",
      "Employees",
      "Send a test",
      "Settings",
    ]);
    expect(el('[data-testid="wa-panel-overview"]')).not.toBeNull();
    expect(apiCalls()).toEqual(["/api/whatsapp-control/overview"]);
    expect(page!.text()).toContain("official Meta WhatsApp Cloud API");
  });

  it("opens the tab the address names", async () => {
    await open("/hr/whatsapp-control?tab=usage");
    expect(el('[data-testid="wa-panel-usage"]')).not.toBeNull();
    expect(apiCalls().every((r) => r.startsWith("/api/whatsapp-control/usage"))).toBe(true);
  });

  it("offers only the tabs a role may see, and lands a hidden tab's address on the first open one", async () => {
    await open(
      "/hr/whatsapp-control?tab=templates",
      hrWith({ whatsapp_control: "edit", "whatsapp_control.templates": "hidden", "whatsapp_control.usage": "hidden" }),
    );
    expect(tabLabels()).not.toContain("Templates");
    expect(tabLabels()).not.toContain("Usage & Cost");
    expect(el('[data-testid="wa-panel-overview"]')).not.toBeNull();
    expect(apiCalls()).toEqual(["/api/whatsapp-control/overview"]);
    // the hero's link into Usage & Cost is not offered
    expect(el('[data-testid="wa-hero-usage-link"]')).toBeNull();
  });

  it("says so when nothing is open to the role", async () => {
    await open("/hr/whatsapp-control", hrWith({ whatsapp_control: "hidden" }));
    expect(el('[data-testid="whatsapp-control-nothing-open"]')).not.toBeNull();
  });

  it("never names the old provider, a QR code or an instance", async () => {
    for (const tab of ["", "?tab=controls", "?tab=config", "?tab=otp", "?tab=templates"]) {
      await open(`/hr/whatsapp-control${tab}`);
      expect(page!.text()).not.toMatch(/wa ?client|QR code|instance/i);
      page!.unmount();
      page = undefined;
    }
  });
});

describe("the Overview", () => {
  it("shows the number, its verified name, quality, messaging limit, status and the webhook in the hero", async () => {
    await open();
    expect(el('[data-testid="wa-hero-number"]')!.textContent).toBe("+91 98765 43210");
    expect(el('[data-testid="wa-hero"]')!.textContent).toContain("UK Textiles");
    expect(el('[data-testid="wa-hero-verdict"]')!.textContent).toBe("Live");
    expect(el('[data-testid="wa-hero-quality"]')!.textContent).toContain("High");
    expect(el('[data-testid="wa-hero-tier"]')!.textContent).toContain("2,000 people / 24 h");
    expect(el('[data-testid="wa-hero-status"]')!.textContent).toContain("Connected");
    expect(el('[data-testid="wa-hero-webhook"]')!.textContent).toContain("4 min ago");
  });

  it("shows the month's spend with GST, the budget meter with the projection's mark, and warns of going over", async () => {
    await open();
    expect(el('[data-testid="wa-hero-spent"]')!.textContent).toBe("₹46.20");
    expect(el('[data-testid="wa-hero-cost"]')!.textContent).toContain("₹54.52 with 18% GST");
    expect(el('[data-testid="wa-hero-projected"]')!.textContent).toBe("₹71.61");
    const meter = el('[data-testid="wa-hero-budget-meter"]')!;
    expect(meter.getAttribute("aria-valuenow")).toBe("77");
    expect(meter.dataset.tone).toBe("warn");
    expect(el('[data-testid="wa-hero-over-budget"]')).not.toBeNull();
  });

  it("shows the month's four numbers and links the failures to Messages", async () => {
    await open();
    expect(el('[data-testid="wa-kpi-sent"]')!.textContent).toContain("420");
    expect(el('[data-testid="wa-kpi-delivered"]')!.textContent).toContain("93%");
    expect(el('[data-testid="wa-kpi-read"]')!.textContent).toContain("21.4%");
    expect(el('[data-testid="wa-kpi-failed"]')!.textContent).toContain("6");
    await page!.click('[data-testid="wa-kpi-failed-link"]');
    expect(el('[data-testid="wa-panel-messages"]')).not.toBeNull();
    expect(
      page!.requests().some((r) => r.startsWith("/api/whatsapp-control/messages") && r.includes("status=failed")),
    ).toBe(true);
  });

  it("lists the alerts worst first, each with a way to the tab that fixes it", async () => {
    await open();
    const alerts = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="wa-alert-"]')).filter(
      (a) => !a.dataset.testid!.startsWith("wa-alert-go-"),
    );
    expect(alerts.map((a) => a.dataset.tone)).toEqual(["bad", "warn", "info"]);
    await page!.click('[data-testid="wa-alert-go-template_rejected"]');
    expect(el('[data-testid="wa-panel-templates"]')).not.toBeNull();
  });

  it("summarises templates, the missing ones, sign-in codes and today's queue", async () => {
    await open();
    expect(el('[data-testid="wa-templates-approved"]')!.textContent).toContain("12");
    expect(el('[data-testid="wa-templates-missing"]')!.textContent).toContain("Late Attendance Alert");
    expect(el('[data-testid="wa-otp-summary-state"]')!.textContent).toBe("working");
    expect(el('[data-testid="wa-today"]')!.textContent).toContain("40");
  });

  it("says plainly when WhatsApp is not set up, with a way to Settings", async () => {
    const o = overviewFixture();
    o.connection = {
      ...o.connection,
      configured: false,
      sendingAllowed: false,
      displayNumber: null as unknown as string,
      qualityRating: null as unknown as string,
    };
    o.cost.budget = null as unknown as number;
    await open("/hr/whatsapp-control", ADMIN, { "/api/whatsapp-control/overview": o });
    expect(el('[data-testid="wa-hero-verdict"]')!.textContent).toBe("Not set up");
    expect(el('[data-testid="wa-hero-number"]')!.textContent).toBe("Not connected");
    expect(el('[data-testid="wa-hero-not-configured"]')).not.toBeNull();
    expect(el('[data-testid="wa-hero-no-budget"]')).not.toBeNull();
    const button = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Open Settings")!;
    await page!.click('[data-testid="wa-hero-not-configured"] button');
    expect(button).toBeTruthy();
    expect(el('[data-testid="wa-panel-config"]')).not.toBeNull();
  });

  it("shows an error, not a blank page, when the overview can't be read", async () => {
    await open("/hr/whatsapp-control", ADMIN, {
      "/api/whatsapp-control/overview": { status: 500, body: { error: "Database is busy" } },
    });
    expect(el('[data-testid="wa-overview-error"]')!.textContent).toContain("Database is busy");
  });
});
