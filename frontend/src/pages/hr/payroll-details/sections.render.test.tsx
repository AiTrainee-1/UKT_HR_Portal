import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollDay, PayrollDetails } from "@/lib/api-client/custom-hooks";
import { productionDetails, staffDetails } from "./fixtures";
import {
  choose,
  click,
  installBrowserStubs,
  installWorld,
  must,
  openLoaded,
  q,
  settle,
  text,
  unmountPage,
  type World,
} from "./harness";

// The sections of the details page in jsdom, one by one: the calendar (with the six attendance categories) and the
// table of days, and the extras on the pay. (The Issues section was taken off the page, owner 2026-11-24.)

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok", user: null }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;
let scroll: ReturnType<typeof vi.fn>;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  world = installWorld(h.fetch);
  scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  unmountPage();
  vi.restoreAllMocks();
});

const openStaff = (suffix = "") => openLoaded(`/hr/payroll/details/101${suffix}`, { fromPayroll: true });
const openProduction = () => openLoaded("/hr/production-payroll/details/301", { fromPayroll: true });

describe("the days of the period", () => {
  const cell = (date: string) => must(`pd-day-${date}`);

  it("lays the month out as a calendar, Monday first, a coloured cell per day", async () => {
    await openStaff();
    const cells = [...document.body.querySelectorAll<HTMLElement>('[data-testid^="pd-day-2026-"]')];
    expect(cells).toHaveLength(31);
    // each day sits in a bordered box of its own; the week row starts with a gutter naming the week
    const weekRow = cell("2026-10-01").closest("[data-week]")!;
    expect(weekRow.getAttribute("data-week")).toBe("1");
    expect(weekRow.firstElementChild!.textContent).toBe("W1");
    const firstWeek = [...weekRow.children]
      .slice(1)
      .map((c) => c.firstElementChild!.getAttribute("data-testid") ?? "blank");
    expect(firstWeek).toEqual([
      "blank",
      "blank",
      "blank",
      "pd-day-2026-10-01",
      "pd-day-2026-10-02",
      "pd-day-2026-10-03",
      "pd-day-2026-10-04",
    ]);
    expect(text(q("pd-calendar"))).toContain("MonTueWedThuFriSatSun");
    // staff payroll lists the working days only: the 2 Oct holiday and the Sundays have no record
    const kinds: Record<string, string> = {
      "2026-10-01": "present",
      "2026-10-02": "none",
      "2026-10-04": "none",
      "2026-10-06": "absent",
      "2026-10-07": "unpaid",
      "2026-10-08": "leave",
      "2026-10-13": "late",
      "2026-10-20": "early",
      "2026-10-22": "half",
    };
    for (const [date, kind] of Object.entries(kinds)) expect(cell(date).dataset.kind, date).toBe(kind);
    // a day with no record is not a button, and says why it is empty
    expect(cell("2026-10-02").tagName).toBe("DIV");
    expect(cell("2026-10-02").title).toBe("Fri, 2 Oct 2026: not a working day, or no record");
    expect(text(cell("2026-10-02"))).toBe("2");
    expect(document.body.querySelectorAll('button[data-testid^="pd-day-2026-"]')).toHaveLength(26);
  });

  it("a cell shows the day, a letter for its kind, the punches and a tag per category, and says it all to a screen reader", async () => {
    await openStaff();
    const late = cell("2026-10-13");
    expect(text(late)).toContain("13");
    expect(text(late)).toContain("L");
    expect(text(late)).toContain("09:42–18:07");
    expect(late.querySelectorAll("[data-mark]")).toHaveLength(1); // one category, one tag
    expect(late.getAttribute("aria-label")).toBe(
      "Tue, 13 Oct 2026: Late In. first in 09:42, last out 18:07. flagged: Late arrival",
    );
    expect(cell("2026-10-22").getAttribute("aria-label")).toContain("Half day");
    expect(text(cell("2026-10-22"))).toContain("0.5 shifts");
    expect(text(cell("2026-10-01"))).not.toContain("shift"); // a full staff day needs no shift count
    expect(cell("2026-10-06").getAttribute("aria-label")).toBe("Tue, 6 Oct 2026: Absent. flagged: Absent");
    // a day with no last punch says so in words, not as stray dashes
    expect(text(cell("2026-10-27"))).toContain("in 09:02");
    expect(text(cell("2026-10-27"))).not.toContain("—");
    expect(cell("2026-10-27").getAttribute("aria-label")).toBe(
      "Tue, 27 Oct 2026: Present. first in 09:02. Missed punch. flagged: Missing punch",
    );
  });

  it("the status legend counts the days whose cell shows that status and doubles as a filter that dims the rest", async () => {
    await openStaff();
    const legend = (k: string) => text(q(`pd-legend-${k}`));
    // a day with a late, permission, On-Duty or missed-punch category is filled in that category's colour, so it is counted
    // under the category: 17 present days, 5 of them filled by a category; the 3 late days all are
    expect(legend("present")).toBe("Present12");
    expect(legend("late")).toBe("Late In0");
    expect(legend("early")).toBe("Early Out1");
    expect(legend("half")).toBe("Half day1");
    expect(legend("absent")).toBe("Absent1");
    expect(legend("unpaid")).toBe("Unpaid leave1");
    expect(legend("leave")).toBe("Paid leave2");
    // every kind of day is in the key, in a colour of its own; one nothing in the period used is greyed out
    for (const k of ["holiday", "onleave", "casual", "onduty", "comp", "sunday_comp", "ot_comp", "weekoff", "other"]) {
      expect((must(`pd-legend-${k}`) as HTMLButtonElement).disabled, k).toBe(true);
    }
    expect(legend("casual")).toBe("Casual Leave0");
    // the dashed cells are explained, with how many there are (not a filter: there is nothing to filter on)
    expect(text(q("pd-legend-norecord"))).toBe("Not a working day5");
    expect(q("pd-legend-norecord")!.tagName).toBe("SPAN");
    click(q("pd-legend-absent"));
    expect(must("pd-legend-absent").getAttribute("aria-pressed")).toBe("true");
    expect(cell("2026-10-13").className).toContain("opacity-30");
    expect(cell("2026-10-06").className).not.toContain("opacity-30");
    // a plain present day is dimmed by "Present" only when it is not the one chosen; a category day is not a "present" cell
    click(q("pd-legend-present"));
    expect(cell("2026-10-01").className).not.toContain("opacity-30");
    expect(cell("2026-10-15").className).toContain("opacity-30"); // filled by Permission, not by Present
    click(q("pd-legend-present")); // pressing it again lifts the filter
    expect(cell("2026-10-15").className).not.toContain("opacity-30");
  });

  it("fills the cell of a day with the colour of its attendance category, and tags every category the day carries", async () => {
    await openStaff();
    const fill = (date: string) => cell(date).dataset.fill;
    // one colour of its own for each of the six categories
    expect(fill("2026-10-15")).toBe("permission");
    expect(cell("2026-10-15").className).toContain("bg-blue-100");
    expect(fill("2026-10-19")).toBe("excess_permission");
    expect(cell("2026-10-19").className).toContain("bg-rose-200");
    expect(fill("2026-10-21")).toBe("on_duty");
    expect(cell("2026-10-21").className).toContain("bg-teal-100");
    expect(fill("2026-10-16")).toBe("on_duty_punch"); // On-Duty AND an approved geo-punch: the punch colours the cell
    expect(cell("2026-10-16").className).toContain("bg-indigo-100");
    expect(fill("2026-10-27")).toBe("missed_punch"); // payroll flagged a missing punch
    expect(cell("2026-10-27").className).toContain("bg-fuchsia-100");
    expect(fill("2026-10-13")).toBe("late");
    expect(cell("2026-10-13").className).toContain("bg-amber-100");
    // a plain day keeps its status colour and has no tag
    expect(fill("2026-10-01")).toBeUndefined();
    expect(cell("2026-10-01").className).toContain("bg-emerald-50");
    expect(cell("2026-10-01").querySelectorAll("[data-mark]")).toHaveLength(0);
    // every category of a day is a tag, in one fixed order
    const tags = (date: string) =>
      [...cell(date).querySelectorAll<HTMLElement>("[data-mark]")].map((t) => t.dataset.mark);
    expect(tags("2026-10-16")).toEqual(["on_duty", "on_duty_punch"]);
    expect(tags("2026-10-14")).toEqual(["late", "permission"]);
    expect(fill("2026-10-14")).toBe("permission"); // late and permission: the permission colours it, the late tag stays
    expect(text(cell("2026-10-14"))).toContain("Late");
    expect(text(cell("2026-10-14"))).toContain("Permission");
    // a day that was not worked, or cut to half, keeps the colour of that: it is what the pay follows
    expect(fill("2026-10-22")).toBeUndefined();
    // a half day: split half red (not worked) / half green (worked), apart from Late In's amber and a holiday's blend
    expect(cell("2026-10-22").className).toContain("from-red-300 from-50% to-emerald-300 to-50%");
    expect(tags("2026-10-22")).toEqual(["permission"]);
    expect(cell("2026-10-06").className).toContain("bg-red-100");
    expect(cell("2026-10-16").getAttribute("aria-label")).toContain("On-Duty, On-Duty punch");
  });

  it("the attendance-types legend names all six, counts the days of each and doubles as a filter", async () => {
    await openStaff();
    const legend = (k: string) => text(q(`pd-mark-legend-${k}`));
    // Late In has its own colour among the day types, so the categories left here are the other five
    expect(q("pd-mark-legend-late")).toBeNull();
    expect(legend("permission")).toBe("Permission3");
    expect(legend("excess_permission")).toBe("Excess permission1");
    expect(legend("on_duty")).toBe("On-Duty2");
    expect(legend("on_duty_punch")).toBe("On-Duty punch1");
    expect(legend("missed_punch")).toBe("Missed punch1");
    expect(must("pd-mark-legend-on_duty").title).toBe("The day was inside an approved On-Duty (field visit) request.");
    click(q("pd-mark-legend-permission"));
    expect(must("pd-mark-legend-permission").getAttribute("aria-pressed")).toBe("true");
    for (const date of ["2026-10-14", "2026-10-15", "2026-10-22"]) {
      expect(cell(date).className, date).not.toContain("opacity-30");
    }
    expect(cell("2026-10-01").className).toContain("opacity-30");
    expect(cell("2026-10-16").className).toContain("opacity-30");
    click(q("pd-days-clear"));
    expect(cell("2026-10-01").className).not.toContain("opacity-30");
    expect(q("pd-days-clear")).toBeNull();
  });

  it("a category nothing in the period used is listed too, greyed out", async () => {
    world.staff.set(101, staffDetails({ days: staffDetails().days.map((d) => ({ ...d, marks: [], flags: [] })) }));
    await openStaff();
    for (const key of ["permission", "excess_permission", "on_duty", "on_duty_punch", "missed_punch"]) {
      expect(q(`pd-mark-legend-${key}`), key).not.toBeNull();
    }
    expect((must("pd-mark-legend-on_duty") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the table does not carry the category legend and keeps its own filters, and a view switch starts the filters again", async () => {
    await openStaff();
    click(q("pd-mark-legend-permission"));
    click(q("pd-view-table"));
    expect(q("pd-mark-legend")).toBeNull();
    expect(document.body.querySelectorAll('tr[data-testid^="pd-row-"]')).toHaveLength(26);
    click(q("pd-view-calendar"));
    expect(must("pd-mark-legend-permission").getAttribute("aria-pressed")).toBe("false");
  });

  it("says what each category on the chosen day means", async () => {
    await openStaff();
    click(cell("2026-10-16"));
    const marks = must("pd-day-marks");
    expect([...marks.querySelectorAll<HTMLElement>("[data-mark]")].map((m) => m.dataset.mark)).toEqual([
      "on_duty",
      "on_duty_punch",
    ]);
    expect(text(marks)).toContain("The day was inside an approved On-Duty (field visit) request.");
    expect(text(marks)).toContain("A geo-punch taken during an On-Duty request was approved");
    click(cell("2026-10-01"));
    expect(q("pd-day-marks")).toBeNull();
  });

  it("Flagged only dims every day nothing was flagged on, and Clear lifts it", async () => {
    await openStaff();
    expect(text(q("pd-flagged-only"))).toBe("Flagged only 8");
    expect(q("pd-days-clear")).toBeNull();
    click(q("pd-flagged-only"));
    expect(cell("2026-10-01").className).toContain("opacity-30");
    expect(cell("2026-10-13").className).not.toContain("opacity-30");
    expect(cell("2026-10-20").className).not.toContain("opacity-30"); // early leaving, still a present day
    click(q("pd-days-clear"));
    expect(cell("2026-10-01").className).not.toContain("opacity-30");
    expect(q("pd-days-clear")).toBeNull();
  });

  it("choosing a day shows what happened on it", async () => {
    await openStaff();
    click(cell("2026-10-13"));
    expect(cell("2026-10-13").dataset.selected).toBe("true");
    const panel = text(q("pd-day-panel"));
    expect(panel).toContain("Tue, 13 Oct 2026");
    expect(panel).toContain("Late");
    expect(panel).toContain("First in 09:42");
    expect(panel).toContain("Last out 18:07");
    expect(panel).toContain("Shifts 1");
    expect(panel).toContain("Morning late-in: first punch 09:42 is after the 09:10 deadline"); // the day's own note
    expect(panel).toContain("First punch 09:42, after General 09:00 + 10 min grace (09:10)");
    // no link to an Issues list: the page has none any more
    expect(q("pd-day-show-issues")).toBeNull();
    // another day moves the selection; the same day again lifts it
    click(cell("2026-10-20"));
    expect(cell("2026-10-13").dataset.selected).toBe("false");
    expect(cell("2026-10-20").dataset.selected).toBe("true");
    click(cell("2026-10-20"));
    expect(q("pd-day-panel")).toBeNull();
  });

  it("a day with nothing flagged says so, a day with no record cannot be chosen, and the panel closes", async () => {
    await openStaff();
    click(cell("2026-10-01"));
    expect(text(q("pd-day-panel"))).toContain("Nothing was flagged on this day.");
    expect(q("pd-day-show-issues")).toBeNull();
    click(cell("2026-10-02")); // a holiday: no record, nothing to choose
    expect(cell("2026-10-01").dataset.selected).toBe("true");
    expect(text(q("pd-day-panel"))).toContain("Thu, 1 Oct 2026");
    click(document.body.querySelector('[aria-label="Close the day"]'));
    expect(q("pd-day-panel")).toBeNull();
  });

  it("the table view has a row per day, with the status, punches, shifts, flags and note", async () => {
    await openStaff();
    click(q("pd-view-table"));
    expect(q("pd-calendar")).toBeNull();
    expect(must("pd-view-table").getAttribute("aria-pressed")).toBe("true");
    const rows = [...document.body.querySelectorAll<HTMLElement>('tr[data-testid^="pd-row-"]')];
    expect(rows).toHaveLength(26); // the working days, as many as payroll recorded
    expect(q("pd-row-2026-10-04")).toBeNull(); // a Sunday has no entry
    const late = [...must("pd-row-2026-10-13").querySelectorAll("td")].map(text);
    expect(late.slice(0, 7)).toEqual(["13 Oct 2026", "Tue", "Late In", "09:42", "18:07", "1", "Late arrival"]);
    expect(late[7]).toBe("Morning late-in: first punch 09:42 is after the 09:10 deadline");
    const half = [...must("pd-row-2026-10-22").querySelectorAll("td")].map(text);
    expect(half[2]).toBe("Half day"); // a present day at half a shift, with a half-day issue on it
    expect(half[5]).toBe("0.5");
    expect(half[6]).toBe("Half day"); // the flag
    const leave = [...must("pd-row-2026-10-08").querySelectorAll("td")].map(text);
    expect(leave.slice(2, 6)).toEqual(["Paid leave", "—", "—", "0"]);
    expect(must("pd-days-table").className).toContain("overflow-x-auto");
  });

  it("the table filters by flagged only and by status, and says when no day matches", async () => {
    await openStaff();
    click(q("pd-view-table"));
    click(q("pd-flagged-only"));
    expect(document.body.querySelectorAll('tr[data-testid^="pd-row-"]')).toHaveLength(8);
    const select = must("pd-status-filter") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All statuses (26)",
      "Present (17)",
      "Late In (3)",
      "Early Out (1)",
      "Half day (1)",
      "Unpaid leave (1)",
      "Paid leave (2)",
      "Absent (1)",
    ]);
    choose(select, "late");
    expect(document.body.querySelectorAll('tr[data-testid^="pd-row-"]')).toHaveLength(3);
    choose(select, "present");
    expect(
      [...document.body.querySelectorAll<HTMLElement>('tr[data-testid^="pd-row-"]')].map((r) => r.dataset.testid),
    ).toEqual(["pd-row-2026-10-27"]);
    choose(select, "leave"); // the two days of paid leave have nothing flagged on them
    expect(text(q("pd-days-empty"))).toContain("No day matches these filters");
    choose(select, "all");
    click(q("pd-flagged-only"));
    expect(document.body.querySelectorAll('tr[data-testid^="pd-row-"]')).toHaveLength(26);
    click(q("pd-view-calendar"));
    expect(q("pd-calendar")).not.toBeNull();
  });

  it("a production period is its week of shifts", async () => {
    await openProduction();
    expect(text(q("pd-section-attendance"))).toContain("Shifts in this period");
    const week = [...must("pd-day-2026-10-05").closest("[data-week]")!.children]
      .slice(1)
      .map((c) => c.firstElementChild!.getAttribute("data-testid"));
    expect(week).toEqual([
      "pd-day-2026-10-05",
      "pd-day-2026-10-06",
      "pd-day-2026-10-07",
      "pd-day-2026-10-08",
      "pd-day-2026-10-09",
      "pd-day-2026-10-10",
      "pd-day-2026-10-11",
    ]);
    expect(cell("2026-10-08").dataset.kind).toBe("half");
    expect(text(cell("2026-10-08"))).toContain("0.5 shifts");
    expect(text(cell("2026-10-05"))).toContain("1 shift"); // production is paid per shift: a full day says so too
    expect(text(cell("2026-10-11"))).not.toContain("shift"); // a day off earned none
    expect(cell("2026-10-10").dataset.kind).toBe("absent");
    expect(cell("2026-10-11").dataset.kind).toBe("holiday");
  });

  it("says so when no days were stored", async () => {
    world.staff.set(101, staffDetails({ days: [] }));
    await openStaff();
    expect(text(q("pd-attendance-empty"))).toContain("No day records were stored for this payroll");
    expect(q("pd-view-table")).toBeNull();
  });

  // The details endpoint does not send the compensation marker today (payroll_insights.py builds a day from the stored
  // breakdown, which has none), so the page draws it only when a day carries it: these days are the shape it would take.
  describe("a day that used a compensation", () => {
    const withMarkers = () => {
      const base = staffDetails();
      world.staff.set(
        101,
        staffDetails({
          days: base.days.map((d) =>
            d.date === "2026-10-13"
              ? {
                  ...d,
                  compensationKind: "ot_allowance" as const,
                  compensationMinutes: 30,
                  compensationNote: "Arrived 09:42, inside the 30 min allowance.",
                }
              : d.date === "2026-10-22"
                ? { ...d, compensationKind: "relaxation" as const, compensationNote: "0.5 shift relaxation applied." }
                : d,
          ),
        }),
      );
    };

    it("is marked in the calendar with a symbol, a screen-reader sentence and a legend", async () => {
      withMarkers();
      await openStaff();
      const ot = cell("2026-10-13");
      expect(ot.querySelector('[data-testid="compensation-symbol-ot_allowance"]')?.textContent).toBe("OT");
      expect(ot.getAttribute("aria-label")).toBe(
        "Tue, 13 Oct 2026: Late In. OT allowance used (30 min): Arrived 09:42, inside the 30 min allowance. first in 09:42, last out 18:07. flagged: Late arrival",
      );
      expect(cell("2026-10-22").querySelector('[data-testid="compensation-symbol-relaxation"]')?.textContent).toBe(
        "RX",
      );
      expect(cell("2026-10-01").querySelector('[data-testid^="compensation-symbol-"]')).toBeNull();
      const legend = q("compensation-legend");
      expect(legend).not.toBeNull();
      expect(text(q("compensation-legend-ot_allowance"))).toContain("×1");
      expect(text(q("compensation-legend-relaxation"))).toContain("×1");
      expect(q("compensation-legend-birthday")).toBeNull();
    });

    it("is a chip with its note when the day is chosen, and a chip in the table", async () => {
      withMarkers();
      await openStaff();
      click(cell("2026-10-13"));
      const panel = must("pd-day-panel");
      expect(text(panel.querySelector('[data-testid="compensation-chip-ot_allowance"]'))).toContain(
        "OT allowance used (30 min)",
      );
      expect(text(panel.querySelector('[data-testid="compensation-note"]'))).toBe(
        "Arrived 09:42, inside the 30 min allowance.",
      );
      click(q("pd-view-table"));
      expect(text(must("pd-row-2026-10-13").querySelector('[data-testid="compensation-chip-ot_allowance"]'))).toContain(
        "OT allowance used (30 min)",
      );
      expect(text(must("pd-row-2026-10-22").querySelector('[data-testid="compensation-chip-relaxation"]'))).toContain(
        "Relaxation (compensation day)",
      );
      expect(must("pd-row-2026-10-01").querySelector('[data-testid^="compensation-chip-"]')).toBeNull();
    });

    it("leaves a payroll whose days carry no marker exactly as it was", async () => {
      await openStaff();
      expect(document.body.querySelector('[data-testid^="compensation-"]')).toBeNull();
    });
  });
});

describe("the calendar's kinds of day, Sync and the salary split-up", () => {
  const cell = (date: string) => must(`pd-day-${date}`);
  const withDays = (over: Record<string, Partial<PayrollDay>>, extra: Partial<PayrollDetails> = {}) => {
    const base = staffDetails();
    world.staff.set(
      101,
      staffDetails({
        ...extra,
        days: base.days.map((d) => (over[d.date] ? { ...d, ...over[d.date] } : d)),
      }),
    );
  };

  it("shows a holiday by its own name, a Sunday as the weekly off, and what was worked on a Sunday", async () => {
    world.staff.set(
      101,
      staffDetails({
        offDays: [
          { date: "2026-10-02", kind: "holiday", name: "Gandhi Jayanti", attendance: null },
          { date: "2026-10-04", kind: "weekly_off", name: null, attendance: null },
          {
            date: "2026-10-11",
            kind: "weekly_off",
            name: null,
            attendance: {
              date: "2026-10-11",
              day: "Sunday",
              status: "present",
              firstIn: "09:00",
              lastOut: "17:30",
              shifts: 1,
              flags: [],
              marks: [],
              note: null,
              isSunday: true,
              compensationType: "sunday_compensation",
            },
          },
        ],
      }),
    );
    await openStaff();
    expect(cell("2026-10-02").dataset.kind).toBe("holiday");
    expect(text(cell("2026-10-02"))).toContain("Gandhi Jayanti");
    expect(cell("2026-10-02").getAttribute("aria-label")).toContain("Gandhi Jayanti");
    // a Sunday nobody worked is the quiet weekly off, not an empty box
    expect(cell("2026-10-04").dataset.kind).toBe("weekoff");
    expect(text(cell("2026-10-04"))).toContain("Sunday");
    // a Sunday somebody worked shows what they did (with its compensation), not "holiday"
    expect(cell("2026-10-11").dataset.kind).toBe("sunday_worked");
    expect(cell("2026-10-11").className).toContain("from-orange-200");
    // a Sunday nobody worked is a plain blank cell; a holiday is always the pink-to-green gradient
    expect(cell("2026-10-04").className).not.toContain("gradient");
    expect(cell("2026-10-02").className).toContain("from-pink-200");
    expect(text(cell("2026-10-11"))).toContain("09:00–17:30");
    expect(text(cell("2026-10-11"))).toContain("Worked on a day off");
    click(cell("2026-10-02"));
    expect(text(q("pd-day-facts"))).toContain("Holiday: Gandhi Jayanti.");
  });

  it("tells Casual Leave, Late In, Early Out and the other kinds apart, each in its own colour", async () => {
    withDays({
      "2026-10-01": { casualLeave: true },
      "2026-10-03": { isEarlyOut: true },
      "2026-10-05": { compensationType: "ot_compensation" },
      "2026-10-12": { compensationType: "compensation" },
    });
    await openStaff();
    expect(cell("2026-10-01").dataset.kind).toBe("casual");
    expect(cell("2026-10-01").className).toContain("bg-sky-100");
    expect(text(cell("2026-10-01"))).toContain("Casual Leave");
    expect(cell("2026-10-03").dataset.kind).toBe("early");
    expect(cell("2026-10-03").className).toContain("bg-fuchsia-100");
    expect(cell("2026-10-05").className).toContain("bg-indigo-100");
    expect(cell("2026-10-12").className).toContain("bg-lime-100");
    expect(cell("2026-10-13").className).toContain("bg-amber-100"); // Late In
    expect(text(q("pd-legend-casual"))).toBe("Casual Leave1");
    expect(text(q("pd-legend-ot_comp"))).toBe("OT Compensation1");
  });

  it("shows today's unfinished day as In progress: the first punch, no verdict, no shift count, counted after the shift", async () => {
    // a production payroll would show "1 shift" on a full day; a day still running must show none
    withDays({
      "2026-10-01": {
        status: "present",
        shifts: 1,
        firstIn: "09:06",
        lastOut: "13:02",
        inProgress: true,
        provisionalUntil: "2026-10-01T18:11:00+05:30",
      },
      // provisionalUntil still set, but its moment has passed: only inProgress decides, so this is an ordinary day
      "2026-10-05": { inProgress: false, provisionalUntil: "2026-10-05T18:11:00+05:30" },
    });
    await openStaff();
    expect(cell("2026-10-01").dataset.kind).toBe("inprogress");
    expect(text(cell("2026-10-01"))).toContain("In progress");
    expect(text(cell("2026-10-01"))).toContain("In 09:06 · at work");
    expect(text(cell("2026-10-01"))).not.toContain("13:02");
    expect(text(cell("2026-10-01"))).not.toMatch(/\d shifts?/);
    expect(cell("2026-10-01").getAttribute("aria-label")).toContain("Counted after the shift ends at 18:11");
    expect(must("pd-in-progress-2026-10-01").getAttribute("title")).toBe("Counted after the shift ends at 18:11");
    expect(cell("2026-10-05").dataset.kind).not.toBe("inprogress");
    // the legend lists it apart (not as a Present day) only while such a day is shown
    expect(text(q("pd-legend-inprogress"))).toBe("In progress1");
    // the day panel: the chip instead of Present, the first punch only, shifts as a dash
    click(cell("2026-10-01"));
    expect(q("pd-day-in-progress")).not.toBeNull();
    expect(text(q("pd-day-at-work"))).toBe("In 09:06 · at work");
    const panel = text(q("pd-day-panel"));
    expect(panel).toContain("Shifts —");
    expect(panel).not.toContain("Shifts 1");
    expect(panel).not.toContain("Last out");
    // the table: the chip, the first punch, no last out, shifts "—"
    click(q("pd-view-table"));
    const row = [...must("pd-row-2026-10-01").querySelectorAll("td")].map(text);
    expect(row[2]).toContain("In progress");
    expect(row[3]).toBe("In 09:06 · at work");
    expect(row[4]).toBe("—");
    expect(row[5]).toBe("—");
    expect(must("pd-row-shifts-2026-10-01").getAttribute("title")).toBe("Counted after the shift ends at 18:11");
  });

  it("a production day still running shows no shift count, where a settled full day says 1 shift", async () => {
    const base = productionDetails();
    world.production.set(
      301,
      productionDetails({
        days: base.days.map((d) =>
          d.date === "2026-10-05" ? { ...d, inProgress: true, provisionalUntil: "2026-10-05T18:11:00+05:30" } : d,
        ),
      }),
    );
    await openProduction();
    expect(cell("2026-10-05").dataset.kind).toBe("inprogress");
    expect(text(cell("2026-10-05"))).not.toMatch(/\d shifts?/);
    expect(text(cell("2026-10-06"))).toMatch(/\d shifts?/);
  });

  it("lists no In progress legend entry when no day is still running", async () => {
    await openStaff();
    expect(q("pd-legend-inprogress")).toBeNull();
  });

  it("does not count an On-Duty day as worked until HR approved it and the punches are there", async () => {
    withDays({
      "2026-10-06": {
        status: "absent",
        shifts: 0,
        onDuty: { state: "no_punches", label: "On-Duty approved; no punches yet", destination: "Erode mill" },
      },
      "2026-10-07": {
        status: "absent",
        shifts: 0,
        onDuty: { state: "pending", label: "On-Duty request awaiting approval", destination: "" },
      },
      "2026-10-08": {
        status: "present",
        shifts: 1,
        onDuty: { state: "verified", label: "On-Duty approved and punched", destination: "Tiruppur" },
      },
    });
    await openStaff();
    expect(cell("2026-10-06").dataset.kind).toBe("onduty_pending");
    expect(text(cell("2026-10-06"))).toContain("no punches yet");
    expect(cell("2026-10-07").dataset.kind).toBe("onduty_pending");
    expect(cell("2026-10-08").dataset.kind).toBe("onduty");
    click(cell("2026-10-06"));
    expect(text(q("pd-day-facts"))).toContain(
      "counts as worked only when HR has approved the request and the punches are there",
    );
    expect(text(q("pd-day-panel"))).toContain("Erode mill");
  });

  it("Sync reads the days again and says how many changed; the pay is not touched", async () => {
    world.live.set(101, {
      days: staffDetails().days.map((d) => (d.date === "2026-10-06" ? { ...d, status: "present", shifts: 1 } : d)),
    });
    await openStaff();
    // the days are read from the attendance records as soon as the page opens: no Sync needed to see Casual Leave or a holiday
    await settle(10);
    expect(world.requests().filter((u) => u.endsWith("/101/details?live=1"))).toHaveLength(1);
    expect(cell("2026-10-06").dataset.kind).toBe("present");
    // a difference from what the payroll counted is said at once
    expect(text(q("pd-sync-status"))).toContain("2 days differ from what this payroll counted");
    expect(must("pd-sync").title).toContain("Sync to read the attendance records as they are now");
    // the button reads them again
    click(q("pd-sync"));
    await settle(10);
    expect(world.requests().filter((u) => u.endsWith("/101/details?live=1"))).toHaveLength(2);
    expect(text(q("pd-sync-status"))).toContain("The pay is unchanged until the payroll is generated again");
    // a View Only login can still Sync: it only reads
    expect(must("pd-sync-bar").hasAttribute("data-view-safe")).toBe(true);
  });

  const salary = (recorded: boolean) => ({
    recorded,
    monthly: 30000,
    earned: 26000,
    firstPortion: { full: 15000, earned: 13000 },
    secondPortion: { full: 15000, earned: 13000 },
    components: [
      { key: "basic", label: "Basic", full: 5000, earned: 4333.33, portion: "first" as const },
      { key: "da", label: "DA", full: 5000, earned: 4333.33, portion: "first" as const },
      {
        key: "retainingAllowance",
        label: "Retaining Allowance",
        full: 5000,
        earned: 4333.34,
        portion: "first" as const,
      },
      { key: "otherAllowance", label: "Other Allowance", full: 3000, earned: 2600, portion: "second" as const },
      { key: "petrolAllowance", label: "Petrol Allowance", full: 3000, earned: 2600, portion: "second" as const },
      { key: "hra", label: "HRA", full: 3000, earned: 2600, portion: "second" as const },
      { key: "specialAllowance", label: "Special Allowance", full: 3000, earned: 2600, portion: "second" as const },
      { key: "ca", label: "CA", full: 3000, earned: 2600, portion: "second" as const },
    ],
  });

  it("shows the whole monthly salary and its split-up, both columns adding up to the total", async () => {
    world.staff.set(101, staffDetails({ salary: salary(true) }));
    await openStaff();
    expect(text(q("pd-salary-monthly"))).toBe("₹30,000.00");
    expect(text(q("pd-salary-earned"))).toBe("₹26,000.00");
    expect(text(q("pd-salary-total"))).toContain("₹30,000.00");
    expect(text(q("pd-salary-total"))).toContain("₹26,000.00");
    expect(text(q("pd-salary-first"))).toContain("₹15,000.00");
    expect(text(q("pd-salary-hra"))).toContain("₹3,000.00");
    expect(q("pd-salary-automatic")).toBeNull();
  });

  it("tells an employee with no recorded split that the automatic one is shown", async () => {
    world.staff.set(101, staffDetails({ salary: salary(false) }));
    await openStaff();
    expect(text(q("pd-salary-automatic"))).toContain("automatic 50% + 50% split");
  });
});

describe("pay and deductions", () => {
  it("advance recovery lists each recovery; the late deduction explains itself with its facts", async () => {
    await openStaff();
    const advance = text(q("pd-advance-12"));
    expect(advance).toContain("Advance #12");
    expect(advance).toContain("Repayment #88 · Instalment 3 of 10");
    expect(advance).toContain("₹1,000.00");
    expect(text(q("pd-advances"))).not.toContain("Total recovered"); // one recovery needs no total
    const late = text(q("pd-late-deduction"));
    expect(late).toContain("3 late-in + 1 early-out = 4 occurrences; 2 free, 2 billable: 0.5 shift deducted.");
    expect(late).toContain("late in3");
    expect(late).toContain("free allowance2");
    expect(late).toContain("billable2");
    expect(late).toContain("shifts deducted0.5");
    expect(text(q("pd-adjustment"))).toContain("HR made no adjustment to this payroll.");
    expect(text(q("pd-overtime"))).toContain("No overtime pay on this payroll.");
  });

  it("shows HR's note, the bonus, overtime, and a total when several advances were recovered", async () => {
    const base = staffDetails();
    world.staff.set(
      101,
      staffDetails({
        notes: "Festival bonus approved by the MD",
        money: { ...base.money, bonus: 500, otAmount: 250 },
        advances: [
          { advanceId: 12, repaymentId: 88, amount: 1000, notes: null },
          { advanceId: 19, repaymentId: 91, amount: 250.5, notes: "Last instalment" },
        ],
      }),
    );
    await openStaff();
    expect(text(q("pd-adjustment-note"))).toBe("Festival bonus approved by the MD");
    expect(text(q("pd-adjustment"))).toContain("+ ₹500.00");
    expect(text(q("pd-overtime"))).toContain("+ ₹250.00");
    expect(text(q("pd-advances"))).toContain("Total recovered");
    expect(text(q("pd-advances"))).toContain("₹1,250.50");
    expect(text(q("pd-advance-19"))).toContain("Last instalment");
  });

  it("a clean payroll has no advance and no late deduction panel", async () => {
    await openLoaded("/hr/payroll/details/102", null);
    expect(text(q("pd-advances"))).toContain("No advance was recovered in this payroll.");
    expect(q("pd-late-deduction")).toBeNull();
  });

  it("a production payroll shows the note HR typed", async () => {
    await openProduction();
    expect(text(q("pd-adjustment-note"))).toBe("Bonus held back until the audit closes.");
    expect(text(q("pd-advance-31"))).toContain("Advance #31");
  });
});

describe("a half-filled answer", () => {
  it("still opens: every section shows 'nothing here' instead of the page crashing", async () => {
    const partial = {
      ...productionDetails(),
      rules: undefined,
      issues: undefined,
      days: undefined,
      history: undefined,
      advances: undefined,
      earnings: undefined,
      deductions: undefined,
      issueCounts: undefined,
      neighbours: undefined,
    } as never;
    world.production.set(301, partial);
    await openProduction();
    expect(text(q("pd-employee-name"))).toBe("Ravi Kumar");
    // no days and no rules is no breakdown: the page says so
    expect(text(q("pd-degraded"))).toContain("No day-by-day breakdown is stored for this payroll");
    expect(text(q("pd-degraded"))).toContain("Bonus held back until the audit closes."); // HR's own note stays
    expect(q("pd-attendance-empty")).not.toBeNull();
    expect(text(q("pd-position"))).toBe("1 of 1");
    await settle(10);
  });
});
