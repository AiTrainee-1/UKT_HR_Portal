// The Today / This Week / This Month filter on the Outpass and Visitors pages.
//
// The backend decides these boundaries for the QR-form records (see _range_bounds in
// backend/api/outpass_visitor_views.py) in the factory's own Asia/Kolkata time: Today starts at
// IST midnight, This Week on that week's Monday, This Month on the 1st, and every range is open
// ended (everything from that instant onwards). The Approved Passes table is filled client-side
// from the flat outpass-requests list, so it applies the SAME rule here -otherwise the pills would
// filter one table and silently leave the other showing every request ever made.

export type GateRangeKey = "today" | "week" | "month";

// India has no daylight saving, so a fixed offset is exact. Using it (rather than the browser's
// own time zone) keeps "today" the factory's today for anyone viewing from another zone.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant (epoch ms) the given range starts at, in Asia/Kolkata. */
export function gateRangeStart(range: GateRangeKey, now: Date = new Date()): number {
  // Shifting by the offset lets the UTC getters read the IST calendar date.
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const todayStart = Date.UTC(y, m, d) - IST_OFFSET_MS;
  if (range === "today") return todayStart;
  if (range === "week") {
    const sinceMonday = (ist.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6
    return todayStart - sinceMonday * DAY_MS;
  }
  return Date.UTC(y, m, 1) - IST_OFFSET_MS;
}

/** Whether an ISO timestamp falls inside the range. An unreadable timestamp is never "in range". */
export function inGateRange(iso: string | null | undefined, range: GateRangeKey, now: Date = new Date()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= gateRangeStart(range, now);
}
