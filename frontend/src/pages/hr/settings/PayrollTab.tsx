import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Clock, IndianRupee, X, Info, Landmark } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";

export default function PayrollTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData, isLoading: psLoading } = usePayrollSettings();

  const [payroll, setPayroll] = useState({
    // Staff
    pfRate: 0,
    esiRate: 0,
    esiApplicableBelow: 21000,
    // Production
    prodPfRate: 0,
    prodEsiRate: 0,
    prodEsiApplicableBelow: 21000,
    // Compensation (CTC breakdown -does not affect payroll generation)
    basicPercent: 50,
    hraPercent: 20,
    // Statutory Bonus (Payment of Bonus Act)
    bonusPercent: 8.33,
    bonusWageCeiling: 7000,
    bonusEligibilityCeiling: 21000,
    bonusFyStartMonth: 4,
    // General
    payDay: 5,
    defaultSalaryPerShift: 0,
  });

  // Payroll tab split into its independent settings groups.
  const [payrollSubTab, setPayrollSubTab] = useState<
    "rates" | "compensation" | "bonus" | "otCompensation" | "prodPfEf"
  >("rates");

  // OT / Compensation -loaded from DB
  const [compensationFeatureEnabled, setCompensationFeatureEnabled] = useState(true);

  const [otDetectionEnabled, setOtDetectionEnabled] = useState(false);

  const [otThresholdMinutes, setOtThresholdMinutes] = useState(60);

  const [otCompensationType, setOtCompensationType] = useState<"pay" | "relaxation">("pay");

  // Production PF/EF salary-range rules (takes precedence over flat rates when enabled)
  const [pfEfEnabled, setPfEfEnabled] = useState(false);

  const [pfEfRules, setPfEfRules] = useState<
    { label: string; minSalary: number; maxSalary: number; pfRate: number; efRate: number }[]
  >([]);

  // Master switches for the flat PF/ESI payroll rules (default OFF -no
  // deduction is applied for that employee class until explicitly enabled)
  const [staffRulesEnabled, setStaffRulesEnabled] = useState(false);

  const [prodRulesEnabled, setProdRulesEnabled] = useState(false);

  useEffect(() => {
    if (!payrollSettingsData) return;
    setPayroll({
      pfRate: payrollSettingsData.pfRate,
      esiRate: payrollSettingsData.esiRate,
      esiApplicableBelow: payrollSettingsData.esiApplicableBelow,
      prodPfRate: payrollSettingsData.prodPfRate,
      prodEsiRate: payrollSettingsData.prodEsiRate,
      prodEsiApplicableBelow: payrollSettingsData.prodEsiApplicableBelow,
      basicPercent: payrollSettingsData.basicPercent ?? 50,
      hraPercent: payrollSettingsData.hraPercent ?? 20,
      bonusPercent: payrollSettingsData.bonusPercent ?? 8.33,
      bonusWageCeiling: payrollSettingsData.bonusWageCeiling ?? 7000,
      bonusEligibilityCeiling: payrollSettingsData.bonusEligibilityCeiling ?? 21000,
      bonusFyStartMonth: payrollSettingsData.bonusFyStartMonth ?? 4,
      payDay: payrollSettingsData.payDay,
      defaultSalaryPerShift: payrollSettingsData.defaultSalaryPerShift ?? 0,
    });
    setCompensationFeatureEnabled(payrollSettingsData.compensationFeatureEnabled ?? true);
    setOtDetectionEnabled(payrollSettingsData.otDetectionEnabled ?? false);
    setOtThresholdMinutes(payrollSettingsData.otThresholdMinutes ?? 60);
    setOtCompensationType((payrollSettingsData.otCompensationType as "pay" | "relaxation") ?? "pay");
    setPfEfEnabled(payrollSettingsData.prodPfEfEnabled ?? false);
    setPfEfRules(payrollSettingsData.prodPfEfRules ?? []);
    setStaffRulesEnabled(payrollSettingsData.staffPayrollRulesEnabled ?? false);
    setProdRulesEnabled(payrollSettingsData.prodPayrollRulesEnabled ?? false);
  }, [payrollSettingsData]);

  // Company/Attendance/Payroll/Salary Slip/SMTP all persist to one shared
  // PayrollSettings record via one endpoint, but each tab now sends only its
  // own fields (rather than one bundled payload covering every tab) -the
  // backend checks edit permission per settings.* field group (see
  // FIELD_GROUPS in payroll_views.py), so a role with edit on only e.g.
  // Payroll must not have its save blocked by SMTP/Salary Slip fields it
  // never touched riding along in the same request.
  const savePayrollRates = async (result?: { title: string; description?: string }, errorTitle?: string) => {
    try {
      await updatePayrollSettings.mutateAsync({
        pfRate: payroll.pfRate,
        esiRate: payroll.esiRate,
        esiApplicableBelow: payroll.esiApplicableBelow,
        prodPfRate: payroll.prodPfRate,
        prodEsiRate: payroll.prodEsiRate,
        prodEsiApplicableBelow: payroll.prodEsiApplicableBelow,
        payDay: payroll.payDay,
        defaultSalaryPerShift: payroll.defaultSalaryPerShift,
        prodPfEfEnabled: pfEfEnabled,
        prodPfEfRules: pfEfRules,
        staffPayrollRulesEnabled: staffRulesEnabled,
        prodPayrollRulesEnabled: prodRulesEnabled,
      } as never);
      toast(
        result ?? {
          title: "Payroll settings saved",
          description: "New rates will apply to all payroll generated from now.",
        },
      );
    } catch {
      toast({ title: errorTitle ?? "Failed to save payroll settings", variant: "destructive" });
    }
  };

  const saveCompensationSettings = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        basicPercent: payroll.basicPercent,
        hraPercent: payroll.hraPercent,
      } as never);
      toast({
        title: "Compensation settings saved",
        description: "Only affects the Compensation page's CTC breakdown -actual payroll generation is unchanged.",
      });
    } catch {
      toast({ title: "Failed to save compensation settings", variant: "destructive" });
    }
  };

  const saveBonusSettings = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        bonusPercent: payroll.bonusPercent,
        bonusWageCeiling: payroll.bonusWageCeiling,
        bonusEligibilityCeiling: payroll.bonusEligibilityCeiling,
        bonusFyStartMonth: payroll.bonusFyStartMonth,
      } as never);
      toast({ title: "Bonus settings saved" });
    } catch {
      toast({ title: "Failed to save bonus settings", variant: "destructive" });
    }
  };

  const saveOtCompensationSettings = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        otDetectionEnabled,
        otThresholdMinutes,
        otCompensationType,
      } as never);
      toast({ title: "OT / Compensation settings saved" });
    } catch {
      toast({ title: "Failed to save OT / Compensation settings", variant: "destructive" });
    }
  };

  return (
    <>
      <PillTabs
        items={[
          { value: "rates", label: "Payroll Rules", icon: <IndianRupee size={13} /> },
          { value: "compensation", label: "Compensation", icon: <IndianRupee size={13} /> },
          { value: "bonus", label: "Bonus", icon: <IndianRupee size={13} /> },
          { value: "otCompensation", label: "OT / Compensation", icon: <Clock size={13} /> },
          { value: "prodPfEf", label: "Production PF/EF", icon: <IndianRupee size={13} /> },
        ]}
        value={payrollSubTab}
        onChange={(v) => setPayrollSubTab(v as "rates" | "compensation" | "bonus" | "otCompensation" | "prodPfEf")}
        baseColor="#0f172a"
        pillBg="#f1f5f9"
      />
      {payrollSubTab === "rates" && (
        <>
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <IndianRupee size={15} className="text-green-500" /> Payroll Rules
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Info banner */}
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <strong>Note:</strong> Payroll rules are <strong>disabled by default</strong>. Use the switch on each
                column to enable PF/ESI deductions for that employee class -while a switch is off, no deduction is
                applied even if rates are set. Changes apply to all new payroll runs -existing records are not affected.
              </div>

              {psLoading ? (
                <p className="text-sm text-muted-foreground">Loading settings…</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-6">
                  {/* ── Staff column ── */}
                  <div className={`space-y-3 ${staffRulesEnabled ? "" : "opacity-60"}`}>
                    <div className="flex items-center gap-2 pb-1 border-b">
                      <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">Staff</span>
                      <span className="text-xs text-muted-foreground">Monthly salary employees</span>
                      <div className="ml-auto flex items-center gap-2">
                        <span
                          className={`text-[10px] font-bold ${staffRulesEnabled ? "text-green-600" : "text-gray-400"}`}
                        >
                          {staffRulesEnabled ? "ENABLED" : "DISABLED"}
                        </span>
                        <Switch checked={staffRulesEnabled} onCheckedChange={setStaffRulesEnabled} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        PF Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        value={payroll.pfRate}
                        onChange={(e) => setPayroll((p) => ({ ...p, pfRate: Number(e.target.value) }))}
                        placeholder="e.g. 12"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        ESI Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        value={payroll.esiRate}
                        onChange={(e) => setPayroll((p) => ({ ...p, esiRate: Number(e.target.value) }))}
                        placeholder="e.g. 0.75"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">ESI Applicable Below (&#8377;)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={payroll.esiApplicableBelow}
                        onChange={(e) => setPayroll((p) => ({ ...p, esiApplicableBelow: Number(e.target.value) }))}
                      />
                    </div>
                  </div>

                  {/* ── Production column ── */}
                  <div className={`space-y-3 ${prodRulesEnabled ? "" : "opacity-60"}`}>
                    <div className="flex items-center gap-2 pb-1 border-b">
                      <span className="text-xs font-semibold text-orange-700 bg-orange-50 px-2 py-0.5 rounded">
                        Production
                      </span>
                      <span className="text-xs text-muted-foreground">Shift-based employees</span>
                      <div className="ml-auto flex items-center gap-2">
                        <span
                          className={`text-[10px] font-bold ${prodRulesEnabled ? "text-green-600" : "text-gray-400"}`}
                        >
                          {prodRulesEnabled ? "ENABLED" : "DISABLED"}
                        </span>
                        <Switch checked={prodRulesEnabled} onCheckedChange={setProdRulesEnabled} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        PF Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        value={payroll.prodPfRate}
                        onChange={(e) => setPayroll((p) => ({ ...p, prodPfRate: Number(e.target.value) }))}
                        placeholder="e.g. 12"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        ESI Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        value={payroll.prodEsiRate}
                        onChange={(e) => setPayroll((p) => ({ ...p, prodEsiRate: Number(e.target.value) }))}
                        placeholder="e.g. 0.75"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        ESI Applicable Below (&#8377;){" "}
                        <span className="text-muted-foreground font-normal">based on monthly estimate</span>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        value={payroll.prodEsiApplicableBelow}
                        onChange={(e) => setPayroll((p) => ({ ...p, prodEsiApplicableBelow: Number(e.target.value) }))}
                      />
                    </div>
                  </div>

                  {/* ── General (full width) ── */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Salary Pay Day (of month)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={28}
                      value={payroll.payDay}
                      onChange={(e) => setPayroll((p) => ({ ...p, payDay: Number(e.target.value) }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      Default Salary Per Shift (&#8377;){" "}
                      <span className="text-muted-foreground font-normal">pre-filled for new production employees</span>
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={payroll.defaultSalaryPerShift}
                      onChange={(e) => setPayroll((p) => ({ ...p, defaultSalaryPerShift: Number(e.target.value) }))}
                      placeholder="e.g. 300"
                    />
                  </div>
                </div>
              )}

              <Button
                size="sm"
                onClick={() => savePayrollRates()}
                disabled={updatePayrollSettings.isPending || psLoading}
              >
                {updatePayrollSettings.isPending ? "Saving…" : "Save Payroll Settings"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {payrollSubTab === "compensation" && (
        <>
          {/* ── Compensation breakdown (Compensation page) ── */}
          <Card className="border-0 shadow-sm mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <IndianRupee size={15} className="text-teal-500" /> Compensation Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                Used only by the <strong>Compensation</strong> page's CTC breakdown (Basic / HRA / Allowances per
                employee). Does <strong>not</strong> affect actual payroll generation or salary slips.
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Basic (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    value={payroll.basicPercent}
                    onChange={(e) => setPayroll((p) => ({ ...p, basicPercent: Number(e.target.value) }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">HRA (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    value={payroll.hraPercent}
                    onChange={(e) => setPayroll((p) => ({ ...p, hraPercent: Number(e.target.value) }))}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Allowances is computed as the remainder (Gross − Basic − HRA) on the Compensation page.
              </p>
              <Button
                size="sm"
                onClick={() => saveCompensationSettings()}
                disabled={updatePayrollSettings.isPending || psLoading}
              >
                {updatePayrollSettings.isPending ? "Saving…" : "Save Compensation Settings"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {payrollSubTab === "bonus" && (
        <>
          {/* ── Statutory Bonus (Bonus page) ── */}
          <Card className="border-0 shadow-sm mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <IndianRupee size={15} className="text-amber-500" /> Statutory Bonus
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                Payment of Bonus Act, 1965: bonus % must be between 8.33 (minimum) and 20 (maximum). Used by the{" "}
                <strong>Bonus</strong> page's calculation engine.
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Bonus (%)</Label>
                  <Input
                    type="number"
                    min={8.33}
                    max={20}
                    step={0.01}
                    value={payroll.bonusPercent}
                    onChange={(e) => setPayroll((p) => ({ ...p, bonusPercent: Number(e.target.value) }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Wage Ceiling (&#8377;)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={payroll.bonusWageCeiling}
                    onChange={(e) => setPayroll((p) => ({ ...p, bonusWageCeiling: Number(e.target.value) }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Eligibility Ceiling (&#8377;)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={payroll.bonusEligibilityCeiling}
                    onChange={(e) => setPayroll((p) => ({ ...p, bonusEligibilityCeiling: Number(e.target.value) }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Financial Year Start Month</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={payroll.bonusFyStartMonth}
                    onChange={(e) => setPayroll((p) => ({ ...p, bonusFyStartMonth: Number(e.target.value) }))}
                    placeholder="4 = April"
                  />
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => saveBonusSettings()}
                disabled={updatePayrollSettings.isPending || psLoading}
              >
                {updatePayrollSettings.isPending ? "Saving…" : "Save Bonus Settings"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {payrollSubTab === "otCompensation" && (
        <>
          {/* ── Compensation feature master switch ── */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Landmark size={15} className="text-teal-600" /> Compensation Feature
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-bold ${compensationFeatureEnabled ? "text-green-600" : "text-gray-400"}`}
                  >
                    {compensationFeatureEnabled ? "ENABLED" : "DISABLED"}
                  </span>
                  <Switch
                    checked={compensationFeatureEnabled}
                    onCheckedChange={async (v) => {
                      setCompensationFeatureEnabled(v);
                      try {
                        await updatePayrollSettings.mutateAsync({ compensationFeatureEnabled: v } as never);
                        toast({
                          title: v ? "Compensation feature enabled" : "Compensation feature disabled",
                          description: v
                            ? "The Compensation page is visible again, and OT detection / Compensation-Leave / OT pay in payroll are all active."
                            : "The Compensation page is hidden from the sidebar, and OT detection, the Compensation-Leave exemption, and OT pay in payroll are all switched off -existing records are kept, not deleted.",
                        });
                      } catch {
                        setCompensationFeatureEnabled(!v);
                        toast({ title: "Failed to update setting", variant: "destructive" });
                      }
                    }}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-gray-500 leading-relaxed">
                Master switch for the entire Compensation page -CTC Breakdown, OT Detection, Compensation Leave, and
                History &amp; Reports. Turning this off hides the page from the sidebar and genuinely stops the
                underlying calculations everywhere (OT is no longer detected, announced OT no longer adds pay to a
                generated payslip, and Compensation-Leave announcements stop exempting Late/Permission detection) -not
                just a cosmetic hide. Turn it back on any time; nothing is deleted while it's off. The settings below
                only matter while this is on.
              </p>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm bg-slate-50/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info size={15} className="text-slate-500" /> How OT / Compensation Works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-slate-600 leading-relaxed space-y-2">
              <p>
                Staff only. Off by default. When enabled, an employee working more than the threshold below past their
                assigned shift's end time is auto-detected as OT-eligible on the{" "}
                <strong>Compensation → OT Detection</strong> page -HR reviews and Announces each one as{" "}
                <strong>Pay</strong> (one day's equivalent salary, added to that employee's next payroll run) or{" "}
                <strong>Relaxation</strong>
                (a paid Alternative Day credit HR can redeem later). Nothing is paid or credited until announced.
              </p>
              <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                Compensation type is a single company-wide default here -employees never choose or self-assign their own
                compensation.
              </p>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Clock size={15} className="text-amber-500" /> OT Detection
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between bg-slate-50 rounded-lg border p-3">
                <div>
                  <Label className="text-xs">Enable OT Detection</Label>
                  <p className="text-[11px] text-gray-500">No employee is flagged for OT until this is on.</p>
                </div>
                <Switch checked={otDetectionEnabled} onCheckedChange={setOtDetectionEnabled} />
              </div>
              <div className="grid sm:grid-cols-2 gap-4 max-w-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs">Threshold (minutes past shift end)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={5}
                    value={otThresholdMinutes}
                    onChange={(e) => setOtThresholdMinutes(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Compensation Type (company-wide default)</Label>
                  <select
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={otCompensationType}
                    onChange={(e) => setOtCompensationType(e.target.value as "pay" | "relaxation")}
                  >
                    <option value="pay">Pay -one day's equivalent salary</option>
                    <option value="relaxation">Relaxation -paid Alternative Day</option>
                  </select>
                </div>
              </div>
              <Button size="sm" onClick={saveOtCompensationSettings} disabled={updatePayrollSettings.isPending}>
                {updatePayrollSettings.isPending ? "Saving…" : "Save OT / Compensation Settings"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {payrollSubTab === "prodPfEf" && (
        <>
          {/* ── Production PF / EF salary-range rules ── */}
          <Card className="border-0 shadow-sm mt-4">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <IndianRupee size={15} className="text-purple-500" /> Production PF / EF Salary-Range Rules
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold ${pfEfEnabled ? "text-green-600" : "text-gray-400"}`}>
                    {pfEfEnabled ? "ENABLED" : "DISABLED"}
                  </span>
                  <Switch checked={pfEfEnabled} onCheckedChange={setPfEfEnabled} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                When <strong>enabled</strong>, production payroll picks the rule matching the employee's
                monthly-equivalent earnings (bi-weekly gross × 2) and deducts PF / EF at that rule's rates — overriding
                the flat Production PF/ESI rates above. Amounts appear in the payroll breakdown and the salary slip. Max
                Salary <strong>0</strong> = no upper limit. When disabled, the flat rates above apply.
              </div>
              {pfEfRules.length === 0 ? (
                <p className="text-xs text-center text-muted-foreground py-3">No rules configured yet.</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 text-[10px] text-gray-400 uppercase font-semibold px-1">
                    <span>Category</span>
                    <span>Min Salary</span>
                    <span>Max Salary</span>
                    <span>PF %</span>
                    <span>EF %</span>
                    <span />
                  </div>
                  {pfEfRules.map((rule, i) => (
                    <div key={i} className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 items-center">
                      <Input
                        placeholder="Category / label"
                        value={rule.label}
                        onChange={(e) =>
                          setPfEfRules((rs) => rs.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))
                        }
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        placeholder="Min ₹"
                        value={rule.minSalary}
                        onChange={(e) =>
                          setPfEfRules((rs) =>
                            rs.map((r, j) => (j === i ? { ...r, minSalary: Number(e.target.value) } : r)),
                          )
                        }
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        placeholder="Max ₹ (0 = no limit)"
                        value={rule.maxSalary}
                        onChange={(e) =>
                          setPfEfRules((rs) =>
                            rs.map((r, j) => (j === i ? { ...r, maxSalary: Number(e.target.value) } : r)),
                          )
                        }
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        placeholder="PF %"
                        value={rule.pfRate}
                        onChange={(e) =>
                          setPfEfRules((rs) =>
                            rs.map((r, j) => (j === i ? { ...r, pfRate: Number(e.target.value) } : r)),
                          )
                        }
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        placeholder="EF %"
                        value={rule.efRate}
                        onChange={(e) =>
                          setPfEfRules((rs) =>
                            rs.map((r, j) => (j === i ? { ...r, efRate: Number(e.target.value) } : r)),
                          )
                        }
                        className="h-8 text-xs"
                      />
                      <button
                        onClick={() => setPfEfRules((rs) => rs.filter((_, j) => j !== i))}
                        className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setPfEfRules((rs) => [...rs, { label: "", minSalary: 0, maxSalary: 0, pfRate: 0, efRate: 0 }])
                  }
                >
                  + Add Rule
                </Button>
                <Button
                  size="sm"
                  onClick={() => savePayrollRates({ title: "PF/EF rules saved" }, "Failed to save PF/EF rules")}
                  disabled={updatePayrollSettings.isPending}
                >
                  {updatePayrollSettings.isPending ? "Saving…" : "Save PF/EF Rules"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
