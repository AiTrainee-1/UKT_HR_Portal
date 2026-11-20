import { describe, expect, it } from "vitest";
import { ApiError } from "../custom-fetch";
import {
  readMetaTemplates,
  readWhatsAppConnection,
  readWhatsAppCreateMissing,
  readWhatsAppMessage,
  readWhatsAppOverview,
  readWhatsAppSettings,
  readWhatsAppTemplateDraft,
  readWhatsAppTestOptions,
  readWhatsAppTestResult,
  readWhatsAppUsage,
  whatsAppFieldErrors,
  type WhatsAppMessage,
} from "./whatsapp";

// Every answer of WhatsApp Control on the Meta WhatsApp Cloud API (2026-11-20) is read through a read*() function, so a
// partial answer (an older or a newer server: the backend landed in parallel) shows safe values instead of breaking a
// tab, and never reads as "all good" when it said nothing.

describe("readWhatsAppOverview", () => {
  it("reads an empty answer as not set up, nothing sent, nothing spent, never as all good", () => {
    const o = readWhatsAppOverview(null);
    expect(o.connection).toMatchObject({
      configured: false,
      sendingAllowed: false,
      blockReasons: [],
      displayNumber: null,
    });
    expect(o.month).toEqual({
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      queued: 0,
      skipped: 0,
      deliveryRate: null,
      readRate: null,
    });
    expect(o.cost).toEqual({ soFar: 0, projected: 0, budget: null, budgetUsedPct: null, currency: "INR" });
    expect(o.otp).toEqual({ enabled: false, available: false, templateStatus: null, templateName: null, month: null });
    expect(o.queue).toBeNull();
    expect(o.alerts).toEqual([]);
  });

  it("keeps the server's figures: rates as a fraction or a percent, Decimals as text, alerts and missing types in any shape", () => {
    const o = readWhatsAppOverview({
      connection: { configured: true, sendingAllowed: true, blockReasons: ["a", "", 3], displayNumber: "+91 1" },
      month: { sent: 200, delivered: 150, read: 40, deliveryRate: 0.95, readRate: 20 },
      cost: { soFar: "12.50", projected: 30, budget: "100.00", budgetUsedPct: 12.5 },
      templates: {
        approved: 3,
        missingForEnabledTypes: ["late_alert", { key: "id_card", label: "ID Card", template: "hrms_id_card" }, 7],
      },
      otp: { enabled: true, available: true, templateStatus: "APPROVED", sent: 9, delivered: 8 },
      queue: { queued: 2 },
      alerts: [
        { level: "error", code: "x", message: "Bad" },
        { level: "loud", message: "Odd level" },
        "Plain words",
        { code: "no message" },
      ],
    });
    expect(o.connection.blockReasons).toEqual(["a"]);
    expect(o.month.deliveryRate).toBe(95);
    expect(o.month.readRate).toBe(20);
    expect(o.cost).toMatchObject({ soFar: 12.5, budget: 100 });
    expect(o.templates.missingForEnabledTypes).toEqual([
      { type: "late_alert", label: "late_alert", templateName: null },
      { type: "id_card", label: "ID Card", templateName: "hrms_id_card" },
    ]);
    expect(o.otp.month).toEqual({ sent: 9, delivered: 8, verified: null });
    expect(o.queue?.queued).toBe(2);
    expect(o.alerts).toEqual([
      { level: "error", code: "x", message: "Bad" },
      { level: "info", code: "", message: "Odd level" },
      { level: "warning", code: "", message: "Plain words" },
    ]);
  });

  it("works the rates out from the counts when the server sends none (a read message was delivered first)", () => {
    const o = readWhatsAppOverview({ month: { sent: 10, delivered: 6, read: 3 } });
    expect(o.month.deliveryRate).toBe(90);
    expect(o.month.readRate).toBe(30);
  });
});

describe("readWhatsAppUsage", () => {
  it("fills every category, Meta's India rates, 18% GST and the month asked for when the answer is empty", () => {
    const u = readWhatsAppUsage({}, "2026-10");
    expect(u.month).toBe("2026-10");
    expect(u.days).toEqual([]);
    expect(Object.keys(u.byCategory)).toEqual(["authentication", "utility", "marketing", "service"]);
    expect(u.rates).toEqual({ authentication: 0.115, utility: 0.115, marketing: 0.8631, service: 0 });
    expect(u.cost).toMatchObject({ soFar: 0, projected: 0, gstRate: 0.18, isCurrentMonth: true });
    expect(u.meta).toEqual({ available: false, cost: null, volume: null, lastSyncedAt: null, error: null });
  });

  it("keeps the server's numbers and works out the GST figures it left out", () => {
    const u = readWhatsAppUsage({
      month: "2026-11",
      days: [{ date: "2026-11-01", sent: 3, byCategory: { utility: 3 } }, { sent: 1 }],
      byCategory: { utility: { messages: 3, billable: 3, cost: "0.35" } },
      byType: [{ type: "salary_slip", messages: 3, cost: 0.35 }, { label: "no type" }],
      cost: { soFar: 10, projected: 20, isCurrentMonth: false },
      rates: { utility: "0.12", marketing: -1 },
      meta: { available: true, cost: 9.8, volume: 80 },
    });
    expect(u.days).toEqual([
      {
        date: "2026-11-01",
        sent: 3,
        delivered: 0,
        read: 0,
        failed: 0,
        byCategory: { authentication: 0, utility: 3, marketing: 0, service: 0 },
      },
    ]);
    expect(u.byCategory.utility).toEqual({ messages: 3, billable: 3, rate: 0.12, cost: 0.35 });
    expect(u.rates.marketing).toBe(0.8631); // a negative rate is ignored
    expect(u.byType).toEqual([{ type: "salary_slip", label: "salary_slip", module: "", messages: 3, cost: 0.35 }]);
    expect(u.cost).toMatchObject({ soFarWithGst: 11.8, projectedWithGst: 23.6, isCurrentMonth: false });
    expect(u.meta).toMatchObject({ available: true, cost: 9.8, volume: 80 });
  });
});

describe("readWhatsAppSettings", () => {
  it("defaults the engine and WhatsApp OTP to ON, and fills the new Meta fields on an older server", () => {
    const s = readWhatsAppSettings({
      engineEnabled: false,
      features: [{ key: "otpLoginEnabled", enabled: true }, { label: "x" }],
    });
    expect(s.engineEnabled).toBe(false);
    expect(s.otpEnabled).toBe(true);
    expect(s.features).toEqual([
      { key: "otpLoginEnabled", label: "otpLoginEnabled", description: "", group: "other", enabled: true },
    ]);
    expect(s.templateOverrides).toEqual({});
    expect(s.priceRates).toEqual({ authentication: 0.115, utility: 0.115, marketing: 0.8631, service: 0 });
    expect(s.monthlyBudget).toBeNull();
    expect(s.quietHours).toBeUndefined();
  });

  it("reads the overrides, the prices and the budget (Decimals as text)", () => {
    const s = readWhatsAppSettings({
      otpEnabled: false,
      templateOverrides: { salary_slip: "payslip_v2", id_card: "" },
      priceRates: { utility: "0.1200" },
      monthlyBudget: "750.00",
      quietHours: { enabled: true, start: "22:00", end: "06:00" },
    });
    expect(s.otpEnabled).toBe(false);
    expect(s.templateOverrides).toEqual({ salary_slip: "payslip_v2" });
    expect(s.priceRates.utility).toBe(0.12);
    expect(s.monthlyBudget).toBe(750);
    expect(s.quietHours).toEqual({ enabled: true, start: "22:00", end: "06:00" });
  });
});

describe("the Meta templates", () => {
  it("reads the list (or a bare array), upper-cases Meta's words, and drops rows without a name", () => {
    const t = readMetaTemplates({
      templates: [
        {
          id: 4,
          name: "hrms_x",
          category: "utility",
          status: "approved",
          qualityScore: { score: "green" },
          messageTypes: ["x", 1],
        },
        { id: 5 },
      ],
      configured: false,
    });
    expect(t.configured).toBe(false);
    expect(t.templates).toEqual([
      {
        id: 4,
        name: "hrms_x",
        language: "en",
        category: "UTILITY",
        status: "APPROVED",
        qualityScore: "GREEN",
        rejectedReason: null,
        messageTypes: ["x"],
        components: [],
        lastSyncedAt: null,
        metaId: null,
      },
    ]);
    expect(readMetaTemplates([{ name: "a" }]).templates[0]).toMatchObject({
      id: -1,
      status: "PENDING",
      category: "UTILITY",
    });
    expect(readMetaTemplates(null)).toEqual({ templates: [], lastSyncedAt: null, configured: true });
  });

  it("reads a draft, its header in any shape, examples as text, and the code expiry", () => {
    expect(
      readWhatsAppTemplateDraft(
        {
          name: "hrms_id_card",
          header: { type: "IMAGE" },
          body: "Hi {{employee_name}} ok",
          examples: { employee_name: "Asha", n: 3 },
        },
        "id_card",
      ),
    ).toEqual({
      messageType: "id_card",
      name: "hrms_id_card",
      language: "en",
      category: "UTILITY",
      header: "image",
      body: "Hi {{employee_name}} ok",
      footer: "UK Textiles HR",
      examples: { employee_name: "Asha", n: "3" },
      warnings: [],
      codeExpirationMinutes: null,
    });
    const otp = readWhatsAppTemplateDraft({
      name: "hrms_otp",
      category: "authentication",
      header: "VIDEO",
      expiryMinutes: 5,
    });
    expect(otp).toMatchObject({ category: "AUTHENTICATION", header: "", codeExpirationMinutes: 5 });
  });

  it("reads the per-type results of Create all missing", () => {
    expect(
      readWhatsAppCreateMissing({
        results: [
          { type: "id_card", name: "hrms_id_card", ok: true, status: "PENDING" },
          { type: "late_alert", ok: false, error: "Meta said no" },
          { messageType: "geo_approval", templateName: "hrms_geo_approval" },
          { nothing: true },
        ],
      }),
    ).toEqual([
      { type: "id_card", label: "id_card", name: "hrms_id_card", ok: true, status: "PENDING", error: null },
      { type: "late_alert", label: "late_alert", name: null, ok: false, status: null, error: "Meta said no" },
      { type: "geo_approval", label: "geo_approval", name: "hrms_geo_approval", ok: true, status: null, error: null },
    ]);
    expect(readWhatsAppCreateMissing([{ type: "x", ok: true }])).toHaveLength(1);
    expect(readWhatsAppCreateMissing(null)).toEqual([]);
  });
});

describe("readWhatsAppConnection", () => {
  it("reads an empty answer as not set up and nothing known, never as all good", () => {
    expect(readWhatsAppConnection(null)).toEqual({
      env: [],
      configured: false,
      sendingAllowed: false,
      blockReasons: [],
      phone: null,
      tokenOk: null,
      error: null,
      apiVersion: null,
      webhook: { url: "", verifyTokenSet: false, appSecretSet: false, lastWebhookAt: null },
      devLock: { onlyToEmployees: null },
    });
  });

  it("keeps names only (never a value), reads Meta's phone in either case, and codes as strings", () => {
    const c = readWhatsAppConnection({
      env: [{ name: "WHATSAPP_CLOUD_ACCESS_TOKEN", set: true, secret: true, value: "never shown" }, { set: true }],
      configured: true,
      phone: { display_phone_number: "+91 1", qualityRating: "GREEN", throughput: { level: "HIGH" } },
      tokenOk: true,
      devLock: { onlyToEmployees: [30020, "30021"] },
    });
    // an older server that does not say counts a variable as required
    expect(c.env).toEqual([{ name: "WHATSAPP_CLOUD_ACCESS_TOKEN", set: true, secret: true, required: true }]);
    expect(
      readWhatsAppConnection({ env: [{ name: "WHATSAPP_CLOUD_API_BASE", set: false, secret: false, required: false }] })
        .env,
    ).toEqual([{ name: "WHATSAPP_CLOUD_API_BASE", set: false, secret: false, required: false }]);
    expect(c.phone).toMatchObject({ displayPhoneNumber: "+91 1", qualityRating: "GREEN", throughput: "HIGH" });
    expect(c.devLock.onlyToEmployees).toEqual(["30020", "30021"]);
    expect(readWhatsAppConnection({ phone: {} }).phone).toBeNull();
  });
});

describe("readWhatsAppMessage", () => {
  const base = {
    id: 1,
    status: "read",
    category: "attendance",
    messageText: "Hi",
    error: "",
  } as unknown as WhatsAppMessage;
  const row = (extra: Record<string, unknown>) => ({ ...base, ...extra }) as unknown as WhatsAppMessage;

  it("reads the template and pricing category under either name, and leaves them empty on an older server", () => {
    expect(
      readWhatsAppMessage(row({ templateName: "hrms_x", pricingCategory: "UTILITY", billable: true })),
    ).toMatchObject({
      templateName: "hrms_x",
      pricingCategory: "utility",
      billable: true,
    });
    expect(readWhatsAppMessage(row({ template: "hrms_y", category: "authentication" }))).toMatchObject({
      templateName: "hrms_y",
      pricingCategory: "authentication",
    });
    expect(readWhatsAppMessage(base)).toMatchObject({
      templateName: "",
      pricingCategory: null,
      billable: null,
      deliveredAt: null,
    });
  });
});

describe("Send a test answers", () => {
  it("drops rows it can't use and reads each type's template", () => {
    const o = readWhatsAppTestOptions({
      limitedTo: [],
      recipients: [{ id: 71, code: "30020", name: "SURYA M", phone: "••••9103", hasPhone: true }, { code: "x" }],
      types: [
        {
          documentType: "late_alert",
          label: "Late",
          module: "attendance",
          template: "hrms_late_alert",
          templateStatus: "APPROVED",
        },
        { label: "no key" },
      ],
    });
    expect(o.limitedTo).toBeNull();
    expect(o.recipients).toEqual([
      { id: 71, code: "30020", name: "SURYA M", phone: "••••9103", hasPhone: true, blockedReason: null },
    ]);
    expect(o.types).toEqual([
      {
        documentType: "late_alert",
        label: "Late",
        module: "attendance",
        moduleLabel: "attendance",
        kind: "",
        variables: [],
        templateName: "hrms_late_alert",
        templateStatus: "APPROVED",
      },
    ]);
    // a recipient without a phone has none, whatever the flag says
    expect(
      readWhatsAppTestOptions({ recipients: [{ id: 1, hasPhone: true, phone: null }] }).recipients[0].hasPhone,
    ).toBe(false);
  });

  it("reads Meta's answer: the wamid, the error code, the parameters as a list or an object", () => {
    expect(
      readWhatsAppTestResult({
        status: "preview",
        templateName: "hrms_x",
        params: [
          { name: "employee_name", value: "Asha" },
          { parameter_name: "date", text: "1 Nov" },
        ],
      }),
    ).toMatchObject({
      status: "preview",
      templateName: "hrms_x",
      params: [
        { name: "employee_name", value: "Asha" },
        { name: "date", value: "1 Nov" },
      ],
    });
    expect(readWhatsAppTestResult({ status: "sent", wamid: "wamid.1", params: { a: "b" } })).toMatchObject({
      providerMessageId: "wamid.1",
      params: [{ name: "a", value: "b" }],
    });
    expect(
      readWhatsAppTestResult({ status: "failed", error: "Expired token", code: 190, httpStatus: 401 }),
    ).toMatchObject({
      errorCode: 190,
      httpStatus: 401,
    });
    expect(readWhatsAppTestResult({ status: "blocked", error: "Not sent (development safety)" }).status).toBe(
      "blocked",
    );
    expect(readWhatsAppTestResult({ status: "queued" })).toMatchObject({
      status: "failed",
      error: "The server's answer was not understood.",
    });
  });
});

describe("whatsAppFieldErrors", () => {
  const refusal = (body: unknown) =>
    new ApiError(new Response(JSON.stringify(body), { status: 400 }), body, { method: "POST", url: "/x" });

  it("reads per-field sentences under fields / errors, the first of a list", () => {
    expect(
      whatsAppFieldErrors(refusal({ fields: { name: "Taken" }, errors: { body: ["Too long", "x"], footer: "" } })),
    ).toEqual({ name: "Taken", body: "Too long" });
    expect(whatsAppFieldErrors(refusal({ error: "x" }))).toEqual({});
    expect(whatsAppFieldErrors(new Error("x"))).toEqual({});
  });
});
