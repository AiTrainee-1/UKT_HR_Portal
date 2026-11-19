import { describe, expect, it } from "vitest";
import {
  apiQuery,
  canCheckOut,
  checkedInByLabel,
  checkedOutByLabel,
  errorCode,
  errorText,
  groupAadhaar,
  hostName,
  isLongStay,
  maskAadhaar,
  maskPhone,
  peopleQuery,
  viewOf,
} from "./logic";

describe("the Visitors page's pure parts", () => {
  it("masks a phone like the server: two first and three last of the last ten digits", () => {
    expect(maskPhone("9845012210")).toBe("98•••••210");
    expect(maskPhone("+91 98450 12210")).toBe("98•••••210");
    expect(maskPhone("12345")).toBe("•••45");
    expect(maskPhone("")).toBe("");
    expect(maskPhone(null)).toBe("");
  });

  it("masks and groups an Aadhaar number", () => {
    expect(maskAadhaar("9012")).toBe("XXXX XXXX 9012");
    expect(maskAadhaar(null)).toBeNull();
    expect(groupAadhaar("123456789012")).toBe("1234 5678 9012");
  });

  it("drops the screen switch (and the paging for the figures) from the API's query", () => {
    const params = new URLSearchParams("view=people&from=2026-10-14&status=inside&page=2&pageSize=25");
    expect(apiQuery(params)).toBe("from=2026-10-14&status=inside&page=2&pageSize=25");
    expect(apiQuery(params, { paging: false })).toBe("from=2026-10-14&status=inside");
    expect(peopleQuery(new URLSearchParams("view=people&q=ram&from=2026-10-14&branchId=2&page=1"))).toBe(
      "q=ram&branchId=2&page=1",
    );
    expect(viewOf("people")).toBe("people");
    expect(viewOf("anything")).toBe("visits");
    expect(viewOf(undefined)).toBe("visits");
  });

  it("names who checked a visitor in and out", () => {
    expect(checkedInByLabel({ source: "qr", sourceLabel: "QR self check-in", checkedInBy: null })).toBe(
      "QR self check-in",
    );
    expect(checkedInByLabel({ source: "hr", sourceLabel: "Registered by HR", checkedInBy: "Priya" })).toBe(
      "Registered by HR (Priya)",
    );
    expect(checkedOutByLabel({ checkedOutBy: "Front Desk", checkoutSource: "reception" })).toBe(
      "Front Desk · Reception desk",
    );
    expect(checkedOutByLabel({ checkedOutBy: null, checkoutSource: null })).toBeNull();
    expect(hostName({ meetingEmployee: null, whomToMeet: "Accounts" })).toBe("Accounts");
  });

  it("a long stay is inside over two hours", () => {
    expect(isLongStay({ status: "inside", minutesInside: 121 })).toBe(true);
    expect(isLongStay({ status: "inside", minutesInside: 120 })).toBe(false);
    expect(isLongStay({ status: "checked_out", minutesInside: 400 })).toBe(false);
  });

  it("reads the server's own words and codes from an error", () => {
    const err = { status: 409, data: { error: "Ramesh is already inside.", code: "already_inside", visitId: 4 } };
    expect(errorText(err, "fallback")).toBe("Ramesh is already inside.");
    expect(errorCode(err)).toEqual({ status: 409, code: "already_inside", visitId: 4 });
    expect(errorText({ data: { error: "permission_denied", message: "No access." } }, "x")).toBe("No access.");
    expect(errorText(new Error("boom"), "fallback")).toBe("fallback");
    expect(errorCode(null)).toEqual({ status: null, code: null, visitId: null });
  });
});

describe("canCheckOut", () => {
  it("follows the server's 24-hour rule, so a night visitor can be checked out after midnight", () => {
    expect(canCheckOut({ status: "not_checked_out", checkedOutAt: null, canCheckOut: true })).toBe(true);
    expect(canCheckOut({ status: "not_checked_out", checkedOutAt: null, canCheckOut: false })).toBe(false);
    expect(canCheckOut({ status: "inside", checkedOutAt: null, canCheckOut: false })).toBe(false);
    // an older server without the key: only while inside
    expect(canCheckOut({ status: "inside", checkedOutAt: null })).toBe(true);
    expect(canCheckOut({ status: "not_checked_out", checkedOutAt: null })).toBe(false);
    expect(canCheckOut({ status: "checked_out", checkedOutAt: "2026-11-18T10:00:00Z" })).toBe(false);
  });
});
