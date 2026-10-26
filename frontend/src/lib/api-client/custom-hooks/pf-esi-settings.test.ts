import { describe, expect, it } from "vitest";
import { ApiError } from "../custom-fetch";
import { isPfEsiForbidden, isStalePfEsiError, pfEsiErrorMessage, pfEsiRuleProblem } from "./pf-esi-settings";

// What a refused save or reset of the PF & ESI rules says (API contract section 3): a 400 about one rule names its list,
// its (0-based) position and its box; a 409 `stale_version` means somebody else saved first; a 403 means the login is not
// the Super Admin.

const refused = (status: number, data: unknown) =>
  new ApiError(new Response(null, { status }), data, { method: "PUT", url: "/api/pf-esi-settings" });

describe("pfEsiRuleProblem", () => {
  it("reads the list, rule and box a 400 names, and the other rule of an overlap", () => {
    expect(
      pfEsiRuleProblem(
        refused(400, {
          error:
            'Staff PF rules 1 ("A") and 3 ("B") overlap (0–25,000 and 20,000–30,000). Ranges in one list must not overlap.',
          list: "staff.pfRules",
          ruleIndex: 2,
          field: "minAmount",
          otherRuleIndex: 0,
        }),
      ),
    ).toEqual({
      message:
        'Staff PF rules 1 ("A") and 3 ("B") overlap (0–25,000 and 20,000–30,000). Ranges in one list must not overlap.',
      list: "staff.pfRules",
      ruleIndex: 2,
      field: "minAmount",
      otherRuleIndex: 0,
    });
  });

  it("keeps a message that names no rule, and ignores a list it does not know", () => {
    expect(pfEsiRuleProblem(refused(400, { error: "expectedVersion is required." }))).toEqual({
      message: "expectedVersion is required.",
      list: null,
      ruleIndex: null,
      field: null,
      otherRuleIndex: null,
    });
    expect(pfEsiRuleProblem(refused(400, { error: "x", list: "staff.nonsense", ruleIndex: -1 }))).toMatchObject({
      list: null,
      ruleIndex: null,
    });
  });

  it("is nothing for any other refusal or a failure that is not an API answer", () => {
    expect(pfEsiRuleProblem(refused(409, { error: "stale_version" }))).toBeNull();
    expect(pfEsiRuleProblem(refused(400, { error: "" }))).toBeNull();
    expect(pfEsiRuleProblem(refused(400, null))).toBeNull();
    expect(pfEsiRuleProblem(new Error("network"))).toBeNull();
  });
});

describe("the other refusals", () => {
  it("knows a stale copy (409 stale_version) from every other 409 and failure", () => {
    expect(isStalePfEsiError(refused(409, { error: "stale_version", message: "..." }))).toBe(true);
    expect(isStalePfEsiError(refused(409, { error: "something_else" }))).toBe(false);
    expect(isStalePfEsiError(refused(400, { error: "stale_version" }))).toBe(false);
    expect(isStalePfEsiError(new Error("x"))).toBe(false);
  });

  it("knows a login that may not change the rules (403)", () => {
    expect(isPfEsiForbidden(refused(403, { error: "permission_denied" }))).toBe(true);
    expect(isPfEsiForbidden(refused(404, {}))).toBe(false);
  });

  it("passes on the server's sentence, but not the bare permission code", () => {
    expect(
      pfEsiErrorMessage(
        refused(403, { error: "permission_denied", message: "Only the Super Admin can change PF / ESI rules." }),
      ),
    ).toBe("Only the Super Admin can change PF / ESI rules.");
    expect(pfEsiErrorMessage(refused(404, { error: "No such branch." }))).toBe("No such branch.");
    expect(pfEsiErrorMessage(refused(403, { error: "permission_denied" }))).toBeNull();
    expect(pfEsiErrorMessage(new Error("x"))).toBeNull();
  });
});
