import { describe, expect, it } from "vitest";
import {
  errorText,
  generatePassword,
  isNotStored,
  isOnline,
  monitorAddress,
  passwordProblem,
  readSelection,
  recordsQuery,
  recordsSummary,
  usernameProblem,
} from "./logic";

describe("Manage Gates logic", () => {
  it("the one gate monitor address", () => {
    expect(monitorAddress("https://hr.example.com")).toBe("https://hr.example.com/gatemonitor");
    expect(monitorAddress("http://localhost:5173/")).toBe("http://localhost:5173/gatemonitor");
  });

  it("suggests readable passwords of the asked length", () => {
    const pw = generatePassword(12);
    expect(pw).toHaveLength(12);
    expect(pw).toMatch(/^[a-zA-Z2-9]+$/);
    expect(pw).not.toMatch(/[01OIl]/);
    // the alphabet wraps: a fixed source gives a fixed password
    expect(generatePassword(3, () => new Uint32Array([0, 1, 55]))).toBe("aba");
  });

  it("checks usernames and passwords like the server", () => {
    expect(usernameProblem("ab")).toMatch(/at least 3/);
    expect(usernameProblem("a b c")).toMatch(/spaces/);
    expect(usernameProblem("x".repeat(61))).toMatch(/at most 60/);
    expect(usernameProblem("  main.gate ")).toBeNull();
    expect(passwordProblem("12345")).toMatch(/at least 6/);
    expect(passwordProblem("123456")).toBeNull();
  });

  it("reads the gate of the address", () => {
    expect(readSelection("all")).toBe("all");
    expect(readSelection("12")).toBe(12);
    expect(readSelection("")).toBe("");
    expect(readSelection("x")).toBe("");
    expect(readSelection("-3")).toBe("");
  });

  it("builds the records query: the page's own keys out, the chosen gate in", () => {
    const params = new URLSearchParams("gate=12&gq=main&gstatus=active&type=exit&gateId=13&page=2");
    expect(recordsQuery(params, 12).toString()).toBe("type=exit&gateId=12&page=2");
    expect(recordsQuery(params, "all").toString()).toBe("type=exit&gateId=13&page=2");
    expect(recordsQuery(new URLSearchParams("gate=all"), "all").toString()).toBe("");
  });

  it("says what the records hold", () => {
    expect(recordsSummary(1, { exits: 1, returns: 2, teaOut: 1, teaIn: 1, denied: 0 })).toBe(
      "1 record · 1 exit · 2 returns · 1 tea break · 0 denied",
    );
    expect(recordsSummary(1240, undefined)).toBe("1,240 records");
  });

  it("online = seen in the last 10 minutes", () => {
    const now = new Date("2026-10-14T06:00:00Z");
    expect(isOnline("2026-10-14T05:51:00Z", now)).toBe(true);
    expect(isOnline("2026-10-14T05:49:00Z", now)).toBe(false);
    expect(isOnline(null, now)).toBe(false);
  });

  it("reads the server's words and the not_stored answer", () => {
    expect(errorText({ data: { error: "That username is already taken" } }, "x")).toBe(
      "That username is already taken",
    );
    expect(errorText(new Error("boom"), "x")).toBe("boom");
    expect(errorText(null, "fallback")).toBe("fallback");
    expect(isNotStored({ status: 409, data: { code: "not_stored" } })).toBe(true);
    expect(isNotStored({ status: 409, data: { code: "other" } })).toBe(false);
  });
});
