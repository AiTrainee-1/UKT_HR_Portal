import type { ReactNode } from "react";
import { AlarmClock, CalendarDays, Clock, Coins, LogOut, MousePointerClick } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ProductionShiftGroup } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  DAYS_LABEL,
  detectionTimes,
  ladderRows,
  shiftSpan,
  shiftsText,
  spanLength,
  timelinePieces,
  topValue,
} from "./production-shift-logic";

function Fact({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-2.5 py-2">
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-slate-500">{label}</p>
        <p className="text-xs font-semibold tabular-nums text-slate-900">{value}</p>
        {hint && <p className="text-[11px] leading-snug text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * One production shift: a Settings default (Day / Night / Sunday ...) or a special shift. Its hours on a 24-hour bar (a
 * night shift wraps past midnight), the detection timings HR asked to see on Manage Shifts (on time until, early out
 * before, which first punches pick it), and its Earned Shift table. `badge`, `actions` and `footer` are the caller's: a
 * default says where it is edited, a special one has its own buttons and its workers.
 */
export default function ProductionShiftCard({
  group,
  graceMinutes,
  special = false,
  actions,
  footer,
  testId,
}: {
  group: ProductionShiftGroup;
  graceMinutes: number;
  special?: boolean;
  actions?: ReactNode;
  footer?: ReactNode;
  testId: string;
}) {
  const { start, end } = shiftSpan(group);
  const pieces = timelinePieces(start, end);
  const length = spanLength(start, end);
  const detect = detectionTimes(group, graceMinutes);
  const rows = ladderRows(group);
  const top = topValue(group);
  const on = group.enabled;

  return (
    <Card
      className={cn("overflow-hidden border-0 shadow-sm", !on && "bg-gray-50")}
      data-testid={testId}
      data-special={special || undefined}
    >
      <div className="flex">
        <div className={cn("w-1 shrink-0", !on ? "bg-gray-300" : special ? "bg-violet-500" : "bg-amber-500")} />
        <div className="min-w-0 flex-1 space-y-3.5 p-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                special ? "bg-violet-100 text-violet-700" : "bg-amber-100 text-amber-700",
              )}
            >
              <Clock size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h4 className="truncate text-sm font-bold text-gray-900" data-testid={`${testId}-name`}>
                  {group.label}
                </h4>
                {special ? (
                  <StatusBadge tone="accent" className="text-[11px] sm:text-[10px]">
                    Special
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="info" className="text-[11px] sm:text-[10px]">
                    Default · from Settings
                  </StatusBadge>
                )}
                {!on && (
                  <StatusBadge tone="danger" className="text-[11px] sm:text-[10px]">
                    Switched off
                  </StatusBadge>
                )}
              </div>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarDays size={12} /> {DAYS_LABEL[group.appliesOn]}
              </p>
            </div>
            {actions && <div className="flex shrink-0 items-center">{actions}</div>}
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="flex flex-wrap items-center gap-1.5 text-lg font-black tabular-nums text-gray-900">
                {group.startTime} <span className="text-gray-300">→</span> {group.mainOutTime ?? "—"}
                {group.mainOutNextDay && (
                  <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                    next day
                  </span>
                )}
              </p>
              {length && <span className="text-xs font-semibold text-gray-500">{length}</span>}
            </div>
            <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100" aria-hidden>
              {pieces.map((p, i) => (
                <div
                  key={i}
                  className={cn(
                    "absolute top-0 h-full rounded-full",
                    !on ? "bg-gray-300" : special ? "bg-violet-500" : "bg-amber-500",
                  )}
                  style={{ left: `${p.left}%`, width: `${p.width}%` }}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] font-medium text-gray-300 sm:text-[10px]" aria-hidden>
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </div>
          </div>

          {/* the detection timings */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid={`${testId}-detections`}>
            <Fact
              icon={<AlarmClock size={13} />}
              label="On time until"
              value={detect.onTimeUntil}
              hint={`Start + ${graceMinutes} min grace; a later first punch is Late`}
            />
            <Fact
              icon={<LogOut size={13} />}
              label="Early out before"
              value={detect.earlyOutBefore ?? "No standard departure"}
              hint={detect.earlyOutBefore ? `Departure − ${graceMinutes} min grace` : undefined}
            />
            {special ? (
              <Fact
                icon={<MousePointerClick size={13} />}
                label="Who it judges"
                value="Only the workers put on it"
                hint="On its days and dates; the defaults otherwise"
              />
            ) : (
              <Fact
                icon={<MousePointerClick size={13} />}
                label="Picks the day when the first punch is"
                value={detect.window}
                hint="The day's first punch chooses the shift"
              />
            )}
            <Fact
              icon={<Coins size={13} />}
              label="Earned shifts"
              value={rows.length ? `Up to ${shiftsText(top)} shifts` : "No row switched on"}
              hint="From the last punch, by the table below"
            />
          </div>

          {/* the Earned Shift table */}
          {rows.length > 0 && (
            <div className="rounded-lg border border-slate-100" data-testid={`${testId}-ladder`}>
              <div className="flex items-center justify-between border-b border-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600">
                <span>Earned Shift table · leave at</span>
                <span>shifts</span>
              </div>
              <ol className="grid grid-cols-1 sm:grid-cols-2">
                {rows.map((r, i) => (
                  <li
                    key={`${r.at}-${i}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1 text-xs odd:bg-slate-50 sm:odd:bg-transparent sm:[&:nth-child(4n+1)]:bg-slate-50 sm:[&:nth-child(4n+2)]:bg-slate-50"
                  >
                    <span className="tabular-nums text-slate-700">
                      {r.at}
                      {r.label && <span className="ml-1 text-[11px] text-slate-400">{r.label}</span>}
                    </span>
                    <span className="font-semibold tabular-nums text-slate-900">{shiftsText(r.value)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {footer && <div className="border-t pt-3">{footer}</div>}
        </div>
      </div>
    </Card>
  );
}
