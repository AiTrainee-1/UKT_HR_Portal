/**
 * Which days a production payslip pays after the employee moved between pay cycles (backend production_coverage.py), in
 * the plain words the cycle pages, the generate dialog and the payroll details page show:
 *
 *   "Pays 9–29 Nov only · 2–8 Nov already paid on Weekly"
 *   "+ catch-up 2–15 Nov from Monthly"
 *
 * An ordinary payslip (the whole period, nothing else) says nothing at all. Pure, so it is unit-tested on its own.
 */

import type { AlreadyPaidPart, CatchUpPart, DayRange, PeriodEmployee } from "@/lib/api-client/custom-hooks";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Day = { y: number; m: number; d: number };

function parse(text: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text ?? "");
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= 31 ? day : null;
}

/**
 * "9–29 Nov", "23 Feb – 1 Mar", "9 Nov", "29 Dec 2025 – 4 Jan 2026" (a range over a year end always names both years).
 * `withYear` adds the year to the end ("9–29 Nov 2026"). Unreadable dates are shown as sent.
 */
export function dayRangeText(range: DayRange, withYear = false): string {
  const a = parse(range.from);
  const b = parse(range.to);
  if (!a || !b) return range.from === range.to ? range.from : `${range.from} – ${range.to}`;
  const year = withYear ? ` ${b.y}` : "";
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.m === b.m && a.d === b.d) return `${a.d} ${MONTHS[a.m - 1]}${year}`;
  if (a.m === b.m) return `${a.d}–${b.d} ${MONTHS[b.m - 1]}${year}`;
  return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]}${year}`;
}

/** "2–8 Feb", "2–8 Feb and 23 Feb – 1 Mar", "1, 2 and 3" style joining. */
export function rangesText(ranges: readonly DayRange[], withYear = false): string {
  const parts = ranges.map((r) => dayRangeText(r, withYear));
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The part of a coverage these words need: the server's PeriodCoverage, or the details page's `coverage`. */
export type CoverageLike = {
  payRanges: readonly DayRange[];
  alreadyPaid: readonly AlreadyPaidPart[];
  catchUp: readonly CatchUpPart[];
  legacyGap?: CatchUpPart | null;
  refused?: boolean;
};

export type CoverageLines = {
  /** "Pays 9–29 Nov only · 2–8 Nov already paid on Weekly" (or "Nothing left to pay · ..."); null with no days paid elsewhere. */
  paid: string | null;
  /** "+ catch-up 2–15 Nov from Monthly", one per catch-up run. */
  catchUp: string[];
  /** Days after a payroll from before the cycles that no payroll paid (reported, never added). */
  legacy: string | null;
};

/** The days already paid elsewhere, one phrase per payroll kind: "2–8 Nov already paid on Weekly". */
function alreadyPaidPhrases(parts: readonly AlreadyPaidPart[]): string[] {
  const byLabel = new Map<string, DayRange[]>();
  for (const part of parts) {
    const label = part.label || "another payroll";
    byLabel.set(label, [...(byLabel.get(label) ?? []), { from: part.from, to: part.to }]);
  }
  return [...byLabel].map(([label, ranges]) => `${rangesText(ranges)} already paid on ${label}`);
}

/** What is different about this payslip; null for an ordinary one (the whole period, nothing else). */
export function coverageLines(coverage: CoverageLike | null | undefined): CoverageLines | null {
  if (!coverage) return null;
  const already = coverage.alreadyPaid ?? [];
  const catchUp = coverage.catchUp ?? [];
  const legacyGap = coverage.legacyGap ?? null;
  if (already.length === 0 && catchUp.length === 0 && !legacyGap) return null;
  let paid: string | null = null;
  if (already.length > 0) {
    const pays =
      coverage.refused || coverage.payRanges.length === 0
        ? "Nothing left to pay"
        : `Pays ${rangesText(coverage.payRanges)} only`;
    paid = [pays, ...alreadyPaidPhrases(already)].join(" · ");
  }
  return {
    paid,
    catchUp: catchUp.map((c) => `+ catch-up ${dayRangeText(c)} from ${c.fromLabel || "the previous cycle"}`),
    legacy: legacyGap ? `${dayRangeText(legacyGap)} not paid by any payroll (not added automatically)` : null,
  };
}

/** Everything in one line (a list entry, a tooltip): "Pays 9–29 Nov only · 2–8 Nov already paid on Weekly · + catch-up ...". */
export function coverageText(coverage: CoverageLike | null | undefined): string | null {
  const lines = coverageLines(coverage);
  if (!lines) return null;
  return [lines.paid, ...lines.catchUp, lines.legacy].filter(Boolean).join(" · ");
}

/**
 * The roster rows a "Generate payroll" click would compute that are paid for part of the period or get catch-up days (a
 * gap after a payroll from before the cycles is only shown on the row: it changes nothing that is paid).
 */
export function partialReady(employees: readonly PeriodEmployee[]): PeriodEmployee[] {
  return employees.filter(
    (e) =>
      !e.payroll &&
      !e.blockedReason &&
      ((e.coverage?.alreadyPaid.length ?? 0) > 0 || (e.coverage?.catchUp.length ?? 0) > 0),
  );
}
