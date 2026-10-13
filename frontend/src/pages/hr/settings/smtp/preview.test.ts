import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  changedFields,
  connectionSecurity,
  formFromSaved,
  fromLine,
  gmailMayRewriteFrom,
  hostProblem,
  maskLogin,
  missingPieces,
  portProblem,
  providerLabel,
  saveOutcome,
  serverMessage,
  smtpErrors,
  smtpPayload,
  smtpWarnings,
  type SmtpForm,
} from "./preview";

const SAVED: SmtpForm = formFromSaved({
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpUsername: "hr.uktex@gmail.com",
  smtpPasswordSet: true,
  smtpFromEmail: "",
  smtpFromName: "UKTextiles HR",
});

describe("what a save may carry (mirrors payroll_views._smtp_problem)", () => {
  it("refuses a blank or malformed host, as the server does", () => {
    for (const host of ["", "   "]) expect(hostProblem(host)).toMatch(/cannot be blank/);
    for (const host of [
      "smtp gmail.com",
      "smtp.gmail.com:587",
      "https://smtp.gmail.com",
      "hr@gmail.com",
      "smtp/gmail",
    ]) {
      expect(hostProblem(host)).toMatch(/Just the server name/);
    }
    for (const host of ["smtp.gmail.com", "  smtp.office365.com ", "127.0.0.1"]) expect(hostProblem(host)).toBeNull();
  });

  it("takes a port from 1 to 65535 only, typed as a whole number", () => {
    for (const port of ["0", "65536", "99999", "70000"]) expect(portProblem(port)).toMatch(/1 to 65535/);
    for (const port of ["abc", "", "58 7", "-1", "587.5"]) expect(portProblem(port)).toMatch(/whole number/);
    for (const port of ["1", "25", "465", "587", "2525", "65535", " 587 "]) expect(portProblem(port)).toBeNull();
  });

  it("judges only the fields being changed, so an old blank value never blocks another change", () => {
    const blank = { ...SAVED, host: "", username: "", port: "0" };
    expect(smtpErrors(blank, { ...blank, fromName: "Acme HR" })).toEqual({});
    expect(smtpErrors(blank, { ...blank, host: "smtp.e2e.example" })).toEqual({});
    const errors = smtpErrors(SAVED, { ...SAVED, host: "", port: "0", username: " ", fromEmail: "HR <hr@x.in>" });
    expect(Object.keys(errors).sort()).toEqual(["fromEmail", "host", "port", "username"]);
  });

  it("sends only what changed, trimmed; an empty password box is never sent (it keeps the saved one)", () => {
    expect(changedFields(SAVED, SAVED)).toEqual([]);
    expect(smtpPayload(SAVED, { ...SAVED, host: "  smtp.e2e.example " })).toEqual({ smtpHost: "smtp.e2e.example" });
    expect(smtpPayload(SAVED, { ...SAVED, port: "465", password: "abcd efgh ijkl mnop" })).toEqual({
      smtpPort: 465,
      smtpPassword: "abcd efgh ijkl mnop",
    });
    expect(smtpPayload(SAVED, { ...SAVED, fromEmail: " hr@uktextiles.in ", fromName: " HR " })).toEqual({
      smtpFromEmail: "hr@uktextiles.in",
      smtpFromName: "HR",
    });
    expect(smtpPayload(SAVED, { ...SAVED })).not.toHaveProperty("smtpPassword");
  });

  it("shows a blank saved value as blank, not as a made-up default", () => {
    expect(formFromSaved({ smtpHost: "", smtpPort: 0, smtpUsername: "", smtpFromName: "" })).toEqual({
      host: "",
      port: "0",
      username: "",
      password: "",
      fromEmail: "",
      fromName: "",
    });
  });
});

describe("what the values do (email_service and Gmail Control)", () => {
  it("names the provider the way Gmail Control does", () => {
    expect(providerLabel("smtp.gmail.com")).toBe("Gmail (SMTP)");
    expect(providerLabel("smtp.googlemail.com")).toBe("Gmail (SMTP)");
    expect(providerLabel("smtp.office365.com")).toBe("SMTP mail server");
  });

  it("uses SSL on 465 and STARTTLS on every other port", () => {
    expect(connectionSecurity(465).label).toBe("SSL (port 465)");
    expect(connectionSecurity(587).label).toBe("STARTTLS");
    expect(connectionSecurity(25).label).toBe("STARTTLS");
  });

  it("lists what is missing before any email can go out", () => {
    expect(missingPieces(SAVED, true)).toEqual([]);
    expect(missingPieces({ ...SAVED, username: "" }, true)).toEqual(["username"]);
    expect(missingPieces({ ...SAVED, host: " " }, false)).toEqual(["mail server", "App Password"]);
    expect(missingPieces({ ...SAVED, password: "new one" }, false)).toEqual([]);
  });

  // Each header below is what Python's email.utils.formataddr returned for the same name and address.
  it("builds the From line exactly as formataddr does", () => {
    const cases: [string, string, string][] = [
      ["UKTextiles HR", "hr@uktextiles.in", "UKTextiles HR <hr@uktextiles.in>"],
      ["", "hr@uktextiles.in", "hr@uktextiles.in"],
      ["U.K. Textiles HR", "hr@uk.in", '"U.K. Textiles HR" <hr@uk.in>'],
      ["UK Textiles, HR", "hr@uk.in", '"UK Textiles, HR" <hr@uk.in>'],
      ['Say "Hi"', "a@b.c", '"Say \\"Hi\\"" <a@b.c>'],
      ["Back\\slash", "a@b.c", '"Back\\\\slash" <a@b.c>'],
      ["HR (Tirupur)", "a@b.c", '"HR (Tirupur)" <a@b.c>'],
      ["HR: Payroll", "a@b.c", '"HR: Payroll" <a@b.c>'],
      ["[HR]", "a@b.c", '"[HR]" <a@b.c>'],
      ["HR; Team", "a@b.c", '"HR; Team" <a@b.c>'],
      ["HR<x>", "a@b.c", '"HR<x>" <a@b.c>'],
      ["HR@Co", "a@b.c", '"HR@Co" <a@b.c>'],
    ];
    for (const [name, address, header] of cases) expect(fromLine(name, address, "").header).toBe(header);
    const unicode = fromLine("Rāma HR", "a@b.c", "");
    expect(unicode.encoded).toBe(true);
    expect(unicode.header).toBe("Rāma HR <a@b.c>");
  });

  it("hides the login the way Gmail Control does (email_control_views._mask)", () => {
    expect(maskLogin("hr.uktex@gmail.com")).toBe("hr•••@gmail.com");
    expect(maskLogin("a@b.c")).toBe("a•••@b.c");
    expect(maskLogin("abc")).toBe("ab•••");
    expect(maskLogin("abc@")).toBe("ab•••");
    expect(maskLogin("")).toBe("");
  });

  it("sends from the username when From Email is blank", () => {
    expect(fromLine("UKTextiles HR", "", "hr.uktex@gmail.com").header).toBe("UKTextiles HR <hr.uktex@gmail.com>");
  });

  it("warns that Gmail rewrites a From address other than the signed-in account", () => {
    expect(gmailMayRewriteFrom({ ...SAVED, fromEmail: "hr@uktextiles.in" })).toBe(true);
    expect(gmailMayRewriteFrom({ ...SAVED, fromEmail: "HR.UKTEX@gmail.com" })).toBe(false);
    expect(gmailMayRewriteFrom({ ...SAVED, host: "smtp.office365.com", fromEmail: "hr@uktextiles.in" })).toBe(false);
  });

  it("gives Gmail advice that does not stop a save", () => {
    expect(smtpWarnings({ ...SAVED, port: "25" }).port).toMatch(/587/);
    expect(smtpWarnings({ ...SAVED, username: "hr.uktex" }).username).toMatch(/full Gmail address/);
    expect(smtpWarnings({ ...SAVED, password: "abcd efgh ijkl" }).password).toMatch(/this has 12/);
    expect(smtpWarnings({ ...SAVED, password: "abcd efgh ijkl mnop" })).toEqual({});
    expect(smtpWarnings({ ...SAVED, host: "mail.example.com", port: "2525", password: "x" })).toEqual({});
  });
});

describe("the save message tells the truth", () => {
  const ready = { sendingAllowedHere: true, emailsEnabled: true };

  it("says the next email uses the account only when nothing stands in the way", () => {
    expect(saveOutcome({ branchLogin: false, gate: ready, missing: [] })).toMatch(/^The next email goes out/);
  });

  it("names the development-machine guard and the master switch", () => {
    expect(saveOutcome({ branchLogin: false, gate: { ...ready, sendingAllowedHere: false }, missing: [] })).toMatch(
      /development setup/,
    );
    expect(saveOutcome({ branchLogin: false, gate: { ...ready, emailsEnabled: false }, missing: [] })).toMatch(
      /master switch "Send emails" is off/,
    );
  });

  it("says what is still missing, and that a branch login saved for its branch only", () => {
    const text = saveOutcome({ branchLogin: true, gate: ready, missing: ["username", "App Password"] });
    expect(text).toMatch(/^Saved for your branch only/);
    expect(text).toMatch(/until the username and App Password are saved/);
  });

  it("does not promise anything it cannot see", () => {
    expect(saveOutcome({ branchLogin: false, gate: null, missing: [] })).toMatch(/as long as Gmail Control/);
  });
});

describe("serverMessage", () => {
  const apiError = (status: number, data: unknown) =>
    new ApiError(new Response(null, { status, statusText: "Bad Request" }), data, { method: "PUT", url: "/x" });

  it("keeps the server's own words", () => {
    expect(serverMessage(apiError(400, { error: "SMTP port must be a number from 1 to 65535 (587 for Gmail)." }))).toBe(
      "SMTP port must be a number from 1 to 65535 (587 for Gmail).",
    );
    expect(
      serverMessage(apiError(403, { error: "permission_denied", message: "You do not have edit access to this." })),
    ).toBe("You do not have edit access to this.");
    expect(serverMessage(new Error("offline"))).toBe("offline");
    expect(serverMessage("nope")).toBeUndefined();
  });
});
