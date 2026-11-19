// Manage Gates: the pure parts (no React): the shared gate monitor address, passwords to suggest, the records query the
// table asks for, the summary line, "online now", and copying to the clipboard.

import type { GateRecordCounts, GateRecordType } from "@/lib/api-client/custom-hooks";
import { fmtCount } from "../kit";

/** Every gate signs in at this one address; the username and password decide which gate it is. */
export const GATE_MONITOR_PATH = "/gatemonitor";

export const monitorAddress = (origin: string): string => `${origin.replace(/\/+$/, "")}${GATE_MONITOR_PATH}`;

/** The permission keys of the page: the gates (view = look, edit = change) and "See gate passwords". */
export const GATES_KEY = "outpass_visitors.outpass.gate_devices";
export const PASSWORD_KEY = "outpass_visitors.outpass.gate_devices.view_password";

/** The shortest password the server takes (gate_credentials.MIN_PASSWORD_LENGTH). */
export const MIN_PASSWORD = 6;
/** The shortest username the server takes (gate_admin_views.MIN_USERNAME_LENGTH). */
export const MIN_USERNAME = 3;

// no 0/O, 1/l/I: a password someone reads off a screen and types at a gate
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random password of `length` letters and digits that are hard to mix up (crypto-random when the browser has it). */
export function generatePassword(length = 10, random: (n: number) => Uint32Array = cryptoRandom): string {
  const values = random(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[values[i] % ALPHABET.length];
  return out;
}

function cryptoRandom(n: number): Uint32Array {
  const values = new Uint32Array(n);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < n; i++) values[i] = Math.floor(Math.random() * 2 ** 32);
  }
  return values;
}

/** What is wrong with a username, or null. Mirrors the server (3-60 characters, no spaces). */
export function usernameProblem(value: string): string | null {
  const v = value.trim();
  if (v.length < MIN_USERNAME) return `Username must be at least ${MIN_USERNAME} characters.`;
  if (v.length > 60) return "Username can be at most 60 characters.";
  if (/\s/.test(v)) return "Username cannot have spaces.";
  return null;
}

export function passwordProblem(value: string): string | null {
  if (value.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (value.length > 128) return "Password can be at most 128 characters.";
  return null;
}

/** A session seen this recently counts as "online now" (the server's SIGNED_IN_WITHIN: 10 minutes). */
export const ONLINE_WITHIN_MS = 10 * 60_000;

export function isOnline(lastSeenAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const seen = new Date(lastSeenAt).getTime();
  return Number.isFinite(seen) && now.getTime() - seen <= ONLINE_WITHIN_MS;
}

/** Which gate the page shows: one gate (its id), every gate ("all"), or none chosen yet (""). */
export type GateSelection = number | "all" | "";

export function readSelection(value: string | null | undefined): GateSelection {
  if (value === "all") return "all";
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : "";
}

/** The page's own address keys that are not record filters (they never go to the records API). */
export const SCREEN_KEYS = ["gate", "gq", "gstatus"] as const;

/**
 * The records list's query: the filters as useGateFilters has them, minus the page's own keys, with `gateId` set to the
 * chosen gate, or (for "All gates") to the Gate filter when one is picked.
 */
export function recordsQuery(params: URLSearchParams, selection: number | "all"): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const key of SCREEN_KEYS) out.delete(key);
  if (selection === "all") {
    if (!out.get("gateId")) out.delete("gateId");
  } else {
    out.set("gateId", String(selection));
  }
  return out;
}

/** "12 records · 5 exits · 4 returns · 2 tea breaks · 1 denied" (the counts cover every type and result). */
export function recordsSummary(total: number, counts: GateRecordCounts | undefined): string {
  const parts = [`${fmtCount(total)} ${total === 1 ? "record" : "records"}`];
  if (counts) {
    parts.push(`${fmtCount(counts.exits)} ${counts.exits === 1 ? "exit" : "exits"}`);
    parts.push(`${fmtCount(counts.returns)} ${counts.returns === 1 ? "return" : "returns"}`);
    parts.push(`${fmtCount(counts.teaOut)} ${counts.teaOut === 1 ? "tea break" : "tea breaks"}`);
    parts.push(`${fmtCount(counts.denied)} denied`);
  }
  return parts.join(" · ");
}

export const TYPE_OPTIONS: readonly { value: GateRecordType; label: string }[] = [
  { value: "exit", label: "Exit" },
  { value: "return", label: "Return" },
  { value: "tea_out", label: "Tea break out" },
  { value: "tea_in", label: "Tea break in" },
];

export const RESULT_OPTIONS = [
  { value: "allowed", label: "Allowed" },
  { value: "denied", label: "Denied" },
] as const;

export const STATUS_OPTIONS = [
  { value: "active", label: "Switched on" },
  { value: "inactive", label: "Switched off" },
] as const;

/** Copies `text`; false when the browser would not (no clipboard, or permission refused). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** The server's own sentence for a refusal ({error: "..."}), else the error's message, else `fallback`. */
export function errorText(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    for (const field of ["error", "message", "detail"]) {
      const v = (data as Record<string, unknown>)[field];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** The 409 of reveal-password for a gate whose password was never stored. */
export const isNotStored = (err: unknown): boolean =>
  (err as { status?: number; data?: { code?: string } } | null)?.data?.code === "not_stored";
