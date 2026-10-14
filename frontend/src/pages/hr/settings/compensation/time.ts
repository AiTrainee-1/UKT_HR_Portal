// Clock times and durations for the Compensation tab. The Type 2 ladder is stored as "minutes since the OT day's midnight"
// (a punch after midnight is 1440 + its clock minutes) but HR reads and types it as a clock time: "9:00 PM", "12:00 AM",
// "2:00 AM next day". These pure helpers convert both ways, and say what is wrong with a text that cannot be read.

export const MINUTES_PER_DAY = 1440;
/** The latest limit that can be written: 11:59 PM of the next day. */
export const MAX_UNTIL_MINUTES = 2 * MINUTES_PER_DAY - 1;

/** 0..1439 -> "9:00 PM" (12-hour clock, 0 = "12:00 AM", 720 = "12:00 PM"). */
export function formatClock(minuteOfDay: number): string {
  const wrapped = ((Math.round(minuteOfDay) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * A ladder limit as HR writes it: 1260 -> "9:00 PM", 1440 -> "12:00 AM" (the midnight that ends the OT day),
 * 1560 -> "2:00 AM next day". A limit of 1 to 1439 is the same day; 1441 or more is after midnight.
 */
export function formatUntil(minutes: number): string {
  if (minutes > MAX_UNTIL_MINUTES || minutes < 1) return `${minutes} minutes`;
  if (minutes === MINUTES_PER_DAY) return formatClock(0);
  if (minutes > MINUTES_PER_DAY) return `${formatClock(minutes - MINUTES_PER_DAY)} next day`;
  return formatClock(minutes);
}

const HELP = "Write a clock time such as 9:00 PM, or 2:00 AM next day for a time after midnight.";

export type ParsedUntil = { minutes: number; error?: undefined } | { minutes?: undefined; error: string };

/**
 * The limit a text means, in minutes since the OT day's midnight, or why it cannot be read.
 * Understood: "9:00 PM", "9pm", "21:00", "21", "12:00 AM" / "00:00" / "midnight" (the midnight that ends the day, 1440),
 * and any of those followed by "next day" (or "tomorrow", "+1") for a time after midnight: "2:00 AM next day" = 1560.
 */
export function parseUntil(text: string): ParsedUntil {
  const cleaned = text.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (cleaned === "") return { error: "Enter the time. " + HELP };

  let rest = cleaned;
  let nextDay = false;
  const marker = /\s*(\(?next day\)?|\(?nextday\)?|tomorrow|\+1)\s*$/;
  if (marker.test(rest)) {
    nextDay = true;
    rest = rest.replace(marker, "").trim();
  }

  let timeOfDay: number;
  if (rest === "midnight" || rest === "12 midnight") {
    timeOfDay = 0;
  } else {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(rest);
    if (!m) return { error: HELP };
    let hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    const meridiem = m[3];
    if (minute > 59) return { error: `${m[2]} is not a minute from 00 to 59. ${HELP}` };
    if (meridiem) {
      if (hour < 1 || hour > 12) return { error: `With AM or PM the hour is from 1 to 12. ${HELP}` };
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    } else if (hour === 24 && minute === 0) {
      hour = 0;
    } else if (hour > 23) {
      return { error: `${hour} is not an hour. ${HELP}` };
    }
    timeOfDay = hour * 60 + minute;
  }

  // Midnight is the one that ENDS the OT day (24:00): "12:00 AM" and "12:00 AM next day" are the same instant, 1440.
  const minutes = nextDay ? MINUTES_PER_DAY + timeOfDay : timeOfDay === 0 ? MINUTES_PER_DAY : timeOfDay;
  return { minutes };
}

/** True when the text already says "next day" (so the ordering message does not need to suggest it). */
export const saysNextDay = (text: string): boolean => /(next ?day|tomorrow|\+1)/i.test(text);

/** 150 -> "2 hours 30 minutes", 60 -> "1 hour", 45 -> "45 minutes", 0 -> "0 minutes". */
export function formatDuration(totalMinutes: number): string {
  const total = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** 150 -> "2 h 30 min": the short form for sentences that already carry a lot of numbers. */
export function formatShort(totalMinutes: number): string {
  const total = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
