import type { BiometricDeviceItem } from "@/lib/api-client/custom-hooks";

// The add / edit form of Settings -> Devices: its values as typed, the checks made before anything is sent, and the
// request bodies (the same keys the tab has always sent, plus name, type and notes on an edit, which the API accepts).

export type DeviceForm = {
  name: string;
  deviceType: string;
  host: string;
  port: string;
  /** The machine's Comm Key (connectionConfig.password). */
  password: string;
  serialNumber: string;
  notes: string;
  /** A Site Connector's id, or "" for "directly from the server". */
  connectorId: string;
};

export const DEVICE_TYPES: { value: string; label: string }[] = [
  { value: "aiface_mars", label: "AiFace-Mars" },
  { value: "zkteco", label: "ZKTeco" },
  { value: "essl", label: "eSSL" },
  { value: "generic_http", label: "Generic HTTP API" },
  { value: "other", label: "Other" },
];

export const deviceTypeLabel = (value: string): string => DEVICE_TYPES.find((t) => t.value === value)?.label ?? value;

export const EMPTY_DEVICE: DeviceForm = {
  name: "",
  deviceType: "aiface_mars",
  host: "",
  port: "",
  password: "",
  serialNumber: "",
  notes: "",
  connectorId: "",
};

export function deviceFormFrom(d: BiometricDeviceItem): DeviceForm {
  return {
    name: d.name ?? "",
    deviceType: d.deviceType || "aiface_mars",
    host: d.host ?? "",
    port: d.port ? String(d.port) : "",
    password: String((d.connectionConfig as { password?: unknown } | undefined)?.password ?? ""),
    serialNumber: d.serialNumber ?? "",
    notes: d.notes ?? "",
    connectorId: d.connectorId ? String(d.connectorId) : "",
  };
}

export type DeviceErrors = Partial<Record<keyof DeviceForm, string>>;

/**
 * What every reader of a device needs: a name; a bare address (no http://, no port in it); a TCP port; a Comm Key that
 * is a number (sync, the status check and Device Control all read it as one, and a non-number fails that device);
 * a serial without spaces (it must match what the machine reports).
 */
export function deviceProblems(f: DeviceForm): DeviceErrors {
  const errors: DeviceErrors = {};
  if (!f.name.trim()) errors.name = "Device name is required";
  const host = f.host.trim();
  if (host && (/\s/.test(host) || host.includes("://") || host.includes("/"))) {
    errors.host = "Enter just the address, such as 192.168.1.201 (no spaces, no http://).";
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(host)) {
    errors.host = "Put the port in the Port box, not after the address.";
  }
  const port = f.port.trim();
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    errors.port = "Port must be a whole number from 1 to 65535 (ZKTeco machines use 4370).";
  }
  const password = f.password.trim();
  if (password && !/^\d{1,9}$/.test(password)) {
    errors.password = "The Comm password is the machine's Comm Key: digits only (usually 0).";
  }
  if (/\s/.test(f.serialNumber.trim())) errors.serialNumber = "A serial number has no spaces.";
  return errors;
}

export const hasProblems = (errors: DeviceErrors): boolean => Object.keys(errors).length > 0;

/** POST /api/biometric-devices: as before, blank optional fields are left out. */
export function createBody(f: DeviceForm) {
  return {
    name: f.name.trim(),
    deviceType: f.deviceType,
    host: f.host.trim() || undefined,
    port: f.port.trim() ? Number(f.port) : undefined,
    notes: f.notes.trim() || undefined,
    serialNumber: f.serialNumber.trim() || undefined,
    connectorId: f.connectorId ? Number(f.connectorId) : undefined,
    connectionConfig: f.password.trim() ? { password: f.password.trim() } : undefined,
  };
}

/**
 * PUT /api/biometric-devices/<id>: the connection exactly as before (a blank port is null, a blank password clears it),
 * and the name, type and notes only when they were changed.
 */
export function updateBody(f: DeviceForm, before: DeviceForm) {
  const name = f.name.trim();
  const notes = f.notes.trim();
  return {
    ...(name !== before.name.trim() ? { name } : {}),
    ...(f.deviceType !== before.deviceType ? { deviceType: f.deviceType } : {}),
    ...(notes !== before.notes.trim() ? { notes } : {}),
    host: f.host.trim(),
    port: f.port.trim() ? Number(f.port) : null,
    serialNumber: f.serialNumber.trim(),
    connectorId: f.connectorId ? Number(f.connectorId) : null,
    connectionConfig: { password: f.password.trim() },
  };
}

/** "192.168.1.201:4370" the way the device list and Device Status print an address (no port = 4370). */
export const addressText = (host: string, port: string | number | null | undefined): string =>
  host ? `${host}:${port ? port : 4370}` : "no address (push only)";
