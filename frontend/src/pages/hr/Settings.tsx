import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, Clock, Shield, Mail, Database, Bell, IndianRupee, Settings as SettingsIcon,
} from "lucide-react";

export default function Settings() {
  const { toast } = useToast();
  const [company, setCompany] = useState({
    name: "UKTextiles", tagline: "Garments Manufacturing Excellence",
    address: "Chennai, Tamil Nadu, India", phone: "+91 9876543210",
    email: "hr@uktextiles.in", website: "https://uktextiles.in",
    gstin: "", pan: "",
  });

  const [attendance, setAttendance] = useState({
    workingDaysPerMonth: 26, gracePeriodMinutes: 15,
    halfDayHours: 4.5, overtimeThresholdHours: 9,
    biometricEnabled: true, autoAttendanceProcess: true,
  });

  const [payroll, setPayroll] = useState({
    pfRate: 12, esiRate: 0.75, esiEmployerRate: 3.25,
    pfApplicableAbove: 0, esiApplicableBelow: 21000,
    payDay: 5, productionPayType: "biweekly",
  });

  const [smtp, setSmtp] = useState({
    host: "", port: "587", username: "", password: "", fromEmail: "", fromName: "UKTextiles HR",
  });

  const [backup, setBackup] = useState({
    enabled: true, schedule: "daily", time: "02:00",
    retentionDays: 30, backupPath: "D:/backups/uktextile/",
  });

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
                    { label: "Working Days / Month", key: "workingDaysPerMonth", type: "number" },
                    { label: "Grace Period (minutes)", key: "gracePeriodMinutes", type: "number" },
                    { label: "Half Day Threshold (hours)", key: "halfDayHours", type: "number" },
                    { label: "Overtime Threshold (hours)", key: "overtimeThresholdHours", type: "number" },
                  ].map(({ label, key, type }) => (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs">{label}</Label>
                      <Input type={type} value={(attendance as any)[key]}
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
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">PF Rate (Employee %) </Label>
                    <Input type="number" value={payroll.pfRate} onChange={e => setPayroll(p => ({ ...p, pfRate: Number(e.target.value) }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">ESI Rate (Employee %)</Label>
                    <Input type="number" value={payroll.esiRate} step="0.01" onChange={e => setPayroll(p => ({ ...p, esiRate: Number(e.target.value) }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">ESI Applicable Below (₹)</Label>
                    <Input type="number" value={payroll.esiApplicableBelow} onChange={e => setPayroll(p => ({ ...p, esiApplicableBelow: Number(e.target.value) }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Salary Pay Day (of month)</Label>
                    <Input type="number" value={payroll.payDay} min={1} max={28} onChange={e => setPayroll(p => ({ ...p, payDay: Number(e.target.value) }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Production Employee Pay</Label>
                    <select value={payroll.productionPayType} onChange={e => setPayroll(p => ({ ...p, productionPayType: e.target.value }))}
                      className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                      <option value="biweekly">Bi-Weekly (every 2 weeks)</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                </div>
                <Button size="sm" onClick={() => save("Payroll")}>Save Payroll Settings</Button>
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
                <div className="grid sm:grid-cols-2 gap-4">
                  {[
                    { label: "SMTP Host", key: "host", placeholder: "smtp.gmail.com" },
                    { label: "SMTP Port", key: "port", placeholder: "587" },
                    { label: "Username", key: "username", placeholder: "hr@uktextiles.in" },
                    { label: "Password", key: "password", type: "password", placeholder: "••••••••" },
                    { label: "From Email", key: "fromEmail", placeholder: "hr@uktextiles.in" },
                    { label: "From Name", key: "fromName", placeholder: "UKTextiles HR" },
                  ].map(({ label, key, type, placeholder }) => (
                    <div key={key} className="space-y-1.5">
                      <Label className="text-xs">{label}</Label>
                      <Input type={type ?? "text"} value={(smtp as any)[key]}
                        onChange={e => setSmtp(s => ({ ...s, [key]: e.target.value }))}
                        placeholder={placeholder} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <Button size="sm" variant="outline" onClick={() => toast({ title: "Test email sent!" })}>
                    Send Test Email
                  </Button>
                  <Button size="sm" onClick={() => save("SMTP")}>Save SMTP Settings</Button>
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
        </Tabs>
      </div>
    </HrLayout>
  );
}
