import { useEffect, useState, type ReactNode } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, Clock, Mail, Database, IndianRupee, FileText, Upload, X,
  Fingerprint, CreditCard, Plus, Trash2, Power, Pencil, FileSignature, Award,
} from "lucide-react";
import {
  usePayrollSettings, useUpdatePayrollSettings,
  useListBiometricDevices, useCreateBiometricDevice, useUpdateBiometricDevice, useDeleteBiometricDevice,
  useIdCardSettings, useUpdateIdCardSettings,
  useBackupStatus, useRunBackup,
  useDocumentSettings, useUpdateDocumentSettings, previewDocumentPdf,
  type DocumentType,
} from "@/lib/api-client/custom-hooks";
import { useAuth } from "@/contexts/AuthContext";
import ProductionShiftConfigCard from "@/components/ProductionShiftConfigCard";

function DocumentThemeCard({
  docType, title, icon, description,
}: { docType: DocumentType; title: string; icon: ReactNode; description: string }) {
  const { toast } = useToast();
  const { token } = useAuth();
  const { data, isLoading } = useDocumentSettings(docType);
  const updateSettings = useUpdateDocumentSettings(docType);
  const [form, setForm] = useState({
    primaryColor: "#0E4B3A", accentColor: "#C9A227", headingStyle: "serif" as "serif" | "sans",
    showWatermark: true, footerTagline: "Weaving Quality. Building Trust.", logoOverride: "",
  });
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        primaryColor: data.primaryColor, accentColor: data.accentColor, headingStyle: data.headingStyle,
        showWatermark: data.showWatermark, footerTagline: data.footerTagline, logoOverride: data.logoOverride,
      });
    }
  }, [data]);

  const save = async () => {
    try {
      await updateSettings.mutateAsync(form);
      toast({ title: `${title} settings saved`, description: "Applies to every newly generated document." });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      await previewDocumentPdf(`/api/document-settings/${docType}/preview`, () => token);
    } catch {
      toast({ title: "Failed to generate preview", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">{icon} {title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-500">{description}</p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Theme Color (Primary)</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                <Input value={form.primaryColor} onChange={e => setForm(f => ({ ...f, primaryColor: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Accent Color</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                <Input value={form.accentColor} onChange={e => setForm(f => ({ ...f, accentColor: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Heading Style</Label>
              <select
                value={form.headingStyle}
                onChange={e => setForm(f => ({ ...f, headingStyle: e.target.value as "serif" | "sans" }))}
                className="w-full h-9 rounded-md border px-3 text-sm bg-background"
              >
                <option value="serif">Serif (elegant)</option>
                <option value="sans">Sans (modern)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Footer Tagline</Label>
              <Input
                value={form.footerTagline}
                onChange={e => setForm(f => ({ ...f, footerTagline: e.target.value }))}
                placeholder="e.g. Weaving Quality. Building Trust."
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Logo Override (optional — defaults to the Company Logo above)</Label>
              <div className="flex items-start gap-4">
                {form.logoOverride ? (
                  <div className="relative">
                    <img src={form.logoOverride} alt="Logo override" className="h-16 border border-gray-200 rounded-lg bg-white p-2 object-contain" />
                    <button
                      onClick={() => setForm(f => ({ ...f, logoOverride: "" }))}
                      className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center w-36 h-16 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-emerald-400 hover:bg-emerald-50 transition-colors">
                    <Upload size={16} className="text-gray-400 mb-1" />
                    <span className="text-xs text-gray-400">Upload logo</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = ev => setForm(f => ({ ...f, logoOverride: ev.target?.result as string }));
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
            <div className="space-y-1.5 flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, showWatermark: !f.showWatermark }))}
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    form.showWatermark ? "bg-emerald-700 border-emerald-700" : "bg-white border-gray-300"
                  }`}
                >
                  {form.showWatermark && <span className="w-2 h-2 bg-white rounded-sm" />}
                </button>
                <span className="text-sm text-gray-700">Show faint watermark</span>
              </label>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={save} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? "Saving…" : `Save ${title} Settings`}
          </Button>
          <Button size="sm" variant="outline" onClick={preview} disabled={previewing}>
            {previewing ? "Generating…" : "Preview"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const [settingsTab, setSettingsTab] = useState("company");

  // ── Company profile — persisted to PayrollSettings via the API ─────────
  const [company, setCompany] = useState({
    name: "UKTextiles", tagline: "Garments Manufacturing Excellence",
    address: "Chennai, Tamil Nadu, India", phone: "+91 9876543210",
    email: "hr@uktextiles.in", website: "https://uktextiles.in",
    gstin: "", pan: "", registration: "",
  });

  // ── Attendance mode + production windows — loaded from DB ─────────────
  const [attMode, setAttMode] = useState({
    attendanceMode: "strict" as "strict" | "simple",
    simpleHalfShiftCutoff: "13:30",
    prodFirstHalfStart: "08:30",
    prodFirstHalfEnd: "12:30",
    prodSecondHalfStart: "13:30",
    prodSecondHalfEnd: "17:30",
    prodExtraStart: "17:50",
    prodExtraEnd: "20:00",
  });
  // ── Payroll — loaded from DB ───────────────────────────────────────────
  const { data: payrollSettingsData, isLoading: psLoading } = usePayrollSettings();
  const updatePayrollSettings = useUpdatePayrollSettings();

  // Production PF/EF salary-range rules (takes precedence over flat rates when enabled)
  const [pfEfEnabled, setPfEfEnabled] = useState(false);
  const [pfEfRules, setPfEfRules] = useState<
    { label: string; minSalary: number; maxSalary: number; pfRate: number; efRate: number }[]
  >([]);

  // Master switches for the flat PF/ESI payroll rules (default OFF — no
  // deduction is applied for that employee class until explicitly enabled)
  const [staffRulesEnabled, setStaffRulesEnabled] = useState(false);
  const [prodRulesEnabled, setProdRulesEnabled] = useState(false);

  // Night Shift Relaxation feature toggle (staff-only page in the sidebar)
  const [nightShiftEnabled, setNightShiftEnabled] = useState(true);

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
    defaultSalaryPerShift: 0,
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
      setCompany({
        name: payrollSettingsData.companyName || "UKTextiles",
        tagline: payrollSettingsData.companyTagline || "Garments Manufacturing Excellence",
        phone: payrollSettingsData.companyPhone || "",
        email: payrollSettingsData.companyEmail || "",
        website: payrollSettingsData.companyWebsite || "",
        gstin: payrollSettingsData.companyGstin || "",
        pan: payrollSettingsData.companyPan || "",
        address: payrollSettingsData.companyAddress || "",
        registration: payrollSettingsData.companyRegistration || "",
      });
      setPayroll({
        pfRate: payrollSettingsData.pfRate,
        esiRate: payrollSettingsData.esiRate,
        esiApplicableBelow: payrollSettingsData.esiApplicableBelow,
        prodPfRate: payrollSettingsData.prodPfRate,
        prodEsiRate: payrollSettingsData.prodEsiRate,
        prodEsiApplicableBelow: payrollSettingsData.prodEsiApplicableBelow,
        payDay: payrollSettingsData.payDay,
        productionPayType: payrollSettingsData.productionPayType,
        defaultSalaryPerShift: payrollSettingsData.defaultSalaryPerShift ?? 0,
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
        prodFirstHalfStart: payrollSettingsData.prodFirstHalfStart || "08:30",
        prodFirstHalfEnd: payrollSettingsData.prodFirstHalfEnd || "12:30",
        prodSecondHalfStart: payrollSettingsData.prodSecondHalfStart || "13:30",
        prodSecondHalfEnd: payrollSettingsData.prodSecondHalfEnd || "17:30",
        prodExtraStart: payrollSettingsData.prodExtraStart || "17:50",
        prodExtraEnd: payrollSettingsData.prodExtraEnd || "20:00",
      });
      setPfEfEnabled(payrollSettingsData.prodPfEfEnabled ?? false);
      setPfEfRules(payrollSettingsData.prodPfEfRules ?? []);
      setStaffRulesEnabled(payrollSettingsData.staffPayrollRulesEnabled ?? false);
      setProdRulesEnabled(payrollSettingsData.prodPayrollRulesEnabled ?? false);
      setNightShiftEnabled(payrollSettingsData.nightShiftEnabled ?? true);
    }
  }, [payrollSettingsData]);

  // ── Database backup ─────────────────────────────────────────────────────
  const { data: backupStatus } = useBackupStatus();
  const runBackup = useRunBackup();
  const [backupDir, setBackupDir] = useState("");
  const [backupDirLoaded, setBackupDirLoaded] = useState(false);

  useEffect(() => {
    if (backupStatus && !backupDirLoaded) {
      setBackupDir(backupStatus.backupDirectory || "D:/backups/uktextile");
      setBackupDirLoaded(true);
    }
  }, [backupStatus, backupDirLoaded]);

  const handleRunBackup = async () => {
    if (!backupDir.trim()) {
      toast({ title: "Enter a backup directory first", variant: "destructive" });
      return;
    }
    try {
      const result = await runBackup.mutateAsync(backupDir.trim());
      toast({
        title: "Backup completed",
        description: `${result.file} (${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
      });
    } catch (err) {
      toast({
        title: "Backup failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  // All Settings tabs (Payroll, PF/EF Rules, SMTP, Salary Slip) share one
  // PayrollSettings record on the backend, so they share this one save call —
  // but each tab reports its own accurate result rather than a generic
  // "Payroll settings saved" message no matter which tab was actually edited.
  const savePayroll = async (result?: { title: string; description?: string }, errorTitle?: string) => {
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
        defaultSalaryPerShift: payroll.defaultSalaryPerShift,
        prodPfEfEnabled: pfEfEnabled,
        prodPfEfRules: pfEfRules,
        staffPayrollRulesEnabled: staffRulesEnabled,
        prodPayrollRulesEnabled: prodRulesEnabled,
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
      toast(result ?? {
        title: "Payroll settings saved",
        description: "New rates will apply to all payroll generated from now.",
      });
    } catch {
      toast({ title: errorTitle ?? "Failed to save payroll settings", variant: "destructive" });
    }
  };

  const saveCompany = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        companyName: company.name,
        companyTagline: company.tagline,
        companyPhone: company.phone,
        companyEmail: company.email,
        companyWebsite: company.website,
        companyGstin: company.gstin,
        companyPan: company.pan,
        companyAddress: company.address,
        companyRegistration: company.registration,
        // null is meaningful here — it clears a previously saved logo
        companyLogo: payroll.companyLogo,
      } as never);
      toast({
        title: "Company settings saved",
        description: "The name and logo now update everywhere in the portal, including the sidebar.",
      });
    } catch {
      toast({ title: "Failed to save company settings", variant: "destructive" });
    }
  };

  // ── Biometric devices ────────────────────────────────────────────────────
  const { data: devices, isLoading: devicesLoading } = useListBiometricDevices();
  const createDevice = useCreateBiometricDevice();
  const updateDevice = useUpdateBiometricDevice();
  const deleteDevice = useDeleteBiometricDevice();
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDevice, setNewDevice] = useState({
    name: "", deviceType: "aiface_mars", host: "", port: "", apiKey: "", password: "", notes: "",
  });
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [editDevice, setEditDevice] = useState({ host: "", port: "", password: "" });

  const startEditDevice = (d: { id: number; host: string; port: number | null; connectionConfig?: Record<string, unknown> }) => {
    setEditingDeviceId(d.id);
    setEditDevice({ host: d.host ?? "", port: d.port ? String(d.port) : "", password: String((d.connectionConfig as any)?.password ?? "") });
  };

  const saveEditDevice = async (id: number) => {
    try {
      await updateDevice.mutateAsync({
        id,
        data: {
          host: editDevice.host,
          port: editDevice.port ? Number(editDevice.port) : null,
          connectionConfig: { password: editDevice.password },
        } as any,
      });
      toast({ title: "Device updated" });
      setEditingDeviceId(null);
    } catch {
      toast({ title: "Failed to update device", variant: "destructive" });
    }
  };

  const addDevice = async () => {
    if (!newDevice.name.trim()) {
      toast({ title: "Device name is required", variant: "destructive" });
      return;
    }
    try {
      await createDevice.mutateAsync({
        name: newDevice.name,
        deviceType: newDevice.deviceType,
        host: newDevice.host || undefined,
        port: newDevice.port ? Number(newDevice.port) : undefined,
        apiKey: newDevice.apiKey || undefined,
        notes: newDevice.notes || undefined,
        connectionConfig: newDevice.password ? { password: newDevice.password } : undefined,
      } as any);
      toast({ title: "Device added" });
      setNewDevice({ name: "", deviceType: "aiface_mars", host: "", port: "", apiKey: "", password: "", notes: "" });
      setShowAddDevice(false);
    } catch {
      toast({ title: "Failed to add device", variant: "destructive" });
    }
  };

  // ── ID Card template settings ───────────────────────────────────────────
  const { data: idCardSettingsData, isLoading: idCardLoading } = useIdCardSettings();
  const updateIdCardSettings = useUpdateIdCardSettings();
  const [idCardForm, setIdCardForm] = useState({
    primaryColor: "#006496", secondaryColor: "#4FB8F0", textColor: "#0f172a",
    fontFamily: "Hanken Grotesk", backgroundStyle: "gradient", logoPosition: "left",
    cornerStyle: "rounded", showQrOnBack: true, footerText: "",
  });

  useEffect(() => {
    if (idCardSettingsData) setIdCardForm(idCardSettingsData);
  }, [idCardSettingsData]);

  const saveIdCardSettings = async () => {
    try {
      await updateIdCardSettings.mutateAsync(idCardForm);
      toast({ title: "ID card template saved", description: "Applies to all newly generated ID cards." });
    } catch {
      toast({ title: "Failed to save ID card settings", variant: "destructive" });
    }
  };

  const saveAttendanceMode = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        attendanceMode: attMode.attendanceMode,
        simpleHalfShiftCutoff: attMode.simpleHalfShiftCutoff,
        prodFirstHalfStart: attMode.prodFirstHalfStart,
        prodFirstHalfEnd: attMode.prodFirstHalfEnd,
        prodSecondHalfStart: attMode.prodSecondHalfStart,
        prodSecondHalfEnd: attMode.prodSecondHalfEnd,
        prodExtraStart: attMode.prodExtraStart,
        prodExtraEnd: attMode.prodExtraEnd,
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

        <Tabs value={settingsTab} onValueChange={setSettingsTab}>
          <PillTabs
            className="flex-wrap h-auto"
            items={[
              { value: "company", label: "Company", icon: <Building2 size={13} /> },
              { value: "attendance", label: "Attendance", icon: <Clock size={13} /> },
              { value: "devices", label: "Devices", icon: <Fingerprint size={13} /> },
              { value: "idcard", label: "ID Card", icon: <CreditCard size={13} /> },
              { value: "documents", label: "Company Documents", icon: <FileSignature size={13} /> },
              { value: "payroll", label: "Payroll", icon: <IndianRupee size={13} /> },
              { value: "salary-slip", label: "Salary Slip", icon: <FileText size={13} /> },
              { value: "smtp", label: "SMTP / Email", icon: <Mail size={13} /> },
              { value: "backup", label: "Backup", icon: <Database size={13} /> },
            ]}
            value={settingsTab}
            onChange={setSettingsTab}
            size="sm"
          />

          {/* Company */}
          <TabsContent value="company" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Building2 size={15} className="text-blue-500" /> Company Profile
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  These details are used across the entire portal — the sidebar, salary slips,
                  ID cards, and PDFs all pull the name and logo from here automatically.
                </div>

                {/* Logo upload */}
                <div className="space-y-2">
                  <Label className="text-xs">Company Logo</Label>
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
                            reader.onload = ev => setPayroll(p => ({ ...p, companyLogo: ev.target?.result as string }));
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

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
                  <div className="space-y-1.5">
                    <Label className="text-xs">PAN</Label>
                    <Input value={company.pan} onChange={e => setCompany(c => ({ ...c, pan: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Registration Details</Label>
                    <Input value={company.registration} onChange={e => setCompany(c => ({ ...c, registration: e.target.value }))} placeholder="CIN / factory license no." />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Address</Label>
                  <Input value={company.address} onChange={e => setCompany(c => ({ ...c, address: e.target.value }))} />
                </div>
                <Button size="sm" onClick={saveCompany} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Company Settings"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Devices */}
          <TabsContent value="devices" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <Fingerprint size={15} className="text-cyan-500" /> Biometric / Punching Devices
                  </CardTitle>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowAddDevice(v => !v)}>
                    <Plus size={13} /> Add Device
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500">
                  Add and enable/disable additional attendance devices — supports employees working
                  across multiple units or branches. The <strong>.env</strong>-configured device (blue badge)
                  always keeps working exactly as before; devices added here are extra. When syncing
                  attendance (Attendance page), HR picks which device to pull from, including
                  "All Devices" to merge every enabled device plus the .env device.
                </p>

                {showAddDevice && (
                  <div className="p-4 border-2 border-cyan-100 bg-cyan-50/40 rounded-xl space-y-3">
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Device Name</Label>
                        <Input value={newDevice.name} onChange={e => setNewDevice(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Main Gate Scanner" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Device Type</Label>
                        <select
                          value={newDevice.deviceType}
                          onChange={e => setNewDevice(d => ({ ...d, deviceType: e.target.value }))}
                          className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        >
                          <option value="aiface_mars">AiFace-Mars</option>
                          <option value="zkteco">ZKTeco</option>
                          <option value="essl">eSSL</option>
                          <option value="generic_http">Generic HTTP API</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Host / IP Address</Label>
                        <Input value={newDevice.host} onChange={e => setNewDevice(d => ({ ...d, host: e.target.value }))} placeholder="192.168.1.201" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Port</Label>
                        <Input type="number" value={newDevice.port} onChange={e => setNewDevice(d => ({ ...d, port: e.target.value }))} placeholder="4370" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Comm Password (ZKTeco, optional)</Label>
                        <Input type="password" value={newDevice.password} onChange={e => setNewDevice(d => ({ ...d, password: e.target.value }))} placeholder="0" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">API Key / Token (optional)</Label>
                        <Input type="password" value={newDevice.apiKey} onChange={e => setNewDevice(d => ({ ...d, apiKey: e.target.value }))} />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs">Notes</Label>
                        <Input value={newDevice.notes} onChange={e => setNewDevice(d => ({ ...d, notes: e.target.value }))} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={addDevice} disabled={createDevice.isPending}>
                        {createDevice.isPending ? "Adding…" : "Save Device"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowAddDevice(false)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {devicesLoading ? (
                  <p className="text-sm text-muted-foreground">Loading devices…</p>
                ) : (devices ?? []).length === 0 ? (
                  <p className="text-sm text-center text-muted-foreground py-6">No devices configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    {(devices ?? []).map(d => (
                      <div key={d.id} className="border rounded-xl overflow-hidden">
                        <div className="flex items-center gap-3 p-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${d.isActive ? "bg-cyan-50" : "bg-gray-100"}`}>
                            <Fingerprint size={16} className={d.isActive ? "text-cyan-600" : "text-gray-400"} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-bold text-gray-800">{d.name}</p>
                              {d.isEnv && (
                                <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded-full">.env</span>
                              )}
                              {!d.isActive && (
                                <span className="text-[10px] font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full">Disabled</span>
                              )}
                            </div>
                            <p className="text-[11px] text-gray-400">
                              {d.deviceType} {d.host ? `· ${d.host}${d.port ? `:${d.port}` : ""}` : ""}
                              {d.isEnv ? " · configured in backend/.env" : ""}
                            </p>
                          </div>
                          {typeof d.id === "number" && !d.isEnv && (
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => editingDeviceId === d.id ? setEditingDeviceId(null) : startEditDevice(d as any)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-cyan-600 hover:bg-cyan-50"
                                title="Edit connection (host, port, password)"
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                onClick={() => updateDevice.mutate({ id: d.id as number, data: { isActive: !d.isActive } })}
                                className={`p-1.5 rounded-lg hover:bg-gray-50 ${d.isActive ? "text-green-600" : "text-gray-400"}`}
                                title={d.isActive ? "Disable device" : "Enable device"}
                              >
                                <Power size={13} />
                              </button>
                              <button
                                onClick={() => deleteDevice.mutate(d.id as number)}
                                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                                title="Remove device"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                        {editingDeviceId === d.id && (
                          <div className="p-3 border-t bg-gray-50 grid sm:grid-cols-3 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Host / IP Address</Label>
                              <Input value={editDevice.host} onChange={e => setEditDevice(v => ({ ...v, host: e.target.value }))} placeholder="192.168.1.201" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Port</Label>
                              <Input type="number" value={editDevice.port} onChange={e => setEditDevice(v => ({ ...v, port: e.target.value }))} placeholder="4370" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Comm Password (ZKTeco)</Label>
                              <Input type="password" value={editDevice.password} onChange={e => setEditDevice(v => ({ ...v, password: e.target.value }))} placeholder="0" />
                            </div>
                            <div className="sm:col-span-3 flex gap-2">
                              <Button size="sm" onClick={() => saveEditDevice(d.id as number)} disabled={updateDevice.isPending}>
                                {updateDevice.isPending ? "Saving…" : "Save Connection"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingDeviceId(null)}>Cancel</Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ID Card Settings */}
          <TabsContent value="idcard" className="mt-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <CreditCard size={15} className="text-sky-500" /> Employee ID Card Template
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500">
                  These settings control the look of every ID card generated from the ID Cards page.
                </p>
                {idCardLoading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Primary Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={idCardForm.primaryColor} onChange={e => setIdCardForm(f => ({ ...f, primaryColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                        <Input value={idCardForm.primaryColor} onChange={e => setIdCardForm(f => ({ ...f, primaryColor: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Secondary Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={idCardForm.secondaryColor} onChange={e => setIdCardForm(f => ({ ...f, secondaryColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                        <Input value={idCardForm.secondaryColor} onChange={e => setIdCardForm(f => ({ ...f, secondaryColor: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Text Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={idCardForm.textColor} onChange={e => setIdCardForm(f => ({ ...f, textColor: e.target.value }))} className="h-9 w-12 rounded border cursor-pointer" />
                        <Input value={idCardForm.textColor} onChange={e => setIdCardForm(f => ({ ...f, textColor: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Font Family</Label>
                      <select
                        value={idCardForm.fontFamily}
                        onChange={e => setIdCardForm(f => ({ ...f, fontFamily: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="Hanken Grotesk">Hanken Grotesk</option>
                        <option value="Inter">Inter</option>
                        <option value="Poppins">Poppins</option>
                        <option value="Roboto">Roboto</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Background Style</Label>
                      <select
                        value={idCardForm.backgroundStyle}
                        onChange={e => setIdCardForm(f => ({ ...f, backgroundStyle: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="gradient">Gradient</option>
                        <option value="solid">Solid</option>
                        <option value="pattern">Pattern</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Logo Position</Label>
                      <select
                        value={idCardForm.logoPosition}
                        onChange={e => setIdCardForm(f => ({ ...f, logoPosition: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Corner Style</Label>
                      <select
                        value={idCardForm.cornerStyle}
                        onChange={e => setIdCardForm(f => ({ ...f, cornerStyle: e.target.value }))}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="rounded">Rounded</option>
                        <option value="sharp">Sharp</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Footer Text (optional)</Label>
                      <Input value={idCardForm.footerText} onChange={e => setIdCardForm(f => ({ ...f, footerText: e.target.value }))} placeholder="e.g. Valid for the current calendar year" />
                    </div>
                    <div className="space-y-1.5 flex items-end">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <button
                          type="button"
                          onClick={() => setIdCardForm(f => ({ ...f, showQrOnBack: !f.showQrOnBack }))}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                            idCardForm.showQrOnBack ? "bg-sky-600 border-sky-600" : "bg-white border-gray-300"
                          }`}
                        >
                          {idCardForm.showQrOnBack && <span className="w-2 h-2 bg-white rounded-sm" />}
                        </button>
                        <span className="text-sm text-gray-700">Show QR verification code on back</span>
                      </label>
                    </div>
                  </div>
                )}
                <Button size="sm" onClick={saveIdCardSettings} disabled={updateIdCardSettings.isPending}>
                  {updateIdCardSettings.isPending ? "Saving…" : "Save ID Card Template"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Company Documents */}
          <TabsContent value="documents" className="mt-4 space-y-4">
            <p className="text-xs text-gray-500 -mt-1">
              Theme each generated document independently. Colors, heading style, and an optional logo override —
              everything else (company name, address, contact info) is pulled from the Company tab automatically.
            </p>
            <DocumentThemeCard
              docType="offer_letter"
              title="Offer Letter"
              icon={<FileSignature size={15} className="text-emerald-700" />}
              description="Generated from an employee's profile — Employees → select employee → Generate Offer Letter."
            />
            <DocumentThemeCard
              docType="experience_letter"
              title="Experience Letter"
              icon={<Award size={15} className="text-emerald-700" />}
              description="Generated from an employee's profile — Employees → select employee → Generate Experience Letter."
            />
            <DocumentThemeCard
              docType="salary_slip"
              title="Salary Slip"
              icon={<IndianRupee size={15} className="text-emerald-700" />}
              description="Applies to the Salary Slip PDF generated from the Salary Slip page."
            />
            <DocumentThemeCard
              docType="resignation_letter"
              title="Resignation Letter"
              icon={<FileText size={15} className="text-emerald-700" />}
              description="Generated from Recruitment → Resignations once a resignation is approved."
            />
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
                    <div className="space-y-1.5 sm:col-span-2">
                      <p className="text-[11px] text-gray-500">
                        Grace period and shift start/end times come solely from the shift assigned
                        to each employee in <strong>Manage Shift</strong> — there is no Settings-level default.
                        An employee with no shift assigned is never flagged late.
                      </p>
                    </div>
                  </div>
                )}

                <Button size="sm" onClick={saveAttendanceMode} disabled={updatePayrollSettings.isPending}>
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Attendance Mode"}
                </Button>
              </CardContent>
            </Card>

            {/* ── Night Shift Relaxation (staff-only feature toggle) ── */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <Clock size={15} className="text-indigo-500" /> Night Shift Relaxation (Staff)
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold ${nightShiftEnabled ? "text-green-600" : "text-gray-400"}`}>
                      {nightShiftEnabled ? "ENABLED" : "DISABLED"}
                    </span>
                    <Switch
                      checked={nightShiftEnabled}
                      onCheckedChange={async (v) => {
                        setNightShiftEnabled(v);
                        try {
                          await updatePayrollSettings.mutateAsync({ nightShiftEnabled: v } as never);
                          toast({
                            title: v ? "Night Shift Relaxation enabled" : "Night Shift Relaxation disabled",
                            description: v
                              ? "The Night Shift page is now visible in the sidebar."
                              : "The Night Shift page is hidden from the sidebar. Existing relaxation logic is unchanged.",
                          });
                        } catch {
                          setNightShiftEnabled(!v);
                          toast({ title: "Failed to update setting", variant: "destructive" });
                        }
                      }}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Staff who work late into the night get a grace window to report late the next
                  morning without being marked Late. This switch controls whether the
                  <strong> Night Shift</strong> page appears in the sidebar — the underlying
                  detection logic and rules keep working exactly as before either way.
                </p>
              </CardContent>
            </Card>

            {/* ── Production Punch Times & Shift Segments (replaces the old fixed 3-window model) ── */}
            <ProductionShiftConfigCard />

            {/* Production PF/ESI deductions are configured in the Payroll tab
                (prodPfRate / prodEsiRate / prodEsiApplicableBelow) — the only
                rates the payroll engine actually applies. */}

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
                  <strong>Note:</strong> Payroll rules are <strong>disabled by default</strong>.
                  Use the switch on each column to enable PF/ESI deductions for that employee
                  class — while a switch is off, no deduction is applied even if rates are set.
                  Changes apply to all new payroll runs — existing records are not affected.
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
                          <span className={`text-[10px] font-bold ${staffRulesEnabled ? "text-green-600" : "text-gray-400"}`}>
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
                    <div className={`space-y-3 ${prodRulesEnabled ? "" : "opacity-60"}`}>
                      <div className="flex items-center gap-2 pb-1 border-b">
                        <span className="text-xs font-semibold text-orange-700 bg-orange-50 px-2 py-0.5 rounded">Production</span>
                        <span className="text-xs text-muted-foreground">Shift-based employees</span>
                        <div className="ml-auto flex items-center gap-2">
                          <span className={`text-[10px] font-bold ${prodRulesEnabled ? "text-green-600" : "text-gray-400"}`}>
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
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        Default Salary Per Shift (&#8377;) <span className="text-muted-foreground font-normal">pre-filled for new production employees</span>
                      </Label>
                      <Input
                        type="number" min={0} step={0.01}
                        value={payroll.defaultSalaryPerShift}
                        onChange={e => setPayroll(p => ({ ...p, defaultSalaryPerShift: Number(e.target.value) }))}
                        placeholder="e.g. 300"
                      />
                    </div>
                  </div>
                )}

                <Button
                  size="sm"
                  onClick={() => savePayroll()}
                  disabled={updatePayrollSettings.isPending || psLoading}
                >
                  {updatePayrollSettings.isPending ? "Saving…" : "Save Payroll Settings"}
                </Button>
              </CardContent>
            </Card>

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
                  monthly-equivalent earnings (bi-weekly gross × 2) and deducts PF / EF at that rule's rates —
                  overriding the flat Production PF/ESI rates above. Amounts appear in the payroll breakdown
                  and the salary slip. Max Salary <strong>0</strong> = no upper limit. When disabled, the flat
                  rates above apply.
                </div>
                {pfEfRules.length === 0 ? (
                  <p className="text-xs text-center text-muted-foreground py-3">No rules configured yet.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1fr_100px_100px_80px_80px_32px] gap-2 text-[10px] text-gray-400 uppercase font-semibold px-1">
                      <span>Category</span><span>Min Salary</span><span>Max Salary</span><span>PF %</span><span>EF %</span><span />
                    </div>
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
                          type="number" placeholder="Max ₹ (0 = no limit)"
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
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm" variant="outline"
                    onClick={() => setPfEfRules(rs => [...rs, { label: "", minSalary: 0, maxSalary: 0, pfRate: 0, efRate: 0 }])}
                  >
                    + Add Rule
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => savePayroll({ title: "PF/EF rules saved" }, "Failed to save PF/EF rules")}
                    disabled={updatePayrollSettings.isPending}
                  >
                    {updatePayrollSettings.isPending ? "Saving…" : "Save PF/EF Rules"}
                  </Button>
                </div>
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
                    onClick={() => savePayroll(
                      { title: "SMTP settings saved", description: "Email sending will use these credentials from now on." },
                      "Failed to save SMTP settings",
                    )}
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
                  Creates a full PostgreSQL dump (<strong>pg_dump</strong>, plain SQL) of the live
                  database into the folder below, on the server machine. The filename includes the
                  date and time, e.g. <strong>UKTex_DB_backup_2026-07-10_14-30-00.sql</strong>.
                  Restore with <code>psql -f &lt;file&gt;</code>.
                </div>

                {backupStatus && !backupStatus.pgDumpAvailable && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                    <strong>pg_dump was not found on the server.</strong> Install the PostgreSQL
                    client tools on the server machine (or add PostgreSQL's <code>bin</code> folder
                    to PATH), then reload this page.
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs">Backup Directory (on the server machine)</Label>
                  <Input
                    value={backupDir}
                    onChange={e => setBackupDir(e.target.value)}
                    placeholder="D:/backups/uktextile"
                  />
                  <p className="text-[11px] text-gray-400">
                    The folder is created automatically if it doesn't exist. The directory is
                    remembered after the first successful backup.
                  </p>
                </div>

                <Button size="sm" onClick={handleRunBackup} disabled={runBackup.isPending}>
                  {runBackup.isPending ? "Backing up…" : "Run Backup Now"}
                </Button>

                {(backupStatus?.backups?.length ?? 0) > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-gray-600">Recent backups in this folder</p>
                    <div className="border rounded-lg divide-y">
                      {backupStatus!.backups.map(b => (
                        <div key={b.file} className="flex items-center justify-between px-3 py-2 text-xs">
                          <span className="font-mono text-gray-700 truncate">{b.file}</span>
                          <span className="text-gray-400 shrink-0 ml-3">
                            {(b.sizeBytes / 1024 / 1024).toFixed(2)} MB · {new Date(b.createdAt).toLocaleString("en-IN")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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

                <Button
                  size="sm"
                  onClick={() => savePayroll({ title: "Salary Slip settings saved" }, "Failed to save Salary Slip settings")}
                  disabled={updatePayrollSettings.isPending}
                >
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
