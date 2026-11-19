import { fmtDateTime, fmtWhen, type DateInput } from "./fmt";

/** A time in a table: "08:34", with the day beside it in small type when it is not today ("08:34 17 Nov"). */
export function WhenCell({ value, now }: { value: DateInput; now?: Date }) {
  const { time, date } = fmtWhen(value, now);
  return (
    <span className="whitespace-nowrap tabular-nums" title={date ? fmtDateTime(value, { year: true }) : undefined}>
      <span className="font-medium text-slate-900">{time}</span>
      {date && <span className="ml-1.5 text-[11px] text-slate-500">{date}</span>}
    </span>
  );
}
