import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import DevicesTab from "../DevicesTab";
import { DEVICES_SETTINGS } from "../DevicesTab.meta";

// jsdom render checks of Settings -> Devices with a fake server (the page itself is covered by e2e/device-status.spec.ts
// and e2e/site-connector.spec.ts): the list, adding and editing with the same requests as before, the confirm before
// switching a device off or removing it, and the explained fields.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const device = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  deviceType: "aiface_mars",
  host: `10.250.0.${id}`,
  port: 4370,
  hasApiKey: false,
  connectionConfig: { password: 0 },
  isActive: true,
  isDefault: false,
  serialNumber: `SN00${id}`,
  connectorId: null,
  lastSyncedAt: null,
  notes: null,
  createdAt: null,
  ...extra,
});

let page: RenderedPage | undefined;
let calls: { method: string; path: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  calls = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open() {
  const devices = [
    {
      id: "env",
      name: "Head Office (.env)",
      deviceType: "essl",
      host: "10.0.0.2",
      port: 4370,
      hasApiKey: false,
      connectionConfig: {},
      isActive: true,
      isDefault: false,
      isEnv: true,
      lastSyncedAt: null,
      notes: "Configured in backend/.env -edit the file to change it.",
      createdAt: null,
    },
    device(11, "ds_live"),
    device(12, "ds_gate", { connectorId: 7, notes: "By the main gate" }),
    device(15, "ds_off", { isActive: false, serialNumber: "DSOFF005" }),
  ];
  const record = (path: string) => (_params: URLSearchParams, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "POST") return { status: 201, body: device(99, "cn_office") };
    if (method === "DELETE") return null;
    return path === "/api/biometric-devices"
      ? devices
      : devices.find((d) => `/api/biometric-devices/${d.id}` === path)!;
  };
  page = await renderMdPage(
    () => <DevicesTab />,
    {
      "/api/auth/me": { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} },
      "/api/biometric-devices": record("/api/biometric-devices"),
      "/api/biometric-devices/11": record("/api/biometric-devices/11"),
      "/api/biometric-devices/12": record("/api/biometric-devices/12"),
      "/api/biometric-devices/15": record("/api/biometric-devices/15"),
      "/api/attendance/device-control/connectors": { connectors: [{ id: 7, name: "cn_Unit 1", devices: [] }] },
    },
    { path: "/hr/settings?tab=devices" },
  );
  return page;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const titled = (row: string, title: string) =>
  q(`[data-testid="settings-device-${row}"]`)!.querySelector<HTMLButtonElement>(`button[title^="${title}"]`);

async function press(el: HTMLElement | null | undefined) {
  if (!el) throw new Error("nothing to press");
  await act(async () => el.click());
  await page!.settle();
}

describe("Settings -> Devices", () => {
  it("lists every device with how it is reached; the .env device has no buttons", async () => {
    await open();
    const text = page!.text();
    expect(text).toContain("Biometric / Punching Devices");
    expect(text).toContain("ds_off");
    expect(text).toContain("DSOFF005");
    expect(q('[data-testid="settings-device-12"]')?.textContent).toContain("via site connector cn_Unit 1");
    expect(q('[data-testid="settings-device-12"]')?.textContent).toContain("By the main gate");
    expect(q('[data-testid="settings-device-15"]')?.textContent).toContain("Disabled");
    expect(q('[data-testid="settings-device-env"]')?.querySelectorAll("button")).toHaveLength(0);
    // the row is the rounded bordered box the site-connector spec finds, with its edit button
    expect(titled("12", "Edit connection")?.closest("div.rounded-xl.border")).toBe(
      q('[data-testid="settings-device-12"]'),
    );
    // the dead API key field is not drawn
    expect(text).not.toContain("API Key");
    expect(q('[data-testid="devices-status-link"] a')?.getAttribute("href")).toBe(
      "/hr/Biometric-Connectors/device-status",
    );
  });

  it("adds a device with the same request as before", async () => {
    await open();
    await press(buttonNamed("Add Device"));
    await page!.type("#new-device-name", "cn_office");
    await page!.type("#new-device-host", "192.168.0.51");
    await act(async () => {
      const select = q('[data-testid="new-device-connector"]') as HTMLSelectElement;
      select.value = "7";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q('[data-testid="new-device-preview"]')?.textContent).toContain("read by cn_Unit 1");
    await press(buttonNamed("Save Device"));
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/biometric-devices",
        body: { name: "cn_office", deviceType: "aiface_mars", host: "192.168.0.51", connectorId: 7 },
      },
    ]);
    expect(toast).toHaveBeenCalledWith({ title: "Device added" });
    expect(q('[data-testid="add-device-form"]')).toBeNull();
  });

  it("refuses a Comm password that is not a number before anything is sent", async () => {
    await open();
    await press(buttonNamed("Add Device"));
    await page!.type("#new-device-name", "Gate");
    await page!.type("#new-device-password", "abc");
    await press(buttonNamed("Save Device"));
    expect(calls).toEqual([]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Check the device details" }));
    expect(page!.text()).toContain("digits only");
  });

  it("edits the connection with the same keys as before", async () => {
    await open();
    await press(titled("12", "Edit connection"));
    await act(async () => {
      const select = q('[data-testid="edit-device-connector-12"]') as HTMLSelectElement;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await press(buttonNamed("Save Connection"));
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/biometric-devices/12",
        body: {
          host: "10.250.0.12",
          port: 4370,
          serialNumber: "SN0012",
          connectorId: null,
          connectionConfig: { password: "0" },
        },
      },
    ]);
    expect(toast).toHaveBeenCalledWith({ title: "Device updated" });
  });

  it("asks before switching a device off, switches one on at once", async () => {
    await open();
    await press(titled("11", "Disable device"));
    expect(q('[data-testid="confirm-disable-device"]')?.textContent).toContain("still recorded");
    expect(calls).toEqual([]);
    await press(buttonNamed("Disable device"));
    expect(calls).toEqual([{ method: "PUT", path: "/api/biometric-devices/11", body: { isActive: false } }]);
    calls = [];
    await press(titled("15", "Enable device"));
    expect(calls).toEqual([{ method: "PUT", path: "/api/biometric-devices/15", body: { isActive: true } }]);
  });

  it("asks before removing a device, and Cancel removes nothing", async () => {
    await open();
    await press(titled("11", "Remove device"));
    expect(q('[data-testid="confirm-remove-device"]')?.textContent).toContain("cannot be undone");
    await press(buttonNamed("Cancel"));
    expect(calls).toEqual([]);
    await press(titled("11", "Remove device"));
    await press(buttonNamed("Remove device"));
    expect(calls).toEqual([{ method: "DELETE", path: "/api/biometric-devices/11", body: null }]);
  });

  it("has a search entry for every field it explains, with the same title and words", async () => {
    await open();
    const ids = [...page!.container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const blocks = [...page!.container.querySelectorAll<HTMLElement>("[data-setting-id]")];
    expect(blocks.map((b) => b.dataset.settingId).sort()).toEqual(DEVICES_SETTINGS.map((m) => m.id).sort());
    for (const meta of DEVICES_SETTINGS) {
      const block = blocks.find((b) => b.dataset.settingId === meta.id)!;
      expect(block.querySelector("h4")?.textContent?.trim(), meta.id).toBe(meta.title);
      expect(block.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim(), meta.id).toBe(meta.purpose);
      expect(block.closest("section:not([data-setting-id])")?.querySelector("h3")?.textContent?.trim()).toBe(
        meta.section,
      );
    }
  });
});
