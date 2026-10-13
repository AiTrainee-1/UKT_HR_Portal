import { describe, expect, it } from "vitest";
import type { BiometricDeviceItem } from "@/lib/api-client/custom-hooks";
import {
  EMPTY_DEVICE,
  addressText,
  createBody,
  deviceFormFrom,
  deviceProblems,
  deviceTypeLabel,
  hasProblems,
  updateBody,
} from "./deviceForm";

const DEVICE: BiometricDeviceItem = {
  id: 5,
  name: "Main Gate Scanner",
  deviceType: "zkteco",
  host: "192.168.1.201",
  port: 4370,
  hasApiKey: false,
  connectionConfig: { password: 0 },
  isActive: true,
  isDefault: false,
  serialNumber: "CQIK222560204",
  connectorId: 2,
  lastSyncedAt: null,
  notes: null,
  createdAt: null,
};

describe("checks before a device is saved", () => {
  const ok = { ...EMPTY_DEVICE, name: "Gate" };

  it("needs a name and nothing else", () => {
    expect(deviceProblems(EMPTY_DEVICE).name).toBe("Device name is required");
    expect(hasProblems(deviceProblems(ok))).toBe(false);
  });

  it("wants a bare address and a real port", () => {
    expect(deviceProblems({ ...ok, host: "http://192.168.1.201" }).host).toBeTruthy();
    expect(deviceProblems({ ...ok, host: "192.168.1 .201" }).host).toBeTruthy();
    expect(deviceProblems({ ...ok, host: "192.168.1.201:4370" }).host).toBe(
      "Put the port in the Port box, not after the address.",
    );
    expect(deviceProblems({ ...ok, host: "gate.factory.local" }).host).toBeUndefined();
    expect(deviceProblems({ ...ok, port: "70000" }).port).toBeTruthy();
    expect(deviceProblems({ ...ok, port: "43.7" }).port).toBeTruthy();
    expect(deviceProblems({ ...ok, port: "4370" }).port).toBeUndefined();
  });

  it("wants the Comm password as digits (every reader turns it into a number) and a serial without spaces", () => {
    expect(deviceProblems({ ...ok, password: "abc" }).password).toBe(
      "The Comm password is the machine's Comm Key: digits only (usually 0).",
    );
    expect(deviceProblems({ ...ok, password: "-5" }).password).toBeTruthy();
    expect(deviceProblems({ ...ok, password: "123456" }).password).toBeUndefined();
    expect(deviceProblems({ ...ok, serialNumber: "CQIK 2225" }).serialNumber).toBeTruthy();
    expect(deviceProblems({ ...ok, serialNumber: " CQIK2225 " }).serialNumber).toBeUndefined();
  });
});

describe("the requests", () => {
  it("adds a device leaving blank optional fields out, as before (no API key: nothing reads it)", () => {
    expect(createBody({ ...EMPTY_DEVICE, name: " Gate " })).toEqual({
      name: "Gate",
      deviceType: "aiface_mars",
      host: undefined,
      port: undefined,
      notes: undefined,
      serialNumber: undefined,
      connectorId: undefined,
      connectionConfig: undefined,
    });
    expect(
      createBody({ ...EMPTY_DEVICE, name: "Gate", host: "10.0.0.5", port: "4370", password: "0", connectorId: "3" }),
    ).toMatchObject({ host: "10.0.0.5", port: 4370, connectionConfig: { password: "0" }, connectorId: 3 });
  });

  it("edits the connection with the same keys as before, and name / type / notes only when changed", () => {
    const before = deviceFormFrom(DEVICE);
    expect(before).toMatchObject({ password: "0", port: "4370", connectorId: "2", notes: "" });
    expect(updateBody({ ...before, connectorId: "" }, before)).toEqual({
      host: "192.168.1.201",
      port: 4370,
      serialNumber: "CQIK222560204",
      connectorId: null,
      connectionConfig: { password: "0" },
    });
    expect(updateBody({ ...before, port: "", password: "" }, before)).toMatchObject({
      port: null,
      connectionConfig: { password: "" },
    });
    expect(updateBody({ ...before, name: "Back Gate", notes: "Near the canteen" }, before)).toMatchObject({
      name: "Back Gate",
      notes: "Near the canteen",
    });
    expect("deviceType" in updateBody({ ...before, name: "Back Gate" }, before)).toBe(false);
  });

  it("prints an address the way Device Status does", () => {
    expect(addressText("192.168.1.201", null)).toBe("192.168.1.201:4370");
    expect(addressText("192.168.1.201", 81)).toBe("192.168.1.201:81");
    expect(addressText("", 4370)).toBe("no address (push only)");
    expect(deviceTypeLabel("aiface_mars")).toBe("AiFace-Mars");
    expect(deviceTypeLabel("custom")).toBe("custom");
  });
});
