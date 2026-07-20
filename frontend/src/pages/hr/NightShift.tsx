import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useListEmployees } from "@/lib/api-client";
import {
  useNightShiftDashboard, useNightShiftRecompute,
  useNightShiftRules, useSaveNightShiftRule, useDeleteNightShiftRule,
  type NightShiftRuleItem,
} from "@/lib/api-client/custom-hooks";
import {
  MoonStar, RefreshCw, CheckCircle2, AlertTriangle, Hourglass, UserX,
  Clock, Trash2, Plus, Info, Settings2,
} from "lucide-react";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  reported_within: { label: "Reported ✓",     cls: "bg-green-100 text-green-800 border-green-200" },
  reported_late:   { label: "Reported Late",  cls: "bg-red-100 text-red-800 border-red-200" },
  waiting:         { label: "Waiting",        cls: "bg-amber-100 text-amber-800 border-amber-200" },
  window_expired:  { label: "Window Expired", cls: "bg-orange-100 text-orange-800 border-orange-200" },
  no_report:       { label: "Did Not Report", cls: "bg-gray-100 text-gray-600 border-gray-200" },
};

export default function NightShift() {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);

  const [viewMode, setViewMode] = useState<"day" | "month">("day");
  const [date, setDate] = useState(today);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [empFilter, setEmpFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  const { data: employees } = useListEmployees({ status: "active" });
  const { data: departments } = useListDepartments();

  const dashParams = viewMode === "day"
    ? { date, employeeId: empFilter ? Number(empFilter) : undefined, departmentId: deptFilter ? Number(deptFilter) : undefined }
    : { month, year, employeeId: empFilter ? Number(empFilter) : undefined, departmentId: deptFilter ? Number(deptFilter) : undefined };

  const { data, isLoading, refetch } = useNightShiftDashboard(dashParams);
  const recompute = useNightShiftRecompute();

  // Rules editor
  const { data: rules } = useNightShiftRules();
  const saveRule = useSaveNightShiftRule();
  const deleteRule = useDeleteNightShiftRule();
  const [showRules, setShowRules] = useState(false);
  const [editRule, setEditRule] = useState<Partial<NightShiftRuleItem> | null>(null);

  const handleRecompute = async () => {
    try {
      const res = await recompute.mutateAsync(
        viewMode === "day" ? { date } : { month, year },
      );
      toast({ title: `Detection complete — ${res.detected} night worker(s) found` });
      refetch();
    } catch {
      toast({ title: "Recompute failed", variant: "destructive" });
    }
  };

  const persistRule = async () => {
    if (!editRule?.name || !editRule?.workedUntil || !editRule?.allowedFirstPunch) {
      toast({ title: "Name, worked-until and allowed-first-punch are required", variant: "destructive" });
      return;
    }
    try {
      await saveRule.mutateAsync(editRule);
      toast({ title: editRule.id ? "Rule updated" : "Rule added" });
      setEditRule(null);
    } catch {
      toast({ title: "Failed to save rule", variant: "destructive" });
    }
  };

  const fmtRemaining = (mins?: number | null) => {
    if (mins == null) return null;
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Night Shift Relaxation</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Late-night workers get extra reporting time next morning instead of overtime pay —
              no Late or Half-Shift marks within the allowed window
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" className="gap-2 h-9" onClick={() => setShowRules(v => !v)}>
              <Settings2 size={14} /> Rules
            </Button>
            <Button
              variant="outline"
              className="gap-2 h-9 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
              onClick={handleRecompute}
              disabled={recompute.isPending}
            >
              <RefreshCw size={14} className={recompute.isPending ? "animate-spin" : ""} />
              {recompute.isPending ? "Detecting…" : "Re-detect"}
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <PillTabs
            items={[
              { value: "day", label: "Day View" },
              { value: "month", label: "Month View" },
            ]}
            value={viewMode}
            onChange={(v) => setViewMode(v as "day" | "month")}
            baseColor="#4f46e5"
          />
          {viewMode === "day" ? (
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-8 text-xs w-36" />
          ) : (
            <>
              <select value={month} onChange={e => setMonth(Number(e.target.value))} className="h-8 rounded-md border px-2 text-xs bg-background">
                {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
              <Input type="number" min={2020} max={2035} value={year} onChange={e => setYear(Number(e.target.value))} className="w-20 h-8 text-xs" />
            </>
          )}
          <select value={empFilter} onChange={e => setEmpFilter(e.target.value)} className="h-8 rounded-md border px-2 text-xs bg-background max-w-[190px]">
            <option value="">— All employees —</option>
            {(employees ?? []).map(e => (
              <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>
            ))}
          </select>
          <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} className="h-8 rounded-md border px-2 text-xs bg-background max-w-[170px]">
            <option value="">— All departments —</option>
            {(departments ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Reported In Time", value: data?.summary.reportedWithin ?? "—", icon: CheckCircle2, cls: "text-green-700", iconCls: "bg-green-600" },
            { label: "Reported Late", value: data?.summary.reportedLate ?? "—", icon: AlertTriangle, cls: "text-red-600", iconCls: "bg-red-500" },
            { label: "Still Waiting", value: data?.summary.waiting ?? "—", icon: Hourglass, cls: "text-amber-700", iconCls: "bg-amber-500" },
            { label: "No Report", value: data?.summary.noReport ?? "—", icon: UserX, cls: "text-gray-700", iconCls: "bg-gray-600" },
          ].map(({ label, value, icon: Icon, cls, iconCls }) => (
            <Card key={label} className="border">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
                  <div className={`p-1.5 rounded-lg ${iconCls}`}>
                    <Icon size={14} className="text-white" />
                  </div>
                </div>
                <p className={`text-3xl font-black leading-none ${cls}`}>{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Rules editor */}
        {showRules && (
          <Card className="border-2 border-indigo-100">
            <CardHeader className="pb-3 pt-4 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Settings2 size={14} className="text-indigo-500" /> Relaxation Rules
                </CardTitle>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs"
                  onClick={() => setEditRule({ crossesMidnight: false, isActive: true, order: (rules?.length ?? 0) + 1 })}>
                  <Plus size={11} /> Add Rule
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Matched by punch-out time, tightest bracket first. "Crosses midnight" marks early-morning
                out-times (e.g. 02:30) as belonging to the previous night.
              </p>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-2">
              {(rules ?? []).map(r => (
                <div key={r.id} className={`flex items-center gap-3 p-2.5 border rounded-xl text-sm ${!r.isActive ? "opacity-50" : ""}`}>
                  <MoonStar size={14} className="text-indigo-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-800">{r.name}</p>
                    <p className="text-[11px] text-gray-400">
                      Worked until <strong className="font-mono">{r.workedUntil}</strong>
                      {r.crossesMidnight ? " (next day)" : ""} → allowed to report until{" "}
                      <strong className="font-mono">{r.allowedFirstPunch}</strong>
                    </p>
                  </div>
                  <button onClick={() => setEditRule(r)} className="text-xs text-blue-600 font-semibold hover:underline shrink-0">Edit</button>
                  <button
                    onClick={async () => { await deleteRule.mutateAsync(r.id); toast({ title: "Rule deleted" }); }}
                    className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}

              {editRule && (
                <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl space-y-3">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Rule Name</Label>
                      <Input className="h-8 text-xs" value={editRule.name ?? ""} onChange={e => setEditRule(r => ({ ...r, name: e.target.value }))} placeholder="e.g. Until 3:00 AM" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Worked Until</Label>
                      <Input type="time" className="h-8 text-xs" value={editRule.workedUntil ?? ""} onChange={e => setEditRule(r => ({ ...r, workedUntil: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Allowed First Punch</Label>
                      <Input type="time" className="h-8 text-xs" value={editRule.allowedFirstPunch ?? ""} onChange={e => setEditRule(r => ({ ...r, allowedFirstPunch: e.target.value }))} />
                    </div>
                    <div className="flex items-end gap-3 pb-1">
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input type="checkbox" checked={!!editRule.crossesMidnight} onChange={e => setEditRule(r => ({ ...r, crossesMidnight: e.target.checked }))} />
                        Crosses midnight
                      </label>
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input type="checkbox" checked={editRule.isActive !== false} onChange={e => setEditRule(r => ({ ...r, isActive: e.target.checked }))} />
                        Active
                      </label>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-xs" onClick={persistRule} disabled={saveRule.isPending}>
                      {saveRule.isPending ? "Saving…" : editRule.id ? "Update Rule" : "Add Rule"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditRule(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Info banner */}
        <div className="flex items-start gap-2 p-3 bg-indigo-50 border border-indigo-100 rounded-xl text-xs text-indigo-700">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Detection is automatic from biometric punches (last punch at/after <strong>8:00 PM</strong>, including
            checkouts after midnight). Attendance, late detection, half-shift detection and payroll all consult
            this table automatically — an employee arriving within their allowed window still earns{" "}
            <strong>1 full shift</strong> with no late mark.
          </span>
        </div>

        {/* Records table */}
        <Card className="border">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <MoonStar size={14} className="text-indigo-500" />
              Night Workers {viewMode === "day" ? `— relaxation applies ${date}` : `— ${MONTH_NAMES[month - 1]} ${year}`}
              {data && <span className="text-xs font-normal text-gray-400">({data.count} records)</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : (data?.records ?? []).length === 0 ? (
              <div className="py-14 text-center">
                <MoonStar size={32} className="text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No night-shift workers found for this period.</p>
                <p className="text-xs text-muted-foreground mt-1">Click "Re-detect" to scan punches again.</p>
              </div>
            ) : (
              <div className="overflow-x-auto border-t">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {["Employee", "Night Of", "Punched Out", "Rule", "Allowed Until", "Reported At", "Status"].map(h => (
                        <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.records ?? []).map(r => {
                      const cfg = STATUS_CFG[r.status] ?? STATUS_CFG.no_report;
                      return (
                        <tr key={r.id} className={`border-b hover:bg-gray-50 ${r.status === "reported_late" ? "bg-red-50/30" : r.status === "waiting" ? "bg-amber-50/30" : ""}`}>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-gray-900">{r.employeeName}</p>
                            <p className="text-[11px] font-mono text-gray-400">
                              {r.employeeCode}{r.department ? ` · ${r.department}` : ""}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-700">{r.nightDate}</td>
                          <td className="px-4 py-3">
                            <span className="font-mono font-bold text-indigo-700">{r.lastPunchOut}</span>
                            {r.crossedMidnight && (
                              <span className="ml-1.5 text-[9px] font-semibold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full">next day</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{r.ruleName ?? "—"}</td>
                          <td className="px-4 py-3 font-mono text-sm font-bold text-gray-800">{r.allowedUntil}</td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {r.reportedAt ?? <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3">
                            <Badge className={`text-[10px] border ${cfg.cls}`}>{cfg.label}</Badge>
                            {r.status === "waiting" && r.remainingMinutes != null && (
                              <p className="text-[10px] text-amber-600 font-semibold mt-0.5 flex items-center gap-0.5">
                                <Clock size={9} /> {fmtRemaining(r.remainingMinutes)}
                              </p>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}
