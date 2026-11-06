import { memo, type ReactNode } from "react";
import {
  Fingerprint,
  Hourglass,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  PenLine,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { ListedPunch } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { PUNCH_KIND_META, punchKind, punchTitle, type PunchKind } from "./logic";

type IconType = typeof Fingerprint;

const KIND_ICON: Record<PunchKind, IconType> = {
  biometric: Fingerprint,
  geo: MapPin,
  on_duty: Navigation,
  missing_punch: TriangleAlert,
  hr_entry: PenLine,
  auto: Sparkles,
  held: Hourglass,
  rejected: Navigation,
  uncounted: Fingerprint,
};

/**
 * Every punch of a day as a row of chips, oldest first: the arrow says In or Out, the colour and the small icon say where
 * the punch came from (device, phone, On-Duty, Missing Punch, HR), a "+1" marks a closing punch made after midnight, a
 * dashed chip a punch the day is not counted on (an On-Duty punch waiting for HR, the punch that closed last night's shift,
 * a double tap). Each chip's tooltip and accessible name say all of it in words.
 */
export const PunchTimeline = memo(function PunchTimeline({
  punches,
  dayDate,
  size = "md",
  empty,
  className,
  testId = "punch-timeline",
}: {
  punches: readonly ListedPunch[] | undefined;
  /** The day the list belongs to: a punch on another date shows "+1". */
  dayDate?: string;
  size?: "sm" | "md";
  empty?: ReactNode;
  className?: string;
  testId?: string;
}) {
  if (!punches || punches.length === 0) {
    return <span className="text-xs text-slate-500">{empty ?? "No punches"}</span>;
  }
  return (
    <ol className={cn("flex flex-wrap items-center gap-1", className)} aria-label="Punches" data-testid={testId}>
      {punches.map((p, i) => {
        const kind = punchKind(p);
        const meta = PUNCH_KIND_META[kind];
        const Icon = KIND_ICON[kind];
        const Arrow = p.type === "OUT" ? LogOut : LogIn;
        const title = punchTitle(p, dayDate);
        const otherDay = !!p.nextDay || (!!dayDate && p.date !== dayDate);
        return (
          <li key={`${p.date}-${p.time}-${i}`} className="list-none">
            <span
              title={title}
              aria-label={title}
              data-kind={kind}
              data-type={p.type}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border font-semibold tabular-nums",
                size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
                meta.chip,
              )}
            >
              <Arrow size={size === "sm" ? 10 : 11} aria-hidden="true" className="shrink-0 opacity-70" />
              <span>{p.time.slice(0, 5)}</span>
              {otherDay && (
                <sup className="-ml-0.5 text-[9px] font-bold" aria-hidden="true">
                  +1
                </sup>
              )}
              <Icon size={size === "sm" ? 10 : 11} aria-hidden="true" className="shrink-0 opacity-60" />
            </span>
          </li>
        );
      })}
    </ol>
  );
});

/** The chip colours, named: shown once above a list of punches. */
export function PunchLegend({ kinds, className }: { kinds?: readonly PunchKind[]; className?: string }) {
  const list = kinds ?? (["biometric", "geo", "on_duty", "missing_punch", "hr_entry", "held"] as const);
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600", className)}>
      {list.map((kind) => (
        <li key={kind} className="inline-flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", PUNCH_KIND_META[kind].dot)} aria-hidden="true" />
          {PUNCH_KIND_META[kind].label}
        </li>
      ))}
    </ul>
  );
}
