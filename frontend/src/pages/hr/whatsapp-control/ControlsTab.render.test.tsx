import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppControl from "../WhatsAppControl";
import { ADMIN, hrWith, pageFixtures, settingsServer } from "./test-fixtures";

// Message Controls: the engine master switch (confirmed both ways), every module with its section switch, and every
// message type with its own switch, its Meta template and status, this month's count, the first reason it does not go
// out, and "Create template" when it has none; then the sending limits, the alert timings and today's queue. Every
// change is a PATCH of only what changed.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (
  opts: { me?: Record<string, unknown>; server?: ReturnType<typeof settingsServer>; extra?: Fixtures } = {},
) => {
  const server = opts.server ?? settingsServer();
  page = await renderMdPage(
    WhatsAppControl,
    {
      ...pageFixtures(server),
      "/api/auth/me": opts.me ?? ADMIN,
      "/api/whatsapp-control/meta-templates/draft/id_card": {
        name: "hrms_id_card",
        language: "en",
        category: "UTILITY",
        header: "image",
        body: "Dear {{employee_name}},\nYour ID card is attached.\n\n- UK Textiles HR",
        footer: "UK Textiles HR",
        examples: { employee_name: "Asha Kumar" },
        warnings: [],
      },
      ...opts.extra,
    },
    { path: "/hr/whatsapp-control?tab=controls" },
  );
  return { page, server };
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const checked = (selector: string) => el(selector)?.getAttribute("aria-checked");
const button = (text: string) =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text)!;

describe("the WhatsApp engine", () => {
  it("asks before turning OFF, warns that sign-in codes stop too, then PATCHes only the engine", async () => {
    const { server } = await open();
    expect(el('[data-testid="wa-engine"]')!.dataset.state).toBe("on");
    await page!.click('[data-testid="wa-engine-switch"]');
    expect(server.patches).toEqual([]);
    const dialog = el('[data-testid="wa-engine-confirm"]')!;
    expect(dialog.textContent).toContain("Turn the WhatsApp engine OFF?");
    expect(dialog.textContent).toContain("One-time sign-in codes will not go by WhatsApp either");
    expect(dialog.textContent).toContain("SMS code");
    await page!.click('[data-testid="wa-engine-confirm-confirm"]');
    expect(server.patches).toEqual([{ engineEnabled: false }]);
    expect(server.methods).toEqual(["PATCH"]);
    expect(el('[data-testid="wa-engine"]')!.dataset.state).toBe("off");
    expect(el('[data-testid="wa-engine-off-note"]')).not.toBeNull();
    // every type now says why
    expect(el('[data-testid="wa-type-off-salary_slip"]')!.textContent).toBe("The WhatsApp engine is OFF.");
  });

  it("falls back to PUT on a server that does not take PATCH yet", async () => {
    const server = settingsServer();
    const put: unknown[] = [];
    await open({
      server,
      extra: {
        "/api/whatsapp-control/settings": (params, init) => {
          if (init?.method === "PATCH") return { status: 405, body: { detail: 'Method "PATCH" not allowed.' } };
          if (init?.method === "PUT") put.push(JSON.parse(String(init.body)));
          return server.fixture(params, init?.method === "PUT" ? { ...init, method: "PATCH" } : init);
        },
      },
    });
    await page!.click('[data-testid="toggle-type:id_card"]');
    expect(put).toEqual([{ "type:id_card": false }]);
    expect(checked('[data-testid="toggle-type:id_card"]')).toBe("false");
  });
});

describe("every message type", () => {
  it("shows its template and status, this month's count, and why it is not sent", async () => {
    await open();
    const row = (type: string) => el(`[data-testid="wa-type-${type}"]`)!;
    expect(row("salary_slip").textContent).toContain("hrms_salary_slip");
    expect(el('[data-testid="wa-type-template-salary_slip"]')!.textContent).toBe("Approved");
    expect(el('[data-testid="wa-type-count-salary_slip"]')!.textContent).toBe("24 this month");
    expect(row("salary_slip").dataset.off).toBeUndefined();
    expect(el('[data-testid="wa-type-template-id_card"]')!.textContent).toBe("No template");
    expect(el('[data-testid="wa-type-off-id_card"]')!.textContent).toBe("Skipped: no approved Meta template.");
    expect(el('[data-testid="wa-type-off-late_alert"]')!.textContent).toBe("Its section switch is OFF.");
    expect(row("visitor_contact").textContent).toContain("Not via Meta");
    // never sent through Meta: says so, its switch can't be flipped, and it is not counted
    expect(el('[data-testid="wa-type-off-visitor_contact"]')!.textContent).toContain("Not sent");
    expect(el('[data-testid="toggle-type:visitor_contact"]')!.hasAttribute("disabled")).toBe(true);
    expect(el('[data-testid="wa-section-count-visitors"]')!.textContent).toBe("0 of 1 going out");
    expect(el('[data-testid="wa-type-template-visitor_notification"]')!.textContent).toBe("In review");
    // the three code types share hrms_otp
    expect(row("otp_reset").textContent).toContain("hrms_otp");
    expect(el('[data-testid="wa-controls-summary"]')!.textContent).toContain("3 of 9 message types go out");
    expect(el('[data-testid="wa-controls-summary"]')!.textContent).toContain("3 wait for a template");
  });

  it("switches one type off with a PATCH of that switch alone", async () => {
    const { server } = await open();
    expect(checked('[data-testid="toggle-type:salary_slip"]')).toBe("true");
    await page!.click('[data-testid="toggle-type:salary_slip"]');
    expect(server.patches).toEqual([{ "type:salary_slip": false }]);
    expect(checked('[data-testid="toggle-type:salary_slip"]')).toBe("false");
    expect(el('[data-testid="wa-type-off-salary_slip"]')!.textContent).toBe("Switched OFF.");
  });

  it("holds a section whose master is OFF, and turns it back on from its header", async () => {
    const { server } = await open();
    expect(el('[data-testid="wa-feature-group-attendance"]')!.dataset.held).toBe("true");
    expect(el('[data-testid="wa-section-held-attendance"]')!.textContent).toContain("Attendance alerts (all)");
    expect(el('[data-testid="wa-section-state-attendance"]')!.textContent).toBe("Section OFF");
    await page!.click('[data-testid="toggle-attendanceAlertsEnabled"]');
    expect(server.patches).toEqual([{ attendanceAlertsEnabled: true }]);
    expect(el('[data-testid="wa-section-held-attendance"]')).toBeNull();
  });

  it("names the shared switch that holds a type back", async () => {
    const server = settingsServer();
    server.state.groups = [
      ...(server.state.groups as unknown[]),
      { key: "geo", title: "Geo Attendance", blurb: "On-Duty approvals." },
    ];
    server.state.features.push(
      { key: "geoApprovalEnabled", group: "geo", label: "Geo Attendance approval & rejection", enabled: false },
      { key: "type:geo_approval", group: "geo", label: "Geo Approval", enabled: true },
    );
    await open({ server });
    expect(el('[data-testid="wa-type-geo_approval"]')!.dataset.off).toBe("shared");
    expect(el('[data-testid="wa-type-off-geo_approval"]')!.textContent).toBe(
      "Held: “Geo Attendance approval & rejection” is OFF.",
    );
    await page!.click('[data-testid="toggle-geoApprovalEnabled"]');
    expect(server.patches).toEqual([{ geoApprovalEnabled: true }]);
    expect(el('[data-testid="wa-type-off-geo_approval"]')!.textContent).toBe("Skipped: no approved Meta template.");
  });

  it("leaves password sign-in to the OTP tab and points there", async () => {
    await open();
    expect(el('[data-testid="toggle-passwordLoginEnabled"]')).toBeNull();
    expect(el('[data-testid="wa-feature-group-signin"]')!.textContent).toContain("OTP tab");
  });

  it("opens the template editor with the type's draft from the server", async () => {
    await open();
    await page!.click('[data-testid="wa-type-create-id_card"]');
    expect(page!.requests()).toContain("/api/whatsapp-control/meta-templates/draft/id_card");
    const dialog = el('[data-testid="wa-template-dialog"]')!;
    expect(dialog.textContent).toContain("Create the template for ID Card");
    expect((el('[data-testid="wa-tpl-name"]') as HTMLInputElement).value).toBe("hrms_id_card");
    expect(el('[data-testid="wa-tpl-preview-body"]')!.textContent).toContain("Dear Asha Kumar");
  });
});

describe("who may do what", () => {
  it("asks nothing about templates or usage when those tabs are hidden, and offers no Create", async () => {
    await open({
      me: hrWith({
        whatsapp_control: "edit",
        "whatsapp_control.templates": "hidden",
        "whatsapp_control.usage": "hidden",
        "whatsapp_control.overview": "hidden",
      }),
    });
    expect(
      page!.requests().some((r) => r.includes("meta-templates") || r.includes("/usage") || r.includes("/queue")),
    ).toBe(false);
    expect(el('[data-testid="wa-type-template-salary_slip"]')).toBeNull();
    expect(el('[data-testid="wa-type-create-id_card"]')).toBeNull();
    expect(el('[data-testid="wa-type-count-salary_slip"]')!.textContent).toBe("");
    expect(el('[data-testid="wa-queue-card"]')).toBeNull();
  });

  it("disables every switch on a View-only tab", async () => {
    await open({ me: hrWith({ whatsapp_control: "edit", "whatsapp_control.controls": "view" }) });
    const switches = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-testid="wa-controls"] [role="switch"]'),
    );
    expect(switches.length).toBeGreaterThan(10);
    expect(switches.every((s) => s.disabled)).toBe(true);
    // "Clear queue" is the Overview tab's (the server files whatsapp-control/queue/clear under it)
    expect(el('[data-testid="wa-clear-queue"]')!.hasAttribute("disabled")).toBe(false);
  });

  it("locks Clear queue by the Overview tab's level, as the server does, not by Message Controls'", async () => {
    await open({ me: hrWith({ whatsapp_control: "edit", "whatsapp_control.overview": "view" }) });
    expect(el('[data-testid="toggle-type:salary_slip"]')!.hasAttribute("disabled")).toBe(false);
    expect(el('[data-testid="wa-clear-queue"]')!.hasAttribute("disabled")).toBe(true);
  });
});

describe("limits, timings and the queue", () => {
  it("saves a changed sending limit alone", async () => {
    const { server } = await open();
    await page!.type('[data-testid="wa-limit-maxPerHour"]', "90");
    await page!.click('[data-testid="wa-save-limits"]');
    expect(server.patches).toEqual([{ maxPerHour: 90 }]);
  });

  it("keeps the code expiry out of the alert timings (it is on the OTP tab)", async () => {
    await open();
    const timings = el('[data-testid="wa-timings"]')!;
    expect(timings.textContent).toContain("Extra wait before an Absent alert");
    expect(timings.textContent).not.toContain("OTP expiry");
    expect(el('[data-testid="wa-queue-card"]')).not.toBeNull();
    expect(button("Save timings").disabled).toBe(true);
  });
});
