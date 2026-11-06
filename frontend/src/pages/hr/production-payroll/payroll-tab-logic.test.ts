import { describe, expect, it } from "vitest";
import { PRODUCTION_URL_DEFAULTS } from "./logic";
import {
  PRODUCTION_PAGE_URL_DEFAULTS,
  PRODUCTION_STATEMENT_REPORT_ID,
  productionStatementQuery,
} from "./payroll-tab-logic";

const WEEK = { periodStart: "2026-02-02", periodEnd: "2026-02-08" };

describe("the Payroll tab's address keys", () => {
  it("open the records as a table, one department at a time, like Staff Payroll", () => {
    expect(PRODUCTION_PAGE_URL_DEFAULTS.layout).toBe("table");
    expect(PRODUCTION_PAGE_URL_DEFAULTS.pdept).toBe("");
  });

  it("keep every other key of the cycle page as it was", () => {
    const { layout: _layout, pdept: _pdept, ...rest } = PRODUCTION_PAGE_URL_DEFAULTS;
    const { layout: _old, ...before } = PRODUCTION_URL_DEFAULTS;
    expect(rest).toEqual(before);
  });
});

describe("the Production Salary Statement download", () => {
  it("is the Report Center's HR Reports report", () => {
    expect(PRODUCTION_STATEMENT_REPORT_ID).toBe("hr-production-salary-statement");
  });

  it("asks for the cycle and the period's first and last day", () => {
    expect(productionStatementQuery("weekly", WEEK).toString()).toBe(
      "cycle=weekly&dateFrom=2026-02-02&dateTo=2026-02-08",
    );
    expect(
      productionStatementQuery("biweekly", { periodStart: "2026-02-02", periodEnd: "2026-02-15" }).get("cycle"),
    ).toBe("biweekly");
  });

  it("carries the payment status only when the page shows Cleared or Pending alone", () => {
    expect(productionStatementQuery("monthly", WEEK, "paid").get("paymentStatus")).toBe("paid");
    expect(productionStatementQuery("monthly", WEEK, "pending").get("paymentStatus")).toBe("pending");
    expect(productionStatementQuery("monthly", WEEK, "all").has("paymentStatus")).toBe(false);
    expect(productionStatementQuery("monthly", WEEK).has("paymentStatus")).toBe(false);
  });
});
