import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { allModuleKeys } from "@/lib/permission-modules";
import AttendanceTab from "../AttendanceTab";
import PayrollTab from "../PayrollTab";
import { ALL_SETTINGS, settingPartKeys } from "../metas";
import { BACKUP_FEATURE_MODULE, LATE_CYCLE_MODULE, SETTINGS_SUBTAB_MODULE, subtabKeysOf } from "../constants";

// The sub-tabs (pills) inside a Settings tab follow their own permission keys (kit/subtabs.tsx): a hidden one is not offered
// and never shown (also when the address or a #setting link asks for it), a View-only one is read-only with its note, and
// a tab with none open says so. The page's search does not offer a setting of a hidden sub-tab (metas.ts settingPartKeys).

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const PAYROLL = {
  companyName: "UK Textiles",
  companyLogo: null,
  compensationFeatureEnabled: true,
  companyWideRulesEditable: true,
  salaryPayDay: 7,
  bonusFyStartMonth: 4,
};

const ATTENDANCE = {
  companyName: "UK Textiles",
  companyLogo: null,
  attendanceMode: "strict",
  simpleHalfShiftCutoff: "13:30",
  morningLateInEnabled: true,
  eveningEarlyOutEnabled: false,
  halfDayFirstHalfEndTime: "13:30",
  halfDaySecondHalfStartTime: "14:30",
  arrivalLateWindowMinutes: 60,
  arrivalPermissionWindowMinutes: 60,
  arrivalExtraMinutes: 20,
  arrivalQuarterDeduction: 0.25,
  afternoonLateWindowMinutes: 60,
  afternoonPermissionWindowMinutes: 60,
  lastPunchPostShiftGraceHours: 9,
  firstPunchPreShiftBufferHours: 2,
  defaultShiftGraceMinutes: 15,
  defaultShiftFirstHalfEnd: "13:30",
  defaultShiftLunchDurationMinutes: 60,
  defaultShiftLunchGraceMinutes: 10,
  lateFreeAllowance: 3,
  permissionMonthlyCap: 3,
  companyWideRulesEditable: true,
};

const hr = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  name: "Test HR",
  isSuperAdmin: false,
  permissions,
});

let page: RenderedPage | undefined;

beforeEach(() => toast.mockClear());
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

async function openPayroll(permissions: Record<string, string>, address = "/hr/settings?tab=payroll") {
  window.history.replaceState(null, "", address);
  page = await renderMdPage(
    () => <PayrollTab />,
    { "/api/auth/me": hr(permissions), "/api/payroll-settings": PAYROLL },
    { path: "/hr/settings?tab=payroll" },
  );
}

async function openAttendance(permissions: Record<string, string>, address = "/hr/settings?tab=attendance") {
  window.history.replaceState(null, "", address);
  page = await renderMdPage(
    () => <AttendanceTab />,
    { "/api/auth/me": hr(permissions), "/api/payroll-settings": ATTENDANCE, "/api/production-shift-config": {} },
    { path: "/hr/settings?tab=attendance" },
  );
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const pills = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"] .ptab-label')].map((l) => l.textContent?.trim());
const button = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);

describe("a Settings tab's sub-tabs follow their own keys", () => {
  it("offers every sub-tab to a role that never set them (they follow the tab)", async () => {
    await openPayroll({ settings: "edit" });
    expect(pills()).toEqual(["Payroll Rules", "Bonus", "OT / Compensation"]);
    expect(q('[data-testid="settings-subtab-view-only"]')).toBeNull();
  });

  it("does not offer a hidden sub-tab, and a #setting link of it opens the first visible one instead", async () => {
    await openPayroll(
      { settings: "edit", "settings.payroll.bonus": "hidden" },
      "/hr/settings?tab=payroll#bonus-percent",
    );
    expect(pills()).toEqual(["Payroll Rules", "OT / Compensation"]);
    expect(q('[data-setting-id="bonus-percent"]')).toBeNull();
    expect(button("Save Staff Bonus Settings")).toBeUndefined();
    expect(button("Save Payroll Settings")).toBeDefined();
  });

  it("shows a View-only sub-tab read-only, with its note", async () => {
    await openPayroll({ settings: "edit", "settings.payroll.rates": "view" });
    expect(q('[data-testid="settings-subtab-view-only"]')).not.toBeNull();
    expect(button("Save Payroll Settings")?.disabled).toBe(true);
  });

  it("says so when none of the tab's sub-tabs is open", async () => {
    await openPayroll({
      settings: "edit",
      "settings.payroll.rates": "hidden",
      "settings.payroll.bonus": "hidden",
      "settings.payroll.ot_compensation": "hidden",
    });
    expect(q('[data-testid="settings-nothing-open"]')).not.toBeNull();
    expect(pills()).toEqual([]);
  });

  it("falls back from a hidden Staff | Production page named in the address", async () => {
    await openAttendance(
      { settings: "edit", "settings.attendance.production": "hidden" },
      "/hr/settings?tab=attendance&view=production",
    );
    expect(pills()).toEqual(["Staff"]);
    expect(q('[data-testid="attendance-page-production"]')).toBeNull();
    expect(button("Save Attendance Settings")).toBeDefined();
  });
});

describe("the keys behind the sub-tabs and the search", () => {
  it("names a key the role editor knows for every sub-tab, cycle pill and Backup part", () => {
    const known = new Set(allModuleKeys());
    const every = [
      ...Object.values(SETTINGS_SUBTAB_MODULE).flatMap((keys) => Object.values(keys)),
      ...Object.values(LATE_CYCLE_MODULE),
      ...Object.values(BACKUP_FEATURE_MODULE),
    ];
    for (const k of every) expect(known.has(k), k).toBe(true);
    expect(subtabKeysOf("late_detection")).toEqual([
      "settings.late_detection.staff",
      "settings.late_detection.production",
      ...Object.values(LATE_CYCLE_MODULE),
    ]);
    expect(subtabKeysOf("company")).toEqual([]);
  });

  it("puts each setting under the sub-tab (and cycle pill, Backup part) that holds it", () => {
    const of = (tab: string, id: string) => {
      const meta = ALL_SETTINGS.find((m) => m.tab === tab && m.id === id);
      if (!meta) throw new Error(`no setting ${tab}#${id}`);
      return settingPartKeys(meta);
    };
    expect(of("payroll", "bonus-percent")).toEqual(["settings.payroll.bonus"]);
    expect(of("attendance", "production-late")).toEqual(["settings.attendance.production"]);
    expect(of("backup", "restore-upload")).toEqual(["settings.backup.restore"]);
    expect(of("backup", "backup-run-now")).toEqual([]);
    expect(of("company", ALL_SETTINGS.find((m) => m.tab === "company")!.id)).toEqual([]);
    const cycleSetting = ALL_SETTINGS.find((m) => m.tab === "late_detection" && m.id.startsWith("weekly-late"));
    expect(cycleSetting && settingPartKeys(cycleSetting)).toEqual([
      "settings.late_detection.production",
      "settings.late_detection.production.weekly",
    ]);
  });
});
