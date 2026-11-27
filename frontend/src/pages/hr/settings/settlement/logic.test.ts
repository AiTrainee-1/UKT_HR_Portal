import { describe, expect, it } from "vitest";
import {
  MAX_EMAILS,
  addEmails,
  ccWithoutTo,
  changedEmails,
  emailFormOf,
  emailProblem,
  inProgressText,
  linkDaysProblem,
  removeEmail,
  splitEmails,
} from "./logic";

// Settings -> Settlement's e-mail lists (owner 2026-11-26): the auditor's and Accounts' To and CC addresses, checked like
// the server checks them (settlement_automation.service.clean_emails) before they are saved.

describe("the e-mail addresses", () => {
  it("splits a typed or pasted list on commas, semicolons and spaces", () => {
    expect(splitEmails(" a@x.in, b@y.com;c@z.org\nd@w.co ")).toEqual(["a@x.in", "b@y.com", "c@z.org", "d@w.co"]);
    expect(splitEmails("  ")).toEqual([]);
  });

  it("refuses what is not an address", () => {
    expect(emailProblem("auditor@firm.in")).toBeNull();
    expect(emailProblem("auditor@firm")).toBe("'auditor@firm' is not an e-mail address.");
    expect(emailProblem("auditor firm.in")).toBe("'auditor firm.in' is not an e-mail address.");
    expect(emailProblem("@firm.in")).not.toBeNull();
    expect(emailProblem(`${"a".repeat(250)}@x.in`)).not.toBeNull();
    expect(emailProblem("")).toBe("Type an e-mail address.");
  });

  it("adds the good ones in lower case once each, and keeps the bad ones back with the reason", () => {
    const r = addEmails(["a@x.in"], "B@Y.com, a@x.in, nope, c@z.org");
    expect(r.list).toEqual(["a@x.in", "b@y.com", "c@z.org"]);
    expect(r.rejected).toEqual(["nope"]);
    expect(r.problem).toBe("'nope' is not an e-mail address.");
    expect(addEmails([], "ok@x.in")).toEqual({ list: ["ok@x.in"], rejected: [], problem: null });
  });

  it(`holds at most ${MAX_EMAILS} addresses`, () => {
    const nine = Array.from({ length: 9 }, (_, i) => `p${i}@x.in`);
    const r = addEmails(nine, "ten@x.in eleven@x.in");
    expect(r.list).toHaveLength(MAX_EMAILS);
    expect(r.rejected).toEqual(["eleven@x.in"]);
    expect(r.problem).toBe(`At most ${MAX_EMAILS} addresses.`);
  });

  it("removes one, and sends only the lists that changed", () => {
    expect(removeEmail(["a@x.in", "b@x.in"], "a@x.in")).toEqual(["b@x.in"]);
    const saved = emailFormOf({
      method: "automation",
      methods: [],
      auditorEmails: ["a@x.in"],
      auditorCc: [],
      accountsEmails: ["acc@x.in"],
      accountsCc: [],
      updatedBy: null,
      updatedAt: null,
      canChange: true,
      inProgress: [],
    });
    expect(changedEmails(saved, { ...saved })).toEqual({});
    expect(changedEmails(saved, { ...saved, auditorCc: ["md@x.in"] })).toEqual({ auditorCc: ["md@x.in"] });
    expect(emailFormOf(undefined)).toEqual({ auditorEmails: [], auditorCc: [], accountsEmails: [], accountsCc: [] });
  });

  it("warns when there is a CC but no To", () => {
    const empty = { auditorEmails: [], auditorCc: [], accountsEmails: [], accountsCc: [] };
    expect(ccWithoutTo(empty)).toBeNull();
    expect(ccWithoutTo({ ...empty, auditorCc: ["md@x.in"] })).toContain("auditor To address");
    expect(ccWithoutTo({ ...empty, accountsCc: ["md@x.in"] })).toContain("Accounts To address");
  });

  it("names a batch in progress", () => {
    expect(
      inProgressText({ id: 1, month: 11, year: 2026, number: 2, stage: "hr_final", stageLabel: "HR Final Settlement" }),
    ).toBe("Batch 2 of Nov 2026: HR Final Settlement");
    expect(
      inProgressText({
        id: 2,
        month: 11,
        year: 2026,
        number: 1,
        advanceType: "term",
        typeLabel: "Term Loan",
        stage: "auditor_changes",
        stageLabel: "HR Review of Auditor Changes",
      }),
    ).toBe("Term Loan · Batch 1 of Nov 2026: HR Review of Auditor Changes");
  });
});

describe("how long the auditor's review link works (2026-11-27)", () => {
  it("takes whole days from 1 to 30", () => {
    expect(linkDaysProblem("7")).toBeNull();
    expect(linkDaysProblem(" 30 ")).toBeNull();
    expect(linkDaysProblem("1")).toBeNull();
    for (const bad of ["", "0", "31", "2.5", "seven", "-3"]) {
      expect(linkDaysProblem(bad), bad).toBe("Enter whole days from 1 to 30.");
    }
    expect(linkDaysProblem("12", { min: 2, max: 10, default: 5 })).toBe("Enter whole days from 2 to 10.");
  });
});
