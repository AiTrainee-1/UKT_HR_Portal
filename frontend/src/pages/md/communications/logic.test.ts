import { describe, expect, it } from "vitest";
import { overviewFixture } from "./fixtures";
import {
  applyCommsPatch,
  assistantSummary,
  axisRupees,
  changeChip,
  commsSearch,
  costRows,
  headlineFigures,
  historyParams,
  insightsFor,
  messageRows,
  monthRows,
  parseCommsState,
  perChannelText,
  purposeBars,
  rateText,
  rupees,
  statusItems,
  type CommsState,
} from "./logic";
import type { PurposeRow } from "./types";

const BLANK: CommsState = parseCommsState("");

describe("the state in the address", () => {
  it("reads every filter and drops what is not valid", () => {
    expect(BLANK).toEqual({ month: "", channel: "all", status: "", from: "", to: "", q: "", page: 1, purpose: "" });
    expect(
      parseCommsState(
        "?month=2026-10&channel=sms&status=failed&from=2026-10-03&to=2026-10-09&q=asha&page=3&purpose=login",
      ),
    ).toEqual({
      month: "2026-10",
      channel: "sms",
      status: "failed",
      from: "2026-10-03",
      to: "2026-10-09",
      q: "asha",
      page: 3,
      purpose: "login",
    });
    const bad = parseCommsState("?month=2026-13&channel=fax&status=lost&from=2026-10-09&to=2026-10-03&page=-2");
    expect(bad).toEqual(BLANK);
    // a purpose belongs to one channel
    expect(parseCommsState("?purpose=otp").purpose).toBe("");
  });

  it("writes back only what differs from the defaults", () => {
    expect(commsSearch(BLANK)).toBe("");
    const s = {
      ...BLANK,
      month: "2026-10",
      channel: "whatsapp" as const,
      status: "failed" as const,
      purpose: "otp",
      page: 2,
    };
    expect(commsSearch(s)).toBe("?month=2026-10&channel=whatsapp&status=failed&purpose=otp&page=2");
    expect(parseCommsState(commsSearch(s))).toEqual(s);
  });

  it("a new month drops the custom range, a new channel drops the purpose, any filter goes back to page 1", () => {
    const s: CommsState = {
      ...BLANK,
      month: "2026-11",
      channel: "whatsapp",
      from: "2026-11-02",
      to: "2026-11-05",
      purpose: "otp",
      page: 4,
    };
    expect(applyCommsPatch(s, { month: "2026-10" })).toMatchObject({ month: "2026-10", from: "", to: "", page: 1 });
    expect(applyCommsPatch(s, { channel: "sms" })).toMatchObject({ channel: "sms", purpose: "", page: 1 });
    expect(applyCommsPatch(s, { channel: "sms", purpose: "login" })).toMatchObject({ purpose: "login" });
    expect(applyCommsPatch(s, { channel: "all" }).purpose).toBe("");
    expect(applyCommsPatch(s, { status: "failed" }).page).toBe(1);
    expect(applyCommsPatch(s, { page: 5 }).page).toBe(5);
    expect(applyCommsPatch(s, { month: "2026-11" })).toEqual(s); // nothing changed, nothing reset
  });

  it("asks the history for the month, or for the custom range", () => {
    expect(historyParams(BLANK)).toEqual({
      channel: "all",
      month: undefined,
      status: undefined,
      q: undefined,
      purpose: undefined,
      page: 1,
      pageSize: 25,
    });
    const s = { ...BLANK, month: "2026-10", from: "2026-10-03", to: "2026-10-09", status: "failed" as const };
    expect(historyParams(s)).toMatchObject({ from: "2026-10-03", to: "2026-10-09", status: "failed" });
    expect(historyParams(s)).not.toHaveProperty("month");
  });
});

describe("money and change", () => {
  it("shows paise, a rate's finer digits and short axis labels", () => {
    expect(rupees(1.44)).toBe("₹1.44");
    expect(rupees(0)).toBe("₹0.00");
    expect(rupees(null)).toBe("—");
    expect(rupees(250000)).toBe("₹2.5 L");
    expect(rateText(0.115)).toBe("₹0.115");
    expect(rateText(0.2)).toBe("₹0.20");
    expect(rateText(0.8631)).toBe("₹0.8631");
    expect(axisRupees(0)).toBe("₹0");
    expect(axisRupees(2.5)).toBe("₹2.50");
    expect(axisRupees(150)).toBe("₹150");
  });

  it("a change chip says how much and against which month; cost rising is bad news", () => {
    expect(changeChip({ abs: 3.26, pct: 291.1 }, "2026-10", { money: true, higherIsBetter: false })).toEqual({
      text: "+291% vs Oct",
      tone: "bad",
      direction: "up",
    });
    expect(changeChip({ abs: -0.5, pct: -4.2 }, "2026-10", { money: true, higherIsBetter: false })).toEqual({
      text: "-4.2% vs Oct",
      tone: "good",
      direction: "down",
    });
    // the month before had none: the amount, not a percentage
    expect(changeChip({ abs: 16, pct: null }, "2026-10")).toEqual({
      text: "+16 vs Oct",
      tone: "neutral",
      direction: "up",
    });
    expect(changeChip({ abs: 1.12, pct: null }, "2026-09", { money: true })?.text).toBe("+₹1.12 vs Sep");
    expect(changeChip(null, "2026-10")).toBeNull();
  });
});

describe("rows for the charts and tables", () => {
  const o = overviewFixture();

  it("12 months of cost (WhatsApp and SMS) and of messages per chosen channel", () => {
    expect(costRows(o.series).at(-1)).toEqual({ month: "2026-11", whatsapp: 1.44, sms: 0.75, total: 2.19 });
    expect(messageRows(o.series, ["sms"]).at(-2)).toEqual({ month: "2026-10", sms: 4 });
  });

  it("the month table runs newest first with the cost change against the month before", () => {
    const rows = monthRows(o.series);
    expect(rows[0]).toMatchObject({ month: "2026-11", messages: 16, cost: 2.19, costChangePct: 95.5 });
    expect(rows[1]).toMatchObject({ month: "2026-10", costChangePct: null }); // September cost nothing
    expect(rows).toHaveLength(12);
  });

  it("purposes are ranked by cost when anything costs money, else by messages", () => {
    const rows: PurposeRow[] = [
      { channel: "email", key: "documents", label: "Documents", messages: 5, failed: 1, skipped: 0, cost: 0, types: 2 },
      {
        channel: "whatsapp",
        key: "otp",
        label: "OTP & Login",
        messages: 2,
        failed: 0,
        skipped: 0,
        cost: 0.23,
        types: 1,
      },
      {
        channel: "whatsapp",
        key: "visitors",
        label: "Visitors",
        messages: 1,
        failed: 0,
        skipped: 0,
        cost: 0.86,
        types: 1,
      },
    ];
    const all = purposeBars(rows, "all");
    expect(all.byCost).toBe(true);
    expect(all.items.map((i) => i.key)).toEqual(["whatsapp:visitors", "whatsapp:otp", "email:documents"]);
    expect(all.items[0].label).toBe("Visitors (WhatsApp)");
    const mail = purposeBars(rows, "email");
    expect(mail.byCost).toBe(false);
    expect(mail.items[0]).toMatchObject({ label: "Documents", display: "5 sent", sub: "No charge" });
  });

  it("the status switch leaves out what a channel cannot have", () => {
    const counts = { sent: 3, delivered: null, failed: 1, skipped: 1, waiting: 0, total: 5 };
    expect(statusItems(counts, "sms").map((i) => i.label)).toEqual(["All", "Sent", "Failed", "Skipped"]);
    expect(statusItems(undefined, "all").map((i) => i.value)).toEqual([
      "",
      "sent",
      "delivered",
      "failed",
      "skipped",
      "waiting",
    ]);
  });

  it("the headline follows the channel filter: the totals for all, a channel's own block otherwise", () => {
    const all = headlineFigures(o, "all");
    expect(all).toMatchObject({ messages: 16, cost: 2.19, projectedCost: 4.38, budget: 2.5, free: false });
    expect(all.sparkMessages.at(-1)).toBe(16);
    const sms = headlineFigures(o, "sms");
    expect(sms).toMatchObject({
      messages: 3,
      failed: 1,
      cost: 0.75,
      projectedCost: 1.5,
      budget: null,
      budgetChannels: [],
    });
    expect(sms.change?.cost).toEqual({ abs: 0.5, pct: 50 });
    expect(sms.sparkMessages.slice(-2)).toEqual([4, 3]);
    const wa = headlineFigures(o, "whatsapp");
    expect(wa).toMatchObject({ budget: 2, budgetCost: 1.44, budgetUsedPct: 71.9, budgetChannels: ["whatsapp"] });
    expect(headlineFigures(o, "email")).toMatchObject({ messages: 5, cost: 0, free: true });
  });

  it("insights about another channel step aside; company-wide ones stay", () => {
    const items = [
      { id: "a", severity: "info" as const, title: "a", channel: "sms" as const },
      { id: "b", severity: "info" as const, title: "b", channel: null },
      { id: "c", severity: "info" as const, title: "c", channel: "whatsapp" as const },
    ];
    expect(insightsFor(items, "all").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(insightsFor(items, "sms").map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("words for the cards and the assistant", () => {
    expect(perChannelText(o.channels, (b) => String(b.messages))).toBe("WhatsApp 8 · SMS 3 · Gmail 5");
    expect(assistantSummary(o.channels, o.totals)).toEqual({
      "Messages sent": "16",
      "Estimated cost (before GST)": "₹2.19",
      "Projected month cost": "₹4.38",
      WhatsApp: "8 sent, 1 failed, ₹1.44",
      SMS: "3 sent, 1 failed, ₹0.75",
      Gmail: "5 sent, 1 failed, no charge",
    });
  });
});
