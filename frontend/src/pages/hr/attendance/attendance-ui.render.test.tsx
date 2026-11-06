import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ABSENT, CL, DAY, MANUAL, NIGHT, ON_DUTY, ON_LEAVE, PENDING_LEAVE, PRESENT, STAFF_DAY } from "./fixtures";
import { countBoard, type StatusFilter } from "./logic";

// The redesigned Staff / Production Attendance page's parts, rendered: the status cards (counts, the filter they set, the
// pressed state), the punch timeline (every punch, its source, In / Out, the next-day mark, the uncounted ones), the list
// (the card filter, the search, the department, a click that opens the person) and the punch sources.

vi.mock("../report-log/useCompany", () => ({
  useCompany: () => ({
    excel: { company: "UK Textiles", branchLabel: "All Branches", logoDataUrl: null },
    sheet: { name: "UK Textiles", branchLabel: "All Branches", logoUrl: null },
  }),
}));

import { RollCall } from "./RollCall";
import { PunchTimeline } from "./PunchTimeline";
import { DayList } from "./DayList";
import { PunchSources } from "./PunchSources";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // "less motion, please": the figures do not count up and the strip does not grow, so the test reads the final values
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function render(node: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const rerender = (node: ReturnType<typeof createElement>) => act(() => root!.render(node));
const byTestId = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const click = (el: Element) => act(() => (el as HTMLElement).click());

describe("the status cards", () => {
  const props = (filter: StatusFilter, onFilter = vi.fn()) => ({
    counts: countBoard(STAFF_DAY),
    loading: false,
    filter,
    onFilter,
    date: DAY,
    isToday: true,
    holidayName: null,
    isSunday: false,
    view: "staff" as const,
  });

  it("shows the six counts, the at-work figure and the strip", () => {
    const el = render(createElement(RollCall, props("all")));
    const count = (s: string) => byTestId(el, `status-card-${s}-count`).textContent;
    expect(["present", "on_duty", "on_leave", "cl", "leave_applied", "absent"].map(count)).toEqual([
      "2",
      "1",
      "1",
      "1",
      "1",
      "1",
    ]);
    expect(byTestId(el, "rollcall-at-work").textContent).toContain("3");
    expect(byTestId(el, "rollcall-at-work").textContent).toContain("of 7 at work");
    // the strip has one segment per status that has anybody
    expect(byTestId(el, "rollcall-strip").querySelectorAll("[data-state]")).toHaveLength(6);
    expect(byTestId(el, "rollcall-strip").getAttribute("aria-label")).toBe(
      "Present 2, On Duty 1, On Leave 1, CL 1, Leave 1, Absent 1",
    );
    // the owner's words, with what each one means
    expect(byTestId(el, "status-card-leave_applied").getAttribute("title")).toBe(
      "Leave asked for, waiting for approval",
    );
    expect(byTestId(el, "status-card-present").textContent).toContain("1 by hand");
  });

  it("a card filters the list, and pressing it again shows everyone", () => {
    const onFilter = vi.fn();
    const el = render(createElement(RollCall, props("all", onFilter)));
    click(byTestId(el, "status-card-cl"));
    expect(onFilter).toHaveBeenLastCalledWith("cl");
    rerender(createElement(RollCall, props("cl", onFilter)));
    expect(byTestId(el, "status-card-cl").getAttribute("aria-pressed")).toBe("true");
    expect(byTestId(el, "status-card-absent").getAttribute("aria-pressed")).toBe("false");
    click(byTestId(el, "status-card-cl"));
    expect(onFilter).toHaveBeenLastCalledWith("all");
  });

  it("names a holiday and yesterday's figures", () => {
    const el = render(
      createElement(RollCall, {
        ...props("all"),
        holidayName: "Deepavali",
        summary: {
          date: DAY,
          totalEmployees: 7,
          productionTotal: 0,
          staffTotal: 7,
          presentToday: 3,
          biometricPresent: 2,
          manualPresent: 1,
          notPunched: 4,
          productionNotPunched: 0,
          staffNotPunched: 4,
          yesterday: { date: "2026-11-03", present: 5, absent: 1, late: 2, onLeave: 1 },
        },
      }),
    );
    expect(byTestId(el, "rollcall-holiday").textContent).toBe("Holiday: Deepavali");
    expect(byTestId(el, "rollcall-yesterday").textContent).toMatch(/Yesterday.*5Present.*1Absent.*2Late.*1On leave/);
  });
});

describe("the punch timeline", () => {
  it("lists every punch with In / Out, its source and its words", () => {
    const el = render(createElement(PunchTimeline, { punches: PRESENT.punches, dayDate: DAY }));
    const chips = Array.from(el.querySelectorAll("[data-kind]"));
    expect(chips.map((c) => [c.textContent, c.getAttribute("data-kind"), c.getAttribute("data-type")])).toEqual([
      ["08:31", "biometric", "IN"],
      ["13:00", "geo", "OUT"],
      ["13:40", "hr_entry", "IN"],
      ["18:05", "missing_punch", "OUT"],
    ]);
    expect(chips[1].getAttribute("aria-label")).toBe("Out 13:00:00, Geo Punch.");
  });

  it("marks the night's closing punch +1 and the punches the day is not counted on", () => {
    const el = render(createElement(PunchTimeline, { punches: NIGHT.punches, dayDate: DAY }));
    const chips = Array.from(el.querySelectorAll("[data-kind]"));
    expect(chips[0].getAttribute("data-kind")).toBe("uncounted");
    expect(chips[2].textContent).toBe("05:30+1");
    expect(chips[2].getAttribute("title")).toContain("on 5 Nov");
    const held = render(createElement(PunchTimeline, { punches: ON_DUTY.punches, dayDate: DAY }));
    expect(held.querySelector('[data-kind="held"]')?.getAttribute("title")).toContain("Waiting for HR");
  });

  it("says when there is nothing", () => {
    const el = render(createElement(PunchTimeline, { punches: [], empty: "Day off" }));
    expect(el.textContent).toBe("Day off");
  });
});

describe("the day list", () => {
  const props = (filter: StatusFilter, onOpen = vi.fn(), onFilter = vi.fn()) => ({
    rows: [...STAFF_DAY],
    loading: false,
    date: DAY,
    view: "staff" as const,
    filter,
    onFilter,
    onOpen,
  });
  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[data-testid="day-list-row"]')).map((r) => r.getAttribute("data-employee-code"));

  it("shows everyone with their punches and what is true of their day", () => {
    const el = render(createElement(DayList, props("all")));
    expect(names(el)).toHaveLength(7);
    expect(byTestId(el, "day-list-count").textContent).toContain("7 of 7 shown");
    const asha = el.querySelector('[data-employee-code="101"]')!;
    expect(asha.querySelectorAll("[data-kind]")).toHaveLength(4);
    expect(asha.querySelector('[data-testid="row-state"]')?.textContent).toBe("Present");
    const karthik = el.querySelector('[data-employee-code="104"]')!;
    expect(karthik.querySelector('[data-testid="row-state"]')?.getAttribute("data-state")).toBe("leave_applied");
    expect(karthik.querySelector('[data-testid="row-leave-fact"]')?.textContent).toBe(
      "Sick leave, waiting for approval",
    );
    expect(el.querySelector('[data-employee-code="102"]')?.textContent).toContain("Marked by hand");
  });

  it("follows the status the cards picked and offers to show everyone again", () => {
    const onFilter = vi.fn();
    const el = render(createElement(DayList, props("on_leave", vi.fn(), onFilter)));
    expect(names(el)).toEqual([ON_LEAVE.employeeCode]);
    click(byTestId(el, "day-list-filter-chip"));
    expect(onFilter).toHaveBeenCalledWith("all");
  });

  it("searches by name or code after a short pause, and narrows to one department", () => {
    vi.useFakeTimers();
    const el = render(createElement(DayList, props("all")));
    const input = byTestId(el, "day-list-search") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "nair");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names(el)).toHaveLength(7); // not yet: the search waits for a pause in typing
    act(() => vi.advanceTimersByTime(250));
    expect(names(el)).toEqual([MANUAL.employeeCode]);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(250));
    const select = byTestId(el, "day-list-department") as HTMLSelectElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "Stores");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(names(el)).toEqual([MANUAL.employeeCode]);
  });

  it("opens the person's month from the row or the name", () => {
    const onOpen = vi.fn();
    const el = render(createElement(DayList, props("all", onOpen)));
    click(el.querySelector('[data-employee-code="103"]')!);
    expect(onOpen).toHaveBeenLastCalledWith(ABSENT.employeeId);
    const nameButton = el.querySelector('[data-employee-code="106"] button')!;
    expect(nameButton.textContent).toBe(CL.employeeName);
    click(nameButton);
    expect(onOpen).toHaveBeenLastCalledWith(CL.employeeId);
    expect(onOpen).toHaveBeenCalledTimes(2); // the name's click is not counted twice by its row
  });

  it("says so when nobody matches, and the export is off", () => {
    const el = render(createElement(DayList, { ...props("cl"), rows: [PRESENT, PENDING_LEAVE] }));
    expect(el.textContent).toContain("Nobody matches");
    expect((byTestId(el, "day-export-menu") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the punch sources", () => {
  it("counts the day's punches by source and by person", () => {
    const el = render(
      createElement(PunchSources, { rows: [PRESENT, ON_DUTY, NIGHT, ABSENT], loading: false, date: DAY }),
    );
    expect(byTestId(el, "attendance-sources").textContent).toContain("9 punches from 3 people");
    const kinds = Array.from(el.querySelectorAll("[data-kind]")).map((li) => [
      li.getAttribute("data-kind"),
      ...Array.from(li.querySelectorAll(":scope > div:first-child > span")).map((s) => s.textContent),
    ]);
    expect(kinds).toEqual([
      ["biometric", "Biometric", "3 from 2"],
      ["geo", "Geo punch (mobile)", "1 from 1"],
      ["on_duty", "On-Duty", "1 from 1"],
      ["missing_punch", "Missing punch (approved)", "1 from 1"],
      ["hr_entry", "HR entry", "1 from 1"],
      ["held", "On-Duty, waiting for HR", "1 from 1"],
      ["uncounted", "Not counted on this day", "1 from 1"],
    ]);
  });
});
