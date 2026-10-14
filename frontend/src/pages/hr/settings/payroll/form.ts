import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { focusSetting } from "../kit/jump";

/**
 * Form plumbing shared by the Payroll and Production Payroll tabs: a section's unsaved edits kept apart from the saved
 * values (so saving one section never resets another), number boxes checked against the same ranges the server
 * enforces, and the server's own message when a save is refused.
 */

// ── a section's draft ──

/** True when two form values mean the same thing: "12" and "12.00" are one number; lists compare by content. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    const x = a.trim();
    const y = b.trim();
    if (x !== "" && y !== "" && Number.isFinite(Number(x)) && Number.isFinite(Number(y)))
      return Number(x) === Number(y);
    return x === y;
  }
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

export type Draft<T> = {
  /** What the section shows: the saved values with the unsaved edits on top. */
  form: T;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  /** Keys whose value on screen differs from the saved one. */
  changed: (keyof T)[];
  dirty: boolean;
  /** Back to the saved values (also what a successful save does). */
  discard: () => void;
};

/**
 * One section's form state. Only the edited keys are kept, on top of `saved`, so when another section saves and the
 * settings reload, this section's unsaved edits stay and its untouched values follow the server.
 */
export function useDraft<T extends Record<string, unknown>>(saved: T): Draft<T> {
  const [edits, setEdits] = useState<Partial<T>>({});
  const form = useMemo(() => ({ ...saved, ...edits }) as T, [saved, edits]);
  const changed = useMemo(
    () => (Object.keys(edits) as (keyof T)[]).filter((k) => !sameValue(edits[k], saved[k])),
    [edits, saved],
  );
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => setEdits((e) => ({ ...e, [key]: value })), []);
  const discard = useCallback(() => setEdits({}), []);
  return { form, set, changed, dirty: changed.length > 0, discard };
}

// ── number boxes ──

export type NumberRule = {
  min: number;
  max: number;
  /** Decimal places allowed (0 = whole numbers). */
  decimals: number;
};

/** The server's ranges (payroll_views.py _payroll_range_problem), so a value is refused before it is sent. */
export const RANGES = {
  percent: { min: 0, max: 100, decimals: 2 },
  amount: { min: 0, max: 99_999_999.99, decimals: 2 },
  perShift: { min: 0, max: 999_999.99, decimals: 2 },
  payDay: { min: 1, max: 28, decimals: 0 },
  customDays: { min: 1, max: 366, decimals: 0 },
  lateCount: { min: 0, max: 366, decimals: 0 },
  slabShifts: { min: 0, max: 366, decimals: 2 },
} satisfies Record<string, NumberRule>;

const NUMBER = /^(\d+\.?\d*|\.\d+)$/;

const show = (n: number): string => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** The number typed in a box, or the problem with it (blank, not a number, too many decimals, out of range). */
export function parseNumber(text: string, rule: NumberRule): { value: number | null; error: string | null } {
  const t = text.trim();
  if (t === "") return { value: null, error: "Enter a number." };
  if (t.startsWith("-")) return { value: null, error: `Must be ${show(rule.min)} or more.` };
  if (!NUMBER.test(t)) return { value: null, error: "Enter a number, using digits and at most one dot." };
  const decimals = (t.split(".")[1] ?? "").replace(/0+$/, "").length;
  if (decimals > rule.decimals) {
    return {
      value: null,
      error: rule.decimals === 0 ? "Use a whole number." : `Use at most ${rule.decimals} decimals.`,
    };
  }
  const value = Number(t);
  if (value < rule.min || value > rule.max) {
    return { value: null, error: `Must be from ${show(rule.min)} to ${show(rule.max)}.` };
  }
  return { value, error: null };
}

/** The number in a box for a live example: the typed value when it is valid, else `fallback`. */
export function numberOr(text: string, rule: NumberRule, fallback: number): number {
  return parseNumber(text, rule).value ?? fallback;
}

/** A saved number as it goes into a box ("12", "0.75"); blank for a missing value. */
export const boxText = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "" : String(n);

// ── saving ──

/** The server's explanation of a refused save (a range message, "company_wide_rule"...), when it sent one. */
export function saveErrorText(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const data = err.data as { error?: unknown; message?: unknown } | null;
  if (data && typeof data.message === "string" && data.message.trim()) return data.message;
  if (data && typeof data.error === "string" && data.error !== "permission_denied") return data.error;
  return undefined;
}

// ── the sub-tab named in the address ──

/** The setting id in the page address (`/hr/settings?tab=payroll#staff-pf-rate` -> "staff-pf-rate"). */
export const addressSetting = (): string =>
  typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, ""));

const ADDRESS_EVENTS = ["popstate", "pushState", "replaceState", "hashchange"];

/**
 * Opens the sub-tab holding the setting the address names, now and every time the address changes: the page's search
 * and links such as `?tab=payroll#fy-start-month` land on a setting that may sit in a sub-tab that is not open. wouter
 * announces its own navigations as "pushState" / "replaceState" window events. The page scrolls to the setting itself
 * after its search (a "replaceState"); a link (a "pushState", or arriving from another tab) is scrolled to here.
 */
export function useSubTabFromAddress<S extends string>(subTabOf: Record<string, S>, open: (subTab: S) => void) {
  useEffect(() => {
    let stop: (() => void) | undefined;
    const follow = (event?: Event) => {
      const id = addressSetting();
      const subTab = subTabOf[id];
      if (!subTab) return;
      open(subTab);
      if (event?.type === "replaceState") return;
      stop?.();
      stop = focusSetting(id);
    };
    follow();
    ADDRESS_EVENTS.forEach((e) => window.addEventListener(e, follow));
    return () => {
      ADDRESS_EVENTS.forEach((e) => window.removeEventListener(e, follow));
      stop?.();
    };
  }, [subTabOf, open]);
}
