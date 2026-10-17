import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  SMS_BASE,
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
  it("has five tabs, in this order, and nested tabs only under Settings", () => {
    expect(SMS_TABS.map((t) => t.value)).toEqual(["overview", "settings", "messages", "test", "setup"]);
    expect(SMS_TABS.map((t) => t.label)).toEqual(["Overview", "Settings", "Messages", "Test", "Setup"]);
    expect(SETTINGS_SECTIONS.map((s) => s.value)).toEqual(["channel", "limits", "switches"]);
    for (const tab of SMS_TABS) {
      expect(nestedOf(tab.value).length, tab.value).toBe(tab.value === "settings" ? 3 : 0);
    }
  });

  it("builds the address of a tab and of a nested tab", () => {
    expect(smsTabPath()).toBe(SMS_BASE);
    expect(smsTabPath("messages")).toBe("/hr/sms-control/messages");
    expect(smsTabPath("settings", "limits")).toBe("/hr/sms-control/settings/limits");
    // a tab without a nested level ignores one
    expect(smsTabPath("messages", "limits")).toBe("/hr/sms-control/messages");
    expect(smsLanding("overview")).toBe("/hr/sms-control/overview");
    expect(smsLanding("settings")).toBe("/hr/sms-control/settings/channel");
  });

  it("adds a query string, with or without its question mark, and opens Settings on its first section", () => {
    expect(smsPath("messages", undefined, "status=failed")).toBe("/hr/sms-control/messages?status=failed");
    expect(smsPath("messages", undefined, "?status=failed")).toBe("/hr/sms-control/messages?status=failed");
    expect(smsPath("settings")).toBe("/hr/sms-control/settings/channel");
    expect(smsPath("settings", "switches")).toBe("/hr/sms-control/settings/switches");
    expect(smsPath("test")).toBe("/hr/sms-control/test");
  });

  it("reads the tab and the nested tab an address names, as far as they are real", () => {
    expect(readSmsPath("/hr/sms-control")).toEqual({ tab: null, nested: null });
    expect(readSmsPath("/hr/sms-control/messages")).toEqual({ tab: "messages", nested: null });
    expect(readSmsPath("/hr/sms-control/settings/limits")).toEqual({ tab: "settings", nested: "limits" });
    expect(readSmsPath("/hr/sms-control/settings/nope")).toEqual({ tab: "settings", nested: null });
    expect(readSmsPath("/hr/sms-control/nope/limits")).toEqual({ tab: null, nested: null });
    expect(readSmsPath("/HR/SMS-Control/Settings/LIMITS?x=1#top")).toEqual({ tab: "settings", nested: "limits" });
    expect(readSmsPath("/hr/sms-control-archive/messages")).toEqual({ tab: null, nested: null });
  });
});

describe("resolveSmsPath", () => {
  const cases: [string, string][] = [
    ["/hr/sms-control", "/hr/sms-control/overview"],
    ["/hr/sms-control/overview", "/hr/sms-control/overview"],
    ["/hr/sms-control/overview/deeper", "/hr/sms-control/overview"],
    ["/hr/sms-control/nope", "/hr/sms-control/overview"],
    ["/hr/sms-control/settings", "/hr/sms-control/settings/channel"],
    ["/hr/sms-control/settings/nope", "/hr/sms-control/settings/channel"],
    ["/hr/sms-control/settings/limits", "/hr/sms-control/settings/limits"],
    ["/hr/sms-control/settings/switches/extra", "/hr/sms-control/settings/switches"],
    ["/hr/sms-control/messages", "/hr/sms-control/messages"],
    ["/hr/sms-control/messages/limits", "/hr/sms-control/messages"],
    ["/hr/sms-control/test/x/y", "/hr/sms-control/test"],
    ["/hr/sms-control/setup", "/hr/sms-control/setup"],
    ["/HR/SMS-CONTROL/Settings", "/hr/sms-control/settings/channel"],
  ];
  it.each(cases)("%s is %s", (from, to) => {
    expect(resolveSmsPath(from)).toBe(to);
  });

  it("is idempotent: a resolved address stays as it is", () => {
    for (const [, to] of cases) expect(resolveSmsPath(to)).toBe(to);
  });

  it("drops a trailing slash first", () => {
    expect(cleanSmsPath("/hr/sms-control/messages/")).toBe("/hr/sms-control/messages");
    expect(cleanSmsPath("/hr/sms-control///")).toBe("/hr/sms-control");
    expect(cleanSmsPath("/")).toBe("/");
    expect(resolveSmsPath(cleanSmsPath("/hr/sms-control/setup/"))).toBe("/hr/sms-control/setup");
  });
});
