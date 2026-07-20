import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useEmployeeMonthlyAttendance, useAttendanceOverride, useAttendanceOverrideRequests,
  type FinalAttendanceDay,
} from "@/lib/api-client/custom-hooks";
import { useListEmployees } from "@/lib/api-client";
import {
  Search, User, RotateCcw, PenLine, X, Clock, Send, ShieldCheck, Hourglass, ShieldX, History,
} from "lucide-react";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_BADGE: Record<string, string> = {
  present:    "bg-green-100 text-green-800 border-green-200",
  half_shift: "bg-amber-100 text-amber-800 border-amber-200",
  absent:     "bg-red-100 text-red-800 border-red-200",
  on_leave:   "bg-purple-100 text-purple-800 border-purple-200",
  holiday:    "bg-gray-100 text-gray-600 border-gray-200",
};
const STATUS_LABEL: Record<string, string> = {
  present: "Present", half_shift: "Half Shift", absent: "Absent",
  on_leave: "On Leave", holiday: "Holiday",
};

type EditForm = {
  status: string;
  firstPunch: string;
  lastPunch: string;
  isLate: boolean;
  shiftType: "full" | "half";
  note: string;
};

/**
 * Employee attendance search: type an employee code → see the whole month
 * split into weeks. Clicking ✏ on a day opens an edit modal (same style as
 * Add Attendance) pre-filled with that employee + date; saving overwrites
 * the final attendance record used by payroll.
 */
export default function AttendanceSearchSection({
  employmentType,
}: {
  employmentType?: "staff" | "production";
}) {
  const { toast } = useToast();
  const now = new Date();

  const [input, setInput] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  // Edit modal state
  const [editDay, setEditDay] = useState<FinalAttendanceDay | null>(null);
  const [form, setForm] = useState<EditForm>({
    status: "present", firstPunch: "", lastPunch: "",
    isLate: false, shiftType: "full", note: "",
  });

  const { data: employees } = useListEmployees({ status: "active" });
  const { data, isLoading, isError } = useEmployeeMonthlyAttendance(searchCode, month, year);
  const overrideMutation = useAttendanceOverride();
  const { data: myRequests } = useAttendanceOverrideRequests(
    data ? { employeeId: data.employee.id } : undefined,
  );

  // Map date -> latest pending request, so the table can flag "Under Review"
  const pendingByDate = new Map(
    (myRequests ?? []).filter(r => r.status === "pending").map(r => [r.date, r]),
  );

  const suggestions = input.trim() && !searchCode
    ? (employees ?? [])
        .filter(e =>
          (!employmentType || e.employmentType === employmentType) &&
          (e.employeeCode.toLowerCase().includes(input.toLowerCase()) ||
           `${e.firstName} ${e.lastName}`.toLowerCase().includes(input.toLowerCase())))
        .slice(0, 6)
    : [];

  const runSearch = (code: string) => {
    setInput(code);
    setSearchCode(code);
  };

  const openEdit = (day: FinalAttendanceDay) => {
    setForm({
      status: day.status === "half_shift" ? "present" : day.status,
      firstPunch: day.firstPunch ?? "",
      lastPunch: day.lastPunch ?? "",
      isLate: day.isLate,
      shiftType: day.isHalfShift || day.status === "half_shift" ? "half" : "full",
      note: day.overrideNote ?? "",
    });
    setEditDay(day);
  };

  const saveEdit = async () => {
    if (!data || !editDay) return;
    const status = form.status === "present" && form.shiftType === "half"
      ? "half_shift"
      : form.status;
    try {
      const res = await overrideMutation.mutateAsync({
        employeeId: data.employee.id,
        date: editDay.date,
        status,
        isLate: form.isLate,
        isHalfShift: form.status === "present" ? form.shiftType === "half" : false,
        firstPunch: form.firstPunch || null,
        lastPunch: form.lastPunch || null,
        note: form.note || undefined,
      });
      if (res.pendingApproval) {
        toast({
          title: "Submitted for Department Head approval",
          description: `The change for ${editDay.date} is pending review. Attendance will only update once approved.`,
        });
      } else {
        toast({ title: `Attendance updated for ${editDay.date}` });
      }
      setEditDay(null);
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to submit request", variant: "destructive" });
    }
  };

  const revertDay = async (day: FinalAttendanceDay) => {
    if (!data) return;
    try {
      await overrideMutation.mutateAsync({
        employeeId: data.employee.id,
        date: day.date,
        reset: true,
      });
      toast({ title: "Reverted to automatic value" });
    } catch {
      toast({ title: "Failed to revert", variant: "destructive" });
    }
  };

  return (
    <Card className="border">
      <CardHeader className="pb-3 pt-4 px-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <Search size={14} className="text-gray-400" />
              Employee Attendance Search
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Search by employee code — view weekly attendance and submit manual edits.
              Edits require Department Head approval before they become final and reach payroll.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                className="pl-8 h-8 text-xs"
                placeholder="Employee code (e.g. 2580)…"
                value={input}
                onChange={e => { setInput(e.target.value); setSearchCode(""); }}
                onKeyDown={e => { if (e.key === "Enter" && input.trim()) runSearch(input.trim()); }}
              />
              {searchCode && (
                <button
                  onClick={() => { setInput(""); setSearchCode(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={12} />
                </button>
              )}
              {suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg overflow-hidden">
                  {suggestions.map(emp => (
                    <button
                      key={emp.id}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-xs"
                      onMouseDown={e => { e.preventDefault(); runSearch(emp.employeeCode); }}
                    >
                      <span className="font-mono text-gray-400 w-14 shrink-0">{emp.employeeCode}</span>
                      <span className="font-semibold truncate">{emp.firstName} {emp.lastName}</span>
                      {emp.departmentName && (
                        <span className="text-gray-400 ml-auto shrink-0">{emp.departmentName}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs px-3"
              disabled={!input.trim()}
              onClick={() => runSearch(input.trim())}
            >
              <Search size={12} /> Search
            </Button>
            <select
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              className="h-8 rounded-md border px-2 text-xs bg-background"
            >
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <Input
              type="number" min={2020} max={2035}
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="w-20 h-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-0">
        {!searchCode ? (
          <div className="py-10 text-center text-sm text-muted-foreground border-t">
            Enter an employee code above and click Search (or press Enter) to load their monthly attendance.
          </div>
        ) : isLoading ? (
          <div className="space-y-3 border-t pt-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : isError || !data ? (
          <div className="py-10 text-center text-sm text-red-500 border-t">
            No employee found with code "{searchCode}".
          </div>
        ) : (
          <div className="space-y-4 border-t pt-4">
            {/* Employee header + totals */}
            <div className="p-3 bg-gray-50 rounded-xl space-y-3">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                    {data.employee.photoUrl
                      ? <img src={data.employee.photoUrl} className="w-9 h-9 rounded-full object-cover" alt="" />
                      : <User size={15} className="text-gray-500" />}
                  </div>
                  <div>
                    <p className="font-black text-base leading-tight">{data.employee.name}</p>
                    <p className="text-[11px] text-gray-400 font-mono">
                      {data.employee.code}
                      {data.employee.department ? ` · ${data.employee.department}` : ""}
                      {data.employee.employmentType ? ` · ${data.employee.employmentType}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-auto flex-wrap">
                  {[
                    { label: "Working Days", value: data.summary.workingDays, cls: "text-gray-700" },
                    { label: "Present", value: data.summary.present, cls: "text-green-700" },
                    { label: "Half Shift", value: data.summary.halfShift, cls: "text-amber-700" },
                    { label: "Absent", value: data.summary.absent, cls: "text-red-600" },
                    { label: "Late", value: data.summary.late, cls: "text-orange-600" },
                    { label: "Leave", value: data.summary.onLeave, cls: "text-purple-600" },
                    { label: "Effective", value: data.summary.effectiveDays, cls: "text-indigo-700" },
                  ].map(s => (
                    <div key={s.label} className="text-center bg-white border rounded-lg px-3 py-1.5 min-w-[70px]">
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{s.label}</p>
                      <p className={`text-sm font-black ${s.cls}`}>{s.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Assigned shift + grace period — the sole source of late/half-shift detection */}
              {data.assignedShift ? (
                <div className="flex items-center gap-2 flex-wrap text-xs bg-white border rounded-lg px-3 py-2">
                  <ShieldCheck size={13} className="text-blue-500 shrink-0" />
                  <span className="text-gray-500">Assigned Shift:</span>
                  <strong className="text-gray-800">{data.assignedShift.name}</strong>
                  {data.assignedShift.startTime && data.assignedShift.endTime && (
                    <span className="font-mono text-gray-600">
                      {data.assignedShift.startTime}–{data.assignedShift.endTime}
                    </span>
                  )}
                  <span className="text-gray-300">|</span>
                  <span className="text-gray-500">Grace Period:</span>
                  <strong className="text-gray-800">{data.assignedShift.gracePeriodMinutes} min</strong>
                  <span className="text-gray-400">— all late/half-shift detection below uses only this shift's settings.</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2">
                  <ShieldCheck size={13} className="shrink-0" />
                  No shift assigned — late detection cannot run for this employee until a shift is assigned in Manage Shift.
                </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground -mt-1">
              Calculation mode: <strong className="uppercase">{data.attendanceMode}</strong>.
              Click <PenLine size={10} className="inline" /> on a day to propose a manual edit —
              it goes to the employee's Department Head for approval before it becomes final.
            </p>

            {/* Weekly tables */}
            {data.weeks.map(week => (
              <div key={week.week} className="rounded-xl border overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Week {week.week}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {week.days[0]?.date} → {week.days[week.days.length - 1]?.date}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        {["Date", "Day", "Status", "First IN", "Last OUT", "Shifts", "Late", "Half", "Source", ""].map(h => (
                          <th key={h} className="text-left px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {week.days.map(day => {
                        const pending = pendingByDate.get(day.date);
                        return (
                        <tr
                          key={day.date}
                          className={`border-b last:border-0 hover:bg-gray-50 ${
                            pending ? "bg-yellow-50/50" :
                            day.source === "manual" ? "bg-blue-50/40" :
                            day.status === "absent" ? "bg-red-50/30" :
                            day.status === "half_shift" ? "bg-amber-50/30" : ""
                          }`}
                        >
                          <td className="px-3 py-2 font-mono text-xs text-gray-700">{day.date}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{day.day}</td>
                          <td className="px-3 py-2">
                            <Badge className={`text-[10px] border ${STATUS_BADGE[day.status]}`}>
                              {STATUS_LABEL[day.status]}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-700">{day.firstPunch ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-700">{day.lastPunch ?? "—"}</td>
                          <td className="px-3 py-2 text-xs font-bold text-gray-800">{day.shiftsEarned}</td>
                          <td className="px-3 py-2 text-xs">
                            {day.isLate
                              ? <span className="text-red-600 font-semibold">Late</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {day.isHalfShift
                              ? <span className="text-amber-700 font-semibold">½</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-2 text-[10px]">
                            {pending ? (
                              <span className="inline-flex items-center gap-1 text-yellow-700 font-semibold">
                                <Hourglass size={10} /> Under Review
                              </span>
                            ) : day.source === "manual" ? (
                              <span className="inline-flex items-center gap-1 text-blue-600 font-semibold">
                                <ShieldCheck size={10} /> Approved{day.overrideBy ? ` · ${day.overrideBy}` : ""}
                              </span>
                            ) : (
                              <span className="text-gray-400">Auto</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                onClick={() => openEdit(day)}
                                disabled={!!pending}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                title={pending ? "A request is already under review for this day" : "Propose an edit"}
                              >
                                <PenLine size={13} />
                              </button>
                              {day.source === "manual" && !pending && (
                                <button
                                  onClick={() => revertDay(day)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                                  title="Revert to automatic value"
                                >
                                  <RotateCcw size={13} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {/* Submitted request tracking */}
            {(myRequests ?? []).length > 0 && (
              <div className="rounded-xl border overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-1.5">
                  <History size={12} className="text-gray-400" />
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Submitted Attendance Requests
                  </p>
                </div>
                <div className="divide-y max-h-56 overflow-y-auto">
                  {(myRequests ?? []).slice(0, 15).map(r => (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <span className="font-mono text-gray-500 w-24 shrink-0">{r.date}</span>
                      <span className="text-gray-600 flex-1 truncate">{r.reason || "—"}</span>
                      {r.status === "pending" && (
                        <span className="inline-flex items-center gap-1 text-yellow-700 font-semibold shrink-0">
                          <Hourglass size={11} /> Pending
                        </span>
                      )}
                      {r.status === "approved" && (
                        <span className="inline-flex items-center gap-1 text-green-700 font-semibold shrink-0">
                          <ShieldCheck size={11} /> Approved{r.reviewedBy ? ` · ${r.reviewedBy}` : ""}
                        </span>
                      )}
                      {r.status === "rejected" && (
                        <span className="inline-flex items-center gap-1 text-red-600 font-semibold shrink-0" title={r.reviewComment ?? ""}>
                          <ShieldX size={11} /> Rejected{r.reviewedBy ? ` · ${r.reviewedBy}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>

      {/* ── Edit / Overwrite Modal ── */}
      <Dialog open={!!editDay} onOpenChange={open => { if (!open) setEditDay(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Propose Attendance Change</DialogTitle>
          </DialogHeader>
          {editDay && data && (
            <div className="space-y-4 pt-1">
              {/* Who + when (locked) */}
              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                  <User size={15} className="text-gray-500" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-sm truncate">{data.employee.name}</p>
                  <p className="text-[11px] text-gray-400 font-mono">{data.employee.code}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="text-xs font-bold text-gray-700 font-mono">{editDay.date}</p>
                  <p className="text-[10px] text-gray-400">{editDay.day}</p>
                </div>
              </div>

              {/* Status */}
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {(["present", "absent", "on_leave", "holiday"] as const).map(st => (
                    <button
                      key={st}
                      onClick={() => setForm(f => ({ ...f, status: st }))}
                      className={`text-[11px] px-2 py-2 rounded-lg border font-semibold transition-colors ${
                        form.status === st
                          ? "bg-gray-900 text-white border-gray-900"
                          : "bg-white hover:bg-gray-50 text-gray-700"
                      }`}
                    >
                      {STATUS_LABEL[st]}
                    </button>
                  ))}
                </div>
              </div>

              {form.status === "present" && (
                <>
                  {/* Full / Half shift */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Shift Type</Label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        onClick={() => setForm(f => ({ ...f, shiftType: "full" }))}
                        className={`text-xs px-3 py-2 rounded-lg border font-semibold ${
                          form.shiftType === "full"
                            ? "bg-green-600 text-white border-green-600"
                            : "bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        Full Shift (1.00)
                      </button>
                      <button
                        onClick={() => setForm(f => ({ ...f, shiftType: "half" }))}
                        className={`text-xs px-3 py-2 rounded-lg border font-semibold ${
                          form.shiftType === "half"
                            ? "bg-amber-500 text-white border-amber-500"
                            : "bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        Half Shift (0.50)
                      </button>
                    </div>
                  </div>

                  {/* Punch times */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1">
                        <Clock size={11} /> First In
                      </Label>
                      <Input
                        type="time"
                        value={form.firstPunch}
                        onChange={e => setForm(f => ({ ...f, firstPunch: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1">
                        <Clock size={11} /> Last Out
                      </Label>
                      <Input
                        type="time"
                        value={form.lastPunch}
                        onChange={e => setForm(f => ({ ...f, lastPunch: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Late toggle */}
                  <button
                    onClick={() => setForm(f => ({ ...f, isLate: !f.isLate }))}
                    className={`w-full text-xs px-3 py-2 rounded-lg border font-semibold transition-colors ${
                      form.isLate
                        ? "bg-red-50 text-red-600 border-red-200"
                        : "bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {form.isLate ? "⚠ Marked as Late — click to clear" : "Mark as Late"}
                  </button>
                </>
              )}

              {/* Reason */}
              <div className="space-y-1.5">
                <Label className="text-xs">Reason for this change <span className="text-gray-400 font-normal">(shown to the Department Head)</span></Label>
                <Input
                  placeholder="e.g. CCTV verified — device missed punch"
                  value={form.note}
                  onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                />
              </div>

              <div className="flex gap-3 pt-1">
                <Button variant="outline" className="flex-1" onClick={() => setEditDay(null)}>
                  Cancel
                </Button>
                <Button
                  className="flex-1 gap-1.5"
                  onClick={saveEdit}
                  disabled={overrideMutation.isPending}
                >
                  <Send size={13} />
                  {overrideMutation.isPending ? "Submitting…" : "Submit for Approval"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground -mt-1">
                This does not change attendance immediately. The employee's Department Head
                reviews the request on the mobile app — only an approval writes it to the record
                used by payroll. Use the ↩ button in the table to instantly revert an already-approved edit.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
