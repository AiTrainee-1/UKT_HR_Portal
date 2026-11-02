import { ArrowRight, CircleAlert, MessageSquareText } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { HrEdit, PayrollDay } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  HR_EDIT_TONE,
  changeText,
  hrEditCounts,
  hrEditLabel,
  hrEditTone,
  sideText,
  whoWhen,
  type HrEditTone,
} from "./hr-edit";

/**
 * What HR changed on a day and where its approval stands: the type, from -> to (with the shifts), the reason, who raised it
 * and when, the stage in words, who decided and when, and their comment. The body of the "!" popover, and of the day panel.
 */
export function HrEditDetails({ edit, className }: { edit: HrEdit; className?: string }) {
  const tone = HR_EDIT_TONE[hrEditTone(edit.status)];
  const raised = whoWhen(edit.raisedBy, edit.raisedAt);
  const decided = whoWhen(edit.decidedBy, edit.decidedAt);
  return (
    <div className={cn("space-y-2.5 text-xs text-slate-700", className)} data-testid="pd-hr-edit-details">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-black",
            tone.badge,
          )}
          aria-hidden="true"
        >
          !
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Edited by HR</p>
          <p className="text-sm font-bold text-slate-900" data-testid="pd-hr-edit-type">
            {edit.typeLabel || "Attendance changed"}
          </p>
        </div>
      </div>

      <p
        className="flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-slate-800"
        data-testid="pd-hr-edit-change"
        title={changeText(edit)}
      >
        <span>{sideText(edit.from)}</span>
        <ArrowRight size={12} className="text-slate-400" aria-hidden="true" />
        {/* the arrow is a picture: a screen reader hears "to" */}
        <span className="sr-only"> to </span>
        <span className="font-semibold">{sideText(edit.to)}</span>
      </p>

      <p
        className={cn("rounded-lg border px-2.5 py-1.5 font-semibold leading-snug", tone.soft)}
        data-testid="pd-hr-edit-stage"
      >
        {edit.stageLabel}
      </p>

      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        {edit.reason && (
          <>
            <dt className="text-slate-500">Reason</dt>
            <dd className="break-words text-slate-800" data-testid="pd-hr-edit-reason">
              {edit.reason}
            </dd>
          </>
        )}
        {raised && (
          <>
            <dt className="text-slate-500">Raised by</dt>
            <dd className="text-slate-800" data-testid="pd-hr-edit-raised">
              {raised}
            </dd>
          </>
        )}
        {decided && (
          <>
            <dt className="text-slate-500">{edit.status === "rejected" ? "Rejected by" : "Decided by"}</dt>
            <dd className="text-slate-800" data-testid="pd-hr-edit-decided">
              {decided}
            </dd>
          </>
        )}
      </dl>

      {edit.comment && (
        <p className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5" data-testid="pd-hr-edit-comment">
          <MessageSquareText size={12} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span className="min-w-0 break-words">
            <span className="font-semibold text-slate-800">Comment: </span>
            {edit.comment}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * The "!" on a day HR edited (amber while it waits, green once applied, rose when rejected). Clicking it - or Enter / Space
 * on it - opens what was changed and where the approval stands. It sits beside the day's own button, never inside it, and it
 * only reads, so a View Only role can open it too (`data-view-safe`).
 */
export function HrEditBadge({
  edit,
  date,
  className,
  size = "sm",
}: {
  edit: HrEdit;
  date: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const tone = HR_EDIT_TONE[hrEditTone(edit.status)];
  return (
    <span data-view-safe className={cn("inline-flex", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={hrEditLabel(edit)}
            data-testid={`pd-hr-edit-${date}`}
            data-status={edit.status}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full font-black leading-none shadow-sm ring-2 ring-white transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-slate-500",
              size === "md" ? "h-5 w-5 text-xs" : "h-[18px] w-[18px] text-[11px]",
              tone.badge,
            )}
          >
            <span aria-hidden="true">!</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          collisionPadding={12}
          className="w-80 max-w-[calc(100vw-2rem)] p-3.5"
          data-view-safe
          data-testid="pd-hr-edit-popover"
          aria-label="What HR changed on this day"
        >
          <HrEditDetails edit={edit} />
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** The key of the "!": shown only when some day of the period carries an HR edit, with how many in each state. */
export function HrEditLegend({ days }: { days: Pick<PayrollDay, "hrEdit">[] }) {
  const counts = hrEditCounts(days);
  const total = counts.waiting + counts.applied + counts.rejected;
  if (total === 0) return null;
  const tones: HrEditTone[] = ["waiting", "applied", "rejected"];
  return (
    <p
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600"
      data-testid="pd-hr-edit-legend"
    >
      <span className="font-semibold text-slate-700">
        Edited by HR: {total} {total === 1 ? "day" : "days"}
      </span>
      {tones
        .filter((t) => counts[t] > 0)
        .map((t) => (
          <span key={t} className="inline-flex items-center gap-1" data-tone={t}>
            <span
              className={cn(
                "flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-black",
                HR_EDIT_TONE[t].badge,
              )}
              aria-hidden="true"
            >
              !
            </span>
            {HR_EDIT_TONE[t].word} <span className="tabular-nums opacity-70">{counts[t]}</span>
          </span>
        ))}
      <span className="text-slate-400">Click a ! to see what was changed.</span>
    </p>
  );
}

/** One line at the top of the edit form: the day's last HR edit and where it stands. */
export function HrEditStageLine({ edit }: { edit: HrEdit }) {
  const tone = HR_EDIT_TONE[hrEditTone(edit.status)];
  return (
    <p
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs", tone.soft)}
      data-testid="pd-day-edit-hr-stage"
    >
      <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
      <span className="font-semibold">This day&apos;s last HR edit: {edit.typeLabel || "attendance changed"}</span>
      <span className="opacity-60" aria-hidden="true">
        ·
      </span>
      <span>{edit.stageLabel}</span>
    </p>
  );
}
