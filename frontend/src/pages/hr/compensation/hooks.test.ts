import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  getBalancesQueryKey,
  getOvertimeListQueryKey,
  getCompensationConfigQueryKey,
  getCompensationSettingsQueryKey,
  invalidateCompensation,
} from "@/lib/api-client/custom-hooks";

// A change to one Compensation record can change several lists (an assigned relaxation moves a report, a redeemed balance moves
// the balances), so every change marks every Compensation query stale, and nothing else.

const stale = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true;

describe("invalidateCompensation", () => {
  it("marks every query whose key starts with /api/compensation, and no other", async () => {
    const client = new QueryClient();
    const compensation: (readonly unknown[])[] = [
      ["/api/compensation", { search: "" }],
      getOvertimeListQueryKey(10, 2026),
      getBalancesQueryKey(),
      ["/api/compensation/balance", 21],
      ["/api/compensation/windows", { kind: "all" }],
      ["/api/compensation/holiday-work", { status: "pending" }],
      ["/api/compensation/holiday-work/eligible", "2026-10-11"],
      ["/api/compensation/birthdays", { period: "today" }],
      ["/api/compensation/reports", { period: "week" }],
      ["/api/compensation/credits", {}],
      getCompensationConfigQueryKey(),
      getCompensationSettingsQueryKey(),
    ];
    const others: (readonly unknown[])[] = [
      ["/api/payroll-settings"],
      ["/api/employees", "search", "asha"],
      ["/api/attendance/employee/7"],
      ["/api/branches"],
    ];
    for (const key of [...compensation, ...others]) client.setQueryData(key, { ok: true });

    await invalidateCompensation(client);

    for (const key of compensation) expect(stale(client, key), JSON.stringify(key)).toBe(true);
    for (const key of others) expect(stale(client, key), JSON.stringify(key)).toBe(false);
  });

  it("leaves a query whose first key is not a string alone", async () => {
    const client = new QueryClient();
    client.setQueryData([{ path: "/api/compensation" }], 1);
    client.setQueryData([42, "/api/compensation"], 1);
    await invalidateCompensation(client);
    expect(stale(client, [{ path: "/api/compensation" }])).toBe(false);
    expect(stale(client, [42, "/api/compensation"])).toBe(false);
  });
});
