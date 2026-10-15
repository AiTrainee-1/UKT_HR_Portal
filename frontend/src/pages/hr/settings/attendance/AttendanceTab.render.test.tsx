import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import AttendanceTab from "../AttendanceTab";
import { ATTENDANCE_SETTINGS } from "../AttendanceTab.meta";

// jsdom render checks of Settings -> Attendance with a fake server (the page itself is covered by
// e2e/arrival-timeline.spec.ts): the agreed numbers and the example rows, previews that follow what is typed, the
// confirm before saving and the exact request, the branch-login lock, and the read-only production part.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const SAVED = {
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
  prodFirstHalfStart: "08:30",
  prodFirstHalfEnd: "12:30",
  prodSecondHalfStart: "13:30",
  prodSecondHalfEnd: "17:30",
  prodExtraStart: "17:50",
  prodExtraEnd: "20:00",
  defaultShiftGraceMinutes: 15,
  defaultShiftFirstHalfEnd: "13:30",
  defaultShiftLunchDurationMinutes: 60,
  defaultShiftLunchGraceMinutes: 10,
  lateFreeAllowance: 3,
  permissionMonthlyCap: 3,
  companyWideRulesEditable: true,
};

const segment = (id: number, label: string, startTime: string, endTime: string, shiftValue: number) => ({
  id,
  label,
  startTime,
  endTime,
  shiftValue,
  order: id,
  isActive: true,
});
const PRODUCTION = {
  punch1Time: "08:30",
  punch2Time: "12:45",
  punch3Time: "13:30",
  punch4Time: "20:00",
  graceMinutes: 10,
  updatedAt: null,
  segments: [
    segment(1, "Morning 1", "08:30", "10:30", 0.25),
    segment(2, "Morning 2", "10:30", "12:45", 0.25),
    segment(3, "Afternoon 1", "13:30", "15:30", 0.25),
    segment(4, "Afternoon 2", "15:30", "17:30", 0.25),
    segment(5, "Evening", "17:30", "20:00", 0.5),
  ],
};

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];

beforeEach(() => {
  puts = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open(saved: Record<string, unknown> = SAVED, props: { readOnly?: boolean } = {}) {
  let current = { ...saved };
  page = await renderMdPage(
    () => <AttendanceTab {...props} />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
      "/api/payroll-settings": (_params, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(body);
          current = { ...current, ...body };
        }
        return current;
      },
      "/api/production-shift-config": PRODUCTION,
    },
    { path: "/hr/settings?tab=attendance" },
  );
  return page;
}

const input = (id: string) => page!.container.querySelector<HTMLInputElement>(`#${id}`)!;
const row = (zone: string) =>
  (page!.container.querySelector(`[data-testid="arrival-preview-${zone}"]`)?.textContent ?? "").replace(/\s+/g, " ");
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const labelOf = (id: string) => page!.container.querySelector(`label[for="${id}"]`)?.textContent?.trim();

async function press(name: string) {
  const b = buttonNamed(name);
  if (!b) throw new Error(`no button "${name}"`);
  await act(async () => b.click());
  await page!.settle();
}

describe("Settings -> Attendance", () => {
  it("opens with the agreed numbers and says what they mean for a 09:00 shift with 10 minutes' grace", async () => {
    await open();
    expect(input("arrival-late-window").value).toBe("60");
    expect(input("arrival-permission-window").value).toBe("60");
    expect(input("arrival-extra").value).toBe("20");
    expect(input("arrival-deduction").value).toBe("0.25");
    expect(labelOf("arrival-late-window")).toBe("Late window (minutes)");
    expect(labelOf("arrival-permission-window")).toBe("Permission window (minutes)");
    expect(labelOf("arrival-extra")).toBe("Extra minutes");
    expect(labelOf("arrival-deduction")).toBe("Quarter-shift deduction (shifts)");
    expect(labelOf("half-day-second-half-start")).toBe("Second Half Start Time");
    expect(labelOf("arrival-sample-start")).toBe("Shift start");
    expect(labelOf("arrival-sample-grace")).toBe("Grace (min)");

    expect(row("on_time")).toContain("up to 09:10");
    expect(row("late")).toContain("09:11 - 10:10");
    expect(row("late")).toContain("1.00 shift");
    expect(row("excused")).toContain("09:11 - 11:10 (with a permission)");
    expect(row("quarter")).toContain("10:11 - 11:30");
    expect(row("quarter")).toContain("0.75 shift");
    expect(row("second_half")).toContain("after 11:30");
    expect(row("second_half")).toContain("0.50 shift");

    // the dead settings are not drawn; the headings the other specs look for are there
    const text = page!.text();
    expect(text).not.toContain("First Half End Time");
    expect(text).not.toContain("Default Timings for New Shifts");
    expect(text).not.toContain("Legacy Half-Shift Cutoff");
    expect(text).toContain("Attendance Calculation Mode");
    expect(byTestId("arrival-timeline")).not.toBeNull();
    expect(buttonNamed("Save Attendance Settings")?.disabled).toBe(true); // nothing changed yet
  });

  it("works every example out from what is typed, not from what is saved", async () => {
    await open();
    await page!.type("#arrival-late-window", "30");
    expect(row("late")).toContain("09:11 - 09:40");
    expect(row("quarter")).toContain("09:41 - 11:00");
    expect(row("second_half")).toContain("after 11:00");
    expect(byTestId("first-half-meanings")?.textContent).toContain("11:00 for the example");

    await page!.type("#arrival-deduction", "0.5");
    expect(row("quarter")).toContain("0.50 shift");

    await page!.type("#arrival-sample-start", "14:00");
    await page!.type("#arrival-sample-grace", "5");
    expect(row("on_time")).toContain("up to 14:05");
    expect(row("late")).toContain("14:06 - 14:35");
    expect(byTestId("arrival-preview-warning")).not.toBeNull();
    await page!.type("#half-day-second-half-start", "20:00");
    expect(byTestId("arrival-preview-warning")).toBeNull();
  });

  it("asks before saving, then sends the same keys as always with the new values", async () => {
    await open();
    await page!.type("#arrival-late-window", "45");
    await page!.type("#arrival-permission-window", "30");
    expect(byTestId("save-bar")?.getAttribute("data-dirty")).toBe("true");
    await press("Save Attendance Settings");
    const dialog = byTestId("confirm-save")!;
    expect(dialog.textContent).toContain("Late window");
    expect(dialog.textContent).toContain("60 minutes");
    expect(dialog.textContent).toContain("45 minutes");
    expect(dialog.textContent).toContain("Past days are re-judged");
    expect(puts).toHaveLength(0);

    await press("Confirm and save");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      attendanceMode: "strict",
      arrivalLateWindowMinutes: 45,
      arrivalPermissionWindowMinutes: 30,
      arrivalExtraMinutes: 20,
      arrivalQuarterDeduction: 0.25,
      halfDaySecondHalfStartTime: "14:30",
      simpleHalfShiftCutoff: "13:30",
      defaultShiftGraceMinutes: 15,
      prodFirstHalfStart: "08:30",
    });
    expect("halfDayFirstHalfEndTime" in puts[0]).toBe(false);
    expect("morningLateInEnabled" in puts[0]).toBe(false); // not flipped, so not sent
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Attendance settings saved" }));
    expect(byTestId("save-bar")?.getAttribute("data-dirty")).toBe("false");
  });

  it("refuses a value out of range before anything is sent, and Discard puts the saved values back", async () => {
    await open();
    await page!.type("#arrival-late-window", "300");
    expect(byTestId("arrival-error")?.textContent).toContain(
      "Late window must be a whole number of minutes between 0 and 240",
    );
    expect(buttonNamed("Save Attendance Settings")?.disabled).toBe(true);
    await press("Discard changes");
    expect(input("arrival-late-window").value).toBe("60");
    expect(byTestId("arrival-error")).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it("sends a switch only when it was flipped, and the mode cards choose the mode", async () => {
    await open();
    await page!.click("#evening-early-out-switch");
    await page!.click('[data-testid="attendance-mode-simple"]');
    await press("Save Attendance Settings");
    expect(byTestId("confirm-save")?.textContent).toContain("Evening Early-Out marks");
    await press("Confirm and save");
    expect(puts[0]).toMatchObject({ eveningEarlyOutEnabled: true, attendanceMode: "simple" });
    expect("morningLateInEnabled" in puts[0]).toBe(false);
  });

  it("shows a branch login the company-wide rules read-only and never sends them", async () => {
    await open({ ...SAVED, companyWideRulesEditable: false });
    expect(input("arrival-late-window").disabled).toBe(true);
    expect(input("half-day-second-half-start").disabled).toBe(true);
    expect(byTestId("company-wide-note-arrival")).not.toBeNull();
    expect(byTestId("company-wide-note-half-day")).not.toBeNull();
    expect(byTestId("company-wide-note-late")).not.toBeNull();
    expect(byTestId("attendance-branch-note")).not.toBeNull();
    await page!.type("#night-late-window-minutes", "45");
    await press("Save Attendance Settings");
    await press("Confirm and save");
    expect(puts[0].afternoonLateWindowMinutes).toBe(45);
    for (const key of ["arrivalLateWindowMinutes", "halfDaySecondHalfStartTime", "morningLateInEnabled"]) {
      expect(key in puts[0]).toBe(false);
    }
  });

  it("draws the lunch-return bands and the after-midnight cut-off from what is typed", async () => {
    await open();
    // out for lunch 13:10 on the example shift, due back 14:10: Night Late for 60 min, then a 60-min permission band
    const bands = () => (byTestId("lunch-zone-bands")?.textContent ?? "").replace(/\s+/g, " ");
    expect(bands()).toContain("14:11 - 15:10");
    expect(bands()).toContain("15:11 - 16:10");
    expect(bands()).toContain("After 16:10");
    await page!.type("#lunch-permission-zone-minutes", "0");
    expect(bands()).toContain("After 15:10");
    expect(bands()).toContain("no permission band");
    await page!.type("#night-late-window-minutes", "0"); // the engine reads 0 as 60
    expect(bands()).toContain("14:11 - 15:10");

    // 18:00 end + 9 h reaches 03:00; 2 h before Tuesday's 09:00 start is 07:00, so the grace decides
    const protection = () => (byTestId("protection-preview")?.textContent ?? "").replace(/\s+/g, " ");
    expect(protection()).toContain("03:00 next day");
    expect(protection()).toContain("nothing after 07:00 next day");
    expect(protection()).toContain("the grace decides");
    await page!.type("#early-arrival-protection-hours", "7");
    expect(protection()).toContain("02:00 next day (the protection decides)");
    await page!.type("#forgotten-last-out-hours", "0");
    expect(protection()).toContain("the grace above is 0");
  });

  it("explains production and links to the Production Shifts tab instead of repeating its editor", async () => {
    await open();
    expect(buttonNamed("Save Punch Times")).toBeUndefined();
    expect(byTestId("production-managed-elsewhere")?.querySelector("a")?.getAttribute("href")).toBe(
      "/hr/settings?tab=production_shifts",
    );
    const text = page!.text();
    expect(text).toContain("Evening");
    expect(text).toContain("1.00 shift = ₹600"); // 08:35, 12:50, 13:35, 17:35
    expect(text).toContain("1.50 shift = ₹900"); // ... staying until 19:55
  });

  it("lets a view-only role try values but not save them", async () => {
    await open(SAVED, { readOnly: true });
    await page!.type("#arrival-late-window", "30");
    expect(row("late")).toContain("09:11 - 09:40");
    expect(buttonNamed("Save Attendance Settings")?.disabled).toBe(true);
  });

  it("has a search entry for every setting it draws, with the same title and words", async () => {
    await open();
    const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]); // a block and its control never share an id
    const blocks = [...page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")];
    expect(blocks.map((b) => b.dataset.settingId).sort()).toEqual(ATTENDANCE_SETTINGS.map((m) => m.id).sort());
    for (const meta of ATTENDANCE_SETTINGS) {
      const block = blocks.find((b) => b.dataset.settingId === meta.id)!;
      expect(block.querySelector("h4")?.textContent?.trim(), meta.id).toBe(meta.title);
      expect(block.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta.id).toBe(meta.purpose);
      const section = block.closest("section:not([data-setting-id])");
      expect(section?.querySelector("h3")?.textContent?.trim(), meta.id).toBe(meta.section);
    }
  });
});
