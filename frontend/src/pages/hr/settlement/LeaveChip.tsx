import { AlertOctagon, AlertTriangle, CalendarDays } from "lucide-react";
import type { AdvanceLeaveCheck } from "@/lib/api-client";
import { leaveChipOf } from "./leave";
import { Chip } from "./parts";

/**
 * The leave check of a request (owner 2026-11-26): an orange chip for exactly 3 days of leave in the 1st-20th ("3 days
 * leave"), a red one for more ("5 days leave"). Below the warning nothing is drawn, unless `showOk` (a column of its own,
 * the detail sheet), when a quiet grey "2 days" is. The words and an icon carry the meaning, not the colour alone.
 */
export function LeaveChip({
  check,
  showOk = false,
  testId,
  className,
}: {
  check: AdvanceLeaveCheck | null | undefined;
  showOk?: boolean;
  testId?: string;
  className?: string;
}) {
  const view = leaveChipOf(check);
  if (!view || (view.flag === "ok" && !showOk)) return null;
  const Icon = view.flag === "critical" ? AlertOctagon : view.flag === "warning" ? AlertTriangle : CalendarDays;
  return (
    <span title={view.title} className="inline-flex" data-testid={testId} data-flag={view.flag}>
      <Chip tone={view.tone} className={className}>
        <Icon size={11} aria-hidden className="shrink-0" />
        <span className="sr-only">{view.srPrefix} </span>
        {view.text}
      </Chip>
    </span>
  );
}
