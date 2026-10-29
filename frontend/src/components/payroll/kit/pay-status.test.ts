import { describe, expect, it } from "vitest";
import { CLEARED_LABEL, MARK_CLEARED_LABEL, payStatusLabel } from "./pay-status";

// The company tracks whether a salary is cleared or still pending, not who was paid: the stored value stays "paid".
describe("a payroll's status in words", () => {
  it("shows the stored 'paid' as Cleared, whatever its case or spaces, and keeps Pending", () => {
    expect(CLEARED_LABEL).toBe("Cleared");
    expect(payStatusLabel("paid")).toBe("Cleared");
    expect(payStatusLabel(" Paid ")).toBe("Cleared");
    expect(payStatusLabel("PAID")).toBe("Cleared");
    expect(payStatusLabel("pending")).toBe("Pending");
  });

  it("capitalises any other status as it came, and reads nothing as nothing", () => {
    expect(payStatusLabel("approved")).toBe("Approved");
    expect(payStatusLabel("locked")).toBe("Locked");
    expect(payStatusLabel("")).toBe("");
    expect(payStatusLabel(null)).toBe("");
    expect(payStatusLabel(undefined)).toBe("");
  });

  it("names the button that clears a salary", () => {
    expect(MARK_CLEARED_LABEL).toBe("Mark as Cleared");
  });
});
