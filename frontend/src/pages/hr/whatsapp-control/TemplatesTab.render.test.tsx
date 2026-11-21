import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppControl from "../WhatsAppControl";
import { ADMIN, metaTemplatesFixture, pageFixtures, settingsServer } from "./test-fixtures";

// Templates: every Meta template with its status, category, quality, the message types it serves and Meta's rejection
// reason; filters; Sync now; delete after a confirmation; the switched-on types with no approved template, one by one or
// all at once; and the editor: Meta's rules checked as HR types, the phone preview with the examples, the POST, and
// Meta's refusal shown as it came.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

type Call = { path: string; method: string; body: unknown };

function templatesServer(opts: { refuseCreate?: boolean; configured?: boolean } = {}) {
  const calls: Call[] = [];
  const list = metaTemplatesFixture();
  if (opts.configured === false) list.configured = false;
  const record = (path: string) => (_p: URLSearchParams, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return method;
  };
  const fixtures: Fixtures = {
    "/api/whatsapp-control/meta-templates": (p, init) => {
      const method = record("meta-templates")(p, init);
      if (method === "GET") return list;
      if (opts.refuseCreate)
        return {
          status: 400,
          body: {
            error: "Meta: Template name already exists in this language.",
            fields: { name: "Already used at Meta." },
          },
        };
      const body = JSON.parse(String(init!.body)) as { name: string };
      return { id: 99, name: body.name, language: "en", category: "UTILITY", status: "PENDING", messageTypes: [] };
    },
    "/api/whatsapp-control/meta-templates/sync": (p, init) => {
      record("sync")(p, init);
      return { synced: 4 };
    },
    "/api/whatsapp-control/meta-templates/3": (p, init) => {
      record("delete-3")(p, init);
      return { ok: true };
    },
    "/api/whatsapp-control/meta-templates/create-missing": (p, init) => {
      record("create-missing")(p, init);
      return {
        results: [
          { type: "id_card", label: "ID Card", name: "hrms_id_card", ok: true, status: "PENDING" },
          {
            type: "approval_approved",
            label: "Request Approved",
            name: "hrms_approval_approved",
            ok: false,
            error: "Meta: too many variables",
          },
        ],
      };
    },
  };
  return { calls, fixtures };
}

const open = async (server = templatesServer()) => {
  page = await renderMdPage(
    WhatsAppControl,
    { ...pageFixtures(), "/api/auth/me": ADMIN, ...server.fixtures },
    { path: "/hr/whatsapp-control?tab=templates" },
  );
  return { page, server };
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const rows = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="wa-template-hrms_"]')).map((r) =>
    r.dataset.testid!.replace("wa-template-", ""),
  );

describe("the Meta templates list", () => {
  it("shows every template with its status, category, quality, the types it serves and Meta's reason", async () => {
    await open();
    expect(rows()).toEqual(["hrms_salary_slip", "hrms_otp", "hrms_late_alert", "hrms_visitor_notification"]);
    const slip = el('[data-testid="wa-template-hrms_salary_slip"]')!.textContent!;
    expect(slip).toContain("Approved");
    expect(slip).toContain("Utility");
    expect(slip).toContain("Green");
    expect(slip).toContain("Salary Slip");
    expect(el('[data-testid="wa-template-hrms_otp"]')!.textContent).toContain("Authentication");
    expect(el('[data-testid="wa-template-hrms_otp"]')!.textContent).toContain("OTP login");
    expect(el('[data-testid="wa-template-reason-3"]')!.textContent).toBe("Meta: INVALID_FORMAT");
    expect(el('[data-testid="wa-template-hrms_visitor_notification"]')!.textContent).toContain("In review");
  });

  it("filters by status and says how many of each", async () => {
    await open();
    expect(el('[data-testid="wa-templates-filter-problem"]')!.textContent).toBe("Rejected / paused 1");
    await page!.click('[data-testid="wa-templates-filter-problem"]');
    expect(rows()).toEqual(["hrms_late_alert"]);
    await page!.click('[data-testid="wa-templates-filter-approved"]');
    expect(rows()).toEqual(["hrms_salary_slip", "hrms_otp"]);
  });

  it("draws a stored template on the phone with Meta's examples", async () => {
    await open();
    await page!.click('[data-testid="wa-template-toggle-1"]');
    const preview = el('[data-testid="wa-stored-preview-1"]')!;
    expect(preview.textContent).toContain("Dear Asha Kumar");
    expect(preview.textContent).toContain("August 2026");
    expect(preview.textContent).toContain("Document (PDF)");
  });

  it("syncs with Meta on Sync now", async () => {
    const { server } = await open();
    await page!.click('[data-testid="wa-templates-sync"]');
    expect(server.calls.filter((c) => c.path === "sync")).toEqual([{ path: "sync", method: "POST", body: null }]);
  });

  it("deletes only after a confirmation that names what will be skipped", async () => {
    const { server } = await open();
    await page!.click('[data-testid="wa-template-delete-3"]');
    expect(server.calls.some((c) => c.path === "delete-3")).toBe(false);
    const dialog = el('[data-testid="wa-template-delete-confirm"]')!;
    expect(dialog.textContent).toContain("Delete hrms_late_alert?");
    expect(dialog.textContent).toContain("Late attendance alert");
    await page!.click('[data-testid="wa-template-delete-confirm-confirm"]');
    expect(server.calls.filter((c) => c.path === "delete-3").map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("says when the Meta keys are missing and offers no sync", async () => {
    await open(templatesServer({ configured: false }));
    const note = el('[data-testid="wa-templates-not-configured"]')!.textContent;
    expect(note).toContain("WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID");
    expect(note).not.toContain("WABA_ID"); // the server's real variable names only
    expect(el('[data-testid="wa-templates-sync"]')!.hasAttribute("disabled")).toBe(true);
  });
});

describe("the types without an approved template", () => {
  it("lists the switched-on ones (not a section that is off, not one in review), and creates them all after asking", async () => {
    const { server } = await open();
    const missing = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="wa-missing-"]'))
      .map((r) => r.dataset.testid!)
      .filter((id) => !id.startsWith("wa-missing-create-"));
    expect(missing).toEqual(["wa-missing-id_card", "wa-missing-approval_approved"]);
    await page!.click('[data-testid="wa-create-missing"]');
    expect(el('[data-testid="wa-create-missing-confirm"]')!.textContent).toContain("(2 now)");
    await page!.click('[data-testid="wa-create-missing-confirm-confirm"]');
    expect(server.calls.filter((c) => c.path === "create-missing").map((c) => c.method)).toEqual(["POST"]);
    const results = el('[data-testid="wa-create-missing-results"]')!.textContent!;
    expect(results).toContain("1 template submitted, 1 not");
    expect(results).toContain("Request Approved: Meta: too many variables");
  });
});

describe("the types without an approved template follow the server's rule", () => {
  it("leaves the code template out while WhatsApp OTP is OFF, and a type held by a shared switch", async () => {
    const settings = settingsServer();
    settings.state.otpEnabled = false;
    settings.state.groups = [...(settings.state.groups as unknown[]), { key: "geo", title: "Geo", blurb: "" }];
    settings.state.features.push(
      { key: "geoApprovalEnabled", group: "geo", label: "Geo approval", enabled: false },
      { key: "type:geo_approval", group: "geo", label: "Geo Approval", enabled: true },
    );
    const server = templatesServer();
    const list = metaTemplatesFixture();
    list.templates = list.templates.filter((t) => t.name !== "hrms_otp");
    page = await renderMdPage(
      WhatsAppControl,
      {
        ...pageFixtures(settings),
        "/api/auth/me": ADMIN,
        ...server.fixtures,
        "/api/whatsapp-control/meta-templates": list,
      },
      { path: "/hr/whatsapp-control?tab=templates" },
    );
    const missing = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="wa-missing-"]'))
      .map((r) => r.dataset.testid!)
      .filter((id) => !id.startsWith("wa-missing-create-"));
    expect(missing).toEqual(["wa-missing-id_card", "wa-missing-approval_approved"]);
  });
});

describe("the template editor", () => {
  it("never offers Marketing: the server refuses it", async () => {
    await open();
    await page!.click('[data-testid="wa-templates-new"]');
    const options = Array.from(
      (el('[data-testid="wa-tpl-category"]') as HTMLSelectElement).querySelectorAll("option"),
    ).map((o) => o.value);
    expect(options).toEqual(["UTILITY", "AUTHENTICATION"]);
  });

  it("checks Meta's rules as HR types, shows the phone, and submits the template", async () => {
    const { server } = await open();
    await page!.click('[data-testid="wa-templates-new"]');
    expect(el('[data-testid="wa-template-dialog"]')!.textContent).toContain("Create a template");
    await page!.type('[data-testid="wa-tpl-name"]', "Hrms Shift Change");
    expect((el('[data-testid="wa-tpl-name"]') as HTMLInputElement).value).toBe("hrms_shift_change");

    await page!.type('[data-testid="wa-tpl-body"]', "{{employee_name}} your shift changes on {{date}}.");
    expect(el('[data-testid="wa-tpl-body-error"]')!.textContent).toContain("starts with a variable");
    expect(el('[data-testid="wa-tpl-submit"]')!.hasAttribute("disabled")).toBe(true);

    await page!.type(
      '[data-testid="wa-tpl-body"]',
      "Dear {{employee_name}},\nYour shift changes on {{date}}. Please check the HRMS app.\n- UK Textiles HR",
    );
    expect(el('[data-testid="wa-tpl-body-error"]')).toBeNull();
    expect(el('[data-testid="wa-tpl-example-error-date"]')!.textContent).toBe("Meta needs an example.");
    await page!.type('[data-testid="wa-tpl-example-date"]', "21 Nov 2026");
    expect(el('[data-testid="wa-tpl-preview-body"]')!.textContent).toContain("Dear Asha Kumar");
    expect(el('[data-testid="wa-tpl-preview-body"]')!.textContent).toContain("21 Nov 2026");

    await page!.click('[data-testid="wa-tpl-submit"]');
    const post = server.calls.find((c) => c.path === "meta-templates" && c.method === "POST")!;
    expect(post.body).toEqual({
      name: "hrms_shift_change",
      language: "en",
      category: "UTILITY",
      header: "",
      body: "Dear {{employee_name}},\nYour shift changes on {{date}}. Please check the HRMS app.\n- UK Textiles HR",
      footer: "UK Textiles HR",
      examples: { employee_name: "Asha Kumar", date: "21 Nov 2026" },
    });
    expect(el('[data-testid="wa-template-dialog"]')).toBeNull();
  });

  it("shows Meta's refusal and the field it is about, and keeps the form", async () => {
    await open(templatesServer({ refuseCreate: true }));
    await page!.click('[data-testid="wa-templates-new"]');
    await page!.type('[data-testid="wa-tpl-name"]', "hrms_salary_slip");
    await page!.type(
      '[data-testid="wa-tpl-body"]',
      "Dear {{employee_name}},\nYour slip is attached here.\n- UK Textiles HR",
    );
    await page!.click('[data-testid="wa-tpl-submit"]');
    expect(el('[data-testid="wa-tpl-server-error"]')!.textContent).toContain("Template name already exists");
    expect(el('[data-testid="wa-tpl-name-error"]')!.textContent).toBe("Already used at Meta.");
    expect(el('[data-testid="wa-template-dialog"]')).not.toBeNull();
  });

  it("draws a code template the way Meta writes it, with a Copy code button and no body to type", async () => {
    await open();
    await page!.click('[data-testid="wa-templates-new"]');
    const category = el('[data-testid="wa-tpl-category"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(category, "AUTHENTICATION");
      category.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page!.settle();
    expect(el('[data-testid="wa-tpl-body"]')).toBeNull();
    expect(el('[data-testid="wa-tpl-auth-note"]')).not.toBeNull();
    expect(el('[data-testid="wa-tpl-preview-body"]')!.textContent).toContain("is your verification code");
    expect(el('[data-testid="wa-tpl-preview-button"]')!.textContent).toBe("Copy code");
  });

  it("starts a new template from a message type's HRMS wording when HR picks one", async () => {
    const server = templatesServer();
    server.fixtures["/api/whatsapp-control/meta-templates/draft/salary_slip"] = {
      name: "hrms_salary_slip_v2",
      language: "en",
      category: "UTILITY",
      header: "document",
      body: "Dear {{employee_name}},\nYour salary slip for {{month_year}} is attached.\n\n- UK Textiles HR",
      footer: "UK Textiles HR",
      examples: { employee_name: "Asha Kumar", month_year: "August 2026" },
      warnings: ["A template named hrms_salary_slip is already approved."],
    };
    await open(server);
    await page!.click('[data-testid="wa-templates-new"]');
    const from = el('[data-testid="wa-tpl-from"]') as HTMLSelectElement;
    const options = Array.from(from.options).map((o) => o.textContent);
    // the code types are offered once, as their shared template; the contact card (not sent via Meta) not at all
    expect(options).toContain("Sign-in codes (hrms_otp)");
    expect(options).not.toContain("OTP password reset");
    expect(options).not.toContain("Visitor Contact Card");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(from, "salary_slip");
      from.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page!.settle();
    expect(page!.requests()).toContain("/api/whatsapp-control/meta-templates/draft/salary_slip");
    expect((el('[data-testid="wa-tpl-name"]') as HTMLInputElement).value).toBe("hrms_salary_slip_v2");
    expect((el('[data-testid="wa-tpl-header"]') as HTMLSelectElement).value).toBe("document");
    expect(el('[data-testid="wa-tpl-warning"]')!.textContent).toContain("already approved");
    expect(el('[data-testid="wa-tpl-preview-body"]')!.textContent).toContain("August 2026");
  });
});
