import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, AlertTriangle, Info } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";

export default function LateDetectionTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData } = usePayrollSettings();

  // Late Detection tab split into its two independent policies.
  const [lateDetectionSubTab, setLateDetectionSubTab] = useState<"late" | "permission">("late");

  // ── Late Detection policy -loaded from DB ─────────────────────────────
  const [lateFreeAllowance, setLateFreeAllowance] = useState(3);

  const [lateSlabs, setLateSlabs] = useState<{ fromLates: number; deductionShifts: number }[]>([]);

  // Without Permission -a separate pool from Late Attendance above.
  const [wpFreeAllowance, setWpFreeAllowance] = useState(0);

  const [wpSlabs, setWpSlabs] = useState<{ fromLates: number; deductionShifts: number }[]>([]);

  // Daily/weekly caps on the auto-detected Permission zone.
  const [maxPermissionsPerDay, setMaxPermissionsPerDay] = useState(1);

  const [maxPermissionsPerWeek, setMaxPermissionsPerWeek] = useState(2);

  useEffect(() => {
    if (!payrollSettingsData) return;
    setLateFreeAllowance(payrollSettingsData.lateFreeAllowance ?? 3);
    setLateSlabs(payrollSettingsData.lateDeductionSlabs ?? []);
    setWpFreeAllowance(payrollSettingsData.withoutPermissionFreeAllowance ?? 0);
    setWpSlabs(payrollSettingsData.withoutPermissionDeductionSlabs ?? []);
    setMaxPermissionsPerDay(payrollSettingsData.maxPermissionsPerDay ?? 1);
    setMaxPermissionsPerWeek(payrollSettingsData.maxPermissionsPerWeek ?? 2);
  }, [payrollSettingsData]);

  const saveLateDetection = async () => {
    // Thresholds must be unique and ordered before saving -the backend
    // re-sorts and de-dupes too, but catching it here gives a clear message
    // instead of a silently-merged row.
    const seen = new Set<number>();
    for (const s of lateSlabs) {
      if (
        !Number.isFinite(s.fromLates) ||
        s.fromLates < 0 ||
        !Number.isFinite(s.deductionShifts) ||
        s.deductionShifts < 0
      ) {
        toast({ title: "Every slab needs a non-negative late count and deduction", variant: "destructive" });
        return;
      }
      if (seen.has(s.fromLates)) {
        toast({ title: `Duplicate threshold: ${s.fromLates} lates appears more than once`, variant: "destructive" });
        return;
      }
      seen.add(s.fromLates);
    }
    try {
      await updatePayrollSettings.mutateAsync({
        lateFreeAllowance,
        lateDeductionSlabs: [...lateSlabs].sort((a, b) => a.fromLates - b.fromLates),
      } as never);
      toast({
        title: "Late Detection policy saved",
        description: "Applies the next time payroll is generated. Already-generated payroll is untouched.",
      });
    } catch {
      toast({ title: "Failed to save Late Detection policy", variant: "destructive" });
    }
  };

  // Mirrors backend late_shift_deduction(): highest matching threshold wins,
  // last row holds beyond the table.
  const previewLateDeduction = (billable: number) => {
    const sorted = [...lateSlabs].sort((a, b) => a.fromLates - b.fromLates);
    let d = 0;
    for (const s of sorted) {
      if (billable >= s.fromLates) d = s.deductionShifts;
      else break;
    }
    return d;
  };

  const saveWithoutPermission = async () => {
    const seen = new Set<number>();
    for (const s of wpSlabs) {
      if (
        !Number.isFinite(s.fromLates) ||
        s.fromLates < 0 ||
        !Number.isFinite(s.deductionShifts) ||
        s.deductionShifts < 0
      ) {
        toast({ title: "Every slab needs a non-negative count and deduction", variant: "destructive" });
        return;
      }
      if (seen.has(s.fromLates)) {
        toast({ title: `Duplicate threshold: ${s.fromLates} appears more than once`, variant: "destructive" });
        return;
      }
      seen.add(s.fromLates);
    }
    try {
      await updatePayrollSettings.mutateAsync({
        withoutPermissionFreeAllowance: wpFreeAllowance,
        withoutPermissionDeductionSlabs: [...wpSlabs].sort((a, b) => a.fromLates - b.fromLates),
        maxPermissionsPerDay,
        maxPermissionsPerWeek,
      } as never);
      toast({
        title: "Without Permission policy saved",
        description: "Applies the next time payroll is generated. Already-generated payroll is untouched.",
      });
    } catch {
      toast({ title: "Failed to save Without Permission policy", variant: "destructive" });
    }
  };

  const previewWpDeduction = (billable: number) => {
    const sorted = [...wpSlabs].sort((a, b) => a.fromLates - b.fromLates);
    let d = 0;
    for (const s of sorted) {
      if (billable >= s.fromLates) d = s.deductionShifts;
      else break;
    }
    return d;
  };

  return (
    <>
      <PillTabs
        items={[
          { value: "late", label: "Late Detection", icon: <AlertTriangle size={13} /> },
          { value: "permission", label: "Permission Policy", icon: <AlertTriangle size={13} /> },
        ]}
        value={lateDetectionSubTab}
        onChange={(v) => setLateDetectionSubTab(v as "late" | "permission")}
        baseColor="#0f172a"
        pillBg="#f1f5f9"
      />
      {lateDetectionSubTab === "late" && (
        <>
          <Card className="border-0 shadow-sm bg-slate-50/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info size={15} className="text-slate-500" /> How Late Detection Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-600 leading-relaxed space-y-2">
              <p>
                Every month, an employee's <strong>late arrivals</strong> and their{" "}
                <strong>approved Permission requests</strong> are added into a single shared pool. The first few are
                free (the allowance below). Everything past that is "billable", and the slab table decides how many
                shifts get cut.
              </p>
              <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                Changing these values affects <strong>future</strong> payroll generation only. Payroll already generated
                for a past month keeps whatever it was calculated with -regenerate that month deliberately if you want
                it repriced.
              </p>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <AlertTriangle size={15} className="text-orange-500" /> Late Detection Policy
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5 max-w-md">
                <Label className="text-xs">Free Allowance -lates + permissions allowed per month</Label>
                <p className="text-[11px] text-gray-500 -mt-1">
                  No deduction at all until an employee exceeds this many in a calendar month. This is also the monthly
                  Permission limit, since both draw on the same pool.
                </p>
                <Input
                  type="number"
                  min={0}
                  className="max-w-[140px]"
                  value={lateFreeAllowance}
                  onChange={(e) => setLateFreeAllowance(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <Label className="text-xs">Deduction Slabs</Label>
                    <p className="text-[11px] text-gray-500">
                      Once the billable count reaches a threshold, that row's deduction applies. The highest matching
                      row wins, and the last row holds for anything beyond it.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() =>
                      setLateSlabs((s) => [
                        ...s,
                        {
                          fromLates: (s.length ? Math.max(...s.map((r) => r.fromLates)) : 0) + 3,
                          deductionShifts: 0.25,
                        },
                      ])
                    }
                  >
                    <Plus size={13} /> Add Slab
                  </Button>
                </div>

                {lateSlabs.length === 0 ? (
                  <div className="text-xs text-gray-500 border border-dashed rounded-lg p-4 text-center">
                    No slabs -late arrivals currently cost nothing. Add a slab to start deducting.
                  </div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 text-left text-xs text-slate-600">
                          <th className="px-3 py-2 font-semibold">From this many billable lates</th>
                          <th className="px-3 py-2 font-semibold">Deduct this many shifts</th>
                          <th className="px-3 py-2 font-semibold text-right">Remove</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {lateSlabs.map((slab, i) => (
                          <tr key={i} className="hover:bg-slate-50/60">
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                className="h-8 max-w-[110px]"
                                value={slab.fromLates}
                                onChange={(e) =>
                                  setLateSlabs((s) =>
                                    s.map((r, j) =>
                                      j === i ? { ...r, fromLates: Math.max(0, Number(e.target.value) || 0) } : r,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                step={0.25}
                                className="h-8 max-w-[110px]"
                                value={slab.deductionShifts}
                                onChange={(e) =>
                                  setLateSlabs((s) =>
                                    s.map((r, j) =>
                                      j === i ? { ...r, deductionShifts: Math.max(0, Number(e.target.value) || 0) } : r,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 text-rose-600 hover:text-rose-800"
                                onClick={() => setLateSlabs((s) => s.filter((_, j) => j !== i))}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Worked example so HR can see the policy's real effect before saving */}
              <div className="p-3 bg-blue-50/60 border border-blue-100 rounded-lg">
                <p className="text-xs font-bold text-blue-900 mb-2">Worked example -with the values above</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  {[0, 2, 4, 6, 9, 12, 15, 20].map((total) => {
                    const billable = Math.max(0, total - lateFreeAllowance);
                    const cut = previewLateDeduction(billable);
                    return (
                      <div key={total} className="bg-white rounded border border-blue-100 p-2">
                        <p className="text-[11px] text-gray-500">{total} lates + permissions</p>
                        <p className="font-bold text-blue-900">
                          {cut > 0 ? `−${cut} shift${cut === 1 ? "" : "s"}` : "No deduction"}
                        </p>
                        {billable > 0 && <p className="text-[10px] text-gray-400">{billable} billable</p>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button size="sm" onClick={saveLateDetection} disabled={updatePayrollSettings.isPending}>
                {updatePayrollSettings.isPending ? "Saving…" : "Save Late Detection Policy"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {lateDetectionSubTab === "permission" && (
        <>
          {/* ── Without Permission -a separate pool ── */}
          <Card className="border-0 shadow-sm bg-slate-50/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info size={15} className="text-slate-500" /> How the Permission Zone Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-600 leading-relaxed space-y-2">
              <p>
                Staff only. An arrival, lunch return, or departure that's past the ordinary Late window (see the
                Attendance tab's Permission Zone Width) but still inside the extra Permission window is{" "}
                <strong>auto-detected as Permission</strong> -purely from punch timing, whether or not a formal
                Permission request was ever submitted. Only past both windows does the day become Half Shift.
              </p>
              <p>
                Once an edge lands in the Permission zone, a submitted+approved <strong>Permission</strong>
                request covering that time labels it <strong>With Permission</strong>; otherwise it's
                <strong> Without Permission</strong> here, tracked separately from ordinary Late Attendance above. Every
                employee may have at most Max-Permissions-Per-Day/Week edges land in this zone (set below) -beyond that,
                the extra edge escalates to Half Shift instead.
              </p>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <AlertTriangle size={15} className="text-rose-500" /> Permission Policy
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-4 p-3 bg-emerald-50/50 border border-emerald-100 rounded-lg max-w-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs">Max Permissions Per Day</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    Edges (morning, afternoon, departure) that may resolve to Permission on the same day.
                  </p>
                  <Input
                    type="number"
                    min={0}
                    className="max-w-[140px]"
                    value={maxPermissionsPerDay}
                    onChange={(e) => setMaxPermissionsPerDay(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Max Permissions Per Week</Label>
                  <p className="text-[11px] text-gray-500 -mt-1">
                    Total Permission-zone edges allowed across an ISO week (Mon-Sun).
                  </p>
                  <Input
                    type="number"
                    min={0}
                    className="max-w-[140px]"
                    value={maxPermissionsPerWeek}
                    onChange={(e) => setMaxPermissionsPerWeek(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <p className="text-[11px] text-gray-500 sm:col-span-2">
                  Beyond either cap, the extra edge escalates from Permission to Half Shift for that day.
                </p>
              </div>

              <div className="space-y-1.5 max-w-md">
                <Label className="text-xs">Free Allowance -occurrences allowed per month</Label>
                <p className="text-[11px] text-gray-500 -mt-1">
                  No deduction at all until an employee exceeds this many Permission-zone-without-a-request occurrences
                  in a calendar month. Ships at 0 -every occurrence is billable unless raised here.
                </p>
                <Input
                  type="number"
                  min={0}
                  className="max-w-[140px]"
                  value={wpFreeAllowance}
                  onChange={(e) => setWpFreeAllowance(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <Label className="text-xs">Deduction Slabs</Label>
                    <p className="text-[11px] text-gray-500">
                      Same rule as Late Attendance's table -highest matching row wins, last row holds beyond it. Empty
                      by default, so this pool deducts nothing until rows are added here.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() =>
                      setWpSlabs((s) => [
                        ...s,
                        {
                          fromLates: (s.length ? Math.max(...s.map((r) => r.fromLates)) : 0) + 1,
                          deductionShifts: 0.25,
                        },
                      ])
                    }
                  >
                    <Plus size={13} /> Add Slab
                  </Button>
                </div>

                {wpSlabs.length === 0 ? (
                  <div className="text-xs text-gray-500 border border-dashed rounded-lg p-4 text-center">
                    No slabs -Without Permission occurrences currently cost nothing beyond being recorded.
                  </div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 text-left text-xs text-slate-600">
                          <th className="px-3 py-2 font-semibold">From this many occurrences</th>
                          <th className="px-3 py-2 font-semibold">Deduct this many shifts</th>
                          <th className="px-3 py-2 font-semibold text-right">Remove</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {wpSlabs.map((slab, i) => (
                          <tr key={i} className="hover:bg-slate-50/60">
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                className="h-8 max-w-[110px]"
                                value={slab.fromLates}
                                onChange={(e) =>
                                  setWpSlabs((s) =>
                                    s.map((r, j) =>
                                      j === i ? { ...r, fromLates: Math.max(0, Number(e.target.value) || 0) } : r,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                step={0.25}
                                className="h-8 max-w-[110px]"
                                value={slab.deductionShifts}
                                onChange={(e) =>
                                  setWpSlabs((s) =>
                                    s.map((r, j) =>
                                      j === i ? { ...r, deductionShifts: Math.max(0, Number(e.target.value) || 0) } : r,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 text-rose-600 hover:text-rose-800"
                                onClick={() => setWpSlabs((s) => s.filter((_, j) => j !== i))}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="p-3 bg-blue-50/60 border border-blue-100 rounded-lg">
                <p className="text-xs font-bold text-blue-900 mb-2">Worked example -with the values above</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  {[0, 1, 2, 3, 4, 6, 8, 10].map((total) => {
                    const billable = Math.max(0, total - wpFreeAllowance);
                    const cut = previewWpDeduction(billable);
                    return (
                      <div key={total} className="bg-white rounded border border-blue-100 p-2">
                        <p className="text-[11px] text-gray-500">{total} occurrences</p>
                        <p className="font-bold text-blue-900">
                          {cut > 0 ? `−${cut} shift${cut === 1 ? "" : "s"}` : "No deduction"}
                        </p>
                        {billable > 0 && <p className="text-[10px] text-gray-400">{billable} billable</p>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button size="sm" onClick={saveWithoutPermission} disabled={updatePayrollSettings.isPending}>
                {updatePayrollSettings.isPending ? "Saving…" : "Save Permission Policy"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
