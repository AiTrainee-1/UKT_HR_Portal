import { describe, expect, it } from "vitest";
import type { WhatsAppFeature, WhatsAppQueueLimit } from "@/lib/api-client/custom-hooks";
import {
  changedLimits,
  crossesMidnight,
  featureSections,
  fmtSendTime,
  limitError,
  quietHoursChanged,
  quietHoursError,
  usageLevel,
} from "./logic";

const feature = (key: string, group: string): WhatsAppFeature => ({
  key,
  group,
  label: key,
  description: "",
  enabled: true,
});

const GROUPS = [
  { key: "signin", title: "Employee sign-in", blurb: "" },
  { key: "documents", title: "Documents", blurb: "" },
  { key: "approvals", title: "Approvals", blurb: "" },
];

describe("featureSections", () => {
  it("keeps the server's groups in order and splits module switches from per-type switches", () => {
    const sections = featureSections(GROUPS, [
      feature("otpLoginEnabled", "signin"),
      feature("documentNotificationsEnabled", "documents"),
      feature("type:salary_slip", "documents"),
      feature("type:id_card", "documents"),
    ]);
    expect(sections.map((s) => s.group.key)).toEqual(["signin", "documents"]);
    const docs = sections[1];
    expect(docs.general.map((f) => f.key)).toEqual(["documentNotificationsEnabled"]);
    expect(docs.perType.map((f) => f.key)).toEqual(["type:salary_slip", "type:id_card"]);
  });

  it("never drops a switch whose module has no group: OTP goes after sign-in, anything else at the end", () => {
    const sections = featureSections(GROUPS, [
      feature("otpLoginEnabled", "signin"),
      feature("type:other", "other"),
      feature("type:otp_login", "otp"),
      feature("approvalLeaveEnabled", "approvals"),
    ]);
    expect(sections.map((s) => s.group.key)).toEqual(["signin", "otp", "approvals", "other"]);
    expect(sections[1].group.title).toBe("OTP & Login");
    expect(sections[1].perType.map((f) => f.key)).toEqual(["type:otp_login"]);
    expect(sections[3].group.title).toBe("Other");
  });

  it("names a module it has never heard of by its key", () => {
    const [only] = featureSections([], [feature("type:x", "payroll")]);
    expect(only.group).toEqual({ key: "payroll", title: "payroll", blurb: "" });
  });
});

const GAP: WhatsAppQueueLimit = { key: "minGapSeconds", label: "Gap", value: 30, min: 5, max: 600, unit: "seconds" };
const DAY: WhatsAppQueueLimit = { key: "maxPerDay", label: "Per day", value: 200, min: 1, max: 1000, unit: "messages" };

describe("limits", () => {
  it("accepts a whole number inside the range and explains everything else", () => {
    expect(limitError(GAP, "30")).toBeNull();
    expect(limitError(GAP, "5")).toBeNull();
    expect(limitError(GAP, "600")).toBeNull();
    expect(limitError(GAP, "")).toBe("Enter a number.");
    expect(limitError(GAP, undefined)).toBe("Enter a number.");
    expect(limitError(GAP, "2.5")).toBe("Whole numbers only.");
    expect(limitError(GAP, "4")).toBe("Must be between 5 and 600.");
    expect(limitError(GAP, "601")).toBe("Must be between 5 and 600.");
  });

  it("sends only the limits that changed", () => {
    expect(changedLimits([GAP, DAY], { minGapSeconds: "30", maxPerDay: "200" })).toEqual({});
    expect(changedLimits([GAP, DAY], { minGapSeconds: "45", maxPerDay: "200" })).toEqual({ minGapSeconds: 45 });
    expect(changedLimits([GAP, DAY], { minGapSeconds: "", maxPerDay: "150" })).toEqual({ maxPerDay: 150 });
  });
});

describe("quiet hours", () => {
  it("wants HH:MM times, and different ones while they are on", () => {
    expect(quietHoursError({ enabled: true, start: "21:00", end: "07:00" })).toBeNull();
    expect(quietHoursError({ enabled: true, start: "21:00", end: "" })).toBe("Enter both times as HH:MM.");
    expect(quietHoursError({ enabled: true, start: "24:00", end: "07:00" })).toBe("Enter both times as HH:MM.");
    expect(quietHoursError({ enabled: true, start: "07:00", end: "07:00" })).toBe(
      "Start and end can't be the same time.",
    );
    expect(quietHoursError({ enabled: false, start: "07:00", end: "07:00" })).toBeNull();
  });

  it("notices a change and an overnight window", () => {
    const saved = { enabled: true, start: "21:00", end: "07:00" };
    expect(quietHoursChanged(saved, { ...saved })).toBe(false);
    expect(quietHoursChanged(saved, { ...saved, end: "06:30" })).toBe(true);
    expect(quietHoursChanged(undefined, saved)).toBe(true);
    expect(crossesMidnight(saved)).toBe(true);
    expect(crossesMidnight({ enabled: true, start: "13:00", end: "14:00" })).toBe(false);
  });
});

describe("usageLevel and fmtSendTime", () => {
  it("turns amber at 80% of a cap and red at it", () => {
    expect(usageLevel(10, 200)).toBe("ok");
    expect(usageLevel(160, 200)).toBe("near");
    expect(usageLevel(200, 200)).toBe("full");
    expect(usageLevel(250, 200)).toBe("full");
    expect(usageLevel(5, 0)).toBe("ok");
  });

  it("shows only the time for today and the date too for another day", () => {
    const now = new Date(2026, 10, 6, 9, 0);
    expect(fmtSendTime(null, now)).toBe("—");
    expect(fmtSendTime("not a date", now)).toBe("—");
    const today = fmtSendTime(new Date(2026, 10, 6, 10, 42).toISOString(), now);
    expect(today).toMatch(/10:42/);
    expect(today).not.toMatch(/Nov/);
    expect(fmtSendTime(new Date(2026, 10, 7, 7, 0).toISOString(), now)).toMatch(/Nov/);
  });
});
