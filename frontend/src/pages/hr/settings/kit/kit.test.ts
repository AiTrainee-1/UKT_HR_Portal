import { describe, expect, it } from "vitest";
import { Clock, IndianRupee } from "lucide-react";
import { searchSettings, type SettingMeta, type SettingsTabDef } from "./catalog";
import { parseSettingsAddress, settingsAddress } from "./jump";

const TABS: SettingsTabDef[] = [
  { id: "attendance", label: "Attendance", group: "time", icon: Clock, purpose: "", usedBy: [] },
  { id: "payroll", label: "Payroll", group: "pay", icon: IndianRupee, purpose: "", usedBy: [] },
];
const METAS: SettingMeta[] = [
  {
    id: "grace",
    tab: "attendance",
    section: "Late marks",
    title: "Grace period",
    purpose: "Minutes after shift start before a punch is Late.",
  },
  {
    id: "free",
    tab: "attendance",
    section: "Late marks",
    title: "Free allowance",
    purpose: "Late marks a month that cost nothing.",
  },
  {
    id: "window",
    tab: "attendance",
    section: "Arrival",
    title: "Late window",
    purpose: "How long after grace an arrival is still just Late.",
  },
  {
    id: "pf",
    tab: "payroll",
    section: "Deductions",
    title: "PF rate",
    purpose: "Provident fund taken from basic salary.",
    keywords: ["provident"],
  },
];

describe("searchSettings", () => {
  it("finds a setting by the start of a word in its title, purpose, section, tab or keywords", () => {
    expect(searchSettings(METAS, TABS, "gra").map((m) => m.id)).toEqual(["grace", "window"]);
    expect(searchSettings(METAS, TABS, "provident").map((m) => m.id)).toEqual(["pf"]);
    expect(searchSettings(METAS, TABS, "payroll").map((m) => m.id)).toEqual(["pf"]);
  });

  it("needs every typed word to match, and ranks a title match above a match elsewhere", () => {
    expect(searchSettings(METAS, TABS, "late free").map((m) => m.id)).toEqual(["free"]);
    expect(searchSettings(METAS, TABS, "late").map((m) => m.id)[0]).toBe("window");
    expect(searchSettings(METAS, TABS, "zzz")).toEqual([]);
    expect(searchSettings(METAS, TABS, "   ")).toEqual([]);
  });
});

describe("settings address", () => {
  it("reads the tab and the setting, and builds the address back", () => {
    expect(parseSettingsAddress("?tab=attendance", "#grace")).toEqual({ tab: "attendance", setting: "grace" });
    expect(parseSettingsAddress("", "")).toEqual({ tab: null, setting: null });
    expect(settingsAddress("salary-slip", "logo")).toBe("/hr/settings?tab=salary-slip#logo");
    expect(settingsAddress("payroll")).toBe("/hr/settings?tab=payroll");
  });
});
