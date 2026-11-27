// The Salary Advance rounding (owner 2026-11-27) as the screens say it: an amount asked for above the eligible limit is
// brought down to the limit, then rounded to the nearest ₹500 (₹0-249 -> ₹0, ₹250-749 -> ₹500, ...), never above the
// limit (a round-up past it goes to the ₹500 below). The server works it out (service.rounded_for / rounding_json) and
// sends it with each request; these only put it in words. Used by the HRMS workflow and the Auditor Review Portal.

import type { SettlementRounding } from "@/lib/api-client/custom-hooks/settlement-automation";
import { formatMoney } from "../shared";

export const ROUND_STEP = 500;
const ROUND_HALF = 250;

/** The nearest ₹500 (₹250 and up within a step rounds up); ₹0 for nothing. */
export function nearest500(amount: number): number {
  if (!(amount > 0)) return 0;
  const steps = Math.floor(amount / ROUND_STEP);
  const rest = amount - steps * ROUND_STEP;
  return (steps + (rest >= ROUND_HALF ? 1 : 0)) * ROUND_STEP;
}

/** The workflow's "as asked" amount of a request: the server's `baseAmount` (a Salary Advance's rounded amount), else the
 *  rounding's own, else what was asked (a Term Loan, an older server). */
export function baseOf(item: {
  requestedAmount: number;
  baseAmount?: number | null;
  rounding?: Pick<SettlementRounding, "rounded"> | null;
}): number {
  return item.baseAmount ?? item.rounding?.rounded ?? item.requestedAmount;
}

/** The rounding changed the amount (worth a line of its own); false for a Term Loan / an older batch. */
export const roundingChanged = (r: SettlementRounding | null | undefined): r is SettlementRounding =>
  !!r && Math.abs(r.rounded - r.requested) >= 0.005;

/** A request that rounds to ₹0: it can only be rejected. */
export const roundsToZero = (item: { rounding?: Pick<SettlementRounding, "zero"> | null }): boolean =>
  !!item.rounding?.zero;

export type RoundingNote = { text: string; tone: "muted" | "red" };

/** The one short line under the rounded amount, when it matters: it rounds to ₹0 (only reject), it was capped at the
 *  limit, or it was rounded up; null otherwise (rounded down a little, or no change). */
export function roundingNote(r: SettlementRounding | null | undefined): RoundingNote | null {
  if (!r) return null;
  if (r.zero) return { text: "rounds to ₹0 — reject", tone: "red" };
  if (r.capped) return { text: "capped at limit", tone: "muted" };
  if (r.direction === "up") return { text: "rounded up", tone: "muted" };
  return null;
}

/** How the rounded amount was worked out, step by step (the hover text): "₹15,000 asked → brought down to the ₹11,560
 *  limit → rounded to the nearest ₹500 = ₹11,500". */
export function roundingSteps(r: SettlementRounding, money: (n: number) => string = formatMoney): string {
  const parts = [`${money(r.requested)} asked`];
  const base = r.capped && r.limit != null ? r.limit : r.requested;
  if (r.capped && r.limit != null) parts.push(`brought down to the ${money(r.limit)} limit`);
  const nearest = nearest500(base);
  if (r.zero) return [...parts, "rounded to the nearest ₹500 = ₹0 (less than ₹250): reject it"].join(" → ");
  if (r.limit != null && nearest > r.limit && Math.abs(nearest - r.rounded) >= 0.005)
    return [
      ...parts,
      `rounded to ${money(r.rounded)} (the nearest ₹500, ${money(nearest)}, is above the ${money(r.limit)} limit)`,
    ].join(" → ");
  parts.push(`rounded to the nearest ₹500 = ${money(r.rounded)}`);
  const tail = r.limit == null ? " (no eligible limit known)" : r.capped ? "" : ` (within the ${money(r.limit)} limit)`;
  return parts.join(" → ") + tail;
}

/** The batch's "as asked" total after the rounding (the server's `amounts.rounded`), for a Salary Advance batch whose
 *  requests carry the rounding; null otherwise (a Term Loan, an older batch or server). A summary without its requests
 *  (the Overview) shows it when it differs from the total asked for. */
export function roundedTotalOf(batch: {
  advanceType: string;
  amounts: { requested: number; rounded?: number };
  items?: { rounding?: SettlementRounding | null }[];
}): number | null {
  const rounded = batch.amounts.rounded;
  if (batch.advanceType === "term" || rounded == null) return null;
  if (batch.items) return batch.items.some((i) => i.rounding) ? rounded : null;
  return Math.abs(rounded - batch.amounts.requested) >= 0.005 ? rounded : null;
}
