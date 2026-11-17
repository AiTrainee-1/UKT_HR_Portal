import { describe, expect, it } from "vitest";
import type {
  MobileMessageControl,
  MobileMessagesOverview,
  PushRecipients,
  PushTemplate,
  RecipientModeOption,
} from "@/lib/api-client/custom-hooks";
import {
  CATEGORY_STATE_LABEL,
  RECIPIENT_MODES,
  RECIPIENT_MODE_LABEL,
  RECIPIENT_PAGE_SIZE,
  STATUS_HELP,
  STATUS_LABEL,
  TEMPLATE_BODY_MAX,
  TEMPLATE_TITLE_MAX,
  asCategory,
  asDate,
  asEmployeeShow,
  asId,
  asPage,
  asPickerShow,
  asPickerType,
  asRead,
  asSize,
  asStatus,
  audienceLabel,
  audienceNames,
  bodyCount,
  bulkChange,
  bulkQuestion,
  canPushAgain,
  categoryChange,
  categoryCounts,
  categoryState,
  categoryTarget,
  changeDoneText,
  charCount,
  controlCategories,
  dayBars,
  dayLabel,
  employeeFilter,
  employeesText,
  errorText,
  groupChange,
  groupControls,
  groupTemplates,
  healthNeedsBanner,
  healthTone,
  inCategory,
  insertAt,
  isNarrowed,
  isWordingDirty,
  messageKinds,
  modeBlocked,
  modeChange,
  modeLabel,
  monthSegments,
  overviewTiles,
  percent,
  phoneCanExpand,
  placeholderToken,
  platformLabel,
  plural,
  reachText,
  recipientMatch,
  recipientParams,
  recipientsLine,
  statusLabel,
  statusTone,
  templateMatches,
  templateStatus,
  titleCount,
  wordingBody,
  wordingProblem,
  type PickerFilters,
} from "./logic";

const counts = (over: Partial<MobileMessagesOverview["today"]> = {}) => ({
  total: 10,
  sent: 6,
  delivered: 5,
  noDevice: 2,
  failed: 1,
  off: 1,
  ...over,
});

const overview = (over: Partial<MobileMessagesOverview> = {}): MobileMessagesOverview => ({
  pushEnabled: true,
  switchedOff: 2,
  kinds: 40,
  muted: 1,
  devices: { employees: 40, withDevice: 31, withoutDevice: 9, tokens: 33, lastRegisteredAt: null },
  today: counts(),
  week: counts({ total: 50, sent: 40, delivered: 30, failed: 3, off: 4, noDevice: 3 }),
  month: counts({ total: 200 }),
  readRate: 61.5,
  byKind: [],
  byDay: [],
  ...over,
});

const control = (key: string, group: string, enabled = true, kind: "message" | "workflow" = "message") =>
  ({
    key,
    label: key,
    description: "",
    group,
    groupLabel: group.toUpperCase(),
    kind,
    enabled,
  }) as MobileMessageControl;

describe("push results", () => {
  it("has a label, a meaning and a tone for every result, and the older notice", () => {
    expect(statusLabel("delivered")).toBe("Delivered to the phone");
    expect(statusLabel("no_device")).toBe("No phone registered");
    expect(statusLabel("")).toBe(STATUS_LABEL[""]);
    expect(statusLabel("weird")).toBe("weird");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("delivered")).toBe("success");
    expect(statusTone("weird")).toBe("neutral");
  });

  it("knows a push being sent and one waiting for its turn, and shows the server's words for a result it does not know", () => {
    expect(statusLabel("sending")).toBe("Sending to the phone");
    expect(statusTone("sending")).toBe("info");
    expect(statusLabel("")).toBe("Waiting to be pushed");
    expect(statusTone("")).toBe("neutral");
    expect(statusLabel("queued_later", "Queued for tonight")).toBe("Queued for tonight");
    expect(statusLabel("queued_later", "")).toBe("queued_later");
    // a known result keeps the page's own words whatever the server sends
    expect(statusLabel("failed", "Push failed (server)")).toBe("Push failed");
    expect(canPushAgain({ pushStatus: "sending" })).toBe(false);
  });

  it("offers Push again as the server says, else for a failed, no-phone or switched-off one", () => {
    expect(canPushAgain({ pushStatus: "failed", canPushAgain: false })).toBe(false);
    expect(canPushAgain({ pushStatus: "delivered", canPushAgain: true })).toBe(true);
    for (const s of ["failed", "no_device", "off"] as const) expect(canPushAgain({ pushStatus: s }), s).toBe(true);
    for (const s of ["sent", "delivered", ""] as const) expect(canPushAgain({ pushStatus: s }), s).toBe(false);
  });
});

describe("numbers", () => {
  it("works out a whole percentage, and nothing when there is nothing to divide by", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(5, 0)).toBeNull();
    expect(plural(1, "phone")).toBe("1 phone");
    expect(plural(3, "phone")).toBe("3 phones");
    expect(plural(0, "employee")).toBe("0 employees");
  });

  it("makes the eight overview tiles, in order, with tones that say good / watch / bad", () => {
    const tiles = overviewTiles(overview());
    expect(tiles.map((t) => t.id)).toEqual([
      "master",
      "phones",
      "today",
      "week",
      "delivered",
      "failed",
      "off",
      "nophone",
    ]);
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(by.master.value).toBe("ON");
    expect(by.master.sub).toBe("38 of 40 kinds on");
    expect(by.phones.value).toBe("31 / 40");
    expect(by.delivered.value).toBe("30");
    expect(by.delivered.sub).toBe("75% of what went out was confirmed");
    expect(by.failed.tone).toBe("bad");
    expect(by.off.sub).toBe("2 kinds off, 1 employee muted");
    expect(by.nophone.sub).toBe("9 employees with no phone registered");
  });

  it("says when the master switch is off, and copes with an older server's missing numbers", () => {
    const off = overviewTiles(overview({ pushEnabled: false }));
    expect(off[0]).toMatchObject({ value: "OFF", tone: "bad", sub: "Nothing is pushed to any phone" });
    const old = overviewTiles(
      overview({
        kinds: undefined,
        muted: undefined,
        switchedOff: 0,
        week: { total: 0, sent: 0, noDevice: 0, failed: 0, off: 0 },
      }),
    );
    const by = Object.fromEntries(old.map((t) => [t.id, t]));
    expect(by.master.sub).toBe("Every kind is on");
    expect(by.delivered).toMatchObject({ value: "0", sub: "Nothing went out yet", tone: "neutral" });
    expect(by.failed.tone).toBe("good");
    expect(by.off.sub).toBe("Every kind is on");
  });

  it("warns on the phones tile when nobody has a phone", () => {
    const tiles = overviewTiles(
      overview({ devices: { employees: 5, withDevice: 0, withoutDevice: 5, tokens: 0, lastRegisteredAt: null } }),
    );
    expect(tiles.find((t) => t.id === "phones")?.tone).toBe("warn");
  });

  it("says whose phones they are when only some employees receive phone notifications", () => {
    const devices = { employees: 142, withDevice: 37, withoutDevice: 105, tokens: 40, lastRegisteredAt: null };
    const sub = (o: MobileMessagesOverview, id: string) => overviewTiles(o).find((t) => t.id === id)?.sub;
    const staff = overview({
      devices,
      recipients: { mode: "staff", modeLabel: "Staff only", receiving: 142, receivingWithPhone: 37 },
    });
    expect(sub(staff, "phones")).toBe("Staff only: employees with a phone, 40 phones in all");
    expect(sub(staff, "nophone")).toBe("105 employees with no phone registered (Staff only)");
    const everyone = overview({
      devices,
      recipients: { mode: "all", modeLabel: "All employees", receiving: 142, receivingWithPhone: 37 },
    });
    expect(sub(everyone, "phones")).toBe("employees with a phone, 40 phones in all");
    expect(sub(everyone, "nophone")).toBe("105 employees with no phone registered");
  });
});

describe("the chart", () => {
  it("names a day by its weekday and date, whatever the time zone", () => {
    expect(dayLabel("2026-11-17")).toBe("Tue 17");
    expect(dayLabel("2026-11-01")).toBe("Sun 1");
    expect(dayLabel("nope")).toBe("nope");
  });

  it("scales the bars to the busiest day and splits what was pushed from what stayed in the app", () => {
    const { bars, peak } = dayBars([
      { date: "2026-11-16", total: 10, sent: 4 },
      { date: "2026-11-17", total: 5, sent: 5 },
      { date: "2026-11-18", total: 0, sent: 0 },
    ]);
    expect(peak).toBe(10);
    expect(bars[0]).toMatchObject({ sent: 4, notPushed: 6, sentPct: 40, notPushedPct: 60 });
    expect(bars[1]).toMatchObject({ sent: 5, notPushed: 0, sentPct: 50, notPushedPct: 0 });
    expect(bars[2]).toMatchObject({ sentPct: 0, notPushedPct: 0 });
    // an empty fortnight does not divide by zero
    expect(dayBars([]).peak).toBe(1);
  });
});

describe("the switches", () => {
  it("groups the switches in the page's order, an unknown group last in the order it came", () => {
    const groups = groupControls([
      control("approval:leave", "approval_workflows", false, "workflow"),
      control("late_alert", "attendance"),
      control("new_thing", "zz_new"),
      control("absent_alert", "attendance", false),
      control("salary_slip", "documents"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["documents", "attendance", "approval_workflows", "zz_new"]);
    const attendance = groups.find((g) => g.key === "attendance")!;
    expect(attendance).toMatchObject({ label: "ATTENDANCE", on: 1, workflow: false });
    expect(attendance.rows.map((r) => r.key)).toEqual(["late_alert", "absent_alert"]);
    expect(groups.find((g) => g.key === "approval_workflows")).toMatchObject({ workflow: true, on: 0 });
  });

  it("turns a group all on or all off by sending only the switches that change", () => {
    const rows = [control("a", "g", true), control("b", "g", false), control("c", "g", false)];
    expect(groupChange(rows, true)).toEqual({ b: true, c: true });
    expect(groupChange(rows, false)).toEqual({ a: false });
    expect(groupChange([control("a", "g", true)], true)).toEqual({});
  });

  it("names who receives a kind, and lists only the kinds of message for the filter", () => {
    expect(audienceLabel("approver")).toBe("To the approver");
    expect(audienceLabel(undefined)).toBe("To the employee");
    expect(audienceLabel("nobody")).toBe("To the employee");
    expect(
      messageKinds([control("late_alert", "attendance"), control("approval:leave", "w", true, "workflow")]).map(
        (c) => c.key,
      ),
    ).toEqual(["late_alert"]);
  });
});

describe("the categories", () => {
  const cat = (keys: string[], on: number, total = keys.length) => ({ keys, on, total });

  it("says whether every switch of a category is on, none, or only some", () => {
    expect(categoryState({ on: 3, total: 3 })).toBe("on");
    expect(categoryState({ on: 0, total: 3 })).toBe("off");
    expect(categoryState({ on: 1, total: 3 })).toBe("partial");
    expect(categoryState({ on: 0, total: 0 })).toBe("none");
    expect(CATEGORY_STATE_LABEL.partial).toBe("Some off");
  });

  it("turns a category all on from off or some off, and all off only when every switch is on", () => {
    expect(categoryTarget("off")).toBe(true);
    expect(categoryTarget("partial")).toBe(true);
    expect(categoryTarget("on")).toBe(false);
  });

  it("sends only the switches that change when they are known, else every switch of the category", () => {
    const controls = [control("a", "g", true), control("b", "g", false), control("c", "g", false), control("x", "h")];
    expect(categoryChange(["a", "b", "c"], true, controls)).toEqual({ b: true, c: true });
    expect(categoryChange(["a", "b", "c"], false, controls)).toEqual({ a: false });
    expect(categoryChange(["a"], true, controls)).toEqual({});
    // the switches not loaded (the role may not open Controls): every key, the server leaves the ones already so
    expect(categoryChange(["a", "b"], false)).toEqual({ a: false, b: false });
    // a key the switches do not list is sent as well
    expect(categoryChange(["a", "new"], false, controls)).toEqual({ a: false, new: false });
  });

  it("counts a category's switches from the loaded switches, else from the overview's numbers", () => {
    const controls = [control("a", "g", true), control("b", "g", false)];
    expect(categoryCounts(cat(["a", "b"], 2), controls)).toEqual({ on: 1, total: 2 });
    expect(categoryCounts(cat(["a", "b"], 2))).toEqual({ on: 2, total: 2 });
    expect(categoryCounts(cat(["zz"], 0, 1), controls)).toEqual({ on: 0, total: 1 });
  });

  it("names who receives a category", () => {
    expect(audienceNames(["employee", "approver"])).toEqual(["Employees", "Approvers"]);
    expect(audienceNames([])).toEqual(["Employees"]);
    expect(audienceNames(undefined)).toEqual(["Employees"]);
    expect(audienceNames(["hr", "board"])).toEqual(["HR", "board"]);
  });

  it("splits a category's 30 days into the parts of one bar, leaving out the empty ones", () => {
    const parts = monthSegments({ total: 10, sent: 5, delivered: 3, failed: 1, off: 0, noDevice: 2 });
    expect(parts.map((p) => [p.id, p.value])).toEqual([
      ["delivered", 3],
      ["sent", 2],
      ["failed", 1],
      ["noDevice", 2],
      ["waiting", 2],
    ]);
    expect(parts.reduce((n, p) => n + p.pct, 0)).toBeCloseTo(100);
    expect(parts[0].pct).toBeCloseTo(30);
    expect(monthSegments({ total: 0, sent: 0, delivered: 0, failed: 0, off: 0, noDevice: 0 })).toEqual([]);
  });

  it("lists the categories of the switches in the dashboard's order, an unknown one last, none from an older server", () => {
    const tag = (row: MobileMessageControl, category: string, categoryLabel: string) => ({
      ...row,
      category,
      categoryLabel,
    });
    const controls = [
      tag(control("zz", "other"), "brand_new", "Brand new"),
      tag(control("chat_message", "chat"), "chat", "Internal chat"),
      tag(control("approval:leave", "approval_workflows", false, "workflow"), "leave", "Leave"),
      tag(control("approval:casual_leave", "approval_workflows"), "leave", "Leave"),
    ];
    const chips = controlCategories(controls);
    expect(chips).toEqual([
      { key: "leave", label: "Leave", total: 2, on: 1 },
      { key: "chat", label: "Internal chat", total: 1, on: 1 },
      { key: "brand_new", label: "Brand new", total: 1, on: 1 },
    ]);
    expect(controlCategories([control("late_alert", "attendance")])).toEqual([]);
    expect(asCategory("chat", chips)).toBe("chat");
    expect(asCategory("payroll", chips)).toBe("");
    expect(inCategory(controls, "leave").map((r) => r.key)).toEqual(["approval:leave", "approval:casual_leave"]);
    expect(inCategory(controls, "")).toHaveLength(4);
  });
});

describe("health", () => {
  it("shows a banner only for a warning or a problem", () => {
    const health = (state: "ok" | "warning" | "problem" | "unknown") => ({
      state,
      note: "",
      lastSentAt: null,
      lastDeliveredAt: null,
      sent30: 0,
      delivered30: 0,
      failed30: 0,
      failureReasons: [],
    });
    expect(healthNeedsBanner(health("ok"))).toBe(false);
    expect(healthNeedsBanner(health("unknown"))).toBe(false);
    expect(healthNeedsBanner(health("warning"))).toBe(true);
    expect(healthNeedsBanner(health("problem"))).toBe(true);
    expect(healthNeedsBanner(undefined)).toBe(false);
    expect([healthTone("ok"), healthTone("warning"), healthTone("problem"), healthTone("unknown")]).toEqual([
      "good",
      "warn",
      "bad",
      "neutral",
    ]);
  });
});

describe("filters and words", () => {
  it("reads the filters from the address, and ignores what is not one of them", () => {
    expect(asStatus("failed")).toBe("failed");
    expect(asStatus("nope")).toBe("");
    expect(asRead("unread")).toBe("unread");
    expect(asRead("maybe")).toBe("");
    expect(asPage("3")).toBe(3);
    expect(asPage("-2")).toBe(1);
    expect(asPage("x")).toBe(1);
    expect(asSize("50")).toBe(50);
    expect(asSize("7")).toBe(20);
    expect(asDate("2026-11-01")).toBe("2026-11-01");
    expect(asDate("1/11/2026")).toBe("");
    expect(asEmployeeShow("muted")).toBe("muted");
    expect(asEmployeeShow("nope")).toBe("all");
  });

  it("turns what is shown on the Employees tab into the server's filters", () => {
    expect(employeeFilter("all")).toEqual({ has: "", muted: false });
    expect(employeeFilter("with")).toEqual({ has: "with", muted: false });
    expect(employeeFilter("without")).toEqual({ has: "without", muted: false });
    expect(employeeFilter("muted")).toEqual({ has: "", muted: true });
  });

  it("names a phone by its platform", () => {
    expect(platformLabel("android")).toBe("Android phone");
    expect(platformLabel("ios")).toBe("iPhone");
    expect(platformLabel("")).toBe("Phone");
    expect(platformLabel("web")).toBe("web phone");
  });

  it("reads the server's own sentence for a refusal, else the error's message, else the fallback", () => {
    expect(errorText({ data: { error: "This employee has no phone registered." } }, "x")).toBe(
      "This employee has no phone registered.",
    );
    expect(errorText({ data: { detail: "Not allowed" } }, "x")).toBe("Not allowed");
    expect(errorText(new Error("network down"), "x")).toBe("network down");
    expect(errorText(null, "Try again.")).toBe("Try again.");
  });
});

// ── who receives phone notifications (the Settings tab) ───────────────────────

const MODES: RecipientModeOption[] = [
  { key: "all", label: "All employees", description: "", employees: 256, withPhone: 70 },
  { key: "staff", label: "Staff only", description: "", employees: 142, withPhone: 37 },
  { key: "production", label: "Production only", description: "", employees: 114, withPhone: 33 },
  { key: "selected", label: "Selected employees", description: "", employees: 12, withPhone: 5 },
];
const recipients = (over: Partial<PushRecipients> = {}): PushRecipients => ({
  mode: "all",
  modes: MODES,
  selected: 12,
  selectedWithPhone: 5,
  receiving: 256,
  receivingWithPhone: 70,
  updatedBy: null,
  updatedAt: null,
  ...over,
});
const filters = (over: Partial<PickerFilters> = {}): PickerFilters => ({
  search: "",
  type: "",
  branch: "",
  department: "",
  show: "all",
  ...over,
});

describe("who receives phone notifications", () => {
  it("names the four choices, the server's own name first", () => {
    expect(RECIPIENT_MODES).toEqual(["all", "staff", "production", "selected"]);
    expect(modeLabel("staff", MODES)).toBe("Staff only");
    expect(modeLabel("staff", [{ key: "staff", label: "Office staff" }])).toBe("Office staff");
    expect(modeLabel("production")).toBe("Production only");
    expect(modeLabel("someday")).toBe("someday");
    expect(RECIPIENT_MODE_LABEL.selected).toBe("Selected employees");
  });

  it("says how far a choice reaches", () => {
    expect(employeesText(1)).toBe("1 employee");
    expect(employeesText(1420)).toBe("1,420 employees");
    expect(reachText(142, 37)).toBe("142 employees, 37 with a phone");
    expect(recipientsLine(recipients({ mode: "staff", receiving: 142, receivingWithPhone: 37 }))).toEqual({
      label: "Staff only",
      reach: "142 employees, 37 with a phone",
    });
    // the Overview's line carries its own name
    expect(
      recipientsLine({ mode: "production", modeLabel: "Production floor", receiving: 1, receivingWithPhone: 0 }),
    ).toEqual({ label: "Production floor", reach: "1 employee, 0 with a phone" });
    expect(recipientsLine({ mode: "selected", modeLabel: "", receiving: 0, receivingWithPhone: 0 }).label).toBe(
      "Selected employees",
    );
  });

  it("will not save Selected employees while the list is empty, and says what to do", () => {
    expect(modeBlocked("selected", { selected: 0 })).toContain("Tick the employees in the list below first");
    expect(modeBlocked("selected", { selected: 3 })).toBeNull();
    expect(modeBlocked("staff", { selected: 0 })).toBeNull();
  });

  it("says exactly who stops and who starts between All, Staff and Production", () => {
    const toStaff = modeChange("all", "staff", MODES);
    expect(toStaff.lines).toEqual(["Production employees will stop getting phone notifications: 114 employees."]);
    expect(toStaff.stops).toBe(true);
    expect(toStaff.after).toBe("After the change, phone notifications go to 142 employees, 37 with a phone.");

    expect(modeChange("staff", "all", MODES)).toEqual({
      lines: ["Production employees will start getting phone notifications: 114 employees."],
      stops: false,
      after: "After the change, phone notifications go to 256 employees, 70 with a phone.",
    });
    expect(modeChange("staff", "production", MODES).lines).toEqual([
      "Staff employees will stop getting phone notifications: 142 employees.",
      "Production employees will start getting phone notifications: 114 employees.",
    ]);
    expect(modeChange("production", "all", MODES).lines).toEqual([
      "Staff employees will start getting phone notifications: 142 employees.",
    ]);
  });

  it("counts everyone not on the list between All and Selected", () => {
    const narrow = modeChange("all", "selected", MODES);
    expect(narrow.lines).toEqual([
      "Everyone who is not on the selected list will stop getting phone notifications: 244 employees.",
    ]);
    expect(narrow.stops).toBe(true);
    const wide = modeChange("selected", "all", MODES);
    expect(wide.lines).toEqual([
      "Everyone who is not on the selected list will start getting phone notifications: 244 employees.",
    ]);
    expect(wide.stops).toBe(false);
  });

  it("names who changes, without a split it does not know, between a type and the list", () => {
    const toList = modeChange("staff", "selected", MODES);
    expect(toList.stops).toBe(true);
    expect(toList.lines[0]).toContain("Only the 12 employees on the selected list will get phone notifications");
    expect(toList.lines[0]).toContain("staff employees who are not on it will stop");
    expect(toList.lines[0]).toContain("production employees on it will start");
    const fromList = modeChange("selected", "production", MODES);
    expect(fromList.stops).toBe(false);
    expect(fromList.lines[0]).toContain("Every production employee will get phone notifications (114 employees)");
    expect(fromList.lines[0]).toContain("Staff employees on the selected list will stop getting them.");
  });

  it("says nobody is affected when a group is empty, and nothing for the same choice", () => {
    const none = modeChange(
      "all",
      "staff",
      MODES.map((m) => (m.key === "production" ? { ...m, employees: 0 } : m)),
    );
    expect(none).toMatchObject({ lines: ["No employee is affected right now."], stops: false });
    expect(modeChange("staff", "staff", MODES).lines).toEqual([]);
  });
});

describe("the selected list's filters", () => {
  it("reads the address safely", () => {
    expect(asPickerType("staff")).toBe("staff");
    expect(asPickerType("production")).toBe("production");
    expect(asPickerType("contract")).toBe("");
    expect(asPickerShow("on")).toBe("on");
    expect(asPickerShow("off")).toBe("off");
    expect(asPickerShow("maybe")).toBe("all");
    expect(asId("12")).toBe("12");
    expect(asId("007")).toBe("7");
    expect(asId("0")).toBe("");
    expect(asId("-3")).toBe("");
    expect(asId("x")).toBe("");
  });

  it("turns the filters into the list's query and the bulk changes' match, leaving empty ones out", () => {
    const f = filters({ search: "  asha ", type: "staff", branch: "2", department: "5", show: "on" });
    expect(recipientMatch(f)).toEqual({ search: "asha", type: "staff", branch: 2, department: 5 });
    expect(recipientParams(f, 3)).toEqual({
      search: "asha",
      type: "staff",
      branch: 2,
      department: 5,
      selected: "1",
      page: 3,
      pageSize: RECIPIENT_PAGE_SIZE,
    });
    expect(RECIPIENT_PAGE_SIZE).toBe(50);
    expect(recipientParams(filters({ show: "off" }), 1)).toEqual({ selected: "0", page: 1, pageSize: 50 });
    expect(recipientParams(filters(), 1)).toEqual({ page: 1, pageSize: 50 });
    expect(recipientMatch(filters({ branch: "abc", department: "0" }))).toEqual({});
  });

  it("knows when the list is narrowed (on / not on the list does not count)", () => {
    expect(isNarrowed(filters())).toBe(false);
    expect(isNarrowed(filters({ show: "off" }))).toBe(false);
    expect(isNarrowed(filters({ search: "  " }))).toBe(false);
    expect(isNarrowed(filters({ type: "production" }))).toBe(true);
  });

  it("builds each bulk change's body from the filters", () => {
    const f = filters({ type: "production", department: "9", show: "off" });
    expect(bulkChange("add", f)).toEqual({ addMatching: { type: "production", department: 9 } });
    expect(bulkChange("remove", f)).toEqual({ removeMatching: { type: "production", department: 9 } });
    expect(bulkChange("clear", f)).toEqual({ clear: true });
    expect(bulkChange("add", filters())).toEqual({ addMatching: {} });
  });

  it("asks each bulk change with its count, and says when it applies at once", () => {
    const f = filters({ type: "staff" });
    expect(bulkQuestion("add", f, { shown: 37, listed: 4 }, "all")).toBe(
      "Add all 37 employees shown by this filter to the selected list? Those already on it stay as they are.",
    );
    expect(bulkQuestion("add", f, { shown: 37, listed: 4 }, "selected")).toContain(
      "They start getting phone notifications at once.",
    );
    expect(bulkQuestion("remove", f, { shown: 2, listed: 4 }, "selected")).toBe(
      "Take all 2 employees shown by this filter off the selected list? Those not on it stay as they are. They stop getting phone notifications at once.",
    );
    expect(bulkQuestion("add", filters(), { shown: 256, listed: 0 }, "all")).toContain(
      "Add every active employee (256 employees)",
    );
    expect(bulkQuestion("add", filters({ show: "off" }), { shown: 244, listed: 12 }, "all")).toContain(
      "Add all 244 employees shown to",
    );
    expect(bulkQuestion("clear", f, { shown: 37, listed: 12 }, "staff")).toBe(
      "Take all 12 employees off the selected list?",
    );
    expect(bulkQuestion("clear", f, { shown: 37, listed: 12 }, "selected")).toContain(
      "nobody will get phone notifications until employees are added again",
    );
  });

  it("says what a change really did, from the server's count", () => {
    expect(changeDoneText("add", 35)).toBe("35 employees added to the selected list");
    expect(changeDoneText("add", 0)).toBe("Nobody was added: they were all on the list already");
    expect(changeDoneText("remove", 1)).toBe("1 employee taken off the selected list");
    expect(changeDoneText("remove", 0)).toBe("Nobody was taken off: none of them was on the list");
    expect(changeDoneText("clear", 12)).toBe("The selected list is empty now (12 employees taken off)");
    expect(changeDoneText("clear", 0)).toBe("The selected list was already empty");
  });

  it("explains a push left out because the employee is not a recipient", () => {
    expect(STATUS_HELP.off).toContain("Settings tab");
  });
});

// ── the wording of each kind (the Message Text tab) ───────────────────────────

const template = (over: Partial<PushTemplate> = {}): PushTemplate => ({
  key: "salary_slip",
  label: "Salary Slip",
  description: "The salary slip PDF, sent with a short caption.",
  group: "documents",
  groupLabel: "Documents",
  category: "payroll",
  categoryLabel: "Payroll & salary",
  origin: "whatsapp",
  enabled: true,
  variables: [],
  title: "",
  body: "",
  defaultTitle: "Salary Slip",
  defaultBody: "Dear {{employee_name}},",
  defaultNote: "",
  customised: false,
  preview: { title: "Salary Slip", body: "Dear Asha Kumar," },
  updatedBy: null,
  updatedAt: null,
  total: 0,
  sent: 0,
  failed: 0,
  lastSentAt: null,
  ...over,
});

describe("the wording of each kind", () => {
  it("puts a placeholder where the cursor is, replacing a selection, or at the end", () => {
    expect(placeholderToken("employee_name")).toBe("{{employee_name}}");
    expect(insertAt("Hi there", "{{x}}", 3, 3)).toEqual({ value: "Hi {{x}}there", caret: 8 });
    expect(insertAt("Hi there", "{{x}}", 3, 8)).toEqual({ value: "Hi {{x}}", caret: 8 });
    expect(insertAt("Hi", "{{x}}")).toEqual({ value: "Hi{{x}}", caret: 7 });
    expect(insertAt("Hi", "{{x}}", null, null)).toEqual({ value: "Hi{{x}}", caret: 7 });
    // a cursor beyond the text, or an end before the start, is kept inside it
    expect(insertAt("Hi", "{{x}}", 9, 12)).toEqual({ value: "Hi{{x}}", caret: 7 });
    expect(insertAt("Hello", "{{x}}", 2, 1)).toEqual({ value: "He{{x}}llo", caret: 7 });
    expect(insertAt("", "{{x}}", 0, 0)).toEqual({ value: "{{x}}", caret: 5 });
  });

  it("counts characters the way the server does, and says when a title may be cut off or is too long", () => {
    expect(charCount("Hi 👋")).toBe(4);
    expect(TEMPLATE_TITLE_MAX).toBe(100);
    expect(TEMPLATE_BODY_MAX).toBe(1000);
    expect(titleCount("Salary Slip")).toEqual({ text: "11 / 100", tone: "ok" });
    expect(titleCount("x".repeat(60)).tone).toBe("ok");
    expect(titleCount("x".repeat(61)).tone).toBe("long");
    expect(titleCount("x".repeat(101))).toEqual({ text: "101 / 100", tone: "over" });
    expect(bodyCount("x".repeat(1000))).toEqual({ text: "1,000 / 1,000", tone: "ok" });
    expect(bodyCount("x".repeat(1001))).toEqual({ text: "1,001 / 1,000", tone: "over" });
  });

  it("says why a wording cannot be saved, as the server would", () => {
    expect(wordingProblem("Salary Slip", "Dear {{employee_name}},")).toBeNull();
    expect(wordingProblem("Two\nlines", "")).toBe("The title must be one line.");
    expect(wordingProblem("x".repeat(101), "")).toBe("The title is 101 characters long; the most is 100.");
    expect(wordingProblem("", "x".repeat(1001))).toBe("The message is 1,001 characters long; the most is 1,000.");
    // spaces at either end are not saved, so they do not count
    expect(wordingProblem(` ${"x".repeat(100)} `, "")).toBeNull();
  });

  it("knows when the fields differ from what is saved, and sends them trimmed", () => {
    const saved = template({ title: "Paid", body: "" });
    expect(isWordingDirty(saved, "Paid", "")).toBe(false);
    expect(isWordingDirty(saved, " Paid ", "  ")).toBe(false);
    expect(isWordingDirty(saved, "Paid!", "")).toBe(true);
    expect(isWordingDirty(saved, "Paid", "Hello")).toBe(true);
    expect(wordingBody("  Paid ", "\nHello {{month}}\n")).toEqual({ title: "Paid", body: "Hello {{month}}" });
  });

  it("says whether a kind is on, from its switch on Controls", () => {
    expect(templateStatus({ enabled: true })).toEqual({ label: "On", tone: "success" });
    expect(templateStatus({ enabled: false })).toEqual({ label: "Switched off on Controls", tone: "neutral" });
  });

  it("groups the kinds by category in the categories' order, keeping the server's order inside each", () => {
    const rows = [
      template({ key: "salary_slip", category: "payroll", categoryLabel: "Payroll & salary" }),
      template({
        key: "late_alert",
        label: "Late Attendance Alert",
        category: "attendance",
        categoryLabel: "Attendance",
      }),
      template({ key: "salary_paid", label: "Salary paid", category: "payroll", customised: true, title: "Paid" }),
      template({ key: "brand_new", label: "Something new", category: "someday", categoryLabel: "Someday" }),
      template({ key: "chat_message", label: "Chat message", category: "chat", categoryLabel: "Internal chat" }),
    ];
    const groups = groupTemplates(rows);
    expect(groups.map((g) => g.key)).toEqual(["attendance", "payroll", "chat", "someday"]);
    expect(groups[1]).toMatchObject({ label: "Payroll & salary", custom: 1 });
    expect(groups[1].rows.map((r) => r.key)).toEqual(["salary_slip", "salary_paid"]);
    expect(groupTemplates(rows, { customOnly: true }).map((g) => g.rows.map((r) => r.key))).toEqual([["salary_paid"]]);
    expect(groupTemplates(rows, { search: "late alert" }).map((g) => g.key)).toEqual(["attendance"]);
    expect(groupTemplates(rows, { search: "internal" }).map((g) => g.key)).toEqual(["chat"]);
    expect(groupTemplates(rows, { search: "nothing like it" })).toEqual([]);
  });

  it("finds a kind by its name, description, category, key or HR's own wording", () => {
    const t = template({ title: "Payslip ready", body: "See the app" });
    expect(templateMatches(t, "")).toBe(true);
    expect(templateMatches(t, "SALARY pdf")).toBe(true);
    expect(templateMatches(t, "salary_slip")).toBe(true);
    expect(templateMatches(t, "payroll")).toBe(true);
    expect(templateMatches(t, "payslip")).toBe(true);
    expect(templateMatches(t, "salary visitor")).toBe(false);
  });

  it("offers to open the phone card only when there is more than about two lines", () => {
    expect(phoneCanExpand("Salary Slip", "Your salary slip is attached.")).toBe(false);
    expect(phoneCanExpand("Salary Slip", "Dear Asha,\nYour salary slip is attached.")).toBe(true);
    expect(phoneCanExpand("Salary Slip", "x".repeat(81))).toBe(true);
    expect(phoneCanExpand("x".repeat(41), "short")).toBe(true);
  });
});
