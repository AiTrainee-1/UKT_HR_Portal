import { describe, expect, it } from "vitest";
import { readSmsOverview } from "./sms-control";

// The overview is read through readSmsOverview, so a server that leaves a key out (an older or a newer build) shows "unknown"
// on the SMS Control page instead of crashing it.

describe("readSmsOverview", () => {
  it("fills in every key of an empty answer, with the safe reading of each", () => {
    expect(readSmsOverview(null)).toEqual({
      provider: "twofactor",
      channel: "whatsapp",
      configured: false,
      sendingAllowed: false,
      sendingNote: "",
      env: { authKey: false, senderId: "", templateName: "", apiBase: "" },
      balance: { available: null, checkedAt: null, error: null },
      today: { sent: 0, failed: 0, blocked: 0 },
      last7Days: [],
      lastSentAt: null,
      limits: { hourlyCap: 0, dailyCap: 0, hourUsed: 0, dayUsed: 0 },
      circuit: { paused: false, until: null },
    });
    expect(readSmsOverview(undefined).channel).toBe("whatsapp");
    expect(readSmsOverview({}).circuit.paused).toBe(false);
  });

  it("keeps what the server sent", () => {
    const o = readSmsOverview({
      provider: "twofactor",
      channel: "sms",
      configured: true,
      sendingAllowed: true,
      sendingNote: "ok",
      env: { authKey: true, senderId: "UKTHRM", templateName: "", apiBase: "https://2factor.in/API/V1" },
      balance: { available: 12.5, checkedAt: "2026-10-14T06:00:00Z", error: null },
      today: { sent: 3, failed: 1, blocked: 2 },
      last7Days: [{ date: "2026-10-14", sent: 3, failed: 1 }],
      lastSentAt: "2026-10-14T05:00:00Z",
      limits: { hourlyCap: 100, dailyCap: 500, hourUsed: 3, dayUsed: 9 },
      circuit: { paused: true, until: "2026-10-14T06:10:00Z" },
    });
    expect(o.channel).toBe("sms");
    expect(o.configured).toBe(true);
    expect(o.env).toEqual({
      authKey: true,
      senderId: "UKTHRM",
      templateName: "",
      apiBase: "https://2factor.in/API/V1",
    });
    expect(o.balance.available).toBe(12.5);
    expect(o.today).toEqual({ sent: 3, failed: 1, blocked: 2 });
    expect(o.last7Days).toEqual([{ date: "2026-10-14", sent: 3, failed: 1 }]);
    expect(o.circuit).toEqual({ paused: true, until: "2026-10-14T06:10:00Z" });
  });

  it("treats a wrong type as missing, not as a value", () => {
    const o = readSmsOverview({
      channel: "carrier-pigeon" as never,
      configured: "yes" as never,
      balance: { available: "lots" as never, checkedAt: 5 as never, error: "" },
      today: { sent: "3" as never, failed: NaN, blocked: undefined as never },
      last7Days: [{ date: "2026-10-14", sent: "x" as never, failed: 2 }, null as never],
    });
    expect(o.channel).toBe("whatsapp");
    expect(o.configured).toBe(false);
    expect(o.balance).toEqual({ available: null, checkedAt: null, error: null });
    expect(o.today).toEqual({ sent: 0, failed: 0, blocked: 0 });
    expect(o.last7Days).toEqual([
      { date: "2026-10-14", sent: 0, failed: 2 },
      { date: "", sent: 0, failed: 0 },
    ]);
  });
});
