import { describe, expect, it } from "vitest";
import { PN_BASE, PN_TABS, cleanPnPath, pnPath, pnTabModule, pnTabPath, readPnPath, resolvePnPath } from "./routes";

describe("the addresses of Phone Notify Control", () => {
  it("has six tabs, in this order", () => {
    expect(PN_TABS.map((t) => t.value)).toEqual([
      "overview",
      "messages",
      "employees",
      "controls",
      "send",
      "configuration",
    ]);
    expect(PN_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Messages",
      "Employees",
      "Controls",
      "Send a message",
      "Configuration",
    ]);
  });

  it("builds the address of a tab, with or without a query string", () => {
    expect(pnTabPath()).toBe(PN_BASE);
    expect(pnTabPath("overview")).toBe("/hr/phone-notify-control/overview");
    expect(pnTabPath("configuration")).toBe("/hr/phone-notify-control/configuration");
    expect(pnPath("messages", "status=failed")).toBe("/hr/phone-notify-control/messages?status=failed");
    expect(pnPath("messages", "?status=failed")).toBe("/hr/phone-notify-control/messages?status=failed");
    expect(pnPath("employees")).toBe("/hr/phone-notify-control/employees");
  });

  it("reads the tab an address names, as far as it is a real one", () => {
    expect(readPnPath("/hr/phone-notify-control")).toBeNull();
    expect(readPnPath("/hr/phone-notify-control/")).toBeNull();
    expect(readPnPath("/hr/phone-notify-control/messages")).toBe("messages");
    expect(readPnPath("/hr/phone-notify-control/send/extra")).toBe("send");
    expect(readPnPath("/HR/Phone-Notify-Control/Controls?x=1#top")).toBe("controls");
    expect(readPnPath("/hr/phone-notify-control/nope")).toBeNull();
    expect(readPnPath("/hr/phone-notify-control-archive/messages")).toBeNull();
    expect(readPnPath("/hr/sms-control/messages")).toBeNull();
  });

  it("gives each tab its own permission key under the page", () => {
    expect(PN_TABS.map((t) => pnTabModule(t.value))).toEqual([
      "phone_notify_control.overview",
      "phone_notify_control.messages",
      "phone_notify_control.employees",
      "phone_notify_control.controls",
      "phone_notify_control.send",
      "phone_notify_control.configuration",
    ]);
  });
});

describe("resolvePnPath", () => {
  const cases: [string, string][] = [
    ["/hr/phone-notify-control", "/hr/phone-notify-control/overview"],
    ["/hr/phone-notify-control/overview", "/hr/phone-notify-control/overview"],
    ["/hr/phone-notify-control/overview/deeper", "/hr/phone-notify-control/overview"],
    ["/hr/phone-notify-control/nope", "/hr/phone-notify-control/overview"],
    ["/hr/phone-notify-control/messages", "/hr/phone-notify-control/messages"],
    ["/hr/phone-notify-control/messages/12", "/hr/phone-notify-control/messages"],
    ["/hr/phone-notify-control/employees", "/hr/phone-notify-control/employees"],
    ["/hr/phone-notify-control/controls", "/hr/phone-notify-control/controls"],
    ["/hr/phone-notify-control/send/x/y", "/hr/phone-notify-control/send"],
    ["/hr/phone-notify-control/configuration", "/hr/phone-notify-control/configuration"],
    ["/HR/PHONE-NOTIFY-CONTROL/Messages", "/hr/phone-notify-control/messages"],
  ];
  it.each(cases)("%s is %s", (from, to) => {
    expect(resolvePnPath(from)).toBe(to);
  });

  it("is idempotent: a resolved address stays as it is", () => {
    for (const [, to] of cases) expect(resolvePnPath(to)).toBe(to);
  });

  it("lands on the first tab the role may open, and treats a hidden tab as unknown", () => {
    const visible = ["messages", "send"] as const;
    expect(resolvePnPath("/hr/phone-notify-control", visible)).toBe("/hr/phone-notify-control/messages");
    expect(resolvePnPath("/hr/phone-notify-control/overview", visible)).toBe("/hr/phone-notify-control/messages");
    expect(resolvePnPath("/hr/phone-notify-control/controls", visible)).toBe("/hr/phone-notify-control/messages");
    expect(resolvePnPath("/hr/phone-notify-control/send", visible)).toBe("/hr/phone-notify-control/send");
    // nothing open at all: the first tab (the page says nothing is open instead of redirecting)
    expect(resolvePnPath("/hr/phone-notify-control/send", [])).toBe("/hr/phone-notify-control/overview");
  });

  it("drops a trailing slash first", () => {
    expect(cleanPnPath("/hr/phone-notify-control/messages/")).toBe("/hr/phone-notify-control/messages");
    expect(cleanPnPath("/hr/phone-notify-control///")).toBe("/hr/phone-notify-control");
    expect(cleanPnPath("/")).toBe("/");
    expect(resolvePnPath(cleanPnPath("/hr/phone-notify-control/send/"))).toBe("/hr/phone-notify-control/send");
  });
});
