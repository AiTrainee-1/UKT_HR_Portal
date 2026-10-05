// Number, money and time formatting for the MD portal. Indian grouping (12,34,567) and lakh / crore, because that is how
// the company reads money; one place so every MD page says "₹12.4 L" the same way.

import { indianNumber } from "@/lib/report-format";

const dash = "—";

/** 1234567.5 -> "12,34,567.5" (Indian grouping). */
export function num(value: number | null | undefined, places = 0): string {
  if (value == null || Number.isNaN(value)) return dash;
  return indianNumber(value, places);
}

/** Full rupees: "₹12,34,568". */
export function inr(value: number | null | undefined, places = 0): string {
  if (value == null || Number.isNaN(value)) return dash;
  return `${value < 0 ? "-" : ""}₹${indianNumber(Math.abs(value), places)}`;
}

/** Compact rupees for cards: ₹45,200 · ₹12.4 L · ₹1.25 Cr. Under a lakh it stays exact. */
export function inrCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return dash;
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v >= 1e7) return `${sign}₹${trim(v / 1e7, 2)} Cr`;
  if (v >= 1e5) return `${sign}₹${trim(v / 1e5, 1)} L`;
  return `${sign}₹${indianNumber(Math.round(v), 0)}`;
}

function trim(n: number, places: number): string {
  return Number(n.toFixed(places)).toString();
}

/** 91.84 -> "91.8%" (the backend already sends 0-100). */
export function pct(value: number | null | undefined, places = 1): string {
  if (value == null || Number.isNaN(value)) return dash;
  return `${Number(value.toFixed(places))}%`;
}

/** "+3.2" / "-1.4" / "0": a change with its sign. */
export function signed(value: number | null | undefined, places = 1): string {
  if (value == null || Number.isNaN(value)) return dash;
  const rounded = Number(value.toFixed(places));
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/** Minutes as "2h 05m" / "45m". */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes)) return dash;
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export type Tone = "good" | "bad" | "neutral";

/** Whether a rise is good news: `higherIsBetter` = true for attendance, false for absenteeism or cost. */
export function changeTone(delta: number | null | undefined, higherIsBetter: boolean, threshold = 0): Tone {
  if (delta == null || Math.abs(delta) <= threshold) return "neutral";
  return delta > 0 === higherIsBetter ? "good" : "bad";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "2026-10-05" -> "05 Oct". */
export function dayShort(iso: string | null | undefined): string {
  if (!iso) return dash;
  const d = parseIso(iso);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
}

/** "2026-10-05" -> "05 Oct 2026". */
export function dayLong(iso: string | null | undefined): string {
  if (!iso) return dash;
  const d = parseIso(iso);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "2026-10-05" -> "Mon". */
export function weekdayShort(iso: string): string {
  return WEEKDAYS[parseIso(iso).getDay()];
}

/** "2026-09" -> "Sep 2026" (or "Sep" with `short`). */
export function monthText(ym: string, short = false): string {
  const [y, m] = ym.split("-").map(Number);
  return short ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`;
}

/** The server's wall-clock timestamp ("2026-10-05T10:42:10") as "10:42 am". */
export function clockText(iso: string | null | undefined): string {
  if (!iso) return dash;
  const [h, m] = (iso.split("T")[1] ?? "00:00").split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** A greeting for the factory's clock ("Good morning"), from the server's time so a wrong laptop clock cannot change it. */
export function greeting(serverIso: string | null | undefined, now: Date = new Date()): string {
  const timePart = serverIso?.split("T")[1];
  const hour = timePart ? Number.parseInt(timePart.split(":")[0], 10) : now.getHours();
  if (Number.isNaN(hour)) return "Hello";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
