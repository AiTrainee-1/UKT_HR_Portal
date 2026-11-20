import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppTab from "../WhatsAppTab";
import { WHATSAPP_SETTINGS } from "../WhatsAppTab.meta";
import { whatsAppRuns } from "./WhatsAppBubble";

// The WhatsApp tab edits nothing: everything WhatsApp (on the Meta WhatsApp Cloud API since 2026-11-20) is set on
// WhatsApp Control or in the server's environment. It explains where each part lives and links to the right tab of
// WhatsApp Control; these checks keep it that way, and keep the old provider's name off it.

const HR = { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} };

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (me: Record<string, unknown> = HR) => {
  page = await renderMdPage(() => <WhatsAppTab />, { "/api/auth/me": me }, { path: "/hr/settings?tab=whatsapp" });
  return page;
};

describe("WhatsApp tab", () => {
  it("has no editor of its own and asks the server for nothing but who is signed in", async () => {
    await open();
    expect(page!.container.querySelectorAll("textarea, input, [role=switch]")).toHaveLength(0);
    expect(page!.requests().filter((r) => !r.startsWith("/api/auth/me"))).toEqual([]);
    // The old tab's message rows and their buttons are gone.
    expect(page!.text()).not.toContain("Save Message");
    expect(page!.text()).not.toContain("Use default");
  });

  it("links every part to its tab of WhatsApp Control, and never names the old provider", async () => {
    await open();
    const links = [...page!.container.querySelectorAll<HTMLAnchorElement>('[data-testid^="whatsapp-managed-"] a')];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/hr/whatsapp-control?tab=config",
      "/hr/whatsapp-control?tab=templates",
      "/hr/whatsapp-control?tab=controls",
      "/hr/whatsapp-control?tab=usage",
    ]);
    expect(page!.text()).toContain("Meta WhatsApp Cloud API");
    expect(page!.text()).toContain("WHATSAPP_CLOUD_*");
    expect(page!.text()).toContain("Open the Templates tab.");
    expect(page!.text()).not.toMatch(/wa ?client|instance id/i);
  });

  it("tells a role that cannot open WhatsApp Control to ask an administrator", async () => {
    await open({ ...HR, isSuperAdmin: false, permissions: { settings: "view", whatsapp_control: "hidden" } });
    expect(page!.text()).toContain("Your role cannot open WhatsApp Control");
  });

  it("draws every entry the search knows about, under the same title", async () => {
    await open();
    for (const meta of WHATSAPP_SETTINGS) {
      const block = page!.container.querySelector(`[data-setting-id="${meta.id}"]`);
      expect(block, meta.id).not.toBeNull();
      expect(block!.querySelector("h4")!.textContent).toBe(meta.title);
      expect(block!.querySelector('[data-testid="setting-purpose"]')!.textContent).toBe(meta.purpose);
    }
  });
});

describe("whatsAppRuns", () => {
  it("reads *bold* and _italic_ the way WhatsApp shows them", () => {
    expect(whatsAppRuns("Your slip for *August 2026* is _attached_.")).toEqual([
      { text: "Your slip for ", style: "plain" },
      { text: "August 2026", style: "bold" },
      { text: " is ", style: "plain" },
      { text: "attached", style: "italic" },
      { text: ".", style: "plain" },
    ]);
    expect(whatsAppRuns("**")).toEqual([{ text: "**", style: "plain" }]);
    expect(whatsAppRuns("line one\n*two*")).toEqual([
      { text: "line one\n", style: "plain" },
      { text: "two", style: "bold" },
    ]);
  });
});
