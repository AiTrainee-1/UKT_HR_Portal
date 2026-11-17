import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { readNotifyAutomation, type NotifyAutomation } from "@/lib/api-client/custom-hooks/attendance-notify";
import {
  addEmails,
  addTime,
  canRetry,
  categoryLabel,
  dateSpanDays,
  deliveryText,
  draftBody,
  draftFrom,
  draftProblems,
  draftWarnings,
  emptyDraft,
  errorField,
  errorText,
  firstProblemStep,
  frequencyText,
  historyFiltersFromSearch,
  historySearch,
  istToday,
  nextRunText,
  nextRuns,
  normalisePhone,
  parseTime,
  pdfFilename,
  phoneLabel,
  rangeLabel,
  recipientProblems,
  recipientSummary,
  relativeText,
  reportText,
  runTitle,
  scheduleText,
  searchForTab,
  sortAutomations,
  splitEmails,
  stepOfField,
  tabFromSearch,
  timesText,
  validEmail,
  whatsappSegments,
  whenText,
  type NotifyDraft,
} from "./logic";

// The rules behind Attendance Notify, apart from the screens: what the address says, times and dates in India time, phone
// numbers and email addresses, the form's checks and what a save sends, and how a run reads.

// Tuesday 17 Nov 2026, 9:30 AM in India
const NOW = new Date("2026-11-17T04:00:00Z");

const apiError = (status: number, body: unknown) =>
  new ApiError(new Response(JSON.stringify(body), { status }), body, {
    method: "POST",
    url: "/api/attendance/notify/x",
  });

const automation = (over: Record<string, unknown> = {}): NotifyAutomation =>
  readNotifyAutomation({ id: 1, name: "Morning absentees", channel: "whatsapp", ...over })!;

describe("the address", () => {
  it("reads the tab, Gmail also as ?tab=email, anything else as the first tab", () => {
    expect(tabFromSearch("?tab=history")).toBe("history");
    expect(tabFromSearch("tab=automations")).toBe("automations");
    expect(tabFromSearch("?tab=email")).toBe("gmail");
    expect(tabFromSearch("?tab=GMAIL")).toBe("gmail");
    expect(tabFromSearch("?tab=bogus")).toBe("whatsapp");
    expect(tabFromSearch("")).toBe("whatsapp");
  });

  it("drops the history's filters when leaving the history, keeps every other key", () => {
    expect(searchForTab("?tab=history&automation=7&status=failed&x=1", "gmail")).toBe("tab=gmail&x=1");
    expect(searchForTab("?tab=history&automation=7", "history")).toBe("tab=history&automation=7");
    expect(searchForTab("", "chat", { a: "1", b: null })).toBe("tab=chat&a=1");
  });

  it("reads the history's filters leniently and writes them back (page 1 and empty keys left out)", () => {
    expect(historyFiltersFromSearch("?tab=history&automation=7&channel=email&status=failed&page=2&run=41")).toEqual({
      automation: 7,
      channel: "email",
      status: "failed",
      page: 2,
      run: 41,
    });
    expect(historyFiltersFromSearch("?automation=abc&channel=sms&status=odd&page=-1")).toEqual({
      automation: null,
      channel: null,
      status: null,
      page: 1,
      run: null,
    });
    expect(historySearch("?tab=whatsapp", { automation: 7, run: 41 })).toBe("tab=history&automation=7&run=41");
    expect(historySearch("?tab=history&automation=7&page=3", { automation: null, page: 1 })).toBe("tab=history");
  });
});

describe("times", () => {
  it("reads the ways a time is typed, and refuses what is not a time", () => {
    expect(parseTime("9:30")).toBe("09:30");
    expect(parseTime("09:30")).toBe("09:30");
    expect(parseTime("9.30")).toBe("09:30");
    expect(parseTime("0930")).toBe("09:30");
    expect(parseTime("930")).toBe("09:30");
    expect(parseTime("21:05")).toBe("21:05");
    expect(parseTime("1:00 pm")).toBe("13:00");
    expect(parseTime("9 PM")).toBe("21:00");
    expect(parseTime("12 am")).toBe("00:00");
    expect(parseTime("12:15 p.m.")).toBe("12:15");
    for (const bad of ["", "25:00", "9:75", "13 pm", "0 am", "abc", "9:3"]) expect(parseTime(bad), bad).toBeNull();
  });

  it("adds a time once, kept in order, at most six", () => {
    expect(addTime(["13:00"], "9:30")).toEqual({ times: ["09:30", "13:00"], error: null });
    expect(addTime(["09:30"], "09:30").error).toContain("already on the list");
    expect(addTime([], " ").error).toBe("Type or pick a time first.");
    expect(addTime([], "noon").error).toContain("is not a time of day");
    const six = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
    expect(addTime(six, "14:00")).toEqual({ times: six, error: "At most 6 sending times." });
  });

  it("says the times in words", () => {
    expect(timesText([])).toBe("no time");
    expect(timesText(["13:00", "09:30"])).toBe("9:30 AM and 1:00 PM");
    expect(timesText(["18:00", "09:30", "13:00"])).toBe("9:30 AM, 1:00 PM and 6:00 PM");
  });
});

describe("dates", () => {
  it("knows today in India whatever the computer's clock zone", () => {
    expect(istToday(NOW)).toBe("2026-11-17");
    expect(istToday(new Date("2026-11-17T20:00:00Z"))).toBe("2026-11-18");
  });

  it("counts a range with both ends", () => {
    expect(dateSpanDays("2026-11-01", "2026-11-15")).toBe(15);
    expect(dateSpanDays("2026-11-17", "2026-11-17")).toBe(1);
    expect(dateSpanDays("2026-11-15", "2026-11-01")).toBeNull();
    expect(dateSpanDays("2026-02-30", "2026-03-01")).toBeNull();
    expect(dateSpanDays(null, "2026-03-01")).toBeNull();
  });

  it("writes a range as short as it reads clearly", () => {
    expect(rangeLabel("2026-11-01", "2026-11-15")).toBe("01 – 15 Nov 2026");
    expect(rangeLabel("2026-10-28", "2026-11-03")).toBe("28 Oct – 03 Nov 2026");
    expect(rangeLabel("2026-12-28", "2027-01-03")).toBe("28 Dec 2026 – 03 Jan 2027");
    expect(rangeLabel("2026-11-17", "2026-11-17")).toBe("17 Nov 2026");
    expect(rangeLabel("2026-11-17", null)).toBe("17 Nov 2026");
    expect(rangeLabel(null, null)).toBe("—");
  });
});

describe("schedules in words", () => {
  const base = { frequency: "daily" as const, days: [0, 1, 2, 3, 4, 5], runOn: null, times: ["09:30", "13:00"] };

  it("every day, chosen weekdays, once, or no time yet", () => {
    expect(scheduleText(base)).toBe("Every day at 9:30 AM and 1:00 PM");
    expect(scheduleText({ ...base, frequency: "weekly", times: ["09:30"] })).toBe("Mon–Sat at 9:30 AM");
    expect(scheduleText({ ...base, frequency: "once", runOn: "2026-11-18", times: ["09:30"] })).toBe(
      "Once on 18 Nov 2026 at 9:30 AM",
    );
    expect(scheduleText({ ...base, times: [] })).toBe("No sending time yet");
    expect(frequencyText({ frequency: "weekly", days: [0, 2, 4], runOn: null })).toBe("Mon, Wed, Fri");
    expect(frequencyText({ frequency: "once", days: [], runOn: "2026-11-18" })).toBe("Once · 18 Nov 2026");
    expect(frequencyText({ frequency: "daily", days: [], runOn: null })).toBe("Every day");
  });

  it("the report's day(s)", () => {
    const r = { reportType: "daily" as const, reportDay: "today" as const, dateFrom: null, dateTo: null };
    expect(reportText(r)).toBe("Daily · today's attendance");
    expect(reportText({ ...r, reportDay: "yesterday" })).toBe("Daily · yesterday's attendance");
    expect(reportText({ ...r, reportType: "custom", dateFrom: "2026-11-01", dateTo: "2026-11-15" })).toBe(
      "Custom · 01 – 15 Nov 2026",
    );
  });

  it("works out the next sends of a draft in India time", () => {
    // 9:30 today is now, so it is not next
    expect(nextRuns(NOW, base).map((d) => d.toISOString())).toEqual([
      "2026-11-17T07:30:00.000Z",
      "2026-11-18T04:00:00.000Z",
      "2026-11-18T07:30:00.000Z",
    ]);
    // Mondays only: next Monday
    expect(
      nextRuns(NOW, { ...base, frequency: "weekly", days: [0], times: ["09:30"] }).map((d) => d.toISOString()),
    ).toEqual(["2026-11-23T04:00:00.000Z"]);
    expect(nextRuns(NOW, { ...base, frequency: "weekly", days: [] })).toEqual([]);
    expect(
      nextRuns(NOW, { ...base, frequency: "once", runOn: "2026-11-20", times: ["18:00"] }).map((d) => d.toISOString()),
    ).toEqual(["2026-11-20T12:30:00.000Z"]);
    expect(nextRuns(NOW, { ...base, frequency: "once", runOn: "2026-11-10" })).toEqual([]);
    expect(nextRuns(NOW, { ...base, times: [] })).toEqual([]);
  });

  it("says when, and how long until", () => {
    expect(whenText("2026-11-17T13:00:00+05:30", NOW)).toBe("Today, 1:00 PM");
    expect(whenText("2026-11-18T09:30:00+05:30", NOW)).toBe("Tomorrow, 9:30 AM");
    expect(whenText("2026-11-16T18:00:00+05:30", NOW)).toBe("Yesterday, 6:00 PM");
    expect(whenText("2026-11-20T09:30:00+05:30", NOW)).toContain("20 Nov");
    expect(whenText(null, NOW)).toBe("—");
    expect(whenText("not a date", NOW)).toBe("—");
    const plus = (min: number) => new Date(NOW.getTime() + min * 60_000);
    expect(relativeText(plus(5), NOW)).toBe("in 5 min");
    expect(relativeText(plus(125), NOW)).toBe("in 2 h 5 min");
    expect(relativeText(plus(7 * 60 + 10), NOW)).toBe("in 7 h");
    expect(relativeText(plus(3 * 24 * 60), NOW)).toBe("in 3 days");
    expect(relativeText(plus(-120), NOW)).toBe("2 h ago");
    expect(relativeText(new Date(NOW.getTime() + 20_000), NOW)).toBe("now");
    expect(relativeText(null, NOW)).toBe("");
  });

  it("the next send of an automation: off, not scheduled, or when", () => {
    expect(nextRunText({ isActive: false, nextRunAt: "2026-11-17T11:35:00+05:30" }, NOW)).toBe("Off");
    expect(nextRunText({ isActive: true, nextRunAt: null }, NOW)).toBe("Not scheduled");
    expect(nextRunText({ isActive: true, nextRunAt: "2026-11-17T11:35:00+05:30" }, NOW)).toBe(
      "Today, 11:35 AM (in 2 h 5 min)",
    );
  });
});

describe("phone numbers and email addresses", () => {
  it("normalises a WhatsApp number to +country, and refuses what is not one", () => {
    expect(normalisePhone("98765 43210")).toBe("+919876543210");
    expect(normalisePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalisePhone("(0)98765 43210".replace("(0)", "0"))).toBe("+919876543210");
    expect(normalisePhone("919876543210")).toBe("+919876543210");
    expect(normalisePhone("+44 7911 123456")).toBe("+447911123456");
    expect(normalisePhone("0044 7911 123456")).toBe("+447911123456");
    for (const bad of ["", "12345", "5876543210", "+91 12345 67890", "abc", "+12"])
      expect(normalisePhone(bad), bad).toBeNull();
    expect(phoneLabel("+919876543210")).toBe("+91 98765 43210");
    expect(phoneLabel("+447911123456")).toBe("+447911123456");
  });

  it("splits typed or pasted addresses into good ones (each once, lower case) and the rest", () => {
    expect(validEmail("hr@uktextiles.in")).toBe(true);
    expect(validEmail("hr@uktextiles")).toBe(false);
    expect(splitEmails("a@b.in, Bad, C@D.COM; a@b.in\nName <x@y.org>")).toEqual({
      valid: ["a@b.in", "c@d.com", "x@y.org"],
      invalid: ["Bad"],
    });
  });

  it("adds addresses once across To, CC and BCC", () => {
    expect(addEmails(["a@b.in"], "a@b.in, new@x.com, oops", ["cc@x.com"])).toEqual({
      list: ["a@b.in", "new@x.com"],
      invalid: ["oops"],
      duplicates: ["a@b.in"],
    });
    expect(addEmails([], "CC@x.com", ["cc@x.com"])).toEqual({ list: [], invalid: [], duplicates: ["cc@x.com"] });
  });
});

describe("the form", () => {
  const today = "2026-11-17";
  const ready = (over: Partial<NotifyDraft> = {}): NotifyDraft => {
    const d = emptyDraft("whatsapp");
    return {
      ...d,
      name: "Morning absentees",
      ...over,
      recipients: { ...d.recipients, connected: true, ...over.recipients },
    };
  };

  it("a new draft: every category, Mon-Sat at 9:30 AM, both content, switched on", () => {
    const d = emptyDraft("email");
    expect(d).toMatchObject({
      channel: "email",
      categories: ["absent", "cl", "on_leave", "on_duty", "permission", "compensation"],
      frequency: "weekly",
      days: [0, 1, 2, 3, 4, 5],
      times: ["09:30"],
      content: "both",
      isActive: true,
      emailFormat: "html",
    });
  });

  it("sends only what applies: the channel's recipients, the dates of a custom report, the days of a weekly one", () => {
    const d = ready({
      name: "  Morning absentees ",
      reportType: "daily",
      dateFrom: "2026-11-01",
      dateTo: "2026-11-05",
      frequency: "daily",
      days: [1, 2],
      runOn: "2026-11-20",
      times: ["13:00", "09:30", "13:00"],
      categories: ["permission", "absent"],
      content: "summary",
      includePhotos: true,
      attachPdf: true,
      subject: "Hello",
      recipients: { ...emptyDraft("whatsapp").recipients, connected: true, to: ["x@y.in"], channelIds: [3] },
    });
    const body = draftBody(d);
    expect(body).toMatchObject({
      name: "Morning absentees",
      dateFrom: null,
      dateTo: null,
      days: [],
      runOn: null,
      times: ["09:30", "13:00"],
      categories: ["absent", "permission"],
      includePhotos: false,
      attachPdf: false,
      subject: "",
    });
    expect(body.recipients).toEqual({ connected: true, numbers: [], groups: [], listIds: [] });
    // a custom report of one day sends it as a range of one
    expect(draftBody({ ...d, reportType: "custom", dateTo: null })).toMatchObject({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-01",
    });
    expect(draftBody({ ...d, channel: "chat" }).recipients).toEqual({ channelIds: [3] });
    expect(draftBody({ ...d, channel: "email", attachPdf: true, subject: " Daily " })).toMatchObject({
      attachPdf: true,
      subject: "Daily",
      recipients: { to: ["x@y.in"], cc: [], bcc: [], listIds: [] },
    });
  });

  it("an automation that exists comes back as the same draft (a copy)", () => {
    const a = automation({
      categories: ["cl"],
      times: ["13:00", "09:30"],
      recipients: { numbers: [{ value: "+919876543210", label: "HR" }] },
    });
    const d = draftFrom(a);
    expect(d.times).toEqual(["09:30", "13:00"]);
    expect(d.recipients.numbers).toEqual([{ value: "+919876543210", label: "HR" }]);
    d.recipients.numbers.push({ value: "x", label: "" });
    expect(a.recipients.numbers).toHaveLength(1);
  });

  it("says what stops a save, on which step", () => {
    const empty = draftProblems(emptyDraft("whatsapp"), today);
    expect(empty.map((p) => [p.field, p.step])).toEqual([
      ["name", "report"],
      ["recipients", "recipients"],
    ]);
    expect(firstProblemStep(empty)).toBe("report");
    expect(draftProblems(ready(), today)).toEqual([]);
    expect(draftProblems(ready({ categories: [] }), today)[0].message).toBe("Pick at least one category.");
    expect(
      draftProblems(ready({ reportType: "custom", dateFrom: "2026-10-01", dateTo: "2026-11-09" }), today)[0].message,
    ).toBe("A custom report covers at most 31 days (this one is 40).");
    expect(
      draftProblems(ready({ reportType: "custom", dateFrom: "2026-11-10", dateTo: "2026-11-01" }), today)[0].field,
    ).toBe("dateTo");
    expect(draftProblems(ready({ reportType: "custom", dateFrom: null }), today)[0].field).toBe("dateFrom");
    expect(draftProblems(ready({ times: [] }), today)[0]).toMatchObject({ field: "times", step: "schedule" });
    expect(draftProblems(ready({ frequency: "weekly", days: [] }), today)[0].message).toBe(
      "Pick at least one weekday.",
    );
    expect(draftProblems(ready({ frequency: "once", runOn: "2026-11-10" }), today)[0].message).toContain("has passed");
    expect(draftProblems(ready({ frequency: "once", runOn: today }), today)).toEqual([]);
    expect(firstProblemStep(draftProblems(ready({ times: [] }), today))).toBe("schedule");
    expect(firstProblemStep([])).toBeNull();
  });

  it("checks each channel's recipients", () => {
    const none = emptyDraft("whatsapp").recipients;
    expect(recipientProblems("whatsapp", none)[0]).toContain("Add at least one number");
    expect(recipientProblems("whatsapp", { ...none, groups: [{ id: "g@g.us", name: "HO" }] })).toEqual([]);
    expect(recipientProblems("whatsapp", { ...none, numbers: [{ value: "12", label: "" }] })).toEqual([
      "Not a WhatsApp number: 12.",
    ]);
    expect(recipientProblems("email", none)[0]).toContain("in To");
    expect(recipientProblems("email", { ...none, to: ["a@b.in"], cc: ["bad"] })).toEqual([
      "Not an email address: bad.",
    ]);
    expect(recipientProblems("email", { ...none, listIds: [4] })).toEqual([]);
    expect(recipientProblems("chat", none)).toEqual(["Pick at least one chat channel."]);
    expect(recipientProblems("chat", { ...none, channelIds: [1] })).toEqual([]);
  });

  it("warns without blocking", () => {
    const w = draftWarnings(ready({ isActive: false }), {
      channelState: { available: false, note: "WhatsApp is not linked" },
      connectedNumber: "",
    });
    expect(w[0]).toContain("cannot deliver right now: WhatsApp is not linked");
    expect(w.some((x) => x.includes("no connected number is set"))).toBe(true);
    expect(w.some((x) => x.includes("switched off"))).toBe(true);
    expect(
      draftWarnings(ready(), { channelState: { available: true, note: "" }, connectedNumber: "+919876543210" }),
    ).toEqual([]);
  });

  it("says who gets it", () => {
    const r = emptyDraft("whatsapp").recipients;
    expect(
      recipientSummary("whatsapp", {
        ...r,
        connected: true,
        numbers: [
          { value: "+919876543210", label: "" },
          { value: "+919876543211", label: "" },
        ],
        groups: [{ id: "g", name: "HO" }],
      }),
    ).toBe("the connected number, 2 numbers, 1 group");
    expect(recipientSummary("email", { ...r, to: ["a@b.in", "c@d.in"], cc: ["e@f.in"], listIds: [1] })).toBe(
      "2 addresses, 1 in CC, 1 saved list",
    );
    expect(recipientSummary("chat", r)).toBe("Nobody yet");
  });
});

describe("errors", () => {
  it("reads the server's sentence and the field it names, and the step that field is on", () => {
    const err = apiError(400, { error: "Pick at least one time.", field: "times" });
    expect(errorText(err)).toBe("Pick at least one time.");
    expect(errorField(err)).toBe("times");
    expect(stepOfField("times")).toBe("schedule");
    expect(stepOfField("dateTo")).toBe("report");
    expect(stepOfField("recipients.numbers")).toBe("recipients");
    expect(stepOfField("subject")).toBe("recipients");
    expect(stepOfField(null)).toBeNull();
    expect(stepOfField("unknown")).toBeNull();
    expect(errorText(apiError(403, {}))).toContain("not change it");
    expect(errorText(apiError(409, { error: "run_in_progress" }))).toContain("being sent right now");
    expect(errorText(new Error("Network down"))).toBe("Network down");
    expect(errorField(new Error("x"))).toBeNull();
  });
});

describe("runs and lists", () => {
  it("names a run by what started it", () => {
    expect(runTitle({ trigger: "schedule", slot: "09:30", requestedBy: "Scheduler" })).toBe("Scheduled · 9:30 AM");
    expect(runTitle({ trigger: "manual", slot: null, requestedBy: "Meena" })).toBe("Run now by Meena");
    expect(runTitle({ trigger: "retry", slot: null, requestedBy: "Meena" })).toBe("Retry by Meena");
    expect(runTitle({ trigger: "manual", slot: null, requestedBy: "" })).toBe("Run now");
  });

  it("says how the deliveries went, and when the failed ones can be sent again", () => {
    expect(deliveryText({ recipients: 3, sent: 2, failed: 1, status: "partial" })).toBe("2 of 3 sent · 1 failed");
    expect(deliveryText({ recipients: 2, sent: 2, failed: 0, status: "done" })).toBe("2 of 2 sent");
    expect(deliveryText({ recipients: 0, sent: 0, failed: 0, status: "skipped" })).toBe("Nothing to send");
    expect(canRetry({ status: "partial", failed: 1 })).toBe(true);
    expect(canRetry({ status: "running", failed: 1 })).toBe(false);
    expect(canRetry({ status: "done", failed: 0 })).toBe(false);
  });

  it("lists active automations first, then by the soonest send, then by name", () => {
    const list = sortAutomations([
      automation({ id: 1, name: "Zeta", isActive: false }),
      automation({ id: 2, name: "Beta", nextRunAt: "2026-11-18T09:30:00+05:30" }),
      automation({ id: 3, name: "Alpha", nextRunAt: "2026-11-17T13:00:00+05:30" }),
      automation({ id: 4, name: "Alpha 2" }),
    ]);
    expect(list.map((a) => a.id)).toEqual([3, 2, 4, 1]);
  });

  it("labels categories, draws WhatsApp's *bold* and _italic_, and names the PDF", () => {
    expect(categoryLabel("cl")).toBe("CL (Casual Leave)");
    expect(categoryLabel("cl", true)).toBe("CL");
    expect(categoryLabel("late")).toBe("late");
    expect(whatsappSegments("*Absent* today: _5_ people")).toEqual([
      { text: "Absent", bold: true, italic: false },
      { text: " today: ", bold: false, italic: false },
      { text: "5", bold: false, italic: true },
      { text: " people", bold: false, italic: false },
    ]);
    expect(whatsappSegments("2*3*4 and snake_case_name")).toEqual([
      { text: "2*3*4 and snake_case_name", bold: false, italic: false },
    ]);
    expect(pdfFilename("Morning absentees!", "2026-11-17")).toBe("attendance-report-morning-absentees-2026-11-17.pdf");
    expect(pdfFilename("", "2026-11-17")).toBe("attendance-report-2026-11-17.pdf");
  });
});
