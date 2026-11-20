import { describe, expect, it } from "vitest";
import { readSmsOverview, readSmsSettings, readSmsUsage, smsDecimal, smsPercent, thisMonthIst } from "./sms-control";

// Every SMS Control answer is read through a `read…` function, so a server that leaves a key out (an older or a newer build)
// shows "unknown" on the page instead of crashing it, and the answer of 2026-11-20 (status / month / cost / alerts) and the
// older flat one (configured / channel / circuit) both fill it.

/** The overview as sms_control_views.sms_overview answers it (2026-11-20). */
const NEW_OVERVIEW = {
  provider: "twofactor",
  configured: true,
  sendingAllowed: true,
  sendingNote: "This server is set up to send SMS.",
  otpEnabled: true,
  status: {
    configured: true,
    sendingAllowed: true,
    sendingAllowedNow: true,
    otpEnabled: true,
    available: true,
    purposes: { login: true, reset: false, activate: true },
    paused: true,
    pauseReason: "The hourly limit of 300 SMS is used up.",
    devLock: { active: true, onlyToEmployees: ["30020"] },
  },
  env: { authKey: true, senderId: "UKTHRM", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
  balance: { credits: 412, available: 412, checkedAt: "2026-11-20T05:00:00Z", error: null },
  today: { sent: 3, failed: 1, blocked: 2 },
  last7Days: [],
  lastSentAt: "2026-11-20T04:59:00Z",
  limits: { hourlyCap: 300, dailyCap: 1500, hourUsed: 300, dayUsed: 420 },
  circuit: { paused: false, until: null },
  month: {
    month: "2026-11",
    requested: 130,
    sent: 120,
    failed: 6,
    blocked: 4,
    verified: 90,
    deliveryRate: 95.2,
    verifiedRate: 78.3,
  },
  cost: {
    perSms: 0.2,
    soFar: 24,
    projected: 36,
    budget: 30,
    budgetUsedPct: 80,
    projectedBudgetPct: 120,
    currency: "INR",
    isCurrentMonth: true,
  },
  alerts: [
    { level: "warning", code: "hourly_cap_near", message: "300 of the hourly limit of 300 SMS are used." },
    { level: "info", code: "dev_lock", message: "This development machine texts only employee 30020." },
  ],
};

describe("readSmsOverview", () => {
  it("fills in every key of an empty answer, with the safe reading of each", () => {
    const o = readSmsOverview(null);
    expect(o).toMatchObject({
      provider: "twofactor",
      configured: false,
      sendingAllowed: false,
      sendingNote: "",
      otpEnabled: false,
      available: false,
      purposes: null,
      paused: false,
      pauseReason: "",
      pausedUntil: null,
      env: { authKey: false, senderId: "", templateName: "", apiBase: "" },
      balance: { credits: null, checkedAt: null, error: null },
      month: { requested: 0, sent: 0, failed: 0, blocked: 0, verified: 0, deliveryRate: null, verifiedRate: null },
      cost: { perSms: null, soFar: null, projected: null, budget: null, budgetUsedPct: null, currency: "INR" },
      alerts: null,
      today: { sent: 0, failed: 0, blocked: 0 },
      lastSentAt: null,
      limits: null,
      devLock: [],
    });
    expect(o.monthKey).toMatch(/^\d{4}-\d{2}$/);
    expect(readSmsOverview(undefined).otpEnabled).toBe(false);
    expect(readSmsOverview("nonsense").alerts).toBeNull();
  });

  it("reads the answer of 2026-11-20: the status block, the month, the cost, the alerts and the development lock", () => {
    const o = readSmsOverview(NEW_OVERVIEW);
    expect(o.configured).toBe(true);
    expect(o.otpEnabled).toBe(true);
    expect(o.available).toBe(true);
    expect(o.purposes).toEqual({ login: true, reset: false, activate: true });
    expect(o.paused).toBe(true);
    expect(o.pauseReason).toBe("The hourly limit of 300 SMS is used up.");
    expect(o.balance).toEqual({ credits: 412, checkedAt: "2026-11-20T05:00:00Z", error: null });
    expect(o.monthKey).toBe("2026-11");
    expect(o.month).toEqual({
      requested: 130,
      sent: 120,
      failed: 6,
      blocked: 4,
      verified: 90,
      deliveryRate: 95.2,
      verifiedRate: 78.3,
    });
    expect(o.cost).toEqual({ perSms: 0.2, soFar: 24, projected: 36, budget: 30, budgetUsedPct: 80, currency: "INR" });
    expect(o.alerts).toEqual([
      { level: "warning", code: "hourly_cap_near", message: "300 of the hourly limit of 300 SMS are used." },
      { level: "info", code: "dev_lock", message: "This development machine texts only employee 30020." },
    ]);
    expect(o.devLock).toEqual(["30020"]);
    expect(o.limits).toEqual({ hourlyCap: 300, dailyCap: 1500, hourUsed: 300, dayUsed: 420 });
  });

  it("reads an older flat answer: SMS chosen as the channel is SMS codes on, the circuit is the pause", () => {
    const o = readSmsOverview({
      channel: "sms",
      configured: true,
      sendingAllowed: true,
      balance: { available: 12.5, checkedAt: "2026-10-14T06:00:00Z", error: null },
      circuit: { paused: true, until: "2026-10-14T06:10:00Z" },
    });
    expect(o.otpEnabled).toBe(true);
    // no `available` from the server: switched on, set up and allowed to send
    expect(o.available).toBe(true);
    expect(o.paused).toBe(true);
    expect(o.pausedUntil).toBe("2026-10-14T06:10:00Z");
    expect(o.balance.credits).toBe(12.5);
    expect(readSmsOverview({ channel: "whatsapp", configured: true, sendingAllowed: true }).available).toBe(false);
  });

  it("works the rates out from the counts when the server sends none, and caps a stray rate at 100", () => {
    const o = readSmsOverview({ month: { sent: 9, failed: 1, verified: 3 } });
    expect(o.month.deliveryRate).toBe(90);
    expect(o.month.verifiedRate).toBeCloseTo(33.33, 1);
    expect(o.month.requested).toBe(10);
    expect(readSmsOverview({ month: { sent: 1, deliveryRate: 250, verifiedRate: null } }).month).toMatchObject({
      deliveryRate: 100,
      verifiedRate: null,
    });
  });

  it("works the budget share out from the money, and drops a budget of nothing", () => {
    expect(readSmsOverview({ cost: { soFar: 45, budget: 30 } }).cost.budgetUsedPct).toBe(150);
    expect(readSmsOverview({ cost: { soFar: "12.50", budget: "50.00" } }).cost).toMatchObject({
      soFar: 12.5,
      budget: 50,
      budgetUsedPct: 25,
    });
    expect(readSmsOverview({ cost: { soFar: 5, budget: 0 } }).cost).toMatchObject({
      budget: null,
      budgetUsedPct: null,
    });
  });

  it("treats a wrong type as missing, not as a value, and drops an alert without words", () => {
    const o = readSmsOverview({
      otpEnabled: "yes",
      configured: "yes",
      balance: { credits: "lots", checkedAt: 5, error: "" },
      today: { sent: "3", failed: NaN, blocked: -2 },
      alerts: [{ level: "panic", code: "x", message: "Something." }, { level: "error", code: "y" }, null],
      devLock: { onlyToEmployees: [30020, ""] },
    });
    expect(o.otpEnabled).toBe(false);
    expect(o.configured).toBe(false);
    expect(o.balance).toEqual({ credits: null, checkedAt: null, error: null });
    expect(o.today).toEqual({ sent: 0, failed: 0, blocked: 0 });
    expect(o.alerts).toEqual([{ level: "info", code: "x", message: "Something." }]);
    expect(o.devLock).toEqual(["30020"]);
  });
});

describe("readSmsUsage", () => {
  const NOW = new Date("2026-11-20T06:00:00Z");

  it("reads one month as the server sends it", () => {
    const u = readSmsUsage(
      {
        month: "2026-10",
        days: [{ date: "2026-10-01", sent: 4, failed: 1, blocked: 0, verified: 3 }],
        totals: { requested: 5, sent: 4, failed: 1, blocked: 0, verified: 3, deliveryRate: 80, verifiedRate: 75 },
        byPurpose: { login: { sent: 3, failed: 1, blocked: 0, verified: 2 }, reset: { sent: 1, verified: 1 } },
        cost: { perSms: 0.2, soFar: 0.8, projected: 0.8, budget: null, currency: "INR", isCurrentMonth: false },
        balance: { credits: 99, checkedAt: null, error: null },
      },
      "2026-10",
      NOW,
    );
    expect(u.month).toBe("2026-10");
    expect(u.days).toEqual([{ date: "2026-10-01", sent: 4, failed: 1, blocked: 0, verified: 3 }]);
    expect(u.totals).toEqual({
      requested: 5,
      sent: 4,
      failed: 1,
      blocked: 0,
      verified: 3,
      deliveryRate: 80,
      verifiedRate: 75,
    });
    expect(u.byPurpose.login).toEqual({ sent: 3, failed: 1, blocked: 0, verified: 2 });
    expect(u.byPurpose.reset).toEqual({ sent: 1, failed: 0, blocked: 0, verified: 1 });
    expect(u.byPurpose.activate).toEqual({ sent: 0, failed: 0, blocked: 0, verified: 0 });
    expect(u.byPurpose.test).toEqual({ sent: 0, failed: 0, blocked: 0, verified: 0 });
    expect(u.cost).toMatchObject({ perSms: 0.2, soFar: 0.8, budget: null, isCurrentMonth: false });
    expect(u.balance.credits).toBe(99);
  });

  it("adds the totals up from the days when the server leaves them out, and knows this month by itself", () => {
    const u = readSmsUsage(
      {
        days: [
          { date: "2026-11-01", sent: 2, failed: 1, blocked: 1, verified: 1 },
          { date: "2026-11-02", sent: 3, failed: 0, blocked: 0, verified: 2 },
        ],
      },
      "",
      NOW,
    );
    expect(u.month).toBe("2026-11");
    expect(u.totals).toMatchObject({ requested: 7, sent: 5, failed: 1, blocked: 1, verified: 3 });
    expect(u.totals.deliveryRate).toBeCloseTo(83.33, 1);
    expect(u.cost.isCurrentMonth).toBe(true);
    expect(readSmsUsage({}, "2026-09", NOW).cost.isCurrentMonth).toBe(false);
  });
});

describe("readSmsSettings", () => {
  it("reads the document, money written as text too", () => {
    const s = readSmsSettings({
      otpEnabled: true,
      otpLoginEnabled: false,
      otpResetEnabled: true,
      otpActivateEnabled: true,
      otpExpiryMinutes: 7,
      resendCooldownSeconds: 90,
      maxRequestsPerHour: 4,
      maxAttemptsPerCode: 3,
      maxPerPhonePerHour: 6,
      hourlyCap: 200,
      dailyCap: 900,
      pricePerSms: "0.1150",
      monthlyBudget: 500,
      pricePerSmsDefault: 0.2,
      version: "abc",
      updatedAt: "2026-11-20T05:00:00Z",
      updatedBy: "Asha",
      warnings: ["One.", 5, ""],
    });
    expect(s).toEqual({
      otpEnabled: true,
      otpLoginEnabled: false,
      otpResetEnabled: true,
      otpActivateEnabled: true,
      otpExpiryMinutes: 7,
      resendCooldownSeconds: 90,
      maxRequestsPerHour: 4,
      maxAttemptsPerCode: 3,
      maxPerPhonePerHour: 6,
      hourlyCap: 200,
      dailyCap: 900,
      pricePerSms: 0.115,
      pricePerSmsDefault: 0.2,
      monthlyBudget: 500,
      version: "abc",
      updatedAt: "2026-11-20T05:00:00Z",
      updatedBy: "Asha",
      warnings: ["One."],
    });
  });

  it("fills the defaults of a new installation, and reads the old channel as the SMS switch", () => {
    const s = readSmsSettings({ otpChannel: "sms" });
    expect(s.otpEnabled).toBe(true);
    expect(s).toMatchObject({ otpLoginEnabled: true, hourlyCap: 300, dailyCap: 1500, pricePerSms: null, version: "" });
    expect(readSmsSettings({}).otpEnabled).toBe(false);
    expect(readSmsSettings({ monthlyBudget: 0 }).monthlyBudget).toBeNull();
  });
});

describe("the small readers", () => {
  it("reads a decimal written as a number or as text, and nothing else", () => {
    expect(smsDecimal(0.2)).toBe(0.2);
    expect(smsDecimal("0.2000")).toBe(0.2);
    expect(smsDecimal(" 12 ")).toBe(12);
    expect(smsDecimal("1e3")).toBeNull();
    expect(smsDecimal(Infinity)).toBeNull();
    expect(smsDecimal(null)).toBeNull();
  });

  it("works a percentage out, null for nothing to divide", () => {
    expect(smsPercent(1, 4)).toBe(25);
    expect(smsPercent(5, 4)).toBe(100);
    expect(smsPercent(1, 0)).toBeNull();
  });

  it("knows the month in India: just after midnight IST is already the next month", () => {
    expect(thisMonthIst(new Date("2026-11-30T18:29:00Z"))).toBe("2026-11");
    expect(thisMonthIst(new Date("2026-11-30T18:31:00Z"))).toBe("2026-12");
  });
});
