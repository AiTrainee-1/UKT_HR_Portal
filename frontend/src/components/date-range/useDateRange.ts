import { useCallback, useEffect, useMemo, useState } from "react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import {
  DATE_RANGE_DEFAULTS,
  istDay,
  msUntilNextIstDay,
  rangeDays,
  rangeLabel,
  rangeParams,
  readDateRange,
  type DateRangeValue,
  type RangeDays,
} from "@/lib/date-range";

/**
 * Today in India ("2026-11-24"), read on every render; a timer re-renders the caller just after India's midnight (and every
 * midnight after), so Today, Yesterday and This Month move on by themselves on a page left open overnight.
 */
export function useIstToday(): string {
  const [tick, setTick] = useState(0);
  const today = istDay(new Date());
  useEffect(() => {
    const timer = setTimeout(() => setTick((n) => n + 1), msUntilNextIstDay() + 1000);
    return () => clearTimeout(timer);
  }, [today, tick]);
  return today;
}

export type DateRange = {
  /** The filter as the address has it (always valid: lib/date-range readDateRange). */
  value: DateRangeValue;
  /** The days it covers (inclusive, India): send these to the API as `from` / `to`. */
  days: RangeDays;
  /** "November 2026", "Today, 24 Nov", "3 Nov – 9 Nov 2026". */
  label: string;
  /** Today in India. */
  today: string;
  /** Changes the filter (in the address, with `replace`). `extra` goes into the same address change: a page that keeps its
   *  page number there resets it here (`{ page: "" }`), so the two never race. */
  set: (next: DateRangeValue, extra?: Record<string, string>) => void;
};

/**
 * The date filter of a page that keeps it in the address on its own (`range` / `month` / `from` / `to`, see
 * lib/date-range): This Month unless the address says otherwise. Pages whose filters already live in the gate kit's
 * useGateFilters get the same keys from there instead.
 */
export function useDateRange(): DateRange {
  const [raw, write] = useUrlParams(DATE_RANGE_DEFAULTS);
  const today = useIstToday();
  const set = useCallback(
    (next: DateRangeValue, extra?: Record<string, string>) =>
      write({ ...rangeParams(next), ...(extra ?? {}) } as Partial<typeof DATE_RANGE_DEFAULTS>),
    [write],
  );
  return useMemo(() => {
    // `today` is in the dependencies: the days are worked out again at India's midnight
    const now = new Date();
    const value = readDateRange(raw, now);
    return { value, days: rangeDays(value, now), label: rangeLabel(value, now), today, set };
  }, [raw, today, set]);
}
