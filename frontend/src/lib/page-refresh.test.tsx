import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageHasRefresh, runPageRefreshers, usePageRefresh } from "./page-refresh";

describe("pageHasRefresh", () => {
  it("gives the button to the pages that show data", () => {
    for (const path of [
      "/hr/dashboard",
      "/hr/employees",
      "/hr/employees/42",
      "/hr/attendance",
      "/hr/attendance/staff",
      "/hr/payroll",
      "/hr/user-management/7",
      "/hr/recruitment/resume-screening",
      "/hr/notifications",
    ]) {
      expect(pageHasRefresh(path), path).toBe(true);
    }
  });

  it("skips data-entry pages, settings, the report builder and chat", () => {
    for (const path of [
      "/hr/employees/new",
      "/hr/employees/42/edit",
      "/hr/employees/bulk-upload",
      "/hr/attendance/manual-import",
      "/hr/settings",
      "/hr/reports",
      "/hr/chat",
    ]) {
      expect(pageHasRefresh(path), path).toBe(false);
    }
  });

  it("skips pages that put their own Refresh button in the title row", () => {
    for (const path of [
      "/hr/requests",
      "/hr/activity-logs",
      "/hr/login-devices",
      "/hr/mobile-app-login",
      "/hr/whatsapp-control",
      "/hr/recruitment/dashboard",
      "/hr/recruitment/new-joinees",
      "/hr/recruitment/resignations",
      "/hr/recruitment/required-roles",
      "/hr/casual-leave",
      "/hr/leave",
      "/hr/shifts",
      "/hr/outpass-visitors",
      "/hr/outpass-visitors/outpass",
      "/hr/outpass-visitors/visitors",
      "/hr/outpass-visitors/tea-break",
      "/hr/geo-attendance",
      "/hr/missing-punch",
      "/hr/attendance/search",
    ]) {
      expect(pageHasRefresh(path), path).toBe(false);
    }
  });

  it("ignores a trailing slash, a query string and a hash", () => {
    expect(pageHasRefresh("/hr/settings/")).toBe(false);
    expect(pageHasRefresh("/hr/requests?tab=leave")).toBe(false);
    expect(pageHasRefresh("/hr/employees?page=2#top")).toBe(true);
  });
});

describe("usePageRefresh", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const roots: { unmount: () => void }[] = [];
  afterEach(() => {
    roots.splice(0).forEach((r) => act(() => r.unmount()));
  });

  function mount(fn: () => unknown) {
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    function Page() {
      usePageRefresh(fn);
      return null;
    }
    act(() => root.render(createElement(Page)));
    return root;
  }

  it("runs a page's loader when the button is pressed, and stops once the page is gone", async () => {
    const load = vi.fn();
    const root = mount(load);
    await runPageRefreshers();
    expect(load).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    await runPageRefreshers();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("always calls the latest version of the loader (it closes over the page's current filters)", async () => {
    const seen: string[] = [];
    const host = document.createElement("div");
    const root = createRoot(host);
    roots.push(root);
    let setFilter: (v: string) => void = () => {};
    function Page() {
      const [filter, set] = useState("all");
      setFilter = set;
      usePageRefresh(() => seen.push(filter));
      return null;
    }
    act(() => root.render(createElement(Page)));
    await runPageRefreshers();
    act(() => setFilter("approved"));
    await runPageRefreshers();
    expect(seen).toEqual(["all", "approved"]);
  });

  it("one failing loader never stops the others", async () => {
    const ok = vi.fn();
    mount(() => {
      throw new Error("boom");
    });
    mount(ok);
    await expect(runPageRefreshers()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
