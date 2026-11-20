import { describe, expect, it } from "vitest";
import { readMetaTemplates, readWhatsAppSettings, type WhatsAppAlert } from "@/lib/api-client/custom-hooks";
import {
  alertTab,
  authTemplatePreview,
  budgetState,
  changedLimits,
  chartDays,
  checkTemplate,
  connectionVerdict,
  controlSections,
  controlSummary,
  crossesMidnight,
  daysInMonth,
  deliveryTicks,
  employeeCodesText,
  findTemplate,
  formatCount,
  formatInr,
  formatPct,
  formatRate,
  groupTestTypes,
  limitError,
  metaErrorHelp,
  moneyError,
  monthLabel,
  numberStatusInfo,
  orderedGroups,
  projectMonth,
  qualityInfo,
  quietHoursError,
  renderTemplate,
  shiftMonth,
  sortAlerts,
  tabFromSearch,
  tabHref,
  templateExamples,
  templateNameFor,
  templateParts,
  templateState,
  templateStatusLabel,
  templateVariables,
  tierInfo,
  timeAgo,
  typeOfSwitch,
  usageLevel,
  webhookHealth,
} from "./logic";
import { metaTemplatesFixture, settingsFixture, usageFixture } from "./test-fixtures";

const NOW = new Date(2026, 10, 20, 12, 0, 0); // 20 Nov 2026, noon

describe("the address", () => {
  it("reads ?tab= and builds a tab's address", () => {
    expect(tabFromSearch("")).toBe("overview");
    expect(tabFromSearch("?tab=Usage")).toBe("usage");
    expect(tabFromSearch("tab=templates&x=1")).toBe("templates");
    expect(tabHref("/hr/whatsapp-control", "overview")).toBe("/hr/whatsapp-control");
    expect(tabHref("/hr/whatsapp-control", "otp")).toBe("/hr/whatsapp-control?tab=otp");
  });
});

describe("money, counts and months", () => {
  it("writes rupees the Indian way, and rates with up to four decimals", () => {
    expect(formatInr(123456.7)).toBe("₹1,23,456.70");
    expect(formatInr(0)).toBe("₹0.00");
    expect(formatInr(null)).toBe("—");
    expect(formatRate(0.115)).toBe("₹0.115");
    expect(formatRate(0.8631)).toBe("₹0.8631");
    expect(formatRate(0)).toBe("₹0");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatPct(93.04)).toBe("93%");
    expect(formatPct(21.44)).toBe("21.4%");
    expect(formatPct(null)).toBe("—");
  });

  it("moves between months and names them", () => {
    expect(shiftMonth("2026-11", -1)).toBe("2026-10");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-11")).toMatch(/November 2026/);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
  });

  it("projects only the current month: so far / days gone x days in the month", () => {
    // 20 of 30 days gone: 40 so far -> 60
    expect(projectMonth(40, "2026-11", NOW)).toBe(60);
    expect(projectMonth(40, "2026-10", NOW)).toBe(40); // a past month is its total
    expect(projectMonth(40, "2026-12", NOW)).toBe(0); // nothing spent yet
  });

  it("says how long ago, or nothing", () => {
    expect(timeAgo(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe("just now");
    expect(timeAgo(new Date(NOW.getTime() - 4 * 60_000).toISOString(), NOW)).toBe("4 min ago");
    expect(timeAgo(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW)).toBe("3 h ago");
    expect(timeAgo(new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), NOW)).toBe("2 days ago");
    expect(timeAgo(null, NOW)).toBeNull();
    expect(timeAgo("nonsense", NOW)).toBeNull();
  });
});

describe("cost against the budget", () => {
  it("is none without a budget, ok under 80%, near at 80% or when the projection passes it, over past it", () => {
    expect(budgetState(10, 20, null).level).toBe("none");
    expect(budgetState(10, 20, 0).level).toBe("none");
    expect(budgetState(10, 30, 100)).toEqual({ level: "ok", usedPct: 10, projectedPct: 30, projectedOver: false });
    expect(budgetState(80, 90, 100).level).toBe("near");
    expect(budgetState(30, 120, 100)).toMatchObject({ level: "near", projectedOver: true, projectedPct: 120 });
    expect(budgetState(120, 150, 100).level).toBe("over");
  });

  it("checks a typed price or budget", () => {
    expect(moneyError("0.115", { max: 100 })).toBeNull();
    expect(moneyError("", { optional: true })).toBeNull();
    expect(moneyError("")).toBe("Enter an amount.");
    expect(moneyError("-1")).toBe("Numbers only, like 0.115.");
    expect(moneyError("1,000")).toBe("Numbers only, like 0.115.");
    expect(moneyError("101", { max: 100 })).toBe("At most ₹100.");
  });
});

describe("Meta's words for the number's health", () => {
  it("reads the quality rating, the messaging tier and the number's status", () => {
    expect(qualityInfo("GREEN")).toMatchObject({ label: "High", tone: "good" });
    expect(qualityInfo("YELLOW").tone).toBe("warn");
    expect(qualityInfo("RED").tone).toBe("bad");
    expect(qualityInfo(null).label).toBe("Not known");
    expect(tierInfo("TIER_2K")).toEqual({ label: "2,000 people / 24 h", people: 2000 });
    expect(tierInfo("TIER_250").people).toBe(250);
    expect(tierInfo("TIER_100K").people).toBe(100000);
    expect(tierInfo("TIER_UNLIMITED").label).toBe("Unlimited");
    expect(tierInfo(null).label).toBe("Not known");
    expect(numberStatusInfo("CONNECTED")).toEqual({ label: "Connected", tone: "good" });
    expect(numberStatusInfo("FLAGGED").tone).toBe("warn");
    expect(numberStatusInfo("RESTRICTED").tone).toBe("bad");
  });

  it("calls a webhook silent for a day stale, and one never heard from 'never'", () => {
    expect(webhookHealth(null, NOW)).toMatchObject({ state: "never", tone: "warn" });
    expect(webhookHealth(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toMatchObject({
      state: "ok",
      tone: "good",
    });
    expect(webhookHealth(new Date(NOW.getTime() - 30 * 3_600_000).toISOString(), NOW).state).toBe("stale");
  });

  it("gives one verdict for the hero, the worst first", () => {
    expect(connectionVerdict({ configured: false, sendingAllowed: false })).toEqual({
      label: "Not set up",
      tone: "bad",
    });
    expect(connectionVerdict({ configured: true, sendingAllowed: false }).label).toBe("Sending blocked");
    expect(connectionVerdict({ configured: true, sendingAllowed: true, status: "RESTRICTED" }).tone).toBe("bad");
    expect(connectionVerdict({ configured: true, sendingAllowed: true, qualityRating: "RED" }).label).toBe(
      "Quality low",
    );
    expect(connectionVerdict({ configured: true, sendingAllowed: true, status: "CONNECTED" })).toEqual({
      label: "Live",
      tone: "good",
    });
  });

  it("puts errors first and links each alert to the tab that fixes it", () => {
    const a = (level: WhatsAppAlert["level"], code: string, message = "x"): WhatsAppAlert => ({ level, code, message });
    expect(sortAlerts([a("info", "1"), a("error", "2"), a("warning", "3")]).map((x) => x.code)).toEqual([
      "2",
      "3",
      "1",
    ]);
    expect(alertTab(a("error", "template_rejected"))).toBe("templates");
    expect(alertTab(a("warning", "otp_template_missing"))).toBe("otp");
    expect(alertTab(a("warning", "budget_near"))).toBe("usage");
    expect(alertTab(a("error", "not_configured"))).toBe("config");
    expect(alertTab(a("warning", "", "The webhook has not been heard from"))).toBe("config");
    expect(alertTab(a("info", "quality_drop", "Quality fell to medium"))).toBeNull();
  });
});

describe("templates", () => {
  it("reads Meta's statuses as the page's states", () => {
    expect(templateState("APPROVED")).toBe("approved");
    expect(templateState("pending")).toBe("pending");
    expect(templateState("IN_APPEAL")).toBe("pending");
    expect(templateState("REJECTED")).toBe("rejected");
    expect(templateState("PAUSED")).toBe("paused");
    expect(templateState("DELETED")).toBe("disabled");
    expect(templateState(null)).toBe("missing");
    expect(templateState("SOMETHING_NEW")).toBe("unknown");
    expect(templateStatusLabel("PENDING")).toBe("In review");
    expect(templateStatusLabel("DRAFT")).toBe("Draft");
    expect(templateStatusLabel("PENDING_DELETION")).toBe("Pending deletion");
  });

  it("names the template a type goes out as: HR's choice, the one serving it, else the catalog default", () => {
    const { templates } = readMetaTemplates(metaTemplatesFixture());
    expect(templateNameFor("salary_slip", {}, templates)).toBe("hrms_salary_slip");
    expect(templateNameFor("salary_slip", { salary_slip: "payslip_v2" }, templates)).toBe("payslip_v2");
    expect(templateNameFor("otp_reset", {}, null)).toBe("hrms_otp");
    expect(templateNameFor("absent_alert", {}, templates)).toBe("hrms_absent_alert");
    expect(templateNameFor("visitor_contact", {}, templates)).toBeNull();
  });

  it("finds the best row of a name (approved before rejected)", () => {
    const { templates } = readMetaTemplates({
      templates: [
        { id: 1, name: "hrms_x", language: "hi", status: "REJECTED" },
        { id: 2, name: "hrms_x", language: "en", status: "APPROVED" },
      ],
    });
    expect(findTemplate("hrms_x", templates)?.id).toBe(2);
    expect(findTemplate("hrms_y", templates)).toBeNull();
    expect(findTemplate(null, templates)).toBeNull();
  });

  it("reads variables, fills them with examples, and checks Meta's rules", () => {
    expect(templateVariables("Dear {{employee_name}}, {{ month_year }} and {{employee_name}} again.")).toEqual([
      "employee_name",
      "month_year",
    ]);
    expect(renderTemplate("Dear {{employee_name}}, see {{date}}.", { employee_name: "Asha" })).toBe(
      "Dear Asha, see [date].",
    );
    const ok = {
      name: "hrms_salary_slip",
      category: "UTILITY",
      body: "Dear {{employee_name}},\nYour slip for {{month_year}} is attached.\n- UK Textiles HR",
      footer: "UK Textiles HR",
      examples: { employee_name: "Asha", month_year: "August 2026" },
    };
    expect(checkTemplate(ok)).toEqual({ errors: {}, warnings: [] });
    expect(checkTemplate({ ...ok, name: "Salary Slip" }).errors.name).toContain("Lowercase");
    expect(checkTemplate({ ...ok, name: "" }).errors.name).toBe("Give the template a name.");
    expect(checkTemplate({ ...ok, body: "{{employee_name}} your slip is here. Thanks" }).errors.body).toContain(
      "starts",
    );
    expect(checkTemplate({ ...ok, body: "Your slip is here, {{employee_name}}." }).errors.body).toContain("ends");
    expect(checkTemplate({ ...ok, body: "Hi {{a}} {{b}} there friend" }).errors.body).toContain("side by side");
    expect(checkTemplate({ ...ok, body: "Hi {{Employee}} there friend" }).errors.body).toContain("lowercase");
    expect(checkTemplate({ ...ok, examples: { employee_name: "Asha" } }).errors["example:month_year"]).toBe(
      "Meta needs an example.",
    );
    expect(
      checkTemplate({ ...ok, examples: { ...ok.examples, month_year: "Aug\n2026" } }).errors["example:month_year"],
    ).toContain("One line");
    expect(checkTemplate({ ...ok, footer: "x".repeat(61) }).errors.footer).toContain("60");
    expect(checkTemplate({ ...ok, body: "Hi {{a}}, {{b}} ok" }).warnings[0]).toContain("Few fixed words");
    expect(checkTemplate({ ...ok, category: "MARKETING" }).warnings[0]).toContain("Marketing");
    // a code template's text is Meta's: only the name is checked
    expect(checkTemplate({ ...ok, category: "AUTHENTICATION", body: "" })).toEqual({ errors: {}, warnings: [] });
  });

  it("reads a stored template's parts and examples, and draws a code template", () => {
    const t = readMetaTemplates(metaTemplatesFixture()).templates[0];
    const parts = templateParts(t.components);
    expect(parts.header).toEqual({ format: "DOCUMENT", text: "" });
    expect(parts.body).toContain("{{month_year}}");
    expect(parts.footer).toBe("UK Textiles HR");
    expect(templateExamples(t.components)).toEqual({ employee_name: "Asha Kumar", month_year: "August 2026" });
    expect(templateParts([{ type: "BUTTONS", buttons: [{ text: "Copy code" }] }]).buttons).toEqual(["Copy code"]);
    expect(authTemplatePreview("123456", 5)).toEqual({
      body: "*123456* is your verification code. For your security, do not share this code.",
      footer: "This code expires in 5 minutes.",
    });
    expect(authTemplatePreview("1", null).footer).toBe("");
  });
});

describe("Message Controls: every type with its switch, template and count", () => {
  const settings = readWhatsAppSettings(settingsFixture());
  const templates = readMetaTemplates(metaTemplatesFixture()).templates;
  const byType = usageFixture().byType;

  it("knows which switch turns which type on and off", () => {
    expect(typeOfSwitch("type:salary_slip")).toBe("salary_slip");
    expect(typeOfSwitch("otpLoginEnabled")).toBe("otp_login");
    expect(typeOfSwitch("lateAlertEnabled")).toBe("late_alert");
    expect(typeOfSwitch("documentNotificationsEnabled")).toBeNull();
    expect(typeOfSwitch("leaveApprovalEnabled")).toBeNull();
  });

  it("keeps the server's groups in order, adds a group for a module with only type switches, drops empty ones", () => {
    const groups = orderedGroups(
      [
        { key: "signin", title: "Sign-in", blurb: "" },
        { key: "empty", title: "Empty", blurb: "" },
      ],
      [
        { key: "type:x", group: "otp", label: "X", description: "", enabled: true },
        { key: "otpLoginEnabled", group: "signin", label: "OTP", description: "", enabled: true },
        { key: "type:y", group: "outpass", label: "Y", description: "", enabled: true },
      ],
    );
    expect(groups.map((g) => g.key)).toEqual(["signin", "otp", "outpass"]);
  });

  it("splits each section into its master, workflow switches and message types", () => {
    const sections = controlSections(settings, templates, byType);
    const documents = sections.find((s) => s.group.key === "documents")!;
    expect(documents.master?.key).toBe("documentNotificationsEnabled");
    expect(documents.types.map((t) => t.type)).toEqual(["salary_slip", "id_card"]);
    const approvals = sections.find((s) => s.group.key === "approvals")!;
    expect(approvals.general.map((f) => f.key)).toEqual(["leaveApprovalEnabled"]);
    // password sign-in lives on the OTP tab only
    const signin = sections.find((s) => s.group.key === "signin")!;
    expect(signin.general).toEqual([]);
    expect(signin.types.map((t) => t.type)).toEqual(["otp_login", "otp_reset", "otp_activate"]);
  });

  it("gives each type its template, status, month count and the first reason it does not go out", () => {
    const rows = Object.fromEntries(
      controlSections(settings, templates, byType)
        .flatMap((s) => s.types)
        .map((r) => [r.type, r]),
    );
    expect(rows.salary_slip).toMatchObject({
      templateName: "hrms_salary_slip",
      templateState: "approved",
      monthCount: 24,
      off: null,
    });
    expect(rows.id_card).toMatchObject({
      templateName: "hrms_id_card",
      templateState: "missing",
      monthCount: 0,
      off: "template",
    });
    expect(rows.otp_login).toMatchObject({
      templateName: "hrms_otp",
      templateState: "approved",
      off: null,
      monthCount: 16,
    });
    expect(rows.otp_activate.off).toBe("own");
    // the attendance section switch is OFF
    expect(rows.late_alert).toMatchObject({ templateState: "rejected", off: "module" });
    expect(rows.visitor_notification).toMatchObject({ templateState: "pending", off: "template" });
    expect(rows.visitor_contact).toMatchObject({ templateName: null, templateState: "none", off: "own" });
  });

  it("puts the engine and the OTP master first, and reads no template status while templates can't be read", () => {
    const off = controlSections({ ...settings, engineEnabled: false }, templates, null).flatMap((s) => s.types);
    expect(off.every((r) => r.off === "engine")).toBe(true);
    const noOtp = controlSections({ ...settings, otpEnabled: false }, templates, null).flatMap((s) => s.types);
    expect(noOtp.find((r) => r.type === "otp_login")!.off).toBe("otp");
    const blind = controlSections(settings, null, null).flatMap((s) => s.types);
    expect(blind.find((r) => r.type === "id_card")).toMatchObject({ templateState: null, off: null, monthCount: null });
  });

  it("sums up what goes out", () => {
    expect(controlSummary(controlSections(settings, templates, byType))).toEqual({
      total: 10,
      live: 3,
      off: 4,
      noTemplate: 3,
    });
  });
});

describe("the month chart", () => {
  it("has every day up to today, zeros where the server has none, and each day's total", () => {
    const days = chartDays(usageFixture("2026-11").days, "2026-11", NOW);
    expect(days).toHaveLength(20);
    expect(days[0]).toMatchObject({ day: 1, total: 20, failed: 1 });
    expect(days[2]).toMatchObject({ date: "2026-11-03", total: 0, sent: 0 });
    expect(chartDays([], "2026-10", NOW)).toHaveLength(31);
    expect(chartDays([], "2026-12", NOW)).toHaveLength(0);
  });
});

describe("sending limits and quiet hours", () => {
  const limit = { key: "maxPerHour", label: "Per hour", value: 60, min: 1, max: 1000, unit: "messages" };
  it("checks a typed limit and sends only what changed", () => {
    expect(limitError(limit, "")).toBe("Enter a number.");
    expect(limitError(limit, "2.5")).toBe("Whole numbers only.");
    expect(limitError(limit, "0")).toBe("Must be between 1 and 1000.");
    expect(limitError(limit, "90")).toBeNull();
    expect(changedLimits([limit], { maxPerHour: "60" })).toEqual({});
    expect(changedLimits([limit], { maxPerHour: "90" })).toEqual({ maxPerHour: 90 });
  });
  it("checks quiet hours", () => {
    expect(quietHoursError({ enabled: true, start: "21:00", end: "07:00" })).toBeNull();
    expect(quietHoursError({ enabled: true, start: "9:00", end: "07:00" })).toBe("Enter both times as HH:MM.");
    expect(quietHoursError({ enabled: true, start: "07:00", end: "07:00" })).toContain("same time");
    expect(crossesMidnight({ enabled: true, start: "21:00", end: "07:00" })).toBe(true);
    expect(usageLevel(170, 200)).toBe("near");
    expect(usageLevel(200, 200)).toBe("full");
    expect(usageLevel(5, 0)).toBe("ok");
  });
});

describe("messages and tests", () => {
  it("draws WhatsApp's ticks", () => {
    expect(deliveryTicks("sent")).toBe("sent");
    expect(deliveryTicks("delivered")).toBe("delivered");
    expect(deliveryTicks("read")).toBe("read");
    expect(deliveryTicks("failed")).toBe("failed");
    expect(deliveryTicks("queued")).toBe("none");
  });

  it("groups the test types by module and names the allowed employees", () => {
    const t = (documentType: string, module: string) => ({
      documentType,
      label: documentType,
      module,
      moduleLabel: module === "documents" ? "Documents" : "",
      kind: "",
      variables: [],
      templateName: null,
      templateStatus: null,
    });
    expect(
      groupTestTypes([t("salary_slip", "documents"), t("late_alert", "attendance"), t("id_card", "documents")]),
    ).toEqual([
      { module: "documents", label: "Documents", types: [t("salary_slip", "documents"), t("id_card", "documents")] },
      { module: "attendance", label: "Attendance", types: [t("late_alert", "attendance")] },
    ]);
    expect(employeeCodesText(["30020"])).toBe("employee 30020");
    expect(employeeCodesText(["1", "2", "3"])).toBe("employees 1, 2 and 3");
  });

  it("explains Meta's error codes", () => {
    expect(metaErrorHelp(190)).toContain("WHATSAPP_CLOUD_ACCESS_TOKEN");
    expect(metaErrorHelp(132001)).toContain("not approved");
    expect(metaErrorHelp(1)).toBeNull();
    expect(metaErrorHelp(null)).toBeNull();
  });
});
