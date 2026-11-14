// Test helpers for the Payroll page (vitest + jsdom, through renderMdPage): the page with a probe that shows the address,
// the fixture table, and the few interactions the tests need (a Radix select, waiting out the search's pause).

import { act } from "react";
import { useLocation, useSearch } from "wouter";
import { vi } from "vitest";
import MdPayroll from "../MdPayroll";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { dashboardFixtures } from "./fixtures";

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

export function PayrollWithProbe() {
  return (
    <>
      <MdPayroll />
      <UrlProbe />
    </>
  );
}

export const FIXTURES = (): Fixtures => dashboardFixtures() as Fixtures;

export const openPayroll = (path = "/md/payroll", over: Fixtures = {}) =>
  renderMdPage(PayrollWithProbe, { ...FIXTURES(), ...over }, { path });

/** jsdom has no layout, so recharts' ResponsiveContainer measures 0 x 0 and says so on every chart: not news here
 *  (charts.test.tsx draws the charts at a real size). Every other warning still gets through. */
export function quietCharts() {
  const quiet =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      if (!String(args[0]).includes("of chart should be greater than 0")) original(...args);
    };
  vi.spyOn(console, "warn").mockImplementation(quiet(console.warn.bind(console)));
  vi.spyOn(console, "error").mockImplementation(quiet(console.error.bind(console)));
}

export const by = (page: RenderedPage, testId: string) =>
  page.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
export const textOf = (page: RenderedPage, testId: string) =>
  (by(page, testId)?.textContent ?? "").replace(/\s+/g, " ").trim();
export const url = (page: RenderedPage) => textOf(page, "probe-url");

/** The requests to one endpoint, as URLSearchParams (newest last). */
export const requestsTo = (page: RenderedPage, endpoint: string) =>
  page
    .requests()
    .filter((r) => r.split("?")[0] === `/api/md/payroll/${endpoint}`)
    .map((r) => new URLSearchParams(r.split("?")[1] ?? ""));
export const lastRequest = (page: RenderedPage, endpoint: string) => requestsTo(page, endpoint).at(-1);

/** Opens a Radix select by keyboard and picks the option with this text. */
export async function choose(page: RenderedPage, triggerTestId: string, optionText: string) {
  const trigger = by(page, triggerTestId);
  if (!trigger) throw new Error(`no select ${triggerTestId}`);
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
  const option = options.find((o) => o.textContent?.trim() === optionText);
  if (!option) throw new Error(`no option "${optionText}": ${options.map((o) => o.textContent).join(" | ")}`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.settle();
}

/** Waits out the search box's pause (300 ms) and lets the page settle. */
export async function afterSearchPause(page: RenderedPage) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 360));
  });
  await page.settle();
}
