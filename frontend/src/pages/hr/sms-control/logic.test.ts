import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { SmsOverview, SmsSettings } from "@/lib/api-client/custom-hooks";
import {
  TWOFACTOR_SENDER_ID,
  TWOFACTOR_TEMPLATE_NAME,
  TWOFACTOR_TEMPLATE_TEXT,
  STATUS_HELP,
  templatePreview,
  ENV_VARS,
  LIMIT_RULES,
  LOW_BALANCE,
  balanceState,
  buildInput,
  chartBars,
  dayLabel,
  draftFrom,
  failureText,
  formatClock,
  formatNumber,
  formatWhen,
  limitsAdvice,
  missingEnv,
  nextSteps,
  normalizeMobile,
  parseWhole,
  purposeLabel,
  sectionDirty,
  serverSentence,
  switchesAdvice,
  usage,
  validateLimits,
  withSection,
} from "./logic";

const OVERVIEW: SmsOverview = {
  provider: "twofactor",
  channel: "sms",
  configured: true,
  sendingAllowed: true,
  sendingNote: "",
  env: { authKey: true, senderId: "UKTHRM", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
  balance: { available: 1500, checkedAt: "2026-10-14T06:00:00Z", error: null },
  today: { sent: 10, failed: 0, blocked: 0 },
  last7Days: [],
  lastSentAt: "2026-10-14T05:30:00Z",
  limits: { hourlyCap: 100, dailyCap: 500, hourUsed: 10, dayUsed: 40 },
  circuit: { paused: false, until: null },
};
const SERVER_NOTE =
  "2Factor documents no balance check this system can use safely. Look at the balance in the 2Factor panel .";
const SERVER_EMPTY_NOTE =
  "2Factor refused the last message because the account has no balance. Top it up in the 2Factor panel.";
const overview = (patch: Partial<SmsOverview> = {}): SmsOverview => ({ ...OVERVIEW, ...patch });
const ids = (o: SmsOverview) => nextSteps(o).map((s) => s.id);
const step = (o: SmsOverview, id: string) => nextSteps(o).find((s) => s.id === id);

const SETTINGS: SmsSettings = {
  otpChannel: "whatsapp",
  otpLoginEnabled: true,
  otpResetEnabled: true,
  otpActivateEnabled: false,
  otpExpiryMinutes: 5,
  resendCooldownSeconds: 60,
  maxRequestsPerHour: 5,
  maxAttemptsPerCode: 5,
  maxPerPhonePerHour: 5,
  hourlyCap: 100,
  dailyCap: 500,
  version: "abc123",
  updatedAt: null,
  updatedBy: null,
  warnings: [],
};

describe("the seven limits", () => {
  it("carry the ranges and defaults of the specification", () => {
    const by = Object.fromEntries(LIMIT_RULES.map((r) => [r.key, [r.min, r.max, r.default]]));
    expect(by).toEqual({
      otpExpiryMinutes: [1, 15, 5],
      resendCooldownSeconds: [30, 600, 60],
      maxRequestsPerHour: [1, 20, 5],
      maxAttemptsPerCode: [3, 10, 5],
      maxPerPhonePerHour: [1, 20, 5],
      hourlyCap: [1, 10000, 300],
      dailyCap: [1, 10000, 1500],
    });
  });

  it("every one explains itself: a purpose, what changes, and an example that follows the number", () => {
    for (const rule of LIMIT_RULES) {
      expect(rule.purpose.length, rule.key).toBeGreaterThan(30);
      expect(rule.affects.length, rule.key).toBeGreaterThan(0);
      expect(rule.example(rule.default), rule.key).not.toBe(rule.example(rule.max));
    }
  });

  it("works the examples out from the typed number", () => {
    const rule = (key: string) => LIMIT_RULES.find((r) => r.key === key)!;
    expect(rule("otpExpiryMinutes").example(7)).toContain("10:07");
    expect(rule("resendCooldownSeconds").example(90)).toContain("10:01:30");
    expect(rule("maxRequestsPerHour").example(1)).toContain("1 code ");
    expect(rule("maxAttemptsPerCode").example(3)).toContain("3 wrong tries");
    expect(rule("hourlyCap").example(2500)).toContain("2,500");
  });
});

describe("parseWhole", () => {
  it("reads a whole number and nothing else", () => {
    expect(parseWhole("5")).toBe(5);
    expect(parseWhole(" 12 ")).toBe(12);
    expect(parseWhole("0")).toBe(0);
    for (const bad of ["", "  ", "5.5", "-3", "abc", "1e3", "5 6", "1234567890"])
      expect(parseWhole(bad), bad).toBeNull();
  });
});

describe("validateLimits", () => {
  const draft = () => draftFrom(SETTINGS);

  it("accepts the saved numbers", () => {
    expect(validateLimits(draft())).toEqual({ errors: {}, first: null });
  });

  it("refuses each number outside its range, and says which one and what is allowed", () => {
    for (const rule of LIMIT_RULES) {
      for (const bad of [String(rule.min - 1), String(rule.max + 1), "", "x"]) {
        const d = { ...draft(), [rule.key]: bad };
        const v = validateLimits(d);
        expect(v.errors[rule.key], `${rule.key} ${JSON.stringify(bad)}`).toMatch(/^Enter a whole number from /);
        expect(v.first, rule.key).toContain(rule.label);
      }
      // (the two caps are checked against each other too: give them room so only the range is being tried)
      const roomy = { ...draft(), hourlyCap: "1", dailyCap: "10000" };
      for (const good of [String(rule.min), String(rule.max)]) {
        expect(validateLimits({ ...roomy, [rule.key]: good }).errors[rule.key], `${rule.key} ${good}`).toBeUndefined();
      }
    }
  });

  it("refuses an hourly cap above the daily cap, as the server does, on the daily cap's box", () => {
    const v = validateLimits({ ...draftFrom(SETTINGS), hourlyCap: "600", dailyCap: "500" });
    expect(v.errors).toEqual({ dailyCap: "The daily cap cannot be lower than the hourly cap (600)." });
    expect(v.first).toBe(
      "SMS cap for the whole company, per day: The daily cap cannot be lower than the hourly cap (600).",
    );
    // equal is allowed; and a box with its own problem is not also blamed for the pair
    expect(validateLimits({ ...draftFrom(SETTINGS), hourlyCap: "500", dailyCap: "500" }).first).toBeNull();
    expect(validateLimits({ ...draftFrom(SETTINGS), hourlyCap: "600", dailyCap: "" }).errors.dailyCap).toMatch(
      /^Enter a whole number/,
    );
  });

  it("reports the first problem in the order the boxes are shown", () => {
    const v = validateLimits({ ...draft(), dailyCap: "0", otpExpiryMinutes: "99" });
    expect(Object.keys(v.errors).sort()).toEqual(["dailyCap", "otpExpiryMinutes"]);
    expect(v.first).toContain("How long a code works");
  });
});

describe("advice that never blocks", () => {
  it("has nothing to say about the saved numbers", () => {
    expect(limitsAdvice(draftFrom(SETTINGS))).toEqual([]);
  });

  it("notes a wait that makes the hourly allowance unreachable", () => {
    const advice = limitsAdvice({ ...draftFrom(SETTINGS), resendCooldownSeconds: "600", maxRequestsPerHour: "20" });
    expect(advice.join(" ")).toContain("never use all the codes");
  });

  it("is silent about numbers that are not numbers yet", () => {
    expect(limitsAdvice({ ...draftFrom(SETTINGS), dailyCap: "", hourlyCap: "x" })).toEqual([]);
  });

  it("warns when all three switches are off", () => {
    const all = { ...draftFrom(SETTINGS), otpLoginEnabled: false, otpResetEnabled: false, otpActivateEnabled: false };
    expect(switchesAdvice(all)[0]).toContain("nobody can get a code");
    expect(switchesAdvice({ ...all, otpResetEnabled: true })).toEqual([]);
  });
});

describe("drafts and saves", () => {
  it("turns what is saved into a draft with the numbers as text", () => {
    const d = draftFrom(SETTINGS);
    expect(d.otpChannel).toBe("whatsapp");
    expect(d.otpActivateEnabled).toBe(false);
    expect(d.otpExpiryMinutes).toBe("5");
    expect(d.dailyCap).toBe("500");
  });

  it("knows which section changed", () => {
    const saved = draftFrom(SETTINGS);
    const edited = { ...saved, hourlyCap: "150" };
    expect(sectionDirty("limits", edited, saved)).toBe(true);
    expect(sectionDirty("channel", edited, saved)).toBe(false);
    expect(sectionDirty("switches", edited, saved)).toBe(false);
    expect(sectionDirty("channel", { ...saved, otpChannel: "sms" }, saved)).toBe(true);
    expect(sectionDirty("switches", { ...saved, otpLoginEnabled: false }, saved)).toBe(true);
  });

  it("takes one section from another draft and leaves the rest", () => {
    const saved = draftFrom(SETTINGS);
    const edited = { ...saved, otpChannel: "sms" as const, hourlyCap: "150" };
    const next = withSection("limits", edited, saved);
    expect(next.hourlyCap).toBe("100");
    expect(next.otpChannel).toBe("sms");
  });

  it("sends the SAVED values with only the saved-section's fields taken from the draft, plus the version", () => {
    const draft = {
      ...draftFrom(SETTINGS),
      otpChannel: "sms" as const,
      otpLoginEnabled: false,
      otpExpiryMinutes: "9",
      dailyCap: "800",
    };
    expect(buildInput(SETTINGS, draft, "limits", "abc123")).toEqual({
      otpChannel: "whatsapp",
      otpLoginEnabled: true,
      otpResetEnabled: true,
      otpActivateEnabled: false,
      otpExpiryMinutes: 9,
      resendCooldownSeconds: 60,
      maxRequestsPerHour: 5,
      maxAttemptsPerCode: 5,
      maxPerPhonePerHour: 5,
      hourlyCap: 100,
      dailyCap: 800,
      expectedVersion: "abc123",
    });
    expect(buildInput(SETTINGS, draft, "channel", "abc123").otpChannel).toBe("sms");
    expect(buildInput(SETTINGS, draft, "channel", "abc123").otpExpiryMinutes).toBe(5);
    const sw = buildInput(SETTINGS, draft, "switches", undefined);
    expect(sw.otpLoginEnabled).toBe(false);
    expect(sw.dailyCap).toBe(500);
    expect("expectedVersion" in sw).toBe(false);
  });

  it("never sends the read-only keys", () => {
    const input = buildInput(SETTINGS, draftFrom(SETTINGS), "channel", "abc123");
    for (const key of ["version", "updatedAt", "updatedBy", "warnings"]) expect(key in input).toBe(false);
  });
});

describe("what the server said", () => {
  const refusal = (status: number, body: unknown) =>
    new ApiError(new Response(JSON.stringify(body), { status }), body, { method: "PUT", url: "/x" });

  it("reads the one-sentence explanation, from message, error or detail", () => {
    expect(serverSentence(refusal(400, { error: "Expiry must be from 1 to 15." }))).toBe(
      "Expiry must be from 1 to 15.",
    );
    expect(serverSentence(refusal(400, { message: "A message." }))).toBe("A message.");
    expect(serverSentence(refusal(400, { detail: "A detail." }))).toBe("A detail.");
    expect(serverSentence(refusal(403, { error: "permission_denied" }))).toBeNull();
    expect(serverSentence(new Error("boom"))).toBeNull();
  });

  it("falls back to words an HR manager can act on", () => {
    expect(failureText(refusal(400, { error: "Too low." }), "save")).toBe("Too low.");
    expect(failureText(refusal(403, { error: "permission_denied" }), "save the SMS settings")).toContain("not allowed");
    expect(failureText(refusal(429, {}), "send the test SMS")).toContain("Too many tries");
    expect(failureText(new Error("network"), "send the test SMS")).toBe(
      "Could not send the test SMS. Check the connection and try again.",
    );
  });
});

describe("the 2Factor values", () => {
  it("lists every environment value, the three required ones first", () => {
    expect(ENV_VARS.map((v) => v.name)).toEqual([
      "TWOFACTOR_API_KEY",
      "TWOFACTOR_TEMPLATE_NAME",
      "TWOFACTOR_SENDER_ID",
      "TWOFACTOR_API_BASE",
      "SMS_ALLOW_SENDING",
    ]);
    expect(ENV_VARS.filter((v) => v.required).map((v) => v.name)).toEqual([
      "TWOFACTOR_API_KEY",
      "TWOFACTOR_TEMPLATE_NAME",
      "TWOFACTOR_SENDER_ID",
    ]);
    // nothing in the examples is a real key
    for (const v of ENV_VARS) expect(v.example).not.toMatch(/[0-9a-f]{20,}/i);
  });

  it("the template follows 2Factor's rules: XXXX once, under 150 characters, and the owner's text", () => {
    expect(TWOFACTOR_TEMPLATE_TEXT).toBe(
      "XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.",
    );
    expect(TWOFACTOR_TEMPLATE_TEXT.split("XXXX")).toHaveLength(2);
    expect(TWOFACTOR_TEMPLATE_TEXT.length).toBeLessThan(150);
    expect(TWOFACTOR_TEMPLATE_NAME).toBe("UKT_HRMS_OTP");
    expect(TWOFACTOR_SENDER_ID).toBe("UKTHRM");
    expect(templatePreview("123456")).toBe(
      "123456 is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.",
    );
  });

  it("names what is missing, by name", () => {
    expect(missingEnv(OVERVIEW)).toEqual([]);
    expect(missingEnv(overview({ env: { ...OVERVIEW.env, authKey: false, templateName: "" } }))).toEqual([
      "TWOFACTOR_API_KEY",
      "TWOFACTOR_TEMPLATE_NAME",
    ]);
  });

  it("names the one provider in the status words", () => {
    expect(STATUS_HELP.sent).toBe("2Factor accepted the message");
    expect(STATUS_HELP.failed).toBe("it could not be handed to 2Factor");
  });
});

describe("usage against a cap", () => {
  it("is comfortable, close at 80%, full at the cap, and nothing without a cap", () => {
    expect(usage(10, 100)).toEqual({ pct: 10, level: "ok" });
    expect(usage(79, 100).level).toBe("ok");
    expect(usage(80, 100).level).toBe("near");
    expect(usage(99, 100).level).toBe("near");
    expect(usage(100, 100)).toEqual({ pct: 100, level: "full" });
    expect(usage(250, 100)).toEqual({ pct: 100, level: "full" });
    expect(usage(5, 0)).toEqual({ pct: 0, level: "none" });
  });
});

describe("the chart", () => {
  it("scales every bar against the busiest day, and keeps the sent and failed parts apart", () => {
    const { bars, max } = chartBars([
      { date: "2026-10-13", sent: 5, failed: 0 },
      { date: "2026-10-14", sent: 15, failed: 5 },
    ]);
    expect(max).toBe(20);
    expect(bars[0]).toMatchObject({ total: 5, sentPct: 25, failedPct: 0, label: "Tue 13" });
    expect(bars[1]).toMatchObject({ total: 20, sentPct: 75, failedPct: 25, label: "Wed 14" });
  });

  it("never divides by zero on an empty week", () => {
    const { bars, max } = chartBars([{ date: "2026-10-14", sent: 0, failed: 0 }]);
    expect(max).toBe(1);
    expect(bars[0].sentPct).toBe(0);
    expect(chartBars([]).bars).toEqual([]);
  });

  it("writes a day as its weekday and number, without any time-zone shift", () => {
    expect(dayLabel("2026-10-12")).toBe("Mon 12");
    expect(dayLabel("2026-01-01")).toBe("Thu 1");
    expect(dayLabel("not a date")).toBe("not a date");
  });
});

describe("times and numbers", () => {
  it("shows the factory's own time", () => {
    expect(formatClock("2026-10-14T10:11:00Z")).toMatch(/3:41\s?pm/i);
    expect(formatWhen("2026-10-14T10:11:00Z")).toMatch(/14 Oct 2026, 3:41\s?pm/i);
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("garbage")).toBe("—");
    expect(formatClock(undefined)).toBe("—");
  });

  it("groups digits the Indian way", () => {
    expect(formatNumber(1234567)).toBe("12,34,567");
  });

  it("names a purpose, and an unknown one as it is", () => {
    expect(purposeLabel("login")).toBe("Login code");
    expect(purposeLabel("test")).toBe("Test message");
    expect(purposeLabel("future")).toBe("future");
  });
});

describe("normalizeMobile", () => {
  it("gives the ten digits of a number typed in the usual ways", () => {
    for (const typed of [
      "9876543210",
      "98765 43210",
      "98765-43210",
      "+91 98765 43210",
      "919876543210",
      "09876543210",
      " (98765) 43210 ",
    ]) {
      expect(normalizeMobile(typed), typed).toEqual({ ok: true, phone: "9876543210" });
    }
  });

  it("refuses what is not an Indian mobile number, and says what is wanted", () => {
    for (const typed of ["", "12345", "98765432", "98765432101", "5876543210", "abcdefghij", "+1 415 555 0100"]) {
      const result = normalizeMobile(typed);
      expect(result.ok, typed).toBe(false);
      if (!result.ok) expect(result.error).toContain("10-digit");
    }
  });
});

describe("what to do next", () => {
  it("says everything is in order when it is, and only then", () => {
    expect(ids(OVERVIEW)).toEqual(["all-good"]);
    expect(step(OVERVIEW, "all-good")?.tone).toBe("done");
    expect(step(OVERVIEW, "all-good")?.detail).toContain("10 SMS have been sent today");
  });

  it("names exactly which 2Factor values are missing, and never a value", () => {
    const o = overview({ configured: false, env: { ...OVERVIEW.env, authKey: false, templateName: "" } });
    const s = step(o, "configure")!;
    expect(s.detail).toContain("TWOFACTOR_API_KEY, TWOFACTOR_TEMPLATE_NAME");
    expect(s.detail).not.toContain("TWOFACTOR_SENDER_ID");
    expect(s.to).toBe("/hr/sms-control/setup");
    expect(s.tone).toBe("bad");
    // while the channel is still WhatsApp it is only a to-do, and says nothing changes for employees
    const w = step({ ...o, channel: "whatsapp" }, "configure")!;
    expect(w.tone).toBe("todo");
    expect(w.detail).toContain("codes keep going by WhatsApp");
  });

  it("tells an example value from a missing one", () => {
    const o = overview({ configured: false, channel: "whatsapp" });
    expect(ids(o)).toContain("placeholder");
    expect(ids(o)).not.toContain("configure");
    expect(step(o, "placeholder")?.detail).toContain("your_");
  });

  it("warns when SMS is chosen but 2Factor is not set up, and says nobody is locked out", () => {
    const o = overview({ configured: false, env: { ...OVERVIEW.env, authKey: false } });
    const s = step(o, "sms-not-ready")!;
    expect(s.tone).toBe("bad");
    expect(s.detail).toContain("nobody is locked out");
    expect(ids({ ...o, channel: "whatsapp" })).not.toContain("sms-not-ready");
  });

  it("explains switching when 2Factor is ready but the channel is WhatsApp", () => {
    const o = overview({ channel: "whatsapp" });
    const s = step(o, "switch")!;
    expect(s.tone).toBe("info");
    expect(s.detail).toContain("Settings > Channel");
    expect(s.to).toBe("/hr/sms-control/settings/channel");
    expect(ids(overview({ channel: "sms" }))).not.toContain("switch");
    // not ready: configuring comes first, no switching hint yet
    expect(
      ids(overview({ channel: "whatsapp", configured: false, env: { ...OVERVIEW.env, authKey: false } })),
    ).not.toContain("switch");
  });

  it("says why this machine will not send, with the server's own sentence", () => {
    const note = "This is a development machine, so SMS are not sent from it.";
    const s = step(overview({ sendingAllowed: false, sendingNote: note }), "sending-blocked")!;
    expect(s.detail).toBe(note);
    expect(s.tone).toBe("bad");
    expect(
      step(overview({ sendingAllowed: false, sendingNote: note, channel: "whatsapp" }), "sending-blocked")?.tone,
    ).toBe("warn");
    expect(step(overview({ sendingAllowed: false }), "sending-blocked")?.detail).toContain("SMS_ALLOW_SENDING=true");
  });

  it("reports a paused circuit with the time it ends", () => {
    const s = step(overview({ circuit: { paused: true, until: "2026-10-14T10:11:00Z" } }), "paused")!;
    expect(s.tone).toBe("bad");
    expect(s.detail).toMatch(/until 3:41\s?pm/i);
    expect(s.to).toBe("/hr/sms-control/messages?status=failed");
    expect(step(overview({ circuit: { paused: true, until: null } }), "paused")?.detail).toContain("a few minutes");
  });

  it("reads the balance: a number, a low number, a refusal for lack of it, and what 2Factor does not offer", () => {
    const b = (balance: SmsOverview["balance"]) => overview({ balance });
    expect(balanceState(b({ available: 1500, checkedAt: null, error: null }))).toMatchObject({
      kind: "amount",
      amount: 1500,
    });
    expect(balanceState(b({ available: LOW_BALANCE, checkedAt: null, error: null })).kind).toBe("low");
    expect(balanceState(b({ available: 0, checkedAt: null, error: null })).kind).toBe("low");
    expect(balanceState(b({ available: null, checkedAt: null, error: null })).kind).toBe("unknown");
    // the everyday note says "no balance check": it is not an empty account
    expect(balanceState(b({ available: null, checkedAt: null, error: SERVER_NOTE })).kind).toBe("unknown");
    expect(balanceState(b({ available: null, checkedAt: null, error: SERVER_EMPTY_NOTE })).kind).toBe("empty");
    expect(balanceState(b({ available: null, checkedAt: null, error: "2Factor refused the key." })).kind).toBe(
      "unknown",
    );
  });

  it("reports the balance: low, empty, and a standing reminder that never counts as a problem", () => {
    const b = (balance: SmsOverview["balance"], patch: Partial<SmsOverview> = {}) => overview({ balance, ...patch });
    const low = step(b({ available: LOW_BALANCE, checkedAt: null, error: null }), "balance-low")!;
    expect(low.tone).toBe("warn");
    expect(low.detail).toContain("100 left");
    expect(ids(b({ available: LOW_BALANCE + 1, checkedAt: null, error: null }))).toEqual(["all-good"]);

    const empty = step(b({ available: null, checkedAt: null, error: SERVER_EMPTY_NOTE }), "balance-empty")!;
    expect(empty.tone).toBe("bad");
    expect(empty.detail).toContain("Top it up in the 2Factor panel");
    expect(ids(b({ available: null, checkedAt: null, error: SERVER_EMPTY_NOTE }))).not.toContain("all-good");

    // 2Factor offers no balance check: a reminder with the server's note, after "everything is in order"
    const note = b({ available: null, checkedAt: null, error: SERVER_NOTE });
    expect(ids(note)).toEqual(["all-good", "balance-note"]);
    expect(step(note, "balance-note")).toMatchObject({ tone: "info", hint: true });
    expect(step(note, "balance-note")?.detail).toBe(SERVER_NOTE);
    expect(step(b({ available: null, checkedAt: null, error: null }), "balance-note")?.detail).toContain(
      "cannot read your 2Factor balance",
    );
    // not before there is anything to run out of: channel still WhatsApp and nothing sent
    expect(
      ids(b({ available: null, checkedAt: null, error: SERVER_NOTE }, { channel: "whatsapp", lastSentAt: null })),
    ).not.toContain("balance-note");
    // and nothing about the balance before 2Factor is set up
    expect(
      ids(overview({ configured: false, balance: { available: null, checkedAt: null, error: SERVER_EMPTY_NOTE } })),
    ).not.toContain("balance-empty");
  });

  it("reports the caps: close, and reached", () => {
    const hour = (hourUsed: number) => overview({ limits: { ...OVERVIEW.limits, hourUsed } });
    expect(step(hour(80), "cap-hour")?.tone).toBe("warn");
    expect(step(hour(80), "cap-hour")?.title).toContain("Close to the hourly");
    const full = step(hour(100), "cap-hour")!;
    expect(full.tone).toBe("bad");
    expect(full.detail).toContain("100 of 100");
    expect(full.to).toBe("/hr/sms-control/settings/limits");
    const day = overview({ limits: { ...OVERVIEW.limits, dayUsed: 500 } });
    expect(step(day, "cap-day")?.title).toContain("daily SMS cap is reached");
    expect(ids(hour(79))).toEqual(["all-good"]);
  });

  it("points at the blocked and the failed messages", () => {
    const blocked = step(overview({ today: { sent: 3, failed: 0, blocked: 2 } }), "blocked")!;
    expect(blocked.title).toBe("2 SMS were blocked today");
    expect(blocked.to).toBe("/hr/sms-control/messages?status=blocked");
    expect(step(overview({ today: { sent: 3, failed: 0, blocked: 1 } }), "blocked")?.title).toBe(
      "1 SMS was blocked today",
    );
    const failed = step(overview({ today: { sent: 3, failed: 4, blocked: 0 } }), "failed")!;
    expect(failed.title).toBe("4 SMS failed today");
    expect(failed.to).toBe("/hr/sms-control/messages?status=failed");
    // a cap that is reached already explains the blocks, and a pause already explains the failures
    const capped = overview({
      today: { sent: 3, failed: 0, blocked: 9 },
      limits: { ...OVERVIEW.limits, hourUsed: 100 },
    });
    expect(ids(capped)).not.toContain("blocked");
    expect(
      ids(overview({ today: { sent: 0, failed: 3, blocked: 0 }, circuit: { paused: true, until: null } })),
    ).not.toContain("failed");
  });

  it("suggests a first test when nothing has been sent yet", () => {
    const s = step(overview({ lastSentAt: null }), "try")!;
    expect(s.tone).toBe("todo");
    expect(s.to).toBe("/hr/sms-control/test");
    expect(ids(overview({ lastSentAt: null, sendingAllowed: false }))).not.toContain("try");
  });

  it("puts the most serious first", () => {
    const o = overview({
      channel: "whatsapp",
      lastSentAt: null,
      balance: { available: 5, checkedAt: null, error: null },
      circuit: { paused: true, until: null },
      limits: { ...OVERVIEW.limits, hourUsed: 85 },
    });
    expect(nextSteps(o).map((s) => s.tone)).toEqual(["bad", "warn", "warn", "todo", "info"]);
    expect(ids(o)[0]).toBe("paused");
  });
});
