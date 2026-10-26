import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import ConfigTab from "./ConfigTab";

// The Setup tab of WhatsApp Control. No WhatsApp message carries a link to the Employee Web App any more, so this tab
// must not ask for a portal address (the EMPLOYEE_PORTAL_URL setting is gone) or report link previews (the preview card is
// gone). These checks keep it that way, including against a server that is still on the older release and sends both.

const CONFIG = {
  provider: "WAClient (WhatsApp Web API)",
  configured: true,
  instanceId: "…1234",
  apiUrl: "https://api.waclient.test/send",
  defaultCountryCode: "91",
  sendDelaySeconds: 2,
  publicBaseUrl: "https://api.example.test",
  webhookUrl: "https://api.example.test/api/whatsapp/webhook/",
  webhookTokenSet: false,
  backgroundSending: true,
};

const settings = (config: Record<string, unknown>) => ({
  groups: [],
  features: [],
  timings: [],
  config,
  updatedAt: null,
});

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (config: Record<string, unknown>) => {
  page = await renderMdPage(
    () => <ConfigTab />,
    { "/api/whatsapp-control/settings": settings(config) },
    { path: "/hr/whatsapp-control" },
  );
  return page;
};

describe("WhatsApp Control setup tab", () => {
  it("shows the connection and the webhook, and nothing about a portal address or link previews", async () => {
    await open(CONFIG);
    const text = page!.text();
    expect(text).toContain("Setup checklist");
    expect(text).toContain("WAClient credentials are set on the server");
    expect(text).toContain("Documents can be downloaded by WAClient");
    expect(text).toContain("Webhook is protected with a token");
    expect(page!.container.querySelector('[data-testid="webhook-url"]')!.textContent).toBe(CONFIG.webhookUrl);
    for (const gone of ["Employee Web App", "EMPLOYEE_PORTAL_URL", "View request", "Link previews", "link preview"]) {
      expect(text).not.toContain(gone);
    }
    expect(text).toContain("Delivery");
  });

  it("ignores a portal address and a link-preview flag sent by a server still on the older release", async () => {
    await open({ ...CONFIG, employeePortalUrl: "https://employee.example.test", linkPreview: true });
    const text = page!.text();
    expect(text).not.toContain("employee.example.test");
    expect(text).not.toContain("Link previews");
    expect(text).not.toContain("Employee Web App");
  });

  it("lists exactly three setup checks: credentials, documents and the webhook token", async () => {
    await open(CONFIG);
    expect(page!.container.querySelectorAll("ul > li")).toHaveLength(3);
  });
});
