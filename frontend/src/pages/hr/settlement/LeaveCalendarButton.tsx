import { useState, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { LeaveCalendarDialog } from "@/components/leave-calendar/LeaveCalendar";
import type { AdvanceLeaveCheck } from "@/lib/api-client";
import { fetchAdvanceLeaveCalendar } from "@/lib/api-client/custom-hooks/settlement-automation";
import { leaveChipOf } from "./leave";
import { LeaveChip } from "./LeaveChip";

/**
 * The Leave column of a request (owner 2026-11-27): the leave check as a chip (orange for 3 days, red for more, grey
 * below) that opens the request's leave calendar. A request without a leave check still opens the calendar.
 */
export function LeaveButton({
  check,
  name,
  onOpen,
  testId,
}: {
  check: AdvanceLeaveCheck | null | undefined;
  name: string;
  onOpen: () => void;
  testId?: string;
}) {
  const view = leaveChipOf(check);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={`${view ? `${view.title} ` : ""}Open ${name}'s leave calendar.`}
      aria-haspopup="dialog"
      className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      data-view-safe
      data-testid={testId}
      data-flag={view?.flag}
    >
      {view ? (
        <LeaveChip check={check} showOk className="cursor-pointer hover:brightness-95" />
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">
          <CalendarDays size={11} aria-hidden /> Calendar
        </span>
      )}
    </button>
  );
}

/** One leave-calendar dialog for a list: `show(advanceId, name)` opens it (GET /api/advances/<id>/leave-calendar). */
export function useLeaveCalendar(): { show: (advanceId: number, name: string) => void; dialog: ReactNode } {
  const [target, setTarget] = useState<{ id: number; name: string } | null>(null);
  const dialog = (
    <LeaveCalendarDialog
      open={target !== null}
      onClose={() => setTarget(null)}
      load={() => fetchAdvanceLeaveCalendar(target!.id)}
      title={target ? `${target.name}: leave calendar` : undefined}
    />
  );
  return { show: (id, name) => setTarget({ id, name }), dialog };
}
