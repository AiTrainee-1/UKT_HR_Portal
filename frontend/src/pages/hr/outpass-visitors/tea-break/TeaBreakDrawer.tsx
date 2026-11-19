import { LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTeaBreakRecordDetail, type TeaBreakAdminRecord } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { cn } from "@/lib/utils";
import { DetailDrawer, DrawerSection, StatusChip, TimeBar, fmtDate, fmtMinutes, fmtTime, NONE } from "../kit";
import { FLAG_NOTE, liveMinutes, liveStatus, STATUS_LABEL, STATUS_TONE, isOpen } from "./teaBreak";

/**
 * One break, opened from a row of the list: both gate scans (time and gate), how long it took against the allowance,
 * the employee's numbers for that month and their latest breaks (a click opens one of them), and a way to list all of
 * that employee's breaks. It only reads, so nothing in it is locked for a View-only role.
 */
export function TeaBreakDrawer({
  row,
  open: isShown,
  now,
  onClose,
  onOpenBreak,
  onShowEmployee,
}: {
  /** The break to show (the last one opened: it stays while the drawer slides shut). */
  row: TeaBreakAdminRecord | null;
  open: boolean;
  now: Date;
  onClose: () => void;
  onOpenBreak: (row: TeaBreakAdminRecord) => void;
  onShowEmployee: (row: TeaBreakAdminRecord) => void;
}) {
  // the last break opened stays asked for while the drawer slides shut (it is cached: no new request)
  const detail = useTeaBreakRecordDetail(row?.id ?? null);
  const data = detail.data && row && detail.data.id === row.id ? detail.data : null;
  const shown = data ?? row;
  if (!shown) return null;

  const open = isOpen(shown);
  const status = liveStatus(shown, now);
  const minutes = liveMinutes(shown, now);
  const allowed = shown.allowedMinutes;
  const over = !open && shown.overMinutes ? shown.overMinutes : 0;
  const firstName = shown.employee.name.split(" ")[0] || shown.employee.name;
  const month = data?.employeeMonth;
  const subtitle = [shown.employee.employeeCode, shown.employee.department ?? "No department", shown.designation]
    .filter(Boolean)
    .join(" · ");

  return (
    <DetailDrawer
      open={isShown}
      onOpenChange={(next) => !next && onClose()}
      title={shown.employee.name}
      subtitle={subtitle}
      testId="tea-break-drawer"
      footer={
        <>
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            onClick={() => onShowEmployee(shown)}
            data-testid="tea-drawer-all-breaks"
            {...{ [VIEW_SAFE_ATTR]: "" }}
          >
            All breaks of {firstName}
          </Button>
          <Button variant="ghost" className="h-11 sm:h-9" onClick={onClose} {...{ [VIEW_SAFE_ATTR]: "" }}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-5" {...{ [VIEW_SAFE_ATTR]: "" }}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={STATUS_TONE[status]} testId="tea-drawer-status">
            {STATUS_LABEL[status]}
            {open ? ` · ${fmtMinutes(minutes)}` : ""}
          </StatusChip>
          {shown.flag && (
            <StatusChip tone="slate" title={FLAG_NOTE[shown.flag]}>
              {shown.flagLabel ?? (shown.flag === "long" ? "Long break" : "Left open")}
            </StatusChip>
          )}
          <span className="text-sm text-slate-500">{fmtDate(shown.outAt, { year: true })}</span>
        </div>

        <DrawerSection title="Gate scans" testId="tea-drawer-scans">
          <div className="grid grid-cols-2 gap-2">
            <ScanBox
              icon={LogOut}
              label="Out"
              time={fmtTime(shown.outAt)}
              day={fmtDate(shown.outAt)}
              gate={shown.outGateName}
            />
            {shown.inAt ? (
              <ScanBox
                icon={LogIn}
                label="Back"
                time={fmtTime(shown.inAt)}
                day={fmtDate(shown.inAt)}
                gate={shown.inGateName}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">Back</p>
                <p className="mt-1 text-sm font-medium text-amber-900">Not scanned back yet</p>
                <p className="mt-0.5 text-xs text-amber-800">Out for {fmtMinutes(minutes)} so far</p>
              </div>
            )}
          </div>
          {shown.flag && <p className="text-xs text-slate-500">{FLAG_NOTE[shown.flag]}</p>}
        </DrawerSection>

        <DrawerSection title="Time against the rule" testId="tea-drawer-time">
          <TimeBar minutes={minutes} allowed={allowed} running={open} showLabel={false} />
          <p className="text-sm text-slate-700">
            {open ? `${fmtMinutes(minutes)} so far` : `${fmtMinutes(minutes)} taken`} · {fmtMinutes(allowed)} allowed
            {over > 0 && <span className="font-semibold text-rose-700"> · {fmtMinutes(over)} over</span>}
          </p>
        </DrawerSection>

        <DrawerSection title={month ? `${month.label} for ${firstName}` : "This month"} testId="tea-drawer-month">
          {month ? (
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="Breaks" value={String(month.breaks)} />
              <MiniStat
                label="Over the limit"
                value={String(month.overtime)}
                hint={month.breaks ? `${Math.round((100 * month.overtime) / month.breaks)}%` : undefined}
                bad={month.overtime > 0}
              />
              <MiniStat label="Average" value={fmtMinutes(month.avgMinutes)} />
            </div>
          ) : (
            <p className="text-sm text-slate-500">{detail.isError ? "Could not load this month." : "Loading…"}</p>
          )}
        </DrawerSection>

        <DrawerSection title="Recent breaks" testId="tea-drawer-recent">
          {data ? (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/80">
              {data.recent.map((r) => {
                const current = r.id === shown.id;
                const rs = liveStatus(r, now);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => !current && onOpenBreak(r)}
                      aria-current={current ? "true" : undefined}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm tabular-nums",
                        current ? "bg-sky-50" : "hover:bg-slate-50",
                      )}
                    >
                      <span className="w-14 shrink-0 font-medium text-slate-900">{fmtDate(r.outAt)}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-600">
                        {fmtTime(r.outAt)} – {r.inAt ? fmtTime(r.inAt) : "still out"}
                        {current && <span className="ml-2 text-xs text-sky-700">This break</span>}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-semibold",
                          STATUS_TONE[rs] === "rose"
                            ? "text-rose-700"
                            : STATUS_TONE[rs] === "amber"
                              ? "text-amber-700"
                              : "text-teal-700",
                        )}
                        title={STATUS_LABEL[rs]}
                      >
                        {fmtMinutes(liveMinutes(r, now))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{detail.isError ? NONE : "Loading…"}</p>
          )}
        </DrawerSection>
      </div>
    </DetailDrawer>
  );
}

function ScanBox({
  icon: Icon,
  label,
  time,
  day,
  gate,
}: {
  icon: typeof LogIn;
  label: string;
  time: string;
  day: string;
  gate: string | null;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200/80 bg-slate-50/60 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Icon size={12} aria-hidden="true" /> {label}
      </p>
      <p className="mt-1 text-base font-semibold tabular-nums text-slate-900">
        {time} <span className="text-xs font-normal text-slate-500">{day}</span>
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-600" title={gate ?? undefined}>
        {gate ?? "Gate not known"}
      </p>
    </div>
  );
}

function MiniStat({ label, value, hint, bad }: { label: string; value: string; hint?: string; bad?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200/80 px-3 py-2 text-center">
      <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn("mt-0.5 text-lg font-bold tabular-nums", bad ? "text-rose-700" : "text-slate-900")}>
        {value}
        {hint && <span className="ml-1 text-xs font-normal text-slate-500">{hint}</span>}
      </p>
    </div>
  );
}
