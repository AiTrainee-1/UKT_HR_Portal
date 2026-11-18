import { describe, expect, it } from "vitest";
import type { WhatsAppFeature, WhatsAppQueueLimit } from "@/lib/api-client/custom-hooks";
import {
  changedLimits,
  crossesMidnight,
  employeeCodesText,
  featureSections,
  fmtSendTime,
  groupTestTypes,
  hodStatus,
  limitError,
  providerBadge,
  quietHoursChanged,
  quietHoursError,
  recipientLabel,
  sectionMaster,
  splitProblems,
  switchedOffSummary,
  tabFromSearch,
  tabHref,
  usageLevel,
} from "./logic";
import { DEV_TEMPLATES, SURYA, TYPES, settings, template } from "./test-fixtures";

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

describe("the tab in the address", () => {
  it("reads ?tab= and falls back to the Overview", () => {
    expect(tabFromSearch("")).toBe("overview");
    expect(tabFromSearch("?tab=controls")).toBe("controls");
    expect(tabFromSearch("tab=Test")).toBe("test");
    expect(tabFromSearch("?tab=")).toBe("overview");
  });

  it("writes the Overview as the bare address and any other tab as ?tab=", () => {
    expect(tabHref("/hr/whatsapp-control", "overview")).toBe("/hr/whatsapp-control");
    expect(tabHref("/hr/whatsapp-control", "test")).toBe("/hr/whatsapp-control?tab=test");
  });
});

describe("switchedOffSummary", () => {
  it("counts the types HR's switches keep back, by module, and the ones that can still go", () => {
    const s = switchedOffSummary(DEV_TEMPLATES(), true);
    expect(s.total).toBe(9);
    expect(s.off.map((t) => t.documentType)).toEqual([
      "salary_slip",
      "id_card",
      "otp_login",
      "absent_alert",
      "approval_approved",
      "geo_approval",
    ]);
    expect(s.on.map((t) => t.documentType)).toEqual([
      "hod_request_waiting",
      "hod_pending_reminder",
      "attendance_report",
    ]);
    expect(s.offByModule).toEqual([
      { key: "documents", label: "Documents", count: 2 },
      { key: "otp", label: "OTP & Login", count: 1 },
      { key: "attendance", label: "Attendance", count: 1 },
      { key: "approvals", label: "Approvals", count: 1 },
      { key: "geo", label: "Geo Attendance", count: 1 },
    ]);
    expect(s.level).toBe("most");
  });

  it("names why: the engine first, then the module, the type's own switch, its Message Text switch", () => {
    const why = (t: ReturnType<typeof template>, engine = true) => switchedOffSummary([t], engine).off[0]?.off ?? null;
    const both = template("salary_slip", "documents", "Documents", { featureEnabled: false, moduleEnabled: false });
    expect(why(both, false)).toBe("engine");
    expect(why(both)).toBe("module");
    expect(why(template("otp_login", "otp", "OTP", { featureEnabled: false }))).toBe("own");
    expect(why(template("id_card", "documents", "Documents", { isEnabled: false }))).toBe("wording");
    expect(
      why(template("id_card", "documents", "Documents", { featureEnabled: true, moduleEnabled: true })),
    ).toBeNull();
  });

  it("is engine-off whatever the types say, some for a few, none for none", () => {
    expect(switchedOffSummary([template("a", "x", "X")], false).level).toBe("engine-off");
    const few = [template("a", "x", "X", { featureEnabled: false }), template("b", "x", "X"), template("c", "x", "X")];
    expect(switchedOffSummary(few, true).level).toBe("some");
    expect(switchedOffSummary([template("b", "x", "X")], true).level).toBe("none");
    expect(switchedOffSummary([], true).level).toBe("none");
  });
});

describe("the section master switches", () => {
  it("finds a section's master when the server sent it", () => {
    const features = settings().features;
    expect(sectionMaster("hod", features)?.key).toBe("hodNotificationsEnabled");
    expect(sectionMaster("approvals", features)?.key).toBe("approvalNotificationsEnabled");
    expect(sectionMaster("documents", features)).toBeNull();
    expect(sectionMaster("geo", features)).toBeNull();
  });
});

describe("hodStatus", () => {
  it("is on, partly or off, and marks a switch the section holds back", () => {
    expect(hodStatus(settings())!.state).toBe("on");
    expect(hodStatus(settings({ reminderOn: false }))!.state).toBe("partly");
    const off = hodStatus(settings({ hodOn: false }))!;
    expect(off.state).toBe("off");
    expect(off.items.map((i) => [i.feature.key, i.on, i.held])).toEqual([
      ["hodRequestWaitingEnabled", false, true],
      ["type:hod_pending_reminder", false, true],
    ]);
    expect(hodStatus(settings({ engineEnabled: false }))!.state).toBe("off");
    expect(hodStatus(settings({ waitingOn: false, reminderOn: false }))!.items.every((i) => !i.held)).toBe(true);
  });

  it("is null on a server without the section", () => {
    const old = settings();
    old.features = old.features.filter((f) => f.group !== "hod");
    expect(hodStatus(old)).toBeNull();
  });
});

describe("the connection check", () => {
  it("colours WAClient's states", () => {
    expect(providerBadge("connected")).toEqual({ label: "Connected", tone: "success" });
    expect(providerBadge("logged_out")).toEqual({ label: "Logged out", tone: "danger" });
    expect(providerBadge("disconnected").tone).toBe("danger");
    expect(providerBadge("pending").tone).toBe("warning");
    expect(providerBadge("linking").tone).toBe("warning");
    expect(providerBadge("connecting").tone).toBe("warning");
    expect(providerBadge("qr_shown")).toEqual({ label: "qr shown", tone: "neutral" });
  });

  it("sets the documents problem apart from the ones that stop every message", () => {
    const docs = "WAClient can't download the PDF from 'http://localhost:8000'.";
    expect(splitProblems(["The master switch is OFF.", `Documents cannot be sent from here: ${docs}`], docs)).toEqual({
      main: ["The master switch is OFF."],
      documents: docs,
    });
    expect(splitProblems(["The master switch is OFF."], null)).toEqual({
      main: ["The master switch is OFF."],
      documents: null,
    });
  });
});

describe("Send a test helpers", () => {
  it("groups the types by module in the server's order", () => {
    const groups = groupTestTypes([...TYPES, { ...TYPES[0], documentType: "id_card", label: "ID Card" }]);
    expect(groups.map((g) => [g.label, g.types.map((t) => t.documentType)])).toEqual([
      ["Documents", ["salary_slip", "id_card"]],
      ["Department Heads", ["hod_request_waiting"]],
    ]);
  });

  it("names the recipient and the allowed employees the way the page says them", () => {
    expect(recipientLabel(SURYA)).toBe("SURYA M (••••9103)");
    expect(recipientLabel({ ...SURYA, phone: null })).toBe("SURYA M (30020)");
    expect(employeeCodesText(["30020"])).toBe("employee 30020");
    expect(employeeCodesText(["30020", "30021"])).toBe("employees 30020 and 30021");
    expect(employeeCodesText(["1", "2", "3"])).toBe("employees 1, 2 and 3");
  });
});
