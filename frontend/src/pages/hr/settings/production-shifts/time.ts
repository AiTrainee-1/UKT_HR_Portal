// Clock times for the Production Shifts tab. The server speaks "HH:MM" (24-hour) and a separate "next day" flag; HR reads
// "5:30 AM next day". The calculator takes a typed list of punches ("08:30, 12:45, 1:30 pm, 20:00") and works out which
// of them are after midnight. All pure, so they are tested without a screen.
import { formatClock } from "../compensation/time";

export const MINUTES_PER_DAY = 1440;

/** "08:30" or "08:30:00" -> 510; null when it is not a clock time. */
export function toMinutes(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour > 23 || minute > 59 ? null : hour * 60 + minute;
}

/** 510 -> "08:30" (a minute count of a day or more wraps round). */
export function toHHMM(minutes: number): string {
  const wrapped = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/** What the server sent for a time, as a box holds it: "08:30:00" -> "08:30"; anything unreadable is kept as it is. */
export function boxTime(text: string | null | undefined): string {
  const minutes = toMinutes(text);
  return minutes === null ? (text ?? "") : toHHMM(minutes);
}

/** "13:30" -> "1:30 PM"; a text that is not a time comes back as it is. */
export function clock12(text: string): string {
  const minutes = toMinutes(text);
  return minutes === null ? text : formatClock(minutes);
}

/** A point of a ladder in words: "8:00 PM", or "5:30 AM next day". */
export function pointText(time: string, nextDay: boolean): string {
  return `${clock12(time)}${nextDay ? " next day" : ""}`;
}

/** Minutes from the shift day's midnight: a time after midnight counts a whole day more. Null while the time is unreadable. */
export function absMinutes(time: string, nextDay: boolean): number | null {
  const minutes = toMinutes(time);
  return minutes === null ? null : minutes + (nextDay ? MINUTES_PER_DAY : 0);
}

export type TypedPunch = {
  /** "HH:MM", as it is sent. */
  hhmm: string;
  /** After midnight of the day the shift began. */
  nextDay: boolean;
  /** "8:30 AM", or "5:30 AM next day": what the screen says back to the person who typed it. */
  text: string;
};

export type ParsedPunches = { punches: TypedPunch[]; error: null } | { punches: []; error: string };

const HELP = "Write the times in the order they happened, such as 08:30 12:45 13:30 20:00, or 8:30 am 8:00 pm.";
const TOKEN = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?(\+1)?$/;

/**
 * The punches a text means, in the order typed. Understood: "08:30", "8:30", "20:00", "1:30pm", "5:30 am next day" and "05:30+1".
 * Without am or pm a time is a 24-hour time ("1:30" is half past one at night: the screen shows it back as "1:30 AM").
 * A time that is not later than the one before it is the next morning, so "20:00 21:00 05:30" is a night that ends at 5:30
 * AM. That is the very rule the server reads the punches by (they are sent as plain HH:MM in this order), so "next day" or
 * "+1" may confirm it but cannot change it: on a time that is not after the evening's punches it is refused. At most two
 * calendar days, and at most twelve punches.
 */
export function parsePunches(text: string): ParsedPunches {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/a\.m\.?/g, "am")
    .replace(/p\.m\.?/g, "pm")
    .replace(/\s*(?:\(?next ?day\)?|tomorrow)/g, "+1")
    .replace(/\s+(am|pm)\b/g, "$1")
    .replace(/\s+\+1/g, "+1");
  if (cleaned === "") return { punches: [], error: `Enter the punch times. ${HELP}` };
  const tokens = cleaned.split(/[\s,;]+/).filter((t) => t !== "");
  if (tokens.length > 12) return { punches: [], error: "That is more than twelve punches in a day. Enter fewer." };

  const out: TypedPunch[] = [];
  let dayOffset = 0;
  let previous: number | null = null; // minutes since the shift day's midnight, the day offset counted
  for (const token of tokens) {
    const m = TOKEN.exec(token);
    if (!m) return { punches: [], error: `"${token}" is not a time. ${HELP}` };
    let hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    const meridiem = m[3];
    if (minute > 59) return { punches: [], error: `"${token}": ${m[2]} is not a minute from 00 to 59. ${HELP}` };
    if (meridiem) {
      if (hour < 1 || hour > 12)
        return { punches: [], error: `"${token}": with am or pm the hour is 1 to 12. ${HELP}` };
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    } else if (hour > 23) {
      return { punches: [], error: `"${token}": ${hour} is not an hour. ${HELP}` };
    }
    const minutes = hour * 60 + minute;
    // the server's reading: a time that is not later than the one before it is the next morning
    let at = minutes + dayOffset * MINUTES_PER_DAY;
    while (previous !== null && at <= previous) {
      dayOffset += 1;
      at += MINUTES_PER_DAY;
    }
    if (dayOffset > 1) return { punches: [], error: "The punches run past two days. Enter one shift's punches." };
    if (m[4] === "+1" && dayOffset === 0) {
      return {
        punches: [],
        error: `"${token}": next day only fits a time that comes after the evening's punches. Write the punches in the order they happened.`,
      };
    }
    previous = at;
    const hhmm = toHHMM(minutes);
    out.push({ hhmm, nextDay: dayOffset === 1, text: `${clock12(hhmm)}${dayOffset === 1 ? " next day" : ""}` });
  }
  return { punches: out, error: null };
}

/** The first Sunday on or after a YYYY-MM-DD date (the same date when it is a Sunday); the date itself when unreadable. */
export function nextSunday(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  date.setUTCDate(date.getUTCDate() + ((7 - date.getUTCDay()) % 7));
  return date.toISOString().slice(0, 10);
}

/** The weekday of a YYYY-MM-DD date ("Sunday"), or "" when it is not a date. */
export function weekdayOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCMonth() !== Number(m[2]) - 1) return "";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
}
