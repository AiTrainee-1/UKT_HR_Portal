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

  // Permission monthly cap -the only cap now (replaces the old daily/weekly
  // auto-detect caps and the separate Without Permission pool).
  const [permissionMonthlyCap, setPermissionMonthlyCap] = useState(3);

  useEffect(() => {
    if (!payrollSettingsData) return;
    setLateFreeAllowance(payrollSettingsData.lateFreeAllowance ?? 3);
    setLateSlabs(payrollSettingsData.lateDeductionSlabs ?? []);
    setPermissionMonthlyCap(payrollSettingsData.permissionMonthlyCap ?? 3);
  }, [payrollSettingsData]);

  // The two detection switches live on the Attendance tab (they belong to that tab's permission group, so saving
  // them from here would be refused for anyone who can edit only this tab) -shown here read-only so it is clear
  // what currently feeds the pool.
  // undefined = the server did not report it (unknown), which is not the same as reporting it off.
  const morningOn = payrollSettingsData?.morningLateInEnabled;
  const eveningOn = payrollSettingsData?.eveningEarlyOutEnabled;
  const switchWord = (on: boolean | undefined) => (on === undefined ? "not reported" : on ? "on" : "off");
  const switchChip = (on: boolean | undefined) =>
    on === true ? "bg-green-100 text-green-800 border-green-200" : "bg-slate-100 text-slate-500 border-slate-200";
  // The cap is the same: an older backend has none, so the box would only show this page's default of 3.
  const capReported = payrollSettingsData?.permissionMonthlyCap != null;

  // The Permission monthly cap is a company-wide rule: a branch-assigned login can see it but the server refuses (403)
  // any save that carries it, so it is shown read-only and never sent. An older backend does not say, and is treated
  // as editable. lateFreeAllowance and the slab table are not company-wide rules and behave as before.
  const companyWideEditable = payrollSettingsData?.companyWideRulesEditable !== false;

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
    } catch (err) {
      toast({
        title: "Failed to save Late Detection policy",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
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

  const savePermissionPolicy = async () => {
    if (!companyWideEditable || !capReported) return; // nothing on this sub-tab to save (the button is disabled too)
    // The server refuses anything outside 0-31 (a month has at most 31 days); say so before sending.
    if (!Number.isInteger(permissionMonthlyCap) || permissionMonthlyCap < 0 || permissionMonthlyCap > 31) {
      toast({ title: "Permission monthly cap must be a whole number from 0 to 31", variant: "destructive" });
      return;
    }
    try {
      await updatePayrollSettings.mutateAsync({ permissionMonthlyCap } as never);
      toast({
        title: "Permission policy saved",
        description: "Applies the next time an attendance day is computed or payroll is generated.",
      });
    } catch (err) {
      toast({
        title: "Failed to save Permission policy",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
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
                Every month, an employee's <strong>Morning Late-In</strong> occurrences,{" "}
                <strong>Evening Early-Out</strong> occurrences (if that's enabled on the Attendance tab), and any
                approved <strong>Permission</strong> beyond the monthly cap (Permission Policy tab) are added into a
                single shared pool. An in-cap approved Permission never reaches this pool at all -it already shifted the
                boundary and prevented the lateness. A day that is late <em>and</em> carries an Excess permission on
                that same edge counts once, not twice. The first few in the pool are free (the allowance below);
                everything past that is "billable", and the slab table decides how many shifts get cut.
              </p>
              <p className="flex flex-wrap items-center gap-2" data-testid="late-detection-switch-status">
                <span className="font-semibold text-slate-700">Currently counting:</span>
                <span className={`rounded-md border px-2 py-0.5 font-semibold ${switchChip(morningOn)}`}>
                  Morning Late-In {switchWord(morningOn)}
                </span>
                <span className={`rounded-md border px-2 py-0.5 font-semibold ${switchChip(eveningOn)}`}>
                  Evening Early-Out {switchWord(eveningOn)}
                </span>
                <span className="text-slate-500">Switch either on or off in Settings → Attendance.</span>
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
                <Label className="text-xs">Free Allowance -occurrences allowed per month</Label>
                <p className="text-[11px] text-gray-500 -mt-1">
                  No deduction at all until an employee exceeds this many Morning Late-In / Evening Early-Out / excess-
                  Permission occurrences, combined, in a calendar month.
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

              <Button size="sm" onClick={saveLateDetection} disabled={updatePayrollSettings.isPending}>
                {updatePayrollSettings.isPending ? "Saving…" : "Save Late Detection Policy"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {lateDetectionSubTab === "permission" && (
        <>
          <Card className="border-0 shadow-sm bg-slate-50/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info size={15} className="text-slate-500" /> How Permission Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-600 leading-relaxed space-y-2">
              <p>
                Staff only. Exactly 3 types -<strong>Morning Late-In</strong>, <strong>Evening Early-Out</strong>, and{" "}
                <strong>Middle One-Hour</strong> -each a fixed 60 minutes. An employee can submit as many as they like;
                HR can approve a 4th (or later) one in a month, but only the first <em>N</em> approved that calendar
                month (the cap below, earliest-first) actually shift that day's Late Detection boundary. Beyond the cap,
                an approved Morning Late-In/Evening Early-Out permission has no effect -that day is judged against the
                plain shift time, and if it's late/early, it joins the same pool as an ordinary unexcused occurrence
                (Late Detection tab). Middle One-Hour never shifts anything, in or out of the cap.
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
              <div className="space-y-1.5 max-w-md">
                <Label className="text-xs">Permission Monthly Cap</Label>
                <p className="text-[11px] text-gray-500 -mt-1">
                  Approved permissions per employee per calendar month that actually protect that day. A request beyond
                  this is still approvable -it just stops being protective.
                </p>
                <Input
                  type="number"
                  min={0}
                  max={31}
                  className="max-w-[140px]"
                  value={permissionMonthlyCap}
                  disabled={!companyWideEditable || !capReported}
                  onChange={(e) =>
                    setPermissionMonthlyCap(Math.min(31, Math.max(0, Math.floor(Number(e.target.value)) || 0)))
                  }
                />
                {!companyWideEditable && (
                  <p data-testid="company-wide-note-cap" className="text-[11px] font-medium text-slate-500">
                    Company-wide rule - set by an administrator
                  </p>
                )}
                {companyWideEditable && payrollSettingsData && !capReported && (
                  <p data-testid="cap-not-reported" className="text-[11px] font-medium text-slate-500">
                    Not reported by the server, so it cannot be changed here
                  </p>
                )}
              </div>

              <Button
                size="sm"
                onClick={savePermissionPolicy}
                disabled={updatePayrollSettings.isPending || !companyWideEditable || !capReported}
              >
                {updatePayrollSettings.isPending ? "Saving…" : "Save Permission Policy"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
