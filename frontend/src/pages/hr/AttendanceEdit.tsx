import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Clock,
  Hourglass,
  Loader2,
  PenLine,
  Send,
  ShieldCheck,
  User,
  UserX,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { ApprovalTrail, WaitingChip } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceEditContext,
  useSubmitAttendanceEdit,
  type AttendanceEditType,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatusChip } from "./punch-view/parts";

const GROUPS: { key: AttendanceEditType["group"]; title: string; hint: string }[] = [
  { key: "Attendance", title: "Attendance", hint: "How much of the day was worked" },
  { key: "Compensation", title: "Compensation", hint: "A paid day given in return for extra work" },
  { key: "Other", title: "Absent, leave and holiday", hint: "A day not worked" },
];

const backTo = (type?: string) => (type === "production" ? "/hr/attendance/production" : "/hr/attendance/staff");

/** The page this one was opened from (the Attendance page with its search and filters in the address), when it is one of the
 *  Attendance pages; otherwise the staff / production Attendance page. */
const cameFrom = (search: string, fallback: string): string => {
  const back = new URLSearchParams(search).get("back") ?? "";
  return back.startsWith("/hr/attendance") && !back.startsWith("//") ? back : fallback;
};

/**
 * The Attendance Edit page (the pencil on a day): every attendance type in one place. Submitting does NOT change the day. It is
 * proposed to the employee's Department Head, who approves it first; then HR approves it second. Only after both have approved
 * is the attendance record written, and until then the day stays exactly as it is.
 */
export default function AttendanceEdit() {
  const params = useParams<{ employeeId: string; date: string }>();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const employeeId = Number(params.employeeId);
  const date = params.date ?? "";
  const ctx = useAttendanceEditContext(Number.isInteger(employeeId) ? employeeId : null, date);
  const submit = useSubmitAttendanceEdit();

  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [shifts, setShifts] = useState("1.00");
  const [firstIn, setFirstIn] = useState("");
  const [lastOut, setLastOut] = useState("");
  const [late, setLate] = useState(false);
  const [earlyOut, setEarlyOut] = useState(false);
  const [note, setNote] = useState("");

  const data = ctx.data;
  const types = useMemo(() => data?.types ?? [], [data]);
  const selected = useMemo(() => types.find((t) => t.key === typeKey) ?? null, [types, typeKey]);
  const day = data?.day;

  // start from the day as it stands: its times and marks (the type is chosen by the person)
  useEffect(() => {
    if (!day) return;
    setFirstIn(day.firstPunch ?? "");
    setLastOut(day.lastPunch ?? "");
    setLate(day.isLate);
    setEarlyOut(!!day.earlyLeave);
  }, [day?.date, day?.firstPunch, day?.lastPunch, day?.isLate, day?.earlyLeave]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (t: AttendanceEditType) => {
    setTypeKey(t.key);
    setShifts(t.shifts);
  };

  const returnTo = cameFrom(search, backTo(data?.employee.employmentType));
  const pending = (data?.requests ?? []).find((r) => r.status === "pending");
  const noHod = !!data && !data.hod;
  const future = !!data?.future;
  const reasonOk = note.trim().length >= 3;
  const canSend = !!data && !!selected && reasonOk && !noHod && !future && !submit.isPending;

  const send = async () => {
    if (!data || !selected) return;
    try {
      await submit.mutateAsync({
        employeeId: data.employee.id,
        date: data.date,
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
        description: `${selected.label} for ${data.employee.name} on ${data.date} goes to ${data.hod?.name ?? "the Department Head"} first, then to HR. The attendance does not change until both approve.`,
      });
      navigate(returnTo);
    } catch (e) {
      toast({
        title: "Could not send",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <HrLayout>
      <div className="mx-auto max-w-4xl space-y-5 pb-10" data-testid="attendance-edit-page">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(returnTo)} aria-label="Back to Attendance">
            <ArrowLeft size={18} />
          </Button>
          <div className="rounded-2xl bg-indigo-600 p-2.5 text-white shadow-sm">
            <PenLine size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-black text-gray-900">Edit Attendance</h2>
            <p className="text-sm text-muted-foreground">
              Choose what the day should be. The Department Head approves it first, then HR. Nothing changes until both
              approve.
            </p>
          </div>
          <Link href="/hr/requests?kind=attendance_correction" className="text-xs font-semibold text-indigo-700 hover:underline">
            Edit requests
          </Link>
        </div>

        {ctx.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        ) : ctx.isError || !data ? (
          <Card className="rounded-2xl ring-1 ring-red-200">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700">
              <span>The day could not be loaded: {(ctx.error as Error)?.message ?? "no answer"}.</span>
              <Button size="sm" variant="outline" onClick={() => ctx.refetch()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* ── who, when, and the day as it is now ── */}
            <Card className="rounded-2xl" data-testid="edit-day-card">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-gray-500">
                    <User size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-bold text-gray-900">{data.employee.name}</p>
                    <p className="truncate text-xs text-gray-500">
                      <span className="font-mono">{data.employee.code}</span>
                      {data.employee.department ? ` · ${data.employee.department}` : ""}
                      {data.employee.designation ? ` · ${data.employee.designation}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="flex items-center justify-end gap-1.5 font-mono text-sm font-bold text-gray-800">
                      <CalendarDays size={14} className="text-gray-400" /> {data.date}
                    </p>
                    <p className="text-[11px] text-gray-400">{data.day.day}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs text-gray-600">
                  <span className="font-semibold text-gray-500">Now</span>
                  <StatusChip status={data.day.status} source={data.day.source} />
                  <span>{Number(data.day.shiftsEarned).toFixed(2)} shift</span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} /> {data.day.firstPunch ?? "—"} to {data.day.lastPunch ?? "—"}
                  </span>
                  {data.day.isLate && <span className="font-semibold text-red-600">Late</span>}
                  {data.day.earlyLeave && <span className="font-semibold text-red-600">Early out</span>}
                </div>
              </CardContent>
            </Card>

            {noHod && (
              <div
                className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
                data-testid="edit-no-hod"
              >
                <UserX size={16} className="mt-0.5 shrink-0" />
                <p>
                  {data.employee.name} has no Department Head who can approve this, so a change cannot be sent. Assign
                  one in{" "}
                  <Link href="/hr/user-management" className="font-semibold underline">
                    User Management
                  </Link>{" "}
                  first.
                </p>
              </div>
            )}
            {future && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p>This day has not come yet, so its attendance cannot be changed.</p>
              </div>
            )}
            {pending && (
              <div
                className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900"
                data-testid="edit-pending"
              >
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  <Hourglass size={15} /> A change for this day is already waiting (
                  {pending.typeLabel ?? "attendance edit"})
                  <WaitingChip approval={pending.approval} />
                </p>
                {pending.approval && <ApprovalTrail approval={pending.approval} submittedBy="HR" />}
                <p className="text-xs">
                  Sending a new change replaces it. The day stays as it is until both approvals are in.
                </p>
              </div>
            )}

            {/* ── the attendance types ── */}
            {GROUPS.map((g) => {
              const items = types.filter((t) => t.group === g.key);
              if (items.length === 0) return null;
              return (
                <section key={g.key} className="space-y-2" aria-label={g.title}>
                  <div>
                    <h3 className="text-sm font-bold text-gray-900">{g.title}</h3>
                    <p className="text-[11px] text-gray-500">{g.hint}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        aria-pressed={typeKey === t.key}
                        data-testid={`edit-type-${t.key}`}
                        onClick={() => choose(t)}
                        className={cn(
                          "rounded-xl border px-3 py-2.5 text-left transition-colors",
                          typeKey === t.key
                            ? "border-gray-900 bg-gray-900 text-white shadow-sm"
                            : "bg-white text-gray-800 hover:bg-gray-50",
                        )}
                      >
                        <span className="block text-sm font-bold">{t.label}</span>
                        <span
                          className={cn("block text-[11px]", typeKey === t.key ? "text-white/70" : "text-gray-500")}
                        >
                          {t.shiftChoices.length ? "0.25 to 1.00 shift" : `${t.shifts} shift`}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}

            {/* ── details of the chosen type ── */}
            {selected && (
              <Card className="rounded-2xl" data-testid="edit-details">
                <CardContent className="space-y-4 p-4">
                  <div>
                    <h3 className="text-sm font-bold text-gray-900">{selected.label}</h3>
                    <p className="text-xs text-gray-500">{selected.description}</p>
                  </div>

                  {selected.shiftChoices.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Worth</Label>
                      <div className="flex flex-wrap gap-2" role="group" aria-label="Shift value">
                        {selected.shiftChoices.map((c) => (
                          <button
                            key={c}
                            type="button"
                            aria-pressed={shifts === c}
                            data-testid={`edit-shifts-${c}`}
                            onClick={() => setShifts(c)}
                            className={cn(
                              "rounded-lg border px-3 py-1.5 text-xs font-semibold",
                              shifts === c ? "border-gray-900 bg-gray-900 text-white" : "bg-white hover:bg-gray-50",
                            )}
                          >
                            {c} shift
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selected.worked && (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="flex items-center gap-1 text-xs">
                            <Clock size={11} /> First In
                          </Label>
                          <Input
                            type="time"
                            value={firstIn}
                            onChange={(e) => setFirstIn(e.target.value)}
                            data-testid="edit-first-in"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="flex items-center gap-1 text-xs">
                            <Clock size={11} /> Last Out
                          </Label>
                          <Input
                            type="time"
                            value={lastOut}
                            onChange={(e) => setLastOut(e.target.value)}
                            data-testid="edit-last-out"
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(
                          [
                            [late, setLate, "Mark as Late", "Late", "edit-late"],
                            [earlyOut, setEarlyOut, "Mark as Early Out", "Early Out", "edit-early-out"],
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
                              on ? "border-red-200 bg-red-50 text-red-600" : "bg-white text-gray-600 hover:bg-gray-50",
                            )}
                          >
                            {on ? `⚠ ${onLabel} -click to clear` : off}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="edit-reason" className="text-xs">
                      Reason{" "}
                      <span className="font-normal text-gray-400">(required; the Department Head and HR read it)</span>
                    </Label>
                    <Textarea
                      id="edit-reason"
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. CCTV verified: the device missed the punch"
                      data-testid="edit-reason"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── the approval path, and send ── */}
            <Card className="rounded-2xl border-indigo-100 bg-indigo-50/40" data-testid="edit-approval-path">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center gap-2 text-sm font-bold text-indigo-900">
                  <ShieldCheck size={16} /> Approval: both are required
                </div>
                <ol className="space-y-1.5 text-sm text-gray-700">
                  <li>
                    <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
                      1
                    </span>
                    Department Head
                    {data.hod ? (
                      <strong> {data.hod.name}</strong>
                    ) : (
                      <strong className="text-red-600"> not assigned</strong>
                    )}{" "}
                    approves first.
                  </li>
                  <li>
                    <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
                      2
                    </span>
                    HR approves second (Requests &gt;{" "}
                    <Link href="/hr/requests?kind=attendance_correction" className="font-semibold text-indigo-700 underline">
                      Edit requests
                    </Link>
                    ).
                  </li>
                </ol>
                <p className="text-xs text-gray-500">
                  Until both have approved, this day stays exactly as it is now: it is not marked Present.
                </p>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Button onClick={send} disabled={!canSend} className="gap-1.5" data-testid="edit-send">
                    {submit.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Send for approval
                  </Button>
                  <Button variant="ghost" onClick={() => navigate(returnTo)}>
                    Cancel
                  </Button>
                  {!selected && <span className="text-xs text-gray-500">Choose an attendance type above.</span>}
                  {selected && !reasonOk && <span className="text-xs text-gray-500">Give a reason to send it.</span>}
                </div>
              </CardContent>
            </Card>

            {/* ── earlier requests for this day ── */}
            {data.requests.length > 0 && (
              <Card className="rounded-2xl" data-testid="edit-history">
                <CardContent className="space-y-3 p-4">
                  <h3 className="text-sm font-bold text-gray-900">Changes proposed for this day</h3>
                  <div className="divide-y">
                    {data.requests.map((r) => (
                      <div key={r.id} className="flex flex-wrap items-start gap-3 py-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-gray-800">{r.typeLabel ?? "Attendance edit"}</p>
                          <p className="text-gray-500">{r.reason || "—"}</p>
                          <p className="text-[10px] text-gray-400">
                            by {r.requestedBy ?? "HR"}
                            {r.createdAt ? ` · ${new Date(r.createdAt).toLocaleString()}` : ""}
                          </p>
                        </div>
                        {r.approval && <ApprovalTrail approval={r.approval} submittedBy="HR" />}
                        <span
                          className={cn(
                            "rounded-md px-2 py-0.5 text-[10px] font-bold",
                            r.status === "approved" && "bg-green-50 text-green-700",
                            r.status === "rejected" && "bg-red-50 text-red-700",
                            r.status === "pending" && "bg-amber-50 text-amber-700",
                          )}
                        >
                          {r.status === "pending"
                            ? "Waiting"
                            : r.status === "approved"
                              ? "Approved by both"
                              : "Rejected"}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </HrLayout>
  );
}
