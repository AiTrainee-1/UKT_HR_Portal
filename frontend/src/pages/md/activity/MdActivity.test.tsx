import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import MdActivity from "../MdActivity";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { EMPTY_FIXTURES, FIXTURES, sensitiveItems, sensitivePage } from "./fixtures";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  // jsdom has no scrollIntoView: a test that stubs it must not leak the stub into the next one
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

/** Let real time pass (a debounce, a retry delay) inside act, so the updates it causes are not reported as stray. */
const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
const byId = (p: RenderedPage, id: string) => p.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (p: RenderedPage, id: string) => byId(p, id)?.textContent ?? "";
const rows = (p: RenderedPage) => p.container.querySelectorAll('[data-testid^="md-activity-row-"]');
const requested = (p: RenderedPage) => p.requests();
const render = (fixtures: Fixtures = FIXTURES) => renderMdPage(MdActivity, fixtures, { path: "/md/activity" });

describe("Activity Logs: the page", () => {
  it("shows the headline figures of the server, each beside what it was before", async () => {
    page = await render();
    expect(text(page, "md-page-title")).toBe("Activity Logs");
    expect(text(page, "md-activity-kpi-actions-value")).toBe("13");
    expect(text(page, "md-activity-kpi-people-value")).toBe("4");
    expect(text(page, "md-activity-kpi-sensitive-value")).toBe("8");
    expect(text(page, "md-activity-kpi-after-hours-value")).toBe("4");
    expect(text(page, "md-activity-kpi-sign-ins-value")).toBe("7");
    expect(text(page, "md-activity-kpi-failed-value")).toBe("6");
    expect(text(page, "md-activity-kpi-actions")).toContain("Previous 7 days: 5");
    expect(text(page, "md-activity-kpi-actions")).toContain("+160%");
    expect(text(page, "md-activity-kpi-sensitive")).toContain("1 critical · 4 high · 3 medium");
    expect(text(page, "md-activity-kpi-after-hours")).toContain("30.8% of actions · 1 on Sunday");
    expect(text(page, "md-activity-kpi-people")).toContain("of 4 enabled accounts");
    expect(text(page, "md-activity-kpi-failed")).toContain("1 lock-out · 1 blocked try");
  });

  it("calls every endpoint of the module and shows every card", async () => {
    page = await render();
    for (const id of [
      "md-activity-attention",
      "md-activity-trend",
      "md-activity-areas",
      "md-activity-users",
      "md-activity-heatmap",
      "md-activity-sensitive",
      "md-activity-sign-ins",
    ]) {
      expect(byId(page, id), id).not.toBeNull();
    }
    const paths = requested(page).map((r) => r.split("?")[0]);
    for (const path of Object.keys(FIXTURES)) {
      if (path !== "/api/md/activity/feed") expect(paths, path).toContain(path); // the full feed is only fetched on request
    }
  });

  it("puts the exceptions first, the worst first, and offers only the period (no scope)", async () => {
    page = await render();
    const attention = byId(page, "md-activity-attention")!;
    expect(attention.textContent).toContain("Needs your attention");
    expect(attention.textContent).toContain("whichever period is chosen below");
    const insights = Array.from(attention.querySelectorAll("[data-severity]")).map((e) =>
      e.getAttribute("data-severity"),
    );
    expect(insights).toEqual(["critical", "warning"]); // sorted: the server sent the warning first
    expect(attention.textContent).toContain("1 critical system change in the last 7 days");
    expect(attention.textContent).not.toContain("Activity Logs"); // no link to the page we are on
    // the card comes before the trend and the lists
    const follows = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(attention, byId(page, "md-activity-trend")!)).toBe(true);
    expect(follows(byId(page, "md-activity-kpis")!, attention)).toBe(true);
    expect(byId(page, "scope-bar")).toBeNull();
    expect(byId(page, "period-bar")).not.toBeNull();
  });

  it("gives every card a way to see how its figures are made and a question for the assistant", async () => {
    page = await render();
    expect(page.container.querySelectorAll('[data-testid="provenance-button"]').length).toBeGreaterThanOrEqual(13); // 6 tiles + 7 cards
    expect(page.container.querySelectorAll('[data-testid="ask-ai"]').length).toBeGreaterThanOrEqual(8);
    await page.click('[data-testid="ask-ai"]'); // the first one: the page header's
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toContain("Summarise system activity for 28 sep – 04 oct 2026");
  });

  it("tells the assistant what is on screen, and forgets it on leaving", async () => {
    page = await render();
    const context = getAssistantState().context;
    expect(context?.page).toBe("activity");
    expect(context?.title).toBe("Activity Logs");
    expect(context?.filters).toEqual({ Period: "28 Sep – 04 Oct 2026" });
    expect(context?.summary).toMatchObject({ Actions: 13, "Sensitive actions": 8, "Failed sign-ins": 6 });
    page.unmount();
    page = undefined;
    expect(getAssistantState().context).toBeNull();
  });

  it("asks the server again, with the new period, when the period changes", async () => {
    page = await render();
    expect(requested(page).some((r) => r.includes("/activity/summary?period=last_30_days"))).toBe(true); // the default
    await page.click('[role="tab"]:nth-child(2)'); // Last 7 days
    expect(requested(page).some((r) => r.includes("/activity/summary?period=last_7_days"))).toBe(true);
    expect(requested(page).some((r) => r.includes("/activity/sensitive?period=last_7_days"))).toBe(true);
    const attentionCalls = requested(page).filter((r) => r.startsWith("/api/md/activity/attention"));
    expect(attentionCalls.every((r) => r === "/api/md/activity/attention")).toBe(true); // always the last 7 days
  });

  it("scrolls to the card a headline tile belongs to", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    page = await render();
    await page.click('[data-testid="md-activity-kpi-sensitive"]');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.mock.instances[0] as HTMLElement).id).toBe("md-activity-sensitive");
  });
});

describe("Activity Logs: charts and tables", () => {
  it("captions the trend and shows where the activity is", async () => {
    page = await render();
    expect(text(page, "md-activity-trend-caption")).toBe("Busiest day: Fri 02 Oct (4 actions) · 1.9 a day on average");
    const bars = text(page, "md-activity-area-bars");
    expect(bars).toContain("Employees");
    expect(bars).toContain("69.2% of actions · 4 sensitive · +4 (+80%) vs before");
    expect(bars).toContain("+2 (new) vs before");
  });

  it("ranks people with role, share, sensitive and after-hours counts", async () => {
    page = await render();
    const table = text(page, "md-activity-users-table");
    expect(table).toContain("Anita Rao");
    expect(table).toContain("Payroll Officer");
    expect(table).toContain("53.8%");
    expect(table).toContain("Sat 03 Oct, 8:59 pm");
    expect(table).toContain("+5 (+250%)");
    expect(table).toContain("+3 (new)");
    expect(byId(page, "row-Anita Rao")?.querySelector("[data-initials]")?.getAttribute("data-initials")).toBe("AR");
  });

  it("charts the weekday by hour grid and who works outside normal hours", async () => {
    page = await render();
    const summary = text(page, "md-activity-heatmap-summary");
    expect(summary).toContain("Busiest: Fri 4 pm (3 actions).");
    expect(summary).toContain("4 of 13 actions (30.8%) were outside working hours: 3 at night, 1 on Sunday.");
    expect(text(page, "md-activity-heatmap")).toContain("7 am to 9 pm, Monday to Saturday");
    expect(text(page, "md-activity-after-hours")).toContain("Who works outside normal hours");
    expect(text(page, "md-activity-after-hours")).toContain("Babu K");
    expect(text(page, "md-activity-after-hours")).toContain("Account changed (role, unit, status or password)");
    expect(byId(page, "md-activity-heatmap-grid")).not.toBeNull();
  });

  it("lists sign-ins with devices, security signals and dormant accounts", async () => {
    page = await render();
    const card = text(page, "md-activity-sign-ins");
    expect(card).toContain("Failed attempts");
    expect(card).toContain("1 lock-out");
    expect(card).toContain("including a privileged account"); // a super admin on a new device
    expect(card).toContain("Safari on iPhone");
    expect(card).toContain("Not an account"); // the guessed username
    expect(card).toContain("Locked out");
    expect(card).toContain("No sign-in for 30+ days");
    expect(card).toContain("64 days ago");
    expect(card).toContain("Open at the same time");
    expect(text(page, "md-activity-signin-stats")).toContain("+600%");
  });
});

describe("Activity Logs: the sensitive actions", () => {
  it("lists them newest first with what happened, how serious, who and when", async () => {
    page = await render();
    expect(rows(page)).toHaveLength(8);
    const critical = text(page, "md-activity-row-9006");
    expect(critical).toContain("Managing Director access assigned");
    expect(critical).toContain("Critical");
    expect(critical).toContain("Chandra S");
    expect(critical).toContain("Super admin");
    expect(critical).toContain("Thu 01 Oct, 2:00 pm");
    expect(byId(page, "md-activity-row-9006")?.getAttribute("data-severity")).toBe("critical");
    const night = text(page, "md-activity-row-9007");
    expect(night).toContain("After hours");
    const bulk = text(page, "md-activity-row-b9001");
    expect(bulk).toContain("× 120");
    expect(bulk).toContain("120 employee records in one upload");
    expect(text(page, "md-activity-feed-count")).toBe("Showing 8 of 8");
    expect(byId(page, "md-activity-show-more")).toBeNull(); // everything fits
  });

  it("shows only the categories that have something, with counts, and the coverage caveat", async () => {
    page = await render();
    expect(byId(page, "md-activity-category-payroll")?.textContent).toContain("Payroll & pay");
    expect(byId(page, "md-activity-category-payroll")?.textContent).toContain("2");
    expect(byId(page, "md-activity-category-all")?.textContent).toContain("8");
    expect(byId(page, "md-activity-category-settings")).toBeNull(); // nothing in it: no chip
    expect(text(page, "md-activity-coverage")).toContain("does not record");
  });

  it("filters by category and back", async () => {
    page = await render();
    await page.click('[data-testid="md-activity-category-payroll"]');
    expect(requested(page).some((r) => r.includes("/activity/sensitive?") && r.includes("category=payroll"))).toBe(
      true,
    );
    expect(rows(page)).toHaveLength(2);
    expect(byId(page, "md-activity-category-payroll")?.getAttribute("aria-pressed")).toBe("true");
    await page.click('[data-testid="md-activity-category-payroll"]'); // again: off
    expect(rows(page)).toHaveLength(8);
  });

  it("searches a moment after typing stops", async () => {
    page = await render();
    await page.type('[data-testid="md-activity-search"]', "anita");
    await sleep(320);
    await page.settle();
    expect(requested(page).some((r) => r.includes("/activity/sensitive?") && r.includes("q=anita"))).toBe(true);
    expect(rows(page)).toHaveLength(5); // Anita's five
  });

  it("asks for ten more at a time", async () => {
    const lots = (params: URLSearchParams) => {
      const size = Number(params.get("pageSize"));
      const body = sensitivePage(params);
      const shown = Math.min(size, 25); // the server never returns more than it has
      return {
        ...body,
        total: 25,
        pages: 3,
        items: Array.from({ length: shown }, (_, i) => ({ ...sensitiveItems[i % 8], id: `p${i}` })),
      };
    };
    page = await render({ ...FIXTURES, "/api/md/activity/sensitive": lots });
    expect(rows(page)).toHaveLength(10);
    expect(text(page, "md-activity-feed-count")).toBe("Showing 10 of 25");
    await page.click('[data-testid="md-activity-show-more"]');
    expect(requested(page).some((r) => r.includes("/activity/sensitive?") && r.includes("pageSize=20"))).toBe(true);
    expect(rows(page)).toHaveLength(20);
    await page.click('[data-testid="md-activity-show-more"]');
    expect(rows(page)).toHaveLength(25); // 30 asked for, only 25 exist
    expect(byId(page, "md-activity-show-more")).toBeNull(); // nothing left to show
  });

  it("switches to everything people did, routine lines included", async () => {
    page = await render();
    await page.click('[data-testid="md-activity-mode-all"]');
    expect(requested(page).some((r) => r.startsWith("/api/md/activity/feed?"))).toBe(true);
    expect(byId(page, "md-activity-mode-all")?.getAttribute("aria-pressed")).toBe("true");
    expect(text(page, "md-activity-feed")).toContain("Updated employee E4 -G H");
    expect(text(page, "md-activity-feed")).toContain("Sunday");
    expect(rows(page)).toHaveLength(9);
    expect(byId(page, "md-activity-categories")).toBeNull(); // categories belong to the sensitive list
  });

  it("narrows the list to a person picked in the people table, and back", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    page = await render();
    await page.click('[data-testid="row-Anita Rao"]');
    expect(requested(page).some((r) => r.includes("/activity/sensitive?") && r.includes("user=Anita+Rao"))).toBe(true);
    expect(text(page, "md-activity-user-filter")).toContain("Only Anita Rao");
    expect(rows(page)).toHaveLength(5);
    await page.click('[data-testid="md-activity-user-filter"]');
    expect(byId(page, "md-activity-user-filter")).toBeNull();
    expect(rows(page)).toHaveLength(8);
  });

  it("shows what counts as sensitive when asked", async () => {
    page = await render();
    expect(byId(page, "md-activity-rules")).toBeNull();
    await page.click('[data-testid="md-activity-rules-toggle"]');
    const rules = text(page, "md-activity-rules");
    expect(rules).toContain("Accounts & access");
    expect(rules).toContain("Managing Director access assigned");
    expect(rules).toContain("Critical");
    expect(rules).toContain("Backup & restore");
  });

  it("says plainly when nothing matches", async () => {
    page = await render();
    await page.type('[data-testid="md-activity-search"]', "zzzz");
    await sleep(320);
    await page.settle();
    expect(text(page, "md-activity-feed-empty")).toContain("Nothing matches");
  });
});

describe("Activity Logs: when something goes wrong or there is nothing", () => {
  it("shows an error in the one card that failed and keeps the rest", async () => {
    page = await render({
      ...FIXTURES,
      "/api/md/activity/heatmap": { status: 500, body: { error: "The heatmap broke." } },
    });
    await sleep(1300); // the page retries a server error once, after a second
    await page.settle();
    const heatmap = byId(page, "md-activity-heatmap")!;
    expect(heatmap.querySelector('[data-testid="md-error"]')?.textContent).toContain("The heatmap broke.");
    expect(text(page, "md-activity-kpi-actions-value")).toBe("13");
    expect(rows(page)).toHaveLength(8);
    expect(byId(page, "md-activity-users-table")).not.toBeNull();
  });

  it("shows a refused request (a period that is not allowed) as a readable message", async () => {
    page = await render({
      ...FIXTURES,
      "/api/md/activity/summary": {
        status: 400,
        body: { error: "That is 900 days; the most one request covers is 800." },
      },
    });
    expect(text(page, "md-page-header")).toContain("Activity Logs");
    expect(page.container.textContent).toContain("That is 900 days; the most one request covers is 800.");
  });

  it("is honest about an empty database: no zero charts, a sentence for each card, and the note", async () => {
    page = await render(EMPTY_FIXTURES);
    expect(text(page, "md-activity-kpi-actions-value")).toBe("0");
    expect(text(page, "md-activity-kpi-after-hours")).toContain("None outside working hours");
    expect(text(page, "md-activity-kpi-sensitive")).toContain("None in this period");
    expect(text(page, "md-activity-kpi-failed")).toContain("No lock-outs");
    expect(byId(page, "md-note")?.textContent).toContain("Nothing was recorded in the audit trail or the sign-in log");
    expect(text(page, "md-activity-trend-empty")).toContain("No activity in this period");
    expect(text(page, "md-activity-areas-empty")).toContain("No actions were recorded");
    expect(text(page, "md-activity-users-empty")).toContain("Nobody did anything");
    expect(text(page, "md-activity-heatmap-empty")).toContain("No activity to chart");
    expect(text(page, "md-activity-feed-empty")).toContain("Nothing sensitive in this period");
    expect(text(page, "md-activity-signins-empty")).toContain("No sign-ins in this period");
    expect(text(page, "md-activity-attention")).toContain("No system activity was recorded in the last 7 days");
    expect(rows(page)).toHaveLength(0);
  });
});
