import { useEffect, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAttendanceSearch, type AttendanceSearchPunch } from "@/lib/api-client/custom-hooks";
import { Search, UserSearch, Clock, Sun, ArrowRightLeft } from "lucide-react";

const todayStr = () => new Date().toISOString().slice(0, 10);

const SOURCE_STYLES: Record<string, string> = {
  Biometric: "bg-blue-50 text-blue-700",
  "Geo Punch": "bg-teal-50 text-teal-700",
  "On-Duty": "bg-amber-50 text-amber-700",
  "HR Entry": "bg-purple-50 text-purple-700",
};

function sourceStyle(label: string) {
  return SOURCE_STYLES[label] ?? "bg-gray-100 text-gray-600";
}

function PunchSlot({ slot, index }: { slot: AttendanceSearchPunch; index: number }) {
  if (!slot) {
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-gray-50 border border-dashed border-gray-200 min-w-[110px]">
        <span className="text-[10px] font-bold text-gray-300">PUNCH {index + 1}</span>
        <span className="text-xs text-gray-300">—</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-white border min-w-[110px]">
      <span className="text-[10px] font-bold text-gray-400">PUNCH {index + 1} · {slot.type === "IN" ? "Check-In" : "Check-Out"}</span>
      <span className="text-sm font-bold text-gray-900 tabular-nums">{slot.time.slice(0, 5)}</span>
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${sourceStyle(slot.sourceLabel)}`}>{slot.sourceLabel}</span>
    </div>
  );
}

export default function AttendancePunchSearch() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState(todayStr());

  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data, isLoading, isFetching } = useAttendanceSearch(query, date);

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Attendance Search</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Look up any employee by Employee Code or Name to see their shift and all four punch timings for a day, with the source of each punch.
          </p>
        </div>

        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[240px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                className="pl-9 h-10 text-sm"
                placeholder="Search by Employee Code or Name…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoFocus
              />
            </div>
            <Input
              type="date"
              className="h-10 text-sm w-auto"
              value={date}
              max={todayStr()}
              onChange={(e) => setDate(e.target.value)}
            />
          </CardContent>
        </Card>

        {!query.trim() ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <UserSearch size={36} className="text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-500">Start typing an Employee Code or Name to search.</p>
            </CardContent>
          </Card>
        ) : isLoading || isFetching ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : (data?.results ?? []).length === 0 ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <UserSearch size={36} className="text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No employees match "{query}".</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {(data?.results ?? []).map((emp) => (
              <Card key={emp.employeeId} className="border-0 shadow-sm">
                <CardContent className="p-4 flex flex-wrap items-start gap-4">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-gray-900">{emp.employeeName}</p>
                      <span className="text-[11px] font-mono text-gray-400">({emp.employeeCode})</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{emp.department ?? "—"} · {emp.designation ?? "—"}</p>
                    {emp.shift && (
                      <p className="text-xs text-gray-500 mt-1.5 flex items-center gap-1.5">
                        <Sun size={11} className="text-amber-500" />
                        {emp.shift.name}
                        {emp.shift.startTime && emp.shift.endTime && (
                          <span className="text-gray-400 flex items-center gap-1">
                            <ArrowRightLeft size={10} /> {emp.shift.startTime}–{emp.shift.endTime}
                          </span>
                        )}
                      </p>
                    )}
                    <p className="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1">
                      <Clock size={10} /> {emp.totalPunches} of 4 punches recorded on {date}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {emp.punches.map((p, i) => <PunchSlot key={i} slot={p} index={i} />)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </HrLayout>
  );
}
