import { describe, expect, it } from "vitest";
import { STAFF_URL_DEFAULTS, statementQuery } from "./logic";

describe("statementQuery", () => {
  it("asks for the month of the page as 'YYYY-MM'", () => {
    expect(statementQuery({ month: 3, year: 2026 }).toString()).toBe("period=2026-03");
    expect(statementQuery({ month: 12, year: 2026 }).get("period")).toBe("2026-12");
  });

  it("adds the payment status only when the page shows Cleared or Pending alone", () => {
    expect(statementQuery({ month: 10, year: 2026 }, "all").has("paymentStatus")).toBe(false);
    expect(statementQuery({ month: 10, year: 2026 }, "paid").get("paymentStatus")).toBe("paid");
    expect(statementQuery({ month: 10, year: 2026 }, "pending").get("paymentStatus")).toBe("pending");
    expect(statementQuery({ month: 10, year: 2026 }, "whatever").has("paymentStatus")).toBe(false);
  });
});

describe("the Payroll tab's address", () => {
  it("lists the records as a table, one department at a time, unless the address says otherwise", () => {
    expect(STAFF_URL_DEFAULTS.layout).toBe("table");
    expect(STAFF_URL_DEFAULTS.pdept).toBe("");
  });
});
