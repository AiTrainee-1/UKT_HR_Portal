import { describe, expect, it } from "vitest";
import {
  RETIRED_SECTIONS,
  SETTINGS_SECTIONS,
  SMS_BASE,
  SMS_OWN_KEYS,
  SMS_TABS,
  cleanSmsPath,
  nestedOf,
  readSmsPath,
  resolveSmsPath,
  smsLanding,
  smsPath,
  smsTabPath,
} from "./routes";

describe("the addresses of SMS Control", () => {
  it("has six tabs, in this order, and nested tabs only under Settings", () => {
    expect(SMS_TABS.map((t) => t.value)).toEqual(["overview", "usage", "settings", "messages", "test", "setup"]);
    expect(SMS_TABS.map((t) => t.label)).toEqual(["Overview", "Usage & Cost", "Settings", "Messages", "Test", "Setup"]);
    expect(SETTINGS_SECTIONS.map((s) => s.value)).toEqual(["switches", "limits", "cost"]);
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual(["OTP Switches", "Limits", "Cost"]);
    for (const tab of SMS_TABS) {
      expect(nestedOf(tab.value).length, tab.value).toBe(tab.value === "settings" ? 3 : 0);
    }
  });

  it("builds the address of a tab and of a nested tab", () => {
    expect(smsTabPath()).toBe(SMS_BASE);
    expect(smsTabPath("messages")).toBe("/hr/sms-control/messages");
    expect(smsTabPath("usage")).toBe("/hr/sms-control/usage");
    expect(smsTabPath("settings", "cost")).toBe("/hr/sms-control/settings/cost");
    // a tab without a nested level ignores one
    expect(smsTabPath("messages", "limits")).toBe("/hr/sms-control/messages");
    expect(smsLanding("overview")).toBe("/hr/sms-control/overview");
    expect(smsLanding("settings")).toBe("/hr/sms-control/settings/switches");
  });

  it("adds a query string, with or without its question mark, and opens Settings on its first section", () => {
    expect(smsPath("messages", undefined, "status=failed")).toBe("/hr/sms-control/messages?status=failed");
    expect(smsPath("messages", undefined, "?status=failed")).toBe("/hr/sms-control/messages?status=failed");
    expect(smsPath("usage", undefined, "month=2026-10")).toBe("/hr/sms-control/usage?month=2026-10");
    expect(smsPath("settings")).toBe("/hr/sms-control/settings/switches");
    expect(smsPath("settings", "limits")).toBe("/hr/sms-control/settings/limits");
    expect(smsPath("test")).toBe("/hr/sms-control/test");
  });

  it("reads the tab and the nested tab an address names, as far as they are real", () => {
    expect(readSmsPath("/hr/sms-control")).toEqual({ tab: null, nested: null });
    expect(readSmsPath("/hr/sms-control/usage")).toEqual({ tab: "usage", nested: null });
    expect(readSmsPath("/hr/sms-control/settings/limits")).toEqual({ tab: "settings", nested: "limits" });
    expect(readSmsPath("/hr/sms-control/settings/nope")).toEqual({ tab: "settings", nested: null });
    expect(readSmsPath("/hr/sms-control/nope/limits")).toEqual({ tab: null, nested: null });
    expect(readSmsPath("/HR/SMS-Control/Settings/COST?x=1#top")).toEqual({ tab: "settings", nested: "cost" });
    expect(readSmsPath("/hr/sms-control-archive/messages")).toEqual({ tab: null, nested: null });
  });

  it("reads the retired Channel section as OTP Switches, and only under Settings", () => {
    expect(RETIRED_SECTIONS).toEqual({ channel: "switches" });
    expect(readSmsPath("/hr/sms-control/settings/channel")).toEqual({ tab: "settings", nested: "switches" });
    expect(readSmsPath("/hr/sms-control/messages/channel")).toEqual({ tab: "messages", nested: null });
  });

  it("keeps each tab's own query keys with it", () => {
    expect(SMS_OWN_KEYS.messages).toEqual(["status", "purpose", "q", "from", "to", "page", "size"]);
    expect(SMS_OWN_KEYS.usage).toEqual(["month"]);
  });
});

describe("resolveSmsPath", () => {
  const cases: [string, string][] = [
    ["/hr/sms-control", "/hr/sms-control/overview"],
    ["/hr/sms-control/overview", "/hr/sms-control/overview"],
    ["/hr/sms-control/overview/deeper", "/hr/sms-control/overview"],
    ["/hr/sms-control/nope", "/hr/sms-control/overview"],
    ["/hr/sms-control/usage", "/hr/sms-control/usage"],
    ["/hr/sms-control/usage/x", "/hr/sms-control/usage"],
    ["/hr/sms-control/settings", "/hr/sms-control/settings/switches"],
    ["/hr/sms-control/settings/nope", "/hr/sms-control/settings/switches"],
    ["/hr/sms-control/settings/channel", "/hr/sms-control/settings/switches"],
    ["/hr/sms-control/settings/limits", "/hr/sms-control/settings/limits"],
    ["/hr/sms-control/settings/cost/extra", "/hr/sms-control/settings/cost"],
    ["/hr/sms-control/messages", "/hr/sms-control/messages"],
    ["/hr/sms-control/messages/limits", "/hr/sms-control/messages"],
    ["/hr/sms-control/test/x/y", "/hr/sms-control/test"],
    ["/hr/sms-control/setup", "/hr/sms-control/setup"],
    ["/HR/SMS-CONTROL/Settings", "/hr/sms-control/settings/switches"],
  ];
  it.each(cases)("%s is %s", (from, to) => {
    expect(resolveSmsPath(from)).toBe(to);
  });

  it("is idempotent: a resolved address stays as it is", () => {
    for (const [, to] of cases) expect(resolveSmsPath(to)).toBe(to);
  });

  it("lands on the first tab and section the role may open, and treats a hidden one as unknown", () => {
    const visible = { tabs: ["usage", "settings"] as const, sections: ["limits", "cost"] as const };
    expect(resolveSmsPath("/hr/sms-control", visible)).toBe("/hr/sms-control/usage");
    expect(resolveSmsPath("/hr/sms-control/overview", visible)).toBe("/hr/sms-control/usage");
    expect(resolveSmsPath("/hr/sms-control/settings", visible)).toBe("/hr/sms-control/settings/limits");
    // the retired Channel opens OTP Switches, and when that is hidden, the first section that is not
    expect(resolveSmsPath("/hr/sms-control/settings/channel", visible)).toBe("/hr/sms-control/settings/limits");
    expect(resolveSmsPath("/hr/sms-control/settings/cost", visible)).toBe("/hr/sms-control/settings/cost");
  });

  it("drops a trailing slash first", () => {
    expect(cleanSmsPath("/hr/sms-control/messages/")).toBe("/hr/sms-control/messages");
    expect(cleanSmsPath("/hr/sms-control///")).toBe("/hr/sms-control");
    expect(cleanSmsPath("/")).toBe("/");
    expect(resolveSmsPath(cleanSmsPath("/hr/sms-control/setup/"))).toBe("/hr/sms-control/setup");
  });
});
