import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useLocation, useSearch } from "wouter";
import MdCommunications from "../MdCommunications";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { balanceFixture, commsFixtures, historyFixture, overviewFixture } from "./fixtures";

/** The address as the router sees it, for asserting on the URL state. */
function UrlProbe() {
  const [path] = useLocation();
  const search = useSearch();
  return (
    <output hidden data-testid="probe-url">
      {path}
      {search ? `?${search}` : ""}
    </output>
  );
}

function PageWithProbe() {
  return (
    <>
      <MdCommunications />
      <UrlProbe />
    </>
  );
}

// jsdom has no layout, so recharts' ResponsiveContainer measures 0 x 0 and warns on every chart: not news here.
beforeAll(() => {
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  const quiet =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      if (!String(args[0]).includes("of chart should be greater than 0")) original(...args);
    };
  vi.spyOn(console, "warn").mockImplementation(quiet(warn));
  vi.spyOn(console, "error").mockImplementation(quiet(error));
});
afterAll(() => vi.restoreAllMocks());

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (path = "/md/communications", over: Fixtures = {}) => {
  page = await renderMdPage(PageWithProbe, { ...commsFixtures(), ...over }, { path });
  return page;
};
const by = (testId: string) => page!.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const textOf = (testId: string) => (by(testId)?.textContent ?? "").replace(/\s+/g, " ").trim();
const url = () => textOf("probe-url");
const requestsTo = (endpoint: string) =>
  page!
    .requests()
    .filter((r) => r.split("?")[0] === `/api/md/comms/${endpoint}`)
    .map((r) => new URLSearchParams(r.split("?")[1] ?? ""));
const last = (endpoint: string) => requestsTo(endpoint).at(-1);

describe("the executive overview", () => {
  it("opens on this month with the four headline figures and their change against last month", async () => {
    await open();
    expect(textOf("md-page-title")).toBe("Communication usage & cost");
    expect(last("overview")?.get("month")).toBeNull(); // the server decides this month (IST)
    expect(last("overview")?.get("months")).toBe("12");
    expect(textOf("md-comms-kpi-messages-value")).toBe("16");
    expect(textOf("md-comms-kpi-messages")).toContain("WhatsApp 8 · SMS 3 · Gmail 5");
    expect(textOf("md-comms-kpi-messages")).toContain("+357% vs Oct");
    expect(textOf("md-comms-kpi-cost-value")).toBe("₹2.19");
    expect(textOf("md-comms-kpi-cost")).toContain("Before GST");
    // cost rising is bad news: crimson
    expect(by("md-comms-kpi-cost")?.querySelector(".md-chip-danger")).not.toBeNull();
    expect(textOf("md-comms-kpi-projected-value")).toBe("₹4.38");
    expect(textOf("md-comms-kpi-projected")).toContain("15 of 30 days");
    expect(textOf("md-comms-kpi-budget-value")).toBe("87.6%");
    expect(textOf("md-comms-kpi-budget")).toContain("₹2.19 of ₹2.50 (WhatsApp + SMS budgets)");
    expect(textOf("md-comms-basis")).toContain("This month at its current pace, against Oct 2026: 7 messages, ₹1.12");
  });

  it("one card per channel, with cost, delivery, budget, credits and Gmail's free sending", async () => {
    await open();
    const wa = textOf("md-comms-card-whatsapp");
    expect(wa).toContain("8 sent");
    expect(wa).toContain("₹1.44 est. (₹1.70 with GST)");
    expect(wa).toContain("4 delivered · 1 failed · 1 skipped · 1 waiting");
    expect(wa).toContain("Budget ₹2.00: 71.9% used, 143.8% at this pace");
    const sms = textOf("md-comms-card-sms");
    expect(sms).toContain("₹0.75 est. at ₹0.25 each");
    expect(sms).toContain("500 credits left on 2Factor");
    expect(sms).not.toContain("delivered"); // SMS has no delivery receipt
    const email = textOf("md-comms-card-email");
    expect(email).toContain("No per-email charge");
    expect(email).toContain("Busiest day 2 of 500 a day allowed");
  });

  it("low SMS credits are marked", async () => {
    await open("/md/communications", {
      "/api/md/comms/sms-balance": balanceFixture({ credits: 40, isLow: true }),
    });
    expect(textOf("md-comms-sms-credits")).toBe("40 credits left on 2Factor");
    expect(by("md-comms-sms-credits")?.className).toContain("text-md-danger-700");
  });

  it("the summary and what stands out, most serious first", async () => {
    await open();
    expect(textOf("md-comms-summary")).toContain("sent 16 messages");
    const items = [...page!.container.querySelectorAll<HTMLElement>('[data-testid^="insight-comms."]')];
    expect(items.map((i) => i.dataset.severity)).toEqual(["critical", "info"]);
    expect(items[0].textContent).toContain("SMS cost ₹0.75 is over its ₹0.50 budget");
    expect(items[0].querySelector('[data-testid="ask-ai"]')).not.toBeNull(); // Explain
  });

  it("a past month shows its failures instead of a projection, and actual changes", async () => {
    await open("/md/communications?month=2026-10");
    expect(last("overview")?.get("month")).toBe("2026-10");
    expect(by("md-comms-kpi-projected")).toBeNull();
    expect(textOf("md-comms-kpi-failed-value")).toBe("0");
    expect(textOf("md-comms-kpi-cost")).toContain("+₹1.12 vs Sep");
    expect(textOf("md-comms-kpi-budget-value")).toBe("No budget");
    expect(textOf("md-comms-basis")).toContain("Against Sep 2026");
  });
});

describe("filters in the address", () => {
  it("a channel card narrows the page to that channel, and a second click shows all again", async () => {
    await open();
    await page!.click('[data-testid="md-comms-card-sms"]');
    expect(url()).toBe("/md/communications?channel=sms");
    expect(last("history")?.get("channel")).toBe("sms");
    // the breakdown is filtered on the page: no second month request for a channel switch
    expect(requestsTo("month")).toHaveLength(1);
    // every figure follows the channel: the headline shows SMS alone
    expect(textOf("md-comms-kpi-messages-value")).toBe("3");
    expect(textOf("md-comms-kpi-messages")).toContain("SMS only");
    expect(textOf("md-comms-kpi-cost-value")).toBe("₹0.75");
    expect(textOf("md-comms-kpi-projected-value")).toBe("₹1.50");
    expect(textOf("md-comms-kpi-budget")).toContain("A monthly budget can be set on SMS Control.");
    // the WhatsApp insight steps aside, the SMS one stays
    expect(by("insight-comms.whatsapp-top-type")).toBeNull();
    expect(by("insight-comms.sms-over-budget")).not.toBeNull();
    expect(textOf("md-comms-type-table")).toContain("Login");
    expect(textOf("md-comms-type-table")).not.toContain("Salary Slip");
    expect(by("md-comms-pricing")).toBeNull(); // WhatsApp pricing only with WhatsApp shown
    // the history's status switch has no Delivered / Waiting for SMS
    expect(by("md-comms-status-delivered")).toBeNull();
    await page!.click('[data-testid="md-comms-card-sms"]');
    expect(url()).toBe("/md/communications");
  });

  it("the channel switch and the month picker write the address, and a refresh keeps them", async () => {
    await open("/md/communications?month=2026-10&channel=whatsapp");
    expect(by("md-comms-channel-whatsapp")?.getAttribute("aria-selected")).toBe("true");
    expect(last("overview")?.get("month")).toBe("2026-10");
    expect(last("month")?.get("month")).toBe("2026-10");
    expect(last("history")?.get("month")).toBe("2026-10");
    await page!.click('[data-testid="month-next"]');
    // the latest month is the default, so it leaves the address
    expect(url()).toBe("/md/communications?channel=whatsapp");
    await page!.click('[data-testid="md-comms-channel-all"]');
    expect(url()).toBe("/md/communications");
  });

  it("clicking a month in the table opens it", async () => {
    await open();
    await page!.click('[data-testid="md-comms-month-table"] [data-testid="row-2026-10"]');
    expect(url()).toBe("/md/communications?month=2026-10");
    expect(last("month")?.get("month")).toBe("2026-10");
  });

  it("a purpose opens the history filtered to it, on its channel", async () => {
    await open();
    await page!.click('[data-testid="bar-whatsapp:otp"] button');
    expect(url()).toBe("/md/communications?channel=whatsapp&purpose=otp");
    expect(last("history")?.get("purpose")).toBe("otp");
    expect(last("history")?.get("channel")).toBe("whatsapp");
    expect(by("md-comms-purpose-chip")).not.toBeNull();
    await page!.click('[data-testid="md-comms-purpose-chip"]');
    expect(url()).toBe("/md/communications?channel=whatsapp");
  });
});

describe("the month in detail", () => {
  it("purposes ranked by cost, message types, WhatsApp pricing and Meta's figure", async () => {
    await open();
    expect(textOf("md-comms-detail")).toContain("Nov 2026 in detail");
    const bars = [...page!.container.querySelectorAll<HTMLElement>('[data-testid="md-comms-purpose-bars"] > li')];
    expect(bars[0].textContent).toContain("Visitors (WhatsApp)");
    expect(bars[0].textContent).toContain("₹0.86");
    expect(textOf("md-comms-type-table")).toContain("Visitor Notification");
    expect(textOf("md-comms-category-table")).toContain("₹0.8631");
    expect(textOf("md-comms-meta")).toContain("Meta's own figure is not available");
  });

  it("Meta's own figure when Meta answers", async () => {
    const { monthFixture } = await import("./fixtures");
    await open("/md/communications", {
      "/api/md/comms/month": monthFixture({ meta: { available: true, cost: 1.52, volume: 7, error: null } }),
    });
    expect(textOf("md-comms-meta")).toContain("Meta's own figure for the month: ₹1.52 for 7 messages");
  });

  it("Gmail alone has no cost chart", async () => {
    await open("/md/communications?channel=email");
    expect(by("md-comms-cost-chart")).toBeNull();
    expect(textOf("md-comms-cost")).toContain("Gmail has no per-email charge");
    expect(textOf("md-comms-kpi-cost-value")).toBe("No charge");
    expect(textOf("md-comms-kpi-messages-value")).toBe("5");
  });
});

describe("the message history", () => {
  it("lists masked messages with status counts and estimated cost", async () => {
    await open();
    expect(textOf("md-comms-status-all")).toBe("All24");
    expect(textOf("md-comms-status-failed")).toBe("Failed3");
    const table = textOf("md-comms-history-table");
    expect(table).toContain("Asha Kumar");
    expect(table).toContain("••••••••0011");
    expect(table).toContain("2Factor refused the number");
    expect(table).toContain("₹0.115");
    expect(textOf("md-comms-history")).toContain("Phone numbers and email addresses are masked");
  });

  it("status, dates, search and pages go to the server and into the address", async () => {
    await open("/md/communications", {
      "/api/md/comms/history": historyFixture({ total: 60, pages: 3 }),
    });
    await page!.click('[data-testid="md-comms-status-failed"]');
    expect(url()).toBe("/md/communications?status=failed");
    expect(last("history")?.get("status")).toBe("failed");

    await page!.click('[data-testid="md-comms-next"]');
    expect(url()).toBe("/md/communications?status=failed&page=2");
    expect(last("history")?.get("page")).toBe("2");

    await page!.type('[data-testid="md-comms-from"]', "2026-11-03");
    await page!.type('[data-testid="md-comms-to"]', "2026-11-09");
    expect(url()).toBe("/md/communications?status=failed&from=2026-11-03&to=2026-11-09");
    expect(last("history")?.get("from")).toBe("2026-11-03");
    expect(last("history")?.get("month")).toBeNull();
    await page!.click('[data-testid="md-comms-range-clear"]');
    expect(url()).toBe("/md/communications?status=failed");

    await page!.type('[data-testid="md-comms-search"]', "asha");
    await new Promise((r) => setTimeout(r, 350));
    await page!.settle();
    expect(url()).toBe("/md/communications?status=failed&q=asha");
    expect(last("history")?.get("q")).toBe("asha");
  });

  it("an empty period says so", async () => {
    await open("/md/communications", {
      "/api/md/comms/history": historyFixture({
        items: [],
        total: 0,
        statusCounts: { sent: 0, delivered: 0, failed: 0, skipped: 0, waiting: 0, total: 0 },
      }),
    });
    expect(textOf("md-comms-history")).toContain("No message in this period.");
    expect(by("md-comms-pager")).toBeNull();
  });
});

describe("empty and failing answers", () => {
  it("an empty company shows zeros and no insights, never a crash", async () => {
    const empty = overviewFixture({
      totals: {
        ...overviewFixture().totals,
        messages: 0,
        cost: 0,
        projectedCost: 0,
        projectedMessages: 0,
        budget: null,
        budgetCost: null,
        budgetUsedPct: null,
        budgetChannels: [],
        change: { messages: { abs: 0, pct: null }, cost: { abs: 0, pct: null } },
      },
      insights: [],
      summary: "In Nov 2026 the HRMS sent 0 messages.",
    });
    await open("/md/communications", { "/api/md/comms/overview": empty });
    expect(textOf("md-comms-kpi-messages-value")).toBe("0");
    expect(textOf("md-comms-kpi-budget-value")).toBe("No budget");
    expect(textOf("md-comms-standout")).toContain("No budget, cost or failure problem this month.");
  });

  it("a failed overview shows the server's reason with a retry; the rest of the page still works", async () => {
    await open("/md/communications", {
      "/api/md/comms/overview": { status: 500, body: { error: "The database is busy." } },
    });
    // a 5xx is tried once more (useMdQuery) about a second later before the page gives up
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await page!.settle();
    expect(textOf("md-error")).toContain("The database is busy.");
    expect(textOf("md-comms-history-table")).toContain("Asha Kumar");
  });

  it("a failed breakdown is reported in its place", async () => {
    await open("/md/communications", {
      "/api/md/comms/month": { status: 400, body: { error: "Dec 2026 has not started yet." } },
    });
    expect(textOf("md-comms-kpi-messages-value")).toBe("16");
    expect(page!.text()).toContain("Dec 2026 has not started yet.");
  });
});
