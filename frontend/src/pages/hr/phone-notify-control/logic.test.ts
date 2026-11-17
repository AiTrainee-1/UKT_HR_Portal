import { describe, expect, it } from "vitest";
import type { MobileMessageControl, MobileMessagesOverview } from "@/lib/api-client/custom-hooks";
import {
  STATUS_LABEL,
  asDate,
  asEmployeeShow,
  asPage,
  asRead,
  asSize,
  asStatus,
  audienceLabel,
  canPushAgain,
  dayBars,
  dayLabel,
  employeeFilter,
  errorText,
  groupChange,
  groupControls,
  healthNeedsBanner,
  healthTone,
  messageKinds,
  overviewTiles,
  percent,
  platformLabel,
  plural,
  statusLabel,
  statusTone,
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
