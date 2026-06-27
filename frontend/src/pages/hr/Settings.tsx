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
        smtpHost: payrollSettingsData.smtpHost || "smtp.gmail.com",
        smtpPort: payrollSettingsData.smtpPort || 587,
        smtpUsername: payrollSettingsData.smtpUsername || "",
        smtpPassword: payrollSettingsData.smtpPassword || "",
        smtpFromEmail: payrollSettingsData.smtpFromEmail || "",
        smtpFromName: payrollSettingsData.smtpFromName || "UKTextiles HR",
      });
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
          <TabsContent value="attendance" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Clock size={15} className="text-amber-500" /> Attendance Rules
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
