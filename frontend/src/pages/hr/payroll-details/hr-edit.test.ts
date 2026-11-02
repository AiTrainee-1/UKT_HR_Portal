import { describe, expect, it } from "vitest";
import type { OffDay } from "@/lib/api-client/custom-hooks";
import { hrEdit } from "./edit-fixtures";
import { HR_EDIT_TONE, changeText, hrEditCounts, hrEditLabel, hrEditTone, sideText, whoWhen } from "./hr-edit";
import { dayKind, offDayAsDay } from "./logic";

// The "!" of a day HR edited: its colour by stage, what it says, and that an off day carries it too.

describe("the stage of an HR edit", () => {
  it("is amber while it waits, green once applied, rose when rejected", () => {
    expect(hrEditTone("waiting_hod")).toBe("waiting");
    expect(hrEditTone("waiting_hr")).toBe("waiting");
    expect(hrEditTone("applied")).toBe("applied");
    expect(hrEditTone("rejected")).toBe("rejected");
    expect(HR_EDIT_TONE.waiting.badge).toContain("bg-amber-500");
    expect(HR_EDIT_TONE.applied.badge).toContain("bg-emerald-600");
    expect(HR_EDIT_TONE.rejected.badge).toContain("bg-rose-600");
  });

  it("counts the days in each state", () => {
    expect(
      hrEditCounts([
        { hrEdit: hrEdit() },
        { hrEdit: hrEdit({ status: "waiting_hr" }) },
        { hrEdit: hrEdit({ status: "applied" }) },
        { hrEdit: null },
        {},
      ]),
    ).toEqual({ waiting: 2, applied: 1, rejected: 0 });
  });
});

describe("what the ! says", () => {
  it("words the change with its shifts", () => {
    expect(sideText({ label: "Present", shifts: 1 })).toBe("Present (1 shift)");
    expect(sideText({ label: "Half Day", shifts: 0.5 })).toBe("Half Day (0.5 shifts)");
    expect(sideText({ label: "Absent", shifts: 0 })).toBe("Absent");
    expect(sideText({ label: "Mark as Late", shifts: null })).toBe("Mark as Late");
    expect(sideText({ label: "", shifts: null })).toBe("Not recorded");
    expect(changeText(hrEdit())).toBe("Present (1 shift) → Half Day (0.5 shifts)");
  });

  it("names who and when, and its accessible name carries the type and the stage", () => {
    expect(whoWhen("Meena", "2026-11-02T06:30:00Z")).toMatch(/^Meena · 2 Nov 2026, \d\d:\d\d$/);
    expect(whoWhen("Meena", null)).toBe("Meena");
    expect(whoWhen(null, null)).toBeNull();
    expect(whoWhen(null, "not a date")).toBeNull();
    expect(hrEditLabel(hrEdit())).toBe("HR edit: Half Day. Waiting for Department Head (Suresh Raj)");
  });
});

describe("an off day HR edited", () => {
  it("carries the edit from the off day itself, or from its worked attendance, without changing its kind", () => {
    const sunday: OffDay = {
      date: "2026-11-08",
      kind: "weekly_off",
      name: null,
      attendance: null,
      hrEdit: hrEdit({ typeLabel: "Sunday Compensation" }),
    };
    const day = offDayAsDay(sunday);
    expect(day.hrEdit?.typeLabel).toBe("Sunday Compensation");
    expect(dayKind(day)).toBe("weekoff");

    const worked: OffDay = {
      date: "2026-11-15",
      kind: "weekly_off",
      name: null,
      hrEdit: hrEdit({ requestId: 1 }),
      attendance: {
        date: "2026-11-15",
        day: "Sunday",
        status: "present",
        firstIn: "09:00",
        lastOut: "17:00",
        shifts: 1,
        flags: [],
        note: null,
        isSunday: true,
        hrEdit: hrEdit({ requestId: 2, status: "applied" }),
      },
    };
    expect(offDayAsDay(worked).hrEdit?.requestId).toBe(2);
    expect(dayKind(offDayAsDay(worked))).toBe("sunday_worked");
    // an off day nobody edited gets no hrEdit key at all
    expect(offDayAsDay({ date: "2026-11-22", kind: "weekly_off", name: null, attendance: null })).not.toHaveProperty(
      "hrEdit",
    );
  });
});
