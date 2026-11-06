import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import EmployeesTab from "./EmployeesTab";

// The Employees tab's "No WhatsApp" switch (an employee's opt-out) and the filter and count for it.

const employee = (employeeId: number, name: string, optOut: boolean) => ({
  employeeId,
  employeeCode: `E00${employeeId}`,
  employeeName: name,
  phone: `91900000000${employeeId}`,
  department: "Stitching",
  total: 4,
  failed: 0,
  lastMessageAt: "2026-11-06T09:00:00+05:30",
  optOut,
});

/** A fake employees endpoint with opt-out state; PATCH answers the updated row, or refuses when told to. */
function employeesServer() {
  const rows = [employee(1, "Asha Kumar", false), employee(2, "Ravi Nair", true), employee(3, "Meena Das", false)];
  const patches: { id: number; body: unknown }[] = [];
  let refuse = false;
  const list = (params: URLSearchParams) => {
    const only = params.get("optOut") === "true";
    const items = rows.filter((r) => !only || r.optOut);
    const size = Number(params.get("pageSize") ?? 25);
    return { items: items.slice(0, size), total: items.length, page: 1, pageSize: size };
  };
  const patch = (id: number) => (_params: URLSearchParams, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { optOut: boolean };
    patches.push({ id, body });
    if (refuse) return { status: 500, body: { error: "Database is busy" } };
    const row = rows.find((r) => r.employeeId === id)!;
    row.optOut = body.optOut;
    return row;
  };
  return {
    patches,
    refuseNext: () => {
      refuse = true;
    },
    fixtures: {
      "/api/whatsapp-control/employees": list,
      "/api/whatsapp-control/employees/1/opt-out": patch(1),
      "/api/whatsapp-control/employees/2/opt-out": patch(2),
      "/api/whatsapp-control/employees/3/opt-out": patch(3),
    },
  };
}

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (server = employeesServer()) => {
  page = await renderMdPage(() => <EmployeesTab />, server.fixtures, { path: "/hr/whatsapp-control" });
  return server;
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const checked = (id: number) => el(`[data-testid="wa-optout-${id}"]`)!.getAttribute("aria-checked");
const names = () =>
  Array.from(document.body.querySelectorAll('[data-testid="whatsapp-employee-row"]')).map(
    (r) => r.querySelector("p")!.textContent,
  );
const filterTab = (label: string) =>
  Array.from(el('[data-testid="wa-optout-filter"]')!.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) =>
    t.textContent?.startsWith(label),
  )!;

describe("No WhatsApp (opt-out) on the Employees tab", () => {
  it("shows each employee's switch, and how many have No WhatsApp on", async () => {
    await open();
    expect(names()).toEqual(["Asha Kumar", "Ravi Nair", "Meena Das"]);
    expect(checked(1)).toBe("false");
    expect(checked(2)).toBe("true");
    expect(filterTab("No WhatsApp").querySelector(".ptab-label")!.textContent).toBe("No WhatsApp(1)");
  });

  it("turns it on without opening the employee's history, and the count follows", async () => {
    const server = await open();
    await page!.click('[data-testid="wa-optout-1"]');
    expect(server.patches).toEqual([{ id: 1, body: { optOut: true } }]);
    expect(checked(1)).toBe("true");
    expect(el('[role="dialog"]')).toBeNull();
    expect(filterTab("No WhatsApp").querySelector(".ptab-label")!.textContent).toBe("No WhatsApp(2)");
  });

  it("puts the switch back when the server refuses", async () => {
    const server = await open();
    server.refuseNext();
    await page!.click('[data-testid="wa-optout-3"]');
    expect(server.patches).toEqual([{ id: 3, body: { optOut: true } }]);
    expect(checked(3)).toBe("false");
  });

  it("filters to the employees with No WhatsApp on", async () => {
    await open();
    await act(async () => filterTab("No WhatsApp").click());
    await page!.settle();
    expect(page!.requests().some((r) => r.includes("optOut=true") && r.includes("pageSize=25"))).toBe(true);
    expect(names()).toEqual(["Ravi Nair"]);
  });
});
