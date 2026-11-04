import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { HodRun } from "@/lib/api-client/custom-hooks";
import { DEFAULT_TEMPLATE, KUMAR, MEENA, RAVI, RUN_DONE, SETTINGS } from "../fixtures";
import {
  addTime,
  changedFields,
  countText,
  daysText,
  errorText,
  formFrom,
  formProblems,
  formWarnings,
  insertAt,
  isCompanyWideRefusal,
  istLabel,
  nextRuns,
  planCounts,
  removeTime,
  runInProgress,
  runOutcome,
  runTitle,
  sameForm,
  scheduleText,
  sendPlan,
  templateProblem,
  timeLabel,
  toggleDay,
  unknownPlaceholders,
  validTime,
} from "./logic";

const refusal = (status: number, body: Record<string, unknown>) =>
  new ApiError(new Response(JSON.stringify(body), { status }), body, {
    method: "PUT",
    url: "/api/hr/hod-reminders/settings",
  });

describe("the form", () => {
  it("starts from the saved settings, and a save sends only what changed", () => {
    const saved = formFrom(SETTINGS);
    expect(saved).toEqual({
      enabled: true,
      times: ["10:00", "16:00"],
      days: [0, 1, 2, 3, 4, 5],
      channels: { whatsapp: true, email: true, push: true },
      template: DEFAULT_TEMPLATE,
    });
    expect(changedFields(saved, saved)).toEqual({});
    expect(sameForm(saved, { ...saved, times: ["16:00", "10:00"] })).toBe(true);
    expect(
      changedFields(saved, {
        ...saved,
        times: ["16:00", "09:30", "10:00"],
        channels: { ...saved.channels, email: false },
      }),
    ).toEqual({ times: ["09:30", "10:00", "16:00"], channels: { whatsapp: true, email: false, push: true } });
    expect(changedFields(saved, { ...saved, enabled: false, days: [6, 0], template: "x" })).toEqual({
      enabled: false,
      days: [0, 6],
      template: "x",
    });
  });

  it("has defaults before the settings are in", () => {
    expect(formFrom(undefined)).toEqual({
      enabled: false,
      times: [],
      days: [0, 1, 2, 3, 4, 5],
      channels: { whatsapp: true, email: true, push: true },
      template: "",
    });
  });
});

describe("times", () => {
  it("knows a time of day", () => {
    expect(["00:00", "09:05", "23:59"].every(validTime)).toBe(true);
    expect(["24:00", "9:05", "12:60", "", "10:00:00"].some(validTime)).toBe(false);
  });

  it("adds a time in order, refusing a bad one, a repeat, or a seventh", () => {
    expect(addTime(["16:00"], "09:30")).toEqual({ times: ["09:30", "16:00"], error: null });
    expect(addTime(["16:00"], "")).toEqual({ times: ["16:00"], error: "Pick a time first." });
    expect(addTime(["16:00"], "16:00").error).toBe("4:00 PM is already on the list.");
    const six = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
    expect(addTime(six, "14:00")).toEqual({ times: six, error: "At most 6 times a day." });
    expect(removeTime(six, "10:00")).toHaveLength(5);
  });

  it("reads a time the way people say it", () => {
    expect(timeLabel("00:05")).toBe("12:05 AM");
    expect(timeLabel("10:00")).toBe("10:00 AM");
    expect(timeLabel("12:00")).toBe("12:00 PM");
    expect(timeLabel("16:30")).toBe("4:30 PM");
    expect(timeLabel("bad")).toBe("bad");
  });
});

describe("days", () => {
  it("toggles a weekday and keeps the order", () => {
    expect(toggleDay([0, 2], 1)).toEqual([0, 1, 2]);
    expect(toggleDay([0, 1, 2], 1)).toEqual([0, 2]);
  });

  it("says the days in words, a run of three or more as a range", () => {
    expect(daysText([0, 1, 2, 3, 4, 5])).toBe("Mon–Sat");
    expect(daysText([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(daysText([])).toBe("No day");
    expect(daysText([0, 2, 4])).toBe("Mon, Wed, Fri");
    expect(daysText([0, 1, 3, 4, 5])).toBe("Mon, Tue, Thu–Sat");
    expect(scheduleText({ times: ["16:00", "10:00"], days: [0, 1, 2, 3, 4, 5] })).toBe(
      "Mon–Sat at 10:00 AM and 4:00 PM",
    );
    expect(scheduleText({ times: ["10:00", "13:00", "16:00"], days: [6] })).toBe(
      "Sun at 10:00 AM, 1:00 PM and 4:00 PM",
    );
    expect(scheduleText({ times: [], days: [0] })).toBe("No time picked");
  });
});

describe("India time", () => {
  it("finds the next runs in India time, skipping the days not picked", () => {
    // Wednesday 4 Nov 2026, 11:00 India time (05:30 UTC)
    const now = new Date("2026-11-04T05:30:00Z");
    const runs = nextRuns(now, ["10:00", "16:00"], [0, 1, 2, 3, 4, 5]);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-11-04T10:30:00.000Z", // today 16:00 IST
      "2026-11-05T04:30:00.000Z", // Thu 10:00 IST
      "2026-11-05T10:30:00.000Z", // Thu 16:00 IST
    ]);
    // Saturday 7 Nov 2026 at 17:00 IST, Mon-Sat: Sunday is skipped, Monday is next
    const sat = new Date("2026-11-07T11:30:00Z");
    expect(nextRuns(sat, ["10:00"], [0, 1, 2, 3, 4, 5], 1)[0].toISOString()).toBe("2026-11-09T04:30:00.000Z");
    // just after midnight in India while it is still the day before in UTC
    const early = new Date("2026-11-04T18:45:00Z"); // Thu 5 Nov 00:15 IST
    expect(nextRuns(early, ["00:30"], [3], 1)[0].toISOString()).toBe("2026-11-04T19:00:00.000Z");
    expect(nextRuns(now, [], [0])).toEqual([]);
    expect(nextRuns(now, ["10:00"], [])).toEqual([]);
  });

  it("shows a moment in India time", () => {
    expect(istLabel("2026-11-04T10:30:00Z")).toBe("Wed, 04 Nov, 4:00 PM");
    expect(istLabel(null)).toBe("—");
    expect(istLabel("nope")).toBe("—");
  });
});

describe("checks", () => {
  it("applies the server's template rules", () => {
    expect(templateProblem(DEFAULT_TEMPLATE)).toBeNull();
    expect(templateProblem("short")).toContain("at least 10");
    expect(templateProblem("Dear {{name}}, please look")).toContain("{{pendingList}}");
    expect(templateProblem(`{{pendingList}}${"x".repeat(2000)}`)).toContain("at most 2000");
  });

  it("points out a placeholder that is not one", () => {
    expect(unknownPlaceholders("Hi {{nme}} {{name}} {{ total }} {{pendingList}}")).toEqual(["{{nme}}", "{{ total }}"]);
    expect(unknownPlaceholders(DEFAULT_TEMPLATE)).toEqual([]);
  });

  it("lists what stops a save", () => {
    const ok = formFrom(SETTINGS);
    expect(formProblems(ok)).toEqual([]);
    expect(formProblems({ ...ok, times: [] })).toEqual(["Add at least one time, or switch the reminders off."]);
    expect(formProblems({ ...ok, enabled: false, times: [], days: [] })).toEqual([]);
    expect(formProblems({ ...ok, days: [] })).toEqual(["Pick at least one day, or switch the reminders off."]);
    expect(formProblems({ ...ok, times: ["10:00", "10:00"] })).toEqual(["A time is on the list twice."]);
    expect(formProblems({ ...ok, times: ["25:00"] })).toEqual(["A time is not a valid time of day."]);
    expect(formProblems({ ...ok, template: "no list in this one" })).toHaveLength(1);
  });

  it("warns without blocking", () => {
    const ok = formFrom(SETTINGS);
    expect(formWarnings(ok, SETTINGS.channelStatus)).toEqual([]);
    expect(formWarnings({ ...ok, channels: { whatsapp: false, email: false, push: false } }, undefined)).toEqual([
      "Every channel is off: the schedule runs but nobody is reminded.",
    ]);
    // only email is on, and SMTP is not set up
    expect(
      formWarnings({ ...ok, channels: { whatsapp: false, email: true, push: false } }, SETTINGS.channelStatus),
    ).toEqual(["None of the channels that are on can deliver right now (see the notes under Channels)."]);
    expect(formWarnings({ ...ok, template: `${ok.template} {{nme}}` }, undefined)[0]).toContain("{{nme}}");
  });

  it("inserts a placeholder at the caret, over a selection", () => {
    expect(insertAt("Dear ,", "{{name}}", 5, 5)).toEqual({ text: "Dear {{name}},", caret: 13 });
    expect(insertAt("Dear X,", "{{name}}", 5, 6)).toEqual({ text: "Dear {{name}},", caret: 13 });
    expect(insertAt("abc", "{{date}}", 99, 99)).toEqual({ text: "abc{{date}}", caret: 11 });
  });
});

describe("errors", () => {
  it("knows the company-wide refusal and says it plainly", () => {
    const branch = refusal(403, { error: "The schedule is company-wide.", code: "company_wide_rule" });
    expect(isCompanyWideRefusal(branch)).toBe(true);
    expect(errorText(branch)).toBe("The schedule is company-wide.");
    const bare = refusal(403, { error: "company_wide_rule" });
    expect(isCompanyWideRefusal(bare)).toBe(true);
    expect(errorText(bare)).toContain("company-wide");
    expect(isCompanyWideRefusal(refusal(403, { error: "x", code: "view_only" }))).toBe(false);
    expect(errorText(refusal(403, {}))).toBe("Your login may look at the reminders but not change them.");
    expect(errorText(refusal(400, { error: "Times must be HH:MM." }))).toBe("Times must be HH:MM.");
    expect(errorText(new Error("offline"))).toBe("offline");
    expect(errorText("x")).toBeUndefined();
  });

  it("follows the run already going when Send now is refused for it", () => {
    expect(runInProgress(refusal(409, { code: "run_in_progress", run: { id: 41, status: "running" } }))).toBe(41);
    expect(runInProgress(refusal(409, { code: "run_in_progress" }))).toBeNull();
    expect(runInProgress(refusal(400, { run: { id: 41 } }))).toBeNull();
  });
});

describe("who a Send now reaches", () => {
  it("lists only heads with something pending, each channel going or why not", () => {
    const plan = sendPlan([KUMAR, MEENA, RAVI], { whatsapp: true, email: true, push: true }, SETTINGS.channelStatus);
    expect(plan.map((p) => p.name)).toEqual(["Ravi Shankar", "Meena Rani"]);
    expect(plan[0].whatsapp).toEqual({ goes: true, note: "WhatsApp" });
    expect(plan[0].email).toEqual({ goes: false, note: "SMTP is not set up in Settings: emails will be skipped" });
    expect(plan[1].whatsapp).toEqual({ goes: false, note: "No phone number" });
    expect(plan[1].push).toEqual({ goes: false, note: "No phone registered for notifications" });
    const counts = planCounts(plan);
    expect(counts).toEqual({ whatsapp: 1, email: 0, push: 1, unreachable: 1 });
  });

  it("says a switched-off channel is off, and a missing email when email can go", () => {
    const plan = sendPlan([MEENA, RAVI], { whatsapp: false, email: true, push: true }, undefined);
    expect(plan[0].whatsapp).toEqual({ goes: false, note: "Switched off" });
    const noMail = sendPlan([{ ...RAVI, email: null }], { whatsapp: true, email: true, push: true }, undefined);
    expect(noMail[0].email).toEqual({ goes: false, note: "No email address" });
  });
});

describe("runs", () => {
  const manual: HodRun = { ...RUN_DONE, trigger: "manual", slot: null, sentBy: "Meena" };

  it("names a run and counts a channel", () => {
    expect(runTitle(RUN_DONE)).toBe("Scheduled · 10:00 AM");
    expect(runTitle(manual)).toBe("Sent now by Meena");
    expect(runTitle({ ...manual, sentBy: null })).toBe("Sent now");
    expect(countText({ sent: 3, failed: 1, skipped: 0 })).toBe("3 sent · 1 failed");
    expect(countText({ sent: 0, failed: 0, skipped: 0 })).toBe("nothing");
  });

  it("sums a finished run up in one sentence", () => {
    expect(runOutcome(RUN_DONE)).toBe(
      "2 HoDs reminded. WhatsApp: 1 sent · 1 skipped. Email: 2 sent. Mobile push: 1 sent · 1 skipped",
    );
    expect(runOutcome({ ...RUN_DONE, hods: 0 })).toBe("No HoD had anything pending: nobody was reminded.");
    expect(runOutcome({ ...RUN_DONE, status: "failed", error: "WhatsApp is down" })).toBe("WhatsApp is down");
    expect(runOutcome({ ...RUN_DONE, status: "failed", error: null })).toContain("stopped with an error");
  });
});
