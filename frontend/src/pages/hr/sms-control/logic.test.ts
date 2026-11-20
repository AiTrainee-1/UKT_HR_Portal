import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { readSmsOverview, type SmsOverview, type SmsSettings } from "@/lib/api-client/custom-hooks";
import {
  BRANCH_ONLY_TEXT,
  CODES_ONLY_TEXT,
  DEFAULT_PRICE_PER_SMS,
  ENV_VARS,
  INDEPENDENT_TEXT,
  LIMIT_RULES,
  NUMERIC_KEYS,
  SWITCH_KEYS,
  SWITCH_RULES,
  TEST_CODE,
  TWOFACTOR_TEMPLATE_TEXT,
  alertLink,
  budgetState,
  buildInput,
  chartRows,
  codesText,
  costExample,
  daysInMonth,
  derivedAlerts,
  draftFrom,
  failureText,
  formatPct,
  formatRupees,
  heroState,
  hidePhone,
  isMonth,
  limitsAdvice,
  missingEnv,
  monthLabel,
  monthOptions,
  normalizeMobile,
  overviewAlerts,
  parseRupees,
  parseWhole,
  pickMonth,
  projectMonth,
  sectionDirty,
  shiftMonth,
  switchOnBlockedReason,
  switchesAdvice,
  templatePreview,
  thisMonth,
  usage,
  validateCost,
  validateLimits,
  withSection,
  type SettingsDraft,
} from "./logic";

const SETTINGS: SmsSettings = {
  otpEnabled: false,
  otpLoginEnabled: true,
  otpResetEnabled: true,
  otpActivateEnabled: false,
  otpExpiryMinutes: 5,
  resendCooldownSeconds: 60,
  maxRequestsPerHour: 5,
  maxAttemptsPerCode: 5,
  maxPerPhonePerHour: 5,
  hourlyCap: 300,
  dailyCap: 1500,
  pricePerSms: 0.2,
  pricePerSmsDefault: 0.2,
  monthlyBudget: null,
  version: "v1",
  updatedAt: null,
  updatedBy: null,
  warnings: [],
};

/** An overview of a server where everything works, changed by `patch`. */
const overview = (patch: Record<string, unknown> = {}): SmsOverview =>
  readSmsOverview({
    configured: true,
    sendingAllowed: true,
    otpEnabled: true,
    status: { available: true, paused: false, pauseReason: null },
    env: { authKey: true, senderId: "UKTHRM", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
    balance: { credits: 500, checkedAt: null, error: null },
    month: { month: "2026-11", sent: 10, failed: 0, blocked: 0, verified: 8 },
    cost: { perSms: 0.2, soFar: 2, projected: 3, budget: null },
    limits: { hourlyCap: 300, dailyCap: 1500, hourUsed: 1, dayUsed: 10 },
    today: { sent: 1, failed: 0, blocked: 0 },
    ...patch,
  });

describe("the settings, as words and rules", () => {
  it("has the seven limits with the server's ranges, and three switches for the three purposes", () => {
    expect(NUMERIC_KEYS).toEqual([
      "otpExpiryMinutes",
      "resendCooldownSeconds",
      "maxRequestsPerHour",
      "maxAttemptsPerCode",
      "maxPerPhonePerHour",
      "hourlyCap",
      "dailyCap",
    ]);
    const ranges = Object.fromEntries(LIMIT_RULES.map((r) => [r.key, [r.min, r.max, r.default]]));
    expect(ranges).toEqual({
      otpExpiryMinutes: [1, 15, 5],
      resendCooldownSeconds: [30, 600, 60],
      maxRequestsPerHour: [1, 20, 5],
      maxAttemptsPerCode: [3, 5, 5],
      maxPerPhonePerHour: [1, 20, 5],
      hourlyCap: [1, 10000, 300],
      dailyCap: [1, 10000, 1500],
    });
    expect(SWITCH_RULES.map((r) => [r.key, r.purposeKey])).toEqual([
      ["otpLoginEnabled", "login"],
      ["otpResetEnabled", "reset"],
      ["otpActivateEnabled", "activate"],
    ]);
    for (const rule of LIMIT_RULES) expect(rule.example(rule.default), rule.key).not.toBe("");
  });

  it("says plainly that SMS is for codes only and that WhatsApp codes do not depend on it", () => {
    expect(CODES_ONLY_TEXT).toMatch(/only for one-time sign-in codes/);
    expect(CODES_ONLY_TEXT).toMatch(/No promotional, bulk or other SMS/);
    expect(INDEPENDENT_TEXT).toMatch(/WhatsApp Control/);
    expect(INDEPENDENT_TEXT).toMatch(/Either one is enough/);
  });
});

describe("the draft and the save", () => {
  const saved = draftFrom(SETTINGS);

  it("starts from what is saved: numbers and money as text", () => {
    expect(saved).toMatchObject({
      otpEnabled: false,
      otpLoginEnabled: true,
      otpActivateEnabled: false,
      otpExpiryMinutes: "5",
      hourlyCap: "300",
      pricePerSms: "0.2",
      monthlyBudget: "",
    });
  });

  it("knows which section has changes, money by its value", () => {
    const draft: SettingsDraft = { ...saved, otpEnabled: true };
    expect(sectionDirty("switches", draft, saved)).toBe(true);
    expect(sectionDirty("limits", draft, saved)).toBe(false);
    expect(sectionDirty("cost", { ...saved, pricePerSms: "0.20" }, saved)).toBe(false);
    expect(sectionDirty("cost", { ...saved, pricePerSms: "₹ 0.2" }, saved)).toBe(false);
    expect(sectionDirty("cost", { ...saved, pricePerSms: "0.25" }, saved)).toBe(true);
    expect(sectionDirty("cost", { ...saved, monthlyBudget: "500" }, saved)).toBe(true);
    expect(sectionDirty("cost", { ...saved, monthlyBudget: "abc" }, saved)).toBe(true);
    // a discard takes one section back and leaves the others as typed
    const both: SettingsDraft = { ...draft, hourlyCap: "100" };
    const back = withSection("switches", both, saved);
    expect(back.otpEnabled).toBe(false);
    expect(back.hourlyCap).toBe("100");
  });

  it("sends only the fields of the section being saved, and the version it started from", () => {
    const draft: SettingsDraft = {
      ...saved,
      otpEnabled: true,
      otpActivateEnabled: true,
      hourlyCap: "200",
      pricePerSms: "0.115",
      monthlyBudget: "₹1,500",
    };
    expect(buildInput(draft, "switches", "v1")).toEqual({
      otpEnabled: true,
      otpLoginEnabled: true,
      otpResetEnabled: true,
      otpActivateEnabled: true,
      expectedVersion: "v1",
    });
    expect(buildInput(draft, "limits", "v1", SETTINGS)).toEqual({
      otpExpiryMinutes: 5,
      resendCooldownSeconds: 60,
      maxRequestsPerHour: 5,
      maxAttemptsPerCode: 5,
      maxPerPhonePerHour: 5,
      hourlyCap: 200,
      dailyCap: 1500,
      expectedVersion: "v1",
    });
    expect(buildInput(draft, "cost", undefined)).toEqual({ pricePerSms: 0.115, monthlyBudget: 1500 });
    // an empty box is "the default price" / "no budget": null
    expect(buildInput({ ...draft, pricePerSms: "", monthlyBudget: " " }, "cost", "v2")).toEqual({
      pricePerSms: null,
      monthlyBudget: null,
      expectedVersion: "v2",
    });
    // the retired channel is never sent
    for (const section of ["switches", "limits", "cost"] as const) {
      expect(buildInput(draft, section, "v1", SETTINGS)).not.toHaveProperty("otpChannel");
    }
  });

  it("checks the limits before a save, the hourly cap against the daily one too", () => {
    expect(validateLimits(saved).first).toBeNull();
    const bad = validateLimits({ ...saved, otpExpiryMinutes: "16", maxAttemptsPerCode: "6" });
    expect(bad.errors.otpExpiryMinutes).toBe("Enter a whole number from 1 to 15.");
    expect(bad.errors.maxAttemptsPerCode).toBe("Enter a whole number from 3 to 5.");
    expect(bad.first).toBe("How long a code works: Enter a whole number from 1 to 15.");
    expect(validateLimits({ ...saved, hourlyCap: "900", dailyCap: "800" }).errors.dailyCap).toBe(
      "The daily cap cannot be lower than the hourly cap (900).",
    );
    expect(parseWhole(" 12 ")).toBe(12);
    expect(parseWhole("5.5")).toBeNull();
    expect(parseWhole("-3")).toBeNull();
    expect(limitsAdvice({ ...saved, resendCooldownSeconds: "600", maxRequestsPerHour: "10" })).toHaveLength(1);
    expect(limitsAdvice(saved)).toEqual([]);
  });

  it("checks the price and the budget", () => {
    expect(validateCost(saved).first).toBeNull();
    expect(validateCost({ pricePerSms: "", monthlyBudget: "" }).first).toBeNull();
    expect(validateCost({ pricePerSms: "101", monthlyBudget: "" }).errors.pricePerSms).toMatch(/from 0 to 100/);
    expect(validateCost({ pricePerSms: "0.12345", monthlyBudget: "" }).errors.pricePerSms).toMatch(/4 decimals/);
    expect(validateCost({ pricePerSms: "-1", monthlyBudget: "" }).first).toMatch(/^Price per SMS: /);
    expect(validateCost({ pricePerSms: "0.2", monthlyBudget: "12.345" }).errors.monthlyBudget).toBe(
      "A budget has at most 2 decimals (paise).",
    );
    expect(validateCost({ pricePerSms: "0.2", monthlyBudget: "lots" }).first).toMatch(/^Monthly budget: /);
    expect(parseRupees("₹ 1,500.50")).toBe(1500.5);
    expect(parseRupees("Rs. 20")).toBe(20);
    expect(parseRupees("  ")).toBe("");
    expect(parseRupees("1e3")).toBeNull();
  });

  it("warns when SMS codes are on but every use is off, and only then", () => {
    const allOff = { ...saved, otpLoginEnabled: false, otpResetEnabled: false, otpActivateEnabled: false };
    expect(switchesAdvice({ ...allOff, otpEnabled: true })).toHaveLength(1);
    expect(switchesAdvice(allOff)).toEqual([]);
    expect(switchesAdvice({ ...saved, otpEnabled: true })).toEqual([]);
    expect(SWITCH_KEYS).toHaveLength(3);
  });

  it("refuses to switch SMS codes on before 2Factor is set up, never to switch them off", () => {
    expect(switchOnBlockedReason(false, false)).toMatch(/cannot be switched on yet: 2Factor is not set up/);
    expect(switchOnBlockedReason(false, true)).toBeNull();
    expect(switchOnBlockedReason(true, false)).toBeNull();
    // not known yet (the overview is still loading): the server decides
    expect(switchOnBlockedReason(null, false)).toBeNull();
  });

  it("puts a refusal in the server's own words, else in plain ones", () => {
    const refused = (status: number, body: unknown) =>
      new ApiError(new Response(JSON.stringify(body), { status }), body, { method: "PATCH", url: "/x" });
    expect(failureText(refused(400, { error: "Price per SMS must be a number." }), "save")).toBe(
      "Price per SMS must be a number.",
    );
    expect(failureText(refused(403, { error: "permission_denied" }), "save the SMS settings")).toBe(
      "Your login is not allowed to save the SMS settings.",
    );
    expect(failureText(refused(429, {}), "send")).toBe("Too many tries. Wait a little and try again.");
    expect(failureText(new Error("offline"), "send the test code")).toBe(
      "Could not send the test code. Check the connection and try again.",
    );
    expect(BRANCH_ONLY_TEXT).toMatch(/company-wide/);
  });
});

describe("money", () => {
  it("writes rupees the Indian way, a price per SMS with up to 4 decimals", () => {
    expect(formatRupees(1234.5)).toBe("₹1,234.50");
    expect(formatRupees(123456)).toBe("₹1,23,456.00");
    expect(formatRupees(0.115, true)).toBe("₹0.115");
    expect(formatRupees(0.2, true)).toBe("₹0.20");
    expect(formatRupees(null)).toBe("—");
    expect(costExample(0.2)).toBe("1,000 SMS codes at ₹0.20 each cost ₹200.00.");
    expect(DEFAULT_PRICE_PER_SMS).toBe(0.2);
  });

  it("says how the month stands against the budget, and whether the pace passes it", () => {
    expect(budgetState({ soFar: 10, projected: 20, budget: null, budgetUsedPct: null })).toMatchObject({
      level: "none",
      barPct: null,
    });
    expect(budgetState({ soFar: 10, projected: 20, budget: 100, budgetUsedPct: 10 })).toEqual({
      level: "ok",
      barPct: 10,
      usedPct: 10,
      projectedOver: false,
      overBy: 0,
    });
    expect(budgetState({ soFar: 85, projected: 120, budget: 100, budgetUsedPct: 85 })).toMatchObject({
      level: "near",
      projectedOver: true,
      overBy: 20,
    });
    expect(budgetState({ soFar: 150, projected: 150, budget: 100, budgetUsedPct: 150 })).toMatchObject({
      level: "over",
      barPct: 100,
      usedPct: 150,
    });
  });

  it("projects the current month at its pace, and leaves a past month as it is", () => {
    const now = new Date("2026-11-10T06:00:00Z"); // the 10th, India time
    expect(projectMonth(10, "2026-11", now)).toBe(30);
    expect(projectMonth(10, "2026-10", now)).toBe(10);
  });

  it("writes a percentage with one decimal under 10%", () => {
    expect(formatPct(95.24)).toBe("95%");
    expect(formatPct(4.56)).toBe("4.6%");
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(null)).toBe("—");
  });
});

describe("months", () => {
  const NOW = new Date("2026-11-20T06:00:00Z");

  it("knows the month in India, steps between months, and names them", () => {
    expect(thisMonth(NOW)).toBe("2026-11");
    expect(thisMonth(new Date("2026-11-30T19:00:00Z"))).toBe("2026-12");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(isMonth("2026-13")).toBe(false);
  });

  it("offers this month and the eleven before it, and turns a bad or future month into this one", () => {
    const options = monthOptions(NOW);
    expect(options).toHaveLength(12);
    expect(options[0]).toBe("2026-11");
    expect(options[11]).toBe("2025-12");
    expect(pickMonth("2026-10", NOW)).toBe("2026-10");
    expect(pickMonth("2027-01", NOW)).toBe("2026-11");
    expect(pickMonth("nope", NOW)).toBe("2026-11");
    expect(pickMonth("", NOW)).toBe("2026-11");
  });

  it("gives the chart one row per day: to today for this month, the whole of a past one", () => {
    const rows = chartRows("2026-11", [{ date: "2026-11-03", sent: 4, failed: 1, blocked: 2, verified: 3 }], NOW);
    expect(rows).toHaveLength(20);
    expect(rows[2]).toMatchObject({ date: "2026-11-03", day: "3", sent: 4, total: 7, verified: 3 });
    expect(rows[0]).toMatchObject({ date: "2026-11-01", total: 0 });
    expect(chartRows("2026-10", [], NOW)).toHaveLength(31);
    expect(chartRows("bad", [], NOW)).toEqual([]);
  });
});

describe("the status line", () => {
  it("says off, not set up, not sending, paused, not offered or working, in that order of weight", () => {
    expect(heroState(overview({ otpEnabled: false })).id).toBe("off");
    expect(heroState(overview({ configured: false })).id).toBe("not-configured");
    expect(
      heroState(overview({ sendingAllowed: false, sendingNote: "A development machine never sends." })),
    ).toMatchObject({ id: "not-sending", tone: "warn", detail: "A development machine never sends." });
    const paused = heroState(
      overview({ status: { available: true, paused: true, pauseReason: "The hourly limit of 300 SMS is used up." } }),
    );
    expect(paused.id).toBe("paused");
    expect(paused.detail).toMatch(/^The hourly limit of 300 SMS is used up\. It starts again by itself/);
    expect(heroState(overview({ status: { available: false } })).id).toBe("unavailable");
    expect(heroState(overview())).toMatchObject({ id: "working", tone: "good", badge: "Available" });
  });
});

describe("what needs attention", () => {
  it("uses the server's alerts when it sends them, with a link to where each is dealt with, most serious first", () => {
    const items = overviewAlerts(
      overview({
        alerts: [
          { level: "info", code: "dev_lock", message: "This development machine texts only employee 30020." },
          { level: "warning", code: "budget_projected", message: "At this pace the month ends over budget." },
          { level: "error", code: "not_configured", message: "2Factor is not set up." },
          { level: "warning", code: "balance_low", message: "Only 40 SMS credits are left." },
        ],
      }),
    );
    expect(items.map((a) => [a.id, a.tone, a.to ?? null])).toEqual([
      ["not_configured", "bad", "/hr/sms-control/setup"],
      ["budget_projected", "warn", "/hr/sms-control/settings/cost"],
      ["balance_low", "warn", null],
      ["dev_lock", "info", "/hr/sms-control/test"],
    ]);
    expect(overviewAlerts(overview({ alerts: [] }))).toEqual([]);
  });

  it("links every alert code the server knows", () => {
    expect(alertLink("otp_off")?.to).toBe("/hr/sms-control/settings/switches");
    expect(alertLink("all_switches_off")?.to).toBe("/hr/sms-control/settings/switches");
    expect(alertLink("hourly_cap_near")?.to).toBe("/hr/sms-control/settings/limits");
    expect(alertLink("daily_cap_near")?.to).toBe("/hr/sms-control/settings/limits");
    expect(alertLink("budget_exceeded")?.to).toBe("/hr/sms-control/settings/cost");
    expect(alertLink("failures")?.to).toBe("/hr/sms-control/messages?status=failed");
    expect(alertLink("sending_blocked")?.to).toBe("/hr/sms-control/setup");
    expect(alertLink("paused")?.to).toBe("/hr/sms-control/messages");
    expect(alertLink("balance_unknown")).toBeUndefined();
    // a code this page does not know yet is read from its words
    expect(alertLink("monthly_budget_new")?.to).toBe("/hr/sms-control/settings/cost");
    expect(alertLink("something_else")).toBeUndefined();
  });

  it("works the same checks out itself for an older server that sends no list", () => {
    const old = overview({ alerts: undefined });
    expect(old.alerts).toBeNull();
    expect(overviewAlerts(old)).toEqual([]);
    const ids = (o: SmsOverview) => derivedAlerts(o).map((a) => a.id);
    expect(ids(overview({ configured: false, env: { authKey: false } }))).toEqual(["not_configured"]);
    expect(derivedAlerts(overview({ configured: false, env: { authKey: false } }))[0].message).toMatch(
      /Not set: TWOFACTOR_API_KEY, TWOFACTOR_TEMPLATE_NAME, TWOFACTOR_SENDER_ID/,
    );
    expect(ids(overview({ sendingAllowed: false }))).toEqual(["sending_blocked"]);
    expect(ids(overview({ balance: { credits: 40 } }))).toEqual(["balance_low"]);
    expect(ids(overview({ cost: { soFar: 120, projected: 150, budget: 100 } }))).toEqual(["budget_over"]);
    expect(ids(overview({ cost: { soFar: 50, projected: 150, budget: 100 } }))).toEqual(["budget_near"]);
    expect(ids(overview({ limits: { hourlyCap: 10, dailyCap: 100, hourUsed: 10, dayUsed: 85 } }))).toEqual([
      "cap_hour",
      "cap_day",
    ]);
    expect(ids(overview({ today: { sent: 1, failed: 2, blocked: 0 } }))).toEqual(["failed_today"]);
  });
});

describe("2Factor's values and the test", () => {
  it("names the environment values, the key as a secret, and never asks for a value", () => {
    expect(ENV_VARS.map((v) => v.name)).toEqual([
      "TWOFACTOR_API_KEY",
      "TWOFACTOR_TEMPLATE_NAME",
      "TWOFACTOR_SENDER_ID",
      "TWOFACTOR_API_BASE",
      "SMS_ALLOW_SENDING",
      "SMS_ONLY_TO_EMPLOYEES",
    ]);
    expect(ENV_VARS.find((v) => v.name === "TWOFACTOR_API_KEY")).toMatchObject({ secret: true, example: "" });
    expect(missingEnv({ env: { authKey: true, senderId: "", templateName: "X", apiBase: "" } })).toEqual([
      "TWOFACTOR_SENDER_ID",
    ]);
  });

  it("previews the OTP template with the 4-digit test code", () => {
    expect(TEST_CODE).toBe("1234");
    expect(TWOFACTOR_TEMPLATE_TEXT.match(/XXXX/g)).toHaveLength(1);
    expect(templatePreview(TEST_CODE)).toBe(
      "1234 is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.",
    );
  });

  it("reads a mobile number typed in any common way, and hides all but its last four digits", () => {
    for (const typed of ["9876543210", "+91 98765 43210", "919876543210", "09876543210", "98765-43210"]) {
      expect(normalizeMobile(typed), typed).toEqual({ ok: true, phone: "9876543210" });
    }
    for (const typed of ["12345", "5876543210", "abc", ""]) expect(normalizeMobile(typed).ok, typed).toBe(false);
    expect(hidePhone("9876543210")).toBe("••••••3210");
  });

  it("lists employee codes in words", () => {
    expect(codesText([])).toBe("");
    expect(codesText(["30020"])).toBe("30020");
    expect(codesText(["1", "2", "3"])).toBe("1, 2 and 3");
  });

  it("measures a cap", () => {
    expect(usage(0, 0)).toEqual({ pct: 0, level: "none" });
    expect(usage(79, 100).level).toBe("ok");
    expect(usage(80, 100).level).toBe("near");
    expect(usage(120, 100)).toEqual({ pct: 100, level: "full" });
  });
});
