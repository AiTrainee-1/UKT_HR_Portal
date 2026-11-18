import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { HodStatusCard, SwitchedOffBanner } from "./OverviewNotices";
import { DEV_TEMPLATES, settings, template } from "./test-fixtures";

// The Overview's notices: a banner when HR's switches keep most messages from going out (on the dev database 24 of 27
// types are off, which is why "nothing works"), the engine OFF above all; and the Department Head notifications at a
// glance (the owner's priority), each with the way to Feature Controls.

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const el = (id: string) => page!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => (el(id)?.textContent ?? "").replace(/\s+/g, " ").trim();

const banner = async (fixtures: Fixtures, canReadTypes = true, onOpenControls?: () => void) => {
  page = await renderMdPage(
    () => <SwitchedOffBanner canReadTypes={canReadTypes} onOpenControls={onOpenControls} />,
    fixtures,
    { path: "/hr/whatsapp-control" },
  );
};

describe("the switched-off banner", () => {
  it("says most messages are switched off, which modules, what can still go, and links to Feature Controls", async () => {
    const open = vi.fn();
    await banner(
      { "/api/whatsapp-control/settings": settings(), "/api/whatsapp-control/templates": DEV_TEMPLATES() },
      true,
      open,
    );
    expect(el("wa-switched-off-banner")!.dataset.level).toBe("most");
    expect(text("wa-switched-off-banner")).toContain("Most WhatsApp messages are switched off: 6 of 9 message types");
    expect(text("wa-switched-off-modules")).toBe(
      "Documents (2) · OTP & Login (1) · Attendance (1) · Approvals (1) · Geo Attendance (1)",
    );
    expect(text("wa-switched-on-types")).toBe("hod request waiting, hod pending reminder, attendance report");
    await page!.click('[data-testid="wa-open-controls"]');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("puts the engine OFF above everything", async () => {
    await banner({
      "/api/whatsapp-control/settings": settings({ engineEnabled: false }),
      "/api/whatsapp-control/templates": DEV_TEMPLATES(),
    });
    expect(el("wa-switched-off-banner")!.dataset.level).toBe("engine-off");
    expect(text("wa-switched-off-banner")).toContain("no WhatsApp message is sent at all");
    // no link when Feature Controls is not open to the role
    expect(el("wa-open-controls")).toBeNull();
  });

  it("is a quiet line when only a few are off, and absent when none is", async () => {
    const few = [
      template("salary_slip", "documents", "Documents", { featureEnabled: false }),
      template("id_card", "documents", "Documents"),
      template("otp_login", "otp", "OTP & Login"),
    ];
    await banner({ "/api/whatsapp-control/settings": settings(), "/api/whatsapp-control/templates": few });
    expect(el("wa-switched-off-banner")!.dataset.level).toBe("some");
    expect(text("wa-switched-off-banner")).toContain("1 of 3 message types are switched off");
    page!.unmount();
    await banner({
      "/api/whatsapp-control/settings": settings(),
      "/api/whatsapp-control/templates": [template("id_card", "documents", "Documents")],
    });
    expect(el("wa-switched-off-banner")).toBeNull();
  });

  it("counts a type switched off on Message Text too", async () => {
    await banner({
      "/api/whatsapp-control/settings": settings(),
      "/api/whatsapp-control/templates": [
        template("id_card", "documents", "Documents", { isEnabled: false }),
        template("otp_login", "otp", "OTP & Login", { isEnabled: false }),
        template("geo_approval", "geo", "Geo Attendance"),
      ],
    });
    expect(el("wa-switched-off-banner")!.dataset.level).toBe("most");
  });

  it("falls back to the switches when the message types are not open to the role (and asks nothing of them)", async () => {
    const off = settings();
    off.features = off.features.map((f) => ({ ...f, enabled: false }));
    await banner({ "/api/whatsapp-control/settings": off }, false);
    expect(page!.requests()).not.toContain("/api/whatsapp-control/templates");
    expect(text("wa-switched-off-banner")).toContain("5 of 5 switches on Feature Controls are OFF");
  });
});

describe("the Department Head notifications card", () => {
  const card = async (s: ReturnType<typeof settings>, onOpenControls?: () => void) => {
    page = await renderMdPage(
      () => <HodStatusCard onOpenControls={onOpenControls} />,
      { "/api/whatsapp-control/settings": s },
      { path: "/hr/whatsapp-control" },
    );
  };

  it("is ON with both messages on, and links to Feature Controls and to the reminder times", async () => {
    const open = vi.fn();
    await card(settings(), open);
    expect(el("wa-hod-status")!.dataset.state).toBe("on");
    expect(text("wa-hod-status")).toContain("Department Head notifications");
    expect(el("wa-hod-item-hodRequestWaitingEnabled")!.dataset.on).toBe("true");
    expect(el("wa-hod-item-type:hod_pending_reminder")!.dataset.on).toBe("true");
    expect(el("wa-hod-held")).toBeNull();
    expect(el("wa-open-notify")!.getAttribute("href")).toBe("/hr/requests?tab=notify");
    await page!.click('[data-testid="wa-open-controls"]');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("is OFF, and says why, when the section switch holds both back", async () => {
    await card(settings({ hodOn: false }));
    expect(el("wa-hod-status")!.dataset.state).toBe("off");
    expect(text("wa-hod-held")).toContain('"Department Head notifications (all)" is OFF');
    expect(text("wa-hod-item-hodRequestWaitingEnabled")).toContain("held back");
  });

  it("is partly on when one message is off", async () => {
    await card(settings({ reminderOn: false }));
    expect(el("wa-hod-status")!.dataset.state).toBe("partly");
    expect(text("wa-hod-item-type:hod_pending_reminder")).toContain("Its own switch is OFF");
  });

  it("is not shown by a server without the section", async () => {
    const old = settings();
    old.features = old.features.filter((f) => f.group !== "hod");
    await card(old);
    expect(el("wa-hod-status")).toBeNull();
  });
});
