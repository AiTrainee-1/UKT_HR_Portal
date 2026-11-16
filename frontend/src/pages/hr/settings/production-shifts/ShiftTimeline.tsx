import { cn } from "@/lib/utils";
import { barBreaks, barOrigin, barPercent, barTicks, labelsThatFit, type LadderPoint } from "./summary";
import { atText } from "./time";

/** The stripes of an unpaid break on a bar. */
export const BREAK_HATCH =
  "repeating-linear-gradient(135deg, rgba(71, 85, 105, 0.55) 0 2px, rgba(255, 255, 255, 0.75) 2px 5px)";

/** Labels near an edge of the bar hang inwards, so they never stick out of it. */
function anchor(percent: number): string {
  if (percent < 6) return "translate-x-0";
  if (percent > 94) return "-translate-x-full";
  return "-translate-x-1/2";
}

/**
 * A 24-hour bar: the shift's time (start to end) in blue, any paid time after the end in light blue, the unpaid breaks
 * striped, each paid leaving time as a tick with the shifts it earns above it, and midnight, 6 AM, noon and 6 PM under it.
 * Without a start it is the whole day from midnight (the Breaks section uses it like that). Purely a picture: `summary`
 * says the same in words for a screen reader.
 */
export function ShiftTimeline({
  start,
  end,
  extraEnd,
  points = [],
  spans,
  summary,
  testId,
  className,
}: {
  /** Minutes from the shift day's midnight; null for a whole-day bar. */
  start: number | null;
  /** The end of the blue part (the group's end time). */
  end?: number | null;
  /** Paid time after `end` up to here (the last paid leaving time). */
  extraEnd?: number | null;
  points?: LadderPoint[];
  /** The unpaid breaks, [start, end] minutes of a day. */
  spans: [number, number][];
  summary: string;
  testId?: string;
  className?: string;
}) {
  const origin = barOrigin(start);
  const at = (minutes: number) => barPercent(origin, minutes);
  const percents = points.map((p) => at(p.at));
  const shown = labelsThatFit(percents, 7);
  const band = (from: number, to: number) => ({ left: `${at(from)}%`, width: `${Math.max(0, at(to) - at(from))}%` });

  return (
    <div className={cn("min-w-0", className)} data-testid={testId}>
      <p className="sr-only">{summary}</p>
      <div aria-hidden className="relative">
        {points.length > 0 && (
          <div className="relative h-4">
            {points.map((p, i) =>
              shown[i] ? (
                <span
                  key={p.key}
                  className={cn(
                    "absolute bottom-0 whitespace-nowrap text-[10px] font-semibold leading-none tabular-nums text-slate-600",
                    anchor(percents[i]),
                  )}
                  style={{ left: `${percents[i]}%` }}
                >
                  {p.value.toFixed(2)}
                </span>
              ) : null,
            )}
          </div>
        )}
        <div className="relative mt-1 h-3.5">
          <div className="absolute inset-0 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200">
            {start !== null && end != null && end > start && (
              <div className="absolute inset-y-0 bg-[#006496]" style={band(start, end)} data-part="shift" />
            )}
            {start !== null && end != null && extraEnd != null && extraEnd > end && (
              <div className="absolute inset-y-0 bg-sky-300" style={band(end, extraEnd)} data-part="after-end" />
            )}
            {barBreaks(origin, spans).map(([from, to]) => (
              <div
                key={`${from}-${to}`}
                className="absolute inset-y-0"
                style={{ ...band(from, to), backgroundImage: BREAK_HATCH }}
                data-part="break"
              />
            ))}
            {barTicks(origin).map((t) => (
              <div key={t.at} className="absolute inset-y-0 w-px bg-white/80" style={{ left: `${at(t.at)}%` }} />
            ))}
          </div>
          {points.map((p, i) => (
            <span
              key={p.key}
              title={`Leaves at ${atText(p.at)}: ${p.value.toFixed(2)} shifts`}
              className="absolute -top-1 h-[22px] w-0.5 -translate-x-1/2 rounded-full bg-slate-800"
              style={{ left: `${percents[i]}%` }}
              data-part="point"
            />
          ))}
        </div>
        <div className="relative mt-1 h-3.5">
          {barTicks(origin).map((t) => (
            <span
              key={t.at}
              className={cn(
                "absolute top-0 whitespace-nowrap text-[10px] leading-none text-slate-400",
                anchor(at(t.at)),
              )}
              style={{ left: `${at(t.at)}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** What the colours of the bars mean, shown once under them. */
export function TimelineKey({ className }: { className?: string }) {
  const swatch = "inline-block h-2.5 w-4 shrink-0 rounded-sm ring-1 ring-inset ring-slate-200";
  return (
    <ul
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500", className)}
      data-testid="timeline-key"
    >
      <li className="flex items-center gap-1.5">
        <span className={cn(swatch, "bg-[#006496]")} /> Shift time (start to end)
      </li>
      <li className="flex items-center gap-1.5">
        <span className={cn(swatch, "bg-sky-300")} /> Paid time after the end
      </li>
      <li className="flex items-center gap-1.5">
        <span className={swatch} style={{ backgroundImage: BREAK_HATCH }} /> Unpaid break
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-0.5 rounded-full bg-slate-800" /> Paid leaving time (shifts above it)
      </li>
    </ul>
  );
}
