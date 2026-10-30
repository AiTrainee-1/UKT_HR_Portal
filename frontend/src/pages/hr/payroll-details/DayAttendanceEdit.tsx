import { useEffect, useMemo, useState } from "react";
import { Hourglass, Loader2, PenLine, Send, ShieldCheck, UserX } from "lucide-react";
import { ApprovalTrail, WaitingChip } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceEditContext,
  useSubmitAttendanceEdit,
  type AttendanceEditType,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

const GROUPS: { key: AttendanceEditType["group"]; title: string }[] = [
  { key: "Attendance", title: "Attendance" },
  { key: "Compensation", title: "Compensation" },
  { key: "Other", title: "Absent, leave and holiday" },
];

const timeText = (t: string | null | undefined): string => (t ? t.slice(0, 5) : "");

/**
 * What the Attendance this month card adds under a chosen day: EVERY punch of that day with where it came from, and the
 * Attendance Edit form inline. An edit is only proposed here: the employee's Department Head approves it first, then HR, and
 * the attendance record is written only after both (the same pipeline as the Attendance page's edit page). Shows nothing for a
 * login that has no access to Attendance.
 */
export function DayAttendanceEdit({ employeeId, date }: { employeeId: number; date: string }) {
  const { toast } = useToast();
  const ctx = useAttendanceEditContext(employeeId, date);
  const submit = useSubmitAttendanceEdit();
  const [open, setOpen] = useState(false);
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [shifts, setShifts] = useState("1.00");
  const [firstIn, setFirstIn] = useState("");
  const [lastOut, setLastOut] = useState("");
  const [late, setLate] = useState(false);
  const [earlyOut, setEarlyOut] = useState(false);
  const [note, setNote] = useState("");

  const data = ctx.data;
  const types = useMemo(() => data?.types ?? [], [data]);
  const selected = types.find((t) => t.key === typeKey) ?? null;
  const day = data?.day;

  // a different day starts with a closed, empty form
  useEffect(() => {
    setOpen(false);
    setTypeKey(null);
    setNote("");
  }, [employeeId, date]);
  // the form starts from the day as it stands
  useEffect(() => {
    if (!day) return;
    setFirstIn(day.firstPunch ?? "");
    setLastOut(day.lastPunch ?? "");
    setLate(day.isLate);
    setEarlyOut(!!day.earlyLeave);
  }, [day?.date, day?.firstPunch, day?.lastPunch, day?.isLate, day?.earlyLeave]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ctx.isLoading) {
    return (
      <p
        className="mt-3 flex items-center gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500"
        data-testid="pd-day-edit-loading"
      >
        <Loader2 size={13} className="animate-spin" /> Loading the punches…
      </p>
    );
  }
  if (ctx.isError || !data) return null; // no access to Attendance: the rest of the panel is all this login sees

  const pending = data.requests.find((r) => r.status === "pending");
  const noHod = !data.hod;
  const reasonOk = note.trim().length >= 3;
  const canSend = !!selected && reasonOk && !noHod && !data.future && !submit.isPending;

  const choose = (t: AttendanceEditType) => {
    setTypeKey(t.key);
    setShifts(t.shifts);
  };

  const send = async () => {
    if (!selected) return;
    try {
      await submit.mutateAsync({
        employeeId,
        date,
        type: selected.key,
        note: note.trim(),
        shifts: selected.shiftChoices.length ? shifts : undefined,
        firstPunch: selected.worked ? firstIn || null : null,
        lastPunch: selected.worked ? lastOut || null : null,
        isLate: selected.worked ? late : false,
        isEarlyOut: selected.worked ? earlyOut : false,
      });
      toast({
        title: "Sent for approval",
        description: `${selected.label} for ${date} goes to ${data.hod?.name ?? "the Department Head"} first, then to HR. The attendance does not change until both approve.`,
      });
      setOpen(false);
      setTypeKey(null);
      setNote("");
    } catch (e) {
      toast({
        title: "Could not send",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t border-slate-200 pt-3" data-testid="pd-day-edit">
      {/* ── every punch of the day ── */}
      <div data-testid="pd-day-punches">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
          Punches on this day ({data.punches.length})
        </p>
        {data.punches.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500" data-testid="pd-day-punches-empty">
            No punch is recorded for this day.
          </p>
        ) : (
          <div className="mt-1.5 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[22rem] text-xs">
              <thead className="bg-slate-50 text-left text-[11px] text-slate-500">
                <tr>
                  <th className="px-2.5 py-1.5 font-semibold">#</th>
                  <th className="px-2.5 py-1.5 font-semibold">Time</th>
                  <th className="px-2.5 py-1.5 font-semibold">In / Out</th>
                  <th className="px-2.5 py-1.5 font-semibold">Source</th>
                  <th className="px-2.5 py-1.5 font-semibold">Device</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.punches.map((p, i) => (
                  <tr key={p.id} data-testid="pd-day-punch">
                    <td className="px-2.5 py-1.5 tabular-nums text-slate-400">{i + 1}</td>
                    <td className="px-2.5 py-1.5 font-mono tabular-nums text-slate-800">{p.time}</td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-bold",
                          p.type === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700",
                        )}
                      >
                        {p.type}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-700" title={p.source}>
                      {p.sourceLabel}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-600">{p.device ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── a change already waiting ── */}
      {pending && (
        <div
          className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900"
          data-testid="pd-day-edit-pending"
        >
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <Hourglass size={13} /> A change for this day is waiting ({pending.typeLabel ?? "attendance edit"})
            <WaitingChip approval={pending.approval} />
          </p>
          {pending.approval && <ApprovalTrail approval={pending.approval} submittedBy="HR" />}
        </div>
      )}

      {/* ── edit ── */}
      {data.canEdit && !open && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpen(true)}
          data-testid="pd-day-edit-open"
        >
          <PenLine size={13} /> Edit attendance
        </Button>
      )}

      {data.canEdit && open && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3" data-testid="pd-day-edit-form">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <PenLine size={14} /> Edit attendance
            <span className="text-xs font-normal text-slate-500">{date}</span>
          </div>

          {noHod && (
            <p
              className="flex items-start gap-2 rounded-lg bg-red-50 p-2 text-xs text-red-800"
              data-testid="pd-day-edit-no-hod"
            >
              <UserX size={13} className="mt-0.5 shrink-0" /> {data.employee.name} has no Department Head who can
              approve this, so a change cannot be sent. Assign one in User Management first.
            </p>
          )}
          {data.future && (
            <p className="text-xs text-amber-800">This day has not come yet, so its attendance cannot be changed.</p>
          )}

          {GROUPS.map((g) => {
            const items = types.filter((t) => t.group === g.key);
            if (items.length === 0) return null;
            return (
              <div key={g.key} className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{g.title}</p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={g.title}>
                  {items.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      aria-pressed={typeKey === t.key}
                      data-testid={`pd-edit-type-${t.key}`}
                      onClick={() => choose(t)}
                      title={t.description}
                      className={cn(
                        "rounded-lg border px-2.5 py-1.5 text-left text-xs font-semibold transition-colors",
                        typeKey === t.key
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "bg-white text-slate-800 hover:bg-slate-50",
                      )}
                    >
                      {t.label}
                      <span
                        className={cn("ml-1.5 font-normal", typeKey === t.key ? "text-white/70" : "text-slate-500")}
                      >
                        {t.shiftChoices.length ? "0.25-1.00" : t.shifts}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {selected && (
            <div className="space-y-3">
              {selected.shiftChoices.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Worth</Label>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Shift value">
                    {selected.shiftChoices.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={shifts === c}
                        data-testid={`pd-edit-shifts-${c}`}
                        onClick={() => setShifts(c)}
                        className={cn(
                          "rounded-lg border px-2.5 py-1 text-xs font-semibold",
                          shifts === c ? "border-slate-900 bg-slate-900 text-white" : "bg-white hover:bg-slate-50",
                        )}
                      >
                        {c} shift
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selected.worked && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">First In</Label>
                    <Input
                      type="time"
                      value={timeText(firstIn)}
                      onChange={(e) => setFirstIn(e.target.value)}
                      data-testid="pd-edit-first-in"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Last Out</Label>
                    <Input
                      type="time"
                      value={timeText(lastOut)}
                      onChange={(e) => setLastOut(e.target.value)}
                      data-testid="pd-edit-last-out"
                    />
                  </div>
                  {(
                    [
                      [late, setLate, "Mark as Late", "Late", "pd-edit-late"],
                      [earlyOut, setEarlyOut, "Mark as Early Out", "Early Out", "pd-edit-early-out"],
                    ] as const
                  ).map(([on, set, off, onLabel, testId]) => (
                    <button
                      key={testId}
                      type="button"
                      aria-pressed={on}
                      data-testid={testId}
                      onClick={() => set(!on)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
                        on ? "border-red-200 bg-red-50 text-red-600" : "bg-white text-slate-600 hover:bg-slate-50",
                      )}
                    >
                      {on ? `⚠ ${onLabel} -click to clear` : off}
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="pd-edit-reason" className="text-xs">
                  Reason{" "}
                  <span className="font-normal text-slate-400">(required; the Department Head and HR read it)</span>
                </Label>
                <Textarea
                  id="pd-edit-reason"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. CCTV verified: the device missed the punch"
                  data-testid="pd-edit-reason"
                />
              </div>
            </div>
          )}

          <div className="rounded-lg bg-indigo-50/60 p-2.5 text-xs text-indigo-900">
            <p className="flex items-center gap-1.5 font-semibold">
              <ShieldCheck size={13} /> Both approvals are required
            </p>
            <p className="mt-1 text-slate-700">
              1. Department Head{" "}
              {data.hod ? <strong>{data.hod.name}</strong> : <strong className="text-red-600">not assigned</strong>}{" "}
              approves first. 2. HR approves second (Attendance &gt; Edit requests). Until both have approved, this day
              stays exactly as it is. The payroll is not recalculated by this: generate it again once the change is
              approved.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={!canSend}
              onClick={send}
              data-testid="pd-day-edit-send"
            >
              {submit.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              Send for approval
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {!selected && <span className="text-xs text-slate-500">Choose an attendance type.</span>}
            {selected && !reasonOk && <span className="text-xs text-slate-500">Give a reason to send it.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
