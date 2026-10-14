import { act } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDetails, productionDetails, staffDetails } from "./fixtures";
import {
  all,
  choose,
  click,
  here,
  installBrowserStubs,
  installWorld,
  must,
  openLoaded,
  press,
  q,
  scrolledTo,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The sections of the details page in jsdom, one by one: the rules (and the one changed in Settings), the issues with
// the date each was detected and every filter, the calendar and table of days, the extras on the pay, the employee's
// payment readiness and the earlier payrolls.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  csv: vi.fn(),
  excel: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "tok", user: null }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));

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
const clickLink = (el: Element | null) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

const rowIds = () => all("pd-issue-detail").map((el) => el.closest("li")!.dataset.testid);
const issueRows = () => [...document.body.querySelectorAll<HTMLElement>('li[data-testid^="pd-issue-"][data-code]')];
const count = () => text(q("pd-issue-count"));

describe("the rules", () => {
  it("lists them in groups, each with where it comes from and a way to the Settings that holds it", async () => {
    await openStaff();
    for (const group of ["attendance", "shift", "late-detection", "pay", "employee"]) {
      expect(q(`pd-rule-group-${group}`), group).not.toBeNull();
    }
    const mode = must("pd-rule-attendance_mode");
    expect(text(mode)).toContain("Attendance mode");
    expect(text(mode)).toContain("Settings");
    expect(text(mode)).toContain("Strict (4-punch)");
    expect(text(mode)).toContain("Morning in, lunch out, lunch in and evening out are all checked");
    expect(must("pd-rule-link-attendance_mode").getAttribute("href")).toBe(
      "/hr/settings?tab=attendance#attendance-mode",
    );
    expect(text(q("pd-rule-link-attendance_mode"))).toContain("Open in Settings");
    // a rule that is not a setting has no link, and says where it comes from
    expect(q("pd-rule-link-shift")).toBeNull();
    expect(text(q("pd-rule-shift"))).toContain("Shift");
    expect(text(q("pd-rule-salary_basis"))).toContain("Employee");
  });

  it("a rule changed in Settings after the payroll was generated says what it was generated with, and what it is now", async () => {
    await openStaff();
    const rule = must("pd-rule-late_free_allowance");
    expect(rule.dataset.changed).toBe("true");
    expect(text(q("pd-rule-diff-late_free_allowance"))).toContain("Generated with: 2 free, then slabs");
    expect(text(q("pd-rule-diff-late_free_allowance"))).toContain("Settings now: 3 free, then slabs");
    expect(text(q("pd-rule-changed-late_free_allowance"))).toBe(
      "Changed since this payroll was generated - regenerate to apply",
    );
    expect(must("pd-rule-link-late_free_allowance").getAttribute("href")).toBe(
      "/hr/settings?tab=late_detection#late-free-allowance",
    );
    // the others show their value only
    const unchanged = must("pd-rule-attendance_mode");
    expect(unchanged.dataset.changed).toBe("false");
    expect(text(unchanged)).not.toContain("Generated with");
    expect(q("pd-rule-changed-attendance_mode")).toBeNull();
    // and the group, the banner and the section bar all say so
    expect(text(q("pd-rule-group-late-detection"))).toContain("1 changed");
    expect(text(q("pd-rules-changed-banner"))).toContain("1 rule has changed");
    expect(text(q("pd-rules-changed-banner"))).toContain("this page shows what it was generated with");
  });

  it("a payroll whose rules have not changed has no banner and no chip", async () => {
    await openLoaded("/hr/payroll/details/102", null);
    expect(q("pd-rules-changed-banner")).toBeNull();
    expect(document.body.querySelectorAll('[data-changed="true"]')).toHaveLength(0);
  });

  it("filters by where a rule comes from, with the counts on the chips", async () => {
    await openStaff();
    expect(text(q("pd-rules-source-all"))).toBe("All 15");
    expect(text(q("pd-rules-source-settings"))).toBe("Settings 9");
    expect(text(q("pd-rules-source-employee"))).toBe("Employee 4");
    expect(text(q("pd-rules-source-shift"))).toBe("Shift 2");
    expect(q("pd-rules-source-cycle")).toBeNull(); // none come from the cycle
    click(q("pd-rules-source-shift"));
    expect(q("pd-rule-group-shift")).not.toBeNull();
    expect(q("pd-rule-group-pay")).toBeNull();
    expect(must("pd-rules-source-shift").getAttribute("aria-pressed")).toBe("true");
    click(q("pd-rules-source-shift"));
    expect(q("pd-rule-group-pay")).not.toBeNull();
  });

  it("searches the rules, shows only the changed ones, and says when nothing matches", async () => {
    await openStaff();
    typeInto(must("pd-rules-search") as HTMLInputElement, "grace");
    expect(q("pd-rule-grace")).not.toBeNull();
    expect(q("pd-rule-shift")).toBeNull();
    expect(q("pd-rule-group-pay")).toBeNull();
    typeInto(must("pd-rules-search") as HTMLInputElement, "zzzz");
    expect(text(q("pd-rules-nomatch"))).toContain("No rule matches");
    click(q("pd-rules-nomatch")!.querySelector("button"));
    expect((must("pd-rules-search") as HTMLInputElement).value).toBe("");
    expect(q("pd-rule-group-pay")).not.toBeNull();
    click(q("pd-rules-changed-only"));
    expect(q("pd-rule-late_free_allowance")).not.toBeNull();
    expect(q("pd-rule-late_slabs")).toBeNull();
    expect(q("pd-rule-group-attendance")).toBeNull();
    expect(must("pd-rules-changed-only").getAttribute("aria-pressed")).toBe("true");
  });

  it("a group collapses and expands, and Collapse all does every group", async () => {
    await openStaff();
    const header = q("pd-rule-group-shift")!.querySelector("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const list = q("pd-rule-group-shift")!.querySelector("ul")!;
    expect(list.className).toContain("hidden");
    expect(list.className).toContain("print:block"); // a collapsed group is still printed
    click(header);
    expect(q("pd-rule-group-shift")!.querySelector("ul")!.className).not.toContain("hidden");
    click(q("pd-rules-collapse-all"));
    expect(text(q("pd-rules-collapse-all"))).toBe("Expand all");
    for (const group of ["attendance", "shift", "late-detection", "pay", "employee"]) {
      expect(q(`pd-rule-group-${group}`)!.querySelector("button")!.getAttribute("aria-expanded"), group).toBe("false");
    }
    click(q("pd-rules-collapse-all"));
    expect(text(q("pd-rules-collapse-all"))).toBe("Collapse all");
  });

  it("says so when no rules were stored", async () => {
    world.staff.set(101, staffDetails({ rules: [] }));
    await openStaff();
    expect(text(q("pd-rules-empty"))).toContain("No rules were stored with this payroll");
    expect(q("pd-rules-search")).toBeNull();
  });
});

describe("the issues", () => {
  it("each row says what happened, the day it was detected on, what it cost, the rule behind it and the facts", async () => {
    await openStaff();
    const row = must("pd-issue-101:late_in:2026-10-13");
    expect(row.dataset.severity).toBe("warning");
    expect(row.dataset.code).toBe("late_in");
    const words = text(row);
    expect(words).toContain("Late arrival");
    expect(words).toContain("Needs a look");
    expect(words).toContain("First punch 09:42, after General 09:00 + 10 min grace (09:10)");
    expect(words).toContain("Detected on Tue, 13 Oct 2026");
    expect(words).toContain("Late free allowance and slabs");
    expect(words).toContain("Open in Settings");
    expect(words).toContain("first in: 09:42");
    expect(words).toContain("shift: General 09:00-18:00");
    expect(words).toContain("grace minutes: 10");
    // the type is named once: the chip, not the chip and the same words again as a title
    expect(words.match(/Late arrival/g)).toHaveLength(1);
    expect(row.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=late_detection#late-slabs");
    expect(text(row.querySelector('[data-testid="pd-issue-date"]'))).toBe("Detected on Tue, 13 Oct 2026");

    const absent = must("pd-issue-101:absent:2026-10-06");
    expect(absent.dataset.severity).toBe("critical");
    expect(text(absent)).toContain("Critical");
    expect(text(absent)).toContain("Detected on Tue, 6 Oct 2026");
    expect(text(q("pd-issue-impact") && absent.querySelector('[data-testid="pd-issue-impact"]'))).toContain("1 day");
    expect(text(absent)).toContain("₹1,134.62");
  });

  it("an issue about the whole period says so, and when payroll flagged it", async () => {
    await openStaff();
    const row = must("pd-issue-101:late_penalty:period");
    expect(row.dataset.date).toBe("");
    expect(text(row)).toContain("Whole period");
    expect(text(row)).toMatch(/Flagged by payroll on \d{1,2} Oct 2026, \d\d:\d\d/);
    expect(text(row)).not.toContain("Detected on");
    expect(text(row)).toContain("0.5 shifts");
    expect(text(row)).toContain("₹567.31");
    expect(text(row)).toContain("late in: 3");
    expect(text(row)).toContain("billable: 2");
    expect(text(row)).toContain("shifts deducted: 0.5");
  });

  it("starts by date: the whole period first, then the weeks, then the days, nothing left out", async () => {
    await openStaff();
    expect(q("pd-issues-by-date")).not.toBeNull();
    expect(q("pd-issues-by-type")).toBeNull();
    expect(count()).toBe("Showing 11 of 11 issues");
    const bands = [...document.body.querySelectorAll<HTMLElement>('[data-testid^="pd-issue-band-"]')].map(
      (b) => b.dataset.testid,
    );
    expect(bands).toEqual([
      "pd-issue-band-period",
      "pd-issue-band-2026-10-05",
      "pd-issue-band-2026-10-12",
      "pd-issue-band-2026-10-19",
      "pd-issue-band-2026-10-26",
    ]);
    expect(text(q("pd-issue-band-period"))).toContain("Whole period");
    expect(text(q("pd-issue-band-period"))).toContain("3 issues");
    expect(text(q("pd-issue-band-period"))).toContain("not tied to a single day");
    // the band says it already: no second header for the one group inside it
    expect(q("pd-issue-day-period")!.querySelector("h4")).toBeNull();
    expect(text(q("pd-issue-band-2026-10-12"))).toContain("Week of 12 Oct - 18 Oct 2026");
    expect(text(q("pd-issue-day-2026-10-13"))).toContain("Tue, 13 Oct 2026");
    expect(issueRows()).toHaveLength(11);
    // within a day the issues keep their order, and the days run oldest first
    const dates = issueRows().map((r) => r.dataset.date);
    expect(dates.filter(Boolean)).toEqual([...dates.filter(Boolean)].sort());
    expect(dates.slice(0, 3)).toEqual(["", "", ""]);
  });

  it("filters by severity, with a count on each chip, and Reset says how many filters are on", async () => {
    await openStaff();
    expect(text(q("pd-issue-sev-critical"))).toBe("Critical1");
    expect(text(q("pd-issue-sev-warning"))).toBe("Needs a look8");
    expect(text(q("pd-issue-sev-info"))).toBe("For information2");
    expect(must("pd-issue-reset").hasAttribute("disabled")).toBe(true);
    click(q("pd-issue-sev-critical"));
    expect(rowIds()).toEqual(["pd-issue-101:absent:2026-10-06"]);
    expect(count()).toBe("Showing 1 of 11 issues · 1 filter on");
    expect(text(q("pd-issue-reset"))).toBe("Reset (1)");
    expect(must("pd-issue-sev-critical").getAttribute("aria-pressed")).toBe("true");
    click(q("pd-issue-sev-info"));
    expect(issueRows()).toHaveLength(3); // critical + info
    click(q("pd-issue-reset"));
    expect(issueRows()).toHaveLength(11);
    expect(must("pd-issue-reset").hasAttribute("disabled")).toBe(true);
  });

  it("filters by kind, from the kinds that are present", async () => {
    await openStaff();
    const select = must("pd-issue-type") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All kinds (11)",
      "Absent (1)",
      "Early leaving (1)",
      "Half day (1)",
      "Late arrival (3)",
      "Late deduction (1)",
      "Missing punch (1)",
      "Unpaid leave (1)",
      "Advance recovery (1)",
      "ESI number missing (1)",
    ]);
    choose(select, "late_in");
    expect(issueRows()).toHaveLength(3);
    expect(issueRows().every((r) => r.dataset.code === "late_in")).toBe(true);
    expect(text(q("pd-issue-reset"))).toBe("Reset (1)");
    // a kind with no issue left in view cannot be left selected by accident: Reset brings everything back
    click(q("pd-issue-reset"));
    expect(select.value).toBe("all");
    expect(issueRows()).toHaveLength(11);
  });

  it("filters by a from / to date range inside the period", async () => {
    await openStaff();
    const from = must("pd-issue-from") as HTMLInputElement;
    const to = must("pd-issue-to") as HTMLInputElement;
    expect([from.min, from.max, to.min, to.max]).toEqual(["2026-10-01", "2026-10-31", "2026-10-01", "2026-10-31"]);
    typeInto(from, "2026-10-13");
    typeInto(to, "2026-10-20");
    expect(rowIds()).toEqual([
      "pd-issue-101:late_in:2026-10-13",
      "pd-issue-101:late_in:2026-10-14",
      "pd-issue-101:early_out:2026-10-20",
    ]);
    expect(text(q("pd-issue-reset"))).toBe("Reset (1)"); // a range is one filter
    expect(from.max).toBe("2026-10-20"); // the ends cannot cross
    expect(to.min).toBe("2026-10-13");
    click(q("pd-issue-reset"));
    expect(from.value).toBe("");
    expect(to.value).toBe("");
    expect(issueRows()).toHaveLength(11);
  });

  it("searches the words of an issue, its facts and its date", async () => {
    await openStaff();
    typeInto(must("pd-issue-search") as HTMLInputElement, "09:25");
    expect(rowIds()).toEqual(["pd-issue-101:late_in:2026-10-14"]);
    typeInto(must("pd-issue-search") as HTMLInputElement, "grace");
    expect(issueRows()).toHaveLength(4);
    typeInto(must("pd-issue-search") as HTMLInputElement, "tue, 27 oct");
    expect(rowIds()).toEqual(["pd-issue-101:missing_punch:2026-10-27"]);
  });

  it("filters combine, and no match says so with a way out", async () => {
    await openStaff();
    click(q("pd-issue-sev-warning"));
    choose(must("pd-issue-type") as HTMLSelectElement, "late_in");
    typeInto(must("pd-issue-search") as HTMLInputElement, "09:18");
    expect(rowIds()).toEqual(["pd-issue-101:late_in:2026-10-29"]);
    expect(text(q("pd-issue-reset"))).toBe("Reset (3)");
    typeInto(must("pd-issue-search") as HTMLInputElement, "zzzz");
    expect(text(q("pd-issues-empty"))).toContain("No issue matches these filters");
    expect(count()).toBe("Showing 0 of 11 issues · 3 filters on");
    expect(issueRows()).toHaveLength(0);
    click([...must("pd-issues-empty").querySelectorAll("button")].find((b) => text(b) === "Reset the filters")!);
    expect(issueRows()).toHaveLength(11);
    expect(q("pd-issues-empty")).toBeNull();
  });

  it("groups by type: worst kind first, each with its count and what it cost, the date still on every row", async () => {
    await openStaff();
    expect(must("pd-issue-group-date").getAttribute("aria-pressed")).toBe("true");
    click(q("pd-issue-group-type"));
    expect(must("pd-issue-group-type").getAttribute("aria-pressed")).toBe("true");
    expect(q("pd-issues-by-date")).toBeNull();
    const groups = [...document.body.querySelectorAll<HTMLElement>('[data-testid^="pd-issue-type-"]')].map(
      (g) => g.dataset.testid,
    );
    expect(groups[0]).toBe("pd-issue-type-absent");
    expect(groups[1]).toBe("pd-issue-type-late_in");
    expect(groups).toHaveLength(9);
    expect(text(q("pd-issue-type-absent"))).toContain("1 issue");
    expect(text(q("pd-issue-type-absent"))).toContain("Cost: 1 day · ₹1,134.62");
    expect(text(q("pd-issue-type-late_in"))).toContain("3 issues");
    expect(text(q("pd-issue-type-late_in"))).not.toContain("Cost");
    expect(text(q("pd-issue-type-late_penalty"))).toContain("Cost: 0.5 shifts · ₹567.31");
    const late = [...q("pd-issue-type-late_in")!.querySelectorAll("li")].map((li) => li.dataset.date);
    expect(late).toEqual(["2026-10-13", "2026-10-14", "2026-10-29"]);
    expect(text(q("pd-issue-101:late_in:2026-10-29"))).toContain("Detected on Thu, 29 Oct 2026");
    // filters still apply in this view
    click(q("pd-issue-sev-critical"));
    expect(issueRows()).toHaveLength(1);
    click(q("pd-issue-group-date"));
    expect(q("pd-issues-by-date")).not.toBeNull();
  });

  it("a clean payroll says so with a green check, and has nothing to filter or export", async () => {
    await openLoaded("/hr/payroll/details/102", null);
    expect(text(q("pd-issues-clean"))).toContain("No issues detected - this payroll is clean");
    expect(text(q("pd-issues-clean"))).toContain("Arun Prasad");
    expect(q("pd-issue-filters")).toBeNull();
    expect(q("pd-issues-empty")).toBeNull();
    expect(q("pd-issues-export")).toBeNull();
  });

  it("exports the issues shown: Excel and CSV of what the filters leave", async () => {
    await openStaff();
    click(q("pd-issue-sev-critical"));
    press(must("pd-issues-export"), "Enter");
    expect(text(q("pd-issues-export-csv"))).toContain("The 1 issue shown below");
    click(q("pd-issues-export-csv"));
    await waitFor(() => h.csv.mock.calls.length > 0, "the CSV");
    expect(h.csv.mock.calls[0][0].rows.map((i: { id: string }) => i.id)).toEqual(["101:absent:2026-10-06"]);
    // the menu closes once the file is made (it shows a spinner on the item meanwhile): open it again for the other format
    await waitFor(() => q("pd-issues-export-xlsx") === null, "the menu to close");
    press(must("pd-issues-export"), "Enter");
    click(q("pd-issues-export-xlsx"));
    await waitFor(() => h.excel.mock.calls.length > 0, "the Excel file");
    expect(h.excel.mock.calls[0][0]).toMatchObject({ sheetName: "Issues", title: "Payroll issues" });
    expect(h.excel.mock.calls[0][0].rows).toHaveLength(1);
  });

  it("a production payroll's issues read the same", async () => {
    await openProduction();
    expect(count()).toBe("Showing 5 of 5 issues");
    expect(text(q("pd-issue-301:absent:2026-10-10"))).toContain("Detected on Sat, 10 Oct 2026");
    expect(text(q("pd-issue-301:bank_missing:period"))).toContain("Whole period");
    expect(text(q("pd-issue-301:half_day:2026-10-08"))).toContain("0.5 shifts");
  });
});

describe("the days of the period", () => {
  const cell = (date: string) => must(`pd-day-${date}`);

  it("lays the month out as a calendar, Monday first, a coloured cell per day", async () => {
    await openStaff();
    const cells = [...document.body.querySelectorAll<HTMLElement>('[data-testid^="pd-day-2026-"]')];
    expect(cells).toHaveLength(31);
    const firstWeek = [...cell("2026-10-01").parentElement!.children].map(
      (c) => c.getAttribute("data-testid") ?? "blank",
    );
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
      "2026-10-20": "present",
      "2026-10-22": "half",
    };
    for (const [date, kind] of Object.entries(kinds)) expect(cell(date).dataset.kind, date).toBe(kind);
    // a day with no record is not a button, and says why it is empty
    expect(cell("2026-10-02").tagName).toBe("DIV");
    expect(cell("2026-10-02").title).toBe("Fri, 2 Oct 2026: not a working day, or no record");
    expect(text(cell("2026-10-02"))).toBe("2");
    expect(document.body.querySelectorAll('button[data-testid^="pd-day-2026-"]')).toHaveLength(26);
  });

  it("a cell shows the day, a letter for its kind, the punches and a dot per flag, and says it all to a screen reader", async () => {
    await openStaff();
    const late = cell("2026-10-13");
    expect(text(late)).toContain("13");
    expect(text(late)).toContain("L");
    expect(text(late)).toContain("09:42–18:07");
    expect(late.querySelectorAll("span.rounded-full")).toHaveLength(1); // one flag, one dot
    expect(late.getAttribute("aria-label")).toBe(
      "Tue, 13 Oct 2026: Late. first in 09:42, last out 18:07. flagged: Late arrival",
    );
    expect(cell("2026-10-22").getAttribute("aria-label")).toContain("Half day");
    expect(text(cell("2026-10-22"))).toContain("0.5 shifts");
    expect(text(cell("2026-10-01"))).not.toContain("shift"); // a full staff day needs no shift count
    expect(cell("2026-10-06").getAttribute("aria-label")).toBe("Tue, 6 Oct 2026: Absent. flagged: Absent");
    // a day with no last punch says so in words, not as stray dashes
    expect(text(cell("2026-10-27"))).toContain("in 09:02");
    expect(text(cell("2026-10-27"))).not.toContain("—");
    expect(cell("2026-10-27").getAttribute("aria-label")).toBe(
      "Tue, 27 Oct 2026: Present. first in 09:02. flagged: Missing punch",
    );
  });

  it("the legend counts each kind of day and doubles as a filter that dims the rest", async () => {
    await openStaff();
    const legend = (k: string) => text(q(`pd-legend-${k}`));
    expect(legend("present")).toBe("Present18");
    expect(legend("late")).toBe("Late3");
    expect(legend("half")).toBe("Half day1");
    expect(legend("absent")).toBe("Absent1");
    expect(legend("unpaid")).toBe("Unpaid leave1");
    expect(legend("leave")).toBe("Paid leave2");
    expect(q("pd-legend-holiday")).toBeNull(); // staff payroll has no day recorded as a holiday
    expect(q("pd-legend-onleave")).toBeNull();
    expect(q("pd-legend-other")).toBeNull();
    // the dashed cells are explained, with how many there are (not a filter: there is nothing to filter on)
    expect(text(q("pd-legend-norecord"))).toBe("Not a working day5");
    expect(q("pd-legend-norecord")!.tagName).toBe("SPAN");
    click(q("pd-legend-late"));
    expect(must("pd-legend-late").getAttribute("aria-pressed")).toBe("true");
    expect(cell("2026-10-06").className).toContain("opacity-30");
    expect(cell("2026-10-13").className).not.toContain("opacity-30");
    expect(cell("2026-10-29").className).not.toContain("opacity-30");
    click(q("pd-legend-late")); // pressing it again lifts the filter
    expect(cell("2026-10-06").className).not.toContain("opacity-30");
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

  it("choosing a day shows what happened on it and narrows the Issues list to that day", async () => {
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
    expect((must("pd-issue-from") as HTMLInputElement).value).toBe("2026-10-13");
    expect((must("pd-issue-to") as HTMLInputElement).value).toBe("2026-10-13");
    expect(rowIds()).toEqual(["pd-issue-101:late_in:2026-10-13"]);
    expect(count()).toBe("Showing 1 of 11 issues · 1 filter on");
    click(q("pd-day-show-issues"));
    expect(scrolledTo(scroll)).toEqual(["pd-issues"]);
    // another day moves the selection; the same day again lifts it
    click(cell("2026-10-20"));
    expect(cell("2026-10-13").dataset.selected).toBe("false");
    expect(rowIds()).toEqual(["pd-issue-101:early_out:2026-10-20"]);
    click(cell("2026-10-20"));
    expect(q("pd-day-panel")).toBeNull();
    expect(issueRows()).toHaveLength(11);
    expect((must("pd-issue-from") as HTMLInputElement).value).toBe("");
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
    expect((must("pd-issue-from") as HTMLInputElement).value).toBe("");
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
    expect(late.slice(0, 7)).toEqual(["13 Oct 2026", "Tue", "Late", "09:42", "18:07", "1", "Late arrival"]);
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
      "Present (18)",
      "Late (3)",
      "Half day (1)",
      "Absent (1)",
      "Unpaid leave (1)",
      "Paid leave (2)",
    ]);
    choose(select, "late");
    expect(document.body.querySelectorAll('tr[data-testid^="pd-row-"]')).toHaveLength(3);
    choose(select, "present");
    expect(
      [...document.body.querySelectorAll<HTMLElement>('tr[data-testid^="pd-row-"]')].map((r) => r.dataset.testid),
    ).toEqual(["pd-row-2026-10-20", "pd-row-2026-10-27"]);
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
    const week = [...must("pd-day-2026-10-05").parentElement!.children].map((c) => c.getAttribute("data-testid"));
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

describe("the employee", () => {
  it("says whether they can be paid, with last digits only and never a whole number", async () => {
    await openStaff();
    expect(must("pd-ready-bank").dataset.ok).toBe("true");
    expect(text(q("pd-ready-bank"))).toContain("••••4821 · State Bank of India");
    expect(must("pd-ready-ifsc").dataset.ok).toBe("true");
    expect(must("pd-ready-pf").dataset.ok).toBe("true");
    expect(text(q("pd-ready-pf"))).toContain("••••0142");
    expect(must("pd-ready-esi").dataset.ok).toBe("false");
    expect(text(q("pd-ready-esi"))).toContain("Not recorded");
    // an icon is never the only signal
    expect(text(q("pd-ready-bank"))).toContain(": present");
    expect(text(q("pd-ready-esi"))).toContain(": missing");
    expect(document.body.textContent).not.toContain("TN/MAS/0012345/000/0142");
  });

  it("a worker with no bank account is marked as one that cannot be paid by transfer", async () => {
    await openProduction();
    expect(must("pd-ready-bank").dataset.ok).toBe("false");
    expect(text(q("pd-ready-bank"))).toContain("Not on file");
    expect(must("pd-ready-ifsc").dataset.ok).toBe("false");
    expect(text(q("pd-ready-ifsc"))).toContain("Missing");
  });

  it("shows how the salary is set, the split, the profile and a link to it", async () => {
    await openStaff();
    expect(text(q("pd-basis"))).toContain("₹29,500 a month");
    const split = text(q("pd-split"));
    expect(split).toContain("First portion");
    expect(split).toContain("₹14,750.00");
    expect(split).toContain("Basic, DA and Retaining allowance · 50%");
    expect(split).toContain("Second portion");
    expect(split).toContain("Other allowance, Petrol, HRA, Special and CA · 50%");
    expect(split).toContain("Basic₹10,000.00");
    expect(split).toContain("Special allowance₹3,750.00");
    const profile = text(q("pd-profile"));
    expect(profile).toContain("Daily rate");
    expect(profile).toContain("₹1,134.62");
    expect(profile).toContain("14 Jun 2021");
    expect(profile).toMatch(/\d+ yr/);
    expect(profile).toContain("Monthly (staff payroll)");
    expect(profile).toContain("Active");
    expect(must("pd-profile-link").getAttribute("href")).toBe("/hr/employees/42");
  });

  it("production: paid per shift, on a cycle, no split, and a link to the Production Employees", async () => {
    await openProduction();
    expect(text(q("pd-basis"))).toContain("₹650 per shift");
    expect(text(q("pd-profile"))).toContain("Weekly");
    expect(q("pd-split")).toBeNull();
    expect(must("pd-profile-link").getAttribute("href")).toBe("/hr/employees/77");
    expect(document.body.querySelector('a[href="/hr/employees/productionEmployee"]')).not.toBeNull();
  });
});

describe("earlier payrolls", () => {
  it("lists them with their net, status and issue count, each a link to its own details page", async () => {
    await openStaff();
    expect(
      [...document.body.querySelectorAll('li[data-testid^="pd-history-"]')].map((li) => li.getAttribute("data-testid")),
    ).toEqual(["pd-history-90", "pd-history-79", "pd-history-66"]);
    const september = q("pd-history-90")!;
    expect(text(september)).toContain("September 2026");
    expect(text(september)).toContain("₹25,480.00");
    expect(text(september)).toContain("Paid");
    expect(text(september)).toContain("2 issues");
    expect(text(q("pd-history-79"))).toContain("Clean");
    expect(september.querySelector("a")!.getAttribute("href")).toBe("/hr/payroll/details/90");
    // a tiny trend of the nets, oldest first and ending with this payroll
    expect(must("pd-history-spark").getAttribute("aria-label")).toBe(
      "Net payable over the last 4 payrolls: ₹24,900, ₹26,121, ₹25,480, ₹23,496",
    );
  });

  it("production history links to production details pages", async () => {
    await openProduction();
    expect(q("pd-history-290")!.querySelector("a")!.getAttribute("href")).toBe("/hr/production-payroll/details/290");
  });

  it("opening one is a new page of its own (Back then goes to that period's list), not a replacement", async () => {
    world.staff.set(
      90,
      staffDetails({
        payrollId: 90,
        period: { ...staffDetails().period, label: "September 2026", month: 9 },
        context: { ...staffDetails().context, month: 9 },
      }),
    );
    await openStaff();
    const entries = window.history.length;
    clickLink(q("pd-history-90")!.querySelector("a"));
    expect(here()).toBe("/hr/payroll/details/90");
    expect(window.history.length).toBe(entries + 1);
    await waitFor(() => text(q("pd-back")) === "Back to Payroll · September 2026", "the September payroll");
  });

  it("says so when the employee has none", async () => {
    world.staff.set(101, staffDetails({ history: [] }));
    await openStaff();
    expect(text(q("pd-history-empty"))).toContain("No earlier payrolls for this employee");
    expect(q("pd-history-spark")).toBeNull();
  });

  it("the clean payroll's history is one earlier payroll", async () => {
    world.staff.set(102, cleanDetails());
    await openLoaded("/hr/payroll/details/102", null);
    expect(q("pd-history-91")).not.toBeNull();
    expect(text(q("pd-history-91"))).toContain("Clean");
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
    expect(q("pd-rules-empty")).not.toBeNull();
    // no days and no rules is no breakdown: the page says so, and does not call the payroll clean
    expect(q("pd-issues-unavailable")).not.toBeNull();
    expect(q("pd-issues-clean")).toBeNull();
    expect(text(q("pd-degraded"))).toContain("No day-by-day breakdown is stored for this payroll");
    expect(text(q("pd-degraded"))).toContain("Bonus held back until the audit closes."); // HR's own note stays
    expect(q("pd-attendance-empty")).not.toBeNull();
    expect(q("pd-history-empty")).not.toBeNull();
    expect(text(q("pd-position"))).toBe("1 of 1");
    await settle(10);
  });
});
