import type { InOutRow, InOutStatus } from "@/lib/api-client/custom-hooks";
import { NONE, TimeBar, WhenCell, fmtMinutes } from "../kit";

/** The status filter of In/Out ("out" lists everyone still out, overdue included: the Still out figure). */
export const STATUS_OPTIONS: readonly { value: InOutStatus; label: string }[] = [
  { value: "back", label: "Back" },
  { value: "out", label: "Still out" },
  { value: "overdue", label: "Overdue" },
  { value: "not_returned", label: "Not returned" },
  { value: "early_dismissal", label: "Left for the day" },
];

/** A longer explanation of a row's status, for its chip's tooltip. */
export function statusTitle(row: InOutRow): string {
  const over = row.overMinutes ? fmtMinutes(row.overMinutes) : null;
  switch (row.status) {
    case "back":
      return over ? `Came back ${over} after the expected return` : "Came back";
    case "out":
      return "Out today, not back yet";
    case "overdue":
      return over ? `Still out ${over} after the expected return` : "Still out after the expected return";
    case "not_returned":
      return "Went out on an earlier day and was never scanned back in";
    case "early_dismissal":
      return "An early-dismissal pass: not expected back";
    default:
      return row.statusLabel;
  }
}

/** How long the person was out: a bar against the expected return when there was one, else the minutes. */
export function TimeOut({ row }: { row: InOutRow }) {
  if (row.minutesOut === null || row.minutesOut === undefined) {
    return <span className="text-slate-400">{NONE}</span>;
  }
  if (row.allowedMinutes !== null && row.allowedMinutes !== undefined) {
    return <TimeBar minutes={row.minutesOut} allowed={row.allowedMinutes} running={row.status === "out"} />;
  }
  return (
    <span className="tabular-nums text-slate-700">
      {fmtMinutes(row.minutesOut)}
      {row.status === "out" || row.status === "overdue" ? " so far" : ""}
    </span>
  );
}

/** A time and the gate it happened at: "08:34 · Gate 1" (with the day when it was not today). */
export function TimeAtGate({ at, gate }: { at: string | null; gate: string | null }) {
  if (!at) return <span className="text-slate-400">{NONE}</span>;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <WhenCell value={at} />
      {gate && <span className="truncate text-[11px] text-slate-500">· {gate}</span>}
    </span>
  );
}
