import { useEffect, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Building2, Clock, Mail, Database, IndianRupee, FileText, Upload, X } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";

export default function Settings() {
  const { toast } = useToast();

  // ── Company (local-only for now) ───────────────────────────────────────
  const [company, setCompany] = useState({
    name: "UKTextiles", tagline: "Garments Manufacturing Excellence",
    address: "Chennai, Tamil Nadu, India", phone: "+91 9876543210",
    email: "hr@uktextiles.in", website: "https://uktextiles.in",
    gstin: "", pan: "",
  });

  const [attendance, setAttendance] = useState({
    workingDaysPerMonth: 26, gracePeriodMinutes: 15,
    halfDayHours: 4.5, overtimeThresholdHours: 9,
  });

  // ── Attendance mode + production windows — loaded from DB ─────────────
  const [attMode, setAttMode] = useState({
    attendanceMode: "strict" as "strict" | "simple",
    simpleHalfShiftCutoff: "13:30",
    simpleGraceMinutes: 15,
    prodFirstHalfStart: "08:30",
    prodFirstHalfEnd: "12:30",
    prodSecondHalfStart: "13:30",
    prodSecondHalfEnd: "17:30",
    prodExtraStart: "17:50",
    prodExtraEnd: "20:00",
  });
  const [pfEfRules, setPfEfRules] = useState<
    { label: string; minSalary: number; maxSalary: number; pfRate: number; efRate: number }[]
  >([]);

  // ── Payroll — loaded from DB ───────────────────────────────────────────
  const { data: payrollSettingsData, isLoading: psLoading } = usePayrollSettings();
  const updatePayrollSettings = useUpdatePayrollSettings();

  const [payroll, setPayroll] = useState({
    // Staff
    pfRate: 0,
    esiRate: 0,
    esiApplicableBelow: 21000,
    // Production
    prodPfRate: 0,
    prodEsiRate: 0,
    prodEsiApplicableBelow: 21000,
    // General
    payDay: 5,
    productionPayType: "biweekly",
    // Salary slip
    slipCompanyName: "UK TEXTILES - H.O",
    slipCompanyAddress: "TIRUPUR",
    minWageRate: 0,
    signatureImage: null as string | null,
    companyLogo: null as string | null,
    authorizedSignature: null as string | null,
    // SMTP
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUsername: "",
    smtpPassword: "",
    smtpFromEmail: "",
    smtpFromName: "UKTextiles HR",
  });

  // Sync DB values into local state once loaded
  useEffect(() => {
    if (payrollSettingsData) {
      setPayroll({
        pfRate: payrollSettingsData.pfRate,
        esiRate: payrollSettingsData.esiRate,
        esiApplicableBelow: payrollSettingsData.esiApplicableBelow,
        prodPfRate: payrollSettingsData.prodPfRate,
        prodEsiRate: payrollSettingsData.prodEsiRate,
        prodEsiApplicableBelow: payrollSettingsData.prodEsiApplicableBelow,
        payDay: payrollSettingsData.payDay,
        productionPayType: payrollSettingsData.productionPayType,
        slipCompanyName: payrollSettingsData.slipCompanyName || "UK TEXTILES - H.O",
        slipCompanyAddress: payrollSettingsData.slipCompanyAddress || "TIRUPUR",
        minWageRate: payrollSettingsData.minWageRate || 0,
        signatureImage: payrollSettingsData.signatureImage || null,
        companyLogo: payrollSettingsData.companyLogo || null,
        authorizedSignature: payrollSettingsData.authorizedSignature || null,
        smtpHost: payrollSettingsData.smtpHost || "smtp.gmail.com",
        smtpPort: payrollSettingsData.smtpPort || 587,
        smtpUsername: payrollSettingsData.smtpUsername || "",
        smtpPassword: payrollSettingsData.smtpPassword || "",
        smtpFromEmail: payrollSettingsData.smtpFromEmail || "",
        smtpFromName: payrollSettingsData.smtpFromName || "UKTextiles HR",
      });
      setAttMode({
        attendanceMode: (payrollSettingsData.attendanceMode as "strict" | "simple") || "strict",
        simpleHalfShiftCutoff: payrollSettingsData.simpleHalfShiftCutoff || "13:30",
        simpleGraceMinutes: payrollSettingsData.simpleGraceMinutes ?? 15,
        prodFirstHalfStart: payrollSettingsData.prodFirstHalfStart || "08:30",
        prodFirstHalfEnd: payrollSettingsData.prodFirstHalfEnd || "12:30",
        prodSecondHalfStart: payrollSettingsData.prodSecondHalfStart || "13:30",
        prodSecondHalfEnd: payrollSettingsData.prodSecondHalfEnd || "17:30",
        prodExtraStart: payrollSettingsData.prodExtraStart || "17:50",
        prodExtraEnd: payrollSettingsData.prodExtraEnd || "20:00",
      });
      setPfEfRules(payrollSettingsData.prodPfEfRules ?? []);
    }
  }, [payrollSettingsData]);

  const [backup, setBackup] = useState({
    enabled: true, schedule: "daily", time: "02:00",
    retentionDays: 30, backupPath: "D:/backups/uktextile/",
  });

  const savePayroll = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        pfRate: payroll.pfRate,
        esiRate: payroll.esiRate,
        esiApplicableBelow: payroll.esiApplicableBelow,
        prodPfRate: payroll.prodPfRate,
        prodEsiRate: payroll.prodEsiRate,
        prodEsiApplicableBelow: payroll.prodEsiApplicableBelow,
        payDay: payroll.payDay,
        productionPayType: payroll.productionPayType,
        slipCompanyName: payroll.slipCompanyName,
        slipCompanyAddress: payroll.slipCompanyAddress,
        minWageRate: payroll.minWageRate,
        signatureImage: payroll.signatureImage ?? undefined,
        companyLogo: payroll.companyLogo ?? undefined,
        authorizedSignature: payroll.authorizedSignature ?? undefined,
        smtpHost: payroll.smtpHost,
        smtpPort: payroll.smtpPort,
        smtpUsername: payroll.smtpUsername,
        smtpPassword: payroll.smtpPassword,
        smtpFromEmail: payroll.smtpFromEmail,
        smtpFromName: payroll.smtpFromName,
      } as never);
      toast({
        title: "Payroll settings saved",
        description: "New rates will apply to all payroll generated from now.",
      });
    } catch {
      toast({ title: "Failed to save payroll settings", variant: "destructive" });
    }
  };

  const save = (section: string) => {
    toast({ title: `${section} settings saved successfully` });
  };

  const saveAttendanceMode = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        attendanceMode: attMode.attendanceMode,
        simpleHalfShiftCutoff: attMode.simpleHalfShiftCutoff,
        simpleGraceMinutes: attMode.simpleGraceMinutes,
        prodFirstHalfStart: attMode.prodFirstHalfStart,
        prodFirstHalfEnd: attMode.prodFirstHalfEnd,
        prodSecondHalfStart: attMode.prodSecondHalfStart,
        prodSecondHalfEnd: attMode.prodSecondHalfEnd,
        prodExtraStart: attMode.prodExtraStart,
        prodExtraEnd: attMode.prodExtraEnd,
        prodPfEfRules: pfEfRules,
      } as never);
      toast({
        title: "Attendance settings saved",
        description: `Mode: ${attMode.attendanceMode === "simple" ? "Simple (morning + evening punch)" : "Strict (4-punch engine)"}. Applies to new calculations.`,
      });
    } catch {
      toast({ title: "Failed to save attendance settings", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Settings</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Configure system, attendance, payroll, and notification settings</p>
        </div>

        <Tabs defaultValue="company">
          <TabsList className="bg-gray-100 flex-wrap h-auto gap-1 p-1">
            <TabsTrigger value="company" className="gap-1.5 text-xs"><Building2 size={13} /> Company</TabsTrigger>
            <TabsTrigger value="attendance" className="gap-1.5 text-xs"><Clock size={13} /> Attendance</TabsTrigger>
            <TabsTrigger value="payroll" className="gap-1.5 text-xs"><IndianRupee size={13} /> Payroll</TabsTrigger>
            <TabsTrigger value="salary-slip" className="gap-1.5 text-xs"><FileText size={13} /> Salary Slip</TabsTrigger>
            <TabsTrigger value="smtp" className="gap-1.5 text-xs"><Mail size={13} /> SMTP / Email</TabsTrigger>
            <TabsTrigger value="backup" className="gap-1.5 text-xs"><Database size={13} /> Backup</TabsTrigger>
          </TabsList>

          {/* Company */}
          <TabsContent value="company" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Building2 size={15} className="text-blue-500" /> Company Profile
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Company Name</Label>
                    <Input value={company.name} onChange={e => setCompany(c => ({ ...c, name: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Tagline</Label>
                    <Input value={company.tagline} onChange={e => setCompany(c => ({ ...c, tagline: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Phone</Label>
                    <Input value={company.phone} onChange={e => setCompany(c => ({ ...c, phone: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input type="email" value={company.email} onChange={e => setCompany(c => ({ ...c, email: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Website</Label>
                    <Input value={company.website} onChange={e => setCompany(c => ({ ...c, website: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">GSTIN</Label>
                    <Input value={company.gstin} onChange={e => setCompany(c => ({ ...c, gstin: e.target.value }))} placeholder="27XXXXX..." />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Address</Label>
                  <Input value={company.address} onChange={e => setCompany(c => ({ ...c, address: e.target.value }))} />
                </div>
                <Button size="sm" onClick={() => save("Company")}>Save Company Settings</Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Attendance */}
          <TabsContent value="attendance" className="mt-4 space-y-4">
            {/* ── Calculation Mode ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Clock size={15} className="text-amber-500" /> Attendance Calculation Mode
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-3">
                  {/* Strict */}
                  <button
                    onClick={() => setAttMode(a => ({ ...a, attendanceMode: "strict" }))}
                    className={`text-left p-4 rounded-xl border-2 transition-all ${
                      attMode.attendanceMode === "strict"
                        ? "border-amber-400 bg-amber-50/60 shadow-sm"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-bold text-sm text-gray-900">Strict Mode (4-Punch)</p>
                      {attMode.attendanceMode === "strict" && (
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">ACTIVE</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Tracks all 4 punches: morning IN, lunch OUT, lunch return, evening OUT.
                      Detects lunch-return delays, half shifts from missing punches, and applies
                      the 3-free-late penalty rule.
                    </p>
                  </button>
                  {/* Simple */}
                  <button
                    onClick={() => setAttMode(a => ({ ...a, attendanceMode: "simple" }))}
                    className={`text-left p-4 rounded-xl border-2 transition-all ${
                      attMode.attendanceMode === "simple"
                        ? "border-green-400 bg-green-50/60 shadow-sm"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-bold text-sm text-gray-900">Simple Mode (Recommended)</p>
                      {attMode.attendanceMode === "simple" && (
                        <span className="text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">ACTIVE</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Morning punch + evening last punch = full shift. First punch after the
                      cutoff time = half shift. No lunch-break tracking. Late = morning punch
                      beyond grace period. Early leave is flagged.
                    </p>
                  </button>
                </div>

                {attMode.attendanceMode === "simple" && (
                  <div className="grid sm:grid-cols-2 gap-4 p-3 bg-green-50/50 border border-green-100 rounded-lg">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Half-Shift Cutoff Time</Label>
                      <p className="text-[11px] text-gray-500 -mt-1">First punch after this time = half shift</p>
                      <Input
                        type="time"
                        value={attMode.simpleHalfShiftCutoff}
                        onChange={e => setAttMode(a => ({ ...a, simpleHalfShiftCutoff: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Grace Period (minutes)</Label>
                      <p className="text-[11px] text-gray-500 -mt-1">Used when the employee has no shift assigned</p>
                      <Input
                        type="number" min={0} max={120}
                        value={attMode.simpleGraceMinutes}
                        onChange={e => setAttMode(a => ({ ...a, simpleGraceMinutes: Number(e.target.value) }))}
                      />
                    </div>
                  </div>
                )}

                <Button size="sm" onClick={saveAttendanceMode} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Attendance Mode"}
                </Button>
              </CardContent>
            </Card>

            {/* ── Production Shift Windows ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Clock size={15} className="text-orange-500" /> Production Attendance Windows (1.5-Shift Day)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500">
                  Production employees can earn up to <strong>1.5 shifts per day</strong>:
                  first half (0.5) + second half (0.5) + additional evening half (0.5).
                </p>
                <div className="grid sm:grid-cols-3 gap-4">
                  {([
                    { label: "First Half", from: "prodFirstHalfStart", to: "prodFirstHalfEnd", color: "text-blue-700" },
                    { label: "Second Half", from: "prodSecondHalfStart", to: "prodSecondHalfEnd", color: "text-indigo-700" },
                    { label: "Additional Half", from: "prodExtraStart", to: "prodExtraEnd", color: "text-purple-700" },
                  ] as const).map(w => (
                    <div key={w.label} className="p-3 border rounded-xl space-y-2">
                      <p className={`text-xs font-bold ${w.color}`}>{w.label} (0.5 shift)</p>
                      <div className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={(attMode as any)[w.from]}
                          onChange={e => setAttMode(a => ({ ...a, [w.from]: e.target.value }))}
                          className="h-8 text-xs"
                        />
                        <span className="text-gray-400 text-xs">→</span>
                        <Input
                          type="time"
                          value={(attMode as any)[w.to]}
                          onChange={e => setAttMode(a => ({ ...a, [w.to]: e.target.value }))}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <Button size="sm" onClick={saveAttendanceMode} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Production Windows"}
                </Button>
              </CardContent>
            </Card>

            {/* ── Production PF / EF Rules ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <IndianRupee size={15} className="text-purple-500" /> Production PF / EF Salary-Range Rules
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  Define PF / EF rates per salary range or work category. Payroll will apply
                  these rules to production employees once the exact calculation details are
                  finalised. Leave empty to skip PF/EF for now.
                </div>
                {pfEfRules.length === 0 ? (
                  <p className="text-xs text-center text-muted-foreground py-3">No rules configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    {pfEfRules.map((rule, i) => (
                      <div key={i} className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 items-center">
                        <Input
                          placeholder="Category / label"
                          value={rule.label}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, label: e.target.value } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="Min ₹"
                          value={rule.minSalary}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, minSalary: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="Max ₹"
                          value={rule.maxSalary}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, maxSalary: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="PF %"
                          value={rule.pfRate}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, pfRate: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" placeholder="EF %"
                          value={rule.efRate}
                          onChange={e => setPfEfRules(rs => rs.map((r, j) => j === i ? { ...r, efRate: Number(e.target.value) } : r))}
                          className="h-8 text-xs"
                        />
                        <button
                          onClick={() => setPfEfRules(rs => rs.filter((_, j) => j !== i))}
                          className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                    <div className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 text-[10px] text-gray-400 uppercase font-semibold px-1">
                      <span>Category</span><span>Min Salary</span><span>Max Salary</span><span>PF %</span><span>EF %</span><span />
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm" variant="outline"
                    onClick={() => setPfEfRules(rs => [...rs, { label: "", minSalary: 0, maxSalary: 0, pfRate: 0, efRate: 0 }])}
                  >
                    + Add Rule
                  </Button>
                  <Button size="sm" onClick={saveAttendanceMode} disabled={updatePayrollSettings.isPending}>
                    {updatePayrollSettings.isPending ? "Saving…" : "Save PF/EF Rules"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* ── Legacy general rules ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Clock size={15} className="text-gray-400" /> General Attendance Rules
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  {[
                    { label: "Working Days / Month", key: "workingDaysPerMonth" },
                    { label: "Grace Period (minutes)", key: "gracePeriodMinutes" },
                    { label: "Half Day Threshold (hours)", key: "halfDayHours" },
                    { label: "Overtime Threshold (hours)", key: "overtimeThresholdHours" },
                  ].map(({ label, key }) => (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs">{label}</Label>
                      <Input type="number" value={(attendance as any)[key]}
                        onChange={e => setAttendance(a => ({ ...a, [key]: Number(e.target.value) }))} />
                    </div>
                  ))}
                </div>
                <Button size="sm" onClick={() => save("Attendance")}>Save Attendance Settings</Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Payroll */}
          <TabsContent value="payroll" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <IndianRupee size={15} className="text-green-500" /> Payroll Rules
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Info banner */}
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  <strong>Note:</strong> PF and ESI are <strong>disabled by default</strong> (rate = 0).
                  Enter a non-zero rate to enable automatic deduction during payroll generation.
                  Changes apply to all new payroll runs — existing records are not affected.
                </div>

                {psLoading ? (
                  <p className="text-sm text-muted-foreground">Loading settings…</p>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-6">
                    {/* ── Staff column ── */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 pb-1 border-b">
                        <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">Staff</span>
                        <span className="text-xs text-muted-foreground">Monthly salary employees</span>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          PF Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.pfRate}
                          onChange={e => setPayroll(p => ({ ...p, pfRate: Number(e.target.value) }))}
                          placeholder="e.g. 12"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          ESI Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.esiRate}
                          onChange={e => setPayroll(p => ({ ...p, esiRate: Number(e.target.value) }))}
                          placeholder="e.g. 0.75"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">ESI Applicable Below (&#8377;)</Label>
                        <Input
                          type="number" min={0}
                          value={payroll.esiApplicableBelow}
                          onChange={e => setPayroll(p => ({ ...p, esiApplicableBelow: Number(e.target.value) }))}
                        />
                      </div>
                    </div>

                    {/* ── Production column ── */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 pb-1 border-b">
                        <span className="text-xs font-semibold text-orange-700 bg-orange-50 px-2 py-0.5 rounded">Production</span>
                        <span className="text-xs text-muted-foreground">Session-based employees</span>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          PF Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.prodPfRate}
                          onChange={e => setPayroll(p => ({ ...p, prodPfRate: Number(e.target.value) }))}
                          placeholder="e.g. 12"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          ESI Rate (%) <span className="text-muted-foreground font-normal">0 = disabled</span>
                        </Label>
                        <Input
                          type="number" min={0} max={100} step={0.01}
                          value={payroll.prodEsiRate}
                          onChange={e => setPayroll(p => ({ ...p, prodEsiRate: Number(e.target.value) }))}
                          placeholder="e.g. 0.75"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">ESI Applicable Below (&#8377;) <span className="text-muted-foreground font-normal">based on monthly estimate</span></Label>
                        <Input
                          type="number" min={0}
                          value={payroll.prodEsiApplicableBelow}
                          onChange={e => setPayroll(p => ({ ...p, prodEsiApplicableBelow: Number(e.target.value) }))}
                        />
                      </div>
                    </div>

                    {/* ── General (full width) ── */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Salary Pay Day (of month)</Label>
                      <Input
                        type="number" min={1} max={28}
                        value={payroll.payDay}
                        onChange={e => setPayroll(p => ({ ...p, payDay: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Production Employee Pay Cycle</Label>
                      <select
                        value={payroll.productionPayType}
                        onChange={e => setPayroll(p => ({ ...p, productionPayType: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="biweekly">Bi-Weekly (every 2 weeks)</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>
                  </div>
                )}

                <Button
                  size="sm"
                  onClick={savePayroll}
                  disabled={updatePayrollSettings.isPending || psLoading}
                >
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Payroll Settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* SMTP */}
          <TabsContent value="smtp" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Mail size={15} className="text-blue-500" /> SMTP / Email Configuration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-xs text-amber-700">
                  For Gmail: use <strong>smtp.gmail.com</strong>, port <strong>587</strong>, and an <strong>App Password</strong> (not your Google account password). Enable 2FA on your Google account, then generate an App Password under Google Account → Security.
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  {([
                    { label: "SMTP Host", key: "smtpHost", placeholder: "smtp.gmail.com" },
                    { label: "SMTP Port", key: "smtpPort", placeholder: "587", isNum: true },
                    { label: "Username (Gmail address)", key: "smtpUsername", placeholder: "hr@gmail.com" },
                    { label: "App Password", key: "smtpPassword", type: "password", placeholder: "xxxx xxxx xxxx xxxx" },
                    { label: "From Email", key: "smtpFromEmail", placeholder: "hr@uktextiles.in" },
                    { label: "From Name", key: "smtpFromName", placeholder: "UKTextiles HR" },
                  ] as { label: string; key: string; placeholder: string; type?: string; isNum?: boolean }[]).map(({ label, key, type, placeholder, isNum }) => (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs">{label}</Label>
                      <Input
                        type={type ?? "text"}
                        value={String((payroll as any)[key] ?? "")}
                        onChange={e => setPayroll(p => ({ ...p, [key]: isNum ? Number(e.target.value) : e.target.value }))}
                        placeholder={placeholder}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <Button
                    size="sm"
                    onClick={savePayroll}
                    disabled={updatePayrollSettings.isPending || psLoading}
                  >
                    {updatePayrollSettings.isPending ? "Saving…" : "Save SMTP Settings"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Backup */}
          <TabsContent value="backup" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Database size={15} className="text-purple-500" /> Backup Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  PostgreSQL backups are automated using pg_dump. Backup files are stored locally on the server.
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Schedule</Label>
                    <select value={backup.schedule} onChange={e => setBackup(b => ({ ...b, schedule: e.target.value }))}
                      className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                      <option value="hourly">Every Hour</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Time (24h)</Label>
                    <Input type="time" value={backup.time} onChange={e => setBackup(b => ({ ...b, time: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Retention (days)</Label>
                    <Input type="number" value={backup.retentionDays} onChange={e => setBackup(b => ({ ...b, retentionDays: Number(e.target.value) }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Backup Path</Label>
                    <Input value={backup.backupPath} onChange={e => setBackup(b => ({ ...b, backupPath: e.target.value }))} />
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button size="sm" variant="outline" onClick={() => toast({ title: "Backup started…" })}>
                    Run Backup Now
                  </Button>
                  <Button size="sm" onClick={() => save("Backup")}>Save Backup Settings</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          {/* Salary Slip */}
          <TabsContent value="salary-slip" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <FileText size={15} className="text-blue-500" /> Salary Slip Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Company Name (on slip header)</Label>
                    <Input
                      value={payroll.slipCompanyName}
                      onChange={e => setPayroll(p => ({ ...p, slipCompanyName: e.target.value }))}
                      placeholder="UK TEXTILES - H.O"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Company Address / City</Label>
                    <Input
                      value={payroll.slipCompanyAddress}
                      onChange={e => setPayroll(p => ({ ...p, slipCompanyAddress: e.target.value }))}
                      placeholder="TIRUPUR"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Minimum Rate of Wages (₹)</Label>
                    <Input
                      type="number"
                      value={payroll.minWageRate}
                      onChange={e => setPayroll(p => ({ ...p, minWageRate: Number(e.target.value) }))}
                      placeholder="20000"
                    />
                  </div>
                </div>

                {/* Signature Image Upload */}
                <div className="space-y-2">
                  <Label className="text-xs">Authorised Signatory Signature Image</Label>
                  <p className="text-xs text-gray-500">This signature will appear on all salary slips in the Proprietor section.</p>
                  <div className="flex items-start gap-4">
                    {payroll.signatureImage ? (
                      <div className="relative">
                        <img
                          src={payroll.signatureImage}
                          alt="Signature"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, signatureImage: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload signature</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => {
                              setPayroll(p => ({ ...p, signatureImage: ev.target?.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Company Logo — used on Resignation Acceptance Letter PDF */}
                <div className="space-y-2 pt-2 border-t border-gray-100">
                  <Label className="text-xs">Company Logo</Label>
                  <p className="text-xs text-gray-500">Used on the Resignation Acceptance Letter PDF header.</p>
                  <div className="flex items-start gap-4">
                    {payroll.companyLogo ? (
                      <div className="relative">
                        <img
                          src={payroll.companyLogo}
                          alt="Company Logo"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, companyLogo: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload logo</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => {
                              setPayroll(p => ({ ...p, companyLogo: ev.target?.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Authorised Signature for Resignation Letter */}
                <div className="space-y-2">
                  <Label className="text-xs">Authorised Signature (for Resignation Letter)</Label>
                  <p className="text-xs text-gray-500">This signature appears on the Resignation Acceptance Letter PDF issued to employees.</p>
                  <div className="flex items-start gap-4">
                    {payroll.authorizedSignature ? (
                      <div className="relative">
                        <img
                          src={payroll.authorizedSignature}
                          alt="Authorised Signature"
                          className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                        />
                        <button
                          onClick={() => setPayroll(p => ({ ...p, authorizedSignature: null }))}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload size={18} className="text-gray-400 mb-1" />
                        <span className="text-xs text-gray-400">Upload signature</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => {
                              setPayroll(p => ({ ...p, authorizedSignature: ev.target?.result as string }));
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                <Button size="sm" onClick={savePayroll} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Salary Slip Settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>
      </div>
    </HrLayout>
  );
}
